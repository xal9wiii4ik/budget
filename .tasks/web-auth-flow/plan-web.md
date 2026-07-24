# Implementation Plan (web): web-auth-flow (roadmap 1.5)

## Approach

This task builds the web client's real architecture around one hard requirement:
a **single-use rotating refresh token** (1.1 §7.2). Everything else — routing,
Query setup, forms — is conventional; the refresh coordinator is the design
center and the part that can silently corrupt sessions if built wrong, so most of
this plan is spent there and on the openapi-fetch spike that proves the retry
mechanism.

Two guiding decisions shape the whole design:

1. **Two client instances, not one.** A plain `authClient` (no bearer, no retry)
   for `/auth/login|refresh|logout|register`, and a wrapped `apiClient`
   (bearer + 401→refresh→retry) for everything else. This makes the "auth
   endpoints must never trigger the refresh path" exclusion **structural** rather
   than a fragile path-string match, and removes any refresh-loop risk by
   construction.
2. **The 401-retry lives in a custom `fetch` wrapper passed to
   `createApiClient`, not in openapi-fetch middleware.** The spike (below) proves
   `onResponse` cannot cleanly retry a request with a body — the body stream is
   already consumed by the time `onResponse` runs, so cloning for retry throws.
   The fetch wrapper owns the `Request` *before* the first send, so it can
   `clone()` pre-consumption and replay bodies safely. This matters for 1.6's
   POST/PATCH mutations, not just today's GETs.

Server state (the user object from `GET /users/me`) lives in TanStack Query.
Tokens live in the coordinator module. The route guard gates on **synchronous
token presence** (not the me-query), so navigation never blocks on a round-trip.
Zustand is **not installed** this task — there is no genuine client UI state yet,
and the coordinator already exposes a minimal external-store interface for React.

---

## Spike results (openapi-fetch@0.17.0, source-verified)

Read: `node_modules/.pnpm/openapi-fetch@0.17.0/node_modules/openapi-fetch/dist/index.mjs`.

### S1 — Can `onResponse` re-issue the original request and return a new Response?

**Partially, but not cleanly for bodied requests — rejected as the mechanism.**

- `onResponse` runs at **lines 157–177**. It receives
  `{ request, response, schemaPath, params, options, id }` (line 161). If a
  handler returns a value it **must** be a `Response` (line 170–171) and it
  **replaces** `response` (line 173). So returning a *new* Response is supported.
- `options` (frozen at **lines 91–98**) contains `options.fetch` — the same
  resolved fetch used for the network call at **line 123** — plus `parseAs`,
  serializers, `baseUrl`. So inside `onResponse` we *do* have both the original
  `request` and a fetch to replay it.
