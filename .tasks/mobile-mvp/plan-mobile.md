# Implementation Plan (mobile): mobile-mvp (roadmap 1.8)

## Approach

Mobile reaches MVP parity by **copying web's proven patterns at the presentation
and app-state layers**, and **consuming the wire-facing modules web promoted to
`@budget/api-client`** (patch builders, envelope-narrow helpers, `ApiError` +
`throwOnError`) plus the shared schemas/money/date/hex helpers in
`@budget/shared`. Per the architect memo (all verdicts ACCEPTED, S1 amended in
obligations.md), nothing new is promoted from this side: the auth coordinator,
query keys, data hooks, error copy tables, and QueryClient policy are
**copy-with-conformance, app-owned in `apps/mobile/src/**`**. The invariants that
bind both clients are enforced by the Phase-4 obligations checklist, not by shared
runtime artifacts (web and mobile run separate QueryClient caches in separate
runtimes).

The one genuinely new engineering problem mobile owns is the **auth coordinator's
storage and concurrency model**: web's synchronous `localStorage` mirror and
cross-tab machinery (`navigator.locks`, `storage` events) do not exist on RN.
Mobile re-implements the coordinator against `expo-secure-store`'s **async** model
with an **async-hydrate-once → in-memory mirror → sync snapshot** gate behind the
splash screen, single-flight refresh as the *entire* concurrency story, and an
`AppState`-resume re-evaluation. This is O1–O7. I chose copy-the-pattern over a
shared `auth-core` package because the seams (sync `read()` on web vs async
hydrate on mobile; locks vs single-flight) are genuinely different runtimes — a
shared abstraction would be a compatibility layer with two implementations and no
payoff (O1, S5).

The coordinator **core** (`coordinator.ts`) is architected with dependency
injection (storage adapter + resume-subscription injected, exactly as web injects
`TokenStorage`/`LockManager`) so it imports only `@budget/api-client` and stays
**vitest-testable under Node without any react-native/expo import** — this is what
makes Section F's single-runner decision viable.

## Screens / navigation

expo-router file-based, **route groups** for auth vs app, **Stack for auth, Tabs
for the app shell, modal Stack screens for forms**. Rationale in Section B.

- `apps/mobile/app/_layout.tsx` — **REPLACES** the current bare `<Stack />`. Root
  providers: `GestureHandlerRootView` → `SafeAreaProvider` →
  `QueryClientProvider` (app-owned client) → splash gate (renders nothing until
  `coordinator` hydration resolves, O2) → `useAuthListener()` (clears Query cache
  on signed-in→out) → `<Stack screenOptions={{ headerShown:false }}>` with the two
  groups and the modal form screens registered with `presentation:'modal'`.
- `apps/mobile/app/(auth)/_layout.tsx` — Stack. If the sync snapshot is
  authenticated, `<Redirect href="/(app)/(tabs)/transactions" />` (prevents seeing
  login while logged in). Deep-link-safe: reads `next` from params, never prior
  screen state (O6).
- `apps/mobile/app/(auth)/login.tsx` — login form; on success routes to the
  validated `next` param or the default authed route.
- `apps/mobile/app/(auth)/register.tsx` — register form; 201 auto-chains into
  login (mirrors web `useRegister`); on the login-leg-fails case, hands off to
  `/(auth)/login` prefilled (does NOT re-register).
- `apps/mobile/app/(app)/_layout.tsx` — **the protected guard**. Reads the sync
  snapshot via `useIsAuthenticated()` (useSyncExternalStore); when false,
  `<Redirect href={\`/(auth)/login?next=${encodeURIComponent(currentHref)}${expiredSuffix}\`} />`
  where `expiredSuffix` comes from `coordinator.wasSessionExpired()` (O6). When
  authenticated, renders `<Stack>` hosting the `(tabs)` group and the two modal
  form screens.
- `apps/mobile/app/(app)/(tabs)/_layout.tsx` — `<Tabs>`: Transactions, Categories.
- `apps/mobile/app/(app)/(tabs)/transactions.tsx` — month screen: `MonthPicker`
  header + `SummaryHeader` + `TransactionList` (FlatList). Owns the selected month
  in a `useState` seeded from `currentMonth()`; deep-link-safe (no reliance on
  another screen). "＋" opens the transaction-form modal.
- `apps/mobile/app/(app)/(tabs)/categories.tsx` — kind-grouped category list
  (SectionList). "＋" opens the category-form modal.
- `apps/mobile/app/(app)/transaction-form.tsx` — modal. **Typed params**:
  `{ id?: string; month: string }`. Create when `id` absent, edit when present.
  Loads its own data from params + the categories/summary caches (deep-link-safe):
  it does NOT receive the `TransactionRead` object via navigation state. For edit
  it finds the row in the already-cached month list by `id`; if absent (cold deep
  link) it shows a "transaction unavailable" state with a back affordance (no
  single-row GET exists — same constraint web documents).
- `apps/mobile/app/(app)/category-form.tsx` — modal. Typed params `{ id?: string }`.
  Same deep-link-safe load-from-cache rule.

## New components / hooks

