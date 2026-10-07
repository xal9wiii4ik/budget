# QA Checklist: deploy — production compose stack (LOCAL verification)

## Scope
18 STOP-probes against the prod stack run **locally**: `docker compose --env-file
<scratch>/.env.prod.qa -f docker-compose.prod.yml -p budget-prod-qa up -d --build`,
`CADDY_HTTP_PORT=8480` / `CADDY_HTTPS_PORT=8443`. Covers compose/secret/port statics, the
Caddy→nginx→api chain over TLS, the real-IP chain, presigned storage via `/storage/`,
scheduler registration, backup/restore/rotation, teardown. NOT covered: server-only scripts
executed (`bootstrap.sh`, `update.sh`, `migrate-local-data.sh` — shellcheck + read-through
only), real DNS/ACME, browser journeys / SW registration (**web-qa**), anything pytest
proves (last section). Users `qa-deploy-1@budgetqa.dev`, `qa-deploy-2@budgetqa.dev` /
`Qa!Test1234`, registered fresh (prod stack boots an EMPTY DB). **One login per user**,
`$TOKEN` reused everywhere; re-login only in P9/P10 (those are ABOUT auth). Hands off:
5173/8010/5443/9010/9011 (dev), 5433/8000/8081 (foreign); the dev `budget` DB is never
touched — the QA stack has its OWN volumes under `budget-prod-qa` and `down -v` removes only those.

