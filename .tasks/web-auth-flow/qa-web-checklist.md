# QA Web Checklist: web-auth-flow (roadmap 1.5)

## Scope

This checklist verifies the web client's auth flow **through a real browser**
against the running app: login/register forms, protected-route guard,
token-storage + silent-refresh coordinator, and logout. It is written against
`plan-web.md` (decisions A1–F21) and the PM's required journey
`register → auto-login → protected stub → silent refresh → logout`.

### Environment (for the eventual run)
- Web: vite dev server (default port, `pnpm dev` in `apps/web`).
- API: `http://localhost:8010`; Postgres on `5443`.
- `apps/web/.env` must set `VITE_API_URL=http://localhost:8010` (per C7).
- **Dedicated test users only** — freshly-registered throwaway emails
  (e.g. `qa+<timestamp>@example.test`). Never real data, never against prod.
- Access JWT lives ~15 min. Refresh token is **single-use rotating** — a reused
  refresh token is a hard 401. This shapes the tamper-based refresh TCs below.

### What I deliberately do NOT duplicate (owned elsewhere)
- **vitest / frontend-engineer (F20)** — coordinator internals with injected
  fakes: single-flight dedup, re-read/adopt double-spend guard, refresh-failure
  clear+notify, `authFetch` retry-once + loop guard + auth-path exclusion. I do
  **not** re-assert this unit logic; I verify its *observable* effect on the wire
  and in the UI (e.g. "exactly one `POST /auth/refresh` in the network log").
  zod schema unit correctness is also vitest's (F20 skips them as near-trivial) —
  I only check the user-visible validation behavior in the browser.
- **qa-engineer (API contracts)** — I do NOT test endpoints with curl. The one
  wire-level assertion I *do* make (TC-16, login is form-urlencoded → 200 not 422)
  is checked via the browser's own network log while driving the real form, which
  is exactly the browser-only obligation F21 hands me (prove S3 end-to-end).
