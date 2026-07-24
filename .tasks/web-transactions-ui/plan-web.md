# Implementation Plan (web): web-transactions-ui (roadmap 1.6)

## Approach

Build the MVP's three real screens — a month-scoped transactions list with a
summary header, an add/edit transaction modal, and a categories management screen
— on the EXISTING typed contract (schema.d.ts stays byte-identical, gate G1). No
component library (R1): continue the CSS-modules pattern established by the auth
flow. Server state lives ONLY in TanStack Query; the only client state is transient
UI (which modal is open, the selected month) held as local component state / URL
search params, never Zustand and never a copy of server data.

Three cross-cutting disciplines carry the risk and get isolated, tested units:
(1) two PATCH-body builders that emit only touched fields and bridge RHF `""` → the
correct omit/`null` intent (C1/T7); (2) an error layer that runtime-narrows the 422
`string | ValidationError[]` split and routes stable codes to fields (C2/T6/A3); and
(3) month math moved into `packages/shared` with vitest (R5/T10) rather than
open-coded. Everything else is composition over the generated client + shared
formatters.

Data flow: one categories query (`include_archived: true`, Q5) is the single source
for the picker, the management screen, and the summary/list name-joins — non-archived
views are derived by client-side filtering. Transactions use an infinite query keyed
by the month filter set; the summary is a separate per-month query. After any tx
mutation both are invalidated (T9); no optimistic updates (R3).

## Screens / components affected

- `apps/web/src/App.tsx` — add `/categories` route inside `ProtectedLayout`; swap the
  `/transactions` element from the stub to the real `TransactionsPage`.
- `apps/web/src/routes/ProtectedLayout.tsx` — add nav (Transactions / Categories);
  add A1 terminal-me-error affordance in `ProtectedShell`.
- `apps/web/src/routes/LoginPage.tsx`, `apps/web/src/routes/RegisterPage.tsx` — A2
  authed-bounce guard at the top of each page.
- `apps/web/src/routes/TransactionsStubPage.tsx` — deleted (replaced).

## New components / hooks

Routes / screens (new files under `apps/web/src/routes/`):
- `TransactionsPage.tsx` (+ `.module.css`) — owns selected `month` (URL search param
  `?month=YYYY-MM`, default current), renders `SummaryHeader` + `MonthPicker` +
  `TransactionList` + "Add" button + `TransactionFormModal`.
- `CategoriesPage.tsx` (+ `.module.css`) — kind-grouped merged list + `CategoryFormModal`.

Feature components (new files under `apps/web/src/features/transactions/` and
`.../features/categories/`, each with a co-located `.module.css`):
- `MonthPicker.tsx` — prev/next buttons + "Month YYYY" label (Q2; NOT `<input
  type="month">`). Calls `shiftMonth` on click, writes the `?month=` param.
- `SummaryHeader.tsx` — income/expense/net + `by_category` breakdown (T3/T4).
- `TransactionList.tsx` — day-grouped list, loading/empty/error, "Load more".
- `TransactionRow.tsx` — signed amount + category name/icon join.
- `TransactionFormModal.tsx` — add/edit form (RHF + shared schema).
- `CategoryList.tsx` / `CategoryRow.tsx` — kind groups, system-row gating (C4).
- `CategoryFormModal.tsx` — create/rename/icon/color/kind + archive action.

Shared UI (new files under `apps/web/src/components/`):
- `Modal.tsx` (+ `.module.css`) — accessible dialog: `role="dialog"`,
  `aria-modal`, focus trap, Esc/backdrop close, restores focus on close.
- `ConfirmDialog.tsx` — destructive-action confirmation built on `Modal` (C6:
  delete tx, archive/unarchive category).

Hooks / data (new files under `apps/web/src/data/`):
- `queryKeys.ts` — key builders (below).
- `categories.ts` — `useCategories`, `useCreateCategory`, `useUpdateCategory`.
- `transactions.ts` — `useTransactions` (infinite), `useSummary`,
  `useCreateTransaction`, `useUpdateTransaction`, `useDeleteTransaction`.
- `categoryLookup.ts` — pure `buildCategoryIndex(cats)` + `sortForDisplay` (C3).

