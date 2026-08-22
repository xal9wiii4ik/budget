# Implementation Plan (web): recurring-dates-and-income

Binding contract: `.tasks/recurring-dates-and-income/architecture.md` (A1–A7, B1–B6, C).
Mobile is OUT of this scope: no `apps/mobile` file is touched, and every shared-package
edit below is checked against the frozen client (evidence in W1 §Shared-package safety).

## Approach

Two subtasks, both STANDARD tier. W1 is the recurring half: one new form field
(`start_date`) plus a read-only upcoming widget on `/transactions`. W2 is copy-only
plumbing: the transaction form's labels become kind-aware, and `/goals` gains one
line naming the free-balance window.

Neither subtask adds a library, a state manager or a new invalidation predicate.
The widget joins the EXISTING `['recurring', …]` root rather than opening a new one
(justified below) — which is the only place this plan deviates from "new feature =
new root", and it does so to inherit invalidation that is already correct.

Order: W1 depends on the regenerated contract (see Seam), W2 does not. W2 can land first.

---

# W1 — start_date + upcoming widget (STANDARD)

## Files touched
- `packages/shared/src/schemas.ts` — `recurringTemplateFormSchema`: `start_date` input
  field, output `string | null`, plus the START/END order rule (mirrors A7's 422).
- `packages/api-client/src/patch.ts` — `buildRecurringTemplatePatch`: `nullableChange`
  on `start_date` (the `end_date` line, verbatim shape).
- `packages/api-client/src/patch.test.ts` — extend the recurring fixture (see Tests).
- `packages/shared/src/i18n/errors.ts` — new keys `recurring.startAfterEnd`,
  `recurring.startTooEarly` (en+ru).
- `apps/web/src/lib/errors.ts` — `RecurringField` += `'start_date'`; new cases
  `START_DATE_AFTER_END_DATE` and `START_DATE_TOO_EARLY` → field `start_date`.
- `apps/web/src/features/recurring/TemplateFormModal.tsx` — the field (create + edit echo),
  defaults, `initial` baseline, create body.
- `apps/web/src/features/recurring/TemplateList.module.css` — `.next` gets weight/accent
  (the "more prominent `next_due_on`" ask; markup and copy unchanged — cheap, zero risk).
- `apps/web/src/data/queryKeys.ts` — `qk.recurringUpcoming(days)`.
- `apps/web/src/data/recurring.ts` — `useUpcomingCharges(days)`.
- `apps/web/src/features/recurring/UpcomingCharges.tsx` (+ `.module.css`) — NEW widget.
- `apps/web/src/features/recurring/upcomingRows.ts` — NEW pure module (row cap + the
  today flag, per PM 2026-08-22).
- `apps/web/src/routes/TransactionsPage.tsx` — mount the widget.
- `apps/web/src/i18n/dict.en.ts` / `dict.ru.ts`.

## Form field (A1–A7)
Placed directly ABOVE `end_date` (start-then-end reads as one period; both are
`<input type="date">`, same markup as `end_date`).

- Label `templateForm.startDate`, hint `templateForm.startDateHint` — states A2/A5 in
  words: the first transaction lands on the first matching date on or after it; empty =
  today's behaviour (next natural date).
- Create: `defaultValues.start_date = ''`; create body sends `values.start_date`
  (`null` when empty — the schema already folds `'' → null`, `end_date` precedent).
- Edit echo: `defaultValues.start_date = template.start_date ?? ''`; `initial.start_date
  = template?.start_date ?? null`; the diff is `nullableChange`, so unchanged → omit,
  cleared → `null` (A4's explicit-null arm), changed → the date.
- PAST start date — CHANGED per PM 2026-08-22 (`START_DATE_TOO_EARLY`, server REFUSES
  instead of clamping; the old `templateForm.startDatePassed` advisory is DELETED because
  the clamp it described no longer exists):
  - CREATE: the client schema pre-empts the obvious arm — `start_date < todayApiDate()`
    (lexicographic `YYYY-MM-DD` compare, UTC, same basis as the server's `_today()`) →
    field issue on `start_date`. Cheap, deterministic, no round-trip for the common typo.
  - EDIT: NO client-side floor. The PATCH floor is `min(watermark, today)` and the
    watermark is server-only state — replicating it would guess wrong. The 422 is the
    primary UX; `START_DATE_TOO_EARLY` routes to `start_date`, the field keeps the user's
    typed value, the modal stays open and re-submittable (shipped error path, unchanged).
  - Copy intent (`recurring.startTooEarly`): past charges are never rewritten; for earlier
    history create a new template or add the transactions manually.
- START > END: caught client-side by the schema (issue on `start_date`); the server sends
  the SAME string code `START_DATE_AFTER_END_DATE` from create AND PATCH (router-level in
  both — per PM 2026-08-22), so error routing is one case with no Pydantic-array arm.

## Shared-package safety (frozen mobile) — verified, not assumed
`grep` over `apps/mobile/src`: mobile imports exactly `formatMoney`, `formatApiDate`,
`sentenceEnd`, `signedLegFor`, `shiftMonth`, `formatMonthLabel`, `HEX_COLOR_PATTERN`,
`parseMoney`, `transactionFormSchema` from `@budget/shared`, and has ZERO references to
`recurringTemplateFormSchema`, `RecurringTemplateFormValues`,
`buildRecurringTemplatePatch`, `errorMessage`/`ERROR_MESSAGES` or anything recurring
(`apps/mobile/src/data/accountLookup.test.ts` is the only file whose text matches
"recurring", incidentally). Web is the sole consumer of all three symbols this subtask
edits. A web-local fork of a 130-line money+anchor parsing schema would be strictly
worse (two implementations of `parseMoney`/anchor rules), so: extend in place. The
`ErrorMessageKey` addition is a union member + one entry per language record — additive,
and mobile calls `errorMessage` nowhere.

## Data layer — widget
- Key: **`qk.recurringUpcoming(days) = ['recurring', 'upcoming', { days }]`**.
  Same root as `['recurring','list']`, `key[1]`-disambiguated (the goals/transactions
  pattern). Deliberate: `invalidateTemplates()` in `data/recurring.ts` already invalidates
  the bare `['recurring']` prefix, so create / PATCH / pause-resume / delete refresh the
  widget with NO new invalidation code — and a template edit is precisely what changes the
  upcoming list. A disjoint root would have to re-derive that, and could drift.
- **Transaction mutations do NOT invalidate it.** The endpoint reads templates +
  `last_materialized_on`; a manual transaction changes neither. The one writer nobody
  observes is the 00:30 UTC materializer (WR-2 already records that no client event
  covers it) — so `staleTime: 60_000`, matching the list, and a tab left open across
  midnight is stale exactly as the `/recurring` screen already is. No polling.
- `days = 30` is a module constant for now (contract default; `ge=1 le=90`). It sits in
  the key so a future horizon control is a parameter change, not a cache redesign.
- Render the server's order VERBATIM (B5 sorts by `(due_on, created_at, id)`): no client
  sort, no grouping, no totals. Summing across items would be cross-currency money math.

## Widget UI (`UpcomingCharges.tsx`)
Mounted between `<SummaryHeader/>` and the account-filter chip on `/transactions`.

- Heading `upcoming.title` names the horizon ("Next 30 days") — it is NOT month-scoped,
  so it must not read as a fact about the selected month.
- Row: `formatApiDate(due_on, {locale})` · name · `formatMoney(kind === 'expense' ?
  -amount_minor : amount_minor, item.currency, {locale})` — the TemplateRow convention
  (sign from `kind`, the item's OWN currency, never the base). `key={`${template_id}:${due_on}`}`
  (a template legitimately appears several times in 30 days; never an index).
- Cap: `upcomingRows(items, { max: 5, today: todayApiDate() })` → `{ rows, hiddenCount }`
  where each row carries `isToday`, render-side truncation of a server-sorted list
  (architecture explicitly allows it). When `hiddenCount > 0`, a plural line
  `upcoming.more` (Intl.PluralRules) + a `<Link to="/recurring">`.
- **TODAY badge (mandatory, PM 2026-08-22).** `isToday = due_on === today`, a string
  compare of two `YYYY-MM-DD` values against **UTC** today — the same basis as
  `freeBalanceWindow` and the server's `_today()`; a local-midnight compare would mislabel
  rows for hours around the boundary. The comparison lives in `upcomingRows.ts` (pure, and
  `today` is injected, so it is testable without clock stubs); the component passes
  `todayApiDate()` and never compares dates itself.
  Semantics to preserve in copy: the widget lists charges that have NOT been materialized
  yet, dated today or later — so a today-row means "will be charged today, hasn't been".
  Render: the date cell gets an inline `<span>` badge `upcoming.today` («сегодня» / "today")
  with the accent colour + the row a subtle accent left-border; text label, not colour
  alone (a11y). "Charges today" vs "charges next week" must read at a glance.
- `queryPhase` 4 arms: `loading` → two fixed-height skeleton rows (no jank);
  `error`/`unreachable` → `<QueryStateNotice compact>` with retry (the widget must not
  shout over the page); `ready` + empty → `upcoming.emptyTitle` / `upcoming.emptyBody`
  with a link to `/recurring` (says what to do next, per the UX baseline).
- Account filter active: append `upcoming.allAccountsNote` ("across all accounts") —
  the endpoint takes no account param, and the SummaryHeader caveat sets the precedent.
  No client-side filtering of the list (it would fight the cap and the server's order).
- Semantics: `<section aria-labelledby>` + `<ul>/<li>`; the rows are text, not buttons.

## i18n keys added (names only)
`templateForm.startDate`, `templateForm.startDateHint`,
`upcoming.title`, `upcoming.loadFailed`, `upcoming.emptyTitle`, `upcoming.emptyBody`,
`upcoming.manage`, `upcoming.allAccountsNote`, `upcoming.more` (PluralForms),
`upcoming.today` (PM 2026-08-22).
Removed vs the first draft: `templateForm.startDatePassed` (advisory deleted, see above).
`@budget/shared` error copy: `recurring.startAfterEnd`, `recurring.startTooEarly`
(en + ru, PM 2026-08-22).

## Seam: contract regeneration
`packages/api-client/src/generated/schema.d.ts` currently has NEITHER `start_date` NOR
`/recurring/upcoming` (grep: no match). Therefore:
- `buildRecurringTemplatePatch` and the create body cannot compile until
  `RecurringTemplateCreate/Update/Read` carry `start_date`;
- `apiClient.GET('/recurring/upcoming')` cannot be typed at all until the path exists —
  and no `as` cast may be used to fake it (CLAUDE.md invariant).
Sequencing (RESOLVED, PM 2026-08-22): **no hand-mirrored contract types.** W2 lands
first (it has no contract dependency); W1's data layer starts only AFTER the regeneration
commit and takes its types from `components['schemas'][…]` directly. The fallback
local-type block from the first draft is dropped.

## Tests (house rule: only genuinely breakable pure logic)
- `packages/api-client/src/patch.test.ts`: `start_date` unchanged → omitted; cleared →
  explicit `null`. It is breakable and load-bearing — A4 gives `null` a distinct
  watermark meaning, and a dropped key would silently mean "keep".
- `packages/shared/src/schemas.test.ts`: start > end raises on `start_date`; empty → `null`;
  create-mode past `start_date` raises on `start_date` (the pre-empt arm, PM 2026-08-22) —
  and edit mode does NOT (no watermark floor client-side). The null/omit/value patch tests
  above are unchanged.
- `upcomingRows.test.ts`: cap + `hiddenCount` (off-by-one is the classic), and `isToday`
  true only for `due_on === today` (the row above/below it must be false).
- NO DOM test for the widget or the form (project rule; QA covers rendering).

## Estimates (AGENT-MINUTES)
writing 45 / gates (lint + typecheck + vitest) 10 / verification 10.

---

# W2 — income form mirror + goals basis copy (STANDARD)

## Files touched
- `apps/web/src/features/transactions/TransactionFormModal.tsx`
- `apps/web/src/features/transactions/kindCopy.ts` — NEW pure module (kind → key map)
- `apps/web/src/routes/GoalsPage.tsx`
- `apps/web/src/features/goals/freeBalanceWindow.ts` (+ `.test.ts`) — NEW pure module
- `apps/web/src/i18n/dict.en.ts` / `dict.ru.ts`

## The whole form, field by field (kind = income vs expense)

| # | Field | Change when kind = income |
|---|---|---|
| 1 | `AccountField` label (`txForm.account` = "Account") | → `txForm.accountIncome` "Received to" / «Куда пришло»; expense gets `txForm.accountExpense` "Paid from" / «С какого счёта списано». `txForm.account` is retired (no other call site: the template and transfer forms have their own keys). |
| 2 | Receipt currency warning | unchanged (receipt-confirm mode is expense in practice, and the sentence is about currency, not direction) |
| 3 | Amount slot, single-amount mode (`txForm.amountLabel` "Amount, {currency}") | → `txForm.amountLabelIncome` "Received, {currency}" / «Получено, {currency}» |
| 4 | Amount slot, PAIR mode (`txForm.spentLabel` "Spent, {currency}") | → `txForm.receivedLabel` «Получено, {currency}» (same slot, `original_amount`) |
| 5 | Spend-currency input `aria-label` + hint | → `txForm.spendCurrencyAriaIncome` / `txForm.spendCurrencyHintIncome` («Пришло в другой валюте?») |
| 6 | Charged field label `txForm.chargedLabel` | → `txForm.creditedLabel` "Credited to the account, {currency}" / «Зачислено на счёт» |
| 7 | `chargeDefault`, `chargeManual`, `manualChargeRequired` (all say "your bank charged/took") | → `…Income` variants ("what actually landed on the account") |
| 8 | `chargeNoRateAhead`, `chargeEstimate`, `chargeRecalc*`, `chargeFetchFailed`, `converting`, all `converted*` | UNCHANGED — they talk about rates and conversion, which is direction-free. Deliberate: doubling them buys nothing and doubles the ru review surface. |
| 9 | Type radios (`common.type` / expense / income) | unchanged — this IS the switch |
| 10 | Category select + optgroups + suggestion hints | unchanged (already kind-filtered by the shipped logic) |
| 11 | Date (`common.date`) | unchanged — neutral in both languages |
| 12 | Merchant `txForm.merchantLabel` "Name / place" | **RELABEL, NOT HIDE** → `txForm.merchantLabelIncome` "Source" / «Источник (кто заплатил)», + `txForm.merchantHintIncome`. Justification below. |
| 13 | Note, AttachPhoto, More options → Country | unchanged |
| 14 | Delete / save / titles | unchanged |
| 15 | FIELD ORDER | ONE change: the Type fieldset moves ABOVE `AccountField`, so the form is already worded correctly before anything is filled in. Nothing else moves — reordering more would relocate controls under the user's cursor on a radio flip. |

**Merchant: relabel, not hide.** `rowDisplay.rowTitle()` uses `merchant` as the row's
TITLE (`rowDisplay.ts:130`), so hiding it for income would leave every salary row titled
by its category alone. Hiding also does not remove the field from the payload: both the
create body and the edit diff always compute `merchant`, so a hidden input would either
keep submitting typed text invisibly or need clear-on-switch logic that DESTROYS data on
an accidental radio flip. Relabelling costs two keys and loses nothing.

**Kind-switch logic stays intact**: `onKindChange` (clear a category whose kind no longer
matches) and the category→kind write are untouched. All labels are DERIVED during render
from the watched `kind` — no effect, no second copy of the kind in state.

`kindCopy.ts` is a pure `Record<'expense'|'income', {account, amount, …}>` of `SimpleKey`s,
so a typo is a typecheck failure. NO test: it is a lookup table, and a test asserting the
table equals itself is exactly the vacuous test the house rule forbids.

## Goals: free-balance basis line (verdict C — UI copy only)
- `freeBalanceWindow.ts`: pure, `(now: Date) => { fromMonth: string; toMonth: string }`,
  the three FULL months before the current one — `goal_reads.py:105-115` iterates
  `offset ∈ [-3, -1)` from `today.replace(day=1)`, and `routers/goals.py:73` makes `today`
  **UTC**. The module therefore reads UTC components (not `currentMonth()`, which is local)
  so the label cannot name the wrong window for a few hours around a month boundary.
  Returns `"YYYY-MM"` strings; `GoalsPage` renders them with `formatMonthShortLabel(…,
  {locale})`. Pure calendar labelling, no money, no API change (architecture C).
- `GoalsPage`: after the free-balance line (both arms — the `> 0` and the `None` arm),
  a `<p>`: `goals.freeBalanceBasis` ("Based on {from}–{to}") plus
  `goals.freeBalanceCurrentMonthNote` — the sentence that actually answers complaint 4:
  income booked this month starts counting when the current month closes. Both arms get
  it; the "nothing to share out" arm is where the confusion bites hardest.
- No change to `goals.freeBalancePrefix/Suffix/None` beyond leaving them intact.

## i18n keys added (names only)
`txForm.accountExpense`, `txForm.accountIncome`, `txForm.amountLabelIncome`,
`txForm.receivedLabel`, `txForm.spendCurrencyAriaIncome`, `txForm.spendCurrencyHintIncome`,
`txForm.creditedLabel`, `txForm.chargeDefaultIncome`, `txForm.chargeManualIncome`,
`txForm.manualChargeRequiredIncome`, `txForm.merchantLabelIncome`,
`txForm.merchantHintIncome`, `goals.freeBalanceBasis`, `goals.freeBalanceCurrentMonthNote`.
Removed: `txForm.account`. (en set + ru mapped type; typecheck enforces parity.)

## Tests
- `freeBalanceWindow.test.ts` ONLY: year rollover (Jan → Oct–Dec of the previous year)
  and the UTC-vs-local boundary. Genuinely breakable, and it is the one thing that can
  make the new copy LIE about which months the server used.
- No DOM tests for copy changes (house rule).

## Estimates (AGENT-MINUTES)
writing 35 / gates 10 / verification 8.

---

## UI states summary
- `/transactions` widget: loading (2 skeleton rows) · unreachable (network notice + retry)
  · error (`upcoming.loadFailed` + retry) · empty (what to do + link to /recurring) · ready.
- Template form: unchanged 4-arm account field; the new field adds two error arms only
  (client schema: start > end, and create-mode past date; server 422:
  `START_DATE_AFTER_END_DATE` / `START_DATE_TOO_EARLY`, both routed to `start_date` with
  the modal open and the typed value kept). No advisory arm — deleted per PM 2026-08-22.
- `/goals`: unchanged phases; the basis line renders in both free-balance arms and never
  in a loading/error arm (it would be a claim about numbers that are not there).

## Open questions — all RESOLVED (senior-lead / PM 2026-08-22)
1. Type-radio reorder (W2 #15): APPROVED.
2. Widget row cap 5 / horizon 30: APPROVED.
3. Contract seam: no hand-mirrored types; W2 first, W1 data layer after the regen commit.

## Risks
- **Contract seam (W1)**: nothing in W1's data layer compiles until the regenerated
  `schema.d.ts` lands — W1's data layer is BLOCKED on that commit by decision, not by luck.
- **`START_DATE_TOO_EARLY` on PATCH** is the only rule the client cannot predict
  (server watermark). If the 422 payload's field routing regresses, the message lands in
  the form-level banner instead of the field — QA should hit it deliberately.
- **Patch discipline**: `start_date` is the second field where `null` has a distinct
  server meaning (it rewinds a future seed, A4). A diff bug here is a watermark bug —
  hence the two pinned patch tests.
- **ru copy volume (W2)**: 14 new keys across two dictionaries; a wrong Russian case in
  «Куда пришло»/«Получено» is the likeliest defect. QA should read the income form in ru.
- **Widget staleness across midnight** is accepted and documented, not a bug to chase.
- `txForm.account` removal touches only one call site; typecheck catches any miss.