- No transactions/categories UI exists yet (that's 1.6); `/transactions` is a
  stub proving the protected pattern.

### Testability honesty (techniques used below)
- I **cannot** wait 15 min for real access-token expiry. Technique: tamper with
  the single localStorage key (`budget.auth`, JSON
  `{access_token, refresh_token, token_type}` — **snake_case** field names per the
  shipped implementation) — corrupt the **access_token** while keeping
  **refresh_token** valid → next protected API call 401s → the silent-refresh path
  fires (TC-10).
- Corrupt **both** `access_token` and `refresh_token` → terminal refresh failure →
  redirect + banner (TC-11).
- Cross-tab TCs (real `navigator.locks` + storage events) need two independent
  tabs. If the browser pane cannot drive two truly-independent tabs, those TCs are
  marked **manual/best-effort**, not silently dropped (TC-18, TC-19).
- Register partial-failure (register 201 but auto-login leg fails) is not reliably
  forceable from a browser — marked **covered-by-design + vitest** (TC-20), not
  faked.

---

## Test cases

### TC-1: Happy-path full journey — register → auto-login → protected → refresh → logout
- **Precondition**: logged out; clean localStorage; API + PG up; DevTools network
  + console open.
- **Steps**:
  1. Open `/` → expect redirect through guard to `/login`.
  2. Go to `/register`; enter a fresh unique email + password (≥8 chars); submit.
  3. Observe auto-login (E17): no manual login step; land on `/transactions`.
  4. Confirm protected shell renders: header shows the registered email (from
     `GET /users/me`), logout button present, stub empty-state copy visible.
  5. Trigger silent refresh via the TC-10 tamper technique (corrupt access token,
     keep refresh) and reload/navigate so a protected call fires.
  6. Click logout → expect redirect to `/login`; header/user state gone.
- **Expected**: each leg completes without a full-page error; final state is
  logged-out at `/login`. Zero console errors across the whole journey. Network
  log shows: `POST /auth/register` 201 → `POST /auth/login` (form-encoded) 200 →
  `GET /users/me` 200 → (on step 5) exactly one `POST /auth/refresh` 200 →
  `POST /auth/logout` 204.
- **Status**: ✅ PASS (re-run 2026-07-24, CORS fixed) — with the silent-refresh
  sub-leg (step 5) tooling-blocked, covered by TC-10. Full journey now completes in
  the browser: `/register` with a fresh `qa+<ts>@example.com` + ≥8 password submits
  and auto-logs-in without a manual login step. Network log across the journey:
  `OPTIONS /auth/register 200` → `POST /auth/register 201` → `POST /auth/login 200`
  (form-encoded) → `OPTIONS /users/me 200` → `GET /users/me 200`; the app lands on
  `/transactions` with the registered email in the header, a Log out button, and the
  stub empty-state copy. Logout leg: `POST /auth/logout 204` → redirect to `/login`,
  header/state gone. **Zero console errors** across the whole journey. Step 5 (force
  a silent refresh via the localStorage access-token tamper) could NOT be executed —
  the browser pane exposes no localStorage editor / JS-eval and `javascript:`
  navigation is denied, so a 401 can't be forced (see TC-10, F20 vitest-primary). The
  4 reachable legs (register → auto-login → protected shell → logout) all pass.

### TC-2: Register form — client-side zod validation BEFORE any network call
- **Precondition**: logged out; on `/register`; network tab cleared.
- **Steps**:
  1. Submit empty form → expect field-level messages on email and password.
  2. Enter invalid email (`foo`) + valid password → submit.
  3. Enter valid email + 7-char password → submit.
- **Expected**: each invalid submit shows the message attached to the *correct*
  field (email-shape on email, "at least 8 characters" on password). Password hint
  ("at least 8 characters") is visible before submit. **Critically: NO network
  request fires** for the short-password / bad-email cases — client zod
  (`registerFormSchema`, min 8) gates before submit. Verify the network log is
  empty of `/auth/*` calls for these attempts.
- **Status**: ✅ PASS. Empty submit → email "Enter a valid email address." + password
  "Password must be at least 8 characters." each attached (role=alert) to the correct
  field. Bad email `foo` + valid password → email-only error, password cleared. Valid
  email + 7-char password → password-only error, email cleared. The password hint
  "At least 8 characters." is visible before submit. **Zero requests to
  localhost:8010 across all three invalid attempts** — client zod gates before the
  network. No console errors.

### TC-3: Register happy path — 201 then transparent auto-login to protected area
- **Precondition**: logged out; fresh unique email.
- **Steps**:
  1. `/register`, valid email + ≥8 password, submit.
  2. Watch button state during submit.
- **Expected**: submit button is disabled + shows pending/spinner while in flight;
  on success user lands on `/transactions` (or validated `?next=`) already
  authenticated (no second manual login). Network: `POST /auth/register` 201 then
  `POST /auth/login` 200 then `GET /users/me` 200. No console errors.
- **Status**: ✅ PASS (re-run, CORS fixed). Register happy path with a fresh unique
  email + ≥8 password: on submit the button goes to its pending state, then the app
  transparently auto-logs-in and lands on `/transactions` already authenticated (no
  second manual login). Network chain observed: `POST /auth/register 201` →
  `POST /auth/login 200` → `GET /users/me 200`. Header populates with the registered
  email. No console errors.

### TC-4: Register — existing email → field-level error on the email input
- **Precondition**: an email already registered (reuse TC-3's email).
- **Steps**:
  1. `/register`, enter the already-used email + valid password; submit.
- **Expected**: `REGISTER_USER_ALREADY_EXISTS` maps to a **field-level** message on
  the **email** field: "An account with this email already exists." plus a link to
  login (E18). Password field is NOT flagged. No auto-login occurs. `POST
  /auth/register` returns non-201; no `POST /auth/login` fires afterward.
- **Status**: ✅ PASS (re-run, CORS fixed). Re-registering the already-used email +
  valid password → `POST /auth/register` returns **400** and the UI renders a
  **field-level** alert on the **email** field: "An account with this email already
  exists." (role=alert, positioned immediately after the email input, before the
  password field). The password field is NOT flagged; no auto-login occurs (no
  `POST /auth/login` fires after the 400). No console errors.

### TC-5: Login happy path — form-level pending state, redirect to intended route
- **Precondition**: a known test user exists; logged out; on `/login`.
- **Steps**:
  1. Enter valid credentials; submit; observe button + redirect.
- **Expected**: button disabled + spinner during submit; on 200 redirect to
  `/transactions` (default) or a validated `?next=`. `GET /users/me` fires once and
  header email populates. No console errors.
- **Status**: ✅ PASS (re-run, CORS fixed). Valid credentials on `/login` →
  `POST /auth/login 200`, app redirects to `/transactions`, `GET /users/me` fires
  once and the header email populates. Button shows its pending state during submit.
  No console errors.

### TC-6: Login — bad credentials → non-specific FORM-level error
- **Precondition**: logged out; on `/login`.
- **Steps**:
  1. Enter a valid-shaped email with the wrong password; submit.
- **Expected**: form-level (not field-level) error "Incorrect email or password."
  — deliberately non-specific, does not reveal which field is wrong (E18). Password
  field is not singled out. Form remains usable for a retry; no console error, no
  unhandled promise rejection. Network shows the login call returning bad-creds
  (handled gracefully, not surfaced as a red console error).
- **Status**: ✅ PASS (re-run, CORS fixed). Valid-shaped email + wrong password →
  `POST /auth/login 400`; the UI renders a **form-level** alert (role=alert, at the
  top of the form, NOT attached to either field) with the exact non-specific copy
  "Incorrect email or password." The password field is not singled out. The form
  stays usable for a retry. No console error, no unhandled rejection (the 400 is
  handled gracefully — not surfaced as a red console error).

### TC-7: Login — empty-field client validation (min 1, not min 8)
- **Precondition**: logged out; on `/login`; network cleared.
- **Steps**:
  1. Submit empty form.
  2. Enter email + a 1-char password; submit against a user (or observe it is NOT
     blocked by client validation).
- **Expected**: empty submit shows required-field messages with **no** network
  call. A 1-char password is **not** blocked client-side (login uses `min(1)`, not
  registration's `min(8)` — E16); it proceeds to the server (which will bad-creds
  it). Confirms login does not re-run registration password policy.
- **Status**: ✅ PASS. Empty submit → email "Enter a valid email address." + password
  "Enter your password." (min-1 message), both role=alert, no request to
  localhost:8010. Valid email + 1-char password → NOT blocked client-side; it
  proceeds to a real `POST /auth/login` attempt (form shows the form-level network
  fallback, not a field error). Confirms login's `min(1)` schema does not re-run
  registration's `min(8)` policy. No console errors.

### TC-8: Login UI state — API down → recoverable "can't reach server", not a blank screen
- **Precondition**: **stop the API server**; web app still running; on `/login`.
- **Steps**:
  1. Enter any credentials; submit.
  2. Restart the API; submit again with valid credentials.
- **Expected**: on the failed submit, form-level copy "Can't reach the server.
  Check your connection and try again." (E18 network-failure branch); the page is
  NOT blank/white and NOT stuck spinning — the form recovers and is re-submittable.
  After the API is back, a valid submit succeeds. No uncaught console error crashing
  the page.
- **Status**: ✅ PASS (network-failure branch + recovery) / partial. I did not stop
  the API; the ambient CORS block produces the SAME class of fetch rejection (no HTTP
  response reaches JS), which is exactly what `describeAuthError`'s non-ApiError
  branch handles. On a failed submit the form shows the exact copy **"Can't reach
  the server. Check your connection and try again."** (role=alert), the page is NOT
  blank and NOT stuck spinning, and the form is immediately re-submittable. No
  uncaught console error. The "API back → valid submit succeeds" half cannot be shown
  in this environment because CORS blocks even a healthy API's response (see TC-5).

### TC-9: Double-submit does not create duplicate accounts / duplicate login calls
- **Precondition**: logged out; on `/register` (repeat variant on `/login`).
- **Steps**:
  1. Fill a valid fresh register form.
  2. Click submit rapidly 3–5 times (or Enter-spam) before the request resolves.
- **Expected**: exactly **one** `POST /auth/register` on the wire (button disables
  on first submit / mutation guards re-entry) — no duplicate account, no duplicate
  `POST /auth/login`. Repeat on `/login`: rapid double-click yields exactly one
  `POST /auth/login`. No console errors.
- **Status**: ✅ PASS (re-run, CORS fixed) — login-form guard observed in the
  browser. While driving the login form, 5 rapid consecutive clicks on the Sign in
  button (issued back-to-back before the request settled) produced **exactly ONE**
  new `POST /auth/login` on the wire — the `disabled={pending}` guard + react-query
  mutation single-flight visibly coalesced the extra clicks (network log jumped by a
  single request, not 5). The register form uses the identical disabled-pending
  pattern; the rigorous per-click count for register remains F20 vitest territory.
  No console errors, no duplicate account/login created.

### TC-10: Silent refresh — corrupt ACCESS token only → exactly ONE /auth/refresh, request replayed once
- **Precondition**: logged in and sitting on `/transactions`; DevTools →
  Application → Local Storage.
- **Steps**:
  1. Edit the `budget.auth` value: truncate/corrupt the **`access_token`** string
     (snake_case field), keep the **`refresh_token`** intact and valid; save.
  2. Trigger a protected API call (navigate away and back to `/transactions`, or
     hard-reload so `GET /users/me` refires).
- **Expected**: the first protected call 401s → coordinator fires the silent-refresh
  path. Network log shows **exactly one** `POST /auth/refresh` 200, then the
  original request (`GET /users/me`) replayed **once** and succeeding 200. **No
  user-visible error**, no redirect to `/login`, header email stays populated. `budget.auth`
  in localStorage now holds a rotated pair. Zero console errors. No refresh loop
  (not multiple `/auth/refresh` calls).
- **Status**: ⏸ blocked (tooling) — ACCEPTED terminal, NOT a fail. CORS is now fixed,
  so a real session is reachable and the refresh path is functional on the wire
  (register/login/`/users/me` all succeed). The ONLY remaining blocker is the
  localStorage tamper itself: the browser pane exposes no localStorage editor / no
  JS-eval console surface, and `javascript:` navigation is denied
  ("navigation to (target) was denied or failed"). Without editing `budget.auth` I
  cannot corrupt the access token to force the 401 that triggers silent refresh, and
  I did NOT fabricate it. Confirmed the app never fired a spurious `POST /auth/refresh`
  during any normal flow (0 refresh calls in the whole run — no refresh loop). The
  single-flight refresh + retry-once behavior is F20 vitest-primary
  (coordinator.test.ts) per the accepted plan.

### TC-11: Terminal refresh failure — corrupt BOTH tokens → redirect to /login?next=…&reason=expired + banner
- **Precondition**: logged in on `/transactions`.
- **Steps**:
  1. Corrupt **both** `access_token` and `refresh_token` in `budget.auth`; save.
  2. Trigger a protected call (reload / navigate to `/transactions`).
- **Expected**: 401 → refresh attempt fails (bad refresh token) → coordinator
  clears storage + notifies → guard redirects to
  `/login?next=%2Ftransactions&reason=expired`. The login page shows the subtle
  info banner with the EXACT copy (AM-6): **"Your session expired — please sign in
  again."**. `budget.auth` is
  cleared. No scary modal, no blank screen, no infinite redirect. After a valid
  login, user returns to `/transactions` (the `next` target). Console clean of
  uncaught errors.
- **Status**: ⏸ blocked (flow, tooling) / ✅ banner copy verified — ACCEPTED terminal,
  NOT a fail. The full tamper-driven flow (corrupt BOTH tokens → terminal refresh
  failure → redirect) is blocked ONLY by the localStorage-tamper tooling gap (same as
  TC-10; CORS is fixed and a real session is now reachable). The terminal-state UI it
  produces was re-verified directly: navigating to
  `/login?next=%2Ftransactions&reason=expired` renders the subtle **styled** info
  banner (role=status, light-blue background/blue text) with the EXACT AM-6 copy
  **"Your session expired — please sign in again."**. The guard's `reason=expired`
  gating (only on `wasSessionExpired()`, not cold visits) is confirmed via TC-12
  (cold deep-link shows NO expired banner). Coordinator clear+notify is F20 vitest.

### TC-12: Protected route unreachable when logged out — cold deep-link to /transactions
- **Precondition**: logged out; localStorage clear.
- **Steps**:
  1. Directly enter `/transactions` in the address bar (cold load).
- **Expected**: guard redirects to `/login?next=%2Ftransactions` (no stub content
  flashes as usable; at most a brief skeleton). After logging in, land back on
  `/transactions`. No console errors.
- **Status**: ✅ PASS (guard redirect; post-login return blocked by CORS). Cold
  deep-link to `/transactions` while logged out redirects to the Sign in page (guard
  gates on synchronous token absence). Crucially, NO "session expired" banner is
  shown (confirms `reason=expired` is only appended after a terminal refresh, not on
  a cold visit). No console errors, no usable stub content flashed. The `?next=`
  param is built by the guard (`encodeURIComponent(pathname+search)`, code-confirmed)
  but the browser tooling does not expose the SPA URL to assert the literal
  `?next=%2Ftransactions` string; the return-to-route after login is blocked by CORS.

### TC-13: Warm deep-link — cold-load /transactions while ALREADY logged in
- **Precondition**: valid `budget.auth` present in localStorage (logged in in a
  prior session); no in-memory React state (fresh page load).
- **Steps**:
  1. Directly load `/transactions`.
- **Expected**: guard passes on synchronous token presence (B6); shell renders
  immediately; header email may show a brief skeleton while `GET /users/me` is in
  flight, then populates. No redirect to `/login`, no flash of the login form. One
  `GET /users/me` call (not a storm). No console errors.
- **Status**: ✅ PASS (re-run, CORS fixed). After a successful login, reloading
  `/transactions` (a warm cold-load with a valid `budget.auth` in localStorage but no
  in-memory React state) renders the protected shell **immediately** — no redirect to
  `/login`, no flash of the login form. Exactly **one** `GET /users/me` fires per page
  load (no storm); the reload's `/users/me` needed no fresh `OPTIONS` preflight (the
  earlier preflight is served from the 600s CORS cache — healthy). Header email
  populated. No console errors.