Auth (`apps/mobile/src/auth/`):
- `coordinator.ts` — **pure, DI**; the copied coordinator (O1,O3,O4,O5 core).
- `secureStore.ts` — `expo-secure-store` async adapter: `hydrate()`, `write(pair)`,
  `clear()` (O2). The only file importing `expo-secure-store`.
- `resume.ts` — `AppState` subscription factory injected into the coordinator (O5).
  Only file importing RN `AppState`.
- `errors.ts` — app-owned `describeAuthError` copy table **including the network
  arm** (O7), over shared `getErrorCode`.
- `useAuth.ts` — `useIsAuthenticated()` (useSyncExternalStore over the mirror),
  `useLogin`/`useRegister`/`useLogout` mutations (copied from web `useAuth.ts`).
- `useAuthListener.ts` — clears the Query cache on the signed-in→signed-out edge
  (copied verbatim from web).
- `next.ts` — `safeNextRoute()` return-route validator for typed params (O6;
  RN analogue of web `next.ts`).
- `useMe.ts` — `['me']` query, disabled while logged out (copied from web).
- `coordinator.test.ts` — vitest, **supersedes and deletes** `src/wiring.test.ts`.

Lib (`apps/mobile/src/lib/`):
- `api.ts` — builds `authClient` (plain) + `apiClient` (protected, `fetch:
  coordinator.authFetch`) + wires the coordinator with `secureStore` + `resume`;
  resolves `baseUrl` from `baseUrl.ts`.
- `baseUrl.ts` — dev host derivation + `EXPO_PUBLIC_API_URL` override (Section C).
- `queryClient.ts` — app-owned `QueryClient` with mobile retry/staleTime (Section D).

Data (`apps/mobile/src/data/`): `queryKeys.ts`, `categories.ts`, `transactions.ts`,
`categoryLookup.ts`, `errors.ts` (all Section D/E).

Feature presentation (`apps/mobile/src/features/`): `transactions/{SummaryHeader,
TransactionList,TransactionRow,MonthPicker,groupByDay}.tsx`,
`categories/{CategoryList,CategoryRow}.tsx` (Section E).

Shared RN primitives (`apps/mobile/src/components/`): `KindSegmented.tsx`
(segmented control — AM-1.6-c), `KeyboardAwareForm.tsx` (KeyboardAvoidingView +
ScrollView wrapper), `HexSwatch.tsx` (AM-hex preview guard), `FieldError.tsx`,
`FormButton.tsx`, `ConfirmDelete` via `Alert.alert` helper.

## Data layer

Endpoints (all already exist — **no API changes; contract untouched, S1**):
`GET/POST /categories`, `PATCH /categories/{id}`, `GET/POST /transactions`,
`PATCH/DELETE /transactions/{id}`, `GET /transactions/summary`, `GET /users/me`,
and the `/auth/*` set via the shared helpers. **No endpoint is missing.**

- **Query keys (`data/queryKeys.ts`)** — COPY `qk` + `TxListFilters` verbatim from
  web (architect Q2). `offset` is the `useInfiniteQuery` pageParam, NOT a key
  member (**AM-1.6-a**). Single archived-inclusive categories cache
  `['categories', {includeArchived:true}]` is the ONE source (**AM-1.6-b**);
  non-archived views are client-derived.
- **Categories (`data/categories.ts`)** — copy web's hooks: one archived-inclusive
  `useCategories` (`include_archived:true`, `staleTime` raised), `useCreateCategory`
  / `useUpdateCategory` updating that cache **in-place by id** from the returned
  `CategoryRead` (**AM-1.6-b**). Archive is `useUpdateCategory` with `{archived}`
  (**W9**); **no DELETE for categories**.
- **Transactions (`data/transactions.ts`)** — copy web: `useTransactions`
  infinite query with `limit` in the stable filter slice and `has_more` **derived**
  as `loaded < total` (**W6**, AM-1.6-a); `useSummary` per-month; create/update/
  delete mutations. Invalidation: after ANY tx mutation invalidate the list via
  the **`key[1] !== 'summary'` list-only predicate** AND the affected month's
  summary; a date-move invalidates **BOTH** old and new months via a `Set`
  (**W8**). `affectedMonth = occurred_at.slice(0,7)` copied (2 lines). 404 on
  update/delete refetches the lists. Delete's 204 path unwraps by hand (cannot use
  `throwOnError` — data is legitimately `undefined`), copied from web.
- **Category lookup (`data/categoryLookup.ts`)** — copy `buildCategoryIndex`
  (archived-inclusive id→category join, **W3**) + `sortForDisplay`
  (`Intl.Collator` within each kind group — **W11**, VERIFY under Hermes, Section
  E). `groupByDay` copied into `features/transactions/groupByDay.ts`.
