# Code review — scope `deploy` (FULL tier)

Reviewed: `docker-compose.prod.yml`, `deploy/Caddyfile`, `.env.prod.example`, `deploy/*.sh`,
`deploy/systemd/*`, `docs/deploy.md`, diff of `apps/web/nginx.conf` + `.gitignore`, against
`docker-compose.yml` and `apps/api/src/budget_api/config.py`. Gates not re-run. The five
already-known docs/bootstrap items and P14 are excluded.

## MAJOR

**M1. sshd drop-in can silently lose to cloud-init — script then claims hardening is on.**
`deploy/bootstrap.sh:16,104-112`. sshd takes the FIRST value it reads for a keyword and
`Include sshd_config.d/*` is processed in lexical order. Ubuntu cloud images (netcup included)
ship `50-cloud-init.conf` with `PasswordAuthentication yes` when the image was provisioned
with a root password — `99-budget.conf` sorts after it and is ignored, while the script prints
"password login disabled; key login only". Fix: name the file `00-budget.conf`, and after the
reload assert the effective value instead of claiming it:
`sshd -T | grep -qi '^passwordauthentication no' || { echo "WARNING: password login still ON (another sshd_config.d file wins)"; }`.

**M2. Restoring a dump older than the current schema crash-loops the api; docs say the opposite.**
`deploy/restore.sh:100`, `docs/deploy.md:57-58`. `pg_restore --clean` drops only objects
present in the dump. After a deploy that added a migration, the new tables survive the restore
while `alembic_version` is rolled back to the old revision; `alembic upgrade head` on the next
api start then fails on "relation already exists" and `restart: unless-stopped` loops it.
Exactly the "roll back after a bad release" case a restore exists for. Fix (minimal): after the
straggler kill, `compose exec -T postgres psql -U budget -d budget -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'`
then `pg_restore --no-owner --exit-on-error -U budget -d budget` (drop `--clean --if-exists`).
Now every restore starts from an empty schema, pg_restore stops at the first error instead of
reporting "errors ignored" at the end, and the docs sentence becomes true.

## MINOR

**m1. No safety dump before a destructive restore.** `deploy/restore.sh:89-104`. With M2 the
pre-restore state is gone the moment the schema is dropped. Three lines before the drop —
`pg_dump -Fc budget > "$BACKUP_DIR/pg/pre-restore-$stamp.dump"` via the same `.part`/rename
dance as backup.sh — make every `--yes` reversible for the cost of one dump.

**m2. authorized_keys check misses ecdsa/sk/option-prefixed keys.** `deploy/bootstrap.sh:100`.
`^[[:space:]]*ssh-` does not match `ecdsa-sha2-nistp256 …`, `sk-ssh-ed25519@openssh.com …` or
`command="…" ssh-ed25519 …`. Fails safe (hardening skipped, password login stays on) but the
owner believes it ran. Fix: `grep -qE '(^|[[:space:]])(ssh-|ecdsa-|sk-)'`.

**m3. Root `.dockerignore` does not exclude `.env`.** `/.dockerignore`. The prod web build
context is `/opt/budget`, so the server's `.env` (every secret) is shipped to the build daemon
on each `update.sh`; and `COPY apps/web ./apps/web` (`apps/web/Dockerfile:24`) would bake any
`apps/web/.env*` into the builder stage, which Vite reads. Not in the final image today — one
COPY away. Fix: add `.env`, `.env.*`, `!.env.example`, `!.env.prod.example`.

**m4. Password rotation recipe puts the secret in argv and bash history.** `docs/deploy.md:73-76`
(`psql -c "ALTER USER budget PASSWORD '…'"`) contradicts lines 109-110. Fix:
`compose exec postgres psql -U budget -c '\password budget'` — prompts, nothing in `ps`.

**m5. "Sessions survive" a restore is only partly true.** `docs/deploy.md:62-63`. Refresh tokens
are DB rows (`models/refresh_token.py`); sessions created after the dump die at their next
refresh (≤15 min). Say "sessions whose refresh token is in the dump".