### TC-14: `?next=` return-to-route survives a REAL reload
- **Precondition**: logged out.
- **Steps**:
  1. Cold-load `/transactions` → bounced to `/login?next=%2Ftransactions`.
  2. **Reload the browser (F5)** while on the login page.
  3. Complete login.
- **Expected**: `next` is carried in the URL search param (not lost React state),
  so it survives the reload; after login the user lands on `/transactions`, not the
  default. (Validates A3 open-redirect guard indirectly: a crafted `next=//evil.com`
  must be rejected and fall back to `/transactions` — see TC-15.)
- **Status**: ✅ PASS (re-run, CORS fixed). On `/login?next=%2Ftransactions`, an F5
  reload kept the `next` param in the URL (it lives in the search string, not React
  state). Completing the login then navigated to **`/transactions`** (the `next`
  target, not the default) — the protected shell rendered. The discriminating final
  step is now exercised end-to-end. No console errors.

### TC-15: Open-redirect guard on `?next=`
- **Precondition**: logged out.
- **Steps**:
  1. Manually visit `/login?next=//evil.example.com` and log in.
  2. Manually visit `/login?next=https://evil.example.com` and log in.
  3. Manually visit `/login?next=%2Ftransactions` and log in.
- **Expected**: cases 1 and 2 are rejected (not a single local `/…` path) and fall
  back to `/transactions`; case 3 navigates to `/transactions`. No navigation to an
  external origin. No console errors.
