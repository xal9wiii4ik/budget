# QA Checklist: api-skeleton (roadmap 0.2)

## Scope

Verification of the FastAPI skeleton: the single real endpoint (`GET /health`),
its exact response contract (architecture §6), Alembic wiring, the now-real
`dev`/`typecheck` scripts, the Dockerfile, and config hygiene. Run **after**
implementation, not now.

**In scope:** `/health` happy + DB-down + recovery paths, prompt-failure timing,
JSON content-type / 404 / OpenAPI availability, Alembic no-op + empty-autogenerate
wiring, pyright/dev/lint scripts becoming real, Docker build/non-root/standalone-boot,
`.env.example`/`.gitignore` hygiene, and the scaffold-lifetime deletion of
`test_placeholder.py`.

**Out of scope (binding):** no auth, no business tables, no CI, no prod compose.
No validation/authorization/boundary cases — there is exactly one unauthenticated,
parameterless GET endpoint, so categories 2–8 of the standard matrix collapse to
"unknown route → 404" and "DB-down → 503". Do not invent checks for features that
don't exist yet.

## Preconditions

- Repo root `docker-compose.yml` exists with a `postgres:17-alpine` service on host
  port **5433**, databases `budget` and `budget_test` (init script creates the
  latter). Bring it up once: `docker compose up -d postgres`.
- All `pnpm turbo …` commands are run from repo root; all `uv run …` and
  `docker build` commands are run from `apps/api` (per architecture §5, §10).
- Dev server target: `pnpm turbo dev --filter=@budget/api` → uvicorn on port 8000.

---

## Section A — Automated test suite gate (pytest, owned by backend-engineer)

### TC-A1: Test suite passes
- **Command** (repo root): `pnpm turbo test --filter=@budget/api`
  (equivalently, from `apps/api`: `uv run pytest`)
- **Expected**: exit 0, all tests pass; compose Postgres must be up (`budget_test`
  reachable) or the fail-fast conftest check fires first (see TC-G1).
- **Pass/fail**: PASS iff exit 0 and the two health tests below are collected and green.
- **Status**: ✅ PASS — `pnpm turbo test --filter=@budget/api --env-mode=loose` exit 0;
  2 passed in 0.14s (TEST_DATABASE_URL → 5443/budget_test per D7).

### TC-A2: Placeholder test is gone (scaffold-lifetime rule, non-optional)
- **Command** (repo root):
  `test ! -e apps/api/tests/test_placeholder.py && echo ABSENT || echo PRESENT`
- **Expected**: `ABSENT`.
- **Pass/fail**: PASS iff file does not exist. If PRESENT → FAIL, escalate
  (binding carry-forward from 0.1 §1.3).
- **Status**: ✅ PASS — `apps/api/tests/test_placeholder.py` → ABSENT.

### TC-A3: Required pytest tests exist and assert the right things
- **Command** (apps/api): `uv run pytest tests/test_health.py -v`
- **Expected — the file must contain (at least) these two tests:**
  1. **Healthy /health** — app fixture pointed at `budget_test` via explicit
     `Settings`, real request over httpx `ASGITransport` + `asgi-lifespan` (lifespan
     runs). Asserts `status_code == 200` AND body **exactly** `{"status":"ok",
     "database":"ok"}` (no extra keys). This is the test that proves engine →
     sessionmaker → `get_session` dependency → pool → asyncpg wiring; it must NOT
     mock the DB.
  2. **DB-down /health** — second app instance built with a deliberately unreachable
     `database_url` (closed localhost port). Asserts `status_code == 503` AND body
     **exactly** `{"status":"degraded","database":"unavailable"}`, and that it returns
     promptly (no monkeypatching of internals).
- **Pass/fail**: PASS iff both tests are present, green, and assert the exact
  contract JSON (not a subset/superset). Note if either mocks the DB session — that
  would defeat the test's purpose (architecture §8) → flag to senior-lead, don't edit.
