# QA Web Checklist: web-transactions-ui (roadmap 1.6)

## Scope

Browser-level user-journey verification for the MVP main screens delivered by
1.6: the transactions list (month navigation, day grouping, summary header), the
add/edit/delete transaction modal, and the categories management screen. All
built on the existing API (no API changes — schema.d.ts byte-identical, G1).

This checklist is the browser half of the split. It does NOT re-verify pure
logic already covered by vitest owned by frontend-engineer — PATCH-body
builders (C1/T7), the `getErrorCode` map wiring (C2/T6), `Intl.Collator` sort
functions (C3), money/date helpers, month math (T10), query-key builders. Those
are unit-tested. Here I verify the same obligations *manifest correctly in a
running browser* through real user journeys: what the user sees, what the
network actually sends, and that caches invalidate to server truth.

Out of scope (belongs to qa-engineer, not here): API contract testing with curl,
status-code assertions at the HTTP layer in isolation, DB-level checks.

**Every expected result below traces to an obligation id** (C1-C8 / T1-T10 /
A1-A4 from obligations.md) or to a contract-review edge semantic; the trace is
cited per TC. Nothing here invents API behavior.

**Legend for how each TC runs:**
- `[auto]` — runnable via browser pane tooling / Playwright unaided
- `[auto-network]` — needs request/response inspection (network tab / Playwright
  `route`/`waitForRequest`) to verify the wire shape, not just the rendered UI
- `[manual]` — needs human visual/UX judgment (color distinction, "visually
  distinct", focus feel)
- `[data-heavy]` — requires seeding a specific data set before it can run

Final widget shapes land in plan-web.md; journeys below are written at the USER
level (what the user accomplishes and sees) so they survive widget choices.

---

## Environment note (for the run phase, not grooming)

No dev server exists for these screens yet — implementation has not started.
When it does: start `apps/web` dev server via preview_start with the API running
locally, sign in as a dedicated **test user** (never real data), then execute.
Simulation hooks that several TCs rely on:
- Blocking / rewriting a request (e.g. `/users/me`, a mutation) → Playwright
  `page.route()` or browser devtools request-blocking / override.
- Inspecting the exact JSON body of a PATCH → network tab payload or Playwright
  `request.postDataJSON()`.

---

## Test cases

### TC-1: Authenticated user visiting /login and /register is bounced into the app
- **Verifies**: A2 (bounce authenticated visitors off /login and /register).
- **Run**: `[auto]`
- **Precondition**: Logged in as the test user (valid token present).
- **Steps**:
  1. While authenticated, navigate directly to `/login`.
  2. Observe the result.
  3. Navigate directly to `/register`.
  4. Observe the result.
  5. Confirm any `?next=` param is honored (if authed user hits
     `/login?next=/transactions` they land on `/transactions`, not a loop).
- **Expected**: Both `/login` and `/register` redirect the authenticated user
  into the app (`/transactions`) instead of showing the auth form. No redirect
  loop, no flash of the login form that then persists. (Current code in App.tsx
  routes `/login` and `/register` unconditionally — this bounce is new 1.6 work
  from the 1.5 finding-8 deferral; TC exists to prove it now happens.)

### TC-2: Terminally-errored me-query shows an error affordance, not a blank/half shell
- **Verifies**: A1 (protected-shell error affordance for a terminally-errored
  me-query; 1.5 finding 6).
- **Run**: `[auto]` (needs request blocking, achievable in-browser via
  Playwright route)
- **Precondition**: Logged in (token present, so the guard admits the shell), but
  `GET /users/me` is forced to fail terminally (block the request or return 500
  repeatedly so retries exhaust).
- **Steps**:
  1. Block/500 `/users/me`.
  2. Load `/transactions` (guard passes on token presence, shell mounts, me-query
     fires and errors out after retries).
  3. Observe the shell.
- **Expected**: The shell surfaces a visible, actionable error affordance (an
  error state with a retry, or a clear "couldn't load your profile" message) —
  NOT a blank shell, NOT a permanently-empty header where the email skeleton
  simply never resolves. (Current ProtectedShell renders `null` for the user
  block on error and otherwise looks normal — that silent half-shell is exactly
  the 1.5 finding-6 gap this TC guards.) Base-currency-dependent rendering must
  not crash; see TC-19 note on currency sourcing.

### TC-3: Transactions list default view — current month, day grouping, occurred_at DESC
- **Verifies**: T9 (list query key + default month), T2 (month from/to filter),
  T1-adjacent (default slice), T4/T8 (amount rendering with correct currency).
- **Run**: `[auto]` `[data-heavy]`
- **Precondition**: Test user with a handful of transactions in the **current**
  month across at least two distinct `occurred_at` days, mixed expense/income.
- **Steps**:
  1. Open `/transactions`.
  2. Confirm the month selector defaults to the current month (no manual pick).
  3. Read the list structure.
- **Expected**:
  - The month shown is the current month by default.
  - Rows are grouped by day, and **days descend** (most recent day first); within
    a day, transactions are ordered `occurred_at` DESC per the API.
  - Each row shows an amount rendered via the shared money helper with the row's
    own `currency` (no hardcoded symbol), and expense vs income are visually
    distinguishable with correct signs (see TC-6).
  - No console errors; the list request carries `from`/`to` for the current
    month (verify in network — see TC-4 for the navigation variant).

### TC-4: Month prev/next navigation refetches the correct slice
- **Verifies**: T2 (from/to via toApiDate YYYY-MM-DD), T9 (list keyed by
  filters; summary keyed by month), T10 (month bounds incl. rollover).
- **Run**: `[auto-network]` `[data-heavy]`
- **Precondition**: Test user with transactions in the current month AND in the
  previous month AND in a month that forces a **year rollover** (e.g. data in
  December and January so prev from January lands in the prior year).
- **Steps**:
  1. Open `/transactions` (current month).
  2. Click "previous month"; read the list and inspect the outgoing list request.
  3. Navigate back to a January, then click "previous" to cross into December of
     the prior year.
  4. Click "next month" repeatedly to return.
- **Expected**:
  - Each navigation refetches; the list shows exactly the transactions whose
    `occurred_at` falls in the selected month, nothing from adjacent months.
  - Network: `from`=`YYYY-MM-01` and `to`=month-end in `YYYY-MM-DD`; the summary
    request carries `month`=`YYYY-MM`.
  - Year rollover (Jan → Dec prev year) computes correct bounds — no off-by-one,
    no NaN month, no empty result where data exists (T10 Dec-rollover behavior
    observed end-to-end, not just in vitest).
  - Summary header updates to the navigated month in lockstep with the list.

### TC-5: List UI states — empty (fresh account), empty (month with no tx), loading, error
- **Verifies**: task UI-state requirements; A1-adjacent recoverable error;
  T9 (list query lifecycle).
- **Run**: `[auto]` (loading + error need request throttling/blocking)
- **Precondition**: (a) a brand-new test user with zero transactions; (b) an
  existing user navigated to a month that has no transactions; (c) any user with
  the list request slow-loaded; (d) any user with the list request 500'd.
- **Steps**:
  1. **Empty fresh account**: open `/transactions` as the empty user — read the
     empty state.
  2. **Empty month**: as a user with data, navigate to a month known to be empty.
  3. **Loading**: throttle/delay the list request and load — observe the interim.
  4. **Error**: 500 the list request and load — observe.
- **Expected**:
  - Empty states show a helpful message that tells the user what to do (e.g.
    "No transactions this month — add one"), not a bare blank panel; the empty
    *fresh account* and empty *month* may share copy but must both render, not
    crash.
  - Loading shows a skeleton/spinner, not a flash of "empty" (empty state must
    not appear while the query is pending).
  - Error shows a recoverable affordance (retry / message), not a blank screen or
    a thrown boundary. No console errors beyond the intended failed request.

### TC-6: Amounts render with correct signs and expense/income are visually distinct
- **Verifies**: T4 (formatMoney for values; magnitude-only inputs), T8 (row's
  own currency, no hardcode), expense/income sign presentation per senior ruling.
- **Run**: `[manual]` `[auto-network]` (value round-trip is auto; "visually
  distinct" is manual)
- **Precondition**: A month containing at least one expense and one income
  transaction of known amounts.
- **Steps**:
  1. Open the month; read each row's rendered amount.
  2. Compare an expense row and an income row.
- **Expected**:
  - Expense renders with a locale minus and a color/visual distinction from
    income; income has no negative sign. Signs are correct for each kind (the
    amount magnitude is stored/sent unsigned; sign is carried by kind).
  - The currency symbol matches the row's `currency` field (not a hardcoded
    symbol). No `12.500000001`-style float leakage — values render through the
    shared formatter only. (Test "distinct + correct sign", not pixel specifics —
    presentation TBD in plan.)

### TC-7: Category name/icon shown, including for a transaction whose category was archived after the fact
- **Verifies**: T3 (list/summary join targets the include_archived=true set),
  1.4 decision e (archived-cat txs still render their category).
- **Run**: `[auto]` `[data-heavy]`
- **Precondition**: A transaction assigned category "Rent"; then "Rent" is
  archived (via categories screen or seed) AFTER the transaction exists.
- **Steps**:
  1. Open the month containing that transaction.
  2. Read the row's category name/icon.
- **Expected**: The row still shows the category's name and icon (not "unknown",
  not blank), because the join uses the archived-inclusive category set. The
  archived category does NOT appear in the NEW-transaction picker (see TC-24) but
  historical rows keep rendering it (T3). No console error from a failed lookup.

