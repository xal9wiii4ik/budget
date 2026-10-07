#!/usr/bin/env bash
# Restore the database from a pg_dump produced by deploy/backup.sh, and push the
# receipt mirror back into MinIO.
#
#   deploy/restore.sh /var/backups/budget/pg/budget-<ts>.dump          # dry run
#   deploy/restore.sh /var/backups/budget/pg/budget-<ts>.dump --yes    # for real
#
# This DESTROYS the current contents of the budget database: without --yes it
# only prints what it would do and exits 2, having changed nothing.
set -euo pipefail

# The pre-restore safety dump below is a full copy of every user's data; same
# reason as backup.sh.
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

# Reads one KEY=value out of $ENV_FILE without sourcing it; an exported value
# wins, exactly as `docker compose` resolves it.
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

usage() {
  echo "usage: deploy/restore.sh <dump> [--yes]" >&2
}

[ "$#" -gt 0 ] || { usage; exit 1; }

DUMP=''
CONFIRMED=0
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRMED=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: unknown option $arg" >&2
      usage
      exit 1
      ;;
    *)
      [ -z "$DUMP" ] || { echo "ERROR: more than one dump given" >&2; exit 1; }
      DUMP="$arg"
      ;;
  esac
done

[ -n "$DUMP" ] || { usage; exit 1; }
[ -f "$DUMP" ] || { echo "ERROR: no such dump: $DUMP" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "ERROR: no env file at $ENV_FILE (see .env.prod.example)" >&2; exit 1; }

BACKUP_DIR="$(env_value BACKUP_DIR /var/backups/budget)"
RECEIPTS_DIR="$BACKUP_DIR/receipts"

if [ "$CONFIRMED" -ne 1 ]; then
  cat <<EOF
DRY RUN — nothing was changed. With --yes this would, against project
"$COMPOSE_PROJECT_NAME" ($COMPOSE_FILE, env $ENV_FILE):

  1. stop the api container (it holds connections the drop cannot evict)
  2. terminate any remaining session on the budget database
  3. pg_dump the CURRENT database to $BACKUP_DIR/pg/pre-restore-<UTC>.dump
  4. DROP SCHEMA public CASCADE; CREATE SCHEMA public;
     => every table in the current database is dropped, not only the ones
        present in the dump
  5. pg_restore --no-owner --exit-on-error  <  $DUMP
  6. mirror $RECEIPTS_DIR back into MinIO (local/receipts, --overwrite)
  7. start api again and wait for its healthcheck

Rerun with --yes to do it.
EOF
  exit 2
fi

echo "==> stopping api"
compose stop api

echo "==> terminating stragglers on the budget database"
# The schema drop below blocks forever on a live session still holding an
# object, instead of failing.
compose exec -T postgres psql -U budget -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'budget' AND pid <> pg_backend_pid();" >/dev/null

# Everything below this line is destructive, so the state it destroys is dumped
# first: a restore of the wrong file stays reversible for the cost of one dump.
# Same .part/rename dance as backup.sh — a truncated safety dump must not look
# restorable.
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
safety="$BACKUP_DIR/pg/pre-restore-$stamp.dump"
echo "==> safety dump of the current database -> $safety"
mkdir -p "$BACKUP_DIR/pg"
if ! compose exec -T postgres pg_dump -U budget -Fc budget >"$safety.part"; then
  rm -f "$safety.part"
  echo "ERROR: the pre-restore safety dump failed — nothing was changed, api left stopped" >&2
  exit 1
fi
mv "$safety.part" "$safety"

# NOT `pg_restore --clean`: that drops only the objects the dump itself
# contains. Restoring a dump older than the current schema would leave the newer
# tables in place while alembic_version rolls back, and the next `alembic
# upgrade head` on api start dies on "relation already exists" — under
# restart: unless-stopped, forever. Dropping the schema makes every restore
# start from the same empty database, whatever its age.
echo "==> dropping schema public"
compose exec -T postgres psql -U budget -d budget -v ON_ERROR_STOP=1 -c \
  'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null

echo "==> pg_restore < $DUMP"
rc=0
compose exec -T postgres pg_restore --no-owner --exit-on-error -U budget -d budget <"$DUMP" || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "ERROR: pg_restore exited $rc — the database is in an unknown state, api left stopped." >&2
  echo "       The pre-restore state is in $safety" >&2
  exit 1
fi

if [ -d "$RECEIPTS_DIR" ]; then
  echo "==> mirroring $RECEIPTS_DIR -> MinIO"
  # Single-quoted: the credentials are expanded by the container's own shell.
  # shellcheck disable=SC2016  # expanded inside the container, not here
  compose --profile tools run --rm mc sh -c \
    'mc alias set local http://minio:9010 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --overwrite /backup/receipts local/receipts'
else
  echo "    no $RECEIPTS_DIR — skipping the receipt mirror (database only)"
fi

echo "==> starting api"
compose up -d api

# Probed from inside the container, the same way its healthcheck does: this has
# to work whatever Caddy publishes, and even with no certificate at all.
healthy=0
for _ in $(seq 1 60); do
  if compose exec -T api python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health")' >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" -ne 1 ]; then
  echo "ERROR: api did not become healthy within ~2 minutes after the restore" >&2
  compose ps
  compose logs --tail=50 api
  exit 1
fi

echo "==> restored from $DUMP; api healthy"
