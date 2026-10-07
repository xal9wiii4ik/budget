# Implementation Plan: deploy — web + API on one VPS (PLAN.md 1.7)

## Approach

The runtime is already deploy-shaped: the SPA is built with `VITE_API_URL=/api` and
the `web` nginx container is the same-origin front door for `/api/` and `/storage/`.
So the deploy is not an application change — it is (a) one standalone compose file
that publishes **only** TLS, (b) Caddy in front of `web` for certificates, (c) bash
plumbing for bootstrap / update / backup / restore, (d) `docs/deploy.md`.
Zero Python changes, zero `apps/web/src` changes, one three-line `map` in
`nginx.conf`.

Standalone `docker-compose.prod.yml` (not an override) per the lead's decision:
compose v2.21 here cannot `!override` the dev file's `ports:`, and a reader must be
able to see the whole published surface in one file. `name: budget-prod` keeps the
prod volume namespace off the dev project's (`budget_*`) on the owner's Mac during
verification.

`S3_ENDPOINT_URL=http://minio.localhost:9010` stays **byte-identical to dev**. It is
not a localism to clean up: `nginx.conf` hardcodes that string in `sub_filter` and
re-sends it as `Host` on `/storage/`, so the presigned signature only survives while
the API signs exactly that host. Prod therefore keeps the `minio.localhost` network
alias and `--address :9010`.

Split: **I1** = runtime chain (compose.prod, Caddyfile, `.env.prod.example`, nginx
`map`, `.gitignore`); verifiable locally end-to-end on 8480/8443 with Caddy's
internal CA. **I2** = `deploy/*.sh`, systemd units, `docs/deploy.md`. Both FULL tier.

## New files

### I1 — runtime chain
- `docker-compose.prod.yml` (root) — `name: budget-prod`; `x-logging` anchor
  (json-file, 10m×3) on every service; caddy / web / api / postgres / minio /
  minio-init; `restart: unless-stopped` everywhere but minio-init. **Only caddy has
  `ports:`** — `${CADDY_HTTP_PORT:-80}:80`, `${CADDY_HTTPS_PORT:-443}:443`, `…:443/udp`.
  Secrets as `${VAR:?message}` (SITE_DOMAIN, POSTGRES_PASSWORD, MINIO_ROOT_USER,
  MINIO_ROOT_PASSWORD, JWT_SECRET) so `compose config` fails loudly; optional ones
  `${VAR:-}`. Postgres gets **no** `docker/postgres/init` mount (`budget_test` is a
  dev artifact). api command identical to dev + the XFF comment below.
