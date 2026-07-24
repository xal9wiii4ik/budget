# /review_senior — mobile-mvp (1.8), independent line-by-line pass

Reviewer: code-reviewer. Reviewed: UNCOMMITTED working tree vs HEAD ed51ea0 — layer 1
(api-client/shared promotions + web re-pointing) and layer 2 (apps/mobile, 49 files).
All findings re-derived from source; the senior diff gate's verdicts were not assumed.
Sanity gate re-run by me: mobile 28/28, api-client 14/14 (+typecheck), web 23/23,
shared 36/36, `tsc --noEmit` clean for @budget/mobile.

## VERDICT: APPROVE-WITH-FIXES

Finding 1 must land (with its regression test) before commit; it is localized to
`coordinator.ts` and the fix direction is unambiguous. Everything else is minor/nit.

---

## Findings

### 1. MAJOR — coordinator: an abandoned refresh flight that later settles applies stale results and breaks single-flight

`apps/mobile/src/auth/coordinator.ts:164-175, 181-183, 281-287`

The R3 resume-timeout deliberately abandons a stranded in-flight refresh
(`inFlight = null` at :285). R3's own rationale assumed the stranded promise never
settles. But "stranded" is a *guess* made after a 4s race — the OS may merely have
delayed the request, and RN's fetch may settle it seconds later. When it does, two
things go wrong, because `runRefresh` and the `.finally` were copied from web
*minus* the identity guard web had:

- **a) Stale writes.** `runRefresh` applies its outcome unconditionally. A
  late-settling abandoned flight F1 will `setTokens(result.data)` (:173) — clobbering
  a newer state: tokens rotated by a replacement flight F2, a *fresh login's* pair,
  or the `null` written by an intervening `logout()` (a resurrected "zombie" session
  in memory AND secure-store — an auth-invariant violation). Its failure arm (:169-170)
  is equally unguarded: a late terminal failure sets `sessionExpired = true` and
  clears the mirror even though F2 *succeeded* meanwhile → spurious logout with a
  false "session expired" banner.
- **b) Single-flight breach.** `refresh()` registers
  `inFlight = runRefresh(...).finally(() => { inFlight = null; })` (:181-183). The
  clear is unconditional, so when abandoned F1 finally settles it nulls **F2's**
  registration while F2 is still running. The next 401 then starts F3 *concurrent
  with F2*, and — since F2 hasn't rotated yet — F3 spends the SAME refresh token
  (`current?.refresh_token`, :179). That is precisely the refresh-token double-spend
  the web coordinator's post-lock re-read guard existed to prevent
  (`git show HEAD:apps/web/src/auth/coordinator.ts`, the `stored.refresh_token !==
  triggeringRefreshToken` adopt branch). O3 deleted that guard as "cross-tab
  machinery", which was sound — until R3's abandonment re-created in-process
  concurrent flights. The two rulings interact; neither the gate's O5/R3 tick nor
  the test suite covers the interaction (the R3 test at `coordinator.test.ts:322`
  uses a promise that literally never settles, so the late-settle arm is dead ground).

**Fix (small, local):**

```ts
// refresh(): identity-guard the clear
const flight: Promise<boolean> = runRefresh(triggeringRefreshToken).finally(() => {
  if (inFlight === flight) inFlight = null;
});
inFlight = flight;

// runRefresh(): bail before applying a stale outcome (both arms)
const result = await authRefresh(authClient, triggeringRefreshToken);
if (current?.refresh_token !== triggeringRefreshToken) {
  // Mirror moved on while we were in flight (logout, new login, or a fresh
  // refresh after this flight was abandoned on resume) — do not apply.
  return current !== null;
}
```