### TC-8: Pagination — month with >200 transactions, load-more, "showing N of M"
- **Verifies**: T1 (limit=200 single fetch; Load more only when total > loaded;
  has_more = offset + items.length < total; total drives "showing N of M").
- **Run**: `[auto]` `[data-heavy]` (SEEDING-HEAVY — see seed plan)
- **Precondition**: A single month seeded with **>200** transactions (e.g. 250)
  so the first `limit=200` fetch does not cover the month. See Seed Data Plan §5
  for the runnable seeding approach (scripted create loop against the API).
- **Steps**:
  1. Open the seeded heavy month.
  2. Confirm a "Load more" affordance appears (only because total > loaded).
  3. Read the "showing N of M" indicator before and after loading more.
  4. Click "Load more"; confirm additional rows append and the indicator updates.
  5. Navigate to a light month (≤200) and confirm "Load more" is ABSENT.
- **Expected**:
  - First fetch requests `limit=200`; "Load more" shows only when `total`
    exceeds the loaded count (light month shows no control).
  - "Showing N of M" reflects `items loaded` of `total` and updates after
    load-more; after loading everything, N === M and the control disappears.
  - No duplicate rows, no request storm (exactly one additional request per
    "Load more" click — check network).

### TC-9: Add transaction — amount major→minor round-trip, category optional (uncategorized)
- **Verifies**: T4 (moneyAmountSchema magnitude input; formatMoney render), T8
  (no currency collected), T9 (list + summary invalidation, no optimistic lie),
  1.4 decision (category optional).
- **Run**: `[auto]` `[auto-network]`
- **Precondition**: Logged in; know the current summary totals for the month.
- **Steps**:
  1. Open `/transactions`, open the Add modal/panel.
  2. Confirm the form collects NO currency field (T8).
  3. Enter amount in **major units** (e.g. `12.50`), leave category empty, pick
     kind, accept default date.
  4. Submit; wait for the modal to close.
- **Expected**:
  - Network: the create body sends `amount_minor` in **minor units** (1250 for
    12.50) and no `currency` field.
  - The new row appears in the list without a manual reload, and its displayed
    amount round-trips (renders 12.50 again via formatMoney).
  - The row shows an "Uncategorized" treatment (category was optional / omitted).
  - The **summary header totals update** to server truth after the mutation (T9
    invalidation of BOTH list and month summary) — not an optimistic guess. To
    prove no optimistic lie: totals must reflect the server response, and a hard
    refresh (TC-25) shows identical numbers.
  - No console errors; exactly the expected create request + the two
    invalidation refetches (list + summary), no request storm.

### TC-10: Add transaction — kind toggle filters the category picker; picking a category sets kind; flipping kind clears an incompatible category
- **Verifies**: T5 (tx kind defaulted from category.kind, direct assignment),
  Q4 (flipping kind clears incompatible category), category picker segmentation
  by kind (C3 grouping).
- **Run**: `[auto]` `[manual]` (the "cleared" observation is visual)
- **Precondition**: Test user has at least one expense category and one income
  category (beyond system ones).
- **Steps**:
  1. Open Add modal. Set kind = expense; open the category picker.
  2. Confirm only expense categories are offered.
  3. Switch kind = income; confirm only income categories are offered.
  4. Set kind = expense, pick an expense category "Food".
  5. Confirm the form's kind is/stays expense (picking a category sets/keeps kind
     from `category.kind`).
  6. Now flip kind to income.
- **Expected**:
  - Picker contents filter by the selected kind (expense categories for expense,
    income for income), grouped/segmented by kind.
  - Picking category "Food" (expense) results in kind = expense (T5 direct
    assignment from category.kind).
  - Flipping kind to income while "Food" (expense) was selected **clears the
    now-incompatible category selection** (Q4) — the picker does not keep a
    mismatched category. No console error, no way to submit a category whose kind
    contradicts the tx kind.

### TC-11: Add transaction — date defaults to today, future date accepted; note 500-cap enforced with clear feedback
- **Verifies**: task form spec (date default today, future allowed; note 500
  cap), T6/A3-adjacent (field-level validation feedback, not raw JSON).
- **Run**: `[auto]` `[manual]`
- **Precondition**: Logged in; know today's date.
- **Steps**:
  1. Open Add modal; confirm the date field defaults to today.
  2. Set the date to a future date; confirm it is accepted (no block).
  3. Enter a note of exactly 500 chars → accepted; enter 501+ chars → observe.
- **Expected**:
  - Date defaults to today; a future `occurred_at` is accepted and submits.
  - The 500-char note cap is enforced with a clear, field-attached message (or a
    hard input cap) — NOT a raw server-JSON dump, NOT a generic form error. If the
    client caps input, TC-22 covers the bypass path where the server 422s.

### TC-12: Edit transaction — prefill correctness (amount magnitude, no sign in input)
- **Verifies**: T4 (edit prefill is magnitude only; never route through a
  path that throws on sign; sign carried by kind), T9 (edit form sources row
  from list cache / router state, no GET /{id}).
