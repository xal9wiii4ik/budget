# plan-mobile-A — line A (transactions list + categories)

Decisions only; the reasons live inline in the code.

## 1. Search / filters / sort on the transactions tab

- `src/data/queryKeys.ts` (+ own block): `TxSort` read off the generated PATH
  (`paths['/transactions']['get'].parameters.query.sort`), like web — never a
  hand-written union. `TxListFilters` += `q?`, `country?`, `sort?`, and `from`/`to`
  become OPTIONAL (all-time omits both). Every member omitted-not-undefined, so the
  unfiltered month key stays byte-identical.
- `src/features/transactions/txFilters.ts` — the mobile port of web's key grammar.
  What is COPIED verbatim (same rules, same reasons): `TX_SORTS`, `DEFAULT_TX_SORT`
  (never sent), `TX_LIST_LIMIT` (= `MONTH_LIMIT`, re-exported from data/transactions
  so the tab / category screen / the tx form's edit-row lookup cannot split the
  cache), `toTxSort`, `isValidRangeDate`, `customRange`, `rangeBounds`, `isNarrowed`,
  `showsDayGroups`.
  What is DROPPED: everything URL-shaped (`parseTxFilters`, `adoptsUrlSearchText`,
  `txExportFilters`) — mobile has no URL and no export. The selection is screen
  state, so the type is `TxSelection` (a `TxRangeMode` + four nullable members)
  instead of web's flat parsed-URL shape.
- ONE test (`txFilters.test.ts`) pinning what actually breaks caches: the omission
  rule (unfiltered month == the historical three-key object) and the
  default-sort normalization (`toTxSort('date_desc') === null`).
- UI, all screen-local state:
  - `TxSearchField.tsx` — a `TextInput` + clear button; the screen debounces via
    `useDebouncedValue` (350 ms) and trims. No render-time resync dance: with no URL
    there is no external writer of `q`, so the field owns its own text.
  - `TxFiltersSheet.tsx` — a built-in RN `Modal` (`presentationStyle` default,
    `animationType="slide"`), a DRAFT held inside and applied on "Apply" so a
    half-composed custom range never becomes a query key. Sections: range mode
    (Month / All time / Custom + two `DateTimePicker`s wired exactly like the
    forms), category (chips over the archived-inclusive cache, +All), country
    (`lib/countryLabel.countryOptions` + filter field + 30 cap — the CountryField
    pattern, the Hermes seam), sort (4 chips).
  - `TxFilterChips.tsx` — active-filter chips with per-chip clear (range, category,
    country, sort). Search is NOT chipped (the box shows it verbatim); the account
    filter keeps its own `AccountFilter` control, unchanged.
- Month mode keeps the `MonthPicker` in the toolbar; all/custom replace it with a
  label + "back to month".
- Summary: rendered only in month mode (web's rule — `GET /transactions/summary` is a
  MONTH aggregate). `tx.filterNotice` is REPLACED by web's two-sentence split:
  `tx.filterChip` (the account chip) + `tx.filterSummaryNote`, the latter shown only
  when the summary is on screen AND `isNarrowed`.
- `TransactionList` gains `grouped` (flat single section under amount sorts, rows
  then print their own date via a new `showDate`), `periodLabel` replacing
  `monthLabel`, and `filtered`/`allTime` for the four empty arms (+ "clear filters").
  `onAddFirst` becomes optional (the category screen has no "add here").
- EDIT NAVIGATION: from a filtered/all-time/custom list the form gets
  `month: transaction.occurred_at.slice(0,7)` — the ROW's month, not the screen's.
  The form locates its row in the cached `{from,to,limit:MONTH_LIMIT}` month list and
  there is no `GET /transactions/{id}`.
- `narrowed` is computed on the screen and a WIDGET SLOT comment sits right above the
  list for lines B/C.

## 2. The original pair in list rows (N-2)

- `rowDisplay.ts` + its test move to `packages/api-client/src/` (the `buildCreateBody`
  precedent), exported from the barrel. Web's file becomes a re-export ONLY — its two
  consumers (`TransactionRow`, `imports/ImportRow`) keep their import lines.
- Mobile `TransactionRow` renders `primary` big (paid currency) and `secondary` muted,
  with the `≈` prefix only on the `base` arm — web's exact rendering.
  `summaryCurrency` is passed from the summary when it is on screen, else `undefined`
  (the base arm is then unreachable, which is the honest answer: a base equivalent
  cannot be judged stale without knowing the base).

## 3. Category → its operations

- New screen `app/(app)/category-transactions.tsx` (`?id=`), PUSHED (not modal):
  registered in `(app)/_layout.tsx` and added to `MODAL_PARENT_TAB → /categories`,
  because the id is unrecoverable after re-login (no `GET /categories/{id}` join for a
  cold cache; the category list IS refetchable but the screen would still be a
  half-answer, and the existing rule for id-carrying routes is the parent tab).
  Header title = the category name (`Stack.Screen options` set from the screen).
- Period = local `month | custom`. NO all-time: the headline is
  `/stats/summary.by_category`, whose grammar has no all-time unit (web's
  `categoryDrilldown.ts` reason, copied).
- `src/data/stats.ts` — `useStatsSummary(period)` only. `qk.statsSummary(period)` with
  `StatsPeriodQuery` (web's type, copied into queryKeys) as the key member, so a
  cached entry cannot drift from the request that filled it.
- `src/features/categories/categoryDrilldown.ts` — `categoryStatsPeriod` +
  `categoryPeriodTotal` copied VERBATIM from web (id AND kind match; a refund books
  income against an expense category). No test: the function is web-tested unchanged.
- Rows reuse `TransactionList` with filters from `txFilters.txListFilters` for
  {category, period} → the same cache entry the tab would use. Tapping a row opens the
  edit form with the ROW's month.
- `unconverted_count > 0` → one line, web's `unconverted.totals` plural copy.
- Entry: a drill affordance (›) on every `CategoryRow`, system rows included (they are
  not editable but ARE drillable); the edit press stays on user rows only.
- Categories tab: client-side name search (`categorySearch.ts`, web's
  `filterCategories` copied verbatim — `toLocaleLowerCase(locale)` + `includes`).

## 4. Invalidation

- `data/transactions.ts`: a new `invalidateStats` (bare `['stats']`) called from the
  three `onSuccess` blocks — I introduce the family, so any write can move any cached
  period and blanket is the only honest scope. Minimal, anchored edits; line C adds its
  goals arm to the same blocks.

## Dictionary

New family prefixes, all wording lifted from web's dict: `tx.search*`, `tx.filters*`,
`tx.filter{Category,Country}*`, `tx.sort*`, `tx.range*`, `tx.empty*`,
`tx.showAllCategories`, `categories.search*`, `categories.viewTransactionsFor`,
`categoryTx.*`, `unconverted.totals`, `period.from`/`period.to`. Removed:
`tx.filterNotice` (superseded by `tx.filterChip` + `tx.filterSummaryNote`).

## Out of scope / left to others

Export CSV, recurring badge, goal-item filter, the two widgets themselves (slot
comment only), `photo.attach` dead key (line B owns it).
