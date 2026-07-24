# Architecture Plan: OpenAPI → TypeScript client pipeline (roadmap 0.3)

## Context

Task 0.2 gave the API a real `/health` endpoint whose OpenAPI schema truthfully
declares both 200 and 503 (amendment A5 exists precisely so this task can generate
a truthful client). `packages/api-client` is still an `export {}` shell with
lint+typecheck only and — deliberately, per 0.1 — no test script.

The architectural question: how does the FastAPI contract become committed,
type-safe TypeScript that both clients consume, such that

- the schema can be exported **without a running server and without any env/DB**,
- web deploys (Vercel/Netlify) **never need Python** (hard constraint),
- drift between API code, schema, and generated TS **fails loudly and locally**
  (CI-ready later, no CI files now),
- the choice survives 1.1 (JWT header injection), 1.5/1.8 (web + React Native
  consumption via TanStack Query), and 4.4 (SSE streaming).

Facts verified by senior-lead and confirmed against source: `create_app(settings:
Settings | None)` factory; `Settings` requires `database_url` (env or
`apps/api/.env`); `app.openapi()` runs no lifespan and touches no DB; turbo 2.10.6
(supports `$TURBO_ROOT$` inputs since 2.4 and cross-package `pkg#task` dependsOn
without a package.json dependency edge); pnpm workspaces with `node-linker=hoisted`;
other TS workspaces use vitest 4.1.10 and exact-version pins (0.1 convention);
`FastAPI(title="Budget API", version=__version__)` with `__version__ = "0.1.0"`.

## Decisions

### D1. Schema export: in-package module, explicit dummy Settings, canonical serializer

**Mechanism.** New module `apps/api/src/budget_api/openapi_export.py`:

- `openapi_json(app: FastAPI) -> str` — the **canonical serializer**:
  `json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"`.
  One function is the single source of truth for bytes; the CLI entry and the
  pytest drift test (D4) both call it, so the "two serializers silently disagree"
  trap is structurally impossible.
- `__main__`-style entry: `uv run python -m budget_api.openapi_export [output-path]`
  (default: stdout). Wired as `apps/api/package.json` script
  `"openapi": "uv run python -m budget_api.openapi_export openapi.json"` — pnpm
  runs scripts with cwd = package dir, so the path is stable.

**Hermetic Settings.** The entry constructs the app as
`create_app(Settings(database_url="postgresql+asyncpg://openapi-export-placeholder/none"))`
— an explicit, obviously-fake value passed as a kwarg. Pydantic-settings only
consults env/.env for fields *not* supplied, and `database_url` is the only field,
so the export depends on **no** environment, no `.env`, no DB, no network. It must
NOT call `get_settings()` (cached, env-dependent).

**Determinism.** `sort_keys=True` (byte-stable even if router include order or dict
construction order is refactored; JSON object key order is non-semantic; array
order — e.g. `required` — is semantic and is *not* sorted), `indent=2`, trailing
newline, UTF-8 with `ensure_ascii=False`. Same code ⇒ same bytes, guaranteed.

**Location & committed-ness.** Output lives at **`apps/api/openapi.json`,
committed**. Rationale: it is the API's published contract, produced by an api-side
task, and turbo task `outputs` must be package-relative — an api task writing into
`packages/api-client` would break turbo caching semantics (see D3). The client
package reads it cross-package at generation time only.

