# Coordinator review (mobile / consumed at 1.8): web-auth-flow (roadmap 1.5)

Reviewer: mobile-engineer. Narrow review-only role, one question: does anything in
the web refresh-coordinator design paint the MOBILE client (Expo + expo-secure-store,
task 1.8) into a corner? No code, no plan edits.

Scope reviewed: plan-web.md S1–S3 (fetch-wrapper retry), C8 (auth helpers in
`packages/api-client`), C9 (`getErrorCode`), D10–D15 (TokenStorage + LockManager
seams, single-flight, navigator.locks, storage events, reactive-only refresh, logout).
Grounded in `packages/api-client/src/client.ts` (`createApiClient` accepts a custom
`fetch`) and the binding coordinator design in auth-email-password/grooming-review.md
§7 item 2.

Mandate limit acknowledged: I may NOT demand web build cross-platform abstractions
now. The senior's prior stands — do not force a premature shared package; I argue
only where a web choice would actively break 1.8 reuse.

---

## Q1 — Coordinator core in `apps/web/src/auth/` (not a shared package); 1.8 re-implements against expo-secure-store. Copy-the-pattern OK, or does 1.8 need shared code?

**ACCEPT — copy-the-pattern is correct; a shared coordinator package would be
actively wrong here.** The coordinator's core logic is inseparable from its runtime
primitives, and those primitives diverge hard between web and RN:

- Token storage: web `localStorage` (sync) vs RN `expo-secure-store` (async, Keychain/
  Keystore-backed). Not a config swap — a different concurrency model (Q2).
- Cross-tab serialization: web `navigator.locks` + `storage` events vs RN — *nothing*,
  because RN has no cross-tab problem (Q3). Half the web coordinator's machinery
  (D12 lock, D14 cross-tab logout, storage-event `subscribe`) has no RN counterpart
  and no RN purpose.
- React reactivity: `useSyncExternalStore` snapshot works on both, but the "source of
  truth" underneath differs (sync localStorage read vs an in-memory mirror hydrated
  from async secure-store).

