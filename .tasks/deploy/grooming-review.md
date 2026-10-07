# Grooming review: deploy (2026-10-07) — scope grooming, PLAN.md 1.7

Team: backend-engineer (plan.md), qa-engineer (qa-checklist.md; FULL tier → stop-probe
design at grooming). Not invoked: architect (no new tables/modules; the structural
decisions — standalone compose, Caddy, project name, XFF chain — were taken by the lead
before fan-out and are listed in plan.md "Approach"); frontend-engineer (the only
`apps/web` edit is a 3-line nginx `map` in proxy config — backend-engineer owns it, a
second engineer for it costs a full boundary); mobile-* (frozen; nothing in `apps/mobile`);
web-qa at grooming (writes `qa-web-checklist.md` and runs it in one pass against the
I1 stand — standing precedent).

## Independent verifications (lead, not delegated)
- uvicorn 0.51 `--forwarded-allow-ips='*'` → `get_trusted_client_address` returns the
  LEFTMOST XFF entry (read in `.venv/.../proxy_headers.py`). The chain is therefore only
  as safe as Caddy's overwrite of a client-supplied header → P9 is mandatory, not optional.
- `nginx.conf` hardcodes `http://minio.localhost:9010/` in `sub_filter` and as the
  `/storage/` upstream Host → `S3_ENDPOINT_URL` stays byte-identical in prod; nothing
  host-specific reaches the browser. Confirmed in plan.md.
- `.gitignore`: `.env.*` then `!.env.example` → `.env.prod.example` needs its own
  exception line (plan has it).
- Local compose v2.21.0 has no `!override` → standalone file ruling stands.
- Ports 8480/8443 free on this machine (lsof).

## Subtasks

| ID | Content | Tier | Estimate (agent-min: write / gates / verify) | Depends |
|---|---|---|---|---|
| I1 | `docker-compose.prod.yml`, `deploy/Caddyfile`, `.env.prod.example`, nginx `map`, `.gitignore` | FULL | 15 / 5 / 25 (qa-engineer A–E ∥ web-qa) | — |
| I2 | `deploy/{bootstrap,update,backup,restore,migrate-local-data}.sh`, systemd pair, `docs/deploy.md` | FULL | 20 / 5 / 20 (+1 fix round if F finds functional) | I1 (service names, `mc` tools service) |

Order: I1 → lead diff gate → QA stand up (qa-engineer P1–P14 ∥ web-qa journeys) ∥ I2
(same engineer, continues) → lead diff gate on I2 → qa-engineer P15–P18 (destructive,
LAST) → code-reviewer (review code, not re-run gates) → meta-review only if MAJOR/BLOCKER
→ docs/ + PLAN.md.

## Rulings on plan.md open questions
1. **update.sh health URL** — ACCEPTED: `https://$SITE_DOMAIN:${CADDY_HTTPS_PORT:-443}/api/health`,
   `-k` ONLY when `SITE_DOMAIN=localhost`. One code path for prod and local verification.
2. **Local-verification env file** — RULED: the session scratchpad
   (`<scratch>/.env.prod.qa`), NOT `deploy/.env.verify`. A gitignored secrets file inside the
   repo tree is one `git add -f` away from a leak and would outlive the QA run. Scripts take
   `ENV_FILE` from the environment (R1) so the scratch path is passed, never hardcoded.
3. **Bucket policy** — ACCEPTED as recommended (identical to dev, private by default).
   QA adds the negative probe: unsigned `GET /storage/receipts/<key>` → 403 (P12, second half).

## Rulings on qa-checklist requirements R1–R8
- R1 ACCEPTED with one correction: `ENV_FILE` default is `.env` (the server's real file,
  which compose reads from `/opt/budget` anyway), not `.env.prod`. `COMPOSE_FILE` default
  `docker-compose.prod.yml`, `COMPOSE_PROJECT_NAME` default `budget-prod`.
- R2–R8 ACCEPTED verbatim. R4: rotation via `find -mtime +N` (mtime-keyed).
- Dev smoke-start after the nginx `map` edit (plan risk 3) — NOT required: `nginx -t`
  inside the freshly built web image (P4) exercises the same Dockerfile + nginx.conf the
  dev image uses; starting the dev stack buys nothing more and costs a rebuild.

## Amendments folded into I1/I2 at implementation
- AM-1: the `mc` tools service (profile `tools`) bind-mounts `${BACKUP_DIR:-/var/backups/budget}:/backup`
  and receives `MINIO_ROOT_USER/PASSWORD` + `R2_*` env, so backup.sh/restore.sh never pass
  secrets on the command line.
- AM-2: `backup.sh` offsite branch keys on ALL FOUR `R2_*` being non-empty; a partial set
  is an ERROR (exit non-zero, not the WARNING arm) — a half-configured offsite is a
  misconfiguration, not "not configured".
- AM-3: `bootstrap.sh` never prints a generated secret; it prints the deploy public key and
  the `.env` path only.
- AM-4: `docs/deploy.md` carries the CLAUDE.md table line for the orchestrator to add.

## Artifacts
plan.md · qa-checklist.md (P1–P18, R1–R8) · this file. web-qa checklist lands at I1 /test.
