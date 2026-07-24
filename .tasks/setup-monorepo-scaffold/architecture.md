# Architecture Plan: setup-monorepo-scaffold (roadmap 0.1)

## Context

Turn a docs-only directory into the monorepo skeleton that every later task builds on. The structural questions: how a Python app coexists with a pnpm/Turborepo workspace, whether shared TS packages ship built artifacts or raw source, and which lint/format/test baselines become project-wide conventions. Getting these wrong means churn in every subsequent task; getting them "big" means maintenance drag on a personal project. Bias: simplest thing that doesn't need to be ripped out at stage 2–4.

## Proposed approach

pnpm workspaces + Turborepo at the root. Five workspaces: three apps, two packages. Python (`apps/api`) is wrapped as a pnpm workspace member with a thin `package.json` whose scripts delegate to `uv`, so one command surface (`turbo lint/typecheck/test`) covers everything. TS packages are consumed as source (no build step). ESLint 9 flat config + Prettier for TS; ruff (lint + format) for Python. Vitest for TS, pytest for Python. Every workspace gets one trivial placeholder test so "green" is a real signal, not a skipped one.

## Repo layout

```
budget/
├── .editorconfig
├── .gitignore
├── .nvmrc                      # 22 (current LTS line)
├── README.md                   # layout map + how to run each workspace
├── package.json                # private, packageManager pin, root scripts (turbo …), engines
├── pnpm-workspace.yaml         # apps/*, packages/*
├── turbo.json
├── tsconfig.base.json
├── eslint.config.mjs           # root flat config, shared by all TS workspaces
├── .prettierrc.json            # + .prettierignore
├── apps/
│   ├── api/
│   │   ├── package.json        # name @budget/api; scripts wrap uv (see below)
│   │   ├── pyproject.toml      # project metadata, requires-python >=3.12, ruff config
│   │   ├── .python-version     # 3.12
│   │   ├── uv.lock
│   │   ├── src/budget_api/
│   │   │   └── __init__.py     # NOTE: routers/domain/services/models/schemas subpackages
│   │   │                       #       are task 0.2, not created here
│   │   └── tests/
│   │       └── test_placeholder.py
│   ├── web/                    # Vite + React + TS (create-vite baseline)
│   │   ├── package.json        # @budget/web
│   │   ├── tsconfig.json       # extends ../../tsconfig.base.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/{main.tsx, App.tsx, App.test.tsx}
│   └── mobile/                 # Expo + TS + expo-router
│       ├── package.json        # @budget/mobile
│       ├── tsconfig.json       # extends expo/tsconfig.base, then local strictness
│       ├── app.json
│       ├── metro.config.js     # monorepo-aware (watchFolders → repo root)
│       └── app/{_layout.tsx, index.tsx} + a placeholder test
├── packages/
│   ├── shared/                 # @budget/shared
│   │   ├── package.json        # exports: ./src/index.ts (source consumption)
│   │   ├── tsconfig.json
│   │   └── src/{index.ts, index.test.ts}
│   └── api-client/             # @budget/api-client — shell only; generation is task 0.3
│       ├── package.json
│       ├── tsconfig.json
│       └── src/index.ts        # empty export {}
```

Root `.gitignore`: node_modules, dist, .turbo, .expo, coverage, `__pycache__`, `.venv`, `.pytest_cache`, `.ruff_cache`, `.env*` (keep `.env.example` later), OS junk.

## Database changes

None. Explicitly out of scope.

## Module structure & dependency direction

- `apps/*` may depend on `packages/*`. Never the reverse; packages never import from apps and never from each other's app-specific concerns. `packages/api-client` may depend on nothing app-side; `packages/shared` depends on nothing internal.
- `packages/api-client` will later be **generated from** `apps/api`'s OpenAPI schema (task 0.3). Generation direction: api → api-client (build-time artifact flow, not a runtime dependency). Not designed here; the shell package just reserves the name and tsconfig.
- `apps/api` internal layering (`routers/ domain/ services/ models/ schemas/`) is task 0.2. This scaffold creates only the package root so 0.2 has a home.

## Decisions

### 1. Python project manager: uv (not poetry)

