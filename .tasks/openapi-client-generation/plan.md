# Implementation Plan (backend slice B1–B5): OpenAPI → TypeScript client pipeline

Scope: the Python/api side and the root-file wiring of roadmap 0.3, exactly as
bounded by `architecture.md` decisions D1–D6 and the "Task-graph & file inventory"
steps B1–B5. Frontend steps F1–F5 (api-client package internals, `generate.mjs`,
generated `schema.d.ts`, `client.ts`/`index.ts`, the vitest contract + edge-2 drift
tests, and deletion of the `export {}` placeholder) are **out of this slice** and
belong to frontend-engineer. This plan does not touch anything under
`packages/api-client/`.

---

## Approach

One canonical serializer function is the single source of truth for the bytes of
the committed contract. `openapi_json(app)` produces the exact string; both the
CLI entry (which writes `apps/api/openapi.json`) and the pytest drift test import
it, so the "writer and checker silently disagree on formatting" failure mode is
structurally impossible (mirrors D1). The export is hermetic — the app is built
with an explicit dummy `Settings(database_url=...)`, never `get_settings()`, so no
`.env`, environment, DB, or network is consulted; `app.openapi()` runs no lifespan
and touches no DB.

To also collapse the "two dummy Settings disagree" seam, the module exposes a
`build_export_app()` helper carrying the one canonical dummy DSN; the CLI and the
drift test both call `openapi_json(build_export_app())`. (Because `database_url`
never appears in the schema, even divergent dummies could not change the bytes —
but a single builder keeps intent obvious and pyright-strict clean. This is design
latitude within D1, not a deviation; noted in Disagreements as a clarification.)

Root-file edits (turbo.json, root package.json, eslint.config.mjs, README.md) are
made here under the standing root-file-ownership carry-forward. `.dockerignore`
gets one line so the build-only contract artifact stays out of the runtime image.

---

## Numbered implementation steps

### Step 1 — B1: `apps/api/src/budget_api/openapi_export.py` (new)

New module, fully typed, must pass `ruff check` + `pyright` strict (it lives under
`src/`, which is strict per 0.2). Skeleton (final code stays this small):

```python
"""Canonical OpenAPI schema export.

Single source of truth for the bytes of apps/api/openapi.json: the
`python -m budget_api.openapi_export` CLI (which writes the committed file) and
the pytest drift test both import `openapi_json`/`build_export_app` from here, so
a regenerated schema and its drift check can never disagree on formatting.

Hermetic: the app is built with an explicit dummy database_url and never calls
get_settings(), so no .env, environment, database, or network is consulted;
app.openapi() runs no lifespan and touches no DB.
"""

import json
import sys
from pathlib import Path

from fastapi import FastAPI

from budget_api.app import create_app
from budget_api.config import Settings

# Explicit, obviously-fake DSN. database_url is Settings' only field, so supplying
# it here means pydantic-settings consults neither env nor .env.
_EXPORT_DATABASE_URL = "postgresql+asyncpg://openapi-export-placeholder/none"


def build_export_app() -> FastAPI:
    """Build the app exactly as the export/drift path expects — hermetic settings."""
    return create_app(Settings(database_url=_EXPORT_DATABASE_URL))


def openapi_json(app: FastAPI) -> str:
    """Canonical serializer: the exact bytes committed to apps/api/openapi.json.

    sort_keys makes JSON object-key order irrelevant (keys are non-semantic);
    array order (e.g. `required`, enum members) is preserved because it is
    semantic. indent=2, UTF-8 (ensure_ascii=False), trailing newline.
    """
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> None:
    document = openapi_json(build_export_app())
    if argv:
        Path(argv[0]).write_text(document, encoding="utf-8")
    else:
        sys.stdout.write(document)


if __name__ == "__main__":
    main(sys.argv[1:])
```

Reviewer checkpoints:
- Serializer flags are exactly `indent=2, sort_keys=True, ensure_ascii=False` plus
  a `+ "\n"` trailing newline — matches D1 verbatim.
