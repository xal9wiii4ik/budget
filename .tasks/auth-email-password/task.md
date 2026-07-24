# Task: auth-email-password (roadmap 1.1)

Verbatim PM description:

TASK (id: `auth-email-password`, roadmap item 1.1): Email+password auth per the
architecture doc's "Вход в приложение" section. State: HEAD 7a8f38a, stage 0
fully done — API skeleton with app factory, async SQLAlchemy + Alembic (zero
tables), /health, generated TS client pipeline.

Scope per architecture doc:
- `fastapi-users` integration: registration POST /auth/register, login POST
  /auth/login, refresh, password reset endpoints (architecture: fastapi-users
  gives these out of the box — verify what its current version actually
  provides and at which paths)
- JWT access token ~15 min + refresh token ~30 days, refresh tokens stored in
  DB and revocable; argon2 hashing via pwdlib (architecture names both — verify
  fastapi-users' current strategy options support this exact combo; the
  refresh-token-in-DB requirement is NOT fastapi-users default behavior — this
  is the main design question, decompose it properly per Phase 3.5)
- DB: users table (fastapi-users base), oauth_accounts table as the
  future-OAuth stub per architecture (decide: create now as the doc implies, or
  defer — surface the tradeoff), refresh-token storage table; FIRST real
  Alembic migration 0001 (the 0.2 groundwork pays off here; naming convention
  already on Base.metadata)
- The current_active_user dependency pattern that every later task will use
  (architecture §3: user-scoped filtering must be impossible to forget)
- profiles table: architecture ties base_currency to the user — decide if
  profiles lands here or at 1.2 with the rest of the schema (surface it,
  recommend)
- OpenAPI schema + generated client regeneration as part of the task (drift
  gates)
- Rate limiting on auth endpoints (slowapi is named in architecture §3 for AI
  endpoints — decide if login gets it now or later; brute-force on /auth/login
  is a real concern even for a personal app)
- Real tests replacing nothing (health tests stay); pytest-conventions apply;
  test DB story for auth flows

Team: backend-engineer + qa-engineer certainly; architect — yes (three new
tables, token lifecycle, security-critical contracts); frontend/mobile NOT
needed (client auth UI is 1.5/1.8; the regenerated client types are the only
client-side artifact and frontend-engineer should sanity-REVIEW the generated
auth surface — decide if that's a review role or skippable).

Process notes from the PM: proceed without waiting; artifacts to
.tasks/auth-email-password/; this is the security-critical task of the whole
project — the Phase 3.5 decision decomposition and Phase 3.6 verification gates
(verify fastapi-users' ACTUAL current API against its docs/source, not memory)
matter more than speed. Phase 4 review MUST include the per-amendment
checklist. Return: team + reasoning, artifact paths, open questions with
recommendations. Do NOT start implementation.

Binding carry-forwards from prior grooming reviews:
- Root-file ownership = backend-engineer (0.1 §1.1).
- Per-amendment checklist in implementation reports (0.1 retro, standing rule).
- Committed OpenAPI contract regenerates via `pnpm openapi`; BOTH artifacts
  (apps/api/openapi.json + packages/api-client schema.d.ts) must be committed
  together — auth endpoints WILL change the schema, so drift gates go red until
  regeneration.
- Local Postgres on this machine: 5443 via TEST_DATABASE_URL; committed
  contract/default is 5433.