**`info.version` churn — accepted.** The schema embeds `__version__`; every version
bump changes one line in `openapi.json` and one line in the generated TS. Bumps are
rare, the diff is trivial, and the drift check makes forgetting to regenerate
impossible. Pinning `info.version` to a constant in the export was rejected: it
would make the committed contract lie relative to the running server's `/openapi.json`
(and 0.2's TC-B5 asserts `.info.version == __version__`).

**Alternatives rejected.**
- `apps/api/scripts/export_openapi.py` outside `src/`: escapes pyright strict mode
  and ruff's configured scope, needs sys.path or config additions. Inside the
  package it's ~30 lines that get full tooling for free; shipping it in the Docker
  image is harmless.
- Export by hitting a running server's `/openapi.json`: needs a server, env, and a
  DB-shaped config — the opposite of hermetic; nondeterministic availability.
- Not committing `openapi.json` (regenerate on demand): would require Python on
  every consumer of the schema, including Vercel — violates the hard constraint;
  also loses reviewable contract diffs.

### D2. Generator: `openapi-typescript` (types) + `openapi-fetch` (runtime)

Validated against the three named requirements:

- **(a) Typed responses per status code.** `openapi-typescript` emits the full
  `responses` map per operation — `paths["/health"]["get"]["responses"][200]` and
  `[503]` are both present and independently typed (A5's payoff). `openapi-fetch`'s
  `{ data, error, response }` result splits 2XX (`data`) from non-2XX (`error`);
  for `/health` the 503 body is typed on `error` and the exact status is on
  `response.status`. Where finer discrimination is ever needed, the generated
  per-status types remain directly importable.
- **(b) JWT at 1.1.** `openapi-fetch` has first-class middleware
  (`client.use({ onRequest })`) — the Authorization header injector and later the
  refresh dance hang there without touching generated code. Designed at 1.1, not now.
- **(c) SSE at 4.4.** Generated fetch wrappers do routinely break on streaming.
  Escape hatch, declared now: SSE endpoints get a **hand-written** function in
  `src/` (plain `fetch` + `ReadableStream`/SSE parsing) that imports its request/
  response *types* from the generated schema but bypasses the `openapi-fetch` call
  path entirely (`openapi-fetch` also supports `parseAs: "stream"` as a lighter
  fallback). The generated client never has to "support" SSE; the type layer still
  covers it.

**Why not the alternatives.**
- *openapi-typescript alone + hand-written thin fetch wrapper*: the wrapper ends up
  re-implementing exactly what `openapi-fetch` is — path-param interpolation,
  querystring serialization, per-operation body/response typing — by the same
  maintainers, ~6 kB, zero dependencies. Hand-rolling that mapping is where type
  lies creep in. Rejected as make-work with worse guarantees.
- *orval*: generates TanStack Query hooks and defaults to axios. We explicitly do
  **not** want generated framework hooks: both clients already own their TanStack
  Query conventions (query keys, invalidation, Zustand interplay), hooks would
  couple `packages/api-client` to React versions across web *and* Metro, and axios
  is dead weight on React Native. Heavier codegen surface, more churn.
- *hey-api (openapi-ts)*: capable, but a larger, faster-moving toolchain (client
  plugins, SDK generation) for a need that is "types + tiny fetch". More moving
  parts to pin and track for no additional requirement met.
- *Generated hooks in general* — refuted, per above: the data layer belongs to the
  apps; the client package stays framework-free (also keeps it consumable from
  non-React contexts, e.g. scripts).

**Runtime/bundle/RN check.** `openapi-fetch` is dependency-free, dual ESM/CJS,
built on the global `fetch` — present in browsers and React Native; no Node-only
APIs, so Metro + hoisted node_modules is unproblematic (verified for real at 1.8).
`openapi-typescript` is a devDependency only. Both pinned to exact versions
(0.1 convention); exact numbers chosen at implementation time.

### D3. Workspace wiring: api exports, api-client generates, turbo chains them

**Script ownership.**
- `@budget/api` owns schema export: script `openapi` (D1).
- `@budget/api-client` owns TS generation: script
  `"generate": "node scripts/generate.mjs"`. `scripts/generate.mjs` is a small
  hand-written wrapper over the `openapi-typescript` **Node API**
  (`openapiTS` + `astToString`), exporting a `generateSchema(): Promise<string>`
  function and writing `src/generated/schema.d.ts` when run as a script. Reason to
  prefer the Node API over the CLI: the vitest drift test (D4) imports the *same*
  function, so generator and checker cannot produce different bytes (mirrors the
  Python-side canonical-serializer design).
- Root `package.json` gains `"openapi": "turbo run generate"` — the one command a
  developer runs after changing routers/schemas.

**Turbo config** (all edits to `turbo.json` and root `package.json` by
backend-engineer per the root-file ownership rule):

```json
"@budget/api#openapi": {
  "inputs": ["src/**", "pyproject.toml", "uv.lock"],
  "outputs": ["openapi.json"]
},
"@budget/api-client#generate": {
  "dependsOn": ["@budget/api#openapi"],
  "inputs": ["$TURBO_ROOT$/apps/api/openapi.json", "scripts/**", "package.json"],
  "outputs": ["src/generated/**"]
}
```

Notes:
- The `pkg#task` dependsOn works without adding `@budget/api` as a package.json
  dependency of api-client (verified: turbo 2.10.6). No fake workspace edge.
- `$TURBO_ROOT$` makes the cross-package schema read an honest cache input.
- Cache-restore of `openapi.json` / `src/generated/**` rewrites committed files
  with identical bytes for identical inputs — harmless by construction (D1/D2
  determinism).
- **Input corrections to existing tasks** (cache-honesty, per 0.2's explicit-inputs
  convention): `@budget/api#test` inputs gain `"openapi.json"` (the new pytest
  drift test reads it); a new explicit `@budget/api-client#test` entry gets
  `["src/**", "scripts/**", "package.json", "tsconfig.json", "$TURBO_ROOT$/apps/api/openapi.json"]`
  — without it, turbo's default package-local hashing would serve a stale green
  cache when only `apps/api/openapi.json` changed.

**Committed vs generated on demand: BOTH artifacts committed**
(`apps/api/openapi.json` and `packages/api-client/src/generated/schema.d.ts`).

- Vercel/Netlify builds of web need neither Python (schema committed) nor even the
  generator (TS committed) — the hard constraint is met with zero build-step
  additions.
- Fresh clone: `pnpm install && pnpm typecheck` works with no Python toolchain —
  matters for frontend/mobile-only sessions.
- Solo-dev workflow: contract changes show up as reviewable diffs in both files in
  the same commit as the API change; the drift checks (D4) make "forgot to
  regenerate" a red test, not a runtime surprise.
- Rejected — *commit schema only, generate TS during builds*: forces
  `openapi-typescript` into every consumer's build (Vercel included), adds
  postinstall/prebuild hooks, and leaves the editor/typecheck experience broken
  until first generation. Buys nothing except one less committed file.
- Rejected — *commit nothing*: violates the no-Python constraint outright.

### D4. Drift check: both edges, recompute-and-compare, rides in `test`

Two edges, each checked by recomputing from the upstream source and byte-comparing
against the committed downstream file. Neither compares a file to itself; both are
deterministic by D1/D3 (canonical serializer shared between writer and checker;
generator version pinned exactly).

- **Edge 1 (api code → openapi.json), Python side.** New pytest
  `apps/api/tests/test_openapi_export.py`: builds the app with the same explicit
  dummy `Settings`, calls the canonical `openapi_json()`, compares to the bytes of
  the committed `apps/api/openapi.json`. On mismatch the assertion message says
  exactly what to run: `pnpm openapi` (and commit the result). Lives in the
  existing pytest suite ⇒ part of `@budget/api#test`. (The suite's DB fail-fast
  conftest means pytest still wants the compose Postgres up; the drift test itself
  is DB-free. Accepted — one gate, no special-case markers.)
- **Edge 2 (openapi.json → schema.d.ts), TS side.** New vitest
  `packages/api-client/src/drift.test.ts`: imports `generateSchema()` from
  `scripts/generate.mjs` (the very function `generate` runs), regenerates the
  string from `../../apps/api/openapi.json`, compares to the committed
  `src/generated/schema.d.ts`. Failure message: run `pnpm openapi`, commit.

**Where it runs:** inside each package's existing `test` task — `pnpm test` at the
root is the complete local gate and is exactly what CI will run later. No CI files
now.

**Rejected alternatives.**
- Separate `check:drift` turbo task / root shell script (`git status`-style diff
  after regeneration): a second command to remember, needs Python locally even for
  frontend-only work if run as one script, and duplicates what `test` already
  orchestrates. The `git status` approach additionally mutates the working tree
  during verification — ugly in a pre-commit/CI context.
- Checking only edge 2: an API change without re-export would keep both committed
  files consistent with *each other* while both lie about the code — the classic
  vacuous drift check. Both edges or nothing.
- Semantic (parsed-JSON deep-equal) comparison instead of bytes: hides formatting
  nondeterminism instead of fixing it, and weakens the "committed file is exactly
  what the tool produces" invariant. Byte equality + canonical serialization is
  strictly stronger and simpler.

### D5. `packages/api-client` shape

```
packages/api-client/
├── package.json          # + deps, scripts (see below)
├── tsconfig.json         # unchanged (extends base, include src)
├── scripts/
│   └── generate.mjs      # hand-written generator wrapper (D3); plain JS, node:fs
└── src/
    ├── generated/
    │   └── schema.d.ts   # GENERATED — header comment "AUTO-GENERATED, do not edit;
    │                     #   run `pnpm openapi`"; never hand-edited; eslint-ignored
    ├── client.ts         # hand-written: createApiClient(...)
    ├── index.ts          # public surface (replaces the `export {}` shell —
    │                     #   scaffold placeholder absorbed per 0.1 carry-forward)
    ├── contract.test.ts  # type-level contract test (below)
    └── drift.test.ts     # edge-2 drift test (D4)
```

Hard boundary: everything under `src/generated/` is machine-owned; everything else
is hand-owned. The generated file is excluded from eslint (root `eslint.config.mjs`
ignore — a root file, so backend-engineer applies the edit) but *included* in
`tsc --noEmit` (it must typecheck; that is part of its job).

**Public surface for 1.5** (`src/index.ts`):

```ts
export function createApiClient(options: { baseUrl: string; fetch?: typeof fetch }): ApiClient
export type ApiClient  // ReturnType<typeof createClient<paths>>
export type { paths, components } from "./generated/schema"
export type HealthResponse = components["schemas"]["HealthResponse"]  // convenience alias
```

`createApiClient` is a thin wrapper over `openapi-fetch`'s `createClient<paths>()`.
`baseUrl` is the only required config; an injectable `fetch` keeps tests and
future RN edge cases honest. No auth options now (1.1 adds middleware), no
retry/refresh logic, no default baseUrl guessing — fetch config beyond this lives
in the apps.

**package.json changes:**
- `dependencies`: `openapi-fetch` (exact pin).
- `devDependencies`: + `openapi-typescript` (exact pin), + `vitest` `4.1.10`
  (matches shared/web/mobile); `typescript` stays `5.9.3`.
- `scripts`: + `"generate": "node scripts/generate.mjs"`,
  + `"test": "vitest run --typecheck"` — the first test script this package has
  ever had (deliberate 0.1 deferral, revisited now as planned). `--typecheck` makes
  the type-level assertions fail the **test** task itself, not only `typecheck`.

**First non-vacuous tests — exactly two, each carrying distinct weight:**

1. `contract.test.ts` (type-level, `expectTypeOf`): asserts
   `paths["/health"]["get"]["responses"]` contains **both** `200` and `503`, each
   with `application/json` content of shape
   `{ status: "ok" | "degraded"; database: "ok" | "unavailable" }`.
   Why it is not vacuous: the drift tests prove code→schema→TS *consistency*, but
   nothing else pins the *contract itself*. If someone removes the A5
   `responses={503: ...}` declaration and dutifully regenerates, every drift check
   stays green — this test alone goes red. It is the executable form of amendment A5.
2. `drift.test.ts` (edge 2, D4): the real "generated code is not stale" gate.

Rejected test candidates: a runtime test that instantiates `createApiClient` and
hits a live API (that's the api-side pytest/QA domain — duplicate coverage, needs
infra); snapshot tests of the generated file (that *is* comparing a file to
itself); re-asserting that `createApiClient` returns an object (vacuous per the
global test policy). Runner: vitest 4.1.10 — matching every other TS workspace;
no reason to deviate.

### D6. README "Regenerating the API client" section (outline)

Written by backend-engineer (root-file ownership). Content outline:

- **When:** after any change to `routers/`, `schemas/`, app metadata, or a version
  bump — anything that alters the OpenAPI schema.
- **How:** `pnpm openapi` from the repo root (turbo runs schema export, then TS
  generation, cached/skipped when nothing changed).
- **What it rewrites:** `apps/api/openapi.json` and
  `packages/api-client/src/generated/schema.d.ts` — commit **both** together with
  the API change.
- **The gate:** `pnpm test` fails on either drift edge with a message telling you
  to run `pnpm openapi`; never hand-edit anything under `src/generated/`.
- **Note:** export is hermetic — no `.env`, DB, or running server needed (Python/uv
  is needed, since the export runs the FastAPI app's schema generation).

## Task-graph & file inventory

Sequencing: backend first (steps B1–B5 produce the committed schema and wiring),
then frontend (F1–F5 consume it). One integration point: the committed
`apps/api/openapi.json`.

**backend-engineer**
- B1 `apps/api/src/budget_api/openapi_export.py` — new: `openapi_json()` canonical
  serializer + CLI entry with explicit dummy `Settings` (D1).
- B2 `apps/api/openapi.json` — new, generated by B1, committed.
- B3 `apps/api/tests/test_openapi_export.py` — new: edge-1 drift test (D4).
- B4 `apps/api/package.json` — add `"openapi"` script.
- B5 Root files (ownership rule):
  - `turbo.json` — `@budget/api#openapi`, `@budget/api-client#generate`,
    `@budget/api-client#test` entries; add `"openapi.json"` to `@budget/api#test`
    inputs (D3).
  - root `package.json` — add `"openapi": "turbo run generate"`.
  - `eslint.config.mjs` — ignore `packages/api-client/src/generated/**`; add a
    node-globals block for `packages/*/scripts/**/*.mjs`.
  - `README.md` — D6 section.

**frontend-engineer**
- F1 `packages/api-client/package.json` — deps/scripts per D5 (exact pins).
- F2 `packages/api-client/scripts/generate.mjs` — generator wrapper exporting
  `generateSchema()` (D3).
- F3 `packages/api-client/src/generated/schema.d.ts` — generated via F2, committed,
  with do-not-edit header.
- F4 `packages/api-client/src/client.ts` + `src/index.ts` — `createApiClient`,
  public exports; deletes the `export {}` placeholder (0.1 carry-forward: this task
  lands the workspace's first real content, so the placeholder dies here).
- F5 `packages/api-client/src/contract.test.ts` + `src/drift.test.ts` — D5 tests.

**QA note (for senior-lead's team call):** the drift tests + the A5 type-level
contract test *are* the automated verification of this task; a separate qa-engineer
pass adds little beyond a checklist run of `pnpm openapi` idempotency
(`git status` clean after a second run) and `pnpm test` red/green when the schema
is perturbed — minimal QA is justified.

**Dependency direction** — unchanged and respected: `apps/web|mobile` →
`packages/api-client` → (build-time file read only) `apps/api/openapi.json`. No
workspace dependency edge from api-client to `@budget/api`; nothing in `apps/api`
imports or knows about the TS side. Within the api, `openapi_export` imports
`app`/`config` only (top of the existing layering, no reverse deps).

## Risks

- **Generator upgrades change output formatting** → drift test goes red on the
  upgrade PR. That is the designed behavior: regenerate in the same commit as the
  pin bump. Exact pins (0.1 convention) prevent surprise drift from floating
  versions.
- **`info.version` churn** (accepted, D1): every `__version__` bump touches
  `openapi.json` + `schema.d.ts`. One-line diffs; drift tests enforce regeneration.
- **openapi-fetch on Metro/React Native**: expected clean (fetch-based, zero deps,
  hoisted layout), but not proven until 1.8. Mitigation: the package's surface is
  small enough that swapping the runtime while keeping `paths` types is a contained
  change.
- **SSE (4.4)**: explicitly out of the generated call path (D2 escape hatch); risk
  deferred with a named plan, not ignored.
- **pytest suite requires local Postgres even for the DB-free drift test**
  (conftest fail-fast from 0.2). Accepted for one-gate simplicity; revisit only if
  it actually hurts.
- **`vitest run --typecheck` behavior** (type assertions failing the test task) is
  vitest-4 functionality the repo hasn't used yet; if it misbehaves, the fallback
  gate is the existing `tsc --noEmit` typecheck task — the assertions fail there
  regardless.
- **Turbo `$TURBO_ROOT$`** required for honest cross-package inputs — supported
  since 2.4; repo is on 2.10.6.

## What this does NOT decide

- Exact pinned versions of `openapi-typescript` / `openapi-fetch` (implementation
  time, latest stable, pinned exact).
- JWT middleware design and refresh-token flow (1.1); SSE helper implementation
  (4.4); how apps/web wires `createApiClient` into TanStack Query (1.5); Metro
  verification (1.8).
- Internal idioms of the tests (exact `expectTypeOf` phrasing, temp handling) and
  of `generate.mjs` — backend/frontend engineers' latitude within the boundaries
  above.
- CI pipeline wiring (none exists; everything here is `pnpm test`-shaped and
  therefore CI-ready).

## Open questions for PM (each either/or, with recommendation)

1. **Commit both generated artifacts vs commit schema only (generate TS in each
   consumer build)?** — **Recommendation: commit both** (`openapi.json` +
   `schema.d.ts`). Vercel/no-Python is satisfied with zero build hooks, fresh
   clones typecheck without Python, contract diffs are reviewable; drift tests
   neutralize the staleness downside.
2. **`openapi-fetch` runtime vs types-only + hand-written fetch wrapper?** —
   **Recommendation: openapi-fetch.** ~6 kB, zero deps, same maintainers as the
   type generator, middleware story for 1.1, RN-compatible; hand-rolling the same
   mapping is where type safety quietly dies.
3. **Schema home: `apps/api/openapi.json` vs `packages/api-client/openapi.json`?**
   — **Recommendation: apps/api.** The producer owns its artifact and turbo task
   outputs stay package-relative; the client reads it via an explicit
   `$TURBO_ROOT$` input. (Client-side colocation would force an api task to write
   outside its package, breaking turbo output caching semantics.)
4. **`info.version` in the exported schema: truthful `__version__` (churn on bumps)
   vs pinned constant (no churn, schema lies vs live `/openapi.json`)?** —
   **Recommendation: truthful.** Bumps are rare and one-line; 0.2's TC-B5 already
   asserts the live schema carries `__version__`.
5. **Drift checks inside existing `test` tasks vs a dedicated `check:drift`
   task/root script?** — **Recommendation: inside `test`.** One local gate
   (`pnpm test`), zero new commands to remember, exactly what CI will run later.