- Never imports or calls `get_settings()`; the DSN is a hard-coded kwarg.
- File writes use `encoding="utf-8"` explicitly (required because
  `ensure_ascii=False` may emit non-ASCII; the committed artifact must not depend
  on the process locale). The stdout branch is a human-convenience path only; the
  committed file is always written through the explicit-utf-8 branch.
- No `Any` leaks into an annotation (`app.openapi()`'s `dict[str, Any]` is consumed
  directly by `json.dumps`, not re-exported) — keeps pyright strict green.
- `Settings(database_url=...)` needs no `# type: ignore` (the required field is
  supplied; conftest.py already does this pattern under strict pyright).

### Step 2 — B4: `apps/api/package.json` — add `openapi` script

Add to `scripts` (pnpm runs scripts with cwd = package dir, so the relative path is
stable):

```json
"openapi": "uv run python -m budget_api.openapi_export openapi.json"
```

Resulting `scripts` order: `lint`, `typecheck`, `test`, `openapi`, `dev` (insert
before `dev` to keep `dev` last, matching the existing convention).

### Step 3 — B2: generate & commit `apps/api/openapi.json` (new, generated artifact)

At implementation, after Step 1, run from `apps/api`:
`uv run python -m budget_api.openapi_export openapi.json`. Commit the result. The
file is the API's published contract. It MUST contain, for `paths./health.get`, a
`responses` map with **both** `"200"` and `"503"` (each `$ref`-ing the
`HealthResponse` schema) — this is amendment A5's payoff and is already declared in
`routers/health.py` (`responses={503: {...}}`). Reviewer: eyeball the committed
file for both status codes and a `HealthResponse` schema whose `status`/`database`
carry the `Literal` enums; confirm keys are sorted and the file ends in a newline.

### Step 4 — B3: `apps/api/tests/test_openapi_export.py` (new, edge-1 drift test)

Class-based, sync test (no DB, no async, no node/client imports — Python side stays
self-contained per senior-lead point 3):

```python
"""Edge-1 drift: committed openapi.json is exactly what the exporter produces."""

from pathlib import Path

from budget_api.openapi_export import build_export_app, openapi_json

_COMMITTED = Path(__file__).parent.parent / "openapi.json"


class TestOpenApiExport:
    def test_committed_schema_matches_current_app(self) -> None:
        expected = openapi_json(build_export_app())
        actual = _COMMITTED.read_text(encoding="utf-8")

        assert actual == expected, (
            "apps/api/openapi.json is stale — run `pnpm openapi` from the repo "
            "root and commit apps/api/openapi.json + "
            "packages/api-client/src/generated/schema.d.ts."
        )
```

Non-vacuous (per global test policy + pytest-conventions): it recomputes the schema
from the live app code and byte-compares against the committed file — it is not a
file-vs-itself snapshot. It fails exactly when API code changes were not
re-exported, which no other test on the Python side catches. It imports only
`budget_api.openapi_export` and `pathlib`; it does not import the client package or
any node tooling. Note: the session-autouse `_require_test_db` conftest fixture
still requires local Postgres for the whole suite to start, even though this test is
DB-free — accepted by the architect (one gate, no special-case markers).

### Step 5 — B5a: `turbo.json` (root file, backend-owned)

Add two new package-scoped tasks and correct two existing input sets. Final `tasks`
map:

```json
"@budget/api#openapi": {
  "inputs": ["src/**", "pyproject.toml", "uv.lock"],
  "outputs": ["openapi.json"]
},
"@budget/api-client#generate": {
  "dependsOn": ["@budget/api#openapi"],
  "inputs": ["$TURBO_ROOT$/apps/api/openapi.json", "scripts/**", "package.json"],
  "outputs": ["src/generated/**"]
},
"@budget/api-client#test": {
  "inputs": ["src/**", "scripts/**", "package.json", "tsconfig.json", "$TURBO_ROOT$/apps/api/openapi.json"]
}
```

