#!/usr/bin/env bash
# Optional, runs on the OWNER'S MAC: copy the local dev data (database +
# receipt objects) to the server so the first deploy is not empty.
#
#   SERVER=root@203.0.113.7 deploy/migrate-local-data.sh
#
# Read-only against the dev stack: it dumps, tars and scp's, then prints the
# restore line to run on the server. Nothing local is stopped, dropped or
# deleted, and the server is not touched beyond dropping the archive into
# $REMOTE_DIR — the restore itself stays a deliberate, separate command.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Where to copy it. SERVER must be given; the default is a placeholder.
SERVER="${SERVER:-root@<ip>}"
REMOTE_DIR="${REMOTE_DIR:-/var/backups/budget/import}"

# The DEV stack, not the production one — this is the source side. Same env
# names as the other scripts (R1), different defaults for the same reason.
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-budget}"
ENV_FILE="${ENV_FILE:-.env}"
case "$COMPOSE_FILE" in /*) ;; *) COMPOSE_FILE="$REPO_ROOT/$COMPOSE_FILE" ;; esac
case "$ENV_FILE" in /*) ;; *) ENV_FILE="$REPO_ROOT/$ENV_FILE" ;; esac

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" "$@"
}

case "$SERVER" in
  *'<ip>'*)
    echo "ERROR: set SERVER, e.g. SERVER=root@203.0.113.7 deploy/migrate-local-data.sh" >&2
    exit 1
    ;;
esac

# compose refuses to start when --env-file points at nothing, so say why here.
[ -f "$ENV_FILE" ] || { echo "ERROR: no env file at $ENV_FILE (the dev stack's root .env)" >&2; exit 1; }

if ! compose ps --status running --services | grep -qx postgres; then
  echo "ERROR: the dev stack is not running (docker compose up -d postgres minio)" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
mkdir -p "$work/pg" "$work/receipts"

echo "==> dumping the dev database"
compose exec -T postgres pg_dump -U budget -Fc budget >"$work/pg/budget-$stamp.dump"

echo "==> mirroring the dev receipts bucket"
# The dev stack has no `mc` tools service, so a throwaway container joins its
# network instead. Dev credentials are the committed minioadmin pair — nothing
# secret, and nothing here reads the production .env.
docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" -v "$work:/backup" --entrypoint sh budget-minio:RELEASE.2025-04-22T22-12-26Z -c \
  'mc alias set dev http://minio:9010 minioadmin minioadmin >/dev/null && mc mirror --overwrite dev/receipts /backup/receipts'

archive="$work/budget-local-$stamp.tar.gz"
echo "==> packing $archive"
tar czf "$archive" -C "$work" pg receipts

echo "==> copying to $SERVER:$REMOTE_DIR"
# shellcheck disable=SC2029  # REMOTE_DIR is a local variable: expanding it here is the point
ssh "$SERVER" "mkdir -p '$REMOTE_DIR'"
scp "$archive" "$SERVER:$REMOTE_DIR/"

cat <<EOF

==> Copied. Now, on the server (this is the destructive half — it replaces the
    server's database with this one):

  ssh $SERVER
  cd /opt/budget
  tar xzf $REMOTE_DIR/budget-local-$stamp.tar.gz -C $REMOTE_DIR
  BACKUP_DIR=$REMOTE_DIR deploy/restore.sh $REMOTE_DIR/pg/budget-$stamp.dump --yes

    BACKUP_DIR points restore.sh (and the /backup mount it uses for the receipt
    mirror) at the imported copy, so the server's own backups stay untouched.

    Local working copy, delete it when you are done: $work
EOF
