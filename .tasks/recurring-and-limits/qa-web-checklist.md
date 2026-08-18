# QA Web Checklist: scope `recurring-and-limits` — W2/W3/W4/W5 (scope-closing live pass)

Executed 2026-08-18 against the uncommitted working tree. W1 is NOT retested here
(see `qa-web-w1.md`).

## Environment

| item | value |
|---|---|
| API | the already-running uvicorn on **127.0.0.1:8010** (not started, not restarted, not killed by this run) |
| DB | the shared Postgres :5443 / db `budget` — read-only inspection only, and only rows of the qa user |
| Web | `pnpm dev` on :5173 via the `web` launch config, `apps/web/.env` untouched (`VITE_API_URL=http://localhost:8010`) |
| User | fresh throwaway `qa-rl-20260818@budgetqa.dev`, registered through the UI, ONE session for the whole run |
| Locale | ru-RU — money `-32 000,00 ₽`, dates `24 авг. 2026 г.`, months `август 2026 г.` |
| Today | 2026-08-18 (Tuesday) |

Deviations / notes, recorded:
- The email domain `budgetqa.dev` **was accepted** by the server validator (no
  fallback to `example.com` needed).
- Not covered live, by instruction: **currency-mismatch** limit state (needs a
  base-currency switch; pinned by `limitProgress.test.ts`) and the
  **`unconverted_count`** notice (needs a rateless FX row).
- Two out-of-band fixture attempts (a DB `INSERT` of a template-owned transaction;
  a `curl PUT /limits/…` to bypass the browser) were **denied by the sandbox
  classifier** and were not retried or worked around. This is why TC-7 and the
  TC-10/11/12/14 family are blocked rather than executed.

---

## Test cases

### TC-1 (W2): `/recurring` empty state
- **Steps**: log in → open `/recurring`.
- **Expected**: empty copy + primary "New template", no skeleton left behind.
- **Observed**: "No recurring templates yet." + "Add rent, a salary or a
  subscription and it will be created automatically on schedule — you'll see it in
  your transactions with a Recurring label." + a "New template" button (header and
  empty-state both).
- **Status**: ✅ PASS

### TC-2 (W2/R6): clean form closes silently on Esc
- **Steps**: "New template" → touch nothing → Esc.
- **Observed**: modal gone, no confirm prompt, page back to the empty state.
- **Status**: ✅ PASS

### TC-3 (W2/R6): dirty form asks before discarding, and "Keep editing" keeps input
- **Steps**: "New template" → type `Аренда` into Name → Esc.
- **Observed**: `Discard your changes? What you typed here will be lost.` +
  `Keep editing` / `Discard changes`; the form's own controls leave the a11y tree
  while the confirm is up. "Keep editing" → form returns; the typed name survived
  (proved later: the created template is named `Аренда`).
  Second cycle in the **edit** modal → same prompt; `Discard changes` closed it and
  the row was unchanged.
- **Status**: ✅ PASS

### TC-4 (W2): create a monthly template on day 31 — clamp copy + next-due
- **Steps**: New template → name `Аренда`, amount `30000` RUB, category `Жильё`,
  Repeats **Monthly**, Day of the month **31** → Save.
- **Expected**: clamp copy surfaced when the day can't exist in every month; the row
  lists with a server-rendered next-due date.
- **Observed**: on picking 31 the hint appeared: *"Months shorter than this use
  their last day (31 → Feb 28)."* After Save the row read
  `🏠 Аренда · Жильё · Monthly on day 31 · -30 000,00 ₽ · Next on 31 авг. 2026 г.`
  with Edit / Pause / Delete. `POST /recurring → 201`, list refetched, no reload.
- **Status**: ✅ PASS

### TC-5 (W2/WR-9/R1): edit — amount + anchor swap month→week
- **Steps**: Edit → amount `32000`, Repeats **Weekly** → Save.
- **Expected**: the day-of-month control is replaced by a weekday control; the PATCH
  is accepted (a stale `day_of_month` would be rejected as ANCHOR_MISMATCH); the row
  re-renders verbatim from the server.
- **Observed**: the "Day of the month" select disappeared and "Weekday" appeared
  with ru labels in ISO order (`понедельник` first … `воскресенье` last — R1 holds,
  no `getDay()` off-by-one). `PATCH /recurring/{id} → 200`; row became
  `Жильё · Weekly on понедельник · -32 000,00 ₽ · Next on 24 авг. 2026 г.`
  (24 Aug 2026 is indeed the next Monday — but the date is the server's, rendered
  verbatim, R2).
- **Status**: ✅ PASS

