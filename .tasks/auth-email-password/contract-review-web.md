# Contract review (web / 1.5): auth-email-password

Reviewer: frontend-engineer. Scope: does the planned auth API contract consume
cleanly from the React SPA (TanStack Query + openapi-fetch generated client in
`packages/api-client`)? No code, no plan — verdict per question.

Verified against the actual toolchain: `openapi-fetch@0.17.0` (per-request
`bodySerializer` exists; `dist`/`src/index.js` L81-105 confirms the Content-Type
default behavior cited below), `openapi-typescript@7.13.0`, current
`schema.d.ts` (health-only today, so this is all additive).

---

## Q1 — form-encoded `/auth/login` (`application/x-www-form-urlencoded`, `username`=email)

**Verdict: ACCEPT-WITH-NOTE.** Workable with openapi-fetch + generated types; no
objection, do not switch to JSON.

Reasoning. openapi-typescript will type the body from the auto-named form schema
(`username` + `password` required, `grant_type`/`scope`/`client_id`/`client_secret`
optional), so the call stays fully typed. What 1.5 needs is a per-call override —
and it is **two parts, not one**, which is the gotcha to document:

1. `bodySerializer: (b) => new URLSearchParams(b as Record<string,string>).toString()`
2. an explicit `headers: { "Content-Type": "application/x-www-form-urlencoded" }`.

The header override is mandatory, not optional: openapi-fetch 0.17.0 hard-defaults
Content-Type to `application/json` for any serialized body that is **not** FormData
(src/index.js L95-101). A URLSearchParams/string body does *not* auto-negotiate the
form content-type through this client, so a bodySerializer alone would send the
right bytes with the wrong Content-Type and FastAPI would 422. Both parts get
wrapped once inside an `login()` helper in `packages/api-client` (or the 1.5 auth
hook) — localized, one call site, never repeated. The `username`-carries-email
field name is invisible to the UI (the helper maps `email -> username`).

This is the only non-JSON call in the API; the friction is real but bounded to one
wrapper. Not worth a contract change.

## Q2 — `TokenPair {access_token, refresh_token, token_type}` from BOTH login and refresh

**Verdict: ACCEPT.** Correct shape for web token-storage + silent-refresh.

One shape for both endpoints is exactly what the refresh flow wants: the 401->refresh
interceptor calls `/auth/refresh`, gets the identical `TokenPair`, and stores it via
the same code path as login — no shape branching. `token_type: Literal["bearer"]`
generates a harmless string-literal type; the client ignores it and hardcodes
`Authorization: Bearer ${access_token}`. Access token stored in memory (Zustand
client-state slice, legitimately client state), refresh token persisted (see Q3).

## Q3 — single-use rotating refresh, same-client races (MOST IMPORTANT)

**Verdict: ACCEPT-WITH-NOTE. No server-side grace window required for 1.5.**

Same-client concurrency is fully mitigable client-side, and I will own that
mitigation in 1.5:

- **In-tab:** a single shared in-flight refresh promise (module-level mutex). All
  requests that 401 concurrently await the same `/auth/refresh` call — only one
  token is ever spent per tab. Standard interceptor pattern.
- **Cross-tab / reload race:** `navigator.locks.request('auth-refresh', ...)` (Web
  Locks API — supported in all current evergreen browsers, which is our only
  target) serializes refresh across tabs. The refresh token lives in `localStorage`
  as the single source of truth; **after** acquiring the lock the holder re-reads
  the token from storage (so the loser of the race picks up the winner's freshly
  rotated token instead of replaying the spent one). A `storage` event (or
  BroadcastChannel) propagates the new pair to sibling tabs.

Residual window that remains even with all of the above: a hard reload/tab-close
that kills the tab *after* the server rotated but *before* the new pair is persisted
loses the rotated token -> forced re-login. This is rare, non-corrupting, and
recoverable by logging in again. Acceptable for a single-user personal app; it does
not justify server-side lineage/grace machinery (which the architecture already
deliberately declined in §1). If real multi-user arrives, a short server-side grace
window (old token accepted for N seconds, returns the same new pair) is the cheap
upgrade — record it, do not build it now.

