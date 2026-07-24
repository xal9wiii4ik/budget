# Code Review: web-auth-flow (roadmap 1.5)

Reviewer: code-reviewer. Scope: full uncommitted diff (all modified + untracked
source; `.tasks/`, `pnpm-lock.yaml`, `PLAN.md` excluded per mandate). Reviewed
against plan-web.md, grooming-review.md §7 (AM-1…AM-8 binding, AM-9 CORS),
coordinator-review-mobile.md (2 platform-free constraints), and the green QA
report (22/0/5-accepted-blocked).

Verification performed, not assumed: ran the 7-test vitest suite (all pass),
`tsc --noEmit` across web + both packages (clean), eslint on the changed TS
surface (clean), the AM-2 grep gate (clean — only comment mentions), confirmed
`schema.d.ts` untouched (absent from `git status`), read openapi-fetch 0.17.0's
shipped `dist/index.mjs` / `index.d.ts` to verify the fetch-seam type, the
204-body handling, and the throw-on-network path, and confirmed the
`safeNextPath` backslash resolution with a live `new URL()` check.

---

## Findings

### 1. MAJOR — `runRefresh` on cross-tab logout (stored === null): spends the revoked token server-side and mislabels the state as "session expired"

**File:** `apps/web/src/auth/coordinator.ts:113-126` (the `stored &&` guard and
the `stored?.refresh_token ?? triggeringRefreshToken` fallback at line 119).

**What's wrong.** The adopt branch only fires when `stored` is non-null with a
*different* refresh token. When another tab **logged out** (revoked the token
server-side, cleared the key), a refresh already queued in this tab reaches the
lock body with `stored === null`, falls through to
`refreshToken = null ?? triggeringRefreshToken`, and:
1. calls `POST /auth/refresh` with a token the user just deliberately revoked
   (guaranteed 401 — a wasted round-trip that shows up server-side as a
   revoked-token reuse attempt), then
2. hits the terminal-failure branch: `sessionExpired = true` → the guard
   redirects to `/login?next=…&reason=expired` → the user who intentionally
   logged out in tab B sees **"Your session expired — please sign in again."**
   in tab A.

Concrete trigger: tab A's access token has expired and a protected call 401s at
roughly the same moment the user clicks Log out in tab B. The storage event has
already set `current = null` in tab A, but `refresh()` captured
`triggeringRefreshToken` before that. Narrow window, but it is exactly the race
the lock + re-read machinery exists to close, and this is the one arm of the
re-read that gets it wrong. `sessionExpired` is documented (coordinator.ts:27-30)
as "TERMINAL refresh failure (not … an intentional logout)" — this path violates
that contract.

**How bad.** No security or data impact (the server correctly rejects the
revoked token); the damage is a misleading banner, a wasted spend of a revoked
token, and a `sessionExpired` flag left `true` until the next in-tab login. It
is a state-correctness defect in the task's design center, and the fix is three
lines.

**Minimal fix.** Treat `stored === null` inside the lock as "logged out
elsewhere": sync the mirror, do NOT flag expiry, do NOT call the server.

```ts
const stored = storage.read();
if (stored === null) {
  // Another tab logged out (or storage was destroyed) while we queued:
  // do not spend the token, do not claim the session "expired".
  current = null;
  notify();
  return false;
}
if (stored.refresh_token !== triggeringRefreshToken) { /* adopt as today */ }
const result = await authRefresh(authClient, stored.refresh_token);
```

This does not disturb TC-11 (QA's tamper keeps the JSON valid, so `stored` stays
non-null and the terminal-failure branch still produces the banner) and does not
disturb the existing vitest terminal-failure test (storage holds `pairA` there).
Add one contrasting vitest case for the null branch (no server call,
`wasSessionExpired() === false`) — a genuinely breakable, currently-uncovered
arm (see finding 4).

### 2. MINOR — stale `sessionExpired` is never reset when tokens arrive via a cross-tab login

**File:** `apps/web/src/auth/coordinator.ts:86-89` (storage subscribe) and the
adopt branch at 113-117.