- `deploy/Caddyfile` — one site `{$SITE_DOMAIN}` → `reverse_proxy web:80`,
  `encode zstd gzip`, `header` HSTS `max-age=31536000` (no preload, no
  includeSubDomains — sslip.io is shared) + `X-Content-Type-Options nosniff`.
  Mounted `:ro`; `caddy_data` / `caddy_config` named volumes so the ACME account and
  certs survive recreation (losing `caddy_data` burns Let's Encrypt rate limit).
- `.env.prod.example` (root) — every line commented with what it is and how it is
  generated; `CADDY_HTTP_PORT`/`CADDY_HTTPS_PORT` present but commented out (prod
  keeps 80/443; only local verification sets them).

### I2 — operations
- `deploy/bootstrap.sh` — root, Ubuntu 24.04, idempotent, `REPO_URL` variable at the
  top. Docker from Docker's apt repo → ufw (22,80,443/tcp + 443/udp, enable) →
  unattended-upgrades → 2 GB swapfile if none (the vite build on 4 GB RAM is the
  reason) → `/etc/docker/daemon.json` log caps **only if the file is absent**
  (never rewrite someone's daemon config) → SSH hardening in
  `/etc/ssh/sshd_config.d/99-budget.conf`, gated on `authorized_keys` having ≥1 key
  and `sshd -t` passing → ed25519 deploy key + `~/.ssh/config` host entry + clone to
  `/opt/budget` (clear "add this pubkey on GitHub, then rerun" exit if the clone
  fails) → `.env` from the example **only if absent**, filling the four secrets with
  `openssl rand -hex 32` and `SITE_DOMAIN=<ipv4-with-dashes>.sslip.io` from
  `ip -4 route get 1.1.1.1` → install the systemd units → print next steps.
  Deliberately does **not** start the stack; `update.sh` owns that.
- `deploy/update.sh` — `git pull --ff-only` → `build --pull` → `up -d
  --remove-orphans` → poll health (~2 min) → `docker image prune -f` +
  `builder prune -f --keep-storage 2G` → `df -h /`, warn at ≥85%. On failure: print
  `compose ps` + last api logs, exit non-zero.
- `deploy/backup.sh` — `pg_dump -Fc` → `$BACKUP_DIR/pg/budget-<UTC>.dump`, `mc mirror`
  receipts → `$BACKUP_DIR/receipts/` (additive, no `--remove`), rotate dumps past
  `BACKUP_RETENTION_DAYS`, optional R2 push, loud WARNING line when R2 is unset.
- `deploy/restore.sh <dump> [receipts-dir]` — requires `--yes`; stop api →
  terminate stragglers → `pg_restore --clean --if-exists` → mirror receipts back →
  start api (migrations re-run idempotently).
- `deploy/migrate-local-data.sh` — owner's Mac, optional: dump dev DB + mirror dev
  MinIO, tar, `scp`, print the `restore.sh` line to run on the server.
- `deploy/systemd/budget-backup.service` + `.timer` — daily `03:15 UTC`,
  `Persistent=true`, `WorkingDirectory=/opt/budget`, output to journald.
- `docs/deploy.md` (≤150 lines) — empty server → live site in owner-order (incl. the
  deploy-key dance), update, backup/restore, secret rotation and what each rotation
  kills (JWT → all sessions; VAPID → all push subscriptions; MinIO creds → must be
  changed in the API env in the same edit), domain switch = `SITE_DOMAIN` +
  `update.sh`, the real-IP chain and why `*` is acceptable, what is deliberately not
  published, disk hygiene, MCP note (`BUDGET_API_URL=https://<domain>/api`).

## Files to modify
- `apps/web/nginx.conf` — add at the top (conf.d is included in the `http` context,
  so `map` is legal there):
  `map $http_x_forwarded_proto $fwd_proto { default $http_x_forwarded_proto; "" $scheme; }`
  and use `$fwd_proto` in the two `/api/` locations instead of `$scheme`. Behind
  Caddy the header is `https`; in dev it is absent → `$scheme` → unchanged. Nothing
  else in the file moves.
- `.gitignore` — one line `!.env.prod.example` after the existing `.env.*` block.
- `PLAN.md` — 1.7 status at scope close (senior-lead).

## Tricky fragments

**XFF chain** — comment to sit next to the api `command:` in compose.prod (verified
against `uvicorn/middleware/proxy_headers.py` 0.51: with `always_trust`,
`get_trusted_client_address` returns `hosts[0]`, the leftmost):

```
# Real client IP, three hops: Caddy REPLACES any client-supplied X-Forwarded-For
# with the real peer IP (no trusted_proxies configured => nothing is trusted,
# Caddy >=2.5) -> nginx appends its own view via $proxy_add_x_forwarded_for, so
# the API sees "client, caddy" -> uvicorn with --forwarded-allow-ips='*' takes the
# LEFTMOST entry = the client. Per-IP rate limits key on that value, so this is
# only safe because api:8000 is NOT published: nothing outside this network can
# hand uvicorn a hand-written header.
```

**MinIO healthcheck without duplicating creds** — the probe must not re-interpolate
the password from compose (it would land in a second place and in `ps` output).
Escape `$` so the *container's* shell expands the container's own env:

```yaml
    healthcheck:
      test:
        - CMD-SHELL
        - mc alias set health http://127.0.0.1:9010 "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD"
          >/dev/null && mc ready health
```

Same `$$` trick in `minio-init`'s entrypoint (which also needs
`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in its own `environment:`, unlike dev where
they were literals).

**How backup.sh reaches MinIO** — via a `profiles: ["tools"]` service `mc` in
compose.prod, run as `docker compose -f docker-compose.prod.yml run --rm mc …`.
Chosen over `docker run --network budget-prod_default`: the profile keeps the
project name, network and credential env in the one file that already owns them,
and nothing has to hardcode the derived network name (which silently breaks if the
project is renamed). `profiles` means it never starts with `up -d`.

**restore.sh connection termination** — `pg_restore --clean` drops objects, and a
live API session holding them makes the drop hang. api is stopped first, then any
straggler is killed before the restore:

```sh
docker compose -f "$COMPOSE" exec -T postgres psql -U budget -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname = 'budget' AND pid <> pg_backend_pid();"
```

## Risks
- **Caddy HTTP→HTTPS redirect targets 443**, so the local 8480/8443 verification must
  hit `https://localhost:8443` directly (and `curl -k` / trust the internal CA);
  the port-80 redirect is expected to be useless locally and correct in prod.
- `caddy_data` loss = re-issuance; repeated recreation can hit the Let's Encrypt
  rate limit. Named volume + "never `down -v`" in docs/deploy.md.
- The `nginx.conf` `map` is shared with dev. If the `map` lands in the wrong context
  the container fails to start — cheap to catch, but it is a shared file, so dev
  compose has to be smoke-started once in I1.
- `CORS_ORIGINS` is built as `https://$SITE_DOMAIN` with no port, so during the
  8443 local run the origin string does not match the browser's. Harmless (traffic
  is same-origin; CORS is unused on this path) but will look wrong in a log.
- 4 GB RAM: `web` build (vite + pnpm install) is the memory peak. Swap mitigates;
  if it still OOMs the fallback is building the image on the Mac and pushing, which
  is out of scope here — flagging, not planning.
- `bootstrap.sh` edits sshd. The `authorized_keys` + `sshd -t` gate is the thing
  that keeps a typo from locking the owner out of a fresh VPS; it must not be
  "simplified" later.
- Dev/prod drift: two compose files now describe the same services. `docs/deploy.md`
  names the three settings that must stay in lockstep (the `minio.localhost` alias,
  `--address :9010`, `VITE_API_URL=/api`).

## Open questions
1. **Health poll URL in `update.sh` when the stack is not on 443.** Recommendation:
   build `https://$SITE_DOMAIN:${CADDY_HTTPS_PORT:-443}/api/health` and add `-k`
   only when `SITE_DOMAIN=localhost` (internal CA) — keeps one code path for prod
   and the local verification. Needs a yes/no, it changes the script's shape.
2. **Where the local-verification env lives.** Recommendation: `deploy/.env.verify`
   passed as `--env-file` (already gitignored by `.env.*`, and it keeps the owner's
   root `.env` untouched as the lead required). Alternative — inline `VAR=… docker
   compose` — loses reproducibility across QA runs.
3. **`minio-init` bucket policy.** Dev only does `mb --ignore-existing`; the bucket
   must stay private in prod. Recommendation: leave it exactly as dev (MinIO buckets
   are private by default and the API only serves presigned URLs) and let QA assert
   that an unsigned `/storage/receipts/<key>` is refused, rather than adding an
   `mc anonymous set none` call that changes dev/prod behaviour asymmetrically.
