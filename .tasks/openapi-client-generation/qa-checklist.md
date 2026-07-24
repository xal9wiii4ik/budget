# QA Checklist: openapi-client-generation (roadmap 0.3)

## Scope

This task changes **no endpoint behavior** — it builds the OpenAPI → TypeScript
client *pipeline tooling* (hermetic schema export, committed `openapi.json`,
`openapi-typescript`/`openapi-fetch` client, drift + contract tests, turbo wiring).
There is therefore **no curl / live-endpoint section**: nothing new is served over
HTTP. QA's job here is to verify the *tooling*, whose worst failure mode is a
**silently-green check** — a drift or contract gate that passes even when the
artifacts are wrong. Every perturbation check below exists to prove a gate actually
bites; a check that only ever passes is worthless.

This checklist targets the **senior-lead Phase 4 amended state**, not the raw plans:
- Frontend contract test is `packages/api-client/src/contract.test-d.ts` (vitest
  type-test idiom); there is **NO** `vitest.config.ts` (F6 dropped). The `test`
  script stays `vitest run --typecheck`; vitest's default typecheck glob collects
  `*.test-d.ts`, its default runtime glob collects `drift.test.ts` (AM1).
- README Layout line for api-client reworded by backend in Step 8 (AM3).
- No eslint glob widening for `scripts/generate.d.mts`; it must lint clean as a
  declaration file (AM4).
- Repo gate is `pnpm turbo test --filter=<pkg>` / root `pnpm test`; no Makefile (AM5).
- Sequencing: backend lands first (committed `apps/api/openapi.json`), then frontend.
  An empty `turbo run generate` before the frontend slice lands is NOT a defect (AM7).

**Global preconditions**
- Run all commands from the repo root `/Users/nikitazaretski/work/budget` unless a
  step says otherwise.
- The tree is a git repo. Every perturbation check ends by restoring the tree; after
  the whole run, `git status --porcelain` MUST be empty. If it is not, QA has left
  the tree dirty — treat as a checklist failure, not a code failure.
- Two checks have **opposite** DB requirements — sequence them as written:
  - TC-A1 (hermeticity) requires Postgres **stopped** and `apps/api/.env` **moved aside**.
  - TC-A5 and any check that runs the **pytest** suite require Postgres **up**
    (`docker compose up -d postgres`) because 0.2's conftest fail-fast aborts the
    whole suite without a DB — even though the drift test itself is DB-free.
- These checks assume both slices have landed (backend B1–B5 + frontend F1–F5).
  If only backend has landed, TC-A11 still applies but `turbo run generate` is
  expected to no-op (AM7) — do not fail it for that reason.

---

## Test cases

### TC-A1: Export is hermetic (no .env, no DB, no network)
- **Preconditions**: Postgres stopped; `apps/api/.env` moved aside.
- **Commands**:
```bash
docker compose stop postgres 2>/dev/null || true
[ -f apps/api/.env ] && mv apps/api/.env apps/api/.env.qabak || true
( cd apps/api && uv run python -m budget_api.openapi_export openapi.json ); echo "exit=$?"
# restore:
[ -f apps/api/.env.qabak ] && mv apps/api/.env.qabak apps/api/.env || true
git checkout -- apps/api/openapi.json
```
- **Expected**: `exit=0`; the file is written. Proves the export builds the app with
  the explicit dummy `Settings(database_url=...)` and never consults env/`.env`/DB/network.
- **PASS/FAIL**: PASS iff exit code is 0 with no `.env` and Postgres down. FAIL if it
  errors, hangs, or emits a "missing database_url"/connection error. (A hang implies
  it tried a real connection — FAIL.)
- **Restore note**: bring the DB back for later pytest checks (`docker compose up -d postgres`).
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A2: Export is byte-idempotent (run twice → clean)
- **Preconditions**: TC-A1's `.env`/DB state already restored (env irrelevant here).
- **Commands**:
```bash
( cd apps/api && uv run python -m budget_api.openapi_export openapi.json )
( cd apps/api && uv run python -m budget_api.openapi_export openapi.json )
git status --porcelain apps/api/openapi.json
```
- **Expected**: empty output from `git status --porcelain` — the committed file is
  byte-for-byte what the exporter produces, twice running (canonical serializer,
  `sort_keys=True`, trailing newline).
