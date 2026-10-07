#!/usr/bin/env bash
# Daily backup (systemd: budget-backup.timer, 03:15 UTC) — also safe to run by
# hand. Writes a compressed pg_dump and an additive mirror of the receipts
# bucket under $BACKUP_DIR, rotates old dumps, and copies both offsite when the
# R2_* credentials are configured. The last stdout line is the new dump's path.
set -euo pipefail

# Dumps are a full copy of every user's data; the systemd unit's default 022
# would leave them world-readable on the host.
umask 077

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
# `docker compose` resolves it — so BACKUP_DIR here and the /backup bind mount
# in the `mc` service cannot drift apart.
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

BACKUP_DIR="$(env_value BACKUP_DIR /var/backups/budget)"
BACKUP_RETENTION_DAYS="$(env_value BACKUP_RETENTION_DAYS 14)"

# Checked before anything is written: a half-configured offsite is a
# misconfiguration, not "not configured", and the owner has to find out now
# rather than after a dump that silently stayed on this host.
r2_set=0
for var in R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  if [ -n "$(env_value "$var")" ]; then
    r2_set=$((r2_set + 1))
  fi
done
if [ "$r2_set" -ne 0 ] && [ "$r2_set" -ne 4 ]; then
  echo "ERROR: only $r2_set of 4 R2_* variables are set in the environment or $ENV_FILE — set all four or none" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR/pg" "$BACKUP_DIR/receipts"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$BACKUP_DIR/pg/budget-$stamp.dump"
partial="$dump.part"

echo "==> pg_dump -> $dump"
# Written under a .part name and renamed only on success, so a dump interrupted
# mid-stream can never be mistaken for a restorable one.
if ! compose exec -T postgres pg_dump -U budget -Fc budget >"$partial"; then
  rm -f "$partial"
  echo "ERROR: pg_dump failed" >&2
  exit 1
fi
mv "$partial" "$dump"

echo "==> mirroring receipts -> $BACKUP_DIR/receipts"
# Single-quoted on purpose: the expansion happens in the CONTAINER's shell, so
# the MinIO credentials come from the service env and never touch a host
# command line or this host's process table. No --remove: the mirror is
# additive, deleting an object in MinIO must not delete its only backup.
# shellcheck disable=SC2016  # the container's shell expands these, not this one
compose --profile tools run --rm mc sh -c \
  'mc alias set local http://minio:9010 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --overwrite local/receipts /backup/receipts'

echo "==> rotating dumps older than $BACKUP_RETENTION_DAYS days"
find "$BACKUP_DIR/pg" -name '*.dump' -mtime +"$BACKUP_RETENTION_DAYS" -delete

if [ "$r2_set" -eq 4 ]; then
  echo "==> offsite copy to R2"
  # shellcheck disable=SC2016  # expanded inside the container, from its own env
  compose --profile tools run --rm -e "DUMP_NAME=$(basename "$dump")" mc sh -c \
    'mc alias set r2 "$R2_ENDPOINT" "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" >/dev/null && mc cp "/backup/pg/$DUMP_NAME" "r2/$R2_BUCKET/pg/" && mc mirror --overwrite /backup/receipts "r2/$R2_BUCKET/receipts"'
else
  echo "WARNING: offsite backup NOT configured (R2_* unset) — the only copy is on this host, under $BACKUP_DIR"
fi

echo "$dump"