- **Status**: ✅ PASS — both tests present & green (`-v`). `test_health_ok` asserts
  exact `{"status":"ok","database":"ok"}` via real `ASGITransport` client, no DB mock;
  `test_health_db_unavailable` builds a 2nd app on unreachable port 5599, asserts exact
  `{"status":"degraded","database":"unavailable"}` (503) and `elapsed < 5`. No mocking.

---

## Section B — Live endpoint checks (curl, owned by QA)

> Start the dev server first: `pnpm turbo dev --filter=@budget/api` (uvicorn :8000),
> compose Postgres up.

### TC-B1: GET /health, DB up → exact 200 contract
- **Method/Endpoint**: GET /health
- **curl**:
```bash
curl -s -o /tmp/h.json -w '%{http_code} %{content_type}\n' http://localhost:8000/health
cat /tmp/h.json
```
- **Expected**: status `200`; `Content-Type: application/json`; body **exactly**
  `{"status":"ok","database":"ok"}` — no extra fields.
- **Pass/fail**: PASS iff code 200 AND (verify exact JSON):
```bash
diff <(echo '{"status":"ok","database":"ok"}' | jq -S .) <(jq -S . /tmp/h.json) && echo EXACT
```
  prints `EXACT`.
- **Status**: ✅ PASS — 200, `application/json`, body EXACT `{"status":"ok","database":"ok"}`.

### TC-B2: GET /health, DB stopped → exact 503 contract AND prompt failure
- **Order dependency**: run after TC-B1; leaves DB stopped for the timing assertion.
- **Setup**: `docker compose stop postgres`
- **curl**:
```bash
docker compose stop postgres
curl -s -o /tmp/h.json -w '%{http_code} time=%{time_total}s\n' http://localhost:8000/health
cat /tmp/h.json
```
- **Expected**: status `503`; body **exactly** `{"status":"degraded","database":"unavailable"}`;
  `time_total` in low single-digit seconds (≲ ~3s, i.e. the capped ping per §6 —
  **NOT** ~60s asyncpg default connect timeout).
- **Pass/fail**: PASS iff code 503 AND exact JSON (same `jq -S` diff as TC-B1 vs the
  degraded body) AND `time_total` < 5s. A ~60s hang → FAIL (ping cap not wired).
- **Status**: ✅ PASS — after `docker compose stop postgres`: 503, body EXACT
  `{"status":"degraded","database":"unavailable"}`, `time_total=0.006s` (connection
  refused, near-instant — well under the 5s cap; no 60s asyncpg hang).

### TC-B3: Restart DB → /health recovers to 200 WITHOUT restarting the API
- **Order dependency**: run after TC-B2 (API process must be the same one, never
  restarted — this proves the connection pool self-heals).
- **curl**:
```bash
docker compose start postgres
# give PG a couple seconds to accept connections, then poll (do NOT restart uvicorn)
for i in $(seq 1 10); do
  code=$(curl -s -o /tmp/h.json -w '%{http_code}' http://localhost:8000/health)
  [ "$code" = "200" ] && break; sleep 1
done
echo "final=$code"; cat /tmp/h.json
```
- **Expected**: recovers to `200` with `{"status":"ok","database":"ok"}` while the
  uvicorn process from TC-B1 is still running (never killed/reloaded).
- **Pass/fail**: PASS iff it returns to 200 without an API restart. If it only
  recovers after restarting uvicorn → FAIL (pool does not recover), escalate.
- **Status**: ✅ PASS — after `docker compose start postgres`, same uvicorn (pid 64765,
  never restarted): iter1=503 (the expected one-time stale-connection invalidation per
  grooming §5.5), iter2=200 with EXACT `{"status":"ok","database":"ok"}`. Pool self-healed.

### TC-B4: Unknown route → 404 JSON
- **curl**:
```bash
curl -s -o /tmp/h.json -w '%{http_code} %{content_type}\n' http://localhost:8000/nope-does-not-exist
cat /tmp/h.json
```
- **Expected**: `404`, `Content-Type: application/json`, body is JSON (FastAPI default
  `{"detail":"Not Found"}`).
- **Pass/fail**: PASS iff 404 AND content-type contains `application/json` AND body
  parses as JSON (`jq . /tmp/h.json` exits 0).