**What's wrong.** `sessionExpired` is reset only by in-tab `login()` (line 176)
and `logout()` (line 182). Sequence: tab A hits a terminal refresh failure
(`sessionExpired = true`, banner shown) → user signs back in **in tab B** → tab
A adopts the pair via the storage event, but its `sessionExpired` stays `true`.
Any later token-clearing event observed by tab A (e.g. the user logging out in
tab B again) makes tab A's guard append `&reason=expired` and show the expired
banner for what was an intentional logout.

**Why it matters.** Same misleading-banner class as finding 1, reached by a
different path; the flag's lifecycle should be "a live token pair means the
session is not expired".

**Minimal fix.** In the storage-subscribe callback (and it also covers the adopt
branch if placed in one shared spot): `if (current !== null) sessionExpired = false;`
after re-reading. Fold together with finding 1's edit — they are the same
lifecycle hole.

### 3. MINOR — `safeNextPath` open-redirect guard is bypassable with a backslash

**File:** `apps/web/src/auth/next.ts:10`.

**What's wrong.** `?next=/\evil.com` (`%2F%5Cevil.com`) starts with `/`, does
not start with `//`, so it passes — but WHATWG URL resolution treats `\` as `/`
for special schemes: verified `new URL("/\\evil.com", "http://localhost:5173")`
→ `http://evil.com/`. The stated contract ("not `//host`, no scheme") is
therefore not met.

**Why it matters.** In practice react-router v7's `navigate` funnels into
`history.pushState`, whose same-origin check throws `SecurityError` on the
cross-origin resolution — so there is **no actual open redirect** in target
browsers. But the failure mode is still wrong: the throw lands in LoginPage's
`catch` (LoginPage.tsx:41-44), which renders "Can't reach the server…" while the
user is in fact already logged in and left stranded on `/login`. The validator
is the security boundary; it should not depend on `pushState` as the backstop.

**Minimal fix.** `if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return DEFAULT_AUTHED_PATH;`

### 4. MINOR — coordinator suite: two genuinely breakable, uncovered paths (body-preserving retry; refresh rejection propagation)

**File:** `apps/web/src/auth/coordinator.test.ts`.

The 7 existing tests are honest — the adopt case contrasts `calls.refresh === 0`
against the happy path's `1`, the loop guard asserts exactly 2 wire requests,
the exclusion test asserts zero refreshes. No vacuous asserts. But per the
project's rule ("add a test when you need to be 100% sure a non-trivial path
works"), two high-value paths are uncovered:

1. **Body preservation on retry.** Every retry test uses a body-less GET
   (lines 193, 216). The clone-before-send order (AM-7) exists *entirely* so
   that 1.6's POST/PATCH bodies survive the replay — yet no test sends a
   `Request` with a body and asserts the retried request still carries it. A
   refactor that consumes the body before cloning (e.g. `new Request(input, …)`
   inside `withBearer`) would pass this whole suite today and break every
   mutation retry at 1.6. Add one test: POST with a JSON body → 401 → refresh →
   assert `await requests[1].text()` equals the original body.