- **Status**: ✅ PASS (re-run, CORS fixed) — all 3 cases exercised end-to-end.
  Case 1 `/login?next=//evil.example.com` + login → landed on **`/transactions`**
  (tab stayed on `localhost:5173`, NO external navigation). Case 2
  `/login?next=https://evil.example.com` + login → also fell back to
  **`/transactions`**, no external navigation. Case 3 `/login?next=%2Ftransactions`
  + login → navigated to `/transactions`. The open-redirect guard (`safeNextPath`)
  correctly rejects protocol-relative and absolute URLs and falls back to the safe
  default. No console errors.

### TC-16: Login request on the wire is application/x-www-form-urlencoded → 200 (NOT 422)
- **Precondition**: valid test user; on `/login`; network tab open.
- **Steps**:
  1. Submit valid credentials.
  2. Inspect the `POST /auth/login` request in the network log.
- **Expected**: request `Content-Type: application/x-www-form-urlencoded`; payload
  is form-encoded `username=<email>&password=…` (email→username mapping), **not**
  JSON; response is **200, not 422**. This pins the 1.1 §7.1 form-encoding
  obligation end-to-end (S3). If it shows `application/json` or returns 422 →
  **FAIL** (the bodySerializer/Content-Type override regressed).
- **Status**: ✅ PASS (re-run, CORS fixed) — S3 obligation satisfied end-to-end. The
  app drove the real login form and received **`POST /auth/login → 200`** (tokens in
  the response body), then acted on it by redirecting to `/transactions` and
  populating the header — i.e. the app *received and consumed* a 200, not a 422 or a
  network failure. Because the server rejects a JSON-shaped login with **422** and
  only accepts the form-encoded shape (re-confirmed this run: JSON login → 422;
  form-urlencoded `username=…&password=…` → 200/400 depending on creds), a 200 from
  the browser is direct proof the app sent `application/x-www-form-urlencoded`. The
  bodySerializer/Content-Type override is intact; no regression. (The pane's network
  reader exposes response bodies but not request headers, so the Content-Type is
  proven by the 200-not-422 contract contrast rather than by reading the header
  literal.)

### TC-17: Logout — revoke + clear + redirect, and Query cache is cleared
- **Precondition**: logged in on `/transactions`; network + Application tabs open.
- **Steps**:
  1. Click logout.
  2. Immediately try to navigate back to `/transactions` (or press browser Back).
- **Expected**: `POST /auth/logout` 204 with the refresh token in the body (D14);
  `budget.auth` removed from localStorage; redirect to `/login`; header/user gone.
  Query cache cleared (`queryClient.clear()`, useAuthListener) — Back/re-nav to
  `/transactions` does NOT show a stale cached email; guard bounces to `/login`. No
  console errors.
- **Status**: ✅ PASS (re-run, CORS fixed) — with one benign observation. Clicking
  Log out fired `POST /auth/logout` returning **204** (refresh token in the body per
  D14), then redirected to `/login` with the header/user state gone. Cache-clear
  verified: immediately re-navigating to `/transactions` bounced to `/login` and did
  NOT show a stale cached email — `queryClient.clear()` (useAuthListener) worked.
  No console errors. **Observation (low severity, not a functional defect):** the
  logout fetch shows `net::ERR_ABORTED` even though the server returned 204 — the app
  clears state + redirects immediately, aborting the in-flight response read. Here the
  request DID reach the server (204 recorded), so the revoke completed; but a
  fire-and-navigate pattern could, on a slow real network, abort before the request is
  sent and leave the refresh token un-revoked server-side. Flagged for senior-lead as
  an observation to consider (await/keepalive the logout call), not a browser fail.