**uv.** Justification: order-of-magnitude faster installs/resolution; single binary manages Python version pinning (`.python-version` → uv installs 3.12 itself, no pyenv), lockfile (`uv.lock`) is first-class; `uv run pytest` gives hermetic script execution without activate-venv ceremony — exactly what turbo-wrapped scripts need. By 2026 uv is the de-facto default for new Python projects; poetry's remaining edge (mature plugin ecosystem) is irrelevant here. Not genuinely contestable anymore — decided, not an open question.

### 2. Python × Turborepo integration: wrap with package.json (option a)

`apps/api/package.json` (`"name": "@budget/api"`, `"private": true`) with scripts:

- `lint` → `uv run ruff check . && uv run ruff format --check .`
- `typecheck` → deferred to 0.2 (mypy vs pyright is an 0.2 decision alongside the API deps); at scaffold stage the script is a no-op `exit 0` with a comment, so the turbo task graph is uniform from day one.
- `test` → `uv run pytest`
- `dev` → deferred to 0.2 (no FastAPI app yet).

Why not a Makefile outside turbo: two command surfaces to remember, and `turbo test` silently not covering the API is exactly the kind of gap that bites later (e.g., in CI at stage 1.7). Caching implication: turbo's default inputs are git-tracked files in the package dir, which covers `**/*.py`, `pyproject.toml`, `uv.lock` — Python tasks cache correctly with no extra config beyond declaring inputs explicitly for clarity.

### 3. TS lint/format: ESLint 9 flat config + Prettier (not Biome)

Biome is faster and single-tool, but: Expo/React Native ecosystem still assumes ESLint (eslint-config-expo, react-hooks rules), typescript-aware lint rules are richer in ESLint, and this repo's TS volume is small enough that speed is a non-issue. One root `eslint.config.mjs` with per-workspace overrides (react-hooks for web/mobile). Prettier as separate formatter — boring and universal. **OPEN QUESTION** (mild): Biome would be defensible; recommendation stays ESLint+Prettier for Expo compatibility.

**Python: ruff only** (lint + `ruff format`). black is redundant since ruff format reached parity; one tool, one config block in `pyproject.toml`. Decided.

### 4. Shared TS packages: source consumption, no build step (option a)

`packages/shared` and `packages/api-client` export raw TS via `"exports": { ".": "./src/index.ts" }` (plus `"types"` pointing at the same file). Consumers compile: Vite handles workspace TS out of the box; Metro needs monorepo config — `metro.config.js` sets `watchFolders: [repoRoot]` and `resolver.nodeModulesPaths` to both app-local and root `node_modules` (standard Expo monorepo recipe; Expo SDK 52+ largely auto-detects but we pin it explicitly).

Why: zero build orchestration, no `dist` staleness, instant cross-package edits, no turbo `build` task needed at all for the scaffold. Cost: these packages are not publishable and every consumer must compile TS — both fine forever for a personal app. If a build step is ever needed (publishing, non-TS consumers), tsup can be added per-package without restructuring.

### 5. TypeScript config layering

`tsconfig.base.json` at root: `strict: true`, `moduleResolution: "bundler"`, `module: "esnext"`, `target: "es2022"`, `skipLibCheck`, `noEmit`, `isolatedModules`, `forceConsistentCasingInFileNames`. Per-workspace `tsconfig.json` extends it:

- **web**: adds `jsx: "react-jsx"`, DOM libs, vite types.
- **mobile**: extends `expo/tsconfig.base` *first* (Expo requires its own paths/jsx settings), then re-asserts `strict: true`. It intentionally does NOT extend the root base — Expo's base conflicts; the shared value here is convention, not inheritance. Documented in README so nobody "fixes" it.
- **packages**: extend root base directly; `noEmit` stays true (source consumption, typecheck = `tsc --noEmit`).

### 6. Test runners & "empty suite passes"

- **TS workspaces**: vitest. Each workspace ships exactly one placeholder test (e.g., `expect(true).toBe(true)` or a trivial render/import assertion) rather than `passWithNoTests`. Reason: `passWithNoTests` makes "test script broken / discovering zero files" indistinguishable from green; one real test proves the runner, tsconfig, and jsx transform actually work. For mobile, the placeholder is a plain vitest unit test of a pure function (no jest-expo / native rendering at scaffold stage — that heavyweight setup is deferred until mobile work starts in 1.8). **OPEN QUESTION** noted below.
- **api**: pytest with one `test_placeholder.py` asserting the package imports. Same reasoning.