- **PASS/FAIL**: PASS iff `git status --porcelain apps/api/openapi.json` prints
  nothing. FAIL if the file shows as modified (nondeterministic bytes, or committed
  file is stale relative to code).
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A3: Stdout mode prints the document and writes no file
- **Commands**:
```bash
( cd apps/api && uv run python -m budget_api.openapi_export ) | head -c 40; echo
git status --porcelain apps/api/openapi.json
```
- **Expected**: the OpenAPI JSON is printed to stdout (first chars look like
  `{` … `"openapi"`); `git status --porcelain` is empty (no-arg invocation writes
  nothing).
- **PASS/FAIL**: PASS iff stdout carries the JSON AND no file was written/modified.
  FAIL if nothing prints, or if the no-arg run mutated `openapi.json`.
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A4: Committed contract carries A5's 200 + 503 (the payoff)
- **Preconditions**: `jq` available.
- **Commands**:
```bash
jq -e '.paths."/health".get.responses | has("200") and has("503")' apps/api/openapi.json
jq -er '.paths."/health".get.responses."200".content."application/json".schema."$ref"' apps/api/openapi.json
jq -er '.paths."/health".get.responses."503".content."application/json".schema."$ref"' apps/api/openapi.json
jq -e '.components.schemas.HealthResponse' apps/api/openapi.json >/dev/null && echo "HealthResponse present"
# sorted keys + trailing newline:
python3 -c "import json,sys; d=open('apps/api/openapi.json').read(); assert d.endswith('\n'), 'no trailing newline'; assert d==json.dumps(json.loads(d),indent=2,sort_keys=True,ensure_ascii=False)+chr(10), 'not canonical/sorted'; print('canonical+newline OK')"
```
- **Expected**: both `has` checks print `true`; both `$ref`s resolve to
  `#/components/schemas/HealthResponse`; `HealthResponse` schema exists; the file is
  key-sorted and ends in a newline.
- **PASS/FAIL**: PASS iff all five assertions succeed (jq `-e`/`-er` exit 0, python
  prints `canonical+newline OK`). FAIL if 503 is absent (A5 regressed), a `$ref` is
  missing/inlined, or the file is not canonical. **This is why the task exists — a
  FAIL here is the highest-severity finding.**
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A5: Drift edge 1 (Python) bites — negative then positive
- **Preconditions**: Postgres **up** (`docker compose up -d postgres`) or the whole
  pytest suite aborts on conftest fail-fast.
- **Commands**:
```bash
docker compose up -d postgres
# NEGATIVE: perturb the committed schema (semantic edit), expect drift test RED
python3 -c "import json,io; p='apps/api/openapi.json'; d=json.load(open(p)); d['info']['title']='QA-TAMPERED'; open(p,'w').write(json.dumps(d,indent=2,sort_keys=True,ensure_ascii=False)+chr(10))"
pnpm turbo test --filter=@budget/api 2>&1 | tee /tmp/qa-a5.log; echo "exit=${PIPESTATUS[0]}"
# RESTORE + POSITIVE:
git checkout -- apps/api/openapi.json
pnpm turbo test --filter=@budget/api; echo "exit=$?"
```
- **Expected**:
  - NEGATIVE: `@budget/api#test` FAILS; the failing assertion message mentions
    `pnpm openapi` (i.e. `grep -q 'pnpm openapi' /tmp/qa-a5.log` succeeds).
  - POSITIVE (after `git checkout`): suite PASSES (exit 0), including
    `TestOpenApiExport::test_committed_schema_matches_current_app`.
- **PASS/FAIL**: PASS iff the perturbed run fails **with the `pnpm openapi` guidance**
  and the restored run passes green. FAIL if the perturbed run stays green (drift
  test is vacuous), or the message lacks the regeneration instruction, or the restored
  run does not go green.
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A6: Drift edge 2 (TS, schema→types) bites via openapi.json perturbation
- **Preconditions**: api-client slice landed. No Python/DB needed (this is the point).
- **Commands**:
```bash
# NEGATIVE: perturb committed openapi.json WITHOUT regenerating schema.d.ts
python3 -c "import json; p='apps/api/openapi.json'; d=json.load(open(p)); d['paths']['/health']['get']['description']='qa-drift-probe'; open(p,'w').write(json.dumps(d,indent=2,sort_keys=True,ensure_ascii=False)+chr(10))"
pnpm --filter @budget/api-client test 2>&1 | tee /tmp/qa-a6.log; echo "exit=${PIPESTATUS[0]}"
git checkout -- apps/api/openapi.json
# POSITIVE:
pnpm --filter @budget/api-client test; echo "exit=$?"
```
- **Expected**: NEGATIVE run FAILS in `drift.test.ts` with a message mentioning
  `pnpm openapi` (regenerated string ≠ committed `schema.d.ts`); POSITIVE run PASSES.