Lib (new/edited under `apps/web/src/lib/`):
- `patch.ts` — `buildCategoryPatch`, `buildTransactionPatch` (C1/T7).
- `errors.ts` — validation-array narrow + category/tx describe fns (C2/T6/A3).

## Data layer

### Query keys (`data/queryKeys.ts`)

```ts
export type TxListFilters = {
  from: string; to: string;
  category_id?: string; kind?: components['schemas']['TransactionKind'];
  limit: number;                  // 200 (R4); offset is the infinite-query pageParam, not a key member
};
export const qk = {
  me: () => ['me'] as const,                                           // existing
  categories: () => ['categories', { includeArchived: true }] as const, // Q5/C5: single source
  txList: (f: TxListFilters) => ['transactions', f] as const,          // T9/T2
  txSummary: (month: string) => ['transactions', 'summary', month] as const, // T9
};
```

Discriminator: `txList` key[1] is the filters OBJECT; `txSummary` key[1] is the
STRING `'summary'`. List-only invalidation uses a predicate
`q.queryKey[0]==='transactions' && q.queryKey[1] !== 'summary'` so invalidating lists
never blanket-refetches every month's summary.

### Queries

- `useCategories()` — `GET /categories?include_archived=true` via `params.query`, key
  `qk.categories()`. Single fetch; picker (non-archived), management (all), and the
  summary/list joins all read this cache and filter client-side (Q5). `staleTime`
  moderate (categories change rarely).
- `useTransactions(filters)` — `useInfiniteQuery`, key `qk.txList(filters)`,
  `initialPageParam: 0`, `queryFn` passes `{ ...filters, offset: pageParam }` through
  `params.query` (T2: `from`/`to` are object KEYS from `toApiDate`, never destructured
  identifiers). `getNextPageParam`: `loaded = pages.flatMap(p=>p.items).length`;
  return `loaded < total ? loaded : undefined` → derives `has_more` (T1/R4). `total`
  from any page drives "showing N of M".
- `useSummary(month)` — `GET /transactions/summary?month=` via `params.query`, key
  `qk.txSummary(month)`. Also the source of the create-form currency chip (R2): read
  `useSummary(month).data?.currency`.

`from`/`to` for the list come from `monthBounds(month)` (R5). The list filter set and
the summary use the SAME `month`.

### Mutations → invalidation map

`affectedMonth(occurred_at) = occurred_at.slice(0,7)` ("YYYY-MM"; occurred_at is
date-only). List invalidation always uses the not-`summary` predicate above.

| Mutation | Endpoint | Invalidates | In-place cache update |
|---|---|---|---|
| Create tx | POST /transactions → 201 TransactionRead | list (predicate) + `qk.txSummary(affectedMonth(row.occurred_at))` | none — infinite-page splice not cheap (R3) → invalidate |
| Edit tx | PATCH /transactions/{id} → 200 TransactionRead | list (predicate) + summary of **old** month AND **new** month (occurred_at may cross months) | none → invalidate |
| Delete tx | DELETE /transactions/{id} → 204 | list (predicate) + `qk.txSummary(affectedMonth(deletedRow.occurred_at))` | none → invalidate |
| Create category | POST /categories → 201 CategoryRead | `qk.categories()` | `setQueryData` append returned row (cheap; C5) or invalidate |
| Update category (rename / icon / color / kind) | PATCH /categories/{id} → 200 CategoryRead | `qk.categories()` | `setQueryData` replace-by-id from returned row (C5) |
| Archive / unarchive category | PATCH /categories/{id} `{archived}` → 200 | `qk.categories()` | `setQueryData` replace-by-id |

Notes: (T9) tx mutations invalidate BOTH list and the affected month's summary — the
aggregate is not locally recomputable. Category mutations do NOT touch summary/list
keys: the summary/list join reads the categories cache reactively, so a rename/archive
re-renders those screens automatically without refetching tx data. Deleted/old rows
for edit/delete are captured from the mutation call site (the row is already in hand),
never via a `GET /{id}` (none exists).

### Edit-form row sourcing (T9)