- **Status**: ✅ PASS — 404, `application/json`, body `{"detail":"Not Found"}` (valid JSON).

### TC-B5: OpenAPI docs served (0.3 depends on the schema existing)
- **curl**:
```bash
curl -s -o /dev/null -w 'docs=%{http_code}\n'    http://localhost:8000/docs
curl -s -o /tmp/openapi.json -w 'openapi=%{http_code} ct=%{content_type}\n' http://localhost:8000/openapi.json
jq -r '.info.title, .info.version, (.paths | keys | join(","))' /tmp/openapi.json
# A5: the degraded 503 branch must be declared in the schema (responses={503: ...}),
# else 0.3's generated client can't see it. Assert BOTH status codes are present.
jq -r '.paths."/health".get.responses | keys | join(",")' /tmp/openapi.json
jq -e '.paths."/health".get.responses | has("200") and has("503")' /tmp/openapi.json \
  && echo RESPONSES_OK || echo RESPONSES_MISSING
```
- **Expected**: `/docs` → 200 (HTML); `/openapi.json` → 200 `application/json`; schema
  `.info.title == "Budget API"`, `.info.version` == package `__version__` (proves
  `__version__` is wired into `FastAPI(version=...)` per §8), and `.paths` includes
  `/health`. Additionally (A5), `.paths."/health".get.responses` contains **both**
  `"200"` and `"503"` — the 503 is declared via `responses={503: {...}}` on the route.
- **Pass/fail**: PASS iff both 200, openapi is valid JSON with title "Budget API",
  `/health` present in paths, AND the `has("200") and has("503")` check prints
  `RESPONSES_OK`. If `"503"` is absent → FAIL (A5 not wired).
- **Status**: ✅ PASS — `/docs`=200, `/openapi.json`=200 `application/json`; title
  "Budget API", version `0.1.0` == `__version__`; `/health` in paths;
  `.paths."/health".get.responses` keys = `200,503` → RESPONSES_OK (A5 wired).

---

## Section C — Alembic wiring (run from apps/api, DB up)

### TC-C1: `alembic upgrade head` is a clean no-op
- **Command** (apps/api): `uv run alembic upgrade head`
- **Expected**: exit 0, no error; with zero committed revisions this does nothing
  (no tables created). Proves `env.py` builds the async engine from `Settings` and
  connects.
- **Pass/fail**: PASS iff exit 0 and no traceback.
- **Status**: ✅ PASS — `alembic upgrade head` exit 0, no traceback (no revisions → no-op).

### TC-C2: `alembic check` reports no new operations
- **Command** (apps/api): `uv run alembic check`
- **Expected**: exit 0, "No new upgrade operations detected." Proves
  `target_metadata = Base.metadata` matches the (empty) DB.
- **Pass/fail**: PASS iff exit 0 / no-diff message.
- **Status**: ✅ PASS — `alembic check` exit 0, "No new upgrade operations detected."

### TC-C3: Throwaway autogenerate produces an EMPTY migration (metadata wiring proof)
- **Rationale**: `alembic check` passing could mean config parses but metadata is
  empty/unwired. Generating a revision and confirming it has empty `upgrade()`/
  `downgrade()` bodies proves `target_metadata` is actually `Base.metadata` and that
  `env.py` imports `budget_api.models` (re-export hook), while there genuinely being
  zero tables. Delete it afterward — no revision is committed at 0.2.
- **Command** (apps/api):
```bash
uv run alembic revision --autogenerate -m tmp_qa_probe
NEW=$(ls -t alembic/versions/*.py | head -1)
echo "generated: $NEW"; sed -n '/def upgrade/,/def downgrade/p' "$NEW"
rm -f "$NEW"
ls alembic/versions/   # expect only .gitkeep remaining
```
- **Expected**: revision created; `upgrade()` and `downgrade()` bodies are just
  `pass` (no `op.create_table`/`op.add_column`). After `rm`, `alembic/versions/`
  contains only `.gitkeep`.
