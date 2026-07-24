# Implementation Plan: setup-monorepo-scaffold — root plumbing + apps/api (backend slice)

## Scope of THIS plan

Repo-root plumbing (git, workspace/turbo/tsconfig/lint baselines, README) **plus** the
`apps/api` Python (uv) scaffold. `apps/web`, `apps/mobile`, `packages/shared`,
`packages/api-client` are the frontend engineer's slice and are **not** created here.
No CI, Docker, or git hooks (out of scope per task).

I plan **within** architecture.md. Two places where I make the architect's intent
concrete (not a disagreement, just the mechanism) and one senior-lead override I am
honoring are called out in "Notes / deviations" at the end.

## Approach

pnpm workspaces + Turborepo at the root; `apps/api` is a pnpm workspace member whose
`package.json` scripts delegate to `uv` so the single `turbo lint|typecheck|test`
surface covers Python too (architecture §2). Python is managed by **uv** (architecture
§1): `.python-version` provisions 3.12, `uv.lock` is committed, `uv run` gives hermetic
execution inside turbo-wrapped scripts.

The Python project uses a **src layout with a build backend** so `budget_api` is a real
installed, importable package — this is what lets the placeholder be a genuine wiring
smoke test (`import budget_api; assert __version__`) rather than a tautology. Dev deps at
scaffold stage are **pytest + ruff only** — no fastapi/sqlalchemy (those are task 0.2).

Root TS lint/format files (eslint flat config, prettier) are created as a **functional
baseline** (installable, runnable) but are not exercised by this slice because it ships
no TS workspace. The frontend engineer layers per-workspace overrides (react-hooks,
expo) onto these files.

## Prerequisites (environment — surface to user)

The dev machine currently has `node v24.7.0` and `corepack`, but **`uv` and `pnpm` are
not installed**. Before implementation the implementer must:

1. Install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`).
2. Activate pnpm via corepack (driven by the `packageManager` pin, see below):
   `corepack enable pnpm`.

Node 24 is installed while `.nvmrc` pins the line to `22`; `engines.node` is `>=22`, so
24 **satisfies** the constraint — no conflict, purely informational. Implementer may
`nvm use` if a 22 toolchain is available, otherwise proceeding on 24 is fine.

## Ordered implementation steps

1. `git init` at repo root; author `.gitignore` (step 3 file list).
2. Write root plumbing files: `package.json`, `pnpm-workspace.yaml`, `turbo.json`,
   `tsconfig.base.json`, `.editorconfig`, `.nvmrc`, `eslint.config.mjs`,
   `.prettierrc.json`, `.prettierignore`, `README.md`.
3. Scaffold `apps/api` with uv:
   - `uv init --package --name budget-api apps/api`
     (packaged/src layout → creates `pyproject.toml`, `src/budget_api/__init__.py`,
     `.python-version`, a sample `README.md`).
   - Trim uv's generated boilerplate: remove the sample `[project.scripts]` entry and
     the generated `main()`/hello function; delete uv's stray `README.md` inside
     `apps/api` (root README documents layout).
   - Overwrite `requires-python` to `>=3.12,<3.13` and replace the `[tool.ruff]` block
     per §"pyproject.toml" below.
   - `uv add --dev pytest ruff` (adds dev dependency-group, writes `uv.lock`).
   - Write `apps/api/package.json` (`@budget/api`, scripts) and
     `apps/api/tests/test_placeholder.py`.
   - `uv run ruff format .` once so `ruff format --check .` passes later.
4. Add root TS/lint tooling as workspace-root devDeps and install:
   `pnpm add -Dw turbo eslint @eslint/js typescript-eslint prettier typescript`
   (then `pnpm install`). Pin `packageManager` to the exact resolved pnpm version.
5. Verify acceptance criteria (below).

## Files to create — content sketches

### Root `package.json`
```jsonc
{
  "name": "budget",
  "private": true,
  "packageManager": "pnpm@10.x.y",   // resolve EXACT latest 10.x at impl time; SSOT for pnpm
  "engines": { "node": ">=22" },
  "scripts": {
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "test": "turbo test",
    "dev": "turbo dev"
  },
  "devDependencies": {
    "turbo": "^2",           // pin exact latest 2.x at impl time
    "eslint": "^9",
    "@eslint/js": "^9",
    "typescript-eslint": "^8",
    "prettier": "^3",
    "typescript": "^5"
  }
}
```

### `pnpm-workspace.yaml`
```yaml
packages:
  - "apps/*"
  - "packages/*"
