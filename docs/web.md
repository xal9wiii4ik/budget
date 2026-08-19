# web.md — apps/web map (React + Vite SPA, react-router, TanStack Query)

## Routes (`src/App.tsx`, pages in `src/routes/`)
- `/login`, `/register` — public (AuthLayout); `/` → redirect `/transactions`.
- Under `ProtectedLayout` (token guard + nav): `/transactions`, `/categories`, `/recurring`, `/goals`, `/stats`, `/advisor`, `/settings` (PAT tokens, 5.6).
- `*` → NotFoundPage.

## Data layer (`src/data/`, keys in `data/queryKeys.ts` — `qk`)
- One module per API area: transactions, categories, fx, goals, limits, recurring, receipts, stats, advisor.
- Key families (top-level roots are DISJOINT by design — new features get new roots so old predicates never touch them):
  - `['transactions', filters]` list vs `['transactions','summary', month]` — key[1] disambiguation.
  - `['categories', {includeArchived:true}]` — single archived-inclusive source; views filter client-side.
  - `['fx','convert', params|null]` — every input in the key; null = disabled state.
  - `['goals','list',{includeArchived}]` / `['goals', goalId, 'contributions'|'progress', …]`.
  - `['stats','summary'|{monthly:months}|'top-merchants', …]` — period object IS the key member (`StatsPeriodQuery`, exactly one anchor per unit).
  - `['recurring','list']`, `['limits',{month}]` (month-scoped: limit is a calendar-month budget), `['receipts', id]` (no list endpoint; cache removed on modal close).
  - `['tokens','list']` (`data/tokens.ts`) — new disjoint root; no existing mutation invalidates it.
- Invalidation rules (`data/transactions.ts` helpers): tx mutations invalidate lists via predicate `key[0]==='transactions' && key[1] !== 'summary'` PLUS the affected month's summary; plus blanket `['stats']`, blanket `['limits']` (an occurred_at edit can move spent in two months), `['goals','list']`.
- `offset` is the useInfiniteQuery pageParam, NEVER a key member (AM-1.6-a).

## Query client (`lib/query.ts`)
- staleTime 30s, no refetchOnWindowFocus, retry: never 4xx / transient ×2, `networkMode:'always'` for queries AND mutations (navigator.onLine is not evidence about our API; paused=silent-forever-skeleton bug).
- `ApiError`/`throwOnError` re-exported from `@budget/api-client`.
- `lib/queryPhase.ts` — `queryPhase()` → 'loading' | 'unreachable' (fetchStatus 'paused') | 'error' | 'ready'; every screen renders 4 arms; 'unreachable' gets an actionable network alert instead of an eternal skeleton. Do NOT branch on isPlaceholderData (period steps keep dimmed previous data).

## Auth (`src/auth/`)
- `coordinator.ts` — two-client design: plain authClient for `/auth/*` (no bearer/retry), protected client via `authFetch` (bearer + single-flight 401→refresh→retry). Refresh under navigator.locks (`locks.ts`) — cross-tab single flight. AUTH_PATHS never trigger refresh (belt-and-suspenders).
- `storage.ts` — one localStorage key `budget.auth` (JSON TokenPair); XSS exposure = recorded accepted tradeoff. Runtime-narrowed on read; corrupt value → logged out.
- `next.ts` — `safeNextPath`: local absolute path only; rejects `//`, backslash (WHATWG `\`→`/` open-redirect), else `/transactions`.
- `wasSessionExpired()` drives `?reason=expired` on redirect; `useAuthListener` clears Query cache on signed-out edge; `useMe`/`useAuth` hooks.

## Patch-builder discipline
- PATCH bodies are DIFFS vs output-shaped initial values: unchanged → OMIT key, cleared → `null`, changed → value. Builders (`buildTransactionPatch`, `buildCategoryPatch`, `buildRecurringTemplatePatch`) + `emptyToNull` live in `@budget/api-client` (shared with mobile).
- `emptyToNull` at every optional text/select boundary (note, merchant, icon, color, category_id).
- Converted-amount snapshot (`features/transactions/convertedSection.ts`): unchanged→omit, value→number, cleared→null; currency change invalidates the stood converted value.

## Forms / modals / features (`src/features/<area>/`)
- Shared `Modal` + `ConfirmDialog` in `src/components/`; forms are `*FormModal.tsx` per feature (transactions, categories, recurring, goals + ContributionModal, receipts capture).
- Pure logic sits beside each feature in small tested modules (period.ts, comparison.ts, groupByDay.ts, realism.ts, periodicity.ts, limitProgress.ts, confirmDefaults.ts, downscale.ts, pollInterval.ts…) — node-only vitest, no DOM.
- Advisor: `features/advisor/useAdvisorChat.ts` (SSE), `history.ts`; receipts: `useReceiptFlow.ts` (upload→poll→confirm).
- Limits (5.4): ONE write surface — `/categories` (`features/limits/` LimitFormModal + LimitBar; slot on expense rows only, C4-gated affordances); `/stats` `BudgetsSection` is READ-ONLY and month-unit-only (`budgetsVisibility.ts` gate, follows the period picker incl. past months). `limitProgress.ts` is the sole comparison gate: `limit_currency !== currency` → mismatch arm, NO bar/ratio/progressbar (AM-5); over is strict `>`; PUT re-stamp is the way out of a mismatch. `categoryLimitFormSchema(currency)` in `packages/shared` — currency bound at construction, read-only text in the form (D15).

## Dirty guard
- `lib/discardGuard.ts` — `shouldConfirmDiscard(isDirty, closeDisabled)`: clean form closes silently; in-flight mutation (`closeDisabled`) never confirms; applied by shared Modal to all three close channels (Esc, backdrop, ×).

## Settings / API tokens (5.6)
- `routes/SettingsPage.tsx` + `features/tokens/` (TokenFormModal → TokenCreatedPanel one-time show + copy, TokenRow; `tokenFormSchema.ts` lives IN the feature, not packages/shared — no second consumer, mobile frozen).
- Plaintext token string exists ONLY in modal-local useState and dies with the modal: never in Query cache, Zustand, localStorage or URL. `useCreateToken` hands the response to the caller and does NOT write it to the cache; `onSuccess` only invalidates `['tokens']`.
- `useRevokeToken`: DELETE 204 unwrapped by hand (limits.ts precedent — `throwOnError` treats `data: undefined` as error); 404 on revoke ALSO invalidates (already revoked in another tab). Revoked rows stay listed — dimmed, "Отозван <date>" badge, no revoke button.
- `formatTimestamp(iso)` in `packages/shared/src/dates.ts` for created/last-used datetimes (`formatApiDate` is date-only and NaNs on ISO datetimes).