What genuinely *should* be shared is already being placed in shared packages by this
plan: the typed auth calls (`login/refresh/logout/register`) in
`packages/api-client/src/auth.ts` (C8) and `getErrorCode` (C9), plus the zod schemas
in `packages/shared` (E16). Those are the platform-free parts. The *orchestration*
(single-flight + storage + locks + navigation reaction) is thin, platform-specific
glue that is cheaper and clearer to re-write against RN primitives than to abstract.
The web plan explicitly acknowledges this at D10 ("so mobile can port at 1.8 without
a cross-platform abstraction layer welded through the core") — that is the right call.
No concrete corner. A premature `@budget/auth-core` package would have to abstract
over sync-vs-async storage and present-vs-absent locking, which would make *both*
clients worse to serve an abstraction neither needs. Do not build it.

## Q2 — TokenStorage seam is SYNCHRONOUS (localStorage). expo-secure-store is ASYNC. Does the sync assumption leak into anything mobile reuses, or is it contained in web's own module? What is 1.8's storage story?

**ACCEPT — the sync assumption is contained in web's own `apps/web/src/auth/` module
and does NOT leak into any shared surface**, on the condition Q5 holds. I traced every
reuse boundary:

- `packages/api-client/src/auth.ts` (C8): the helpers take a *passed* `ApiClient` and
  the tokens as plain arguments/return values (`login(email,password)` returns a pair,
  `refresh(refreshToken)` takes a string). They never read storage themselves — sync
  or async. No leak.
- `getErrorCode` (C9): pure function over an error object. No storage. No leak.
- The custom-fetch pattern (S1–S2): `authFetch(input, init) => Promise<Response>` is
  already async (returns a Promise). Mobile's wrapper is the same signature and can
  `await` an async token read internally. No leak — this is the key point: the fetch
  wrapper contract is Promise-returning, so an async token source fits with zero
  contract change.

The one place sync-ness is baked in is web's own `TokenStorage` seam
(`read(): TokenPair | null` — synchronous) and its `getAccessToken(): string | null`
plus the `useSyncExternalStore` `getSnapshot()`. Those live entirely in
`apps/web/src/auth/` and are NOT a shared type. Mobile does not import them.

**1.8's storage story (recommended, recorded as an obligation):** async **hydrate
once into memory, then serve a sync snapshot.**
- On app boot (before rendering the guarded tree), `await SecureStore.getItemAsync`
  the token pair once and populate an in-memory mirror. Show a splash/hydrating gate
  until this resolves (this is the RN analogue web doesn't need because localStorage
  is sync).
- After hydration, `getAccessToken()` / `getSnapshot()` read the **in-memory mirror
  synchronously** — same shape web's guard and `useSyncExternalStore` want. Writes go
  to memory synchronously AND fire an async `SecureStore.setItemAsync` (fire-and-await
  inside `refresh()`/`login()`/`logout()`, which are already async).
- This keeps the RN route guard synchronous (matching web's B6 "gate on synchronous
  token presence, never block navigation on a round-trip") while honoring secure-store's
  async API. The async cost is paid once at boot, not per navigation.
- Tokens in `expo-secure-store` ONLY — never AsyncStorage. (Mobile standing rule; noted
  so 1.8 grooming does not drift.)

## Q3 — navigator.locks + storage events don't exist in RN. Is the in-tab single-flight promise alone sufficient at 1.8, and does the web design assume cross-tab machinery exists?

**ACCEPT — the module-level single-flight promise alone is sufficient at 1.8, and the
web design does NOT assume cross-tab machinery exists anywhere shared.** RN is a single
JS runtime with exactly one instance of the coordinator module — there are no tabs, no
second context racing for the same refresh token. The web plan's D11 in-tab
`inFlight: Promise<boolean> | null` (concurrent 401s all await one flight, cleared in
`finally`) is *the whole* concurrency story mobile needs. Everything the web plan wraps
on top of that is cross-tab-only and inert in RN:

- D12 `navigator.locks` / re-read-after-lock / adopt-stored-pair: exists solely to
  serialize *across tabs*. In RN there is no losing tab to adopt from. Mobile's
  `LockManager` equivalent is the web plan's own documented fallback (D12: "runs `fn`
  directly; the in-tab `inFlight` promise still dedups"). That fallback *is* mobile's
  production path — no lock, single-flight only. No hard failure by the web plan's own
  reasoning.
- D14 cross-tab logout via storage events, and the storage-event `subscribe`: no RN
  analogue and no RN need. Mobile's `subscribe` just notifies the in-memory mirror's
  React subscribers; there is no external mutation source to listen for.

Confirmed the web design contains its cross-tab assumptions inside D12/D14 and the
`LockManager`/`TokenStorage.subscribe` seams — none of it crosses into `api-client`
or `shared`. No corner.

One RN-specific concern to flag for 1.8 grooming (NOT a web problem, do not act on it
now): the single-flight `inFlight` promise must survive **app background/foreground**
transitions, and a refresh in flight when the OS suspends the JS thread may need
re-evaluation on resume. That is 1.8's to design; web's reactive-only model (D15) is
actually *easier* to port here than a proactive timer would be (Q-note under
obligations).

## Q4 — The clone-before-send / retry-once fetch wrapper: does RN fetch (whatwg-fetch / Hermes) support `Request.clone()` with bodies the same way? Flag verify-at-1.8 vs assert.

**ACCEPT the pattern as portable IN PRINCIPLE, with one explicit item to VERIFY at
1.8 — I will not assert RN body-clone semantics from memory.**

The web mechanism (S2/D11): the custom fetch wrapper receives a fully-built `Request`,
does `const retry = original.clone()` *before* the first send (body intact), sends the
original with a bearer, and on 401 replays `retry` with the new bearer. openapi-fetch
calls the injected fetch as `fetch(request, requestInitExt)` and `requestInitExt` is
`undefined` in non-Node runtimes (web plan verified this at source lines 2–4, 20, 123).
RN is also non-Node from openapi-fetch's guard's perspective, so the wrapper signature
`(input, init) => Promise<Response>` with `input` a `Request` should hold the same way.

**ASSUMPTION (memory-based, flagged — must be verified at 1.8, not trusted):**
- RN's networking does NOT ship the standard whatwg-fetch `Request`/`Response` with a
  spec-compliant `clone()`; RN historically uses its own `fetch` implementation over
  `XMLHttpRequest`, and under Hermes the global `Request`/`Response`/`Headers` come
  from RN's polyfill, not the browser. Whether `Request.prototype.clone()` exists and
  whether it correctly duplicates an un-consumed body is **not** something I will
  assert — RN's `Request` body handling (especially for `FormData`/`Blob` receipt
  uploads at later tasks) has known divergences from the browser.
- **Even so, this does not block reuse**, because the wrapper owns the request before
  send and can retry by other means. The verify-at-1.8 task is: confirm whether to
  (a) `original.clone()` like web, or (b) reconstruct the retry request from the
  captured `input`/`init` (mobile controls how it builds the `Request`, so it can keep
  the original `init` around and build a fresh `Request` for the retry instead of
  relying on `clone()`). Option (b) sidesteps any RN clone-body quirk entirely and is
  the safer default for RN unless `clone()` is proven.

**1.8 VERIFY items (do not assert):** (1) does `input` arrive as a `Request` (vs
`[url, init]`) under the installed openapi-fetch + RN fetch; (2) does RN
`Request.clone()` preserve an un-sent JSON body; (3) since 1.8's auth flow is
JSON/form bodies only (no receipt multipart until later), a captured-`init` rebuild is
an acceptable fallback and probably preferable. This is a spike for 1.8's plan, not a
web concern. The web plan's own risk note ("If openapi-fetch is bumped off 0.17.0,
re-verify line 123 still hands the wrapper a `Request`") applies double on RN.

## Q5 — `packages/api-client/src/auth.ts` helpers take a passed `ApiClient` and stay platform-free (no window/localStorage/navigator imports). Confirm the reuse boundary and state it as a HARD requirement web must keep.

**ACCEPT — this is exactly the right reuse boundary, and it is the single load-bearing
constraint for 1.8.** `createApiClient({ baseUrl, fetch })` already accepts a custom
`fetch` (verified in `client.ts`), so mobile constructs its own `ApiClient` with its
own RN `authFetch` and passes it to the *same* `auth.ts` helpers. That works if and
only if `auth.ts` and `getErrorCode` never reach for a web global. This is the one web
implementation choice that can silently break 1.8, so I state it as a hard requirement
(see constraints below).

Current state supports it: `packages/api-client/src/index.ts` today exports only
`createApiClient` and types — no platform coupling. The plan adds `auth.ts` + the
error helper here (C8/C9) precisely so mobile reuses them. Keep it clean and 1.8 gets
these for free.

---

## MUST-NOT-DO constraints on web's implementation (only where a web choice would actively break 1.8 reuse)

1. **`packages/api-client/src/auth.ts` and `getErrorCode` MUST stay platform-free.**
   No `window`, `document`, `localStorage`, `navigator`, `sessionStorage`,
   `addEventListener`, or any DOM/browser global imported or referenced in these files.
   They operate ONLY on the passed `ApiClient`, plain arguments, and returned values.
   Any web global creeping into `auth.ts`/`getErrorCode` breaks the mobile build at
   1.8 (RN has no such globals). This is the boundary that makes copy-the-pattern
   viable — if it holds, Q1–Q3 all resolve cleanly.

2. **The `authFetch` wrapper contract MUST remain `(input, init) => Promise<Response>`
   (already async).** Web must not bake a *synchronous* token read into anything that
   sits on a shared surface (it may do so freely inside `apps/web/src/auth/`, which
   mobile does not import). Concretely: keep the token-source coupling inside web's own
   `TokenStorage`/`getAccessToken` in `apps/web/src/auth/` — do NOT push a
   `read(): TokenPair | null` *synchronous* signature into `packages/api-client` or
   `packages/shared`. Mobile's token read is async-hydrated; a shared sync storage type
   would force mobile to lie about its concurrency model.

Nothing else in the web plan constrains 1.8. Web is free to keep `navigator.locks`,
storage events, sync `localStorage`, and cross-tab logout entirely — all contained in
`apps/web/src/auth/`, none of it shared, none of it a corner for mobile.

---

## 1.8 obligations (durable carry-forwards — 1.8 grooming MUST read this)

1. **Copy the coordinator pattern, do NOT share it.** Re-implement single-flight
   refresh + reactive-only 401→refresh→retry against RN primitives in
   `apps/mobile/src/auth/`. Reuse the shared parts only: `auth.ts`
   (`login/refresh/logout/register`), `getErrorCode`, and the `packages/shared` zod
   schemas (`loginFormSchema`/`registerFormSchema`). Do not build a shared
   `auth-core` package (Q1).

2. **Storage: async-hydrate-once into an in-memory mirror, then serve a sync
   snapshot.** On boot, `await SecureStore.getItemAsync` the token pair once behind a
   hydrating/splash gate; after that, `getAccessToken()`/`getSnapshot()` read memory
   synchronously so the expo-router guard never blocks on I/O (mirrors web B6). Writes
   update memory sync + `await SecureStore.setItemAsync` inside the already-async
   `login/refresh/logout`. Tokens in `expo-secure-store` ONLY, never AsyncStorage (Q2).

3. **Single-flight promise is the entire concurrency story — no lock, no storage
   events.** Use the web plan's documented `LockManager` fallback path (run `fn`
   directly) as production. Drop `navigator.locks`, the re-read-after-lock/adopt-stored-
   pair double-spend guard, storage-event `subscribe`, and cross-tab logout — all are
   cross-tab-only and inert in RN's single runtime (Q3). `useSyncExternalStore` over
   the in-memory mirror covers React reactivity.