The edit modal receives the full `TransactionRead` via component state when the user
clicks a list row (row already in the infinite-query cache). No per-transaction route
(Q3) → no cold deep-link path exists to a single tx, so the "refetch-or-redirect"
branch is structurally unreachable and needs no code. The edit form's amount schema
uses `row.currency` (T8); only the CREATE form needs summary currency.

## PATCH-body builders (C1, T7) — `apps/web/src/lib/patch.ts`

Both take resolved form values + the initial values and emit ONLY changed fields,
bridging the RHF empty sentinel once (wrapped, never open-coded per call site).

```ts
import type { components } from '@budget/api-client';

// C1. name/kind never null; icon/color cleared ("") → null. archived is NOT in the
// rename form — it's a separate mutation (C6). Empty PATCH (nothing changed) → {} ;
// caller skips the mutation (server would 200 no-op anyway).
export function buildCategoryPatch(
  values: CategoryFormValues,
  initial: CategoryFormValues,
): components['schemas']['CategoryUpdate'];

// T7. amount_minor/kind/occurred_at never null (server *_REQUIRED 422 clears NOT NULL).
// category_id/note cleared ("") → null. amount_minor is already the parsed minor
// number (moneyAmountSchema transform output); occurred_at required, never cleared.
export function buildTransactionPatch(
  values: TransactionFormValues,
  initial: TransactionFormValues,
): components['schemas']['TransactionUpdate'];
```

Bridging rule (the single place `""` is interpreted): a nullable-clearable field
(`icon`, `color`, `category_id`, `note`) whose value changed to `""` emits `null`;
whose value is unchanged is omitted; whose value is a non-empty string emits the
string. Non-nullable fields (`name`, `kind`, `amount_minor`, `occurred_at`) are
included only when changed and are never `null`/`undefined`. `undefined` is never
emitted as an intent (JSON.stringify would drop it → "preserve", masking a bug).

## Error helper (C2, T6, A3) — `apps/web/src/lib/errors.ts`

Reuse `getErrorCode` from `@budget/api-client` (unchanged; it lives in
`packages/api-client/src/auth.ts`, hand-written, returns the raw stable string — NOT
edited, so G1/contract untouched). New app-side layer:

```ts
import { getErrorCode } from '@budget/api-client';
import { ApiError } from './query';

type FieldIssue = { loc: (string|number)[]; msg: string };

// Runtime narrow of the 422 body: detail is ValidationError[] → issues, else undefined.
// Do NOT trust the generated POST/PATCH 422 type (declares {detail:string}) as
// exhaustive — the Pydantic array arm is real at runtime (T6).
export function getValidationIssues(body: unknown): FieldIssue[] | undefined;

export type FieldError<F extends string> = { field: F | 'form'; message: string };

export function describeCategoryError(e: unknown): FieldError<'name'|'icon'|'color'|'kind'>;
export function describeTransactionError(e: unknown): FieldError<'amount_minor'|'category_id'|'occurred_at'|'note'>;
```

Code map (string arm, via `getErrorCode`):
- Category: `SYSTEM_CATEGORY_READONLY` → form ("System categories can't be edited");
  `CATEGORY_NOT_FOUND` → form (refetch/toast); `CATEGORY_NAME_CONFLICT` → **field
  `name`** ("A category with this name already exists in this type") — fires on rename
  OR kind-only PATCH (C2 senior amendment), so it is always routed to `name`, never a
  generic failure.
- Transaction: `TRANSACTION_NOT_FOUND` (404) → form + trigger list invalidation;
  `CATEGORY_NOT_FOUND` / `CATEGORY_ARCHIVED` (422) → **field `category_id`**;
  `AMOUNT_REQUIRED` / `KIND_REQUIRED` / `OCCURRED_AT_REQUIRED` (422) → generic form
  fallback (these only fire from a malformed body the builder never sends — an
  unexpected-error signal, not a user field error).

Validation-array arm (`getValidationIssues`): map `loc` tail → field. For categories:
`color` pattern, `name` length/whitespace, invalid `kind` → the matching field. For
transactions: `note` > 500, `amount_minor` `ge=1`, bad enum → the matching field
(client zod already guards these; the array arm is a backstop). Non-`ApiError`
(fetch rejected) → form-level "Can't reach the server…" (mirrors `describeAuthError`).