### TC-6 (W2): pause / resume arms
- **Observed**: Pause → row gains `PAUSED` + *"Nothing is created while paused, and
  skipped dates are not backfilled when you resume."*, "Next on …" replaced, action
  flips to Resume. Resume → back to the active arm. No confirmation dialog (by
  design — reversible).
- **Status**: ✅ PASS

### TC-7 (W3): "Recurring" badge on a transaction row
- **Expected**: a row created by a template renders a `Recurring · {name}` chip.
- **How I tried to reach it**:
  1. No materialized row exists — the scheduler on 8010 runs **daily at 00:30 UTC**
     (`config.py: recurring_materialize_hour_utc=0 / minute=30`) and the template's
     `next_due_on` is 24 Aug; restarting the API to force it was forbidden.
  2. There is **no materialize endpoint** (`routers/recurring.py` exposes only
     POST/GET/PATCH/DELETE) and `recurring_template_id` is server-set, absent from
     the transaction create body — so the chip cannot be produced through the UI.
  3. A DB fixture row (`INSERT INTO transactions … recurring_template_id=…` for the
     qa user only) was **denied by the sandbox classifier**; not worked around.
- **What IS verified**: the contrast arm — a manually created transaction row shows
  **no** chip (`🏠 Жильё · -6 000,00 ₽ · 18 авг. 2026 г.`, nothing else), so the chip
  is not rendered unconditionally. The chip itself
  (`TransactionRow.tsx:66`) and its degradation stay pinned by
  `recurringBadge.test.ts`.
- **Status**: ⏸ BLOCKED (not faked, not marked pass)

### TC-8 (W4/C4): the limit slot appears only where it should
- **Steps**: open `/categories`.
- **Observed**: section header `Budgets for август 2026 г.` + empty copy *"No budgets
  yet — set one on any expense category to track how much of it you've used this
  month."*; **all 13 expense** rows carry a "Set a budget" button, **all 5 income**
  rows carry none. Buttons are individually named — `Set a budget for Кафе и
  рестораны` — good screen-reader story.
- **Status**: ✅ PASS

### TC-9 (W4): budget form validation
- **Steps**: "Set a budget for Жильё" → Save with the field blank; then `0` → Save.
- **Observed**: modal titled `Set a budget — Жильё`, one "Monthly budget" field, the
  currency as **read-only text `RUB`** + *"Budgets are set in your base currency."*
  (no picker — matches D15). Blank → `alert "Enter an amount."`; `0` →
  `alert "Enter an amount greater than zero."` — two **distinct** messages, both
  inside the field's form group, no request fired.
- **Status**: ✅ PASS

### TC-10 (W4): set a budget → bar with "X of Y" / "Z left"
- **Steps**: same modal → amount `5000` → Save budget.
- **Expected**: `PUT /limits/{category_id} → 200`, bar renders `0,00 ₽ of 5 000,00 ₽`
  + `5 000,00 ₽ left`.
- **Observed**: ❌ the save **fails for every user, every category, every amount**.
  The browser's CORS preflight for the PUT is rejected:
  ```
  OPTIONS http://localhost:8010/limits/c861af3a-…  → 400 Bad Request
  body: "Disallowed CORS method"
  access-control-allow-methods: GET, POST, PATCH, DELETE, OPTIONS   ← no PUT
  PUT   http://localhost:8010/limits/c861af3a-…    → net::ERR_FAILED
  ```
  Console: *"Access to fetch at 'http://localhost:8010/limits/…' … blocked by CORS
  policy: Response to preflight request doesn't pass access control check."*
  Same-origin contrast on the **same path**: `Access-Control-Request-Method: PATCH`
  → **200**, `PUT` → **400**. Root cause is one line:
  `apps/api/src/budget_api/app.py:194` —
  `allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"]`.
  `PUT /limits/{category_id}` (`apps/web/src/data/limits.ts:60`) is the **only PUT in
  the whole web app**, so nothing else ever exercised the gap.
  In the UI the failure surfaces as the modal-level *"Can't reach the server. Check
  your connection and try again."* — an honest state for a network-layer failure, but
  it points the user at their connection for what is a server config bug.
- **Status**: ❌ FAIL — **FUNCTIONAL / BLOCKER**. W4's entire write path is dead in
  the browser.

### TC-11 (W4): over-limit state (colour + "Over by …")
- **Precondition**: a budget must exist. Unreachable — TC-10.
- **Status**: ⏸ BLOCKED by TC-10 (fixture creation out-of-band was denied).