4. **VERIFY (do not assert) RN Request/body semantics for the retry replay.** Spike at
   1.8: (a) does openapi-fetch hand the injected fetch a `Request` under RN; (b) does
   RN `Request.clone()` preserve an un-sent body; (c) default to rebuilding the retry
   request from captured `init` rather than relying on `clone()` if (b) is uncertain.
   1.8 auth bodies are JSON/form only, so a captured-`init` rebuild is a safe fallback.
   Re-verify against the actually-installed openapi-fetch version (Q4).

5. **Reactive-only refresh (no proactive `exp`-decode timer) — accept for RN too, and
   handle background/foreground.** Web's D15 lean ports well: no timer lifecycle to
   manage across app-suspend. Additionally design for the RN-specific case where the JS
   thread is suspended (backgrounded) mid-refresh — re-evaluate the `inFlight` promise
   and token freshness on `AppState` resume. This is net-simpler than a proactive
   timer would be on mobile (Q3 note).

6. **Navigation reaction stays in React, via expo-router.** Mirror web D13: the fetch
   wrapper only clears the mirror + notifies; the guard (subscribed via
   `useSyncExternalStore`) reacts and redirects to the login route. Do NOT imperatively
   navigate from inside the fetch wrapper. Preserve the intended route via typed route
   params (expo-router), the RN analogue of web's `?next=`, and keep login screens
   deep-link-safe (load their own state from params).