**m6. IPv6 clients share one rate-limit bucket.** `docker-compose.prod.yml:25-28`. Ports are
published on v4+v6 but the bridge is IPv4-only, so IPv6 clients arrive via docker-proxy with
the bridge gateway as peer → Caddy, nginx and uvicorn all see the same "client" → one IPv6 user
exhausts login 10/min / register 5/h for all of them. Invisible on sslip.io (A record only);
bites the day a real domain gets an AAAA. Fix: one line in "Switching domain": no AAAA record
(Docker IPv6 is not enabled).

**m7. Dumps are world-readable on the host.** `deploy/backup.sh:40-54`. The systemd unit runs
with umask 022, so `budget-*.dump` lands 0644 (and `pg/` 0755 unless bootstrap happened to
create it under its own `umask 077`). Fix: `umask 077` at the top of backup.sh.

## NIT

- `apps/web/nginx.conf:4-7` — the `map` forwards any string; a whitelist (`https https; http http; default $scheme;`)
  costs nothing. Inert today: uvicorn whitelists (`proxy_headers.py:47`), nothing reads scheme, Caddy overwrites it.
- `.env.prod.example:15-17` — `POSTGRES_PASSWORD` is interpolated into a URL (`compose.prod:78`): say
  "hex only — `@ : / % #` break DATABASE_URL". The generator is safe; a hand-picked password is not.
- `.env.prod.example:3-4` — `docker compose … config` prints every secret; suggest `config -q` for the check.
- `deploy/bootstrap.sh:138` — `ssh-keyscan` is trust-on-first-use; acceptable for a read-only deploy key.
- `deploy/bootstrap.sh:194` — the timer is live before the stack exists; the first 03:15 run fails
  loudly in journald until `update.sh` has run. Harmless; one docs line.
- `docker-compose.prod.yml:159,181` — `minio/mc` is unpinned while the server is pinned (same as dev; pin both or neither).
- `deploy/Caddyfile` is a bind mount: an edit needs `compose restart caddy`; `update.sh` only recreates
  caddy on an env change. One docs line.
- `docs/deploy.md:92-96` — ufw does not filter Docker-published ports (DOCKER chain precedes ufw INPUT);
  the `ports:` discipline is the real control. Worth one clause so nobody "adds a ufw rule" and thinks it works.
- `docs/deploy.md:34-35` — open registration on a public host + per-account AI quotas = Anthropic spend
  exposure via throwaway accounts (5 regs/h/IP × 20 asks + 100 parses/day). Documented; owner's call, not this scope.

## Verified OK
- Env mapping vs `config.py`: `DATABASE_URL`, `JWT_SECRET`, `S3_ENDPOINT_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
  `CORS_ORIGINS` (JSON list, parsed by pydantic-settings), `ANTHROPIC_API_KEY`, `VAPID_*` — all correct.
- Published surface: only `caddy` has `ports:`; postgres/minio/api/mc have none. Caddy admin (2019) and
  MinIO console (9011) stay inside the network.
- Secrets never on a command line: `$$` in compose healthcheck/entrypoint, single-quoted container-side
  expansion in backup/restore, `fill` in bootstrap substitutes in-shell. `-e DUMP_NAME` is not a secret.
- XFF chain as groomed: Caddy sets a fresh XFF/XFP for untrusted peers → nginx appends caddy →
  uvicorn leftmost = client. The nginx `map` cannot be fed from outside through Caddy.
- `update.sh`: build before `up`, so a failed build leaves the old containers running; `--remove-orphans`
  never touches volumes; `caddy_data` persists across updates (no LE re-issuance).
- Bootstrap rerun-safe: every step gated on its own artifact; `ufw allow 22` precedes `enable`; a bad
  sshd drop-in is removed on `sshd -t` failure (modulo M1).
- Lockstep triple (`minio.localhost` alias, `--address ":9010"`, `S3_ENDPOINT_URL`) and `VITE_API_URL=/api`
  byte-identical to dev. `.gitignore` exception order correct. Restore defaults to dry run, exit 2.

**Verdict: APPROVE WITH FIXES — no BLOCKER; M1 and M2 must land before the first real deploy (both are
small, local edits), the MINORs are each a few lines and can ride in the same pass.**