- **Run**: `[auto]`
- **Precondition**: An existing expense transaction of known amount (e.g. 12.50)
  and an income transaction.
- **Steps**:
  1. From the list, open Edit on the expense row.
  2. Read the amount input value and the kind control.
  3. Repeat for the income row.
- **Expected**:
  - The amount input shows the **magnitude** (`12.50`) with **no minus sign**
    inside the input — the sign is represented by the kind control, not typed
    into the amount field (T4: summary/negative values never routed through the
    input-string path).
  - The kind, category, date, note prefill from the row (sourced from list cache
    / router state — no per-tx GET fired; verify in network that no
    `/transactions/{id}` request occurs).

### TC-13: Edit transaction — amount-only edit on a transaction whose category is archived succeeds
- **Verifies**: 1.4 decision e (amount-only PATCH allowed on a tx whose category
  was later archived), T7 (PATCH sends only touched fields).
- **Run**: `[auto]` `[auto-network]` `[data-heavy]`
- **Precondition**: A transaction pointing at a category that is now **archived**
  (reuse TC-7 setup).
- **Steps**:
  1. Open Edit on that transaction.
  2. Change ONLY the amount; leave the (archived) category untouched.
  3. Submit.
- **Expected**:
  - The PATCH body contains ONLY `amount_minor` (the touched field) — no
    `category_id` key at all (T7 omitted-vs-null: untouched = absent). Verify in
    network.
  - The edit succeeds (no CATEGORY_ARCHIVED 422), because the archived category
    was not re-sent. The row updates in the list and the summary updates.
  - No console errors.

### TC-14: Edit transaction — clearing note and category persists as cleared after refresh
- **Verifies**: T7 (cleared category_id/note → `null`; untouched fields absent;
  RHF "" → null bridge), C1-analogous null-vs-omit discipline, T9 invalidation.
- **Run**: `[auto-network]` (network inspection is the core assertion here)
- **Precondition**: A transaction that HAS a note and HAS a category assigned.
- **Steps**:
  1. Open Edit; clear the note field and clear/unset the category; touch nothing
     else.
  2. Submit.
  3. Inspect the PATCH request body.
  4. Hard-refresh (F5) and re-open the row.
- **Expected**:
  - Network: the PATCH body sends `category_id: null` and `note: null`
    **explicitly** (cleared → null), while genuinely untouched fields
    (`amount_minor`, `kind`, `occurred_at`) are **absent** from the body (not
    null, not "", not undefined-as-key). This is the observable manifestation of
    T7 / C1 discipline from the browser — mark automatable via Playwright
    `request.postDataJSON()`.
  - After hard refresh, the note and category read as cleared (server truth
    persisted), confirming null actually cleared the columns (not "" or a no-op).

### TC-15: Delete transaction — confirmation dialog, row gone, summary updates, cancel path
- **Verifies**: T9 (delete invalidates list + month summary), destructive-action
  confirmation baseline.
- **Run**: `[auto]`
- **Precondition**: A month with a known transaction and known summary totals.
- **Steps**:
  1. Trigger delete on a row; confirm a confirmation dialog appears.
  2. **Cancel** it; confirm the row and totals are unchanged.
  3. Trigger delete again; **confirm**.
- **Expected**:
  - Delete is gated behind a confirmation dialog (no one-click destructive
    delete).
  - Cancel leaves the row and summary intact.
  - Confirm removes the row from the list without manual reload, and the summary
    header totals update to server truth (T9 dual invalidation). Hard refresh
    (TC-25) shows the row still gone. No console errors; exactly one DELETE plus
    the invalidation refetches, no storm.

### TC-16: Summary header — income/expense/net correct, NEGATIVE net rendered with minus
- **Verifies**: T4 (formatMoney for income/expense/net; negative net renders with
  locale minus; never routed through the throwing input path).
- **Run**: `[auto]` `[data-heavy]`
- **Precondition**: A **crafted month** where total expense > total income so
  `net_minor` is negative, with round numbers you can verify by hand.
- **Steps**:
  1. Open the crafted month.
  2. Read income, expense, and net in the summary header.
- **Expected**:
  - Income and expense show the correct non-negative magnitudes; net = income −
    expense and, being negative, renders with a **locale-correct minus** (e.g.
    "-123,45 ₽" / "-$123.45") via formatMoney — no crash, no swallowed value, no
    NaN. Currency comes from `summary.currency` (T4/T8). No console error.

### TC-17: Summary breakdown — uncategorized bucket labeled; refund case shows TWO rows without React key warnings
- **Verifies**: T3 (null bucket → "Uncategorized" label; breakdown keyed
  `${category_id ?? 'uncategorized'}:${kind}`; refund repeats a category_id under
  both kinds).
- **Run**: `[auto]` `[data-heavy]` (console inspection required)
- **Precondition**: A crafted month containing: (a) at least one uncategorized
  transaction; (b) a **refund pair** — the SAME category with both an expense
  transaction and an income transaction (so `by_category` lists that category_id
  twice, once per kind). See Seed Data Plan §4.
- **Steps**:
  1. Open the crafted month; open/read the by-category breakdown.
  2. Open the browser console and watch for React warnings during render.
- **Expected**:
  - The `category_id === null` bucket renders with an "Uncategorized" label (not
    raw null, not blank).
  - The refund category appears as **TWO distinct rows** — one expense, one
    income — both visible, neither collapsing or overwriting the other.
  - **Console shows NO "Encountered two children with the same key" warning**
    (proves the composite `${category_id}:${kind}` key, not `category_id` alone).
    This console check is the load-bearing assertion of the TC.

### TC-18: Categories management — merged list grouped by kind; system categories visually distinct and NOT editable/archivable in UI
- **Verifies**: C4 (gate edit/archive on is_system === true; server 403 is
  backstop), C3 (grouped by kind), task categories spec.
- **Run**: `[auto]` `[manual]`
- **Precondition**: Logged in; the account has the system categories plus at
  least one user-created category per kind.
- **Steps**:
  1. Open the categories management route.
  2. Confirm categories are grouped by kind (expense group, income group).
  3. Locate a system category and a user category.
  4. Attempt to find edit/archive affordances on each.
- **Expected**:
  - Single merged list grouped by kind.
  - System categories are visually distinct (badge/style) AND expose **no**
    edit/archive controls in the UI (gated on `is_system`, not merely relying on
    the server 403). User categories DO expose edit/archive. No console error.

### TC-19: Categories management — create with icon + color, rename
- **Verifies**: C5 (create/patch update the cache from returned CategoryRead or
  invalidate; new row appears), C7 (color casing not assumed canonical),
  T8/base-currency-display note.
- **Run**: `[auto]` `[auto-network]`
- **Precondition**: Logged in on the categories screen.
- **Steps**:
  1. Create a new category: name, an icon, and a color entered in **lowercase
     hex** (e.g. `#abc123`) to exercise C7.
  2. Submit; confirm it appears in the correct kind group without reload.
  3. Rename an existing user category; confirm the new name appears.