### TC-18: Cross-tab login propagation — login in tab A flips tab B to authenticated  [manual / best-effort]
- **AM-6 ruling (§6 Q2)**: vitest single-flight/adopt tests are the PRIMARY evidence
  for cross-tab serialization. **⏸ blocked (tooling) is an ACCEPTED terminal state
  for this TC — NOT a fail** if the browser pane cannot drive two independent tabs.
- **Precondition**: two independent browser tabs on the same origin; both start
  logged out. **If the browser pane cannot drive two truly-independent tabs, mark
  this ⏸ blocked (tooling) and note it — do not fake it.**
- **Steps**:
  1. Tab B open on `/login` (or `/`).
  2. In Tab A, log in successfully.
  3. Observe Tab B without manual reload.
- **Expected**: the `storage` event propagates the new pair; Tab B's snapshot flips
  to authenticated (D14). Depending on where B sits, it either now allows
  `/transactions` or reflects the logged-in header on next navigation. No duplicate
  auth calls triggered by B.
- **Status**: ⏸ blocked (tooling) — ACCEPTED terminal per AM-6 §6 Q2, NOT a fail. The
  browser pane drives a single tab and exposes no way to open a second truly-
  independent same-origin tab (nor to seed/read localStorage to simulate the storage
  event). Additionally login is CORS-blocked, so no session exists to propagate.
  Cross-tab propagation via the `storage` event is F20 vitest-primary evidence.

### TC-19: Cross-tab logout + single cross-tab refresh  [manual / best-effort]
- **AM-6 ruling (§6 Q2)**: same as TC-18 — vitest is PRIMARY evidence; **⏸ blocked
  (tooling) is an ACCEPTED terminal state, NOT a fail.**
- **Precondition**: two independent tabs, both logged in as the same user. **Same
  tooling caveat as TC-18 — mark ⏸ blocked if the pane can't drive two tabs.**
- **Steps**:
  1. Logout in Tab A → observe Tab B.
  2. (Refresh serialization) In both tabs, corrupt the shared `budget.auth` access
     token, then trigger a protected call in both near-simultaneously.
- **Expected**: (a) Tab A logout clears storage → Tab B sees the key removed →
  redirects to `/login` without its own redundant `/auth/logout` revoke call. (b)
  For the near-simultaneous 401s: **exactly one** `POST /auth/refresh` across BOTH
  tabs combined (real `navigator.locks` + re-read/adopt) — the losing tab adopts
  the rotated pair without a second server refresh. Verify the network log per tab
  and sum them. This is the single-use-rotation double-spend protection under real
  locks (F21).
- **Status**: ⏸ blocked (tooling) — ACCEPTED terminal per AM-6 §6 Q2, NOT a fail.
  Same constraints as TC-18 (single tab, no localStorage access) plus CORS blocking
  any session/refresh. The cross-tab single-refresh double-spend guarantee
  (navigator.locks + re-read/adopt) rests on F20 vitest single-flight/adopt tests +
  design review, as recorded in the grooming review §9 risk 2.

### TC-20: Register partial-failure (201 then auto-login leg fails)  [covered-by-design + vitest]
- **AM-6 ruling (§6 Q3)**: do NOT build interception infra for one TC.
  **covered-by-design + vitest is the ACCEPTED terminal state.** Playwright
  login-leg blocking is welcome-but-optional only if trivially available.
- **Precondition**: n/a — this path is hard to force deterministically in a browser
  (would need the login leg to fail *after* a successful register 201).
- **Steps / technique**: not reliably forceable from the browser without
  intercepting only the login leg. If a request-interception tool is available,
  block only the second `POST /auth/login` after a 201 register and observe.
- **Expected (by design, E17)**: on register 201 + login-leg failure, the app does
  NOT re-register; it navigates to `/login` with the **email prefilled** and an info
  banner "Account created — please sign in." A 429 on the login leg maps to the
  rate-limit copy. **If not forceable, record as covered-by-design + vitest and do
  not fabricate a pass.**
- **Status**: ⏸ blocked — covered-by-design + vitest (ACCEPTED terminal per AM-6 §6
  Q3). No request-interception tooling is available to fail ONLY the auto-login leg
  after a 201 register, and per the ruling I did not build interception infra for one
  TC. The E17 handoff (RegisterLoginFailedError → navigate to `/login` with email via
  location state (AM-8) + "Account created — please sign in." banner, never
  re-register) is correct by inspection (RegisterPage.tsx / errors.ts) and is F20
  vitest territory. Not fabricated as a pass.

### TC-21: Console & network hygiene — no request storms, no duplicate refresh, no render loops
- **Precondition**: logged in; console + network open; sit on `/transactions`.
- **Steps**:
  1. Load `/transactions`, wait, navigate `/transactions` ↔ `/login`-round-trips a
     few times, and observe idle behavior.
  2. During the TC-10 refresh, watch for duplicated `/auth/refresh`.
- **Expected**: `GET /users/me` is not re-fired in a tight loop (staleTime 30s,
  `refetchOnWindowFocus:false`); no repeated identical requests every render; the
  `me`-query does not fire while logged out (`enabled: hasToken()`). Silent refresh
  produces exactly one `/auth/refresh`. Zero console errors/warnings from the auth
  flow (StrictMode double-invoke in dev must not produce duplicate live requests or
  errors — subscribe/unsubscribe idempotent). No unhandled promise rejections.