Add a vitest case: flight F1 hangs, resume-timeout abandons it, F2 refreshes
successfully, then F1 settles (success in one case, failure in the other); assert
tokens remain F2's, `inFlight` is not clobbered, and `wasSessionExpired()` stays
false. (Obligations: O3, O5/R3; also touches O2's storage-consistency intent.)

### 2. MINOR — guard's `next` drops query params: expired-session on an edit modal silently reopens as CREATE

`apps/mobile/app/(app)/_layout.tsx:14-17`

`usePathname()` returns the path without search params. A session expiring while on
`/transaction-form?id=X&month=Y` redirects with `next=/transaction-form`; after
re-login the user lands on the form with `id` absent → create mode (or the
"unavailable" state), a silent behavior change rather than a return to their edit.
O6 asks for the intended *route* to be preserved; params are part of it here.
Fix: rebuild the full href (`usePathname()` + `useGlobalSearchParams()` serialized),
or map modal routes to their parent tab before encoding `next`.

### 3. MINOR — `safeNextRoute` crashes on a repeated `next` param (the deep-link validator is itself deep-link-fragile)

`apps/mobile/src/auth/next.ts:12-16`, consumed at `app/(auth)/login.tsx:39`,
`register.tsx:34`

`useLocalSearchParams` yields `string[]` when a param repeats
(`...login?next=/a&next=/b`); the generic type annotation hides this from tsc. An
array is truthy, so `next.startsWith('/')` throws a TypeError at runtime — a red
screen from a crafted link, in the exact function whose job is O6 deep-link safety.
Fix: first line `if (typeof next !== 'string') return DEFAULT_AUTHED_ROUTE;` (and a
one-line test). (O6.)

### 4. MINOR — icon field errors are routed but never rendered

`apps/mobile/app/(app)/category-form.tsx:163-175`

`describeCategoryError` can return `field: 'icon'` (CATEGORY_FIELDS includes it,
`src/data/errors.ts:19`), and the submit handler then calls `setError('icon', ...)`
(:107) — but the icon `LabeledInput` is the only field not passed an `error` prop,
so a server-routed 422 on icon shows nothing: the form just doesn't close, with no
visible reason. Violates the O7-adjacent "visible, retryable" discipline the rest of
the forms follow. Fix: `error={errors.icon?.message}`. (W2 routing surface.)

### 5. MINOR — `refetchOnReconnect: true` is inert on RN; the comment claims recovery it doesn't deliver

`apps/mobile/src/lib/queryClient.ts:7, 19`

TanStack Query's `onlineManager` has no reconnect signal on React Native unless it
is wired to NetInfo; nothing in this diff wires it, so `refetchOnReconnect` never
fires and the header comment ("recover when connectivity flaps back") overstates
what ships. Actual recovery paths today are retry-on-fetch and pull-to-refresh —
fine for MVP, but the claim should match. Fix: either wire
`onlineManager.setEventListener` to `@react-native-community/netinfo` (a new native
dep — needs approval) or correct the comment and note recovery is manual. (O7's
flaky-network stance — honesty of the claim, not a behavior bug.)

### 6. MINOR — the captured-init rebuild silently drops `signal` (and all other RequestInit carry-overs)

`apps/mobile/src/auth/coordinator.ts:215-219`

Web's `input.clone()` preserved `AbortSignal`; the rebuild carries only
url/method/headers/body. No current mobile hook forwards a signal, so today this is
latent — but the moment anyone wires Query cancellation (or a timeout signal), aborts
will silently stop propagating and in-flight requests will outlive their screens.
Cheap now: pass `signal: input.signal` into the initial-send rebuild (the RN
polyfill supports it), or at minimum document the dropped-fields contract in the O4
comment block so the next engineer doesn't assume clone-parity. (O4.)

### 7. NIT — `TimerSeam.clearTimeout` is dead surface; resume timers are never cleared

`apps/mobile/src/auth/coordinator.ts:49, 105-108, 281-287`

Production code never calls `clearTimeout`; a flight that settles within the grace
period still leaves its timer to fire as a no-op (guarded by `settled`), and each
resume stacks another. Harmless at 4s scale, but either clear the timer on settle
(`pending.finally(() => timers.clearTimeout(handle))`) or drop `clearTimeout` from
the seam — an injectable API nobody calls misleads the next reader.

### 8. NIT — row memoization is defeated by per-render closures

`apps/mobile/src/features/transactions/TransactionRow.tsx:93` /
`CategoryRow.tsx:90` vs `app/(app)/(tabs)/transactions.tsx:76` and
`(tabs)/categories.tsx:58`

`memo(...)` on the rows is neutralized because `onEdit` is a fresh inline lambda
every screen render, so every row re-renders anyway. Not a correctness issue and
list sizes are small; either `useCallback` the handlers or drop the `memo` +
"memoized" comments so the claim matches reality.

### 9. NIT — one unlocalized month label

`app/(app)/(tabs)/transactions.tsx:35` calls `formatMonthLabel(month)` without
`{ locale: APP_LOCALE }`, while `MonthPicker.tsx:26` passes it. The empty-state
sentence can render its month name in a different locale than the header above it.

### 10. NIT — stale module comment in web errors.ts

`apps/web/src/lib/errors.ts:1-8` still says this file "adds a RUNTIME narrow of the
422 body's ValidationError[] arm" — that narrow now lives in `@budget/api-client`.
Update the header to match the post-promotion shape (the mobile copy
`src/data/errors.ts:1-6` shows the right wording).

### 11. NIT — deep-linked edit of a system category renders a fully editable form

`app/(app)/category-form.tsx:138` gates only the archive affordance on `is_system`;
the row-level gate (`CategoryRow.tsx:33-35`) is the real W9 barrier, so this is
reachable only via a crafted in-app link. Server 403 + the
`SYSTEM_CATEGORY_READONLY` copy backstop it. A `category.is_system` read-only
render (or an upfront notice) would close it for one conditional. Acceptable per
R4's no-external-deep-link ruling; recording so the future deep-link trigger
re-opens it.

### 12. NIT — `router.back()` with a possibly empty stack

`app/(app)/transaction-form.tsx:88, 214` and `category-form.tsx:59, 104` call
`router.back()` unconditionally; a cold start directly into a modal href has no
back stack. Same R4 carve-out as #11; `router.canGoBack() ? router.back() :
router.replace('/transactions')` is the cheap hardening when a real deep-link
source appears.

### 13. NIT — hydration assignment would clobber a pre-`ready` login

`apps/mobile/src/auth/coordinator.ts:137-147` assigns `current = pair`
unconditionally when hydrate resolves. Today unreachable-in-anger: the splash gate
(`app/_layout.tsx:32`) keeps all UI (hence login) unmounted until `ready`. But the
coordinator is DI'd and consumed outside that gate's control; a
`if (current === null) current = pair` (or ordering assert) would make the
invariant local instead of depending on a caller. Fold into the finding-1 patch if
convenient.

---

## Verified correct (positively confirmed, not merely un-flagged)

**Layer 1 — promotions (S1 amended):**
- `packages/api-client/src/patch.ts` is byte-identical to HEAD web `lib/patch.ts`
  except the sanctioned `components` import re-point (:19) — diffed. `patch.test.ts`
  moved byte-identical — diffed, exit 0.
- `packages/api-client/src/errors.ts` — `ApiError`/`throwOnError`/`FetchResult`
  (:18-46) verbatim vs HEAD `lib/query.ts`; `getValidationIssues`/`locTailField`/
  `routeIssue` (:61-107) verbatim vs HEAD `lib/errors.ts`, `routeIssue` newly
  exported as planned; platform-free header present; no web/DOM global in the file.
- errors.test.ts split is LOSSLESS: HEAD had 6 cases; the 3 envelope-narrow cases
  moved to `packages/api-client/src/errors.test.ts:6-17`, the 3 copy-table cases
  stayed in `apps/web/src/lib/errors.test.ts:7-23`. No case lost, none duplicated.
- Barrel `packages/api-client/src/index.ts:18-21` — additive only; lines 1-16
  byte-identical to HEAD.
- S1 mechanics: `git status` on `src/generated/**` and `apps/api` = empty; the
  api-client→shared edge is `import type` only (`patch.ts:20`, `patch.test.ts:2` —
  grepped, no value import); `@budget/shared` added to `dependencies` (correct per
  plan-web item 5's public-signature ruling).
- Web re-pointing: `lib/query.ts:9-11` VALUE re-export shim (`export { ApiError,
  throwOnError } from '@budget/api-client'`) with `queryClient` retained and its
  retry closure using the imported class; both form modals import builders from
  `@budget/api-client`; `auth/errors.ts:1` consolidated onto the package specifier;
  zero leftover `lib/patch` imports anywhere in apps/web (grepped).
- AM-hex: `HEX_COLOR_PATTERN` exported at `packages/shared/src/schemas.ts:77` +
  barrel `index.ts:37`; web's local copy at CategoryFormModal deleted, import
  re-pointed (diff read); mobile's second consumer is `HexSwatch.tsx:5,17`.

**Layer 2 — auth (O1–O7):**
- O1: `coordinator.ts:12-18` imports ONLY `@budget/api-client`; no auth-core
  package; cross-tab machinery (locks, storage events, cross-tab logout) verified
  absent vs the web original.
- O2: async-hydrate-once (`coordinator.ts:137-147`) behind the splash gate
  (`app/_layout.tsx:17, 24-32` — `preventAutoHideAsync` at module load, UI renders
  null until `ready`); post-hydration reads are sync; writes are memory-sync +
  awaited secure-store inside async flows (`setTokens:129-133` awaited at
  :170/:173/:241/:255). Tokens ONLY in expo-secure-store (`secureStore.ts:8` is the
  sole importer; no AsyncStorage anywhere — grepped).
- Secure-store adapter robustness: `secureStore.ts:28-38` — try/catch around read +
  `JSON.parse`, `isTokenPair` runtime narrow; corrupt value → logged-out, no crash.
- O3 happy paths: single-flight dedup, settle-then-new-flight, terminal-failure
  clear+flag+notify — all confirmed in code AND covered
  (`coordinator.test.ts:128-184`).
- O4: captured-init rebuild with METHOD-based body decision
  (`coordinator.ts:205-219`) — `.body` never consulted; GET/HEAD never read;
  `'' → null → undefined` so a bodyless rebuild sends no `''`. Bearer set on a
  FRESH `Headers` copy per attempt (:216-217) so the retry carries the rotated
  token and Content-Type survives (asserted end-to-end in
  `coordinator.test.ts:189-232`). The RN-polyfill tripwire (:234-265) is honest:
  its fake has `body: undefined` + working one-shot `text()`, and asserts the
  payload on BOTH legs — it genuinely fails against a `.body`-gated
  implementation. Loop guard (second 401 returned as-is) and /auth-path exclusion
  covered (:267-298).
- O5: resume seam fires only on background/inactive→active (`resume.ts:13`);
  reactive-only (no exp-decode timer anywhere); R3 timeout race implemented and
  its two committed arms tested (`coordinator.test.ts:321-405`) — the *third* arm
  (late settle) is finding 1.
- O6: `authFetch` contains zero navigation; guard redirects via `<Redirect>` with
  `next` + conditional `reason=expired` (`(app)/_layout.tsx:16-19`); modals live
  inside the guarded group (:25-26); login/register read `next` from params only;
  `safeNextRoute` rejects `//host`, schemes, and backslash bypass with tests
  (`next.test.ts:5-24`, modulo finding 3).
- `wasSessionExpired` lifecycle: set only on terminal refresh failure (:169),
  reset on login (:240) and logout (:246), never by cold start — and the logout
  path confirmed non-expired in `coordinator.test.ts:304-316`.
- O7: network arm present and TESTED in all three copy tables
  (`auth/errors.test.ts:34`, `data/errors.test.ts:17, 37`); auth submit buttons
  re-enable after failure (pending is mutation-scoped); register duplicate routes
  to the email field (R9 arm, `auth/errors.test.ts:13`);
  `RegisterLoginFailedError` hand-off to /login prefilled without re-registering
  (`useAuth.ts:47-51`, `register.tsx:36-47`).
- A-1: login/refresh/logout go through the shared helpers exclusively
  (`coordinator.ts:165, 236, 250`); encoding never re-derived.
- Two-client wiring: auth endpoints structurally bypass authFetch (`lib/api.ts:16`
  plain client vs :24-27 protected client).

**Layer 2 — data (AM/W):**
- AM-1.6-a/b: `queryKeys.ts` is web's file verbatim modulo comments (diffed);
  offset is pageParam only; single archived-inclusive categories cache with
  in-place update by id on create/update (`categories.ts:38-40, 56-58`).
- W6: `limit` in the stable slice (MONTH_LIMIT=200 shared by tab and modal for an
  identical key — `transactions.tsx:22`, `transaction-form.tsx:65`); `has_more`
  derived `loaded < total` (`transactions.ts:54-58`).
- W8: list-only predicate `key[0]==='transactions' && key[1]!=='summary'`
  (`transactions.ts:36-41`); dual-month Set on update (:107-113); create/delete
  invalidate list + affected month; 404 on update/delete refetches lists
  (:118-122, :145-149). Delete unwraps the 204 by hand as ruled (:129-138).
- W3: archived-inclusive `buildCategoryIndex` join; `null` bucket →
  "Uncategorized"; composite key `${category_id ?? 'uncategorized'}:${kind}`
  (`SummaryHeader.tsx:26-28, 83-89`); row-level Unknown-category fallback
  (`TransactionRow.tsx:26-27`).
- W4: every render via `formatMoney` incl. signed net (`SummaryHeader.tsx:59, 74`);
  `toInputString` used ONLY on the magnitude `amount_minor`
  (`transaction-form.tsx:126`); amounts go through `moneyAmountSchema` inside the
  shared `transactionFormSchema`; no float math anywhere in apps/mobile (grepped
  for arithmetic on money paths; sign flip is integer negation,
  `TransactionRow.tsx:25`).
- W5: picking a category assigns `kind` directly from `category.kind`
  (`transaction-form.tsx:176-180`); kind flip clears a mismatched category
  (:169-174); no alias spanning the two GENERATED enums (KindSegmented's local UI
  literal union is not derived from either).
- AM-1.6-c: the picker is kind-segmented via `KindSegmented` + per-kind chip list;
  the word "filtered" appears nowhere in a picker context (grepped).
- W7: no currency input exists in any form; create is degraded (submit disabled +
  notice) until the summary currency resolves (`transaction-form.tsx:115-117, 244,
  340`); rows render `tx.currency`, summary renders `summary.currency`.
- W9: system rows non-interactive (`CategoryRow.tsx:33-35`); archive gated on
  `!is_system` (`category-form.tsx:138`); archive = PATCH `{archived}` behind
  confirm, unarchive confirm non-destructive (`confirm.ts:27`); NO category DELETE
  anywhere (grepped); no client-side dedup pre-gate (409 relied on).
- W10: case-insensitive color compare lives in the promoted `buildCategoryPatch`
  and is tested (`patch.test.ts:37`).
- W11: fallback isolated in `makeNameComparator` (`categoryLookup.ts:26-32`,
  Collator → localeCompare), probe ships (`probes.ts:87-102`); explicit
  `APP_LOCALE` from expo-localization passed at every formatMoney/formatApiDate/
  formatMonthLabel call site except finding 9.
- Dates: `toApiDate`/`todayApiDate` used for all wire dates; the picker feeds a
  LOCAL-constructed Date (`apiDateToLocalDate`, `transaction-form.tsx:48-51`) — no
  UTC-parse TZ hazard.
- Retry policy: never-retry-4xx / retry-transient-×2 mirrors web against the
  shared `ApiError` (`queryClient.ts:20-25`).

**Screens/misc:**
- Edit-form deep-link ladder: pending → "Loading…", missing row → unavailable+back
  (R4 redirect-arm), found → form (`transaction-form.tsx:73-91`,
  `category-form.tsx:43-62`); hooks all called before the conditional returns
  (hook-order safe).
- List keys: `keyExtractor` by `item.id` on both SectionLists; sections built
  without re-sorting server order (`groupByDay` verbatim from web, order-preserving).
- Accessibility baseline: 44pt TOUCH_TARGET on buttons/rows/chips/segments,
  `accessibilityRole`/`accessibilityState` on interactive elements, `alert` role on
  error texts, decorative swatch hidden from the a11y tree (`HexSwatch.tsx:20-21`).
- S4/R5: vitest graph is RN/expo-free — `coordinator.ts` + everything the 4 test
  files import contain no `react-native`/`expo-*` specifier (grepped); the RN
  seams live only in `secureStore.ts`/`resume.ts`/`probes.ts`/`locale.ts`.
- Scaffold-lifetime: `src/wiring.test.ts` deleted; its workspace-resolution role is
  genuinely superseded (mobile tests import both workspace packages).
- Version pins: react-query 5.101.4, RHF 7.82.0, resolvers 5.4.0 identical to web;
  zod 4.4.3 identical to shared (R2 held).
- Hygiene: zero console.* outside `probes.ts`, zero TODO/FIXME, zero
  `as any`/ts-ignore/eslint-disable in apps/mobile; user-facing copy is uniformly
  English on both clients; `.tasks/` artifacts not treated as code.
- No vacuous tests found: the 28 mobile + 14 api-client cases each exercise real
  branching (single-flight dedup, both R3 committed arms, polyfill tripwire,
  copy-table routing incl. network arms, safeNextRoute rejections, patch-builder
  omit/null/case rules); `qk` literals, `affectedMonth`, and `sortForDisplay` are
  correctly left to the checklist per the no-vacuous-tests rule. The one genuinely
  missing case is the late-settle arm of finding 1 — pure TS, vitest-coverable,
  and required by the fix.
