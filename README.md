# budget

Personal budget tracker (Expo mobile + React web + FastAPI + Postgres), in a single monorepo.

## Layout

```
budget/
├── apps/
│   ├── api      — FastAPI backend (Python 3.12, uv-managed)
│   ├── web      — Vite + React single-page app
│   └── mobile   — Expo (React Native) app
└── packages/
    ├── shared     — cross-client TypeScript utilities
    └── api-client — OpenAPI-generated TS client (currently a shell; generated in task 0.3)
```

## Prerequisites

- **Node 22+** — see `.nvmrc` (`nvm use`); enforced by root `engines` (`>=22`).
- **pnpm** via corepack — pinned by `packageManager` in `package.json`; run `corepack enable pnpm`.
- **uv** — for `apps/api`; uv provisions the Python 3.12 interpreter, so no separate Python install is required.

## Common commands

Run from the repo root unless noted.

```bash
pnpm install                    # install all workspaces

pnpm lint                       # turbo: lint across all workspaces
pnpm typecheck                  # turbo: typecheck across all workspaces
pnpm test                       # turbo: test across all workspaces

pnpm --filter @budget/web dev   # start the web dev server (Vite)
pnpm --filter @budget/mobile dev # start the Expo dev server
```

For `apps/api` (Python, managed by uv):

```bash
uv sync                         # install/refresh the Python environment
uv run pytest                   # run the backend tests
uv run ruff check .             # lint the backend
```

## Do not "fix" these

- **`apps/mobile/tsconfig.json` extends `expo/tsconfig.base`, not the root `tsconfig.base.json`.**
  This is intentional: Expo's base conflicts with the root base. Shared strictness across the
  repo is a convention we uphold by hand, not something mobile inherits — do not repoint it at
  the root base.
- **Root `.npmrc` sets `node-linker=hoisted`.** This flat `node_modules` layout is required for
  Expo/Metro to resolve dependencies in a pnpm monorepo. Do not remove it.

## A note on tests

The placeholder smoke tests in each workspace are scaffold-lifetime only: they verify the
build/resolution wiring while there is no real code, and get deleted or absorbed as real tests
land (tasks 0.2 for api, 0.4 for shared, 1.x for web/mobile).