- **Pass/fail**: PASS iff generated `upgrade()` is empty (only `pass`) AND the probe
  file is removed leaving just `.gitkeep`. If the file failed to generate → wiring
  broken. If it contains operations → unexpected tables leaked in → escalate.
- **Cleanup note**: this test must leave `git status` on `apps/api/alembic/versions/`
  clean (only `.gitkeep` tracked). Confirm: `git status --porcelain apps/api/alembic/versions/`
  is empty.
- **Status**: ✅ PASS — generated `5977d026b569_tmp_qa_probe.py`; `upgrade()`/`downgrade()`
  bodies are only `pass` (no ops); removed → `versions/` has only `.gitkeep` (+ ignored
  `__pycache__`). Note: whole `apps/api` tree is still untracked per D7 pre-commit state,
  so `git status` shows `?? apps/api/alembic/versions/`; the probe `.py` is confirmed gone.

---

## Section D — Scripts became real

### TC-D1: `typecheck` runs pyright and actually fails on a type error
- **Rationale**: 0.1 left `typecheck` as `exit 0`. Prove it now runs pyright by
  probing with a deliberate error and confirming non-zero exit, then revert.
- **Baseline** (repo root): `pnpm turbo typecheck --filter=@budget/api` → PASS (exit 0)
  on clean tree.
- **Probe**: introduce a deliberate type error into a `src/` file, e.g. append to a
  module: `_qa_probe: int = "not an int"`. Then re-run:
```bash
pnpm turbo typecheck --filter=@budget/api; echo "exit=$?"
```
- **Expected**: baseline exits 0; probed run exits **non-zero** with a pyright
  diagnostic (`Type "str" is not assignable to declared type "int"` or similar).
- **Revert**: remove the probe line; re-run typecheck → back to exit 0. Confirm
  `git status --porcelain apps/api/src/` is clean afterward.
- **Pass/fail**: PASS iff clean=0, probe≠0, revert=0. If probe still exits 0 →
  `typecheck` is still a no-op → FAIL.
- **Status**: ✅ PASS — baseline exit 0; probe (`_qa_probe: int = "not an int"` appended
  to `config.py`) → exit 1 with pyright `config.py:24:18 - error: Type "Literal['not an
  int']" is not assignable to declared type "int" (reportAssignmentType)`; reverted →
  exit 0; `grep -c _qa_probe config.py` = 0 (no residue).

### TC-D2: `dev` boots uvicorn (no longer an echo no-op)
- **Command** (repo root): `pnpm turbo dev --filter=@budget/api` (or inspect
  `apps/api/package.json` `dev` script == `uv run uvicorn budget_api.app:create_app
  --factory --reload`).
- **Expected**: uvicorn actually starts and serves; TC-B1 succeeding against :8000 is
  the functional proof. Script is NOT `echo` / `exit 0`.
- **Pass/fail**: PASS iff the process binds :8000 and /health responds (covered by
  TC-B1). Inspect the script string to confirm it invokes uvicorn, not echo.
- **Status**: ✅ PASS — `dev` = `uv run uvicorn budget_api.app:create_app --factory
  --reload` (not echo); functionally proven by TC-B1 answering 200 on :8000.

### TC-D3: Lint passes with the expanded rule set
- **Command** (repo root): `pnpm turbo lint --filter=@budget/api`
- **Expected**: exit 0. Ruff select is `E W F I UP B C4 SIM RUF ASYNC` (§9), and it
  lints `alembic/env.py` too (turbo inputs include `alembic/**`).
- **Pass/fail**: PASS iff exit 0. (Optional sanity: `uv run ruff check --show-settings`
  or inspect `pyproject.toml [tool.ruff.lint] select` matches the §9 set.)
- **Status**: ✅ PASS — `pnpm turbo lint` exit 0; `select = ["E","W","F","I","UP","B",
  "C4","SIM","RUF","ASYNC"]` matches §9 exactly.

---

## Section E — Docker (run from apps/api)