- **QueryClient policy (`lib/queryClient.ts`, app-owned)** — `retry`: never retry
  4xx (`ApiError` with `400 ≤ status < 500` → false; a 401 that reaches Query means
  refresh already failed), retry transient 5xx/**network** up to 2× (O7's
  flaky-network stance — network errors have no `ApiError`, so they retry).
  `refetchOnReconnect: true` (mobile connectivity flaps — recover automatically),
  `refetchOnWindowFocus` is a no-op on RN. `staleTime`: 30s default, 60s for
  categories, mirroring web's per-query overrides. Offline is a state, not a crash:
  cached data renders while a refetch is in flight; a `net.isConnected`-less MVP
  relies on Query's `isFetching`/`isError` + retry rather than an offline banner
  (no offline sync — deliberate post-MVP per agent rules).

Consumes from `@budget/api-client` (post-promotion, per architect Q1/Q3):
`ApiError`, `throwOnError`, `buildCategoryPatch`, `buildTransactionPatch`,
`emptyToNull`, `getErrorCode`, `getValidationIssues`, `locTailField`,
`routeIssue`, `ValidationIssue`, `FieldError`. **Contingency (S1 flagged open
question):** if senior-lead/PM holds S1's literal "byte-identical" line and
rejects the api-client promotions, these modules are instead COPIED into
`apps/mobile/src/lib/{patch.ts,errorNarrow.ts,apiError.ts}` with the same
conformance-checklist gate. My data/error code imports from a single local barrel
so this contingency is a one-line import swap, not a rewrite.

## Platform concerns

- **Permissions**: none required for MVP. No camera/photo (receipt photos are out
  of 1.8 scope), no location, no notifications. `expo-secure-store` needs no
  runtime permission (Keychain/Keystore). If PM later adds receipts, that is a
  separate task with the image-permission + presigned-upload flow.
- **Secure storage**: tokens live in `expo-secure-store` **only**, never
  AsyncStorage (agent rule + O2). iOS Keychain / Android Keystore-backed. Note:
  `expo-secure-store` values are size-limited (~2 KB) — JWT pairs are well under.
- **iOS vs Android**: Android hardware **back button** on the login screen must not
  escape into the protected group — the `(app)` guard's `<Redirect>` handles the
  reverse; on the auth screens back is the OS default (exit app from login root,
  acceptable). iOS **swipe-back** disabled on the login/register root via
  `gestureEnabled:false` so a user can't swipe out of an unauthenticated modal into
  nothing. Status-bar/**notch**: every screen wraps content in `SafeAreaView` /
  `useSafeAreaInsets`; the Tabs bar respects the bottom inset automatically.
- **Keyboard**: every form screen (login, register, transaction, category) uses
  `KeyboardAvoidingView` (`behavior:'padding'` iOS / `'height'` Android) inside a
  `ScrollView` with `keyboardShouldPersistTaps:'handled'` (the shared
  `KeyboardAwareForm`), so the amount/note/password fields aren't covered.
- **Native modules touched** (need senior-lead approval — Section H flags each):
  `expo-secure-store`, `@react-native-community/datetimepicker`,
  `expo-haptics`, `expo-localization`. All are Expo-Go/dev-client compatible; no
  eject.
- **Hermes verifications** (grounded, not assumed): the 0.1 canary proved
  `Intl.NumberFormat`. This task adds two runtime verifications on-device
  (Section E `Intl.Collator`, Section A `Request.clone()`); both have committed
  fallbacks so implementation never blocks on the spike outcome.

## UI states

- **Login / Register**: idle → submitting (button spinner, inputs disabled) →
  error (field-routed via zod + a form-level `describeAuthError` message with a
  **retry affordance**, incl. the network arm O7) → success (redirect). Empty n/a.
- **Transactions month screen**:
  - Summary header: loading (skeleton totals) / error ("Couldn't load this month's
    summary" + Retry) / success (income/expense/net + breakdown) — copied from web
    `SummaryHeader`, W3/W4.
  - List: loading (skeleton rows) / empty ("No transactions in {month}. Add your
    first one." + Add button) / error ("Couldn't load transactions." + Retry) /
    success (day-grouped FlatList, footer "Showing N of total" + load-more).
  - Offline: cached month renders with `isFetching` spinner; on refetch error the
    stale list stays visible with an inline error+Retry rather than blanking.
- **Transaction form modal**: create-degraded state while summary currency
  resolves (submit disabled, "Loading account currency…", W7); submitting; field
  + form errors via `describeTransactionError`; delete confirm (Section E).
- **Categories screen**: loading (skeleton) / empty ("No categories yet") / error
  (Retry) / success (kind-grouped SectionList).
- **Category form modal**: submitting; field/form errors via
  `describeCategoryError`; archive/unarchive confirm; live hex swatch preview
  guarded by `HEX_COLOR_PATTERN` (AM-hex).

---

## A. Auth coordinator (`apps/mobile/src/auth/`) — O1–O7

**O1 — copy, don't share.** `coordinator.ts` re-implements single-flight refresh +
reactive-only 401→refresh→retry, reusing ONLY `login/refresh/logout/register` +
`getErrorCode` from `@budget/api-client` and `loginFormSchema`/`registerFormSchema`
from `@budget/shared`. No `auth-core` package. The auth endpoints bypass
`authFetch` structurally (they run on the plain `authClient` with no custom fetch),
same two-client design as web (`lib/api.ts`).

**O2 — async-hydrate-once + splash gate.** `secureStore.ts` exposes async
`hydrate(): Promise<TokenPair|null>`, `write`, `clear` over
`SecureStore.getItemAsync/setItemAsync/deleteItemAsync` (single JSON key
`budget.auth`, `isTokenPair` runtime narrow copied from web `storage.ts`).
`createCoordinator` starts in a `hydrating` state; `app/_layout.tsx` keeps the
Expo splash visible (`SplashScreen.preventAutoHideAsync()` at module load, and the
root awaits `coordinator.ready` then `SplashScreen.hideAsync()`). After hydration
resolves, `getAccessToken()`/`getSnapshot()`/`hasToken()` are **synchronous** reads
of the in-memory mirror — the guard never awaits. Writes are memory-sync +
`await SecureStore.setItemAsync` **inside** the already-async login/refresh/logout
(no new async surface). Tokens in secure-store ONLY.

**O3 — single-flight is the entire concurrency story.** Port web's `inFlight`
promise + `runRefresh` verbatim, **minus** everything cross-tab: no
`LockManager`/`runExclusive`, no `storage.subscribe`, no stored-pair re-read/adopt
double-spend guard, no cross-tab logout. One runtime, one process. Reactivity via a
`Set<listener>` + `useSyncExternalStore` over the mirror (web's `subscribe`/
`notify`). `wasSessionExpired()` flag retained for the guard's `reason=expired`
redirect.

**O4 — VERIFY RN Request/body semantics (SPIKE = implementation step 1; findings
recorded in `.tasks/mobile-mvp/spike-request-clone.md`).**
Grounding already done by code-read: openapi-fetch **0.17.0** (pinned in
`packages/api-client/package.json`, identical to web; verified installed) builds
`new Request(url, requestInit)` at `src/index.js:120` and calls
`fetch(request, requestInitExt)` at line 171 — so **(a) the injected fetch's first
arg is a `Request` under RN too** (this is library code, not platform code). The
`authFetch(input: Request)` seam therefore holds structurally. What remains
genuinely uncertain is **(b) whether RN/Hermes `Request.clone()` preserves an
un-sent JSON body** (RN's `fetch`/`Request` come from a whatwg-fetch-derived
polyfill, not the browser's native implementation, and have a documented history
of body-clone quirks).

Spike procedure (dev client against the local API :8010):
1. Inject a probe fetch into `createApiClient` and, on the first protected call,
   assert `input instanceof Request`, log `input.url`/`input.method` — confirm (a)
   on-device.
2. Build `const r = new Request(url, {method:'POST', headers:{'Content-Type':
   'application/json'}, body: JSON.stringify({probe:1})})`; do
   `const c1 = r.clone(); await fetch(c1);` then `const body = await
   r.clone().text();` and assert `body === JSON.stringify({probe:1})`. Pass = clone
   preserves an un-sent body across a send; fail = body empty/consumed.
3. Record outcome in the task dir.

**Commitment: the captured-init rebuild is the DEFAULT** unless step 2 proves
`clone()` sound. Rebuild design (no `clone()` dependency): at `authFetch` entry,
read the body **once** via `const bodyText = input.body ? await input.text() : null`
(auth endpoints never reach here, so bodies are JSON or empty — no FormData/stream
edge), capture `input.method`/`input.url`/headers, then build **fresh** `Request`
objects from `(url, {method, headers, body: bodyText})` for both the initial send
and the 401 retry. A plain JS string body is replayable with certainty. If step 2
passes, use web's `input.clone()`-before-send verbatim instead.

**O5 — AppState resume.** `resume.ts` wraps `AppState.addEventListener('change',
…)`, injected into the coordinator. On `active` resume, re-evaluate: if `inFlight`
is non-null the JS thread may have been suspended mid-refresh — we do **not**
start a second refresh (single-flight still holds; the awaiters resolve when the
suspended promise settles). We additionally `notify()` so any subscriber
re-reads the current snapshot (a refresh that terminally failed while backgrounded
already cleared the mirror; the guard reacts on resume). No proactive
exp-decode timer — refresh stays **reactive-only** (a stale token is discovered by
the next 401).

**O6 — navigation stays in React.** The `authFetch` wrapper **only** clears the
mirror + `notify()` on terminal failure — it NEVER navigates imperatively. The
`(app)/_layout.tsx` guard subscribes via `useSyncExternalStore` and renders
`<Redirect>` when the snapshot is false, appending the intended route as a
**typed route param** `next` (RN analogue of web's `?next=`), plus
`reason=expired` when `coordinator.wasSessionExpired()`. `next.ts` ports web's
`safeNextRoute` (must be a local in-app href; reject anything else → default authed
route). Login/register screens are deep-link-safe: they read `next` from params
only.

**O7 — app-owned error copy incl. network arm.** `auth/errors.ts`
`describeAuthError(error)` maps `getErrorCode` (`LOGIN_BAD_CREDENTIALS`,
`REGISTER_USER_ALREADY_EXISTS`, `REGISTER_INVALID_PASSWORD`, `RATE_LIMITED`, …) to
copy, with a **mandatory network arm** (`!(error instanceof ApiError)` →
"Can't reach the server. Check your connection and try again."). Every auth
mutation surfaces a **visible, retryable** error (the submit button stays enabled
after failure; error text renders inline) — not a dead end.

## B. Navigation — decision

**Tabs for the app shell, Stack for auth, modal Stack screens for forms.
Recommended.**

Justification: the app has exactly two peer destinations (Transactions,
Categories) that a user switches between freely — the textbook Tabs case, and it
mirrors web's persistent top-nav. Auth is a linear Stack (login ↔ register). Forms
are **modal** screens (`presentation:'modal'`) rather than inline, because they're
transient create/edit tasks over a list — matching web's `<Modal>` and giving iOS
the swipe-down dismiss for free. Route groups `(auth)` and `(app)` keep the
protected boundary in one `_layout.tsx`. **Protected-route gating is on the
synchronous coordinator snapshot** (`useIsAuthenticated`), never on the `me` query
(navigation must not block on a round-trip — the whole point of O2's sync mirror).
The modal form screens live **inside** `(app)` so they're behind the same guard.

Alternative rejected: a single Stack with a manual segmented header (more code,
loses native tab affordances, worse for thumb reach). Drawer rejected (two
destinations don't warrant it).

## C. API base URL dev convention

Dev API is `:8010`. **Recommendation: derive the host from Expo's Metro
`hostUri` at dev time, with an `EXPO_PUBLIC_API_URL` explicit override that always
wins.** `lib/baseUrl.ts`:

1. If `process.env.EXPO_PUBLIC_API_URL` is set → use it verbatim (dev override +
   the **required** production/EAS value; the base URL is the ONLY config the
   client holds).
2. Else in `__DEV__`, read `Constants.expoConfig?.hostUri` (fallback
   `Constants.expoGoConfig?.debuggerHost`), take the host before `:`, and build
   `http://<host>:8010`. This is the dev machine's LAN address that Metro is already
   serving from, so a **physical device via Expo Go on the same Wi-Fi reaches it**,
   and the **iOS simulator** — which shares the Mac's network — also reaches it
   (and `localhost:8010` would work on the simulator too, but the derived host is a
   single code path for both).
3. Else (no override, no Metro host, e.g. a bare release build without
   `EXPO_PUBLIC_API_URL`) → throw a clear "set EXPO_PUBLIC_API_URL" error at client
   construction (mirrors web's `VITE_API_URL` guard).

**Honest failure modes:** (a) a physical device on a **different network** than
the Mac cannot reach the derived LAN host — documented; workaround is
`EXPO_PUBLIC_API_URL` with a tunnel/reachable host. (b) `hostUri` is **absent** in
some dev-client/tunnel configurations → step 3 throws; set the override. (c) The
API binding to `127.0.0.1` only (not `0.0.0.0`) would refuse the LAN connection
from a device — a backend/run-config note for mobile-qa, not a client bug. The
simulator path (localhost-reachable) is the always-works baseline the brief asks us
to be honest about; the device path requires same-network + reachable bind.

No secrets in the bundle or `app.json` — only the API base URL and the user's
tokens (agent rule).

## D. Data layer — see "Data layer" section above

Discharges AM-1.6-a/b (`queryKeys.ts`), W6/W8 + dual-month + list-only predicate
(`transactions.ts`), W3 + Uncategorized (`categoryLookup.ts`/`SummaryHeader`), W7
(no currency in forms; render from `tx.currency`/`summary.currency`), W5 (default
kind from `category.kind` by direct assignment; no cross-enum `Kind` alias).
QueryClient policy is app-owned with mobile-appropriate retry/`refetchOnReconnect`
and O7's flaky-network stance (network errors retry; 4xx never).

## E. Screens / forms

**Form library: react-hook-form + `@hookform/resolvers/zod`. Recommended.** RHF is
platform-agnostic; RN `TextInput` is wrapped with RHF `Controller`. This gives
**exact parity** with web: the SAME `transactionFormSchema`/`categoryFormSchema`
from `@budget/shared`, the SAME `zodResolver`, the SAME `""` empty-string sentinel
(RN `TextInput` holds `""` naturally; the promoted `emptyToNull`/patch builders
interpret it — architecture.md ruling). Alternative (plain `useState` + manual zod
`.safeParse`) rejected: it forks the validation-wiring web already proved and adds
per-field error plumbing for no benefit. Either way form values conform to the
shared schemas.

**Transactions month screen** (`(tabs)/transactions.tsx` + `features/transactions/*`):
- `MonthPicker` — prev/next chevrons + `formatMonthLabel(month)`; shifts via
  `shiftMonth`; month is local `useState` seeded from `currentMonth()` (AM-schemas
  month helpers — no forked month math).
- `SummaryHeader` — copy web: income/expense/net via `formatMoney` incl. the signed
  `net_minor` (**W4** — never `toInputString` on a signed value); per-category
  breakdown joined against the **archived-inclusive** index, `null` bucket →
  "Uncategorized", composite key `` `${category_id ?? 'uncategorized'}:${kind}` ``
  (**W3** — refund repeats a category_id under both kinds).
- `TransactionList` — **`FlatList`** (never `.map` in a ScrollView — agent rule),
  `keyExtractor={t => t.id}`, day-grouped via `SectionList` **or** flattened
  `FlatList` with day-header rows; I'll use `SectionList` seeded by `groupByDay`
  (preserves server occurred_at-DESC order, no re-sort). `onEndReached` →
  `fetchNextPage` (load-more), footer count "Showing N of total". `TransactionRow`
  **memoized** (`React.memo`) — sign carried by kind (expense negative/red, income
  positive/green) via `formatMoney(signedMinor, tx.currency)` (**W4/W5/W7**).
- **Transaction form** (`transaction-form.tsx`) — amount `TextInput`
  `keyboardType:'decimal-pad'` through `moneyAmountSchema` (magnitude only,
  **parseMoney minor units, W4**); **kind = a SEGMENTED control** (`KindSegmented`,
  expense | income) — **AM-1.6-c**; the category picker shows the **selected kind's
  categories** (kind-segmented, *never* described as "filtered"), picking a category
  sets kind by direct assignment (**W5**), flipping the segment clears a selected
  category whose kind no longer matches (mirror web `onKindChange`); date field via
  the native picker (below); note `TextInput` `maxLength=500` `multiline`. Create
  body uses `emptyToNull` for `category_id`/`note`; edit uses `buildTransactionPatch`
  (**W1** — omit-vs-null discipline via the promoted builder); delete confirm below.
  Currency **never collected**, sourced from `tx.currency` (edit) or the month
  summary (create; degraded until it resolves — **W7**).

**Date picker: `@react-native-community/datetimepicker`. Recommended (flag for
senior-lead approval as a native module).** It's the Expo-supported, config-plugin
date/time picker, works in Expo Go and dev client, renders the native iOS/Android
pickers, and stores/returns a JS `Date` we convert with `toApiDate`/`todayApiDate`
(TZ-safe, no ISO-string parse — AM-schemas). Alternative (a masked `TextInput`
`YYYY-MM-DD`) rejected for UX and error-proneness; kept as the zero-native-module
fallback if approval is withheld. The picker is presented on tap (Android shows the
dialog; iOS shows an inline/spinner in the modal).

**Categories screen** (`(tabs)/categories.tsx` + `features/categories/*`):
- `CategoryList` — **`SectionList`** grouped by kind (Expense then Income),
  pre-sorted by `sortForDisplay` (locale-aware within group). `CategoryRow`
  memoized: swatch (`category.color`, fallback grey), icon, name, Archived/System
  tags. **`is_system` gates edit/archive affordances** — a system row is
  non-interactive (no press); server 403 is the backstop (**W9**). No DELETE.
- **Category form** (`category-form.tsx`) — name/kind(segmented)/icon/color; archive
  is `useUpdateCategory` `{archived}` behind a confirm (**W9**); **color compared
  case-insensitively** in the patch builder (**W10**, already in
  `buildCategoryPatch`). Live swatch preview guarded by the **shared
  `HEX_COLOR_PATTERN`** (`HexSwatch` component) — **AM-hex**: the pattern is
  EXPORTED from `@budget/shared` now and web's local copy at
  `CategoryFormModal.tsx:36` dies in the same task (frontend-engineer owns the web
  side).

**W11 — `Intl.Collator` under Hermes VERIFY.** RN 0.86 / Expo 57 ship Hermes with
`Intl` (incl. `Collator`) enabled by default on both platforms, but the 0.1 canary
only proved `Intl.NumberFormat`. **How I verify:** add a `__DEV__` probe (alongside
the existing money canary) that runs
`new Intl.Collator(undefined,{sensitivity:'base'}).compare('Ё','Е')` and a small
sort of `['Z','a','Ё','Е']`, logging the result; mobile-qa confirms it on **both**
iOS and Android in Section A. **Fallback if unsupported or divergent:**
`sortForDisplay` degrades to `a.name.localeCompare(b.name, undefined,
{sensitivity:'base'})` (also Hermes-Intl-backed), and if that is also unavailable,
a plain code-point `<` compare with a recorded caveat. `sortForDisplay` isolates
this in one function so the fallback is a single edit.

**Delete / archive confirm + haptics.** Destructive actions confirm via
`Alert.alert` (native, accessible, zero custom UI, two-button destructive style);
on confirm, `expo-haptics` `notificationAsync(Success)` for the key confirmation
(agent UX baseline). Touch targets ≥ 44pt (button `minHeight:44`). Open question
for PM: native `Alert` vs a custom bottom-sheet confirm (I recommend `Alert` for
MVP).

## F. Test-runner story (S4 — decided now)

**Decision: single runner — plain `vitest`, scoped to pure TypeScript. Do NOT
adopt jest-expo in 1.8. RN-rendering journeys fall to mobile-qa on the simulator
(their Section A).**

What runs in **vitest** (Node/V8, no RN/expo import in the graph):
- `auth/coordinator.test.ts` — the coordinator core is **DI-architected** so it
  imports ONLY `@budget/api-client` (+ injected fakes for the storage adapter and
  resume subscription). Tests cover: hydrate-once → sync snapshot, single-flight
  dedup of concurrent 401s, 401→refresh→retry-once + second-401 passthrough,
  terminal-failure clears mirror + sets `wasSessionExpired`, logout revoke+clear.
  This is the exact web `coordinator.test.ts` shape minus cross-tab cases. **This is
  viable only because `coordinator.ts` never statically imports `expo-secure-store`
  or `react-native`** — those live in `secureStore.ts`/`resume.ts`, which the test
  never imports and instead replaces with fakes.
- `auth/errors.test.ts`, `data/errors.test.ts` — copy-table narrowing over
  `getErrorCode`/`getValidationIssues` (pure).
- Any copied pure helper with real branching (`safeNextRoute`, `groupByDay` if I
  keep a test). I will NOT re-test `qk` literals, `affectedMonth`, or `sortForDisplay`
  vacuously (per the standing "no vacuous tests" rule and architect Q2: the
  key-shape invariants are gated by the obligations checklist, not a literal-echo
  test).

What **cannot** run in vitest (imports `react-native`/`expo-router`/`expo-*`):
every screen, hook using RN components, the `secureStore.ts`/`resume.ts` adapters,
and `lib/baseUrl.ts` (imports `expo-constants`). These are **not** unit-tested in
this task.

What falls to **mobile-qa on the simulator** (their FIRST invocation, Section A
simulator journeys + Section B manual device checklist): auth login/register/logout
+ protected-redirect + `next` return-route, month list/summary/paging, tx CRUD with
the dual-month summary invalidation, category CRUD + is_system gating + archive, the
two on-device verifications (Request.clone spike outcome, Intl.Collator), and the
device-only base-URL/keyboard/safe-area/back-button checks.

**Why not jest-expo:** it buys only component-render tests, which for an MVP are
better exercised by mobile-qa on a real simulator (catches native layout/keyboard/
safe-area issues a jsdom-RN preset cannot). Adopting it costs a second runner, a
`babel.config.js` + `jest.config` + `transformIgnorePatterns` for the expo/RN
module soup, a second `turbo` test task, and CI time — real cost for marginal
coverage. If the app later grows complex pure-in-component logic, jest-expo can be
added in a dedicated task; the **promoted api-client/shared modules stay
vitest-tested inside their own packages regardless** (architect note).

**`src/wiring.test.ts` fate: DELETED.** Scaffold-lifetime rule (S4) — it exists
only to prove workspace resolution, which `coordinator.test.ts`/`errors.test.ts`
(real modules importing `@budget/api-client` + `@budget/shared`) now supersede.
The Hermes canary role it references stays with the running screen / the two new
`__DEV__` probes.

## G. UI stance

**Confirmed: React Native primitives only, no UI framework.** Consistent with web's
deliberate lib-free stance, keeps the bundle lean, avoids a native-module UI kit
(and its Expo-compat/approval burden), and the surface is small (two lists, four
forms, a segmented control, a swatch). I build the handful of shared primitives in
`src/components/` (`KindSegmented`, `KeyboardAwareForm`, `HexSwatch`, `FieldError`,
`FormButton`). No challenge — a UI framework would be net cost here.

## H. New dependencies (each justified; native modules flagged for senior-lead)

Runtime:
- `@budget/api-client` (`workspace:*`) — the ONLY way to call the API; adds the
  missing workspace edge to mobile (currently only depends on `@budget/shared`).
- `@tanstack/react-query` — server-state layer (match web's installed version).
- `expo-secure-store` — token storage (O2; **native module**, Expo-first, no
  runtime permission).
- `@react-native-community/datetimepicker` — date field (Section E; **native
  module**, Expo-Go/dev-client compatible; senior-lead approval requested).
- `react-hook-form` + `@hookform/resolvers` — forms with `zodResolver` + shared
  schemas (Section E; pure JS, no native module).
- `zod` — peer of `@hookform/resolvers/zod` and of `@budget/shared`'s schemas
  (pin to shared's version to avoid a duplicate).
- `expo-haptics` — key-confirmation haptics (agent UX baseline; **native module**,
  Expo-first).
- `expo-localization` — explicit locale for `formatMoney`/date helpers
  (the shared modules' documented mobile expectation for Android reliability;
  **native module**, Expo-first). *Optional* — droppable if PM prefers host-default
  locale; I recommend including it.

NOT added: `jest-expo` (Section F), `@react-native-async-storage/async-storage`
(tokens go to secure-store only), any UI framework (Section G).

## I. Obligation coverage table

| ID | Discharged by |
|---|---|
| O1 | A (coordinator.ts copy; reuse only helpers/schemas; no auth-core) |
| O2 | A (secureStore.ts async hydrate-once + splash gate; sync snapshot after) |
| O3 | A (single-flight `inFlight` only; no cross-tab machinery) |
| O4 | A (spike step 1 + code-grounded Request finding; captured-init rebuild default) |
| O5 | A (resume.ts AppState re-evaluation; reactive-only) |
| O6 | A + B (React guard `<Redirect>`, typed `next` param, authFetch never navigates) |
| O7 | A (auth/errors.ts app-owned copy incl. network arm + retry affordance) |
| AM-1.6-a | D (queryKeys.ts: offset is pageParam, not a key member) |
| AM-1.6-b | D (single archived-inclusive categories cache; client-derived views) |
| AM-1.6-c | E (kind-SEGMENTED picker; "filtered" wording avoided) |
| AM-schemas | E (shared transaction/category schemas + month helpers; no fork) |
| AM-hex | E (HEX_COLOR_PATTERN exported from shared; HexSwatch guard; web copy dies) |
| W1 | E/D (buildTransactionPatch/buildCategoryPatch + emptyToNull, single builders) |
| W2 | D/E (getErrorCode + runtime getValidationIssues narrow; code table in data/errors.ts) |
| W3 | D/E (archived-inclusive index, Uncategorized, composite `id:kind` key) |
| W4 | E (formatMoney incl. signed net; parseMoney minor units; no toInputString on signed) |
| W5 | E/D (kind from picked category.kind by direct assignment; no cross-enum alias) |
| W6 | D (limit in filter slice; has_more derived `loaded < total`) |
| W7 | E (no currency collected; render from tx.currency/summary.currency) |
| W8 | D (list-only `key[1]!=='summary'` predicate + dual-month summary invalidation) |
| W9 | E (is_system gates edit/archive; archive=PATCH{archived}; no DELETE) |
| W10 | E (case-insensitive color compare in buildCategoryPatch) |
| W11 | E (Intl.Collator Hermes VERIFY + localeCompare/code-point fallback) |
| A-1 | A (login via shared `login()` helper; never re-derive form-encoding) |
| S1 | Data layer note (contract untouched; consumes promoted api-client modules; copy contingency) |
| S2 | This file is `plan-mobile.md`, not `plan.md` |
| S3 | Lint/typecheck/test gate run for @budget/mobile (+ shared/web on the AM-hex & promotion moves) before "done" |
| S4 | F (vitest-only decided now; wiring.test.ts deleted) |
| S5 | Approach (no shared package created; copy-the-pattern per architect) |
| S6 | C (dev API :8010; simulator vs Expo-Go device honestly stated) |

*No ID is marked n/a.*

## J. Open questions for the PM (each with my recommendation)

1. **api-client promotions vs S1 literal wording** (architect's flagged Q1/Q3):
   patch builders + envelope-narrow helpers + `ApiError`/`throwOnError` land in
   `@budget/api-client`. *Recommend:* approve the S1 amendment already recorded in
   obligations.md (`src/generated/**` byte-identical; existing exports unchanged) —
   my code imports them from api-client. *Either/or:* if you hold the literal line,
   I COPY them into `apps/mobile/src/lib/*` (one-line import swap in my plan; no
   rewrite).
2. **Navigation shape** — Tabs (app) + Stack (auth) + modal forms, *recommended*,
   vs a single Stack with a segmented header. *Recommend Tabs.*
3. **Date picker** — `@react-native-community/datetimepicker` (native module,
   Expo-Go compatible), *recommended*, vs a masked `YYYY-MM-DD` `TextInput`
   (zero native module, worse UX). *Recommend the community picker* — needs your +
   senior-lead's native-module approval.
4. **Form library** — react-hook-form + zodResolver (web parity), *recommended*,
   vs controlled `useState` + manual `safeParse`. *Recommend RHF.*
5. **Test-runner shape** — vitest-only for pure TS + mobile-qa on simulator,
   *recommended*, vs adding jest-expo now. *Recommend vitest-only* (jest-expo cost
   outweighs MVP benefit; revisit in a later task).
6. **Base-URL convention** — derive host from Expo `hostUri` + `EXPO_PUBLIC_API_URL`
   override, *recommended*, vs `EXPO_PUBLIC_API_URL`-only (explicit, but every dev
   must set it and it can't distinguish simulator/device). *Recommend derive +
   override.*
7. **Destructive-confirm UX** — native `Alert.alert` (+ haptics), *recommended*,
   vs a custom bottom-sheet confirm. *Recommend Alert for MVP.*
8. **`expo-localization`** — include it to pass an explicit locale to
   money/date helpers (Android reliability, per the shared modules' documented
   expectation), *recommended*, vs relying on Hermes host-default locale. *Recommend
   include.*
9. **Where the summary lives** — a header card above the transaction list on the
   Transactions tab, *recommended* (mirrors web), vs a separate tab/screen.
   *Recommend header card.*

## Risks

- **`Request.clone()` on Hermes** (O4) — the single biggest unknown; mitigated by
  the captured-init-rebuild default so implementation never blocks on the spike.
  Needs a real device/simulator check, not just the simulator.
- **Base-URL on a physical device** — reachable only same-network + API bound to
  `0.0.0.0`; a dev-environment footgun, not a code bug. mobile-qa Section B must
  test on a device, not only the simulator.
- **Keyboard/safe-area on real hardware** — `KeyboardAvoidingView` behaviour
  differs iOS vs Android; the amount/note fields on small screens need a device
  check.
- **`Intl.Collator` divergence** (W11) — low risk (Hermes ships it) but must be
  confirmed on both platforms; fallback isolated in `sortForDisplay`.
- **Cross-package promotion timing** — my data/error/form code depends on the
  frontend-engineer landing the api-client promotions + the AM-hex export in this
  same task; if sequencing slips I use the copy contingency (open question 1). S3's
  regression gate (web suite green) must pass after the AM-hex + promotion moves.
- **Android back button on protected↔auth transitions** — needs explicit testing
  (guard `<Redirect>` + `gestureEnabled:false` on auth root).
