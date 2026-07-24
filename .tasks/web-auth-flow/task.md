# Task: web-auth-flow (roadmap 1.5)

Verbatim PM description:

The web client's auth flow — first real frontend feature work. State: HEAD d9e39f1 —
apps/web is still the 0.1 scaffold (App.tsx renders formatMoney demo); packages/api-client
has createApiClient + generated types for ALL server endpoints (auth, categories,
transactions); TanStack Query + Zustand named in architecture but NOT YET INSTALLED —
this task introduces the web app's real architecture.

Scope per roadmap 1.5 and architecture:
- App shell: React Router (routes: /login, /register, + protected layout for future
  /transactions etc.), TanStack Query setup (QueryClient config — decide staleTime/retry
  defaults), the api-client instance wiring (baseUrl from env — decide VITE_API_URL
  convention + .env.example for web; NOTE root-file/env ownership — web's own .env.example
  is fine, decide)
- Login/register forms: react-hook-form + zod (shared package's zod primitives), the 1.1
  obligations implemented: form-encoded login (bodySerializer + Content-Type), error
  mapping (LOGIN_BAD_CREDENTIALS etc. via the detail envelope), min password 8 aligned
  with server validate_password
- Token storage + refresh coordinator: THE design center of this task. localStorage vs
  memory+refresh-cookie is settled (architecture: JWT pair, localStorage implied by the
  1.1 review's coordinator design). Implement the coordinator per the recorded design:
  in-tab shared refresh promise, navigator.locks for cross-tab, re-read localStorage
  after lock acquisition; 401-triggered silent refresh via openapi-fetch middleware;
  logout (revoke + clear + redirect); decide what happens on refresh failure mid-session
  (redirect to /login preserving intended route?)
- Protected route pattern: redirect to /login when tokens absent/dead;
  return-to-intended-route after login
- Auth state: decide Zustand vs TanStack Query for the user object (GET /users/me) —
  architecture names both tools; pick the boundary (PM hint: user object is server
  state → Query; auth tokens are client state — the coordinator module owns them)
- UI states per frontend-engineer's own agent conventions: loading/error states on forms,
  disabled submit while pending
- Testing: vitest for the coordinator logic (mutex/lock behavior — how testable is
  navigator.locks in jsdom/node? decide the test strategy honestly: what's unit-testable
  vs what goes to web-qa's browser checks); web-qa checklist for the journeys
  (register→login→protected→refresh→logout) — WEB-QA joins the team for the first time
- NO transactions/categories UI — that's 1.6. The protected area can be a stub page
  proving the pattern.

Team: frontend-engineer (implements), web-qa (journey checklist + browser execution —
FIRST invocation), backend-engineer NOT needed (no API changes — assert),
mobile-engineer optional narrow review of the coordinator design (mobile needs the same
pattern on expo-secure-store at 1.8). Architect: senior-lead's call.

Process: artifacts to .tasks/web-auth-flow/; Phase 4 with per-amendment checklist.
Vite dev server + api on 8010, PG 5443 — foreign stuff untouched. Standing rules:
root-file ownership = backend (frontend must REQUEST root changes); per-amendment
checklist; full lint gate on every fix round; contract artifacts untouched (no API
changes expected — asserted).

Durable carry-forwards binding on this task (from .tasks/auth-email-password/
grooming-review.md §7, "1.5 (web auth flow)"):
1. /auth/login needs BOTH a urlencoded bodySerializer AND an explicit
   Content-Type: application/x-www-form-urlencoded header — openapi-fetch 0.17.0
   hard-defaults JSON Content-Type and the call 422s without the override. Wrap once
   in an api-client login() helper (maps email→username).
2. Refresh coordinator: in-tab shared in-flight promise + navigator.locks cross-tab
   serialization + localStorage as single token source RE-READ after lock acquisition;
   propagate new pairs via storage events. Single-use rotating refresh makes this
   mandatory.
3. One error envelope: detail everywhere incl. 429 RATE_LIMITED — client error helper
   is single-branch. Register-input schema carries ignored optional privilege fields
   (stock BaseUserCreate) — use email+password only.

Senior-lead verification at grooming start (Phase 3.6, done before team launch):
- HEAD d9e39f1, clean working tree.
- packages/api-client/src/generated/schema.d.ts covers /auth/login (form-urlencoded
  body Body_login_auth_login_post), /auth/refresh, /auth/logout, /auth/register,
  /auth/forgot-password, /auth/reset-password, /users/me. NO contract change is
  needed or permitted: schema.d.ts must remain byte-identical at the end of this task.
- apps/web/package.json currently lacks @budget/api-client, react-router, TanStack
  Query — all to be added (exact-pin convention).