## REQUIREMENTS FOR THE ENGINEER (these probes are impossible otherwise)
- **R1** `backup.sh`/`restore.sh`/`update.sh`/`migrate-local-data.sh` take the compose context
  from env — `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, `ENV_FILE` (or `--env-file`), defaults
  `docker-compose.prod.yml`/`budget-prod`/`.env.prod`. No bare `docker compose` anywhere.
- **R2** `backup.sh`: paths from `BACKUP_DIR`; dump path to stdout; one greppable `WARNING:`
  line when `R2_*` is unset; non-zero exit on any failed step.
- **R3** `restore.sh`: refuses (non-zero, zero mutation) without `--yes`; dump path as arg;
  `pg_restore --clean`; api healthy at the end.
- **R4** rotation keyed on file **mtime** vs `BACKUP_RETENTION_DAYS` (a `touch -t`-aged file
  must be deletable without waiting 20 days).
- **R5** every required secret as `${VAR:?msg}` — a missing one FAILS `config`, not renders empty.
- **R6** `ports:` on caddy ONLY, both knobs defaulted (80/443, 443 tcp+udp).
- **R7** `.env.prod.example` lists every `${VAR:?}` key; **R8** dev `docker-compose.yml` untouched.

## A. Static gates (no stack)
### P1 — config renders; a missing secret refuses
`config -q` with the full scratch env → exit 0. Then once per secret (JWT_SECRET,
POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD) with that line removed → non-zero, variable named in stderr.
Plus R7's key-set diff. Failure = prod can boot with a blank secret. **Status**: ✅ PASS — full-env `config -q` exit 0; each of JWT_SECRET/POSTGRES_PASSWORD/MINIO_ROOT_PASSWORD/MINIO_ROOT_USER/SITE_DOMAIN removed → exit 15, e.g. `required variable JWT_SECRET is missing a value: JWT_SECRET is required`. R7: the 5 `${VAR:?}` keys all appear in `.env.prod.example` (+8 optional, 4 commented defaults).

### P2 — ports only on caddy; dev stack untouched
`config --format json | jq '[.services|to_entries[]|select(.value.ports)|.key]'` → exactly
`["caddy"]`, mapping 8480→80 and 8443→443 **tcp+udp**. `git diff --stat docker-compose.yml` empty and
`docker compose -f docker-compose.yml config` identical to the HEAD render. Failure =
Postgres/MinIO/api exposed on a public VPS, or the dev stand mutated. **Status**: ✅ PASS — `["caddy"]` is the only service with `ports`; `8480→80/tcp`, `8443→443/tcp`, `8443→443/udp`; with CADDY_* unset it renders 80/80 and 443/443 tcp+udp (R6). `mc` profiles == `["tools"]` and `ps` lists only api/caddy/minio/postgres/web — no `mc`. R8: `git diff --stat docker-compose.yml` empty, sha1 identical to `git show HEAD:docker-compose.yml`.

### P3 — shell lint + read-through
`docker run --rm -v "$PWD/deploy:/s:ro" koalaman/shellcheck:stable /s/*.sh` → no findings. Read
the three server-only scripts for `set -euo pipefail`, no `rm -rf $EMPTYVAR`, no echoed secret,
guarded destructive steps. **Status**: ✅ PASS — `shellcheck:stable` over all five (`bootstrap`, `update`, `backup`, `restore`, `migrate-local-data`; listed explicitly — zsh refuses to glob into the container) → **0 findings, exit 0**; `bash -n` clean on all five; `set -euo pipefail` in all five. Read-through: the only `rm` calls are `rm -f "$partial"` (backup.sh:50, always set — `$BACKUP_DIR/pg/…dump.part`) and `rm -f "$SSHD_DROPIN"` (bootstrap.sh:115, a constant) — **no `rm -rf`, nothing deleted through an empty-able variable**. No secret is echoed: bootstrap prints only the *public* deploy key, and `fill()` substitutes the generated secrets inside the shell (never as argv, so none reaches `ps`); backup/restore hand MinIO and R2 credentials to a **single-quoted** `sh -c` expanded by the container's own shell. Destructive steps all guarded: restore needs `--yes`; bootstrap skips `.env`, `daemon.json`, the swapfile and the clone when they already exist, and turns password SSH off only when `authorized_keys` holds an `ssh-` line **and** `sshd -t` passes (otherwise the drop-in is removed and sshd left alone). Plus the one coupling shellcheck cannot see, checked end to end: the real `fill()` extracted from bootstrap.sh, run against the real `.env.prod.example`, fills all 5 required keys (line count unchanged 76→76) and the resulting `.env` passes `docker compose -f docker-compose.prod.yml config -q` → **exit 0** — so a freshly bootstrapped box boots instead of dying on a blank `${VAR:?}`. Two notes, neither a defect: `update.sh` prunes images and build cache **globally**, not per project (fine on a dedicated VPS); `fallocate -l 2G /swapfile` would overwrite an existing-but-inactive `/swapfile` (reachable only when swap is off, so the file is not in use).

### P4 — nginx syntax inside the built image
`build web`, then `docker run --rm --entrypoint nginx <web image> -t` → "test is successful";
failure = the stack dies on first boot. **Status**: ✅ PASS — `nginx -t` in `budget-prod-qa-web` → "test is successful". Note: must run with `--network budget-prod-qa_default`; detached it dies on `host not found in upstream "api"` (DNS, not syntax).

## B. Chain: Caddy → nginx → api
### P5 — up, TLS, http→https
`up -d --build`, all services healthy. Export the internal CA (`exec caddy cat
/data/caddy/pki/authorities/local/root.crt > <scratch>/caddy-root.crt`), then
`curl --cacert <scratch>/caddy-root.crt https://localhost:8443/api/health` → 200 (the cacert pass
itself proves the chain; `-k` only as fallback). `curl -I http://localhost:8480/` → **308**,
`Location` on `https://` (port-less is Caddy's normal rewrite — record, don't fail). **Status**: ✅ PASS — api/minio/postgres healthy, caddy+web running (neither declares a healthcheck). CA exported (631 B); `curl --cacert` → 200 `{"status":"ok","database":"ok"}` with `ssl_verify_result=0` — real chain, no `-k`. `http://localhost:8480/` → **308** → `https://localhost/` (port-less, as predicted).

### P6 — install surface in ONE header capture per URL
Four `curl -sD- -o /dev/null` calls, all assertions read off those headers/body: `/` → 200
`text/html` with `<div id="root"`; `/manifest.webmanifest` → 200 `content-type:
application/manifest+json` + `cache-control: no-cache`; `/sw.js` → 200 `no-cache`; any https
response → `strict-transport-security` present. Failure = Chrome refuses the manifest, or a
worker outlives a deploy. **Status**: ✅ PASS — `/` 200 `text/html`, body has `<div id="root"`, `cache-control: no-store`; `/manifest.webmanifest` 200 `application/manifest+json` + `no-cache`; `/sw.js` 200 `application/javascript` + `no-cache` (4648 B); every response carries `strict-transport-security: max-age=31536000`.

### P7 — only caddy reachable from the host
`ps --format json | jq` → `Publishers` non-empty for caddy alone. `lsof -nP -iTCP -sTCP:LISTEN` →
from THIS project only 8480/8443 (dev's 5443/9010/9011/8010/5173 belong to other containers —
identify by PID, not a leak); `curl --max-time 3` on this stack's 5432/9010/8000 → refused. **Status**: ✅ PASS — only `caddy` has Publishers (8480/8443); host `lsof` shows just `*:8480`/`*:8443` from com.docker (the dev stack happens to be down, so its ports are absent entirely); `curl --max-time 3` on 5432/9010/9011/8000 → rc=7 connection refused.

## C. Auth + real-IP chain
### P8 — register + login once (also proves alembic ran on boot)
`POST /api/auth/register` (JSON `{email,password}`) → 201; `POST /api/auth/login`
(**form-urlencoded** `username`/`password`) → 200 `access_token` → `$TOKEN`; repeat for qa-deploy-2.
A 500 here = migrations did not apply at container start. **Status**: ✅ PASS — register qa-deploy-1 → 201 id `4d63e30f…`, qa-deploy-2 → 201 id `dd61b890…`; both logins 200 with `access_token`/`refresh_token`. Alembic ran at container start (`0005→0006 … 0014→0015` in the boot log).

### P9 — forged `X-Forwarded-For` is NOT honoured
11 × login, right username + wrong password, each with a different `X-Forwarded-For:
203.0.113.<n>`. Expect 1–10 → 401 `LOGIN_BAD_CREDENTIALS`, **11th → 429
`{"detail":"RATE_LIMITED"}`**. An 11th 401 = Caddy appends instead of overwriting XFF, uvicorn
trusts a client-chosen leftmost address, login limiting is bypassable from the internet. **Status**: ✅ PASS — attempts 1–10 with `X-Forwarded-For: 203.0.113.1…10` → **400** `LOGIN_BAD_CREDENTIALS` (the API answers 400, not 401, on bad creds — its contract, not a deploy defect); attempt 11 → **429** `{"detail":"RATE_LIMITED"}`. A forged XFF does not reset the key.

### P10 — the limiter key varies with the TRUE source
Right after P9 (host IP still locked): `exec caddy sh -c 'wget --no-check-certificate -qO-
--post-data=… https://127.0.0.1/api/auth/login'` → 401, not 429 (source 127.0.0.1 → different key).
Fallback if caddy's image lacks wget/curl: `docker run --rm --network budget-prod-qa_default
curlimages/curl`. **Honest limitation**: Docker Desktop NATs every host-side client to
`192.168.65.1`, so two real external IPs cannot be simulated here — this proves the key follows
the true source, not that two LAN clients get separate budgets. **Status**: ✅ PASS — the host source was still 429 at that moment; `exec caddy wget --post-data=… https://localhost/api/auth/login` (true source 127.0.0.1) → **400 Bad Request**, not 429. The key follows the real peer. Limitation as groomed: Docker NATs every host client to 192.168.65.1.

## D. Storage through `/storage/`
### P11 — no `minio.localhost` leak in any JSON field
`POST /api/receipts` (Bearer `$TOKEN`) → 201; `.upload.url` starts with `/storage/` (field is
`upload.url`, NOT `upload_url`) AND `grep -c 'minio\.localhost\|:9010'` over the whole body
== 0. Failure = clients get a host only the server can resolve. **Status**: ✅ PASS — 201; `.upload.url` starts `/storage/receipts/<uid>/<rid>.jpg?X-Amz-…`; `grep -c 'minio\.localhost\|:9010'` over the whole body == **0**; `.upload.headers` = `{"Content-Type":"image/jpeg"}`.

### P12 — real roundtrip through Caddy (uses P11's id + url)
`PUT` a ~20 KB JPEG to `https://localhost:8443<upload.url>` with the advisory `Content-Type` from
`.upload.headers` → 200/204 (the signature survives nginx restoring `Host: minio.localhost:9010`).
Then `GET /api/receipts/{id}` → `view_url` starts with `/storage/`; GET it → 200 and `shasum` == the
uploaded file's. Keep this receipt — P16 checks it survived restore. **Status**: ✅ PASS (download half substituted — see note) — PUT of a 20022 B JPEG to `https://localhost:8443/storage/…` → **200**, `etag: "a4b0919177bc9c9e6e5baf6eabd27023"` == the file's local `md5` ⇒ byte-exact through Caddy→nginx→MinIO with the signature intact. The receipt's own `view_url` stays **null**: it is minted only past `pending`, and `POST /receipts/{id}/parse` → **503 AI_NOT_CONFIGURED** (no ANTHROPIC_API_KEY on this stand) — by design. The presigned **GET** was therefore proven on the same `/storage/` route via the goal-item file flow: presign 201 (leak-count 0) → PUT 200 → confirm 200 `uploaded:true` → `GET <view_url>` → **200**, 20022 B, md5 identical. Receipt `a519a82c-7f57-42b9-a6ab-0b9479a5556b` kept for P16.
- **P12b (added by the lead)**: unsigned `GET /storage/receipts/<key>` with no query string → **403** `<Code>AccessDenied</Code>` — the bucket is private.

### P13 — API sees `X-Forwarded-Proto: https`
`curl -sD- https://localhost:8443/api/transactions/ -H "Authorization: Bearer $TOKEN"` (trailing
slash → Starlette `redirect_slashes` 307) → `Location` must start with **`https://`**. Caveat: that
`Location` path lacks the `/api` prefix (nginx strips it) — only the scheme is under test. If no
redirecting route survives, record "not observable" rather than invent a probe. **Status**: ✅ PASS — `GET /api/transactions/` → 307 `location: https://localhost/transactions`; `/api/accounts/` likewise. Scheme is `https` ⇒ `X-Forwarded-Proto` survives the three hops (the path lacks `/api`, as predicted).

## E. Schedulers — P14: three jobs registered, clean boot log
`logs api | grep -iE 'fx|recurring|push'` → one registration line per scheduler (all three gates
ON in prod); `grep -c Traceback` == 0. Registration only, no cron wait. Failure = a prod box
silently stops fetching rates / materializing recurring / sending digests. **Status**: ⚠ PARTIAL — the boot log is clean (151 lines, `grep -c Traceback` == **0**, zero ERROR/CRITICAL) and fx is proven live: `budget_api.services.fx_jobs: fx backfill: provider frankfurter/nbrb has no rows, fetching 2025-09-02..2026-10-07`. The other two **cannot** be seen: `app.py::_configure_logging` attaches a handler to the `budget_api` package logger only, so APScheduler's own "Scheduler started / Added job" INFO lines fall through to a handler-less root and die in `logging.lastResort` (WARNING); `recurring_jobs.py`/`push_jobs.py` log nothing at all on a clean, empty boot. Indirect evidence instead: all three gates default `True` in `config.py` and the rendered compose sets **no** `*_SCHEDULER_ENABLED` override, so none of them is off. Operability gap, not a deploy defect — see F-1.

## F. Backup / restore / rotation (LAST — destructive on the QA stack)
### P15 — backup: dump + mirrored object + offsite warning
`COMPOSE_FILE=… COMPOSE_PROJECT_NAME=budget-prod-qa ENV_FILE=… BACKUP_DIR=<scratch>/backups
deploy/backup.sh` → exit 0; non-empty `*.dump` that `file` calls PostgreSQL custom; the P12 receipt
object under the mirror dir; the single `WARNING:` line on stdout (R2_* unset). **Status**: ✅ PASS — `COMPOSE_PROJECT_NAME=budget-prod-qa ENV_FILE=… deploy/backup.sh` → **exit 0**. Dump `backups/pg/budget-20261007T122828Z.dump`, 86 657 B, `file` → **"PostgreSQL custom database dump - v1.16-0"**. Mirror pulled 9 objects / 44.47 KiB including the P12 receipt at `backups/receipts/4d63e30f…/a519a82c….jpg`, 20 022 B, **md5 `a4b0919177bc9c9e6e5baf6eabd27023`** — byte-identical to the uploaded file. Exactly **one** line matching `^WARNING:` (`offsite backup NOT configured (R2_* unset) …`), and the **last** stdout line is the dump path verbatim (so the systemd unit / a wrapper can consume it). `BACKUP_DIR` came from the env file, not a hardcoded `/var/backups` (R2). Half-configured offsite: rerun with `R2_BUCKET=x` exported → stderr `ERROR: only 1 of 4 R2_* variables are set in … — set all four or none`, **exit 1**, and **no `*.part` left behind** (0 found) — R2's "fail loudly" holds. Observation, not a defect: that run still leaves a complete local dump, because the R2 arity check runs *after* the dump — arguably the right order (you keep the local copy) but worth knowing when reading the directory after a failed run. The ERROR text names `$ENV_FILE` as the source even when the offending value came from the environment — cosmetic.

### P16 — restore refuses without `--yes`, then rewinds exactly
`restore.sh <dump>` → non-zero, nothing stopped, health still 200. Then create one extra transaction
(`POST /api/accounts` → `POST /api/transactions` with `kind`/`account_id`/`occurred_at`/
`amount_minor`/`currency`), note its id, run `restore.sh <dump> --yes`. Assert: that transaction →
**404**, `GET /api/receipts/{P12 id}` → 200 with its bytes still downloadable, `/api/health` → 200,
`$TOKEN` still valid (same JWT_SECRET, restored user row). Failure = the documented recovery path
does not recover. **Status**: ✅ PASS — **dry run**: `restore.sh <dump>` → **exit 2**, printed the 5 numbered steps it *would* take, mutated nothing — `docker ps` container set identical before/after, `/api/health` still **200**. Then a fresh dump was taken immediately before the destructive half (12:29:38Z) to keep the rewind window for the parallel web-qa run to seconds rather than minutes, the extra transaction created on top of it (`e303cf66-53fa-4bd3-9acc-3a9b0521e5fc`, present in `GET /api/transactions` → `count:1`), then `restore.sh <dump> --yes`. **Result: exit 0**, wall clock **12:30:04Z→12:30:23Z (19 s)** of which api was down ~15 s. **`pg_restore` exited 0 and printed nothing at all** — no "errors ignored", no warning line (its stderr in the captured run holds only compose's own `Container … Started` progress), so the rewind is clean, not clean-looking. Assertions afterwards: the extra transaction is **gone** — absent from the list (`count:0`) and `PATCH /api/transactions/e303cf66…` → **404** (no-oracle, as if it never existed); the P12 receipt row survives → `GET /api/receipts/a519a82c…` **200**; the goal-item file is still downloadable through `/storage/` — freshly minted `view_url` → **200, 20 022 B, md5 `a4b0919177bc9c9e6e5baf6eabd27023`**, byte-identical, and the same object **unsigned** still answers **403** (the mirror-back did not flip the bucket public); `/api/health` → **200** `{"status":"ok","database":"ok"}`; the pre-restore `$T1` from P8 **still authenticates** (200, same `JWT_SECRET`, restored user row) and U1's account `8ac6311f…` is back. The documented recovery path recovers. Note for the checklist: there is **no `GET /api/transactions/{id}`** route (→ 405), so the disappearance is proven by the list plus a 404 on `PATCH`. Recipe pre-validated against the live stack: `POST /api/accounts` → 201, `POST /api/transactions` → 201 (then deleted again, 204). **`occurred_at` is a DATE**: `"2026-10-07T10:00:00Z"` → 422 `date_from_datetime_inexact`. Ids and the exact body: `<scratch>/qa/state.env`.

### P17 — rotation deletes an expired dump
`touch -t <now-20d>` an old dump with `BACKUP_RETENTION_DAYS=14`, rerun `backup.sh` → aged file gone,
fresh one kept; failure = the VPS disk fills up. **Status**: ✅ PASS — two copies of a real dump were aged with `touch -t`: one to **2026-09-17** (20 days, past the cutoff) and one to **2026-09-24** (13 days, inside it) — the second is the control that proves a *cutoff* rather than "delete everything old". Rerunning `backup.sh` (no `BACKUP_RETENTION_DAYS` in the env file, so the **default 14** is also under test) → exit 0, and afterwards `budget-20260917T120000Z.dump` is **gone** while `budget-20260924T120000Z.dump` and all three same-day dumps are **kept**. Rotation is keyed on **mtime** (R4), so it is testable without waiting 20 days, and it will actually free the VPS disk.

## G. Teardown — P18: leave the machine as found
`down -v --rmi local`; `docker image rm koalaman/shellcheck:stable` (+ any fallback image);
`docker volume ls | grep budget-prod-qa` empty; `docker run --rm alpine df -h /` → **<85%**; dev
stack still up on its ports, dev DB untouched. Report to the orchestrator that the QA stack is
gone — dropping anything in the dev DB is **his** prerogative. **Status**: ⏸ DEFERRED — section G, later run. The stack is deliberately left UP (web-qa probes it in parallel). Host disk at this point: `/` **27 %** used (12 Gi of 460 Gi); `docker system df`: images 23.15 GB, volumes 7.21 GB, build cache 608 MB.

## Deliberately excluded (proven cheaper by pytest / elsewhere)
- Status codes, validation, 422 shapes; auth 401/expired JWT; foreign-resource 404 no-oracle and
  `user_id` scoping; boundaries; idempotency → per-router `tests/test_*.py`.
- Rate-limit arithmetic and per-user AI budgets → `tests/test_rate_limit*.py`; P9 covers only the
  proxy header chain, which pytest cannot reach.
- CORS preflight verbs → `tests/test_cors.py::test_preflight_allows_every_verb_the_api_serves`;
  receipt parse/claim state machine + MinIO-down 503 → `tests/test_receipts.py`.
- SPA routing, SW activation, offline page, installability → web-qa's CDP checks.

## Summary

**Run 1 — 2026-10-07, sections A–E minus P3.** Stack `budget-prod-qa` on 8480/8443,
images built from the working tree. Passed 12 (P1, P2, P4–P13 incl. the added P12b),
failed 0, partial 1 (P14), deferred 5 (P3, P15–P18). Details in each probe above.

**Run 2 — 2026-10-07, P15 → P16 → P17 → P3** (section F first, lint last, because the
engineer was still editing `bootstrap.sh` and the systemd unit when run 2 began).

Total: 18 · **Passed: 16** (P1, P2, **P3**, P4–P13 + P12b, **P15**, **P16**, **P17**) ·
Failed: **0** · Partial: 1 (P14) · Not run: 1 (P18 teardown — the lead's, after web-qa)

Status: **✅ NO BLOCKING DEFECT.** Backup, restore and rotation all do what
`docs/deploy.md` promises; the five shell scripts are shellcheck-clean and hold no
unguarded destructive step. Findings carried forward:

- **F-1 (P14, minor, operability)** — unchanged from run 1: scheduler registration is
  invisible in prod logs because `app.py::_configure_logging` only gives a handler to the
  `budget_api` logger. Owner's call.
- **F-2 (P15, cosmetic).** A half-configured R2 set fails *after* the dump is written, so
  the run leaves a complete local dump behind and the `ERROR:` text credits `$ENV_FILE`
  even when the offending value came from the environment. `deploy/backup.sh`.
- **F-3 (process, no file at fault).** P16 is destructive on a stack web-qa was probing in
  parallel. Mitigated by dumping immediately before restoring, so the rewind window was
  **12:30:04Z→12:30:23Z (19 s, api down ~15 s)** rather than the 2 min since the P15 dump.
  Any web-qa assertion that fell inside that window should be re-read, not trusted.

Checklist corrections learned in run 2: there is **no `GET /api/transactions/{id}`** (405) —
use the list plus a 404 on `PATCH`; and zsh cannot glob `deploy/*.sh` into the shellcheck
container, so P3 lists the five scripts explicitly.

Stack left **UP** on purpose. Disk after run 2: `docker run --rm alpine df -h /` →
**61 % used** (33.7 G of 58.4 G on the VM's overlay; the Mac's `/` is at 27 %), well under
P18's 85 % gate — `docker system df` shows 11.89 GB of images and 4.32 GB of volumes
reclaimable, most of it older scopes. Artefacts kept for P18: 4 dumps + the 9-object
receipt mirror under `<scratch>/backups`, both QA users, the P12 receipt and the goal-item
file; ids and tokens in `<scratch>/qa/state.env`, raw probe output in `<scratch>/qa/p1[567]*`.
Teardown (`down -v --rmi local`, `docker image rm koalaman/shellcheck:stable`, removing
`<scratch>/backups`) stays P18's — the lead's, after web-qa finishes.