2. **Refresh rejection propagation.** No test covers `authRefresh` *throwing*
   (network failure): all concurrent joiners must reject, tokens must be
   preserved (no `setTokens(null)`, `wasSessionExpired() === false`), and
   `inFlight` must be cleared so a subsequent `refresh()` starts a new flight.
   The `finally`-clear and the no-catch-swallow are load-bearing (this is the
   senior's lead 2b path) and currently unverified.

Plus the finding-1 null-storage case once that fix lands. These are additions
where a genuinely breakable path is uncovered — not padding.

### 5. MINOR — logout revoke: `net::ERR_ABORTED` explained (cosmetic), but the revoke is lost if the tab closes mid-flight; add `keepalive`

**Files:** `packages/api-client/src/auth.ts:47-51`,
`apps/web/src/auth/coordinator.ts:180-192` (context: `useAuth.ts:61-65`,
`ProtectedLayout.tsx:45`).

**Actual cause of QA's TC-17 observation (traced, not assumed).** The await
ordering is **correct**: `coordinator.logout()` awaits `authLogout` *before*
`setTokens(null)`, the redirect is client-side (no document unload), and the
button disables while pending — so within the SPA lifecycle the revoke cannot be
"lost to navigation". The `ERR_ABORTED` comes from openapi-fetch 0.17.0 itself:
for a 204 it returns **without ever reading or cancelling the response body
stream** (verified in `dist/index.mjs` — the
`if (response.status === 204 || …)` early-return). Chrome later cancels the
unread stream when the `Response` is GC'd and DevTools logs the request as
`net::ERR_ABORTED` even though the 204 was fully received. Cosmetic; the revoke
reached the server (QA saw the 204 recorded).

**The real residual gap.** If the user closes the tab/window right after
clicking Log out, the browser may kill the in-flight `POST /auth/logout` and the
refresh token stays valid server-side for its remaining lifetime.

**Minimal hardening.** Pass `keepalive: true` in the logout call —
openapi-fetch spreads per-call init into the `Request`, so in `auth.ts`:
`client.POST("/auth/logout", { body: { refresh_token: refreshToken }, keepalive: true })`.
`keepalive` is a plain standard `RequestInit` field (no web global — AM-2 safe;
RN ignores it harmlessly). No ordering change needed.

### 6. NIT — protected shell renders nothing for a terminally-errored me-query

**File:** `apps/web/src/routes/ProtectedLayout.tsx:37-41`.

When the me-query errors on a non-401 (API down, refresh network failure per
lead 2b: query retries twice, then errors — tokens preserved, no redirect), the
header renders neither skeleton nor email nor any error/retry affordance
(`me.isPending ? skeleton : me.data ? email : null`). Acceptable for a stub-era
shell (the degradation is otherwise sound: no crash, no bogus redirect, recovery
on next refetch), but 1.6 should give the error state *some* affordance.

### 7. NIT — `FakeLocks.maxConcurrent` is dead test infrastructure

**File:** `apps/web/src/auth/coordinator.test.ts:39-58`. The fake records peak
concurrency but no test ever asserts it. Either assert `maxConcurrent() === 1`
in the single-flight test (it is the one place it adds signal) or delete it.

### 8. NIT — `/login` and `/register` don't redirect already-authenticated visitors

**Files:** `apps/web/src/routes/LoginPage.tsx`, `RegisterPage.tsx`,
`apps/web/src/App.tsx:17-18`. A logged-in user navigating to `/login` sees the
sign-in form (and after finding 3's stranded-state, stays there). Not required
by plan A2; harmless today. Consider a `hasToken → Navigate(next)` fast-path at
1.6 if it starts to bite.

---

## Verified-correct (subtle points the meta-review can rely on)

- **Single-flight lifecycle** (`coordinator.ts:133-141`): creation, joining,
  `finally`-clear, and rejection propagation are all correct. Joiners share one
  promise; `.finally` preserves rejection for every joiner; a rejected flight
  clears `inFlight` so the next call starts fresh; the token-less early return
  resolves `false` without touching state.
- **Lead 2b (network failure during refresh) — acceptable degradation, traced
  end-to-end.** openapi-fetch rethrows fetch errors (verified in `index.mjs`),
  so `authRefresh` rejects → `runRefresh` rejects through the lock →
  `refresh()`/`authFetch` reject with tokens **preserved** and `sessionExpired`
  untouched → queryFn rejects with a non-`ApiError` → the retry predicate
  (`query.ts:50-55`) retries twice → terminal error leaves the user on the
  protected shell (finding 6's blank header), `hasToken()` still true, and the
  next refetch/navigation recovers. Mutations surface the E18 network copy via
  `describeAuthError`'s non-ApiError arm. No bug; only finding 4.2's missing
  test and finding 6's cosmetic gap.
- **AM-7 order** holds: `input.clone()` (coordinator.ts:153) precedes the bearer
  attach; `withBearer` mutates headers in place and never constructs a new
  Request from `input`, so the body stream is undisturbed. Retry-once cap and
  the second-401-returned-as-is loop guard are correct; refresh-failure path
  returns the original 401 and lets the guard react (D13 honored — no
  imperative navigation in the wrapper).
- **Re-read/adopt vs the binding 1.1 design**: in-tab promise ✓, lock ✓,
  re-read-after-acquisition ✓, adopt-without-server-call on a differing stored
  token ✓, storage-event re-hydration + notify ✓. The one wrong arm is
  finding 1's `stored === null`.
- **AM-2/AM-3 gates pass.** Grep over `packages/api-client/src` (generated
  excluded) finds web globals only inside auth.ts's own warning comment.
  `TokenStorage`/`LockManager` and every sync read live only in
  `apps/web/src/auth/`; `TokenPair` is exported as a plain data type (allowed).
- **`client.ts` fetch-seam type** now matches openapi-fetch 0.17.0's own
  declaration exactly (`fetch?: (input: Request) => Promise<Response>`,
  `dist/index.d.ts:8`) — narrower and more honest than the previous
  `typeof fetch`, and it is the seam mobile plugs into at 1.8.
- **`login()` (S3)** sets both the urlencoded `bodySerializer` and the explicit
  Content-Type; `username`/`password`/`scope` match the generated
  `Body_login_auth_login_post` (scope is required-with-default in the generated
  type, so passing `""` is right). QA proved it on the wire (TC-16).
- **`register()`'s privilege fields are justified, not a carry-forward-3
  violation**: generated `UserCreate` marks `is_active`/`is_superuser`/
  `is_verified` as *required* (default-having fields are non-optional in the
  generated type), so the call cannot typecheck without them; values equal the
  server defaults and `safe=True` drops them server-side. The comment says so.
- **`getErrorCode`** narrows exactly per the verified `ErrorModel` union;
  a Pydantic `ValidationError[]` array falls through to `undefined` (array is
  `typeof "object"` but its `.code` is undefined). Raw-code return, app-owned
  copy table in `errors.ts` matching E18 line-for-line, incl. the 429
  status-fallback and the network arm.
- **Shared schemas (AM-1)**: zod-4 `z.email()` top-level validator, `min(1)` vs
  `min(8)` exactly per E16/R3, messages documented as non-contractual defaults
  mirroring the MONEY_ERROR_MESSAGES convention, barrel-exported. No vacuous
  schema tests added (correct per repo rule).
- **Storage impl**: JSON-parse failure and shape-mismatch both degrade to
  `null`; the `storage` event filter accepts the exact key *and* `key === null`
  (localStorage.clear()) — correct.
- **CORS (AM-9)**: explicit origin list from typed settings (env-overridable,
  JSON-array parse documented), `allow_credentials=False` is right for
  bearer-in-header auth, headers/methods minimal-but-sufficient (PATCH/DELETE
  pre-provisioned for 1.6). Ordering is sound: `add_middleware` makes
  CORSMiddleware wrap Starlette's ExceptionMiddleware, so the slowapi 429
  handler's response gets CORS headers (empirically confirmed by QA TC-22
  reading the 429 body from JS). `test_cors.py` asserts both the allowed and
  denied branch against a real route — non-vacuous.
- **Routes/forms**: guard gates on the synchronous snapshot and appends
  `reason=expired` only via `wasSessionExpired()`; `?next=` round-trip is
  URL-carried (survives F5, QA TC-14); AM-8 honored — email prefill travels
  only via router location state, `?email=` never appears; double-submit
  guarded by `disabled={pending}` + RHF `isSubmitting` (QA TC-9); labels
  wired `htmlFor`/`id`, errors `role="alert"`, banners `role="status"`,
  `aria-invalid`/`aria-describedby` present; StrictMode-safe (Set-based
  idempotent subscribe, ref-guarded transition effect, module singletons).
- **`useMe` enabled-race** closed: `enabled` is driven by the
  `useSyncExternalStore` snapshot, and login's `invalidateQueries(['me'])`
  covers the warm path; `useAuthListener` clears the cache only on the
  authenticated→unauthenticated transition.

---

## Verdict: APPROVE-WITH-FIXES

**Required before commit:**
- **Finding 1** (MAJOR) — the `stored === null` arm of `runRefresh`, together
  with **finding 2** (same `sessionExpired` lifecycle hole) and the contrasting
  vitest case.
- **Finding 3** (MINOR, security-boundary hygiene) — one-line backslash reject
  in `safeNextPath`.

**Strongly recommended in the same pass (cheap, high leverage):**
- **Finding 4** — the POST-body retry-preservation test (protects the entire
  AM-7 mechanism before 1.6 builds on it) and the refresh-rejection test.
- **Finding 5** — `keepalive: true` on the logout call.

Findings 6–8 are nits; fold at 1.6 or at leisure. Everything else in the diff —
including the concurrency core's single-flight, adopt, retry, and failure
semantics — is correct as written.