```
(Empty `packages/*` glob is a no-op for pnpm — fine that only `apps/api` exists in this
slice; frontend fills the rest.)

### `turbo.json` (architecture §7, with @budget/api input overrides)
```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "lint":      { "outputs": [] },
    "typecheck": { "outputs": [] },
    "test":      { "outputs": [] },
    "dev":       { "cache": false, "persistent": true },

    // Python task input overrides (architect wanted these explicit for cache clarity).
    // Mechanism: turbo 2.x package#task keys in root turbo.json.
    "@budget/api#lint":      { "inputs": ["src/**", "tests/**", "pyproject.toml", "uv.lock"], "outputs": [] },
    "@budget/api#typecheck": { "inputs": ["src/**", "tests/**", "pyproject.toml", "uv.lock"], "outputs": [] },
    "@budget/api#test":      { "inputs": ["src/**", "tests/**", "pyproject.toml", "uv.lock"], "outputs": [] }
  }
}
```
No `build` task, no `dependsOn` chains (source consumption; nothing builds) — per §7.

### `tsconfig.base.json` (architecture §5 — exact compilerOptions)
```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "strict": true,
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  }
}
```
Exactly the eight options §5 names. Per-workspace `tsconfig.json` files add `jsx`, DOM
`lib`, vite/expo types — those belong to the frontend slice, not the base.

### `.gitignore` (architecture "Root .gitignore")
Node/Turbo/Expo: `node_modules/`, `dist/`, `.turbo/`, `.expo/`, `coverage/`.
Python: `__pycache__/`, `*.py[cod]`, `.venv/`, `.pytest_cache/`, `.ruff_cache/`.
Env: `.env`, `.env.*`, `!.env.example`.
OS/editor: `.DS_Store`, `*.log`.
(Commit `uv.lock` and `pnpm-lock.yaml` — do NOT ignore them.)

### `.editorconfig`
`root = true`; default utf-8 / lf / final-newline / trim-trailing-whitespace /
`indent_style = space`, `indent_size = 2`; override `[*.py] indent_size = 4`.

### `.nvmrc`
```
22
```

### `eslint.config.mjs` (baseline flat config)
```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.turbo/**", "**/.expo/**", "apps/api/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```
`apps/api/**` ignored — Python is linted by ruff, not eslint. Frontend appends
react-hooks / expo overrides here.

### `.prettierrc.json`
```json
{ "semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

### `.prettierignore`
`node_modules`, `dist`, `.turbo`, `.expo`, `coverage`, `pnpm-lock.yaml`, `uv.lock`,
`apps/api/` (Python is formatted by ruff).

### `README.md` (stub outline)
Sections: project one-liner; **Layout** (tree: apps/api·web·mobile, packages/shared·
api-client — noting web/mobile/packages arrive in the frontend slice); **Prerequisites**
(Node 22+, corepack/pnpm, uv); **Common commands** (`pnpm install`,
`pnpm lint|typecheck|test`, `turbo …`); **apps/api** subsection (`uv sync`,
`uv run pytest`, `uv run ruff check .`); a one-line note that mobile's tsconfig will
intentionally not extend the root base (architecture §5) so nobody "fixes" it later.

### `apps/api/pyproject.toml`
```toml
[project]
name = "budget-api"
version = "0.1.0"
description = "Budget app FastAPI backend"
requires-python = ">=3.12,<3.13"
dependencies = []            # fastapi/sqlalchemy are task 0.2

[dependency-groups]
dev = ["pytest>=8", "ruff>=0.6"]

[tool.ruff]
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I"]     # see justification below

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```
Ruff rule justification: `F` (pyflakes — undefined names, unused imports: real bugs),
`E` (pycodestyle errors), `I` (isort — import ordering, which `ruff format` does not do).
Deliberately minimal: opinionated sets (`ANN`, `D`, `B`, `UP`, …) generate noise on an
empty project and are better chosen in 0.2 alongside real code + the mypy/pyright call.

### `apps/api/.python-version`
```
3.12
```

### `apps/api/package.json` (architecture §2 scripts, exact)
```json
{
  "name": "@budget/api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "lint": "uv run ruff check . && uv run ruff format --check .",
    "typecheck": "echo 'no-op: Python typecheck deferred to task 0.2 (mypy vs pyright)'",
    "test": "uv run pytest",
    "dev": "echo 'no-op: dev server deferred to task 0.2 (no FastAPI app yet)'"
  }
}
```
`typecheck`/`dev` are echo no-ops (exit 0) — keeps the turbo task graph uniform from day
one (§2). `echo` carries the "comment" the architect asked for.

### `apps/api/src/budget_api/__init__.py`
```python
"""Budget API package root. Subpackages (routers/ domain/ services/ models/ schemas/) land in task 0.2."""

__version__ = "0.1.0"
```

### `apps/api/tests/test_placeholder.py` (real wiring smoke test — senior-lead override)
```python
import budget_api


class TestPackageWiring:
    def test_package_imports_and_exposes_version(self):
        assert budget_api.__version__ == "0.1.0"
```
Not tautological: it fails if the package fails to install/import (build backend, src
layout, or venv wiring broken) or if `__version__` drifts from `pyproject.toml`. It is
the only pytest test in this slice.

## Test ownership (pytest vs shell/QA verification)

- **pytest (this file, in `apps/api/tests/`):** the one wiring smoke test above.
- **Shell/QA (live-command verification, the scaffold analogue of curl checks):** exit
  codes of `pnpm install`, `uv sync`, `uv run pytest`, and
  `pnpm turbo lint typecheck test`. These are environment/wiring checks, not application
  behavior, so they belong to QA's command-level verification, not pytest.

## Acceptance criteria

1. `corepack enable pnpm` + `uv` installed (prereqs).
2. `pnpm install` at root succeeds (installs turbo/eslint/prettier/typescript; registers
   `@budget/api` as a workspace member with no node deps).
3. `cd apps/api && uv sync` succeeds → creates `.venv` + committed `uv.lock`, installs
   `budget_api` editable.
4. `uv run pytest` in `apps/api` → 1 passed.
5. `pnpm turbo lint typecheck test` from root → **green**, and the run visibly includes
   `@budget/api` (ruff check + `ruff format --check` clean, typecheck/test tasks pass).
6. `pnpm turbo test` a second time → cache HIT for `@budget/api#test` (proves the input
   override is wired).
7. `git status` shows `uv.lock` and `pnpm-lock.yaml` tracked (not gitignored).

## Notes / deviations

- **Senior-lead override honored (flagged for transparency):** the `pytest-conventions`
  skill explicitly bans `test_module_imports()`-style smoke tests, and the project
  owner's CLAUDE.md bans vacuous tests. My task brief overrides this for the scaffold: a
  wiring smoke test is the accepted middle ground because there is no application code to
  test yet, and `passWithNoTests` would leave the pytest/uv/build wiring unverified. I am
  following the override. If the reviewer prefers strict skill compliance, the fallback
  is `--passed-with-no-tests` semantics, which the architect and senior-lead both
  rejected — so no action needed, just noting the tension.
- **Making architecture concrete (not a deviation):** §7 says declare `@budget/api`
  inputs "in the root turbo.json via package-specific task config" — implemented via
  turbo 2.x `"@budget/api#<task>"` keys, which is the supported mechanism for
  per-package config from the root file.
- **uv init flavor:** using `uv init --package` (src layout + build backend) rather than
  the default app layout, specifically so `budget_api` is importable by pytest. Trimming
  uv's generated CLI stub afterward.

## Risks

- **turbo over a non-node package:** `@budget/api` has no node deps; turbo runs its
  `package.json` scripts which shell out to `uv`. If `uv` is not on PATH when turbo runs,
  every api task fails — covered by the prereq step and acceptance criterion 1.
- **`ruff format --check` failing on first run:** freshly authored files must already be
  ruff-formatted. Mitigation: run `uv run ruff format .` once during implementation
  (step 3) before relying on `--check`.
- **pnpm/turbo exact versions unresolved here:** I cannot fetch registry versions in the
  grooming env. Implementer resolves exact latest pnpm 10.x (write into `packageManager`)
  and turbo 2.x at implementation time.
- **Persistent `dev` task that exits immediately:** `@budget/api#dev` is an echo no-op
  while `turbo dev` is `persistent`. This is harmless (turbo tolerates a persistent task
  process exiting) but may print a benign notice; acceptable until 0.2 supplies a real
  dev server.

## Open questions for the user (with recommendations)

1. **Env bootstrap:** `uv` and `pnpm` are not installed on this machine. Recommend the
   two prereq commands above (uv install script + `corepack enable pnpm`). Confirm you
   want the implementer to run these, or you'll install uv yourself.
2. **Ruff rule set at scaffold stage:** recommend minimal `["E", "F", "I"]` now, expand
   in 0.2. Confirm, or ask for a broader set (e.g. add `B`, `UP`) from day one.
3. **Root TS tooling ownership:** this slice installs `eslint/@eslint/js/
   typescript-eslint/prettier/typescript` at the workspace root as the shared baseline;
   the frontend engineer builds per-workspace overrides on top rather than replacing
   them. Recommend keeping ownership of these root devDeps here to avoid two engineers
   editing root `package.json`. Confirm this split.