7. **Error copy table is app-owned, over the shared `getErrorCode`.** Same split as web
   E18 (`getErrorCode` returns the raw code; the mobile app owns code→copy). Include
   the network-failure arm — doubly important on flaky mobile networks; every auth
   mutation needs a visible, retryable error affordance, not a dead end.

---

## Summary

**Verdict: ACCEPT on all five questions.** The web coordinator design does not paint
the mobile client into a corner. Its cross-tab machinery (navigator.locks, storage
events, sync localStorage, multi-tab logout) is fully contained in `apps/web/src/auth/`
and has no place in — and creates no obstacle for — RN's single-runtime, async-storage
world. The genuinely reusable pieces (typed `auth.ts` helpers, `getErrorCode`, shared
zod schemas) are correctly placed in `packages/api-client` / `packages/shared`, and
`createApiClient`'s custom-`fetch` seam lets mobile plug in its own async-token
`authFetch` with no contract change. Copy-the-pattern is right; a premature shared
auth package would be wrong.

**Constraints on web (2, both narrow):**
1. `packages/api-client/src/auth.ts` and `getErrorCode` MUST stay platform-free — no
   web globals. (The single load-bearing constraint; if broken, 1.8 mobile won't build.)
2. Do NOT push a synchronous storage/token-read signature onto any shared surface —
   keep sync `localStorage` coupling inside `apps/web/src/auth/`.

**One item explicitly deferred to 1.8 as VERIFY-don't-assert:** RN `Request.clone()`
body semantics for the retry replay (Q4) — flagged as an ASSUMPTION, resolved by a
1.8 spike with a captured-`init` rebuild fallback.