And extend the existing `@budget/api#test` inputs with `"openapi.json"` (the new
pytest drift test reads it), giving:
`["src/**", "tests/**", "pyproject.toml", "uv.lock", "alembic/**", "alembic.ini", "openapi.json"]`.

Reviewer checkpoints (verbatim against D3):
- `@budget/api#openapi` output is package-relative `openapi.json` (turbo outputs
  must be package-local — an api task must not write into api-client).
- `@budget/api-client#generate` uses a `pkg#task` `dependsOn` on `@budget/api#openapi`
  with no package.json dependency edge (supported on turbo 2.10.6) and reads the
  schema via `$TURBO_ROOT$` so the cross-package input is an honest cache key.
- `@budget/api-client#test` is added explicitly so a change to only
  `apps/api/openapi.json` invalidates api-client's test cache (turbo's default
  package-local hashing would otherwise serve stale green).
- No base `openapi`/`generate` task entries are added — package-scoped definitions
  stand alone; `turbo run generate` resolves them by script name.

### Step 6 — B5b: root `package.json` — add `openapi` script

Add to root `scripts`: `"openapi": "turbo run generate"` (the one command a dev
runs after changing routers/schemas). Place it after `test`, before `dev`.

### Step 7 — B5c: `eslint.config.mjs` (root file, backend-owned)

Two edits:
1. Add `'packages/api-client/src/generated/**'` to the top-level `ignores` array
   (the generated `schema.d.ts` is machine-owned and must not be linted; it is
   still typechecked by `tsc --noEmit`, which is intentional).
2. Add a config block giving Node globals to the generator scripts (they use
   `node:fs` etc.), placed alongside the existing `.config.js` block:

```js
// Workspace generator scripts run under Node (node:fs, process, URL) — give them
// Node globals so no per-file eslint-disable is needed.
{
  files: ['packages/*/scripts/**/*.mjs'],
  languageOptions: {
    globals: globals.node,
  },
},
```

(`.mjs` is ESM by default, so no `sourceType` override is needed — unlike the
existing CJS `.config.js` block.)

### Step 8 — B5d: `README.md` (root file, backend-owned) — D6 section

Add a new section "Regenerating the API client" implementing the D6 outline:
- **When:** after any change to `routers/`, `schemas/`, app metadata (title), or a
  `__version__` bump — anything that alters the OpenAPI schema.
- **How:** `pnpm openapi` from the repo root (turbo runs schema export, then TS
  generation; cached/skipped when nothing changed).
- **What it rewrites:** `apps/api/openapi.json` and
  `packages/api-client/src/generated/schema.d.ts` — commit **both** together with
  the API change.
- **The gate:** `pnpm test` fails on either drift edge with a message telling you to
  run `pnpm openapi`; never hand-edit anything under `src/generated/`.
- **Note:** export is hermetic (no `.env`, DB, or running server), but needs
  Python/uv since it runs the FastAPI app's schema generation.

Also update the one stale Layout line (root README is backend-owned):
`api-client — OpenAPI-generated TS client (currently a shell; generated in task 0.3)`
→ drop the "currently a shell; generated in task 0.3" parenthetical (or reword to
"OpenAPI-generated TS types + typed fetch client"). Minor doc accuracy; the actual
shell deletion is frontend F4.

### Step 9 — `.dockerignore` decision (senior-lead point 1)

**Decision: exclude `openapi.json` from the image.** Add `openapi.json` to
`apps/api/.dockerignore`. One-line reasoning: it is a build-time contract artifact
consumed only by the TS generator and the pytest drift test (`tests/` is already
excluded), with zero runtime role — the running server serves its schema live from
`app.openapi()` at `/openapi.json` — so shipping it would only add a stale
duplicate to the image.

---

## Determinism check (senior-lead point 2)

`app.openapi()` output is stable across Python runs for identical code:
- FastAPI builds the schema dict from static route definitions and Pydantic model
  schemas; there are no timestamps, UUIDs, or RNG in the process.