### TC-E1: Image builds
- **Command** (apps/api): `docker build -t budget-api:qa .`
- **Expected**: build succeeds; multi-stage, uv-based; context is `apps/api` (no
  pnpm/repo-root files needed). `.dockerignore` excludes `.venv/`, `__pycache__`,
  `tests/`, `.env`.
- **Pass/fail**: PASS iff build exits 0.
- **Status**: ✅ PASS — `docker build -t budget-api:qa .` exit 0 (image kept for E2–E4).

### TC-E2: Container runs as non-root
- **Command**:
```bash
docker run --rm --entrypoint sh budget-api:qa -c 'id; whoami'
```
- **Expected**: user `app`, uid `1000` (not root / uid 0).
- **Pass/fail**: PASS iff `uid=1000` and not `root`.
- **Status**: ✅ PASS — `uid=1000(app) gid=1000(app) groups=1000(app)`, `whoami`=app.

### TC-E3: Container boots standalone WITHOUT a DB → 503-degraded contract
- **Rationale**: proves the app process boots and serves even with no reachable DB
  (503-degraded is the expected standalone result, §10/§6).
- **Command**:
```bash
docker run -d --name budget-api-qa -p 8001:8000 \
  -e DATABASE_URL='postgresql+asyncpg://budget:budget@127.0.0.1:5999/budget' \
  budget-api:qa
sleep 3
curl -s -o /tmp/h.json -w '%{http_code}\n' http://localhost:8001/health; cat /tmp/h.json
docker rm -f budget-api-qa
```
  (127.0.0.1:5999 inside the container is a closed port → DB unreachable.)
- **Expected**: `503` and exactly `{"status":"degraded","database":"unavailable"}`;
  container stayed up (app booted).
- **Pass/fail**: PASS iff 503 + exact degraded JSON AND the container was running to
  answer at all.
- **Status**: ✅ PASS — DATABASE_URL → closed 127.0.0.1:5999; container `Running=true`,
  503 with EXACT `{"status":"degraded","database":"unavailable"}`. Container removed after.

### TC-E4: Container with working DATABASE_URL → 200
- **Order dependency**: compose Postgres up (TC preconditions).
- **Command**:
```bash
docker run -d --name budget-api-qa -p 8001:8000 \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL='postgresql+asyncpg://budget:budget@host.docker.internal:5433/budget' \
  budget-api:qa
sleep 3
curl -s -o /tmp/h.json -w '%{http_code}\n' http://localhost:8001/health; cat /tmp/h.json
docker rm -f budget-api-qa
```
- **Expected**: `200` and exactly `{"status":"ok","database":"ok"}` — the container
  reaches host compose Postgres via `host.docker.internal:5433`.
- **Pass/fail**: PASS iff 200 + exact ok JSON. (On Docker Desktop for macOS
  `host.docker.internal` resolves; `--add-host …:host-gateway` is included for
  portability.)
- **Status**: ✅ PASS — via `host.docker.internal:5443` (D7-local substitution; committed
  contract is 5433): container `Running=true`, 200 with EXACT `{"status":"ok","database":
  "ok"}`. Container removed after.

---

## Section F — Config hygiene

### TC-F1: `.env.example` exists and DATABASE_URL matches compose (port 5433)
- **Command** (repo root):
```bash
cat apps/api/.env.example
grep -q '5433' apps/api/.env.example && echo PORT_OK || echo PORT_WRONG
```
- **Expected**: file present; single `DATABASE_URL` line ==
  `postgresql+asyncpg://budget:budget@localhost:5433/budget` (§3/§8). No other secrets.
- **Pass/fail**: PASS iff file exists, uses `postgresql+asyncpg` scheme, port `5433`,
  db `budget`. If it says `5432` or `5533` → FAIL (5433 is the corrected reality).
- **Status**: ✅ PASS — committed `.env.example` = `postgresql+asyncpg://budget:budget@
  localhost:5433/budget` → PORT_OK (5433, not 5432/5533). No local 5443 leaked in.

### TC-F2: `.env` is gitignored
- **Command** (repo root): `git check-ignore apps/api/.env; echo "exit=$?"`
- **Expected**: prints `apps/api/.env` and exit 0 (path is ignored by root
  `.gitignore`).
