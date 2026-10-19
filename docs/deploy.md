# deploy.md — one VPS, docker-compose.prod.yml

Runtime: `caddy` (TLS, the only published ports) → `web` (nginx: SPA + `/api/` +
`/storage/` + `/mcp` + `/.well-known/oauth-`) → `api` / `minio`, plus `postgres`. Files: `docker-compose.prod.yml`,
`deploy/Caddyfile`, `.env.prod.example`, `deploy/*.sh`, `deploy/systemd/*`.
Local dev stand: `docs/infra.md` (the two must not drift — see the bottom note).

## Prerequisites
- Ubuntu 24.04 VPS, ≥2 vCPU / 4 GB RAM / 40 GB disk, root SSH by key.
- Your public key already in `/root/.ssh/authorized_keys` (otherwise bootstrap
  leaves password login ON and says so — a locked-out server is unrecoverable).
- A domain pointing at the server, or nothing: the default is
  `<ipv4-with-dashes>.sslip.io`, which resolves without any DNS of your own.
- Nothing else listening on 80/443.

## First deploy
1. `ssh root@<ip>`
2. The repo is private, so copy the script from the Mac instead of curl'ing it:
   `scp deploy/bootstrap.sh root@<ip>:/root/`
3. `REPO_URL=git@github.com:<owner>/budget.git bash bootstrap.sh` — the env
   override, no editing — installs Docker, firewall, unattended upgrades, 2 GB
   swap, SSH hardening, a deploy key, the backup timer. It prints a public key
   and stops. The timer is live from this point, so a 03:15 run before step 7
   fails loudly in `journalctl -u budget-backup.service` — expected, not a fault.
4. Add that key on GitHub: repo → Settings → Deploy keys → Add, read-only.
5. The same `REPO_URL=… bash bootstrap.sh` again — it clones to `/opt/budget`
   and writes `/opt/budget/.env` (mode 600): generated secrets, sslip.io domain.
   Rerunning is always safe: every step skips what already exists.
6. `cd /opt/budget && $EDITOR .env` — set `SITE_DOMAIN` if you have a real
   domain, and the optional keys you want: `ANTHROPIC_API_KEY` (advisor +
   receipt parsing, otherwise 503 `AI_NOT_CONFIGURED`), the three `VAPID_*`
   (web push; generator one-liner is in the file), `R2_*` (offsite backups).
7. `deploy/update.sh` — first run builds everything (~10 min) and waits for
   `https://$SITE_DOMAIN/api/health`.
8. Open the site, register the owner account. **Registration is open** — nothing
   in the app restricts who can sign up.

## Update
`cd /opt/budget && deploy/update.sh` — pull, rebuild, `up -d`, poll health for
~2 min, prune images/build cache, warn if `/` is ≥85% full. On failure it prints
`compose ps` and the last 50 api log lines and exits non-zero. `up -d` recreates
every changed container (stop old → start new), so a rebuilt service is down for
the seconds it takes to recreate it. Applying an `.env` edit is the same
command (`SKIP_PULL=1` to skip the pull). `deploy/Caddyfile` is a bind mount and
`update.sh` only recreates caddy when its env changed: after editing it run
`docker compose -f docker-compose.prod.yml restart caddy`.

## Backups and restore
`deploy/backup.sh` runs daily at 03:15 UTC (`budget-backup.timer`;
`journalctl -u budget-backup.service` for the log) and by hand any time. It
writes `$BACKUP_DIR/pg/budget-<UTC>.dump` (`pg_dump -Fc`), mirrors the receipts
bucket into `$BACKUP_DIR/receipts` (additive — deleting an object in MinIO never
deletes its backup), deletes dumps older than `BACKUP_RETENTION_DAYS` (14), and
copies both offsite when all four `R2_*` are set. With none set it prints one
`WARNING:` line; with some of them set it fails — a half-configured offsite is
worse than none, because it looks configured.