- Nothing environment-dependent leaks in: no `servers` block is configured, no
  `root_path`, and the hermetic dummy `database_url` never appears in the schema.
  `info.title` is the constant `"Budget API"`; `info.version` is `__version__`
  (constant per code — its churn on version bumps is accepted per D1 and caught by
  the drift test); `openapi` version string is fixed by the pinned FastAPI.
- Python dict iteration is insertion-order-stable (3.7+), and `sort_keys=True`
  normalizes object-key order regardless, so refactors to router include order or
  dict construction cannot change the bytes. Semantic arrays (`required`, `enum`
  members) are order-preserved by Pydantic in field-definition order — deterministic
  and correctly *not* sorted.

**No genuine nondeterminism source found.** The only way the bytes change for
unchanged first-party code is a FastAPI/Pydantic version bump (pinned in `uv.lock`);
that is a deliberate, drift-test-enforced regeneration event (see Risks), not
runtime flakiness.

---

## Acceptance criteria (exact commands + expected outcomes)

All from repo root unless noted. Local Postgres up (`docker compose up -d postgres`)
for anything invoking the pytest suite.

1. **Export runs hermetically & idempotently.**
   `cd apps/api && uv run python -m budget_api.openapi_export openapi.json` with no
   `.env` present and DB stopped → exits 0, writes the file (proves hermeticity).
   Run it a second time → `git status` shows `apps/api/openapi.json` unchanged
   (byte-idempotent).
2. **Stdout mode.** `cd apps/api && uv run python -m budget_api.openapi_export` →
   prints the same document to stdout, writes no file.
3. **Contract contains A5's 503.** Committed `apps/api/openapi.json`'s
   `paths./health.get.responses` has both `"200"` and `"503"`; keys are sorted;
   file ends with a newline.
4. **Drift test green when in sync.** `pnpm turbo test --filter=@budget/api` →
   passes, including `TestOpenApiExport::test_committed_schema_matches_current_app`.
5. **Drift test red when perturbed.** Hand-edit `apps/api/openapi.json` (e.g. delete
   a key) → the drift test fails with the "run `pnpm openapi`" message; revert.
6. **Lint/type clean on new Python.** `cd apps/api && uv run ruff check . && uv run ruff format --check . && uv run pyright` → all clean (covers `openapi_export.py`
   and the new test).
7. **turbo config valid & task resolves.** `turbo run openapi --dry-run` (or
   `--filter=@budget/api`) lists the `@budget/api#openapi` task with output
   `openapi.json`; `turbo run generate --dry-run` shows `@budget/api-client#generate`
   depending on `@budget/api#openapi`. (Full `pnpm openapi` end-to-end succeeds only
   after frontend F1/F2 add the `generate` script — see Risks/sequencing.)
8. **eslint config still loads.** `pnpm lint` → runs without config errors; the
   generated path is ignored, `packages/*/scripts/**/*.mjs` gets Node globals.

Note on `make test`: this repo has no Makefile (the pytest-conventions skill's
`make test` is generic). The equivalent local gate is
`pnpm turbo test --filter=@budget/api` (api slice) and `pnpm test` (whole repo);
these are what CI will run. Flagged as an open question below.

---

## Risks

