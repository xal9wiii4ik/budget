# web.md — apps/web map (React + Vite SPA, react-router, TanStack Query)

## Routes (`src/App.tsx`, pages in `src/routes/`)
- `/login`, `/register` — public (AuthLayout); `/` → redirect `/transactions`.
- Under `ProtectedLayout` (token guard + nav): `/transactions`, `/categories`, `/accounts` (W1: CRUD + archive + server-computed balances), `/recurring`, `/goals`, `/stats`, `/advisor`, `/settings` (PAT tokens, 5.6).
- `*` → NotFoundPage.

## Data layer (`src/data/`, keys in `data/queryKeys.ts` — `qk`)
- One module per API area: transactions, categories, fx, goals, limits, recurring, receipts, stats, advisor.
- Key families (top-level roots are DISJOINT by design — new features get new roots so old predicates never touch them):
  - `['transactions', filters]` list vs `['transactions','summary', month]` — key[1] disambiguation.
  - `['categories', {includeArchived:true}]` — single archived-inclusive source; views filter client-side.
  - `['fx','convert', params|null]` — every input in the key; null = disabled state.
  - `['goals','list',{includeArchived}]` / `['goals', goalId, 'contributions'|'progress', …]`.
  - `['stats','summary'|{monthly:months}|'top-merchants', …]` — period object IS the key member (`StatsPeriodQuery`, exactly one anchor per unit).
  - `['recurring','upcoming',{days}]` (`useUpcomingCharges`, /transactions widget) — the ONE deliberate exception to "new feature = new root": it shares the recurring root so the existing `invalidateTemplates()` (bare `['recurring']`) already refreshes it on create/PATCH/pause-resume/delete, incl. a paused template vanishing from the widget with no reload. Tx mutations deliberately do NOT invalidate it (the endpoint reads templates + `last_materialized_on`); the 00:30 UTC materializer stays unobserved, as on `/recurring`.
  - `['recurring','list']`, `['limits',{month}]` (month-scoped: limit is a calendar-month budget), `['receipts', id]` (no list endpoint; cache removed on modal close).
  - `['tokens','list']` (`data/tokens.ts`) — new disjoint root; no existing mutation invalidates it.
  - `['accounts','list']` (`data/accounts.ts`, W1) — ONE archived-inclusive entry feeds the /accounts screen AND every account selector; balances are server fields, so EVERY tx mutation also invalidates the bare `['accounts']` prefix (a money write moves a balance).
  - Account filter (W2) is DATA IN THE KEY of transaction lists — a transfer legitimately appears under both of its accounts' filtered keys.
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
- Accounts (W1): `features/accounts/` — AccountFormModal (currency read-only after create), AccountList/Row (balance from server, archive toggle), AccountField/AccountSelect for pickers, `lastAccount.ts` (remembered default account, localStorage), `AccountFilter.tsx` on the transactions list. `accountFieldBlocked`/`accountIndex` in `accountOptions.ts` gate the tx form until accounts are loadable.
- Transfers (W1/W2): `features/transfers/TransferFormModal.tsx` — two accounts + two amounts; `transfer_rate` is a SERVER string shown as-is, hidden for same-currency pairs. A transfer renders as ONE list row with both sides (A1); in an account-filtered list the leg/sign comes from `signedLegFor` in `packages/shared/src/transfers.ts` (A3 — pure leg-and-sign choice, no money arithmetic, `counter_currency` read verbatim, never a fallback). Click opens the transfer form, not the tx form.
- Receipt confirm (W2): `features/transactions/confirmDefaults.ts` — account default prefers a live account matching the parsed receipt currency; `receiptCurrencyMismatch()` drives a non-blocking warning in TransactionFormModal (saving allowed — server stamps the ACCOUNT's currency, warning explains amounts won't be converted).
- Book-now shortcut (recurring-book-now W1): "+" on upcoming-widget rows and on EVERY /recurring template row (paused/ended included — it drafts an operation, not a charge) opens TransactionFormModal with `templatePrefill` (second create-prefill channel beside `receipt`, mutually exclusive). Pure mapper `features/transactions/templatePrefill.ts`: minor→major via `toInputString` at the template currency, `merchant ?? name` (a manual row has no template badge to resolve the name from — do NOT "align" with the job, which copies merchant only). Date = row's `due_on` (widget) / `todayApiDate()` (/recurring), captured at click time. Saves an ORDINARY transaction: no materialization, no `recurring_template_id`, the widget row stays and the schedule still fires (accepted risk, said in the form lede). The form's STARTING account/category (edit row's or template's) stays selectable even when archived — `selectableAccounts`/`accountFieldBlocked` take `startingAccountId`; dropping it would silently substitute another account (money to the wrong place) instead of the honest 422 ACCOUNT_ARCHIVED, whose copy now tells the user to pick another account.
- Limits (5.4): ONE write surface — `/categories` (`features/limits/` LimitFormModal + LimitBar; slot on expense rows only, C4-gated affordances); `/stats` `BudgetsSection` is READ-ONLY and month-unit-only (`budgetsVisibility.ts` gate, follows the period picker incl. past months). `limitProgress.ts` is the sole comparison gate: `limit_currency !== currency` → mismatch arm, NO bar/ratio/progressbar (AM-5); over is strict `>`; PUT re-stamp is the way out of a mismatch. `categoryLimitFormSchema(currency)` in `packages/shared` — currency bound at construction, read-only text in the form (D15).