- **PASS/FAIL**: PASS iff perturbed run fails in `drift.test.ts` and restored run is
  green. FAIL if the openapi.json change does not turn `drift.test.ts` red (the
  `@budget/api-client#test` explicit `$TURBO_ROOT$` input is missing → stale-green
  cache, a real defect) or restore does not go green.
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A7: Drift edge 2 bites via schema.d.ts perturbation
- **Commands**:
```bash
# NEGATIVE: hand-edit the generated file (simulate stale / manual edit)
python3 - <<'PY'
p='packages/api-client/src/generated/schema.d.ts'
s=open(p).read(); open(p,'w').write(s.replace('paths','paths /*qa*/ ',1))
PY
pnpm --filter @budget/api-client test 2>&1 | tee /tmp/qa-a7.log; echo "exit=${PIPESTATUS[0]}"
git checkout -- packages/api-client/src/generated/schema.d.ts
pnpm --filter @budget/api-client test; echo "exit=$?"
```
- **Expected**: NEGATIVE run FAILS (`drift.test.ts`: fresh regeneration ≠ hand-edited
  committed file); POSITIVE run PASSES after restore.
- **PASS/FAIL**: PASS iff the hand-edit turns the run red and restore turns it green.
  FAIL if hand-editing the generated file goes unnoticed.
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A8: Contract type test bites — delete 503 from schema.d.ts (dual gate)
- **Rationale**: proves `contract.test-d.ts` pins A5 *independently of drift* — deleting
  503 and dutifully regenerating would keep all drift checks green; only this test
  catches it. Verified via both gates: the vitest typecheck project AND `tsc --noEmit`.
- **Commands**:
```bash
# Scratch-perturb: remove the 503 response entry from the generated types.
# (The exact deletion depends on emitted shape; delete the `503:` member of the
#  /health get `responses` object in src/generated/schema.d.ts.)
cp packages/api-client/src/generated/schema.d.ts /tmp/qa-a8-schema.bak
python3 - <<'PY'
import re
p='packages/api-client/src/generated/schema.d.ts'
s=open(p).read()
# remove a line-scoped 503 response member; adjust the regex if the emitted key differs
s2=re.sub(r'\n\s*503:\s*[^\n]*\n', '\n', s, count=1)
assert s2!=s, "503 member not found — inspect schema.d.ts and delete it by hand for this check"
open(p,'w').write(s2)
PY
pnpm --filter @budget/api-client typecheck 2>&1 | tee /tmp/qa-a8-tsc.log; echo "tsc_exit=${PIPESTATUS[0]}"
pnpm --filter @budget/api-client test 2>&1 | tee /tmp/qa-a8-test.log; echo "test_exit=${PIPESTATUS[0]}"
# RESTORE:
cp /tmp/qa-a8-schema.bak packages/api-client/src/generated/schema.d.ts
git checkout -- packages/api-client/src/generated/schema.d.ts
```
- **Expected**: with 503 gone, `contract.test-d.ts`'s
  `paths["/health"]["get"]["responses"][503]...` no longer resolves →
  `tsc --noEmit` FAILS **and** `vitest run --typecheck` reports a FAILED type test.
- **PASS/FAIL**: PASS iff BOTH gates fail (`tsc_exit != 0` AND the test run reports a
  failed typecheck test). FAIL if either stays green — a single-gate pass means the
  other gate is a no-op for this contract.
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A9: Contract type test is NOT vacuous — flip an assertion to a wrong shape
- **Rationale**: THE critical vacuity check. If `vitest run --typecheck` passes while
  a deliberately-wrong `expectTypeOf` sits in `contract.test-d.ts`, the type gate is a
  no-op and the whole "executable A5 contract" is theater.