So: contract acceptable as-is. The cost is a non-trivial but well-understood client
refresh coordinator that 1.5 must build (mutex + Web Locks + localStorage as source
of truth). Flagging it here so it is scoped into 1.5, not discovered mid-build.

## Q4 — error contracts (`detail` string codes, 429 `{"error":...}`, ErrorModel union)

**Verdict: ACCEPT-WITH-NOTE.** One cheap server normalization recommended, none blocking.

- `400 {"detail":"LOGIN_BAD_CREDENTIALS"}` / `401 {"detail":"REFRESH_TOKEN_INVALID"}`
  — fine. String codes in `detail` are stable map keys for i18n/message lookup.
  Better than prose. The client builds one `getErrorCode(response)` helper.
- **fastapi-users ErrorModel `detail: string | {...}` union** — expected and
  tolerable. openapi-typescript emits the union; the helper narrows
  `typeof detail === "string"`. The register/reset codes we care about
  (`REGISTER_USER_ALREADY_EXISTS`, `REGISTER_INVALID_PASSWORD`,
  `RESET_PASSWORD_BAD_TOKEN`) all arrive as the string arm. No action.
- **429 body `{"error": ...}` (slowapi) diverging from `{"detail": ...}`** — the one
  genuine wart. It forces the error helper to check two envelope keys, and the
  divergent shape will surface in the generated types only if 429 is declared on the
  route (the plan does declare it — good; keep that). *Recommendation (cheap, not
  blocking):* register a slowapi `RateLimitExceeded` handler that emits
  `{"detail": "RATE_LIMITED"}` (429) so the entire API speaks one error envelope and
  the client helper stays single-branch. If backend declines, 1.5 absorbs it in the
  helper — but a one-shape API is worth the ~5-line handler. Raising as a NOTE, not
  an objection.

## Q5 — register returns `UserRead` (no tokens) -> client logs in after register

**Verdict: ACCEPT.** Standard two-step; fine for 1.5 UX.

TanStack Query composes this cleanly: register mutation `onSuccess` chains the login
mutation with the same credentials, single spinner, one perceived action for the
user. Keeping one token-issuance path (login) is the right simplification; it also
means the register form and login form share the same post-auth navigation. No
contract change wanted.

## Q6 — awkward generated TS (auto-named form schema, 204 logout, security scheme)

**Verdict: ACCEPT.** Nothing 1.5 will curse — minor ergonomics only.

- **`Body_login_auth_login_post`** (exact name depends on the route function name)
  — ugly but harmless. 1.5 aliases it once in the api-client wrapper; the raw name
  never leaks into UI code. Do not fight it (matches plan §10).
- **204 logout** — openapi-fetch handles empty-body responses; `data` is `undefined`,
  `error` unset on success. The logout hook just checks `!error`. Fine.
- **OAuth2 password security scheme + per-route `security`** — openapi-fetch does not
  enforce auth from the schema; it is documentation only. Zero client impact. Auth
  header is attached by our request middleware regardless.
- **`OAuth2PasswordRequestForm` optional fields** (`grant_type` etc.) — all optional
  in the generated body type, so the login helper passes only `username`+`password`.
  No noise at the call site.

---

## Objections that should change the 1.1 contract

**None.** The contract is consumable as-is. Two non-blocking NOTES for backend to
consider now while it is cheap, plus one scope flag for 1.5:

- **(cheap, recommended)** Normalize the slowapi 429 body to `{"detail": "RATE_LIMITED"}`
  via a custom `RateLimitExceeded` handler, so the whole API uses one error envelope
  (`detail`) instead of login/refresh using `detail` and 429 using `error`. Keep the
  429 declared on the limited routes either way. (Q4)
- **(document for 1.5)** `/auth/login` requires BOTH a urlencoded `bodySerializer`
  AND an explicit `Content-Type: application/x-www-form-urlencoded` header override —
  openapi-fetch 0.17.0 otherwise defaults the header to `application/json` and the
  call 422s. (Q1)
- **(scope into 1.5, not a contract change)** Single-use rotating refresh obliges the
  web client to build a refresh coordinator: in-tab mutex + `navigator.locks`
  cross-tab lock + `localStorage` as the single token source re-read after lock
  acquisition. Acceptable; owned by 1.5. (Q3)
