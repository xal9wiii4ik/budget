# Task: setup-monorepo-scaffold (roadmap 0.1)

## Original request (verbatim)

Bootstrap the monorepo skeleton for the project. Currently the directory contains ONLY documentation (budget-app-architecture.md, PLAN.md) and .claude/ config — no code, and it is NOT yet a git repository.

Scope:
- git init + sensible root .gitignore
- pnpm workspaces + Turborepo config
- Directory scaffolds per the architecture doc: apps/api (FastAPI, Python 3.12 — python project managed with uv or poetry, decide and justify), apps/web (Vite + React + TS), apps/mobile (Expo + TS), packages/shared (TS), packages/api-client (TS, generated later — just the package shell now)
- Root tooling: turbo.json pipelines (lint, typecheck, test, dev), base tsconfig, editorconfig, prettier/eslint baseline decision
- README stub describing the layout
- NO feature code, NO DB, NO auth — scaffolds must build/lint/pass empty test suites, nothing more. Items 0.2–0.4 of the roadmap are separate tasks.

Process notes from the PM:
- Proceed without waiting for user confirmation at Phase 1 (pre-authorized).
- Keep the plan LEAN. Over-engineering (CI pipelines, docker-compose, husky hooks) is out of scope unless argued in as trivial.
- Surface open questions per Phase 3.5 with recommendations.

## Senior-lead restatement

Turn the docs-only directory into a working monorepo skeleton: git repo, pnpm workspaces + Turborepo, five package scaffolds, root tooling (lint/typecheck/test/dev pipelines, base tsconfig, editorconfig, lint+format baseline), README. Definition of done: `pnpm install` succeeds, `turbo lint/typecheck/test` pass across all workspaces (empty/placeholder suites), `apps/api` env installs and passes an empty pytest run. No feature code, no DB, no auth, no CI, no Docker.
