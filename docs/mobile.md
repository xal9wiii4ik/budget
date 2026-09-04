# mobile.md — apps/mobile map (Expo / RN, expo-router)

## Status
- Surface = 1.8 MVP (auth + categories + transactions) + accounts-and-transfers MOB (18c627d: accounts tab, account/transfer forms) + mobile-catchup-1 (i18n, profile language, shared amount mirror). Charts/stats/settings/language picker deliberately absent; still FROZEN beyond that until 1.7 deploy — open only for a defect or a groomed scope.
- Simulator QA passed per scope (`.tasks/accounts-and-transfers/`, `.tasks/mobile-catchup-1/qa-mobile-checklist.md`); the physical-iPhone checklists in those files are WRITTEN, NOT EXECUTED. Open nits: `.tasks/mobile-catchup-1/follow-ups.md`.

## Screens (`app/`, expo-router groups)
- `app/index.tsx` — `/` → redirect to `/transactions`.
- `(auth)/` — login, register (+ group layout).
- `(app)/(tabs)/` — transactions, categories, accounts tabs; `(app)/transaction-form`, `(app)/category-form`, `(app)/account-form`, `(app)/transfer-form` — modal-style form screens (a transfer is ONE operation with two legs, `transfer_rate` a server string shown verbatim and hidden for same-currency pairs).
- `(app)/_layout.tsx` — protected guard (reads coordinator's sync snapshot; captures intended route for `next`).
- Root `app/_layout.tsx` — splash held (`SplashScreen.preventAutoHideAsync`) until `coordinator.ready` resolves; guard NEVER evaluates a pre-hydration snapshot. `useAuthListener` clears Query cache on sign-out edge. `runDevProbes()` logs Hermes seam probes (`src/lib/probes.ts`, __DEV__ only, out of vitest graph).

## DI coordinator (`src/auth/coordinator.ts`)
- COPY of web's pattern, not shared (O1/S5): single-flight refresh, reactive-only 401→refresh→retry; all cross-tab machinery deleted (one RN process).
- Imports ONLY `@budget/api-client` — whole core vitest-testable under Node. Platform seams INJECTED: `AsyncTokenStorage` (secure store), `ResumeSubscribe` (AppState), `TimerSeam`.
- Async-hydrate: `hydrate()` once into an in-memory mirror behind the splash gate; after that reads are sync.
- Resume handling (O5/R3): on AppState foreground-resume, a suspended in-flight refresh is waited ≤4000ms then abandoned so the next 401 starts a FRESH flight (the MAJOR stale-flight race fix from 1.8 review: never rebuild state from a captured stale in-flight promise).
- Wiring in `src/lib/api.ts`: two clients — plain `authClient` (auth endpoints, no bearer) and `apiClient` (fetch = `coordinator.authFetch`); baseUrl resolved once at init.

## Secure store (`src/auth/secureStore.ts`)
- ONLY file importing expo-secure-store; key `budget.auth`, JSON TokenPair in OS keychain (never AsyncStorage); corrupt value → logged-out, not crash. Tests inject in-memory fake.

## Base URL (`src/lib/baseUrl.ts`)
- Precedence: `EXPO_PUBLIC_API_URL` override → __DEV__ derive host from Metro hostUri + port 8010 → throw (release without override). No secrets in bundle.

## Data / UI
- `src/data/` mirrors web (queryKeys, categories, transactions, errors, profile); shared patch builders/ApiError from `@budget/api-client`; HEX pattern etc. from `@budget/shared`.
- i18n (`src/i18n/`, mobile-catchup-1): mobile's OWN ~90-key dict (`dict.en.ts` is the key set, `dict.ru.ts` a mapped type over it); `types.ts`/`context.ts` are copies of web's, and so is `t.ts` EXCEPT the plural seam: Hermes has NO `Intl.PluralRules` (D-1 red-screened the accounts+categories tabs), so `selectForm` takes the LANG and calls hand-written CLDR `src/i18n/plural.ts` (a third language must extend it; pinned by `plural.test.ts`). `Intl.NumberFormat`/`Intl.Collator` do work in Hermes and are untouched. Screens use only `useT()`/`useLang()`/`useLocale()`; EVERY formatter and `Intl.Collator` takes `useLocale()` — the device locale is the "English UI, Russian dates" defect. Language = `profile.language` → device (`expo-localization`, isolated in `src/lib/deviceLang.ts`, out of the vitest graph) → 'en'; NO local cache and NO picker (language is chosen on web). Nothing on mobile invalidates `['profile']` and there is no focus refetch, so a language changed on web reaches a running app only on the next COLD start (in-memory cache; staleTime 60s). Server-error copy stays shared (`errorMessage()`, @budget/shared) and `describe*Error(error, lang)`; `auth/errors.ts` returns dictionary KEYS. KNOWN GAP: zod messages in `@budget/shared/schemas.ts` are still English.
- Transfer amount mirror: `mirrorDecision` lives in `@budget/shared` (`amountMirror.ts`) and is wired identically in both transfer forms; mobile mirrors the RAW typed string (`100,5`), normalisation stays in the resolver.
- Components in `src/components/` (LabeledInput, KindSegmented, KeyboardAwareForm, confirm.ts…); features mirror web's transactions/categories lists.

## Constraints
- Testing: vitest-only under Node — NO react-native/expo import may enter the test graph (DI seams exist for this). No RN component tests.
- Simulator QA via idb + Expo Go (see infra.md); full Xcode absent on this machine — manual checklist in `.tasks/mobile-mvp/qa-mobile-checklist.md`.

## Recent defect fixes (both pinned by tests)
- TC-8 (deep-linked `next` across login) — THREE layers, all needed: (1) `src/auth/intendedRoute.ts`: `usePathname()` is WRONG at redirect time (router store written post-commit; cold start holds `/`); resolve from `useRootNavigationState()` — committed chain when it enters `(app)`, else the pending navigate payload in `__root.params` (warm arm). (2) Module-level latch (`captureIntendedRoute`/`releaseIntendedRoute`): expo-router's `<Redirect>` re-issues `router.replace` every render, and the teardown render sees an empty `(app)` — unresolvable renders keep the last answer; released on the authenticated edge. (3) `app/(auth)/_layout.tsx` bounce honors `safeNextRoute(next)` instead of hardcoding `/transactions`, so its replace and login's converge (race made harmless). Side effect: logout returns you to the screen you were on.
- `src/lib/amountInput.ts` (F-1): ru-RU decimal-pad only types ','; `normalizeAmountInput` maps EXACTLY one ','/'.' to '.'; two-plus separators pass through untouched for the shared parser to reject (never guess thousands separators). Field shows what was typed; only the validated value is normalized.