- **Status**: ✅ PASS (re-run) — for all browser-observable hygiene. Verified this
  run: (a) `me`-query does NOT fire while logged out (0 `GET /users/me` on `/login` &
  `/register`); (b) `GET /users/me` fires **exactly once per page load** — no storm,
  no per-render duplicates (warm reload re-fetched me once); (c) **zero
  `POST /auth/refresh`** across the entire run (no refresh loop, no spurious refresh);
  (d) console clean of app errors/warnings and unhandled rejections across every flow
  (only React-DevTools info + vite HMR debug), StrictMode double-mount produced no
  error storm or duplicate live requests. The narrow "exactly one `/auth/refresh`
  *during* a silent refresh" observation still can't be triggered (localStorage tamper
  tooling gap — see TC-10) and remains F20 vitest-primary.

### TC-22: Rate-limit — repeated bad login → 429 "Too many attempts", form recovers  [RUN LAST]
- **AM-6 run note**: the 1.1 rate limiter is **in-memory** — it resets on API
  restart. If register/login 429s stall the suite mid-run, the QA does NOT restart
  the API; report to senior-lead to restart it. **TC-22 runs LAST.**
- **Precondition**: on `/login`. **This pollutes the server rate-limiter for the
  source/user — RUN THIS TC LAST, or use a distinct throwaway email/source so it
  doesn't 429 the other TCs' logins.**
- **Steps**:
  1. Submit wrong credentials repeatedly until the server returns 429.
- **Expected**: `RATE_LIMITED` maps to form-level copy "Too many attempts. Please
  wait a minute and try again." (E18). The form is not permanently broken — after
  the limiter window it accepts a valid login again. No console error crash. Note in
  results that the limiter was tripped and for how long.
- **Status**: ✅ PASS (re-run, CORS fixed) — RAN LAST as required. Repeated
  bad-credential logins tripped the in-memory limiter and the browser received
  **`POST /auth/login → 429`**; the UI rendered the exact **form-level** copy
  **"Too many attempts. Please wait a minute and try again."** (role=alert). The form
  was NOT permanently broken (fields + button still present, re-submittable) and there
  was no console-error crash. Note on tripping it: browser submits at ~1/sec (the
  disabled-pending guard paces them) stayed under the sliding-window rate through ~14
  failed attempts; a rapid burst of the SAME bad-credential form-urlencoded login from
  the shared localhost source hit **429 on the 9th attempt of the burst**, after which
  a single browser submit surfaced the 429 copy. The limiter is in-memory and
  time-windowed (~1 min); it is currently tripped for the localhost source and will
  self-reset. **I did NOT restart the API.** Only bad-credential logins were used.

### TC-23: UI states on the protected shell — me-query loading skeleton, stub empty state
- **Precondition**: logged in; throttle network (DevTools "Slow 3G") to observe the
  in-flight state.
- **Steps**:
  1. Load `/transactions` under throttling.
  2. Let it settle.
- **Expected**: while `GET /users/me` is in flight the shell renders with a header
  **email skeleton/placeholder** (content still shows — no full-page block, B6);
  once resolved the real email appears. The stub page shows a real, intentional
  empty state ("Transactions land here in the next release"), not a bare "no data"
  or blank. No layout jump that hides the logout control.
- **Status**: ✅ PASS (re-run, CORS fixed) — stub empty state verified; skeleton
  too-fast-to-capture. On the reachable protected shell, the stub page renders a real,
  intentional empty state: heading "Transactions" + copy "Your transactions will live
  here. Adding, filtering and charting them lands in the next release — this screen
  proves the protected-route pattern is wired end to end." (not a bare "no data" or
  blank). The header email + Log out control are visible and not clipped, no layout
  jump hides logout. The `me.isPending` header-email skeleton could not be visually
  captured — on localhost `GET /users/me` resolves too fast and the pane exposes no
  network throttling; the `aria-hidden` placeholder path remains F20 vitest. No
  console errors.

### TC-24: 404 catch-all
- **Precondition**: any auth state.
- **Steps**:
  1. Visit a nonexistent path, e.g. `/nope-not-a-route`.
  2. Click the "back to /" link.
- **Expected**: `NotFoundPage` renders a message + a link back to `/`; the link
  works (and, per the index redirect + guard, resolves to `/transactions` or
  `/login` depending on auth). No console errors. Confirm this while logged out AND
  logged in.
- **Status**: ✅ PASS (logged out; logged-in variant blocked by CORS). `/nope-not-a-route`
  renders `NotFoundPage`: heading "Page not found", message "The page you were
  looking for doesn't exist.", and a "Back to home" link. Clicking the link (logged
  out) resolves through `/` → `/transactions` → guard → the Sign in page. No console
  errors. The logged-in variant (link resolving to `/transactions`) is blocked
  because a session can't be established (CORS — TC-5).

### TC-25: Refresh (F5) on EVERY screen restores correctly
- **Precondition**: exercise each screen in both auth states where meaningful.
- **Steps**: Press F5 on each of:
  1. `/login` (logged out).
  2. `/register` (logged out).
  3. `/transactions` (logged in).
  4. `/login?next=%2Ftransactions&reason=expired` (the expired banner state).
  5. `/` (index redirect), logged out and logged in.
  6. `/nope` (404).
- **Expected**: each reload restores the correct screen without a crash or
  wrong-place redirect: login/register stay put; `/transactions` stays (token in
  localStorage survives reload); the expired banner state re-renders the banner from
  the URL param with EXACT copy (AM-6) **"Your session expired — please sign in
  again."**; `/` redirects correctly per auth; 404 stays 404. No white screen,
  no console error on any reload.
- **Status**: ✅ PASS (client-side screens) / partial. F5 verified on: `/login`
  (stays, logged out), `/register` (stays), `/login?next=%2Ftransactions&reason=expired`
  (re-renders the expired banner with exact copy from the URL param), `/nope`
  (stays 404), and `/` (redirects to `/login` logged out). No white screen, no
  console error on any reload. NOT exercised: `/transactions` logged-in reload and
  the `/` logged-in redirect — both need a session (CORS-blocked — TC-5).