- **Commands**:
```bash
cp packages/api-client/src/contract.test-d.ts /tmp/qa-a9.bak
# Flip an expected shape to something wrong, e.g. drop "degraded" from status union.
python3 - <<'PY'
p='packages/api-client/src/contract.test-d.ts'
s=open(p).read()
s2=s.replace('"ok" | "degraded"', '"ok"')
assert s2!=s, "expected status union not found — inspect the file and break one assertion by hand"
open(p,'w').write(s2)
PY
pnpm --filter @budget/api-client test 2>&1 | tee /tmp/qa-a9.log; echo "test_exit=${PIPESTATUS[0]}"
# RESTORE:
cp /tmp/qa-a9.bak packages/api-client/src/contract.test-d.ts
git checkout -- packages/api-client/src/contract.test-d.ts
```
- **Expected**: `vitest run --typecheck` reports a FAILED test (the `expectTypeOf`
  mismatch is a type error the typecheck project surfaces as a failing test).
- **PASS/FAIL**: PASS iff the wrong assertion produces a **FAILED test** (`test_exit != 0`
  with a reported type-test failure). **FAIL — BLOCKING DEFECT — if it passes silently**:
  that means `contract.test-d.ts` is not actually being typechecked (e.g. `--typecheck`
  glob didn't pick up the `-d.ts` file, or the assertion runs only at runtime where
  `expectTypeOf` is a no-op). Escalate immediately to senior-lead.
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A10: No-Python constraint — api-client verifies without python/uv, no api tasks in graph
- **Rationale**: simulates a Vercel / fresh frontend-only clone with no Python toolchain.
- **Commands**:
```bash
# 1) The turbo test graph for api-client must not pull any @budget/api task.
pnpm turbo run test --filter=@budget/api-client --dry-run=json > /tmp/qa-a10.json
python3 -c "import json; t=json.load(open('/tmp/qa-a10.json')).get('tasks',[]); ids=[x.get('taskId') or x.get('task') for x in t]; print('tasks:',ids); assert not any('@budget/api#' in str(i) for i in ids), 'api task leaked into api-client test graph'; print('no api tasks in graph OK')"
# 2) api-client scripts invoke only node tooling (no python/uv references).
python3 -c "import json; s=json.load(open('packages/api-client/package.json'))['scripts']; bad=[k for k,v in s.items() if 'python' in v or 'uv ' in v or v.strip().startswith('uv')]; assert not bad, bad; print('scripts python-free OK')"
# 3) The three gates run green (assumes node_modules installed; no python present is fine).
pnpm --filter @budget/api-client lint && pnpm --filter @budget/api-client typecheck && pnpm --filter @budget/api-client test; echo "exit=$?"
```
- **Expected**: dry-run graph contains no `@budget/api#…` task; scripts reference no
  python/uv; lint + typecheck + test all pass.
- **PASS/FAIL**: PASS iff all three sub-checks pass. FAIL if `@budget/api-client#test`
  `dependsOn`s any api task (would force Python on Vercel), or any api-client script
  shells out to python/uv, or a gate fails.
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A11: Turbo wiring — generate depends on openapi
- **Commands**:
```bash
pnpm turbo run generate --dry-run=json > /tmp/qa-a11.json
python3 -c "import json; d=json.load(open('/tmp/qa-a11.json')); t={ (x.get('taskId') or x.get('task')): x for x in d.get('tasks',[]) }; print(list(t)); g=[k for k in t if 'api-client#generate' in k]; assert g, 'generate task missing'; deps=t[g[0]].get('dependencies',[])+t[g[0]].get('dependsOn',[]); print('deps',deps); assert any('@budget/api#openapi' in str(x) for x in deps), 'generate does not depend on @budget/api#openapi'; print('dependsOn OK')"
```
- **Expected**: `@budget/api-client#generate` present, with `@budget/api#openapi` in its
  dependency list.
- **PASS/FAIL**: PASS iff the dependency edge is present in the dry-run graph. FAIL if
  `generate` is missing or doesn't chain `@budget/api#openapi` (pipeline would generate
  TS from a stale/absent schema). Note (AM7): if only backend has landed, `generate`
  may be absent — record as ⏸ blocked "frontend slice not yet landed", not FAIL.
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A12: End-to-end idempotency — `pnpm openapi` twice → clean tree
- **Preconditions**: full pipeline landed (backend + frontend); Python/uv + node present.
- **Commands**:
```bash
pnpm openapi
pnpm openapi
git status --porcelain apps/api/openapi.json packages/api-client/src/generated/schema.d.ts
```
- **Expected**: both `pnpm openapi` runs succeed; `git status --porcelain` for both
  generated artifacts is empty (byte-stable across the full export→generate chain).
