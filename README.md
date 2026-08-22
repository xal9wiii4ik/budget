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
    └── api-client — OpenAPI-generated TS types + typed fetch client
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

## Run everything (Docker)

One command brings up Postgres, MinIO, the API and the web app. Migrations run as
part of the API container's start, so a fresh machine needs nothing else:

```bash
docker compose up -d --build
```

| Service | URL | Notes |
|---|---|---|
| Web app | http://localhost:5173 | static build served by nginx |
| API | http://localhost:8010 | `/health` answers `{"status":"ok",...}` |
| MinIO console | http://localhost:9011 | `minioadmin` / `minioadmin` |
| Postgres | localhost:5443 | override with `POSTGRES_HOST_PORT` |

Ports are env-overridable (`WEB_HOST_PORT`, `API_HOST_PORT`, `POSTGRES_HOST_PORT`)
because 5433, 8000 and 8081 belong to other projects on this machine.

Stop it, keeping data:

```bash
docker compose down
```

Rebuild after changing code — the images are built, not mounted, so a rebuild is
what picks changes up:

```bash
docker compose up -d --build api web
```

**AI features.** The advisor and receipt parsing answer an honest
`503 AI_NOT_CONFIGURED` until an `ANTHROPIC_API_KEY` exists. Put it in a root
`.env` (gitignored) and recreate the API container:

```bash
docker compose up -d api
```

**Why MinIO listens on 9010 inside the container too.** Presigned upload and
download URLs are signed together with their host. The browser must reach that
host, and so must the API when it fetches an image back for parsing. One alias —
`minio.localhost:9010` — satisfies both: browsers resolve `*.localhost` to
127.0.0.1 and land on the published port, while inside the compose network the
alias resolves to the container.

## Run the API locally (without Docker)


The backend needs a Postgres instance. A root `docker-compose.yml` provides one
(`postgres:17-alpine`, host port **5433**), plus an init script that creates a
separate `budget_test` database used by the test suite.

```bash
docker compose up -d postgres          # start Postgres (host port 5433)
cp apps/api/.env.example apps/api/.env  # DATABASE_URL for local dev
(cd apps/api && uv sync)                # install the Python environment

pnpm --filter @budget/api dev           # start the FastAPI dev server (uvicorn --reload)
curl localhost:8000/health             # -> {"status":"ok","database":"ok"}
```

`dev`, `uv run pytest`, and every `alembic` command must be run from `apps/api`
(the `.env` file is resolved relative to the process working directory).

Migrations (no-op today — no revisions exist yet):

```bash
cd apps/api
uv run alembic upgrade head            # clean no-op at 0.2
```

Tests run against the `budget_test` database on the same Postgres:

```bash
pnpm turbo test --filter=@budget/api
```

**`budget_test` caveat:** the init script that creates `budget_test` runs only on
first initialization of the `budget_pg_data` volume. If the volume predates this
script (e.g. from an earlier scaffold), recreate it so the test DB exists:

```bash
docker compose down -v && docker compose up -d postgres
```

## Regenerating the API client

The typed TypeScript client in `packages/api-client` is generated from the API's
OpenAPI schema. Regenerate it after **any** change that alters the schema — new or
changed `routers/`, `schemas/`, app metadata (title), or a `__version__` bump.

```bash
pnpm openapi   # from the repo root
```

This runs the schema export (`app.openapi()` → `apps/api/openapi.json`) and then
the TypeScript generation, and is cached/skipped by turbo when nothing changed.
It rewrites two files that must be committed **together** with the API change:

- `apps/api/openapi.json` — the published contract
- `packages/api-client/src/generated/schema.d.ts` — the generated TS types

`pnpm test` is the gate: it fails on either drift edge with a message telling you
to run `pnpm openapi`. Never hand-edit anything under `src/generated/`.

The export is hermetic — it consults no `.env`, database, or running server — but
it does need Python/uv, since it runs the FastAPI app's schema generation.

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