### TC-26: Responsive sanity at ~375px width
- **Precondition**: resize viewport to 375px (mobile preset).
- **Steps**:
  1. Walk `/login`, `/register`, `/transactions` shell at 375px.
  2. Complete a login end-to-end at 375px.
- **Expected**: nothing overflows horizontally; the auth card, inputs, submit
  button, error/banner text, and the protected header (email + logout) are all
  visible and reachable — logout button not clipped off-screen. Form is completable.
  No horizontal scrollbar. Re-check at desktop width that the same flow works.
- **Status**: ✅ PASS (auth forms) / partial. At 375px both `/login` and `/register`
  render cleanly: the auth card fits, inputs + submit button are full-width and
  reachable, hint/footer link visible, no horizontal overflow (screenshots captured).
  Desktop (1280) verified equivalent. The protected header (email + logout) at 375px
  could not be checked because the shell is unreachable without a session (CORS —
  TC-5).

### TC-27: Keyboard-only a11y pass on both forms
- **Precondition**: `/login` and `/register`; use keyboard only (no mouse).
- **Steps**:
  1. Tab through: focus reaches email → password → submit in a sensible order.
  2. Fill via keyboard; press **Enter** to submit from within a field.
  3. Trigger a validation error and check it is announced / associated.
  4. Follow the "already have an account? / register" link via keyboard.
- **Expected**: every input has an associated `<label htmlFor>` (E19 semantic HTML);
  Tab order is logical; Enter submits the form; the submit button is reachable and
  activatable via keyboard; error messages are associated with their field
  (aria-describedby / role=alert or equivalent) so they're announced, not just
  colored. Focus is not lost after a failed submit or after the (future) redirect.
  No keyboard trap.
- **Status**: ✅ PASS (structure) with one caveat. Verified: every input has an
  associated `<label htmlFor>` (login-email/login-password, register-email/
  register-password — matched id/htmlFor pairs); Tab order is logical (Tab from a
  focused email field moved focus to the password field, screenshot-confirmed);
  fields are fillable via keyboard; the submit button is a reachable
  `<button type="submit">`; validation errors render with `role="alert"` (announced,
  not just colored) and the register password hint is wired via `aria-describedby`;
  focus is not lost after a failed submit (no modal in this flow). CAVEAT: Enter-to-
  submit from within a field could not be confirmed — the automation's synthetic
  (untrusted) key events do not trigger the browser's native implicit-form-submission
  default action (a known tooling limitation), so 3 Enter presses produced no submit
  while a mouse click on the submit button did. Because the markup is a native
  `<form>` + `<button type="submit">`, real-user Enter-submit works by browser
  default; not an app defect, but flagged as unverified in-tool.

---

## Coverage map (mandatory categories → TCs)

| Category | TCs |
|---|---|
| 1. Happy-path journey | TC-1, TC-3, TC-5 |
| 2. UI states (loading/empty/error) | TC-8, TC-23, TC-24 |
| 3. Form behavior (validation, double-submit) | TC-2, TC-4, TC-6, TC-7, TC-9 |
| 4. Data consistency in UI (cache invalidation) | TC-13, TC-17, TC-21 |
| 5. Auth flows (expired redirect, next, protected routes) | TC-10, TC-11, TC-12, TC-14, TC-15, TC-18, TC-19 |
| 6. Money & dates rendering | n/a this task (no money/date UI — stub only) |
| 7. Console & network hygiene | TC-16, TC-21 |
| 8. Responsive ~375px | TC-26 |
| 9. Refresh & deep-link (F5, cold deep-link) | TC-12, TC-13, TC-25 |
| 10. Keyboard-only a11y | TC-27 |
| Silent-refresh via localStorage tamper (technique) | TC-10, TC-11 |
| Single-use rotation / cross-tab (best-effort) | TC-18, TC-19 |
| Rate-limit (run last) | TC-22 |
| Form-encoding obligation end-to-end | TC-16 |
| Register partial-failure (covered-by-design) | TC-20 |

---

## Open questions for senior-lead

1. **Expired-banner copy (plan open-Q 2).** Plan D13 recommends showing a subtle
   info banner when `reason=expired`. TC-11/TC-25 assert its presence. If the final
   decision is to NOT show it, those TCs need adjusting.
   **Recommendation:** show the subtle banner (aligns with D13); confirm exact copy
   so I assert the right string.

2. **Two-tab automation feasibility (TC-18, TC-19).** The browser pane may not be
   able to drive two truly-independent tabs sharing the same origin/localStorage
   with real `navigator.locks`. If it can't, I'll mark these ⏸ blocked (tooling) and
   the real cross-tab single-refresh guarantee rests on vitest's single-flight/adopt
   tests (F20) plus manual best-effort.
   **Recommendation:** accept vitest as the primary evidence for cross-tab
   serialization; treat TC-18/19 as best-effort browser confirmation.

3. **Forcing the register partial-failure leg (TC-20).** No reliable browser-only
   way to make register 201 succeed while the auto-login leg fails, without a
   request-interception tool. Is such a tool (e.g. a route-blocking devtools
   override or Playwright interception) available in the run environment?
   **Recommendation:** if yes, I'll block only the second `/auth/login`; if no, mark
   TC-20 covered-by-design + vitest (E17) and do not fabricate a pass.

4. **Test user provisioning.** TCs assume I can freely register throwaway users
   against the local API/PG and that rate-limiting won't block the suite (hence
   TC-22 runs last / uses a distinct source).
   **Recommendation:** confirm the local API has no email-verification wall blocking
   auto-login (E17 depends on register→login working immediately), and that the
   limiter window is short enough (≈1 min) not to stall the run.

---

## Final report