A3: extend `describeAuthError` (in `apps/web/src/auth/errors.ts`) to consult
`getValidationIssues` before its generic fallback — a 422 whose `loc` ends in `email`
(the reserved-TLD case the shared zod accepts but the server rejects) routes to the
`email` field, not a generic form error. Shared narrow reused from `lib/errors.ts`.

Call sites route the result into RHF: `describeX(...)` → `setError(field==='form' ?
'root' : field, { message })` (same pattern LoginPage already uses).

## Forms

RHF + `zodResolver`, schemas from `packages/shared` (the same schemas mobile will
reuse at 1.8) — see "Shared package additions". Amount via `moneyAmountSchema(currency)`
(magnitude only; T4/T8) — sign is carried by `kind`, never typed into the field.

Transaction form (`TransactionFormModal`):
- Fields: amount (`moneyAmountSchema`), kind toggle, category picker (optional), date
  `<input type="date">` default `todayApiDate()`, future allowed (Q6), note
  `<textarea>` 500 cap.
- Currency: display-only chip, never collected (T8). Create: `useSummary(month).data
  ?.currency`; if summary unresolved/errored → omit the chip AND disable submit with an
  inline "Loading account currency…" notice (rare; summary is fetched for the header on
  the same screen). Edit: uses `row.currency` (always present), never gated on summary.
- Kind ↔ category (Q4/T5): picking a category sets `kind = category.kind` by DIRECT
  assignment (safe direction; reference `components['schemas']['CategoryKind']` at the
  category site, `['TransactionKind']` at the tx field — no shared `type Kind` alias).
  Manually flipping kind clears a now-incompatible selected category (category stays
  optional). Picker lists NON-archived categories only for new/selectable; an edit whose
  saved `category_id` is archived shows that archived category as the current value
  (amount-only edit stays valid, 1.4 decision e).
- Edit prefill: amount via `toInputString(row.amount_minor, row.currency)` (magnitude;
  never a summary value — T4). Submit builds the PATCH via `buildTransactionPatch`.

Category form (`CategoryFormModal`):
- Fields: name (min 1, trimmed), kind toggle, icon (optional, soft ≤16-codepoint hint),
  color (optional, `^#[0-9A-Fa-f]{6}$`, case-insensitive C7). No dedup pre-gate — rely
  on server 409 surfaced to the `name` field (C8). System rows (`is_system===true`) are
  not editable (C4): no edit/archive affordance rendered; server 403 is backstop only.
- Archive/unarchive (C6): `PATCH {archived:true|false}` behind `ConfirmDialog`
  (destructive). No DELETE.

Confirmations (C6): delete tx and archive/unarchive category both go through
`ConfirmDialog`. Mutations expose `isPending`/error; the modal shows a spinner on the
submit button and the routed error message; nothing closes until success.

## Summary header + by_category breakdown (T3, T4)

`SummaryHeader` reads `useSummary(month)` + `useCategories()`.
- Totals: `formatMoney(income_minor, currency)`, `formatMoney(expense_minor, currency)`,
  `formatMoney(net_minor, currency)` — net is signed, `formatMoney` renders the
  locale-correct minus (T4). NEVER `toInputString` on a summary value (throws on
  negatives); no `toFixed`/float.
- Breakdown: build `Map<id, CategoryRead>` from the `include_archived: true` set
  (`buildCategoryIndex`) — this is why the single archived-inclusive query matters: a
  summary can reference a since-archived category (1.4 decision e) that a non-archived
  join would render "unknown" (T3). Each row keyed `${category_id ?? 'uncategorized'}:
  ${kind}` (React key + any client map) — the refund case repeats a `category_id` under
  both kinds; `category_id` alone collides (T3). `category_id === null` → "Uncategorized"
  label. Archived categories render their name (muted). `total_minor` via `formatMoney`.

## A1 / A2