Restore: `deploy/restore.sh <dump>` prints what it would do and exits 2. With
`--yes` it stops api, terminates leftover sessions, dumps the current database
to `$BACKUP_DIR/pg/pre-restore-<UTC>.dump` (a restore of the wrong file stays
reversible), then `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` and
`pg_restore --no-owner --exit-on-error`, mirrors `$BACKUP_DIR/receipts` back
into MinIO, restarts api and waits for its healthcheck. The schema drop is what
makes a dump *older* than the live schema restorable: `--clean` alone leaves the
newer tables behind while `alembic_version` rolls back, and `alembic upgrade
head` then crash-loops api on "relation already exists".

**Drill it once, on purpose** (the only way to know the backups are real): run
`backup.sh`, create a throwaway transaction, run `restore.sh <that dump> --yes`,
confirm the transaction is gone and a receipt still downloads. Only sessions
whose refresh token is in the dump survive (same `JWT_SECRET`, restored
`refresh_tokens` rows) — a newer one dies at its next refresh, within 15 min.

**Never `down -v`.** It destroys `pg_data`, `minio_data` and `caddy_data`; the
last one also burns a Let's Encrypt issuance.

## Rotating secrets
Edit `/opt/budget/.env`, then `deploy/update.sh`. What each rotation costs:
- `JWT_SECRET` — every session is invalidated; all users log in again. MCP
  personal access tokens are unaffected: they are SHA-256 hashes in the DB, not
  JWTs.
- `POSTGRES_PASSWORD` — the running Postgres keeps the OLD password (it is only
  read when the data directory is initialised). Change it in SQL first:
  `compose exec postgres psql -U budget -c '\password budget'` — it prompts, so
  the new password never reaches argv or `~/.bash_history` — then in `.env`.
- `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` — one variable each feeds both MinIO
  and the API's S3 credentials, so change both lines in `.env` in the same edit
  and run `update.sh`: compose recreates `minio` and `api` with the new pair.
  MinIO reads them from the environment on every start, so there is no SQL step
  like Postgres has.
- `VAPID_*` — every existing push subscription dies; browsers resubscribe on
  their next Settings visit.
- `ANTHROPIC_API_KEY` — nothing stored depends on it.

## Switching domain
Point the new name at the server, set `SITE_DOMAIN` in `.env`, run
`deploy/update.sh`. Caddy requests the certificate on the first request for the
new name; `CORS_ORIGINS` follows the same variable. Keep the old DNS record for
a while — HSTS (`max-age=31536000`) is already in browsers for the old name.
**An A record only, no AAAA.** Docker's bridge is IPv4-only, so every IPv6
client would arrive with the bridge gateway as peer and all of them would share
one per-IP rate-limit bucket (login 10/min, register 5/h).

## Security model
- Published surface: 80/tcp, 443/tcp+udp on `caddy`, and SSH. Nothing else —
  postgres, minio and api have no `ports:` at all and are reachable only inside
  the compose network. Verify with `docker compose … ps` (only caddy has
  publishers). The `ports:` discipline *is* the control here: ufw does not
  filter Docker-published ports (the DOCKER chain is hit before ufw's INPUT
  rules), so adding a ufw rule to hide a published port does nothing.
- Real client IP: Caddy REPLACES any client-supplied `X-Forwarded-For` with the
  real peer (it trusts no proxy by default) → nginx appends its own view →
  uvicorn with `--forwarded-allow-ips='*'` takes the LEFTMOST entry = the
  client. The wildcard is acceptable *only* because `api:8000` is unpublished:
  no outsider can hand uvicorn a hand-written header. Publishing the api port
  would instantly make per-IP rate limits forgeable.
- No cookies: the SPA holds bearer tokens in `localStorage` (accepted XSS
  tradeoff, see `docs/web.md`), so there is no CSRF surface and no cookie flags
  to get wrong. CORS is unused on this path — browser traffic is same-origin
  through nginx; `CORS_ORIGINS` only matters for a non-browser client.