- **Expected**:
  - Created category appears immediately (cache updated from the returned
    CategoryRead or the key invalidated — C5), placed in the right kind group and
    at the locale-correct sort position (see TC-23).
  - The color the user entered is preserved/compared case-insensitively — no
    breakage or mismatch from lowercase vs uppercase hex (C7); the swatch renders.
  - Rename reflects immediately. No console errors.
  - (Note on base currency: it is display-only and sourced from the summary
    response — the categories screen never collects currency; confirm no currency
    field appears here either, T8.)

### TC-20: Categories management — duplicate name in same kind → field-level 409 message, not generic
- **Verifies**: C2 (409 CATEGORY_NAME_CONFLICT surfaced field-level on rename OR
  create; "name already exists in this kind"), C8 (rely on server 409, no
  client-side hard dedup gate).
- **Run**: `[auto]` `[auto-network]`
- **Precondition**: An expense category named "Groceries" already exists.
- **Steps**:
  1. Create a NEW expense category also named "Groceries" (case variation to
     exercise case-insensitive dedup, e.g. "groceries").
  2. Submit; observe the error.
  3. Repeat via **rename**: rename another expense category to "Groceries".
- **Expected**:
  - The 409 is surfaced as a **field-level** message attached to the name field
    ("a category with this name already exists" in that kind), NOT a generic
    "something went wrong" banner and NOT raw JSON. Verify the response was a 409
    with `CATEGORY_NAME_CONFLICT` in network, and the UI mapped it to the field.
  - Same field-level treatment whether the conflict came from create or rename.
  - The client did not block submission with its own dedup guess before the server
    answered (C8) — the request actually reached the server.

### TC-21: Categories management — kind-flip into a group with a same-name sibling → same field-level 409
- **Verifies**: C2 senior amendment (409 reachable from a **kind-only** PATCH;
  dedup triggers on kind change too), C8.
- **Run**: `[auto]` `[auto-network]` `[data-heavy]`
- **Precondition**: An **expense** category "Bonus" AND an **income** category
  also named "Bonus" both exist (same name, different kinds — legal, since dedup
  is same-kind scoped).
- **Steps**:
  1. Edit the expense "Bonus" and flip its kind to **income** (a kind-only
     change, name untouched).
  2. Submit; observe.
- **Expected**:
  - Network: the PATCH sends only `kind` (touched field), and the server returns
    **409 CATEGORY_NAME_CONFLICT** because flipping into income collides with the
    existing income "Bonus".
  - The UI surfaces this as a **field-level** conflict message (name/kind area),
    NOT a generic failure — proving the error helper handles 409 on a kind-only
    PATCH (C2 amendment), not just on rename.

### TC-22: Error-shape journey — force a 422, expect field-level message not raw JSON
- **Verifies**: C2 / T6 / A3 (422 ValidationError[] arm mapped to field-level
  messages; do not trust generated 422 type as exhaustive; not raw JSON).
- **Run**: `[auto-network]` (needs a modified/oversize request)
- **Precondition**: Logged in. Two variants:
  (a) Category: submit an invalid **color** that bypasses any client input mask
      (e.g. via devtools-modified request body or an override) so the server's
      `^#[0-9A-Fa-f]{6}$` pattern 422s.
  (b) Transaction: submit a **note > 500 chars** by bypassing the client cap
      (devtools-modified request) so the server 422s the note length.
- **Steps**:
  1. Trigger variant (a): send a category create/patch with color `not-a-color`.
  2. Observe the UI.
  3. Trigger variant (b): send a transaction with an oversize note.
  4. Observe the UI.
- **Expected**:
  - Both produce a **field-level** validation message attached to the offending
    field (color field / note field), derived from the `ValidationError[]` arm —
    NOT a raw JSON dump, NOT an unhandled crash, NOT a generic banner only.
  - The runtime array shape is handled even though the generated POST/PATCH 422
    type claims `{detail: string}` (T6: don't trust the generated type; narrow
    `detail` as `string | ValidationError[]`). Confirm no console error escapes.
  - (A3 sibling: this same mapping path is what surfaces the reserved-TLD email
    422 on the auth field — not re-tested here, but the shared error-helper
    behavior is the same and is exercised by these two variants.)

### TC-23: Categories management — archive requires confirmation; archived disappears from NEW-tx picker; old txs still render; unarchive
- **Verifies**: C6 (archive = PATCH {archived:true} behind confirmation;
  unarchive = {archived:false}; no DELETE), C5 (archived list caches separately),
  T3 (archived hidden from new picker but historical rows still render).
- **Run**: `[auto]` `[data-heavy]`
- **Precondition**: A user category "Subscriptions" with at least one existing
  transaction assigned to it.
- **Steps**:
  1. On the categories screen, archive "Subscriptions" — confirm a confirmation
     dialog appears; cancel first, verify no change.
  2. Confirm the archive.
  3. Open the Add-transaction picker — confirm "Subscriptions" is absent.
  4. Open the month containing the old transaction — confirm the row still shows
     "Subscriptions" name/icon (T3, TC-7 overlap).
  5. Back on the categories screen, unarchive "Subscriptions".
  6. Open the Add-transaction picker again — confirm it reappears.
- **Expected**:
  - Archive is confirmation-gated (C6); cancel is a no-op. No DELETE request is
    ever issued — archive/unarchive are PATCH `{archived}` (verify in network).
  - After archive: the category is gone from the **new-transaction** picker but
    historical transactions still render its name/icon (join uses archived-
    inclusive set, T3).
  - Unarchive restores it to the picker. No console errors across the cycle.

### TC-24: Add-transaction picker excludes archived categories (new-tx path)
- **Verifies**: T3 / C5 (new picker uses the non-archived set; archived hidden
  from NEW selection while still joinable for display).
- **Run**: `[auto]` `[data-heavy]`
- **Precondition**: At least one archived and several active user categories.
- **Steps**:
  1. Open the Add-transaction modal and open the category picker.
  2. Scan the offered categories.
