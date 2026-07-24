# Task: openapi-client-generation (roadmap 0.3)

Verbatim PM description:

TASK (id: `openapi-client-generation`, roadmap item 0.3): Build the OpenAPI → TypeScript client pipeline. State: task 0.2 is committed (22a5760) — the API has a real /health endpoint whose schema declares both 200 and 503 (amendment A5 was made precisely so this task generates a truthful client). `packages/api-client` is an `export {}` shell with lint+typecheck only, no test script.

Scope per roadmap 0.3:
- A way to export the OpenAPI schema from the FastAPI app WITHOUT a running server (script that imports create_app and dumps openapi.json — decide exact mechanism)
- Generation tooling decision: openapi-typescript (types only) + thin fetch wrapper vs openapi-fetch companion vs heavier generators (orval, hey-api) — architecture doc names `openapi-typescript`; validate that choice against the need for: typed request/response per status code, and later JWT auth header injection (1.1) and SSE streaming endpoints (4.4 advisor) which generated clients often handle poorly
- Wire generation into the workspace: where the schema file lives, which package owns the generation script, turbo task + inputs so regeneration is cached/invalidated correctly, drift check (generated code committed vs generated on demand — decide, justify; consider that Vercel/Netlify deploys of web must not need Python)
- packages/api-client gains its first real content: generated types + a minimal typed client the web app can consume in 1.5; its scaffold-era "no test script" state gets revisited — decide what a real non-vacuous test looks like here (e.g. a type-level test that /health 200 and 503 shapes exist, or a drift test)
- README section: how to regenerate after API changes

Team: your call, justify. Cross-package contract → architect likely. backend-engineer (export script, api side) + frontend-engineer (generation config, client package). QA probably minimal — decide and justify what verifies this (drift check may BE the QA).

Process notes from the PM: proceed without waiting; artifacts to .tasks/openapi-client-generation/; keep lean — no auth, no client usage in apps yet (that's 1.5); Phase 4 review MUST include the per-amendment checklist. Return: team + reasoning, artifact paths, open questions with recommendations. Do NOT start implementation.

Binding carry-forwards from previous groomings (0.1, 0.2):
- Root file ownership = backend-engineer (turbo.json, root README, root package.json — nobody else touches root files).
- Scaffold-lifetime placeholder rule: the task that lands the first real content in a workspace deletes/absorbs that workspace's placeholder. For api-client that is THIS task: the `export {}` shell in src/index.ts is replaced; api-client has no placeholder test (0.1 §1.4 — first real test arrives now).
- Implementation reports must check off each binding amendment explicitly (0.1 retro, 0.2 §4).