- **PASS/FAIL**: PASS iff no diff in either artifact after two runs. FAIL if either file
  shows modified (nondeterminism, or committed artifacts are stale).
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A13: Cache invalidation — schema-affecting change re-runs and reddens drift
- **Rationale**: turbo hashes **content**, so a bare `touch` (mtime only) must NOT
  invalidate — verifying a real content change does is the honest test of the input set.
- **Commands**:
```bash
# Pick a schema-affecting source edit (add a docstring/description that alters the
# OpenAPI output — e.g. bump __version__ or add a field description). Example: bump version.
VF=$(grep -rl '__version__' apps/api/src | head -1); echo "editing $VF"
cp "$VF" /tmp/qa-a13.bak
python3 - "$VF" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p).read()
s2=re.sub(r'__version__\s*=\s*"([^"]+)"', lambda m: f'__version__ = "{m.group(1)}-qa"', s, count=1)
assert s2!=s, "no __version__ literal found — choose another schema-affecting edit"
open(p,'w').write(s2)
PY
# pnpm openapi must re-run (cache MISS) and rewrite openapi.json:
pnpm openapi 2>&1 | tee /tmp/qa-a13.log
git status --porcelain apps/api/openapi.json packages/api-client/src/generated/schema.d.ts
# With source changed but if committed artifacts were NOT regenerated, drift is red.
# Verify red-before-regen by restoring ONLY the generated files, keeping the src edit:
git checkout -- apps/api/openapi.json packages/api-client/src/generated/schema.d.ts
docker compose up -d postgres
pnpm turbo test --filter=@budget/api --filter=@budget/api-client 2>&1 | tee /tmp/qa-a13-test.log; echo "exit=${PIPESTATUS[0]}"
# RESTORE everything:
cp /tmp/qa-a13.bak "$VF"
git checkout -- apps/api/openapi.json packages/api-client/src/generated/schema.d.ts "$VF"
```
- **Expected**: `pnpm openapi` reports the `@budget/api#openapi` (and `generate`) task
  as a cache MISS / re-run (not `cache hit, replaying`), and rewrites `openapi.json`.
  With the source edit present but committed artifacts un-regenerated, the drift tests
  go RED. After full restore the tree is clean.
- **PASS/FAIL**: PASS iff (a) `pnpm openapi` shows a cache miss for the api export after
  the content change (`grep -q 'cache miss' /tmp/qa-a13.log` or the task is re-executed),
  and (b) drift tests are red while artifacts are stale. FAIL if turbo replays a cached
  result despite the source change (input set too narrow → stale-green), or drift stays
  green with a real code/schema divergence.
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A14: Hygiene — README section, generated header, exact pins, repo-wide lint
- **Commands**:
```bash
# README "Regenerating the API client" section exists and names both artifacts + pnpm openapi:
grep -q 'Regenerating the API client' README.md && echo "README section OK"
grep -q 'pnpm openapi' README.md && grep -q 'src/generated' README.md && echo "README guidance OK"
# do-not-edit header on the generated file:
head -5 packages/api-client/src/generated/schema.d.ts | grep -qi 'do not edit' && echo "header OK"
# exact pins (no ^ or ~) in api-client package.json deps/devDeps:
python3 -c "import json; p=json.load(open('packages/api-client/package.json')); d={**p.get('dependencies',{}),**p.get('devDependencies',{})}; bad={k:v for k,v in d.items() if v[:1] in '^~' or '*' in v or ' - ' in v}; assert not bad, bad; print('exact pins OK', d)"
# repo-wide lint clean:
pnpm lint 2>&1 | tail -5; echo "lint_exit=${PIPESTATUS[0]}"
```
- **Expected**: README has the section naming `pnpm openapi` and both committed
  artifacts; `schema.d.ts` carries a do-not-edit header; every api-client dep is an
  exact pin (no `^`/`~`/`*`); `pnpm lint` exits 0 repo-wide (generated file ignored,
  `generate.d.mts` lints clean per AM4).
- **PASS/FAIL**: PASS iff all five sub-checks succeed. FAIL on a missing README section,
  missing header, any range-pinned dep, or a repo-wide lint error (in particular a lint
  error on `scripts/generate.d.mts` would contradict AM4 → report as a defect).