- A1 (`ProtectedLayout.tsx` → `ProtectedShell`): when the me-query is terminally
  errored (`me.isError`, retries exhausted — a non-401 5xx/network; a 401 never reaches
  here, the coordinator handles it), render an inline affordance in the header ("Couldn't
  load your account" + a Retry `<button>` calling `me.refetch()`), instead of the current
  silent `null`. Shell/nav still render; content is not blocked.
- A2 (`LoginPage.tsx`, `RegisterPage.tsx`): at the top, if `useIsAuthenticated()` →
  `<Navigate to={safeNextPath(searchParams.get('next'))} replace />` (register bounces to
  `/transactions`). Reuses existing `safeNextPath`; prevents an authed user seeing the
  auth forms.

## Shared package additions (R5) — `packages/shared/src/dates.ts` + `index.ts`

Month math moved out of components (approved T10 resolution). Exact exports:

```ts
export function monthParam(year: number, month: number): string;      // (2026, 7) -> "2026-07"
export function currentMonth(locale?: never): string;                 // today's local month -> "YYYY-MM"
export function shiftMonth(month: string, delta: number): string;     // ("2026-01",-1) -> "2025-12"
export function monthBounds(month: string): { from: string; to: string }; // "2026-02" -> {from:"2026-02-01", to:"2026-02-28"}
export function formatMonthLabel(month: string, options?: { locale?: string }): string; // "2026-07" -> "July 2026"
```

Implemented with local `Date(y, m-1, ...)` component math (TZ-safe, matching the
existing `formatApiDate` discipline); `monthBounds` last day via `new Date(y, m, 0)
.getDate()` (Date handles leap Feb natively); `formatMonthLabel` via a cached
`Intl.DateTimeFormat({year:'numeric', month:'long'})`. All added to the `index.ts`
barrel. `formatApiDate` stays for `occurred_at` only, never `created_at` (datetime —
1.6 renders only `occurred_at`, T10).

Form schemas (also `packages/shared/src/schemas.ts`, within shared's stated remit —
"zod form schemas", 0.4; reused by mobile 1.8):

```ts
export function transactionFormSchema(currency: string): ZodType<...>; // amount via moneyAmountSchema, kind, category_id?, occurred_at, note.max(500)
export const categoryFormSchema: ZodType<...>;                          // name.min(1).trim, kind, icon?, color?(hex, case-insensitive)
export type TransactionFormValues; export type CategoryFormValues;
```

## Vitest inventory (pure logic only; repo rule — no vacuous tests)

- `packages/shared` month helpers: `monthParam` padding; `monthBounds` Dec (→31),
  leap Feb 2024 (→29) vs non-leap Feb 2025 (→28), Apr (→30); `shiftMonth` Dec→Jan (+1yr
  rollover) and Jan→Dec (−1yr); `formatMonthLabel` en-US. Genuinely breakable month math.
- `apps/web/src/lib/patch.test.ts`: `buildCategoryPatch` — unchanged field omitted;
  icon cleared → `null`; name never `null`; no-change → `{}`. `buildTransactionPatch` —
  category_id/note cleared → `null`; amount_minor/kind/occurred_at never `null`; only
  touched fields present. (Load-bearing omit-vs-null discipline.)
- `apps/web/src/lib/errors.test.ts`: `getValidationIssues` narrow (string detail →
  undefined; array → issues; object → undefined); `describeCategoryError` routes 409 →
  `name`; `describeTransactionError` routes `CATEGORY_ARCHIVED` → `category_id` and
  `AMOUNT_REQUIRED` → form. (Breakable string/array narrowing + field routing.)
- `apps/web/src/data/categoryLookup.test.ts`: `sortForDisplay` — Cyrillic order via
  `Intl.Collator` within kind, kind grouping (C3); `buildCategoryIndex` includes an
  archived id. (Contrast against raw server order — non-vacuous.)
- `apps/web/src/features/transactions/groupByDay.test.ts`: day-grouping preserves
  occurred_at-DESC order and buckets correctly across a month boundary.

Explicitly NOT tested (would be vacuous): trivial key-string concatenation, the
sign-from-kind one-liner, presentational components (web-qa owns journeys).

A4: the coordinator body-preservation vitest (`apps/web/src/auth/coordinator.test.ts`)
is the tripwire for 1.6 mutation retries — it MUST stay green and is NOT touched by this
task. Full vitest gate every round (G2).

## File-by-file change list & build order

Build order lands foundation first so each diff reviews incrementally:

1. **shared** (edit) `dates.ts` (+`dates.test.ts`), `schemas.ts` (+`schemas.test.ts`),
   `index.ts` — month helpers + form schemas. `packages/shared/*`.
2. **web lib** (create) `lib/patch.ts` (+test), `lib/errors.ts` (+test); (edit)
   `auth/errors.ts` (A3).
3. **web data** (create) `data/queryKeys.ts`, `data/categoryLookup.ts` (+test),
   `data/categories.ts`, `data/transactions.ts`.
4. **web shared UI** (create) `components/Modal.tsx`(+css), `components/ConfirmDialog.tsx`.
5. **web categories** (create) `routes/CategoriesPage.tsx`(+css),
   `features/categories/CategoryList.tsx`, `CategoryRow.tsx`, `CategoryFormModal.tsx`
   (+css).
6. **web transactions** (create) `features/transactions/MonthPicker.tsx`,
   `SummaryHeader.tsx`, `TransactionList.tsx`(+`groupByDay.ts`+test), `TransactionRow.tsx`,
   `TransactionFormModal.tsx`, `routes/TransactionsPage.tsx` (+css).
7. **web routing/shell** (edit) `App.tsx` (routes), `routes/ProtectedLayout.tsx` (nav +
   A1), `routes/LoginPage.tsx` + `routes/RegisterPage.tsx` (A2); (delete)
   `routes/TransactionsStubPage.tsx`.

Gate after each landed layer and at the end: `pnpm typecheck`, `pnpm lint`, full
`pnpm vitest` across `apps/web` + `packages/shared` (G2). Confirm
`packages/api-client/src/generated/schema.d.ts` byte-identical (G1). Root ownership /
no cross-package contract edits (G3).

## UI states

- **Transactions list**: loading → day-group skeleton rows (stable height, no jank);
  empty (month has no tx) → "No transactions in {Month YYYY}. Add your first one." with
  the Add button; error → inline message + Retry (`refetchList`); success → grouped rows
  + "showing N of M" + "Load more" only when `has_more`.
- **Summary header**: loading → skeleton figures; empty month → zeros rendered via
  `formatMoney` (server still returns currency, R2) + "No spend yet" on the breakdown;
  error → compact error line, does not block the list.
- **Transaction form**: idle; submitting → disabled fields + spinner button; field
  errors from zod + routed API errors; create degraded (currency unknown) → disabled
  submit + notice; success → close modal, list/summary refetch.
- **Categories screen**: loading → skeleton groups; empty (never truly empty — 18 system
  seeds) so effectively always populated; error → message + Retry. System rows visually
  distinct + edit-gated (C4).
- **Confirm dialogs**: pending state on confirm button; error surfaced in-dialog; closes
  only on success.

## Disagreements

None with the senior rulings (R1–R5) or the Q1–Q6 defaults — all adopted as written.
Two decisions flagged for awareness, not objections:

1. **Form schemas added to `packages/shared`** (`transactionFormSchema`,
   `categoryFormSchema`). This is within shared's stated remit (0.4 "zod form schemas")
   and satisfies the standard "the same schema the mobile client uses". It is not a new
   package or a contract change. Raising it because it slightly widens shared beyond what
   R5 named (R5 only named the month helpers).
2. **"Load more" via `useInfiniteQuery`**, which places `offset` as the query's
   `pageParam` rather than as a member of the query key. T1/T2/T9 name the list key as
   `['transactions', filters]`; I read "filters" as the stable slice (from/to/category/
   kind/limit) with `offset` as the page cursor — the idiomatic TanStack shape that makes
   accumulate-and-invalidate correct. If senior prefers `offset` folded into the key with
   manual page accumulation instead, say so; the rest of the plan is unaffected.

## Open questions

None blocking. R2's currency-chip degraded path is resolved in "Forms" (omit chip +
disable create submit until summary currency resolves; edit uses row currency). No API
endpoint is required; schema.d.ts stays byte-identical.