- **Pass/fail**: PASS iff exit 0. If exit 1 (not ignored) → FAIL, risk of committing
  secrets.
- **Status**: ✅ PASS — `git check-ignore apps/api/.env` prints the path, exit 0.

### TC-F3: No secrets committed / tracked
- **Command** (repo root): `git ls-files apps/api | grep -E '(^|/)\.env$' && echo FOUND || echo NONE`
- **Expected**: `NONE` — no tracked `.env`. Only `.env.example` is tracked.
- **Pass/fail**: PASS iff no real `.env` is tracked.
- **Status**: ✅ PASS — `git ls-files apps/api | grep '\.env$'` → NONE (only `.env.example`).

### TC-F4: root README documents "Run the API locally" (A2/A4 coverage)
- **Rationale**: amendment A2 added a root README "Run the API locally" section; A4
  makes QA verify it so the amendment isn't gated by diff-review alone (the failure
  mode of 0.1's amendment 2.1). Must mention the contract host port `5433` and the
  `docker compose down -v` caveat for recreating `budget_test`.
- **Command** (repo root):
```bash
grep -qF 'Run the API locally' README.md && echo SECTION_OK || echo SECTION_MISSING
# 5433 must appear inside the "Run the API locally" section (not merely somewhere else)
awk '/^## Run the API locally$/{f=1} /^## /{if(f && $0!="## Run the API locally"){f=0}} f' README.md \
  | grep -q '5433' && echo PORT_OK || echo PORT_MISSING
awk '/^## Run the API locally$/{f=1} /^## /{if(f && $0!="## Run the API locally"){f=0}} f' README.md \
  | grep -q 'docker compose down -v' && echo CAVEAT_OK || echo CAVEAT_MISSING
awk '/^## Run the API locally$/{f=1} /^## /{if(f && $0!="## Run the API locally"){f=0}} f' README.md \
  | grep -qi 'budget_test' && echo TESTDB_OK || echo TESTDB_MISSING
```
- **Expected**: `SECTION_OK`, `PORT_OK`, `CAVEAT_OK`, `TESTDB_OK` — the section exists
  and, within it, references host port `5433`, the `docker compose down -v` recreate
  command, and the `budget_test` database it recreates.
- **Pass/fail**: PASS iff all four echo `_OK`. If the section is missing, or names a
  different port (e.g. `5432`/`5533`), or omits the `down -v` caveat → FAIL.
- **Status**: ✅ PASS — `## Run the API locally` section present; within it: `5433`
  (PORT_OK), `docker compose down -v && docker compose up -d postgres` (CAVEAT_OK), and
  `budget_test` (TESTDB_OK). All four markers OK.

---

## Section G — Failure-mode note

### TC-G1: Compose not running at test start → documented fail-fast
- **Rationale (not a normal-run assertion, a resilience check):** the shared-test-DB
  strategy (§8) means tests fail if compose is down; the mitigation is a fail-fast
  conftest check with a clear message.
- **Procedure**: with Postgres stopped (`docker compose stop postgres`), run
  `uv run pytest` from `apps/api`.
- **Expected**: fast, clear failure telling the developer to
  `docker compose up -d postgres` — NOT a 60s hang or an opaque asyncpg
  `ConnectionRefusedError` stack with no guidance.
- **Pass/fail**: PASS iff the suite fails fast with an actionable message. Then bring
  Postgres back up before re-running the real suite.
- **QA action on encountering this state for real**: do not attempt to fix code —
  bring compose up (`docker compose up -d postgres`) and note it; if the message is
  missing/unclear, report to senior-lead.
- **Status**: ✅ PASS — with `docker compose stop postgres`, `uv run pytest` exited 1 in
  0.42s (no tests ran) with the actionable message: `test Postgres unreachable (Multiple
  exceptions: [Errno 61] Connect call failed ... 5443 ...) — run: docker compose up -d
  postgres`. No 60s hang (A6 cap holds). Postgres restarted → suite 2 passed again.

---

