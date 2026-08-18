# mobile.md — apps/mobile map (Expo / RN, expo-router)

## Status
- FROZEN surface = 1.8 mobile MVP (auth + categories + transactions) until 1.7 deploy; charts/stats deliberately absent. Do not extend without unfreezing decision.

## Screens (`app/`, expo-router groups)
- `app/index.tsx` — `/` → redirect to `/transactions`.
- `(auth)/` — login, register (+ group layout).
- `(app)/(tabs)/` — transactions, categories tabs; `(app)/transaction-form`, `(app)/category-form` — modal-style form screens.
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
- `src/data/` mirrors web (queryKeys, categories, transactions, errors); shared patch builders/ApiError from `@budget/api-client`; HEX pattern etc. from `@budget/shared`.
- Components in `src/components/` (LabeledInput, KindSegmented, KeyboardAwareForm, confirm.ts…); features mirror web's transactions/categories lists.

## Constraints
- Testing: vitest-only under Node — NO react-native/expo import may enter the test graph (DI seams exist for this). No RN component tests.
- Simulator QA via idb + Expo Go (see infra.md); full Xcode absent on this machine — manual checklist in `.tasks/mobile-mvp/qa-mobile-checklist.md`.

## Recent defect fixes (both pinned by tests)
- `src/auth/intendedRoute.ts` (TC-8): `usePathname()` is WRONG at redirect time (router store written post-commit; cold start holds `/`). Walk `useRootNavigationState()` to the focused leaf (incl. `params.screen` tail) to capture the real intended deep-link route.
- `src/lib/amountInput.ts` (F-1): ru-RU decimal-pad only types ','; `normalizeAmountInput` maps EXACTLY one ','/'.' to '.'; two-plus separators pass through untouched for the shared parser to reject (never guess thousands separators). Field shows what was typed; only the validated value is normalized.