- **FastAPI/Pydantic version bump changes schema bytes** → drift test goes red on
  the upgrade PR. Designed behavior: regenerate (`pnpm openapi`) in the same commit
  as the pin bump. `uv.lock` prevents surprise drift from floating deps. (Python-side
  analog of the architecture's generator-upgrade risk.)
- **`info.version` churn** (accepted, D1): every `__version__` bump changes one line
  in `openapi.json` (and one in the generated TS). Trivial diff; drift test enforces
  regeneration.
- **Sequencing gap:** root `package.json`'s `"openapi": "turbo run generate"` and
  the `@budget/api-client#generate` turbo entry reference an api-client `generate`
  script that frontend F1/F2 add. Between this slice landing and frontend's,
  `pnpm openapi` finds no `generate` task and no-ops harmlessly; the api-side export
  is independently runnable via `pnpm --filter @budget/api openapi`. Full pipeline is
  green only after F1–F3. Reviewer should not treat an empty `turbo run generate` as
  a defect pre-frontend.
- **`pkg#task` dependsOn without a package.json dep edge** relies on turbo ≥ 2.4
  behavior; repo is 2.10.6 (verified in architecture). Low risk; the `--dry-run`
  check in acceptance criterion 7 confirms it resolves.
- **pytest suite still requires local Postgres** for the DB-free drift test
  (conftest fail-fast, 0.2). Accepted for one-gate simplicity (architecture Risks).

---

## Disagreements with architecture

None substantive. Two clarifications made within stated engineer latitude
("internal idioms ... backend/frontend engineers' latitude", architecture §"What
this does NOT decide"):

1. Added a `build_export_app()` helper (canonical hermetic-app builder) alongside
   `openapi_json()` so the CLI and drift test share one construction, not just one
   serializer. Strengthens D1's single-source-of-truth intent; changes no bytes and
   no public contract.
2. `.dockerignore` excludes `openapi.json` (Step 9). The architecture only stated
   that shipping the *export module* is harmless; it did not rule on the artifact.
   Excluding a build-only contract file with no runtime role is consistent with the
   lean-image posture and is not a contradiction of D1.

---

## Per-amendment / carry-forward checklist (binding items → plan step)

| Binding carry-forward / amendment | Source | Satisfied by |
|---|---|---|
| Root-file ownership = backend-engineer (turbo.json, root package.json, root README, eslint.config.mjs) | task.md carry-forward; 0.1 §1.1 | Steps 5, 6, 7, 8 — all root-file edits made here, nowhere else |
| Scaffold-lifetime placeholder rule: this task lands api-client's first real content; the `export {}` shell + "no test script" state are absorbed **by frontend F4/F1** | task.md carry-forward; 0.1 §1.3 | **Not this slice.** Backend does not touch `packages/api-client/`; noted explicitly so the placeholder deletion is not double-owned. Frontend F4 owns it. |
| Implementation reports must check off each binding amendment/carry-forward explicitly | task.md carry-forward; 0.1 retro; 0.2 §4 | Obligation recorded here; at `/implement` the report will tick each row of this table + confirm A5's 503 in the committed schema |
| A5 — 503 declared in OpenAPI (503 must be visible to the generated client) | grooming-review A5 | Step 3 acceptance: committed `openapi.json` carries both `200` and `503` for `/health` (already declared in `routers/health.py`); verified in acceptance criterion 3 |
| Cache-honesty / explicit-inputs convention (turbo inputs must list every real input) | 0.2 grooming-review; D3 | Step 5 — `openapi.json` added to `@budget/api#test` inputs; explicit `@budget/api-client#test` inputs; `$TURBO_ROOT$` cross-package input on `generate` |
| pyright strict on `src/`, ruff rule set, exact-style tooling scope | 0.2 grooming-review | Step 1 (module under `src/`, strict-clean, no `Any` leak) + acceptance criterion 6 |

---

## Open questions (with recommendations)

1. **`make test` vs the repo's actual gate.** The pytest-conventions skill says to
   run `make test`; this monorepo has no Makefile — the real gate is
   `pnpm turbo test --filter=@budget/api` / `pnpm test`. **Recommendation:** treat
   `pnpm turbo test --filter=@budget/api` as the "make test" equivalent for the
   backend slice; no Makefile is introduced by 0.3. Confirm senior-lead is fine with
   this substitution (it changes nothing about which tests run).

2. **Should backend reword the stale README Layout line now (Step 8) or leave it to
   frontend?** It is a root-file line (backend-owned) but describes api-client
   internals that frontend lands. **Recommendation:** backend updates it in the same
   README edit (Step 8) since root-file ownership is exclusive; frontend cannot touch
   README. Trivial, avoids a cross-owner edit. Flag if senior-lead prefers otherwise.