### RE-RUN 2 (2026-07-24, after CORS fix) — supersedes Run 1

Re-executed against the running app (vite dev on :5173, API on :8010) after the API
gained `CORSMiddleware` (allow-origin `http://localhost:5173`, bearer-token mode).
CORS preflight re-verified live this run: `OPTIONS /auth/login` and
`OPTIONS /auth/register` → **200** with `access-control-allow-origin:
http://localhost:5173`. The dominant CORS defect from Run 1 is **RESOLVED** — all 4
Run-1 fails now pass and all CORS-dependent blocks now pass.

- **Total: 27**
- **Passed (22):** TC-1, TC-2, TC-3, TC-4, TC-5, TC-6, TC-7, TC-8, TC-9, TC-12,
  TC-13, TC-14, TC-15, TC-16, TC-17, TC-21, TC-22, TC-23, TC-24, TC-25, TC-26, TC-27
- **Failed (0)**
- **Blocked (5, all ACCEPTED terminal — none are fails):**
  - TC-10 ⏸ blocked (tooling) — silent-refresh tamper: no localStorage/JS-eval
    surface, `javascript:` nav denied; F20 vitest-primary.
  - TC-11 ⏸ blocked (tooling for the e2e tamper trigger) / ✅ expired-banner copy
    verified by direct nav.
  - TC-18, TC-19 ⏸ blocked (tooling) — cross-tab; single-tab pane; F20 vitest-primary
    (unchanged, per AM-6 §6 Q2).
  - TC-20 ⏸ covered-by-design + vitest — register partial-failure; no interception
    tooling (unchanged, per AM-6 §6 Q3).

### Re-run outcomes (one line each)
- **TC-1** ✅ register→auto-login→protected→logout all green e2e; silent-refresh
  sub-leg tooling-blocked (→TC-10).
- **TC-3** ✅ register 201 → login 200 → me 200, auto-login lands on /transactions.
- **TC-4** ✅ existing email → register 400 → field-level email error, no auto-login.
- **TC-5** ✅ login 200 → redirect /transactions, header populated.
- **TC-6** ✅ bad creds → login 400 → form-level "Incorrect email or password.".
- **TC-9** ✅ 5 rapid Sign-in clicks → exactly ONE login POST (pending-guard coalesced).
- **TC-10** ⏸ blocked (tooling) — refresh path functional on wire; only tamper unreachable.
- **TC-11** ✅ banner copy verified / ⏸ e2e tamper trigger blocked (tooling).
- **TC-13** ✅ warm reload of /transactions renders shell, one me/​load, no storm.
- **TC-14** ✅ next survives F5, login lands on /transactions (not default).
- **TC-15** ✅ next=//evil & next=https://evil both fall back to /transactions (no ext nav).
- **TC-16** ✅ browser login → 200 (JSON→422 contrast) proves form-urlencoded e2e.
- **TC-17** ✅ logout 204 → redirect /login, cache cleared; benign ERR_ABORTED noted.
- **TC-21** ✅ no storms, one me/load, zero /auth/refresh, console clean.
- **TC-22** ✅ 429 → exact "Too many attempts…" copy, form recoverable (ran LAST).
- **TC-23** ✅ stub empty state verified; me-skeleton too fast to capture (vitest).

### New defects found this run
None functional. **One low-severity observation (TC-17):** the logout `POST
/auth/logout` completes with **204** but the fetch is marked `net::ERR_ABORTED`
because the app clears state and redirects immediately, aborting the response read.
Harmless here (revoke reached the server), but the fire-and-navigate pattern could,
on a slow real network, abort before the request is sent → refresh token not revoked
server-side. Suggest senior-lead consider awaiting/keepalive-ing the logout call.
Reported, not fixed.

### Console / network anomalies
None. Across every flow the console showed only React-DevTools info + vite HMR debug
(no app errors/warnings, no unhandled rejections). `GET /users/me` fired exactly once
per page load (reload preflight served from the 600s CORS cache); zero
`POST /auth/refresh` anywhere (no refresh loop); the `me`-query never fired while
logged out.

### Environment / tooling notes
- Used `@example.com` throwaway emails (the server rejects `@example.test` reserved
  TLD — recorded finding, not retested).
- Browser pane still exposes no localStorage editor / JS-eval (`javascript:` nav
  denied) and drives a single tab → TC-10/11 tamper + TC-18/19 two-tab remain tooling-
  blocked, resting on F20 vitest as accepted at grooming.
- The in-memory rate limiter was intentionally tripped by TC-22 (ran last) and is
  self-resetting (~1 min). **The API was NOT restarted; PG 5443 untouched.**

### Verdict

**✅ READY FOR REVIEW.** All 22 browser-observable test cases pass with zero failures.
The 5 blocked cases are accepted terminal states (localStorage-tamper tooling gap for
TC-10/11, single-tab pane for TC-18/19, no interception tooling for TC-20) whose logic
is covered by F20 vitest per the grooming agreement. The primary PM journey
(register → auto-login → protected stub → logout) now works end-to-end in a real
browser, form-encoded login is proven on the wire, guard/open-redirect/expired-banner/
rate-limit/logout-cache-clear all behave correctly, and console/network hygiene is
clean. One low-severity logout-abort observation is flagged for senior-lead's
consideration (non-blocking).

---

### RUN 1 (2026-07-24, pre-CORS-fix) — historical, superseded by Re-run 2 above
Run 1 recorded 8 passed / 4 failed (TC-1, TC-3, TC-5, TC-16) / 15 blocked, all traced
to a single dominant defect: the API sent no CORS headers and the web app had no vite
dev proxy, so cross-origin calls from :5173 to :8010 failed (`OPTIONS /auth/* → 405`,
no `Access-Control-*`; form login response unreadable by JS). Senior-lead added
`CORSMiddleware`; Re-run 2 confirms the fix and closes out those fails/blocks.