- **Status**: ✅ PASS (see "Execution results — /test")

### TC-A15: Placeholder absorbed + first real test script (0.1 carry-forwards)
- **Commands**:
```bash
# index.ts is no longer the `export {}` shell and exports the real surface:
grep -Eq '^\s*export\s*\{\s*\}\s*;?\s*$' packages/api-client/src/index.ts && echo "STILL A SHELL (bad)" || echo "shell gone OK"
grep -q 'createApiClient' packages/api-client/src/index.ts && echo "public surface OK"
# first real test script present and is the vitest typecheck runner:
python3 -c "import json; s=json.load(open('packages/api-client/package.json'))['scripts']; assert s.get('test')=='vitest run --typecheck', s.get('test'); print('test script OK')"
# amended file layout: contract test is the -d.ts idiom, and NO vitest.config.ts (AM1):
test -f packages/api-client/src/contract.test-d.ts && echo "contract.test-d.ts OK"
test -f packages/api-client/src/drift.test.ts && echo "drift.test.ts OK"
test ! -f packages/api-client/vitest.config.ts && echo "no vitest.config.ts OK (AM1)"
```
- **Expected**: `src/index.ts` is not `export {}` and exports `createApiClient`; the
  `test` script is exactly `vitest run --typecheck`; `contract.test-d.ts` and
  `drift.test.ts` exist; there is no `vitest.config.ts`.