### TC-12 (W4): edit a budget / Remove via confirm dialog
- **Status**: ⏸ BLOCKED by TC-10 (nothing to edit or remove). Note that
  `DELETE` *is* in the CORS allow-list, so Remove is expected to work once the PUT
  is fixed — but it was not observed.

### TC-13 (W4/C4 inverted): archived category
- **Steps**: create a custom expense category `QA Archived` → open its row → Archive
  → confirm.
- **Observed**: before archiving the row carried `Set a budget for QA Archived`;
  after archiving the row renders `QA Archived · ARCHIVED` and the "Set a budget"
  affordance is **gone** — the C4 gate mirrors the server's 422. The list updated in
  place, no reload.
- **Status**: ✅ PASS (the *archived-with-a-budget* read-only/Remove-only arm is
  ⏸ BLOCKED by TC-10)

### TC-14 (WR-2 / T9): a tx mutation refreshes `/categories` spent without a reload
- **Steps**: `/transactions` → Add transaction 6000 RUB / `Жильё` / today → Save.
- **Observed**: `POST /transactions → 201`; the row and the month summary updated
  with no reload (`EXPENSE 6 000,00 ₽`, `NET -6 000,00 ₽`, `18 авг. 2026 г.`) — the
  shipped invalidation is healthy. But the *limits* half of the assertion — the bar's
  `spent` moving without a reload — needs a budget to exist.
- **Status**: ⏸ BLOCKED by TC-10 for the `['limits']` half; the transactions half
  ✅ passes.