- **The blocker:** the network call at line 123 (`await fetch(request, ...)`)
  consumes `request`'s body stream. By the time `onResponse` runs, a retry needs
  either `request.clone()` or `new Request(request, …)` — both throw `TypeError`
  once the body is disturbed. There is **no pre-fetch clone** available to an
  `onResponse` handler. It works for bodyless GETs (today's protected reads) but
  breaks the moment 1.6 adds POST/PATCH. Building the mechanism on a limitation
  we know we'll hit next task is wrong.

### S2 — Chosen mechanism: custom `fetch` wrapper (`coordinator.authFetch`)

- openapi-fetch calls the injected `fetch` at **line 123**:
  `response = await fetch(request, requestInitExt)`. In the browser
  `requestInitExt` is `undefined` (guarded at **lines 2–4, 20** — only Node+undici
  sets it), so the wrapper's signature is plain `(input, init) => Promise<Response>`
  and `input` is a fully-built `Request`.
- The wrapper owns the request **before** the first send, so it can
  `const retry = original.clone()` while the body is still intact, then attach the
  bearer and send. On `401` (non-excluded path) it awaits `coordinator.refresh()`
  (shared single-flight), and on success replays `retry` with the *new* bearer and
  returns that Response — bodies preserved. Retry-**once** only; a second 401 is
  returned as-is (no loop).
- Auth-endpoint exclusion is handled by the two-client design (authClient uses
  plain `fetch`, never this wrapper), with a defensive pathname check in the
  wrapper as belt-and-suspenders.

### S3 — Per-call form-encoded login override (Content-Type + bodySerializer)

Verified sufficient and I will set **both** (matching the 1.1 §7.1 carry-forward
wording and for defensiveness):

- Per-call `bodySerializer` overrides the global/default — destructured with that
  precedence at **line 32** (`bodySerializer = globalBodySerializer ?? defaultBodySerializer`,
  itself taken from `fetchOptions`). `login()` passes
  `bodySerializer: (body) => new URLSearchParams(body).toString()`.
- Per-call `headers: { "Content-Type": "application/x-www-form-urlencoded" }`
  wins the final Content-Type: `finalHeaders` (**lines 59–68**) merges the default
  `application/json` at *lowest* priority, then base/per-call headers via
  `mergeHeaders` `.set()` (last-wins, **lines 502–521**), so our per-call header
  overrides the JSON default.
- Note: `defaultBodySerializer` (**lines 476–487**) already URL-encodes when it
  sees the form Content-Type, so the header alone would suffice — but I set the
  explicit serializer too so the behaviour doesn't depend on that branch. Login
  passes `{ username: email, password }` (email→username mapping) as the body.

---

## Decision points

### A. Routing

**A1 — react-router v7, declarative mode, component-level guard (not loaders).**
Add `react-router` v7 (unified package). Use `<BrowserRouter><Routes>` +
`useNavigate`, **not** `createBrowserRouter` data-router loaders. Reasoning:
our data lives in TanStack Query, not loaders; a loader-based guard would have to
reach into the Query cache / coordinator outside React, duplicating the guard
logic the components already need. A `<RequireAuth>` element that reads the
coordinator's synchronous snapshot is more idiomatic here and co-locates the gate
with the Query hooks that 1.6 will add. (Exact patch pinned at install — no `^`.)

**A2 — Route map:**
| Path | Element | Notes |
|---|---|---|
| `/login` | `LoginPage` (public) | form |
| `/register` | `RegisterPage` (public) | form |
| `/` | `<Navigate to="/transactions">` | index redirect (guard bounces to /login if unauth) |
| `/transactions` | `ProtectedLayout` → `TransactionsStubPage` | protected; stub proving the pattern, 1.6 fills in place |
| `*` | `NotFoundPage` | catch-all |

`ProtectedLayout` is a guard + shell: it gates on token presence, renders the app
header (user email from me-query + logout button) and `<Outlet/>`.

**A3 — Return-to-intended-route via `?next=` search param (not location state).**
State does not survive a full reload, and the session-expiry redirect can happen
after/around a reload; `?next=` is robust across both origins of the redirect
(in-app guard and coordinator-triggered). The guard redirects to
`/login?next=<encoded pathname+search>`; after login we read `next`, **validate
it is a local absolute path** (starts with a single `/`, not `//` — open-redirect
guard), and navigate there, defaulting to `/transactions`.

### B. Query setup

**B4 — QueryClient defaults (explicit):**
- `staleTime: 30_000` — calms refetch storms; the user object barely changes.
  1.6 overrides per-query where it needs fresher data.
- `retry:` predicate that **never retries 4xx**:
  `(count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2`.
  openapi-fetch does not throw on HTTP errors (it returns `{ error, response }`),
  so queryFns run through a `throwOnError` helper that throws an `ApiError`
  carrying `response.status`; the predicate reads that. A 401 that survives to
  Query means refresh already failed — retrying is pointless.
- `refetchOnWindowFocus: false` — personal app, no surprise refetches; explicit,
  1.6 can opt in per-query.

**B5 — User object in TanStack Query; Zustand NOT installed.**
`useMe()` = `queryKey: ['me']`, queryFn `apiClient.GET('/users/me')` through
`throwOnError`, `enabled: coordinator.hasToken()` (don't fire when logged out).
Tokens are client state owned by the coordinator module. There is no other
genuine client state this task, so **do not add Zustand** — an unused state
manager is exactly the "don't add what you don't use" trap. The coordinator
exposes `subscribe`/`getSnapshot` for `useSyncExternalStore`, so React reactivity
is covered without a store. Revisit at 1.6+ when real UI prefs (persisted
filters, theme) appear.

**B6 — Guard gate = synchronous token presence via `useSyncExternalStore`.**
`isAuthenticated = coordinator.hasToken()` (an access **or** refresh token is
present). Reasoning: gating on the me-query would flash a loading state on every
navigation; token presence is the cheap gate.
- **While me-query is in flight:** the protected shell renders with a header
  skeleton (email placeholder) — no full-page block.
- **me-query 401 → refresh recovers:** the fetch wrapper retries transparently;
  the query resolves 200; no user-visible effect.
- **me-query 401 → refresh fails:** the wrapper's `refresh()` cleared the token
  pair and notified subscribers → `hasToken()` flips false → the guard re-renders
  and `<Navigate to="/login?next=…&reason=expired">`. A stale-token visit thus
  shows a brief shell skeleton then redirects — acceptable.

### C. api-client wiring

**C7 — `VITE_API_URL`; singleton clients in `apps/web/src/lib/api.ts`.**
`.env.example` (committed) sets `VITE_API_URL=http://localhost:8010`; typed via
`apps/web/src/env.d.ts` (`ImportMetaEnv`). Both client singletons and the
coordinator are created once in `src/lib/api.ts`. A runtime guard throws a clear
error if `VITE_API_URL` is unset at build. **Root files:** `.gitignore` already
covers `apps/web/.env` (root globs `.env`, `.env.*`, `!.env.example` — verified
lines 16–18), so **no .gitignore request**. `turbo.json` has **no web `build`
task**, so no env declaration is needed today; **conditional heads-up** (not an
action): if a cached web build task is ever added, `VITE_API_URL` must be
declared in that task's `env` for correct cache keys — root-owned, would be a
REQUEST then.

**C8 — Auth helpers hand-written in `packages/api-client/src/auth.ts`.**
`login()` (form-encoded, email→username, per S3) is decided by 1.1 §7.1 to live
here, not in generated code. **Decision: `refresh()`, `logout()`, `register()`
sit alongside it** — thin typed wrappers over a passed `ApiClient`, client-
agnostic, so mobile reuses them at 1.8. `schema.d.ts` stays byte-identical;
these are new hand-written files, exported from `src/index.ts`.

**C9 — `getErrorCode` in `packages/api-client` (new this task).**
`getErrorCode(error: unknown): string | undefined`. Single-branch narrow on the
`ErrorModel.detail` union (`string | { [k]: string }`, schema lines 356–362):
- `detail` is a **string** → return it (the stable code:
  `LOGIN_BAD_CREDENTIALS`, `REGISTER_USER_ALREADY_EXISTS`, `RATE_LIMITED`).
- `detail` is an **object** → the only such case in these flows is
  `REGISTER_INVALID_PASSWORD` (`{code, reason}`); return `detail.code` if it's a
  string, else `undefined`.
- Anything else → `undefined`.
It returns the raw code string only — the app owns the code→copy table (E18), so
1.6 extends the map without restructuring `getErrorCode`. Lives in api-client
because it narrows generated types and mobile reuses it at 1.8.

### D. Refresh coordinator (`apps/web/src/auth/`)

**D10 — Module shape and public API.** `coordinator.ts` with two injectable
seams (needed for vitest — see F20 — and so mobile can port at 1.8 without a
cross-platform abstraction layer welded through the core):
- `TokenStorage` seam: `read(): TokenPair | null`, `write(pair)`, `clear()`,
  `subscribe(cb)` (wraps the `storage` event). Prod impl = single localStorage
  key `budget.auth` holding `{access, refresh}` JSON — the single source of truth.
- `LockManager` seam: `runExclusive(name, fn)`. Prod impl = `navigator.locks`;
  fallback impl runs `fn` directly (see D12).

Public API:
- `getAccessToken(): string | null`
- `hasToken(): boolean`, `getSnapshot()`, `subscribe(cb)` — for `useSyncExternalStore`
- `authFetch(input, init): Promise<Response>` — the wrapper passed to `apiClient`
- `login(email, password): Promise<LoginResult>` — calls authClient login, stores pair
- `logout(): Promise<void>` — revoke + clear + notify
- `refresh(): Promise<boolean>` — single-flight; used by `authFetch` on 401

In-memory snapshot is the source React reads; the storage `subscribe` re-reads on
cross-tab changes and re-notifies.

**D11 — 401→refresh→retry mechanism (per S2), with single-flight.**
`authFetch`:
```
const excluded = isAuthPath(url);              // belt-and-suspenders; authClient already bypasses
const retry = original.clone();                // pre-send clone; bodies preserved
let res = await realFetch(withBearer(original, getAccessToken()));
if (res.status === 401 && !excluded) {
  const ok = await refresh();                  // shared single-flight (below)
  if (ok) res = await realFetch(withBearer(retry, getAccessToken()));  // retry ONCE
  // if !ok: refresh() has already cleared+notified → guard redirects; return the 401
}
return res;
```
`refresh()` single-flight: a module-level `inFlight: Promise<boolean> | null`.
Concurrent 401s from parallel queries all `await` the same promise → **exactly one**
refresh flight. Cleared in `finally`.

**D12 — `navigator.locks`: exclusive mode, re-read after acquisition.**
Inside `refresh()`, after the in-tab dedup, the body runs under
`lockManager.runExclusive('budget-auth-refresh', …)` (prod: `navigator.locks.request(name, {mode:'exclusive'}, cb)`).
**First step inside the lock: RE-READ storage.** Another tab may have already
rotated while we queued; the single-use refresh token makes a double-spend a hard
401. So:
- If storage's refresh token **differs** from the one that triggered us → another
  tab already rotated → **adopt the stored pair, return true without calling the
  server.**
- Else call `authClient.refresh(refreshToken)`; on 200 `write` the new pair
  (fires a `storage` event → other tabs adopt it); on failure `clear` + return false.

`navigator.locks` baseline: present in all target browsers (Chrome 69+, Firefox
96+, Safari 15.4+). **Fallback** (absent, e.g. jsdom/Node, ancient browsers): the
`LockManager` fallback impl runs `fn` directly; the in-tab `inFlight` promise
still dedups within a tab, and a cross-tab double-spend is recovered by the
re-read/adopt on the losing tab's next 401. No hard failure.

**D13 — Refresh failure mid-session: near-silent redirect, navigation stays in
React.** On terminal refresh failure `refresh()` clears storage + notifies
subscribers → `hasToken()` flips false → the guard (subscribed) redirects to
`/login?next=<current>&reason=expired`. The fetch wrapper does **not** imperative-
navigate from outside React — it only clears/notifies; the React guard reacts.
UX: `/login` shows a subtle info banner ("Your session expired — please sign in
again") when `reason=expired`, otherwise nothing. This keeps the surprise
redirect explainable without a scary modal.

**D14 — Logout: revoke + clear + cross-tab.** Contract (schema lines 667–696):
`POST /auth/logout` takes `LogoutRequest {refresh_token}` in the body, returns
`204`, **no bearer/401 declared** → no auth header needed. `logout()` sends the
current refresh token to revoke server-side (via authClient), then `clear()`s
storage. Clearing fires a `storage` event → other tabs' listeners see the key
removed → their snapshot flips → they redirect to `/login`. **Decision: multi-tab
logout is IN scope** — it's free once the storage listener exists for pair
propagation; only the clicking tab calls the server revoke (others just observe
cleared storage, no redundant revoke).

**D15 — Reactive-only refresh (accept senior's lean).** No `exp`-decode timer, no
proactive refresh. Reasoning: simpler, no clock-skew handling, no timer lifecycle
across tabs; the 401→refresh→retry path already recovers transparently. Cost: the
first request after access-token expiry eats one extra round-trip (401→refresh→
retry-200). Acceptable for a personal app.

### E. Forms

**E16 — Shared zod schemas (add to `packages/shared/src/schemas.ts`).** None exist
today (only currency/money). Add and export from the barrel, so mobile reuses at
1.8:
- `emailSchema` — valid email (zod 4 API; implementer confirms `z.email()` vs
  `z.string().email()` against 4.4.3).
- `registerFormSchema` — `{ email: emailSchema, password: z.string().min(8) }`.
  `min(8)` aligns **exactly** with server `validate_password` (len ≥ 8, nothing
  fancier — written accept, 1.1 R3). Email+password only (ignore stock privilege
  fields — carry-forward 3).
- `loginFormSchema` — `{ email: emailSchema, password: z.string().min(1) }`.
  Login requires non-empty, **not** min-8 — we don't re-run registration policy at
  login.

**E17 — Register auto-chains into login (senior's lean).** `register` returns
`UserRead`, no tokens (schema lines 731–751). On `201`, immediately call
`coordinator.login(email, password)` → success → navigate to `next`/`/transactions`.
**Partial-failure** (register `201` but the login leg fails — e.g. transient or
`429`): the account exists, so do **not** re-register; navigate to `/login` with
the email prefilled and an info banner "Account created — please sign in." A `429`
on the login leg maps to the rate-limit copy.

**E18 — Error mapping (code → copy, field vs form level).** Driven by
`getErrorCode(error)` → app-owned table in `apps/web/src/auth/errors.ts`:
| Code / condition | Source | Level | Copy |
|---|---|---|---|
| `LOGIN_BAD_CREDENTIALS` | login 400, `detail` string (undeclared in contract — see Risks) | form | "Incorrect email or password." |
| `REGISTER_USER_ALREADY_EXISTS` | register 400, `detail` string | field: email | "An account with this email already exists." (+ link to login) |
| `REGISTER_INVALID_PASSWORD` | register 400, `detail` object `{code,reason}` | field: password | "Password must be at least 8 characters." (client copy, not server reason) |
| `RATE_LIMITED` | 429, `detail` string | form | "Too many attempts. Please wait a minute and try again." |
| network failure (fetch throws, no response) | — | form | "Can't reach the server. Check your connection and try again." |
| anything else (5xx / unknown) | — | form | "Something went wrong. Please try again." |

Client zod already enforces email shape + min-8 before submit; the server codes
are backstops. Bad-credentials stays deliberately non-specific (don't reveal which
field).

**E19 — Plain CSS Modules, minimal.** No new UI/CSS library (would need senior
approval). Vite supports CSS Modules out of the box, zero deps. A centered auth
card (`AuthLayout.module.css`), field/label/button/error styles. Semantic HTML:
`<form>`, `<label htmlFor>`, `<input>`, `<button type="submit">`. This task's value
is architecture, not pixels — styling stays deliberately thin.

### F. Testing (honest split)

**F20 — vitest, `node` env, injected fakes.** `navigator.locks` does **not** exist
in Node or jsdom (the Web Locks API is unimplemented by jsdom) — which is exactly
why the coordinator takes injectable `TokenStorage` + `LockManager` seams. Unit
tests inject a fake in-memory `TokenStorage` (with a manual "storage event"
trigger) and a fake `LockManager` (runs `fn`, records concurrency). No jsdom
needed; vitest stays on the `node` environment. Tests that earn their place
(non-vacuous, per repo test rules):
- **Single-flight:** N concurrent `refresh()` (or N parallel `authFetch` 401s) →
  exactly **one** `authClient.refresh` call; all resolve true; new pair stored.
- **Re-read/adopt (double-spend guard):** fake storage mutated to a *different*
  refresh token before the lock body runs → coordinator adopts the stored pair and
  does **not** call the server — contrasted against the happy path where the server
  **is** called (so the branch is genuinely exercised, not re-asserting the
  happy-path value).
- **Refresh failure:** `authClient.refresh` → 401 → coordinator clears storage,
  flips snapshot, notifies, returns false.
- **authFetch retry-once:** mocked fetch returns 401 then 200 → asserts refresh
  ran once and the original request replayed with the new bearer; a second 401
  after refresh returns the 401 with **no** further retry (loop guard). Auth-path
  exclusion asserted (authClient path never triggers refresh).
- **zod schemas:** none — `email` + `min(8)` are near-trivial; a test would just
  re-assert zod. Skipped per repo rule against vacuous tests.

**F21 — Browser-only (hand to web-qa for their checklist):**
- Real `navigator.locks` cross-tab serialization (two real tabs, one refresh).
- Cross-tab `storage`-event propagation: login in tab A reflected in tab B;
  logout in A logs out B.
- Real single-use rotation against the **live** API (double-spend → 401 → adopt
  recovery).
- Full journeys: register → auto-login → protected → access-token expiry → silent
  refresh → logout.
- `?next=` return-to-intended-route surviving a **real reload**.
- Live server accepts the form-encoded login (200, not 422) — proves S3 end-to-end.
- Focus management / a11y of both forms in a real browser (labels, tab order,
  submit-on-enter, error announcement).

---

## Screens / components affected
- `apps/web/src/App.tsx` — replace the formatMoney demo with `<BrowserRouter>` +
  route map (A2).
- `apps/web/src/main.tsx` — wrap in `<QueryClientProvider>`.

## New components / hooks
- `apps/web/src/lib/api.ts` — `authClient` (plain) + `apiClient`
  (`fetch: coordinator.authFetch`) singletons; wired after the coordinator.
- `apps/web/src/lib/query.ts` — `queryClient` (B4 defaults), `ApiError`,
  `throwOnError` helper.
- `apps/web/src/auth/coordinator.ts` (+ `storage.ts`, `locks.ts` seam impls) —
  the refresh coordinator (D10–D15).
- `apps/web/src/auth/coordinator.test.ts` — F20.
- `apps/web/src/auth/useAuth.ts` — `useSyncExternalStore` snapshot + login/
  logout/register action wrappers (as `useMutation`s for pending/error state).
- `apps/web/src/auth/useMe.ts` — the `['me']` query (B5).
- `apps/web/src/auth/useAuthListener.ts` — on logout transition,
  `queryClient.clear()`.
- `apps/web/src/auth/errors.ts` — code→copy table over `getErrorCode` (E18).
- `apps/web/src/auth/AuthLayout.tsx` (+ `.module.css`) — E19.
- `apps/web/src/routes/LoginPage.tsx`, `RegisterPage.tsx`, `ProtectedLayout.tsx`
  (guard + shell), `TransactionsStubPage.tsx`, `NotFoundPage.tsx`, `router.tsx`.
- `apps/web/src/env.d.ts` — `ImportMetaEnv.VITE_API_URL`.

## Data layer
- `GET /users/me` → `queryKey ['me']`, `enabled: hasToken()`, default 30s stale.
- login/register/logout are imperative coordinator calls wrapped in `useMutation`
  for pending/error ergonomics.
- Invalidation: on login success → `invalidateQueries(['me'])`; on logout →
  `queryClient.clear()`. No optimistic updates (auth is not cache data).

## UI states (per screen)
- **Login:** idle → submitting (button disabled + spinner) → field errors (zod,
  inline) / form-level error (bad creds, rate-limit, network) → success redirect.
  `reason=expired` shows an info banner.
- **Register:** as login + a password hint ("at least 8 characters"); success →
  auto-login → redirect, or partial-failure → `/login` prefilled + banner.
- **ProtectedLayout:** me-query loading → header email skeleton (content still
  renders); terminal 401 → guard redirect (no error UI needed); success → email
  shown.
- **TransactionsStub:** empty state that says what's next — "Transactions land
  here in the next release" (a real empty state, not "no data").
- **NotFound:** message + link back to `/`.

## Files touched
**apps/web (new + modified):** `package.json` (deps), `src/main.tsx`, `src/App.tsx`,
`src/lib/api.ts`, `src/lib/query.ts`, `src/auth/*` (coordinator + seams + hooks +
errors + layout + test), `src/routes/*`, `src/env.d.ts`, `.env.example`. No
changes to `vite.config.ts` (test env stays `node`), `tsconfig.json`, or local
eslint (uses root flat config).

**packages/api-client (new + modified):** `src/auth.ts` (login/refresh/logout/
register + `getErrorCode`, hand-written), `src/index.ts` (export them + `TokenPair`,
`UserRead`, `ErrorModel` types). **`src/generated/schema.d.ts` UNTOUCHED —
byte-identical.** No new dependency (openapi-fetch already present).

**packages/shared (modified):** `src/schemas.ts` (email/login/register schemas),
`src/index.ts` (export them).

**REQUESTED root changes:** **none required now.**
- `.gitignore` — already covers `apps/web/.env` (root globs, verified). No request.
- `turbo.json` — no web build task exists; no env declaration needed today.
  Conditional heads-up only: a future cached web build task must declare
  `VITE_API_URL` in its `env` (root-owned → REQUEST then).
- `eslint.config.mjs` — root-owned; existing `apps/web/src/main.tsx` already uses
  a browser global (`document`) and lints clean, so `no-undef` is not a problem
  for the coordinator's browser APIs (localStorage, navigator, window,
  addEventListener, URLSearchParams, Request/Response/Headers). **Verify at
  implement**; only if the broader surface trips `no-undef` would adding
  `globals.browser` to the apps/web block become a REQUEST (low probability).

## Open questions
1. **Exact version pins.** react-router v7, @tanstack/react-query v5,
   react-hook-form v7, @hookform/resolvers v5 — I can't hit the registry from
   here; the implementer pins exact latest-stable patches (no `^`) at install and
   senior-lead confirms. `@hookform/resolvers` v5 must support the installed zod
   4.4.3 — verify at install.
2. **`reason=expired` banner copy / whether to show it at all** — PM-facing UX
   nicety; recommendation: show the subtle banner. Non-blocking.

## Risks
- **Body-consumption on retry** — the entire reason for the fetch-wrapper
  mechanism (S1/S2). Mitigated by cloning *before* the first send; covered by the
  authFetch retry test. If openapi-fetch is bumped off 0.17.0, re-verify line 123
  still hands the wrapper a `Request`.
- **Refresh loop** — mitigated structurally by the two-client design + the
  wrapper's path exclusion + retry-once cap.
- **Single-use refresh double-spend across tabs** — mitigated by `navigator.locks`
  + re-read/adopt; residual risk only where locks are absent, recovered by
  re-read on the loser's next 401.
- **React StrictMode double-invoke (dev)** — subscribe/unsubscribe and the
  module-level `inFlight` must be idempotent under double-mount; account for it in
  the hooks.
- **me-query `enabled` race** — the query must re-enable when a token appears
  after login (snapshot drives `enabled`).
- **`LOGIN_BAD_CREDENTIALS` / refresh-failure statuses are undeclared in the
  contract** (login declares only 200/422/429; refresh only 200/422). The wire
  still returns them; `getErrorCode` reads the runtime body regardless of the
  typed response, and the coordinator treats any non-200 refresh as failure — do
  not rely on the generated response types for these error paths.
- **localStorage token exposure (XSS)** — an accepted, recorded architecture
  tradeoff (localStorage chosen for the JWT pair); rotation limits blast radius.
  Flagged, not silently inherited.
- **`VITE_API_URL` unset at build** — runtime guard throws a clear message;
  `.env.example` documents it.
