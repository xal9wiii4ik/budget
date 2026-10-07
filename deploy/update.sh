#!/usr/bin/env bash
# Deploy the current main: pull, rebuild, restart, wait for health, reclaim disk.
# This is also the way to apply an .env change (SITE_DOMAIN, secrets, keys).
#   SKIP_PULL=1 deploy/update.sh    # rebuild/restart what is already checked out
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-budget-prod}"
ENV_FILE="${ENV_FILE:-.env}"
case "$COMPOSE_FILE" in /*) ;; *) COMPOSE_FILE="$REPO_ROOT/$COMPOSE_FILE" ;; esac
case "$ENV_FILE" in /*) ;; *) ENV_FILE="$REPO_ROOT/$ENV_FILE" ;; esac

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" "$@"
}

# Reads one KEY=value out of $ENV_FILE without sourcing it (that file holds
# secrets and arbitrary characters). An exported value wins, which is also how
# `docker compose` resolves it — so the script and the stack cannot disagree.
env_value() {
  local key="$1" default="${2:-}" value=''
  value="$(printenv "$key" 2>/dev/null || true)"
  if [ -z "$value" ] && [ -f "$ENV_FILE" ]; then
    value="$(sed -n "s/^[[:space:]]*$key=//p" "$ENV_FILE" | tail -n 1)"
    value="${value%\"}"
    value="${value#\"}"
  fi
  printf '%s' "${value:-$default}"
}

[ -f "$ENV_FILE" ] || { echo "ERROR: no env file at $ENV_FILE (see .env.prod.example)" >&2; exit 1; }

SITE_DOMAIN="$(env_value SITE_DOMAIN)"
[ -n "$SITE_DOMAIN" ] || { echo "ERROR: SITE_DOMAIN is not set in $ENV_FILE" >&2; exit 1; }
HTTPS_PORT="$(env_value CADDY_HTTPS_PORT 443)"
HEALTH_URL="https://$SITE_DOMAIN:$HTTPS_PORT/api/health"

CURL_OPTS=(-fsS --max-time 5 -o /dev/null)
# Only the local verification stand runs on `localhost`, where Caddy serves its
# own internal CA. A real domain must validate.
if [ "$SITE_DOMAIN" = "localhost" ]; then
  CURL_OPTS+=(-k)
fi

if [ "${SKIP_PULL:-0}" = "1" ]; then
  echo "==> git pull skipped (SKIP_PULL=1)"
else
  echo "==> git pull --ff-only"
  git -C "$REPO_ROOT" pull --ff-only
fi

echo "==> build"
compose build --pull

echo "==> up"
compose up -d --remove-orphans

echo "==> waiting for $HEALTH_URL"
healthy=0
for _ in $(seq 1 60); do
  if curl "${CURL_OPTS[@]}" "$HEALTH_URL"; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" -ne 1 ]; then
  echo "ERROR: $HEALTH_URL did not answer within ~2 minutes" >&2
  compose ps
  compose logs --tail=50 api
  exit 1
fi
echo "    healthy"

echo "==> reclaiming disk"
docker image prune -f
docker builder prune -f --keep-storage 2G

used="$(df -P / | awk 'NR==2 { gsub("%","",$5); print $5 }')"
df -h / | sed 's/^/    /'
if [ "$used" -ge 85 ]; then
  echo "WARNING: / is ${used}% full — see 'disk hygiene' in docs/deploy.md" >&2
fi

site_url="https://$SITE_DOMAIN"
if [ "$HTTPS_PORT" != "443" ]; then
  site_url="$site_url:$HTTPS_PORT"
fi
echo "==> deployed: $site_url"