## i18n (`src/i18n/`, transaction-details-and-i18n W5)
- `dict.en.ts` IS the key set; `dict.ru.ts` is a mapped type over it — a missing key or a plural written as a plain string fails `pnpm typecheck`. Plurals go through `Intl.PluralRules` (ru one/few/many, the 21-vs-11 trap pinned in `t.test.ts`).
- Components use ONLY `useT()` / `useLang()` / `useLocale()` (`i18n/context.ts`); nothing imports the dictionaries directly.
- Language resolves as explicit pick → `profile.language` → `budget.lang` cache → browser (`I18nProvider`). `LOCALE_BY_LANG` (lang.ts) is the ONE lang→locale map.
- **Every** `formatMoney/formatAmount/formatApiDate/formatMonth*/formatQuarterLabel/formatTimestamp` call site passes `{ locale }` from `useLocale()`, as do `Intl.Collator` (`sortForDisplay`), `Intl.DisplayNames` (country list) and `weekdayLabels`. Host-default locale = the shipped "English UI, Russian dates" defect.
- `todayApiDate()` is LOCAL and is for the user's own calendar (default date on a form); anything compared against a date the SERVER decided (recurring `start_date` floor, "due today" in the upcoming widget) uses `todayApiDateUtc()` — `routers/recurring.py:_today()` is UTC, and a local compare disagrees with it for hours around midnight.
- PURE modules stay language-free and return KEYS, not sentences: `originalPair.describeOriginalPairError().messageKey`, `period.unitLabelKey()`, `auth/errors.describeAuthError().messageKey`; `rowDisplay.rowTitle()` takes its two fallback LABELS as an argument; `periodicity.periodicityLabel(template, t, locale)`.
- NOT translated, by rule: user-typed text (category/account/goal/template names, merchants, notes), advisor ANSWERS and every server string (`transfer_rate`, parsed receipt items). System categories translate by frozen UUID (`systemCategoryName`, @budget/shared) with the server `name` as fallback — applied once in `useCategories`' `select`.
- Server errors stay CODES: `lib/errors.ts` routes code → field, copy comes from `ERROR_MESSAGES` (@budget/shared, shared with mobile). Screen copy lives in `apps/web/src/i18n`.
- KNOWN GAP: zod messages in `@budget/shared/schemas.ts` are still English (changing them touches the frozen mobile client — cross-package call). `features/tokens/tokenFormSchema.ts` is web-only and IS translated (factory over `t`).

## Dirty guard
- `lib/discardGuard.ts` — `shouldConfirmDiscard(isDirty, closeDisabled)`: clean form closes silently; in-flight mutation (`closeDisabled`) never confirms; applied by shared Modal to all three close channels (Esc, backdrop, ×).

## Settings / API tokens (5.6)
- `routes/SettingsPage.tsx` + `features/tokens/` (TokenFormModal → TokenCreatedPanel one-time show + copy, TokenRow; `tokenFormSchema.ts` lives IN the feature, not packages/shared — no second consumer, mobile frozen).
- Plaintext token string exists ONLY in modal-local useState and dies with the modal: never in Query cache, Zustand, localStorage or URL. `useCreateToken` hands the response to the caller and does NOT write it to the cache; `onSuccess` only invalidates `['tokens']`.
- `useRevokeToken`: DELETE 204 unwrapped by hand (limits.ts precedent — `throwOnError` treats `data: undefined` as error); 404 on revoke ALSO invalidates (already revoked in another tab). Revoked rows stay listed — dimmed, "Отозван <date>" badge, no revoke button.
- `formatTimestamp(iso)` in `packages/shared/src/dates.ts` for created/last-used datetimes (`formatApiDate` is date-only and NaNs on ISO datetimes).