- **Expected**: Only non-archived categories (plus applicable system ones) are
  offered for a NEW transaction; the archived category does not appear. (This is
  the picker-source counterpart to TC-7/TC-23's display-side join.)

### TC-25: Cross-tab / refresh sanity — hard refresh shows identical data (server truth)
- **Verifies**: T9 (post-mutation state equals server truth; no optimistic lie),
  general refresh/deep-link resilience.
- **Run**: `[auto]`
- **Precondition**: Perform a create, an edit, and a delete (reuse TC-9/13/15
  actions) in one session.
- **Steps**:
  1. After each mutation, note the list rows and summary totals.
  2. Hard-refresh (F5) the `/transactions` screen.
  3. Re-read the list and summary.
- **Expected**: Post-refresh list and summary are **identical** to the
  post-mutation in-memory state — proving mutations wrote to the server and the
  UI reflected server truth (not an optimistic guess that a refresh would
  contradict). F5 on the transactions screen restores it correctly (no crash, no
  wrong redirect); the month selection either persists or defaults sanely.

### TC-26: Cyrillic category names sort per Intl.Collator within kind groups
- **Verifies**: C3 (locale-aware re-sort with Intl.Collator; server ORDER BY is
  determinism only; grouped by kind).
- **Run**: `[auto]` `[data-heavy]`
- **Precondition**: Seed several user categories with **Russian names** in one
  kind, chosen so DB byte-order (LC_COLLATE) and Russian collation differ — e.g.
  "Ёлка", "Еда", "Кафе", "Продукты", "Зарплата"(income). Include an "Ё"/"Е" pair,
  which typical DB collations mis-order versus `Intl.Collator('ru')`.
- **Steps**:
  1. Open the categories screen; read the order within the kind group.
  2. Compare against the expected `Intl.Collator('ru', {sensitivity:'base'})`
     order.
- **Expected**: Within each kind group, Cyrillic names appear in locale-correct
  Russian collation order (e.g. "Е"/"Ё" adjacency handled), NOT raw server byte
  order. This is observable only with names where the two orders diverge — hence
  the seed choice. No console error.

### TC-27: Refresh & deep-link on every screen of the flow
- **Verifies**: refresh/deep-link resilience; T9 (edit form on cold load
  refetches containing list or redirects — no GET /{id}); A1/A2 auth interplay
  on reload.
- **Run**: `[auto]`
- **Precondition**: Logged in.
- **Steps**:
  1. F5 on `/transactions` (list) — see TC-25.
  2. F5 on the categories management route directly (deep-link to it).
  3. Open the Add/Edit modal, then F5 — confirm the app restores to the list
     screen sanely (modal state is not URL-backed per senior ruling; a refresh
     landing on the bare list is acceptable, a crash is not).
  4. While logged OUT, deep-link directly to `/transactions` and the categories
     route.
- **Expected**:
  - Direct deep-link to the categories route loads it (protected, but reachable
    when authed).
  - F5 with a modal open does not crash; it restores the underlying screen (no
    per-tx URL exists, so the modal simply closes — acceptable).
  - Logged-out deep-links to protected routes redirect to `/login` with `?next=`
    preserved and NO app content flashing through (protected routes unreachable
    when logged out).

### TC-28: Responsive sanity — the full flow works at desktop AND ~375px
- **Verifies**: responsive baseline (task UX baseline); no obligation-specific,
  but a mandatory QA category.
- **Run**: `[manual]` (resize + visual judgment)
- **Precondition**: Seeded month with several transactions and the categories
  screen populated.
- **Steps**:
  1. At desktop width: walk the list → open Add modal → submit → open categories.
  2. Resize to ~375px (mobile preset) and repeat the same walk.
- **Expected**: At 375px nothing overflows off-screen, the summary header remains
  readable, the Add/Edit modal is fully usable (all fields and the submit button
  reachable, no clipped controls), day-group headers and rows wrap sanely, and
  the categories list stays usable. The whole happy path is completable at both
  widths.

### TC-29: Basic a11y — flow completable with keyboard only; inputs labeled; focus restored after modal close
- **Verifies**: a11y baseline (mandatory QA category); modal focus management.
- **Run**: `[manual]` (`[auto]` partial — Tab order and label presence are
  scriptable, focus feel is manual)
- **Precondition**: Logged in with a seeded month.
- **Steps**:
  1. Using only the keyboard (Tab/Shift-Tab/Enter/Esc): navigate the list, open
     the Add modal, fill and submit a transaction.
  2. Confirm each form input has an associated label.
  3. Close the modal (via submit and via Esc/cancel) and observe where focus
     lands.
  4. Repeat for the categories create/edit flow.
- **Expected**: The add-transaction and category-create journeys are completable
  with keyboard alone (no mouse-only controls, no keyboard trap inside the
  modal). Every input has a programmatic label. After the modal closes, focus
  returns to a sensible element (the trigger button or the list), not lost to
  `<body>`. No console a11y-related React warnings.

### TC-30: Console & network hygiene across every tested flow
- **Verifies**: cross-cutting hygiene (mandatory QA category); T9 (no request
  storms from over-invalidation / render loops).
- **Run**: `[auto]` (console + network inspection)
- **Precondition**: Run alongside TC-3 through TC-27.
- **Steps**:
  1. With the console and network tabs open, execute each happy-path flow (list
     load, month nav, add, edit, delete, categories CRUD, archive/unarchive).
  2. Watch console messages and the request list throughout.
- **Expected**:
  - Zero console errors and zero React key/act warnings on the happy paths
    (errors are only acceptable in the deliberate failure TCs 2/5/22).
  - No duplicate or looping API requests; each mutation triggers exactly its
    request plus the intended invalidation refetches (list + summary), not a
    storm. Month navigation does not re-fire prior months' requests. No render
    loop hammering `/transactions` or `/categories`.

### TC-31: Cross-month edit — dual summary invalidation (old month shrinks, new month grows, others untouched)
- **Verifies**: T9 (edit invalidates BOTH old-month AND new-month summaries;
  list-invalidation predicate must NOT blanket-refetch every cached month's
  summary), T10-adjacent (affectedMonth from occurred_at). Cites the plan's #1
  Risk ("Cross-month edit invalidation … easy to forget the old one") and the
  invalidation table's Edit-tx row.
- **Run**: `[auto-network]` `[data-heavy]`
- **Precondition**: Seeded known totals in **month A** and **month B** (see Seed
  Data Plan §7), plus a **month C** with its own transactions. All three months'
  summaries must be warm in cache before the edit (visit C first, then A, then B,
  so each `qk.txSummary` key is populated). One target transaction lives in month
  A with a known amount and known kind.
- **Steps**:
  1. Visit month C (so its summary is cached), then A, then B; note each month's
     header totals against the seeded truth.
  2. Navigate to month A and open Edit on the target transaction.
  3. Change ONLY its date (`occurred_at`) to a day inside month B; touch nothing
     else. Submit.
  4. With the network panel open, observe the refetches, then read A's and B's
     headers (navigate as needed).
- **Expected**:
  - (a) The row leaves month A's list and appears in month B's list (no manual
    reload).
  - (b) **Month A's summary totals SHRINK to server truth** — income/expense/net
    drop by the moved transaction's contribution. This is the load-bearing
    assertion: a forgotten old-month invalidation would leave A's header stale
    (showing the pre-move totals) until a manual refresh.
  - (c) Month B's summary totals GROW by the moved transaction's contribution.
  - (d) Network: summary refetches fire for **month A and month B ONLY**. **No
    `/transactions/summary?month=` request fires for month C** (already cached) —
    proving the list-invalidation predicate
    (`queryKey[0]==='transactions' && queryKey[1] !== 'summary'`) does not sweep
    every cached month's summary. The list predicate may refetch loaded list
    pages, but the summary refetches are scoped to exactly A and B.
  - No console errors; no request storm.

### TC-32: Register — reserved-TLD email → field-level error on the email field (A3 end-to-end)
- **Verifies**: A3 (email-TLD 422 the shared zod accepts but the server rejects,
  routed to the email field via `describeAuthError` → `getValidationIssues`),
  T6-adjacent (shared runtime narrow of `detail` as `string | ValidationError[]`).
  This is the ONLY end-to-end proof of the `describeAuthError` → `getValidationIssues`
  wiring (the 1.5 A3 carry-forward folded into 1.6's error-helper work).
- **Run**: `[auto]` `[auto-network]`
- **Precondition**: Logged **OUT** (no token). Must run before any authed setup,
  or after an explicit logout — coordinate ordering with TC-1 (which requires an
  authed session for the /login,/register bounce); these two exercise opposite
  auth states of /register.
- **Steps**:
  1. While logged out, open `/register` (should show the register form, not bounce
     — the authed bounce is TC-1's concern).
  2. Enter email `user@example.test` (the shared zod accepts this reserved TLD)
     and a valid password.
  3. Submit; inspect the response in the network panel.
  4. Observe the UI, then correct the email to a valid domain (e.g.
     `user@example.com`) and confirm the form is still usable.
- **Expected**:
  - Network: the request returns **422** with a `ValidationError[]`-shaped
    `detail` (array), whose failing entry's `loc` ends in `email`.
  - The UI attaches a **field-level message to the EMAIL field** — NOT a generic
    form-level banner, NOT a raw JSON dump, NOT a crash. This proves the auth
    error helper consulted `getValidationIssues` and routed by `loc` tail before
    its generic fallback.
  - After correcting the email to a valid domain, the form remains usable and
    submittable (no stuck error state, focus not lost). No console errors beyond
    the intended 422.

---

## Seed Data Plan

All seeding via the existing API using a dedicated **test user** (never real
data). A scripted create loop (Playwright request context, or a small
`curl`/`httpx` loop authenticated as the test user) covers the data-heavy TCs.
No API changes; seeding only exercises existing POST endpoints.

**Accounts**
- `qa-web-main@test.local` — the primary seeded user (all category + transaction
  sets below).
- `qa-web-empty@test.local` — a fresh user with ZERO categories-beyond-system and
  ZERO transactions, for the empty-fresh-account state (TC-5a).

**Categories** (POST /categories as qa-web-main)
- User expense categories: "Groceries", "Food", "Rent", "Subscriptions",
  "Bonus"(expense).
- User income categories: "Salary", "Bonus"(income) — the two "Bonus" rows
  (one per kind) power the kind-flip 409 (TC-21).
- A same-name-different-kind and a same-kind-duplicate target for TC-20/TC-21.
- **Cyrillic set** (one kind, names where DB order ≠ ru collation): "Ёлка",
  "Еда", "Кафе", "Продукты" (expense); "Зарплата" (income) — for TC-26.
- **Archived**: create "Subscriptions" and "Rent", assign transactions to them
  (below), THEN archive via PATCH `{archived:true}` — powers TC-7, TC-13, TC-23,
  TC-24 (archived-after-the-fact join + amount-only edit + picker exclusion).
- Leave all 18 system categories untouched (TC-18 read-only check).

**Transaction sets** (POST /transactions as qa-web-main)
1. **Current month, mixed & multi-day**: ~6 transactions across ≥2 days, mixed
   expense/income, some categorized some not — TC-3, TC-6, TC-9 baseline,
   TC-25.
2. **Previous month + year-rollover month**: a few transactions in the previous
   month and in December-of-prior-year (so prev navigation crosses the year
   boundary) — TC-4.
3. **Empty month**: deliberately leave one month with no transactions — TC-5b.
4. **Crafted negative-net + refund month**: in one month, seed transactions so
   total expense > total income (negative net) AND include a **refund pair** —
   the SAME category (e.g. "Groceries") with one expense tx and one income tx, so
   `by_category` returns that category_id twice (once per kind) — plus at least
   one **uncategorized** tx (no category_id) — TC-16, TC-17.
5. **>200-transaction month (SEEDING-HEAVY)**: script a loop creating **250**
   transactions all within a single target month (vary `occurred_at` day and
   amount; reuse a couple of categories). Runnable approach: authenticate the
   test user once, then a `for` loop of POST /transactions (Playwright
   `request.post` or `curl` with the bearer token) — ~250 calls, throttled to
   respect any rate limit — TC-8.
6. **Archived-category transaction**: at least one tx assigned to "Subscriptions"
   and one to "Rent" BEFORE those categories are archived — TC-7, TC-13, TC-23.
7. **Cross-month dual-invalidation set (months A / B / C)**: pick three DISTINCT
   months A, B, C (kept separate from the year-rollover set §2 to avoid overlap).
   Seed each with a handful of transactions of KNOWN amounts so each month's
   summary totals (income/expense/net) are hand-verifiable. Month A additionally
   holds ONE clearly-identified target transaction (known amount + kind) that
   TC-31 moves into month B by editing only its `occurred_at`. Month C exists
   only to be pre-cached and then observed to receive NO summary refetch — it is
   never edited — TC-31.

---

## Obligation coverage map

Each obligation and the TC(s) that verify it in the browser (or the reason it is
not browser-verifiable here):

- **C1** (PATCH-body null-vs-omit, categories) → observed via TC-20/TC-21/TC-23
  network bodies; core builder logic is vitest (frontend-engineer).
- **C2** (error helper, field-level 409 + 422) → TC-20, TC-21, TC-22.
- **C3** (Intl.Collator sort, grouped by kind) → TC-26 (Cyrillic), TC-18
  (grouping).
- **C4** (is_system gates edit/archive) → TC-18.
- **C5** (categories cache keys; archived caches separately) → TC-19, TC-23,
  TC-24.
- **C6** (archive = PATCH behind confirmation; no DELETE) → TC-23.
- **C7** (color casing not assumed canonical) → TC-19.
- **C8** (rely on server 409, no client hard dedup) → TC-20 (request reaches
  server).
- **T1** (limit=200, Load more, showing N of M) → TC-8.
- **T2** (from/to via toApiDate; filter query) → TC-4.
- **T3** (archived-inclusive join; Uncategorized; composite key) → TC-7, TC-17,
  TC-23, TC-24.
- **T4** (formatMoney signed; magnitude inputs; negative net) → TC-6, TC-12,
  TC-16.
- **T5** (no shared Kind alias; category.kind → tx kind) → TC-10 (observable
  behavior); alias discipline itself is a code/vitest concern.
- **T6** (error helper tx codes; 422 string|array narrow) → TC-22 (+ TC-13 for
  CATEGORY_ARCHIVED avoidance).
- **T7** (tx PATCH-body null-vs-omit) → TC-13, TC-14.
- **T8** (no currency in forms; render from data) → TC-6, TC-9, TC-19.
- **T9** (query keys; dual invalidation; no GET /{id}; deep-link) → TC-9, TC-12,
  TC-15, TC-25, TC-27, TC-30, TC-31 (cross-month dual-summary invalidation +
  no-blanket-summary-refetch predicate).
- **T10** (month string + bounds, rollover) → TC-4.
- **A1** (me-query error affordance) → TC-2.
- **A2** (bounce authed off /login, /register) → TC-1.
- **A3** (email-TLD 422 → field-level) → TC-32 drives the auth-field case
  end-to-end on /register (reserved-TLD email → email-field message via
  `describeAuthError` → `getValidationIssues`); TC-22 exercises the same shared
  error-helper narrow on the category/tx forms.
- **A4** (AM-7 body-preservation vitest tripwire) → NOT browser-verifiable; it is
  a vitest invariant in the coordinator suite (must stay green, G2) — flagged
  here so it is not forgotten, but owned by frontend-engineer's test gate.

---

## Summary (RUN COMPLETE — 2026-07-24)

- Total TCs: 32
- Passed: 29 (TC-1, TC-3, TC-4, TC-6, TC-7, TC-8, TC-9, TC-10, TC-11, TC-12,
  TC-13, TC-14, TC-15, TC-16, TC-17, TC-18, TC-19, TC-20, TC-21, TC-23, TC-24,
  TC-25, TC-26, TC-27, TC-28, TC-29, TC-30, TC-31, TC-32)
- Failed: 0
- Blocked: 2 fully (TC-2, TC-22) + 1 partial (TC-5: empty-state substates PASS,
  loading/error substates BLOCKED)

**Status: ✅ READY FOR REVIEW** — zero functional failures. All blocked items are
blocked by a TOOLING limitation (the MCP browser pane exposes no request
interception / blocking / override — no Playwright `route`, no devtools override),
NOT by any product defect. The code paths behind the blocked negative-path TCs
were read and are present/correct; they simply could not be browser-exercised.

### Environment / deviations from the groomed plan
- **Test-user email domain**: the checklist named `qa-web-main@test.local` /
  `qa-web-empty@test.local`, but the server rejects the `.local` reserved TLD
  (this is literally the A3 behaviour). Used `qa-web-main@budgetqa.dev` /
  `qa-web-empty@budgetqa.dev` instead. (Registration of `@example.com` and
  `@qa-budget.io` mains also succeeded during domain-probing and were left as
  harmless strays.)
- **Currency is RUB** (2-decimal), system categories are the 18 Russian seeds,
  and the app's locale renders Russian month labels ("июль 2026 г.") and
  ₽/space-thousands/comma-decimal money. All money/date assertions evaluated
  against RUB formatting.
- **Browser-pane constraints observed**: (a) the pane clamps CSS viewport width
  at ~451px (cannot render a true 375px CSS width; screenshots are 375-scaled of
  a 451 render); (b) `read_network_requests` returns RESPONSE bodies only, not
  request bodies — so raw PATCH/POST request-body key inspection (TC-13/14/21
  omit-vs-null at the wire) was proven behaviourally (server outcome + refresh
  persistence) rather than by reading the literal request JSON; (c) `scroll`
  times out on very tall lists (used `scroll_to` by ref instead); (d)
  intermittent black/0x0 screenshots after navigation (worked around with
  screenshot-to-force-render then re-read).

### DB / seed state left in place (for reruns)
Left seeded and NOT torn down. `qa-web-main@budgetqa.dev` holds the full seed set
(pw `Qa!Test1234`) with these run-mutations applied:
- July 2026 (current): +1 created uncategorized tx 12.50 (TC-9), still present.
- Feb 2026: the Subscriptions tx amount changed 15.00 → 25.00 (TC-13). Categories
  "Subscriptions" and "Rent" remain ARCHIVED (Subscriptions was unarchived then
  re-archived during TC-23; net state = archived, as originally seeded).
- Category "QA Travel" created then renamed to "QA Trips" (TC-19), still present.
- The A/B/C set: the TARGET-MOVE tx was moved from 2026-09 (A) into 2026-10 (B)
  (TC-31) and left there — so A now = income 0 / exp 10, B = income 40 / exp 25,
  C (2026-11) unchanged = exp 15. A rerun of TC-31 must account for this (or move
  it back to 2026-09-15).
- Aug 2026 tx (created for TC-14/TC-11) was deleted in TC-15 — Aug is empty again.
- `qa-web-empty@budgetqa.dev` (pw `Qa!Test1234`): zero user categories, zero
  transactions (18 system cats only). Untouched.

---

## Per-TC results

- **TC-1 PASS** — Authed visits to `/login` and `/register` both bounce to
  `/transactions`; `/login?next=/categories` honored → landed on `/categories`
  (no loop). (?next URL string not directly readable via pane; proven
  functionally by the next-honoring bounce.)
- **TC-2 BLOCKED (tooling)** — Forcing a terminal (non-401) `/users/me` failure
  needs request interception the MCP pane doesn't provide. Code path verified by
  reading `ProtectedLayout.tsx`: `me.isError` renders an inline `role="alert"`
  "Couldn't load your account." + a Retry button (`me.refetch()`) — the A1
  affordance exists and is correct — but was not browser-exercised.
- **TC-3 PASS** — Defaults to current month (июль 2026); day groups DESC (20,18,15);
  per-row amount via shared money helper with row currency (₽), expense=red+minus,
  income=green no-sign; list req `from=2026-07-01&to=2026-07-31&limit=200`; no
  console errors.
- **TC-4 PASS** — Prev→June (`from/to 06-01/06-30`, summary `2026-06`); Jan 2026
  →prev→ Dec 2025 rollover (`from/to 2025-12-01/31`, summary `2025-12`, Dec=31 no
  off-by-one/NaN); Next→Jan 2026 (`2026-01-01/31`). Header + summary in lockstep.
- **TC-5 PARTIAL** — Empty fresh account (qa-web-empty): PASS ("No transactions in
  июль 2026 г.. Add your first one." + "No spend yet this month." + Add button,
  0,00 ₽ via formatMoney). Empty month (Aug after delete / 2026-05): PASS.
  Loading + Error substates: BLOCKED (no request throttle/500 tooling in the pane).
- **TC-6 PASS** — Expense renders locale minus + red (e.g. `-50,00 ₽`), income
  green no-sign (`3 000,00 ₽`); currency ₽ from row data; no float leakage.
  MANUAL-RESIDUAL: exact color-contrast is human judgment, but red vs green is
  clearly distinct.
- **TC-7 PASS** — Feb 2026 rows + breakdown for archived "Rent"/"Subscriptions"
  still render their name and 🛒 icon (breakdown shows them muted); archived-
  inclusive join (T3) holds. No failed-lookup console error.
- **TC-8 PASS** — Heavy month 2026-03: first fetch `limit=200&offset=0`; "Showing
  200 of 250" + "Load more" (present only because 250>200); one click → exactly
  one `offset=200` request → "Showing 250 of 250", control unmounts; no dup rows,
  no storm; light months showed no control.
- **TC-9 PASS** — No currency field (only RUB display chip, T8); entered 12.50
  major, left uncategorized → POST 201; new "Uncategorized -12,50 ₽" row appears
  under today (24 июл) without reload; amount round-trips; summary → server truth
  (EXPENSE 92,49→104,99, NET→3 395,01) via dual list+summary invalidation; no storm.
- **TC-10 PASS (with deviation)** — Picking income "Salary" flipped kind to Income
  (T5 direct assignment); flipping kind back to Expense cleared the incompatible
  category to Uncategorized (Q4). DEVIATION from the TC wording: the picker is NOT
  kind-FILTERED — it always shows both kinds SEGMENTED into `<optgroup>` Expense /
  Income (C3 grouping). This is a valid design satisfying every cited obligation
  (T5/Q4/C3 — no obligation requires hiding the other kind); it differs only from
  the checklist's "only expense offered" phrasing.
- **TC-11 PASS** — Date defaults to today (24.07.2026); a future date 2026-08-15
  was accepted and submitted (POST 201). Note cap = native `maxLength={500}` hard
  input cap (verified in DOM/code). MANUAL-RESIDUAL: 500/501 paste boundary not
  exercised (native maxLength cannot be exceeded by typing).
- **TC-12 PASS** — Edit prefill (archived-Subscriptions tx): amount shows magnitude
  "15.00" with NO minus (sign carried by the Expense radio); kind/category/date/note
  prefilled from cache; NO `/transactions/{id}` GET fired (row sourced from list
  cache, T9).
- **TC-13 PASS** — Amount-only edit on an archived-category tx: PATCH 200 (first
  401 → coordinator auto-refreshed → retry 200), NO CATEGORY_ARCHIVED 422 — which
  proves `category_id` was omitted from the body (had it been re-sent, the server
  422s). Row → -25,00, summary 815→825. (Raw request body not readable via pane;
  the 200-on-archived outcome is dispositive for the omit.)
- **TC-14 PASS** — Cleared note + category on a categorized+noted tx → PATCH 200,
  row → "• Uncategorized -30,00 ₽" (note gone). Hard refresh: still uncategorized,
  no note → the clear PERSISTED to server truth (proves `category_id:null` /
  `note:null` were sent, not `""` or a no-op; amount/date/kind stayed correct).
  RESIDUAL: literal null-vs-absent key inspection not available via pane, proven
  behaviourally.
- **TC-15 PASS** — Delete gated behind ConfirmDialog; Cancel = no-op (no request,
  row+totals intact); Confirm → DELETE 204 (the `ERR_ABORTED` is the standard
  no-body-204 artifact), row removed without reload, summary → 0/0/0 via dual
  invalidation, one DELETE + scoped refetches.
- **TC-16 PASS** — Crafted 2026-04: NET renders `-130,00 ₽` (locale minus) for
  income 50 − expense 180; no NaN/crash; currency from summary (₽).
- **TC-17 PASS** — 2026-04 breakdown: "Groceries" appears TWICE (120,00 expense +
  20,00 income refund pair) as two distinct rows; null bucket labeled
  "Uncategorized"; console shows NO "two children with the same key" warning
  (composite `${id}:${kind}` key holds) — the load-bearing console assertion.
- **TC-18 PASS** — Merged list grouped EXPENSE/INCOME; system categories render as
  non-interactive `<div>` with a SYSTEM badge and NO edit/archive control (gated on
  `is_system`); user categories render as `<button>` opening the edit modal.
- **TC-19 PASS** — Created with icon 🧳 + lowercase `#abc123` → POST 201, response
  stored color lowercase as-entered (C7, no forced canonical casing); appears
  immediately at correct kind-group + sort position (no reload); rename ("QA Travel"
  →"QA Trips") reflects immediately; no currency field (T8).
- **TC-20 PASS** — Create dup "groceries" → 409 CATEGORY_NAME_CONFLICT surfaced as
  a field-level alert on the Name field (case-insensitive match; request reached
  the server, no client dedup pre-gate, C8); rename "Food"→"Groceries" → same 409
  field-level treatment.
- **TC-21 PASS** — Kind-only flip of expense "Bonus"→income (name untouched) → 409
  CATEGORY_NAME_CONFLICT (collides with income "Bonus") surfaced field-level on
  Name (C2 kind-only-PATCH amendment). RESIDUAL: literal "only `kind` in body" not
  readable via pane; verified by toggling only the kind radio and getting the 409.
- **TC-22 BLOCKED (tooling)** — The client zod hard-validates color (invalid
  "notacolor" → field-level "Enter a 6-digit hex color like #3366FF.", NO request
  sent) and the note uses native maxLength — so the SERVER-422 path requires a
  request-override the pane doesn't offer. The shared error-helper
  ValidationError[]→field mapping IS proven end-to-end elsewhere: TC-32 (email 422
  array-arm → email field) and TC-20/21 (409 → name field).
- **TC-23 PASS** — Archive AND unarchive both go through ConfirmDialog (Cancel =
  no-op, no request); both are PATCH `{archived:true|false}` (response bodies
  confirm), NEVER a DELETE (C6); archived hidden from new-tx picker (TC-24) while
  historical rows still render (TC-7); unarchive restores it.
- **TC-24 PASS** — The new-transaction category picker excludes archived
  Subscriptions/Rent (only non-archived + system offered); an EDIT whose saved
  category is archived shows it as the current value "Subscriptions (archived)"
  but not as a selectable option.
- **TC-25 PASS** — Create/edit/delete all persisted identically across hard
  refreshes (server truth, no optimistic lie); F5 on `/transactions` restores
  correctly.
- **TC-26 PASS** — Raw API returns expense order `[…Ёлка, Еда…]` (codepoint, Ё
  first) but the UI renders `Еда, Ёлка …` with Latin moved after Cyrillic — the
  client re-sorts locale-aware (Intl.Collator), Ё/Е adjacency handled, diverging
  from server byte order.
- **TC-27 PASS** — Deep-link `/categories` (authed) loads; deep-link `?month=`
  loads the right month; F5 with a modal open restores the bare list (modal
  closes, no crash, no console errors); logged-out deep-links to `/transactions`
  and `/categories` redirect to Sign in with no protected content flashing.
- **TC-28 PASS (at pane min-width) / MANUAL-RESIDUAL** — At the pane's narrowest
  CSS width (~451px; the pane clamps below that) the header wraps, the summary
  card stacks (INCOME/EXPENSE row then NET), rows and day-headers wrap, and the
  flow stays usable. Minor: the header email truncates/clips at the right edge.
  MANUAL-RESIDUAL: true 375px CSS could not be rendered (pane clamp); a human
  should confirm the Add/Edit modal fit and the header-email clip at exactly 375px.
- **TC-29 PASS / MANUAL-RESIDUAL** — Modal is `role="dialog"`; on open focus moves
  INTO the dialog (Close button, visible focus ring — trapped, not left on body);
  Tab order Close→Amount→… is logical and keyboard input works (typed into Amount
  via keyboard); every input has an associated label; Esc closes; no a11y console
  warnings; no mouse-only controls. MANUAL-RESIDUAL: focus-restoration to the
  trigger after close not machine-verifiable (cannot read document.activeElement
  via pane) — Modal component is coded to restore per plan.
- **TC-30 PASS** — Across every happy-path flow (list load, month nav, add, edit,
  delete, categories CRUD, archive/unarchive, pagination) console error checks
  returned clean; each mutation fired exactly its request + the scoped invalidation
  refetches (list + affected-month summary), no duplicate/looping requests, no
  render storms. (Console errors appeared only where intended: none of the
  executed TCs were deliberate-failure ones beyond the field-validation 409/422
  responses, which are expected.)
- **TC-31 PASS** — Warmed C(2026-11)/A(2026-09)/B(2026-10) in one app instance;
  moved the target (income 40) A→B by editing only occurred_at. Result: row left A
  and appeared in B; A summary SHRANK to server truth (40/10/30 → 0/10/-10, old-
  month invalidation NOT forgotten — load-bearing); B GREW (0/25/-25 → 40/25/15);
  C unchanged (0/15/-15). Network in the post-edit window showed exactly ONE
  summary refetch — `month=2026-09` (A, the active month) — and NO `month=2026-11`
  (C) and NO `month=2026-10` request: the invalidation is scoped, the list
  predicate does not sweep every cached month's summary. No storm, no console
  errors.
- **TC-32 PASS** — `user@example.test` (reserved TLD the shared zod accepts) →
  register returns 422 with a `ValidationError[]` `detail` whose entry `loc` ends
  in `email`; UI attaches a field-level "Enter a valid email address." to the
  EMAIL field (not a banner, not raw JSON, no crash); form stayed usable after
  correction; no console errors. End-to-end proof of `describeAuthError` →
  `getValidationIssues` → loc-tail routing.