## Contract ambiguities / untestable points (raise with senior-lead)

- **Ping cap exact threshold**: §6 says "capped (e.g. `asyncio.wait_for(~2s)`) …
  low single-digit seconds," leaving the exact value to the engineer. I assert
  `time_total < 5s` in TC-B2 as a generous upper bound that still distinguishes a
  real cap from the ~60s asyncpg default. If the team wants a tighter SLA (e.g. <3s),
  say so and I'll adjust.
- **`__version__` value in OpenAPI**: TC-B5 asserts `.info.version` equals the package
  `__version__`, but the checklist can't know that literal ahead of time — I read it
  from `src/budget_api/__init__.py` at run time and compare. Flagging so the assertion
  isn't mistaken for a hardcoded expectation.
- **DB-recovery timing (TC-B3)**: pool self-heal depends on asyncpg reconnecting after
  `docker compose start`. I poll up to ~10s. If PG needs longer to accept connections
  on a given machine this could flap; not a code fault. Will note if it takes an
  unusual amount of time.
- **`host.docker.internal` on Linux/CI**: TC-E4 assumes Docker Desktop (macOS dev
  box, per env). On plain Linux the `--add-host …:host-gateway` mapping is included,
  but if CI-someday runs this the network wiring may differ — out of scope now, noted.
- **Standalone container DB-down (TC-E3) vs healthy build**: uses a closed port inside
  the container; this only proves boot + degraded contract, not that the image can
  ever reach a real DB — TC-E4 covers the reachable case. Both are needed; neither
  alone is sufficient.

---

## Final report

- Total: 21 (as directed by amendment A4's "20 → 21" count)
- Passed: 21
- Failed: 0
- Blocked: 0
- Overall: ✅ READY FOR REVIEW — every check passes.

> **Count discrepancy (flagged to senior-lead, not massaged):** the checklist actually
> contains **23** distinct `### TC-` headers (A:3, B:5, C:3, D:3, E:4, F:4, G:1). Grooming
> §8's "20-check list (becoming 21 with TC-F4)" undercounted by 2 — the pre-F4 file already
> had 22 TCs. I kept the "Total: 21" line per the explicit instruction, but for the record
> **all 23 present TCs were executed and all 23 PASS** (0 fail, 0 blocked). No result was
> altered to fit the number; only the header count is off.

**Run environment (D7 deviation on this machine):** the committed contract port 5433 is
occupied by a foreign container, so the project Postgres (`budget-postgres-1`, compose
project `budget`) runs on host port **5443**. Tests used
`TEST_DATABASE_URL=…@localhost:5443/budget_test`; the dev server + alembic used
`apps/api/.env` (already 5443); TC-E4 substituted `host.docker.internal:5443`. This is a
runtime-only substitution — no committed file was changed, and TC-F1 confirms the
committed `.env.example` still states the 5433 contract.

**Notable observations:**
- TC-B2 DB-down `/health` returned in **0.006s** (connection-refused path) — the 2s ping
  cap (§6 / A6) is not even exercised in the stop-container case; no 60s asyncpg hang.
- TC-B3 recovery showed the **expected single interim 503** on poll iter 1 (SQLAlchemy
  stale-connection invalidation, grooming §5.5), then 200 on iter 2 — pool self-healed
  without restarting uvicorn (pid 64765 unchanged throughout B1→B3).
- TC-B5 confirms A5: `/health` GET declares both `200` and `503` in the OpenAPI schema.
- TC-G1 fail-fast fired in 0.42s with the actionable message and the 5443 endpoint in it,
  confirming the A6 time-cap works against the D7 port too.

**Environment restored:** `budget-postgres-1` is **running** (`budget` + `budget_test`
present); dev-server uvicorn (pid 64765) stopped, port 8000 free; TC-D1 probe fully
reverted (`grep _qa_probe` = 0); TC-C3 revision deleted (`alembic/versions/` = only
`.gitkeep`); no `budget-api-qa` containers remain; `budget-api:qa` **image kept**. No
foreign container was touched; no git commits; no committed source/config file modified.