### TC-15 (W5/WR-6): `/stats` budgets section — month unit
- **Steps**: `/stats`, period = Month, август 2026.
- **Observed**: a `Budgets` section under the period card with a `Manage budgets`
  link to `/categories` and the empty copy *"No budgets set for август 2026 г.. Set
  one on a category to track how much of it you've used."* with `Set one on a
  category` linking to `/categories`. `GET /limits?month=2026-08 → 200`.
  **Read-only confirmed**: the section contains **no** Set / Edit / Remove control —
  only the two links out to `/categories` (one write surface, W4's).
  *(The populated arm — real bars on /stats — is ⏸ BLOCKED by TC-10.)*
- **Defect found**: the empty copy renders **`август 2026 г..`** — a double
  terminator. The ru `Intl` month label already ends in `.`, and this call site
  appends its own `.` instead of going through the shared `sentenceEnd` helper that
  W1 shipped for exactly this. Contrast in the same screenshot-free page dump: the
  neighbouring stats empty state reads `No transactions in август 2026 г.` — one dot.
  Reproduced on a second month (`декабрь 2025 г..`), so it is not a one-off.
- **Status**: ❌ FAIL — **COSMETIC** (the P3 defect class, un-fixed at the new W5
  call site)

### TC-16 (W5/WR-6): the section follows the picked month
- **Steps**: Month → Previous month (twice, via Year→Month).
- **Observed**: the section re-queried per month —
  `GET /limits?month=2026-01`, `GET /limits?month=2025-12` — and the copy tracked the
  picker (`No budgets set for декабрь 2025 г...`). Past months are queried, as
  designed.
- **Status**: ✅ PASS (copy carries the TC-15 dot defect)

### TC-17 (W5/Disagreement 1): non-month periods
- **Steps**: Quarter (Q3 2026), then Year (2026).
- **Observed**: both render exactly one line —
  *"Budgets are monthly — pick a month period to see them."* — plus the
  `Manage budgets` link. Crucially the network log shows **no `/limits` request at
  all** while the unit is quarter or year: the gate short-circuits the query, it does
  not merely hide a rendered result.
- **Status**: ✅ PASS

### TC-18: responsive sanity at 375 px
- **Observed** (`/recurring`, 375×812): header/nav, the template card (name, category
  + periodicity, amount, next-due) and all three row actions wrap cleanly inside the
  viewport; nothing overflows or becomes unreachable.
- **Cosmetic note (`/categories`, desktop)**: the "Set a budget" affordance renders
  as a bare centred link **below and outside** the category's white card rather than
  inside the row, which reads as a detached orphan between two rows. Classified
  **COSMETIC**.
- **Status**: ✅ PASS (with the cosmetic note)

### TC-19: refresh / deep-link
- **Observed**: direct navigation (fresh document load) to `/recurring`,
  `/categories`, `/transactions`, `/stats` restored the session and the screen every
  time — used as the vehicle for most TCs above. A `401 → refresh → retry` pair fired
  once mid-run and the screen recovered silently.
- **Status**: ✅ PASS

### TC-20: console & network hygiene
- **Console**: no React warnings, no render-loop noise, no app-thrown errors. The
  only entries are (a) `ERR_CONNECTION_REFUSED` from the seed tab before the dev
  server was up, (b) pre-login `401`s from a stale token + one mid-run `401` that the
  refresh path absorbed, and (c) **the CORS error of TC-10**.
- **Network**: one request per query per screen; no duplicate storms, no repeated
  polling. `GET /recurring`, `GET /categories?include_archived=true`,
  `GET /limits?month=…` each fired once per invalidation.
- **a11y spot-checks**: every input is labelled; the periodicity control is a
  `fieldset/legend` radio group; row actions and the limit affordances are real
  `<button>`s with per-row accessible names; the discard confirm removes the form's
  controls from the tree while it is up.
- **Not a defect (tool limitation)**: pressing Enter inside a focused text field did
  not submit either form modal in this harness. Grepped — neither `Modal.tsx` nor
  `TemplateFormModal.tsx` handles/prevents Enter, so this is the browser-automation
  key synthesis, not the app. Recorded so it is not mistaken for a finding.
- **Status**: ✅ PASS (the CORS error is counted under TC-10, not double-reported)

---

## Summary

| | |
|---|---|
| Total | 20 |
| Passed | 13 — TC-1..6, TC-8, TC-9, TC-13, TC-16, TC-17, TC-18, TC-19, TC-20 (TC-14 partially) |
| Failed | 2 — **TC-10 (FUNCTIONAL/BLOCKER)**, **TC-15 (COSMETIC)** |
| Blocked | 5 — TC-7 (no materialized recurring row reachable; fixtures denied), TC-11, TC-12, TC-14's `['limits']` half, TC-13's archived-with-budget arm — all four downstream of TC-10 |

### Findings

1. **FUNCTIONAL / BLOCKER — category budgets cannot be created or edited from the
   web app.** `PUT /limits/{category_id}` is the only PUT the SPA issues, and the
   API's CORS `allow_methods` (`apps/api/src/budget_api/app.py:194`) omits `PUT`, so
   the preflight returns `400 "Disallowed CORS method"` and the request never leaves
   the browser. Evidence: preflight contrast on the same path (PATCH → 200,
   PUT → 400) plus the console CORS message. This kills W4's write path and, with it,
   every populated-state assertion in W4 and W5. Secondary: the UI attributes the
   failure to the user's connection ("Can't reach the server…").
2. **COSMETIC — double sentence terminator in the W5 budgets empty state.**
   `No budgets set for август 2026 г..` — the new call site appends `.` to an `Intl`
   month label that already ends in one, i.e. the P3 defect W1 fixed elsewhere, at a
   site that did not adopt `sentenceEnd`. Reproduced on two different months.
3. **COSMETIC — the `/categories` "Set a budget" affordance sits outside the row
   card**, centred beneath it, reading as an orphaned link between rows.

**❌ FAIL OVERALL — senior-lead must handle.** Finding 1 is a release blocker: the
feature is unusable from the browser even though the API, the data layer and the
render code are all in place. Findings 2 and 3 are cosmetic and can ride along.
Re-run of TC-7 and TC-10..14 is required once finding 1 is fixed (and, for TC-7,
once a materialized recurring transaction can be produced).

---

## Retest after the CORS fix (2026-08-18, ~23:35–00:05)

Re-run of the previously ❌/⏸ cases only. Passed TCs above are NOT re-executed and
their text is unchanged. `curl-first`: every data-shaped assertion and every
fixture went through curl; the browser was used only for CORS, rendering and
cache invalidation.

### Retest environment (deliberate deviations from the run above)

| item | value |
|---|---|
| API | **127.0.0.1:8012** — FIXED code (`allow_methods` now contains `PUT`). The unfixed 8010 instance was left running and untouched. |
| DB | same Postgres as 8010 (the qa user's rows are the same rows) |
| Web | `pnpm --filter @budget/web dev` on :5173 with a gitignored `apps/web/.env.local` = `VITE_API_URL=http://localhost:8012`; **deleted after the run**, `apps/web/.env` never edited |
| User | the SAME `qa-rl-20260818@budgetqa.dev` as above, one login, one token reused for all curl |
| Throwaway | a second uvicorn on :8013 started only to trigger the unconditional boot catch-up job, then killed |

### TC-10 (W4): set a budget → ✅ PASS (was ❌ FUNCTIONAL/BLOCKER)

- **curl**: `PUT /limits/{Жильё} {"amount_minor":500000}` → **200**
  `{"category_id":…,"limit_minor":500000,"limit_currency":"RUB"}`;
  `GET /limits?month=2026-08` lists it with `spent_minor` computed.