## Risks

- **Cross-month edit invalidation** (edit moving a tx's `occurred_at` to another month):
  must invalidate BOTH old and new month summaries — easy to forget the old one. Covered
  in the invalidation table; watch at diff.
- **Infinite-query invalidation** refetches all loaded pages (correct but N requests for
  a deep month); acceptable for MVP volumes (~100–150 rows / 200 cap).
- **Currency exponent on create** if summary errors — mitigated by disabling submit
  until currency is known rather than guessing an exponent (JPY vs RUB differ).
- **Focus management** in `Modal` (trap + restore) is the a11y-fragile part; web-qa
  checklist must exercise keyboard open/close/Esc.
- **Composite-key collision** (refund case) is silent if a dev keys on `category_id`
  alone — enforced by the `${id}:${kind}` helper and called out in review.

## Obligations coverage

| Obligation | Plan step that discharges it |
|---|---|
| C1 | `lib/patch.ts` `buildCategoryPatch` + patch.test.ts (touched-only, `""`→`null`, name/kind never null) |
| C2 | `lib/errors.ts` `describeCategoryError` code map (readonly/not-found/conflict) + `getValidationIssues` array arm; 409 routed to `name` field |
| C3 | `data/categoryLookup.ts` `sortForDisplay` (`Intl.Collator` within kind group) + test |
| C4 | `CategoryRow`/`CategoryFormModal` gate edit/archive on `is_system===true`; server 403 backstop |
| C5 | `qk.categories()` single archived-inclusive key; mutations `setQueryData`-by-id or invalidate; no single-row GET |
| C6 | Archive/unarchive = `PATCH {archived}` via `ConfirmDialog`; no DELETE |
| C7 | `categoryFormSchema` hex regex case-insensitive; color compares case-insensitive |
| C8 | No client dedup gate; rely on server 409 → `name` field (C2) |
| T1 | `useTransactions` infinite query, limit=200, `getNextPageParam` derives `has_more`; `total` → "showing N of M" |
| T2 | `params.query` from/to/category_id/kind/limit; `from`/`to` from `toApiDate`, object keys only; filter set in `qk.txList` |
| T3 | `SummaryHeader` join to `buildCategoryIndex` (archived-inclusive), `${id ?? 'uncategorized'}:${kind}` keys, "Uncategorized" label |
| T4 | Totals + net via `formatMoney(_, summary.currency)`; amount inputs via `moneyAmountSchema`; no `toInputString`/`toFixed` on summary |
| T5 | Reference `TransactionKind`/`CategoryKind` at their sites; category→tx kind by direct assignment; no shared `type Kind` |
| T6 | `lib/errors.ts` `describeTransactionError` + `getValidationIssues` runtime narrow (`string \| ValidationError[]`), five codes mapped |
| T7 | `lib/patch.ts` `buildTransactionPatch` + patch.test.ts (category_id/note→`null`; amount/kind/occurred_at never null) |
| T8 | No currency field in forms; render via `row.currency`/`summary.currency`; create chip display-only |
| T9 | `qk.txList`/`qk.txSummary` keys; edit sources row from cache/state (no GET/{id}); invalidate list + affected month(s) summary after every tx mutation |
| T10 | shared `monthParam`/`monthBounds`/`shiftMonth`/`formatMonthLabel` + vitest; `formatApiDate` for `occurred_at` only |
| A1 | `ProtectedShell` terminal-me-error affordance + Retry |
| A2 | `LoginPage`/`RegisterPage` authed-bounce `<Navigate>` guard |
| A3 | `describeAuthError` consults `getValidationIssues` → email-field routing for reserved-TLD 422 |
| A4 | Coordinator body-preservation vitest kept green + untouched; full vitest gate each round |
| G1 | `schema.d.ts` byte-identical; no api-client contract edits (getErrorCode unchanged) |
| G2 | typecheck + lint + full vitest gate every round |
| G3 | Root ownership; no cross-package contract/architecture changes |
</content>
</invoke>