- Receipt objects are private; the browser only ever gets presigned `/storage/…`
  URLs. An unsigned `GET /storage/receipts/<key>` is refused by MinIO.
- `.env` is mode 600 and never printed by any script; secrets are never passed
  on a command line (the `mc` tools container reads them from its own env).

## Disk hygiene
`update.sh` prunes dangling images and trims the build cache to 2 GB each run
and warns at 85%. If it is still tight: `docker system df`, then
`docker builder prune -af`, and check `$BACKUP_DIR` — dumps are the other thing
that grows (lower `BACKUP_RETENTION_DAYS`). Container logs are capped at
10 MB × 3 per service.

## Moving local data to the server (optional, one-off)
On the Mac, with the dev stack up: `SERVER=root@<ip> deploy/migrate-local-data.sh`.
It dumps the dev DB, mirrors the dev receipts bucket, scp's one archive to
`/var/backups/budget/import` and prints the exact `restore.sh` line to run on
the server. It changes nothing locally and nothing on the server by itself.

## Embeddings model (rag) — RAM is the thing to watch
The API image carries a 118 MB int8 ONNX model (`apps/api/model_manifest.json`),
fetched and sha256-verified in its own build stage: **every build depends on
huggingface.co** (deliberate — an unverifiable artifact must not produce an
image); image 311 → **595 MB**. No DB image swap, no data step, no new `.env`
line: the update is the ordinary `deploy/update.sh` (back up first, by habit);
the boot sweep indexes the ledger in the background (`EMBEDDINGS_SWEEP_*`).

RSS of the API worker with the model loaded: **≈560 MB** standalone on arm64
(`.tasks/rag/evidence.md` — the 250k-token embedding table is materialised as
fp32), **824–844 MB** inside the `linux/amd64` image under emulation on the dev
Mac. A native macOS `ps rss` reads 180–220 MB after idling, but macOS compresses
idle pages, so plan with the Linux figure. Re-measure on the VPS after the first
deploy: `docker compose -f docker-compose.prod.yml exec api sh -c 'grep VmRSS
/proc/1/status'` — 3.8 GB is shared with Postgres, MinIO and Caddy. ⚠ above
~900 MB or if the box swaps: `EMBEDDINGS_PROVIDER=off` in `/opt/budget/.env` +
`deploy/update.sh` — search and `POST /advisor/qa` answer 503
`EMBEDDINGS_NOT_AVAILABLE`, stored vectors stay, nothing else moves.

## MCP
Remote connector (default, nothing to install): `https://<domain>/mcp` in Claude →
Settings → Connectors (`apps/api/MCP.md` §0). `PUBLIC_BASE_URL` is DERIVED from
`SITE_DOMAIN` by `docker-compose.prod.yml` — nothing to add to `.env`; an empty
value switches the connector and its OAuth server off. `/mcp` and
`/.well-known/oauth-*` are proxied to the API by nginx, so a 404 of HTML there
means the API has no base URL. **Changing the domain invalidates every connector**
(the URL is its identity): users re-add it in Claude, and existing grants stay in
Settings → Connected AI apps until revoked.
Local stdio server (needs the repo): `BUDGET_API_URL=https://<domain>/api` with a
personal access token from Settings (`apps/api/MCP.md` §§1–9).

## Dev/prod lockstep
Three settings must stay byte-identical in `docker-compose.yml` and
`docker-compose.prod.yml` or presigned receipt links break: the
`minio.localhost` network alias, `--address ":9010"`, and
`S3_ENDPOINT_URL=http://minio.localhost:9010`. The SPA build arg
`VITE_API_URL=/api` is the fourth: an absolute URL there re-introduces CORS.

CLAUDE.md table row for the orchestrator: | деплой — VPS, compose.prod, Caddy, бэкапы/восстановление, ротация секретов | `docs/deploy.md` |