- **browser (THE CORS proof)** — "Set a budget for Здоровье" → 1200 → Save budget,
  network panel:
  ```
  OPTIONS http://localhost:8012/limits/6c53a9ed-…  → 200 OK
  PUT     http://localhost:8012/limits/6c53a9ed-…  → 200 OK
  GET     http://localhost:8012/limits?month=2026-08 → 200 OK   ← post-write refetch
  ```
  The modal closed and the row grew a bar `0,00 ₽ of 1 200,00 ₽` / `1 200,00 ₽ left`
  with no reload. The finding-1 blocker is **resolved**.

### TC-11 (W4): over-limit state → ✅ PASS

Fixtures by curl (limit 5 000 ₽ on Жильё against 6 000 ₽ already spent; limit
2 000 ₽ on Кафе against 500 ₽). `/categories` renders both arms and they are
visually distinct: over = full-width **red** bar + `Over by 1 000,00 ₽` in red;
under = partially filled **blue** bar + grey `1 500,00 ₽ left`. Money formatting is
ru-RU throughout (`6 000,00 ₽`), no float dust.

### TC-12 (W4): edit / remove a budget → ✅ PASS

- **curl** (on Транспорт): `PUT` 1 000 ₽ → 200, second `PUT` 3 500 ₽ → 200, and
  `GET /limits` then shows **exactly one** row for that category at the new amount
  (upsert replaces, does not accumulate). `DELETE` → **204**; `DELETE` again →
  **404 `LIMIT_NOT_FOUND`**.
- **browser** (Remove confirm dialog, once): "Remove the budget for Жильё" opens
  `Remove budget` — *"Remove the budget for "Жильё"? Your transactions are not
  affected."* with `Cancel` / `Remove`. Confirm → `OPTIONS 200` + `DELETE 204` +
  refetch; the row falls back to `Set a budget` in place, no reload.

### TC-14 (WR-2/T9): the `['limits']` half of cache invalidation → ✅ PASS

With a bar on Кафе showing `500,00 ₽ of 2 000,00 ₽`, a 300 ₽ Кафе transaction was
created through the app's own form (`POST /transactions → 201`). No `/limits` call
fires while the mutation's screen is open (the query is not mounted there — correct
React Query behaviour), and on returning to `/categories` by in-app navigation (same
document, no F5) the bar reads `800,00 ₽ of 2 000,00 ₽` / `1 200,00 ₽ left`.
`data/transactions.ts:76` blanket-invalidates `['limits']`, and the refetch is
visible in the network log.

### TC-7 (W3): "Recurring" badge → ✅ PASS

Template `QA Подписка` (monthly, day 18 = today, 199 ₽, Подписки) created by curl →
`next_due_on: 2026-08-18`. A throwaway API on :8013 (same DB) was booted so its
unconditional catch-up job materialized the occurrence, then killed. `GET
/transactions` for today returns the row carrying
`recurring_template_id: a0d3c6d8-…`. In `/transactions` that row renders the chip
**`Recurring · QA Подписка`** under the category name, while the two hand-made rows
in the same list carry none — the contrast arm is in the same frame.

- Cleanup note: deleting the template afterwards (`DELETE /recurring/{id}` → 204)
  leaves the materialized transaction in place with `recurring_template_id` nulled,
  so the chip disappears. Recorded, **not evaluated** — that is D12/SL-C territory.

### Not retested, by instruction

TC-15's double terminator (`август 2026 г..`) and the `/categories` "Set a budget"
placement outside the row card — both remain open COSMETIC follow-ups.

### Retest hygiene

- Console: **zero errors** across the whole retest (the CORS error of the first run
  is gone).
- Network: one request per query per screen; every `OPTIONS` preflight seen
  (`/limits`, `/limits/{id}`, `/transactions`) returned **200**.
- Observation (not a defect): the web sends `DELETE /limits/{id}` with no `month`,
  and the API's handler takes none — a limit is one standing threshold per
  (user, category), not a per-month row (schemas/limit.py documents this). A
  `month` field sent to `PUT` is simply ignored by `LimitUpsert`.

### Retest summary

| | |
|---|---|
| Retested | 5 — TC-7, TC-10, TC-11, TC-12, TC-14 (`['limits']` half) |
| Passed | 5 |
| Failed | 0 |
| Still open | TC-15 COSMETIC (double terminator), the "Set a budget" placement COSMETIC — untouched by this fix, not retested |

**✅ READY FOR REVIEW** for the recurring + limits web surfaces: the blocker of
finding 1 is fixed and every case it blocked now passes. The two cosmetic findings
remain for senior-lead to schedule.