### 7. turbo.json pipeline

```jsonc
{
  "tasks": {
    "lint":      { "outputs": [] },                       // cacheable
    "typecheck": { "outputs": [] },                       // cacheable
    "test":      { "outputs": [] },                       // cacheable
    "dev":       { "cache": false, "persistent": true }
  }
}
```

- No `build` task at scaffold stage (source consumption, no dist). Added later only if/when something needs it (e.g., web production build in 1.7 — that's `apps/web` `build`, introduced then).
- No `dependsOn: ["^build"]` chains — nothing builds. `test`/`typecheck` don't depend on each other.
- Inputs: turbo defaults (git-tracked package files) suffice, including `.py`. For `@budget/api` declare `"inputs": ["src/**", "tests/**", "pyproject.toml", "uv.lock"]` explicitly in the root turbo.json via package-specific task config — cheap clarity that Python caching is intentional.
- Outputs empty everywhere: these tasks produce logs, not artifacts; turbo caches exit status + logs.

### 8. Version pinning

- **Node**: `.nvmrc` = `22` and `"engines": { "node": ">=22" }` in root package.json.
- **pnpm**: `"packageManager": "pnpm@<exact latest 9.x/10.x at implementation time>"` in root package.json — corepack-compatible exact pin. This is the single source of truth for pnpm version.
- **Python**: `.python-version` = `3.12` in `apps/api` (uv reads it and provisions the interpreter) + `requires-python = ">=3.12,<3.13"` in pyproject.toml. Upper bound because the app targets a specific runtime, not a library audience.

## Trade-offs considered

- **uv vs poetry**: uv — speed, built-in interpreter management, momentum. Poetry adds nothing needed here.
- **Python inside turbo vs Makefile**: inside — one command surface, uniform caching, no coverage gaps. Makefile would be a second dialect for one package.
- **Source-consumed packages vs tsup builds**: source — zero orchestration for a two-consumer personal repo; reversible later.
- **ESLint+Prettier vs Biome**: ecosystem compatibility (Expo) beats raw speed at this scale.
- **Placeholder tests vs passWithNoTests**: a real green beats a vacuous green.
- **Expo tsconfig outside the shared base**: pragmatism over purity; documented.

## What this does NOT decide

Deferred to later tasks / implementation:

- API internal layout, FastAPI deps, mypy-vs-pyright, `dev` server command — **0.2**.
- OpenAPI generation tooling and regeneration workflow — **0.3**.
- `packages/shared` actual contents — **0.4**.
- Exact dependency versions (React, Expo SDK, vitest, ruff, turbo) — backend/frontend engineers pick current stable at implementation time; this doc pins only Node major, Python minor, and the pinning *mechanisms*.
- Web production `build` task shape — **1.7**.
- Mobile native test setup (jest-expo, RN testing library) — **1.8**.
- Out of scope entirely per task: CI, Docker, docker-compose, husky/pre-commit hooks, DB, auth, feature code.

## Open questions for the user

1. **ESLint 9 + Prettier vs Biome** for TS lint/format. Recommendation: **ESLint + Prettier** — Expo/react-hooks ecosystem still assumes ESLint; repo is small so Biome's speed win is negligible.
2. **Node version line: 22 LTS vs 24.** Recommendation: **22** — current active LTS, maximum ecosystem compatibility (Expo tooling in particular); bump later is a one-line change.
3. **Placeholder test per workspace vs `passWithNoTests`-style flags.** Recommendation: **one placeholder test each** — proves the runner and tsconfig actually work; vacuous green hides broken wiring.
4. **Mobile placeholder test as plain vitest unit test vs full jest-expo setup now.** Recommendation: **plain vitest now**, jest-expo deferred to 1.8 when mobile UI work actually starts — jest-expo is heavy config with zero payoff until then.
5. **Scaffold `apps/web` and `apps/mobile` from official generators (create-vite / create-expo-app) then trim, vs hand-write minimal files.** Recommendation: **generators, then trim** — keeps us aligned with upstream defaults (especially Expo, where hand-rolled configs rot); trimming is easy at scaffold size.