- **PASS/FAIL**: PASS iff all sub-checks pass. FAIL if the `export {}` shell survives,
  the test script differs, the contract test is not the `-d.ts` file, or a
  `vitest.config.ts` was added (contradicts AM1's F6-dropped decision).
- **Status**: ✅ PASS (see "Execution results — /test")

---

## Per-amendment / carry-forward coverage

| Amendment / carry-forward | What it requires | Covered by |
|---|---|---|
| **A5** (200 + 503 in schema AND executable contract test) | committed `openapi.json` declares both status codes; a non-vacuous type test pins them | TC-A4 (schema), TC-A8 (type gate bites on 503 removal), TC-A9 (type gate not vacuous) |
| **AM1** (contract test = `contract.test-d.ts`; NO `vitest.config.ts`; default globs) | type test is the `-d.ts` idiom, collected by default `--typecheck` glob; drift test collected by default runtime glob; no config file | TC-A9 (proves `-d.ts` is actually typechecked), TC-A15 (file layout + no config), TC-A6/A7 (drift.test.ts runs at runtime) |
| **AM3** (backend rewords stale README Layout line) | README api-client line updated in Step 8 | TC-A14 (README section + guidance present; Layout line reviewed while there) |
| **AM4** (no eslint glob widening; `generate.d.mts` lints clean) | repo-wide lint clean with no special glob for the `.d.mts` | TC-A14 (`pnpm lint` repo-wide, flags any error on `generate.d.mts`) |
| **AM5** (gate is `pnpm turbo test --filter` / root `pnpm test`; no Makefile) | all verification uses pnpm/turbo, not `make` | TC-A5, TC-A6, TC-A10, TC-A12, TC-A13 all use `pnpm turbo test` / `pnpm test` |
| **AM7** (backend lands first; empty `turbo run generate` pre-frontend is not a defect) | sequencing tolerated | TC-A11 (records ⏸ blocked, not FAIL, when frontend slice absent) |
| **0.1 carry-forward** — placeholder absorbed (`src/index.ts` no longer `export {}`) | first real content deletes the shell | TC-A15 |
| **0.1 carry-forward** — first real, non-vacuous test script exists | `test` script added; two non-vacuous tests | TC-A15 (script), TC-A6/A7 (drift non-vacuous), TC-A8/A9 (contract non-vacuous) |

---

## Final report

- Total: 15
- Passed: 15
- Failed: 0
- Blocked: 0

Overall status: ✅ READY FOR REVIEW — all 15 checks passed; final full-repo gate
green (5/5 turbo tasks; api 3 passed, api-client 2 passed). Working tree ended
byte-identical to the as-found state.

---

## Execution results — /test

**Run date**: 2026-07-24. Executed by qa-engineer against the landed backend +
frontend slices. **Overall: ✅ ALL PASS (15/15).**

**Environment overrides applied (from senior-lead, override the checklist):**
- Test DB on port **5443** (not committed 5433), creds **budget:budget**:
  `TEST_DATABASE_URL='postgresql+asyncpg://budget:budget@localhost:5443/budget_test'`.
  Turbo runs used `--env-mode=loose` (and `--force` where a real re-execution was
  needed to defeat the content-hash cache).
- **No docker containers were touched.** Postgres was already up on 5443 and stayed up.
- `apps/api/openapi.json` and everything under `packages/api-client/src/` are
  **NEW/untracked** — `git checkout --` cannot restore them. Every perturbation was
  backed up to an out-of-repo scratch dir, restored from that `.bak`, and verified
  **byte-identical via `cmp`**. Because the artifacts are untracked, the checklist's
  `git status --porcelain apps/api/openapi.json` idempotency assertions were **adapted**
  to `cmp` against the as-found bytes (an untracked file always shows `??`, never empty).

### Results table

| TC | Verdict | Evidence (one line) |
|---|---|---|
| TC-A1 | ✅ PASS | Export `exit=0` in ~1s with `.env` moved aside **and** `DATABASE_URL`/`TEST_DATABASE_URL` pointed at closed port 5599; output byte-identical → hermetic (adapted, see note below). |
| TC-A2 | ✅ PASS | Two exports; `cmp` vs as-found = byte-identical → deterministic (`git status` shows `??` only because file is untracked). |
| TC-A3 | ✅ PASS | No-arg run streamed the JSON to stdout (`{ "components"…`, `components` first due to `sort_keys`); `cmp` proves no file written. |
| TC-A4 | ✅ PASS | `/health` has `200`+`503`, both `$ref` → `#/components/schemas/HealthResponse`; `HealthResponse` present; `canonical+newline OK`. |
| TC-A5 | ✅ PASS | Negative (`info.title`→`QA-TAMPERED`): `@budget/api#test` RED on `test_committed_schema_matches_current_app` with `pnpm openapi` guidance. Positive after restore: 3 passed. |
| TC-A6 | ✅ PASS | Negative (perturb `/health` description in openapi.json): `drift.test.ts` RED with `pnpm openapi` message. Positive after restore: 2 passed. |
| TC-A7 | ✅ PASS | Negative (hand-edit generated `schema.d.ts`): `drift.test.ts` RED. Positive after restore: 2 passed. |
| TC-A8 | ✅ PASS | Removed full `503` member: **both** gates red — `tsc --noEmit` `error TS2339: Property '503' does not exist`, and `vitest --typecheck` `FAIL src/contract.test-d.ts` (`TypeCheckError: Property '503'…`). |
| TC-A9 | ✅ PASS | Flipped `"ok" \| "degraded"` → `"ok"`: `vitest --typecheck` reports a **FAILED type test** (`Type Errors 1 failed`, contract.test-d.ts:20) → contract gate is genuinely typechecked, **not vacuous**. |
| TC-A10 | ✅ PASS | `test` dry-run graph = `['@budget/api-client#test']` only (no `@budget/api#…`); scripts python/uv-free; lint+typecheck+test all green. |
| TC-A11 | ✅ PASS | `generate` dry-run: `@budget/api-client#generate` deps = `['@budget/api#openapi']`. |
| TC-A12 | ✅ PASS | `pnpm openapi` twice (run2 = `FULL TURBO`); both artifacts byte-identical to as-found via `cmp`. |
| TC-A13 | ✅ PASS | `__version__` bump (feeds `info.version`): `pnpm openapi` shows `@budget/api:openapi: cache miss, executing 5f50f62223900b0a` and rewrote openapi.json to `0.1.0-qa`; with src edit + stale artifacts, `@budget/api#test` drift RED. All restored. |
| TC-A14 | ✅ PASS | README "Regenerating the API client" + `pnpm openapi`/`src/generated`; `do not edit` header; all deps exact-pinned; `pnpm lint` 5/5; `generate.d.mts` linted (not ignored), clean. |
| TC-A15 | ✅ PASS | `index.ts` no longer `export {}`, exports `createApiClient`; `test`=`vitest run --typecheck`; `contract.test-d.ts`+`drift.test.ts` present; **no** `vitest.config.ts`. |

### TC-A1 adaptation note (required)

The checklist's precondition "Postgres **stopped**" was **not** met by stopping any
container (docker is off-limits per senior-lead). Hermeticity was proven by an
equivalent-or-stronger perturbation: (a) `apps/api/.env` moved aside to `.env.qabak`
for the duration (restored + verified afterward), **and** (b) `DATABASE_URL` and
`TEST_DATABASE_URL` exported into the export command's environment pointed at a
**closed** port — `postgresql+asyncpg://budget:budget@localhost:5599/none`. The
export completed `exit=0` in ~1 s and produced byte-identical output. If it had
consulted `.env`, the environment, or any DB it would have errored or hung on the
closed port; it did neither → it built the app with the explicit dummy
`Settings(database_url=…)` and touched no env/DB/network. (`timeout(1)` is absent on
this macOS host; a 60 s wall-clock kill-guard was used instead — never triggered.)

### Pinned turbo cache-miss wording (TC-A13)

turbo **2.10.6** emits, on a real content-hash miss:

```
@budget/api:openapi: cache miss, executing 5f50f62223900b0a
@budget/api-client:generate: cache miss, executing 100a7e228698e1b5
```

and for an already-cached graph: `Cached: 2 cached, 2 total` / `>>> FULL TURBO`.
A forced re-exec (`--force`) reads as `cache bypass, force executing <hash>`. An
mtime-only `touch` would **not** produce a miss — this was a genuine `__version__`
content edit.

### Per-amendment / carry-forward coverage — verdicts

| Amendment / carry-forward | Covered by | Verdict |
|---|---|---|
| **A5** (200 + 503 in schema AND executable contract test) | TC-A4, TC-A8, TC-A9 | ✅ PASS (schema carries both; type gate bites on 503 removal via **both** tsc + vitest; gate proven non-vacuous) |
| **AM1** (contract test = `.test-d.ts`; NO `vitest.config.ts`; default globs) | TC-A9, TC-A15, TC-A6/A7 | ✅ PASS (`-d.ts` is really typechecked — flip → FAILED type test; no config file; `drift.test.ts` runs at runtime) |
| **AM3** (README Layout line reworded) | TC-A14 | ✅ PASS (README section + guidance present and reviewed) |
| **AM4** (no eslint glob widening; `generate.d.mts` lints clean) | TC-A14 | ✅ PASS (repo-wide lint 5/5; `generate.d.mts` directly linted, not ignored, exit 0) |
| **AM5** (gate is `pnpm turbo test --filter` / root `pnpm test`; no Makefile) | TC-A5, TC-A6, TC-A10, TC-A12, TC-A13 | ✅ PASS (all verification used pnpm/turbo; no `make` invoked) |
| **AM7** (backend lands first; empty `generate` pre-frontend not a defect) | TC-A11 | ✅ PASS (frontend slice landed; `generate` present with the `@budget/api#openapi` edge — not exercised as blocked) |
| **0.1 carry-forward** — placeholder absorbed (`index.ts` no longer `export {}`) | TC-A15 | ✅ PASS |
| **0.1 carry-forward** — first real, non-vacuous test script | TC-A15, TC-A6/A7, TC-A8/A9 | ✅ PASS (script = `vitest run --typecheck`; both tests proven to bite) |

### Observations for senior-lead (all technically passing)

1. **Turbo default fail-fast masks sibling output (TC-A13).** When running
   `pnpm turbo test --filter=@budget/api --filter=@budget/api-client --force` with the
   Python drift deliberately RED, `@budget/api-client:test` printed only `RUN v4.1.10`
   then `[ELIFECYCLE] Test failed` with **no** test results — turbo terminated the
   in-flight vitest sibling the moment `@budget/api#test` failed (no `--continue`).
   Re-run standalone it is green (2 passed). **Not a defect**, but a debugging trap: a
   combined-filter run makes an unrelated sibling look broken. Noting so it isn't
   mistaken for an api-client failure.
2. **`git status --porcelain` idempotency checks are inherently `??` here** because
   `openapi.json` and `src/generated/**` are still untracked. Once these are committed,
   the checklist's literal `git status --porcelain <file>`-is-empty assertions (TC-A2,
   A3, A12) will hold as written; today they were verified by byte-`cmp` instead.
   Worth confirming the commit lands these artifacts as intended.
3. **TC-A3 stdout first-key is `components`, not `openapi`** (checklist expected
   `"openapi"` first) — purely because `sort_keys=True` orders keys alphabetically.
   The JSON document is fully emitted; expectation wording is cosmetically stale, no
   code issue.
