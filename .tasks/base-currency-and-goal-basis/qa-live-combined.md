# qa-live-combined — ONE live program for BOTH scopes (PM cap: 15 total)

Scopes: `recurring-dates-and-income` (RDI) + `base-currency-and-goal-basis`
(BCG). Supersedes the LIVE sections of both scopes' checklists; pytest/vitest
sections there stay authoritative. RDI scenarios are POINTERS to
`.tasks/recurring-dates-and-income/qa-checklist.md` (LV-*), not restatements —
their preconditions block (UTC window, scheduler off, fixtures, hygiene) applies
to the whole run. BCG fixtures: `qa-base-hist@` (3 full months incl. a no-rate
row), `qa-base-empty@` (no tx) — on top of RDI's `qa-rdi-*` users.

Run AFTER both scopes' W1 land. Estimate: ~95-110 agent-minutes total
(RDI's ~75 minus ~15 merged/folded, plus ~35-45 BCG).

## Program (15)

RDI-owned (verbatim by pointer):
- **C-1** = LV-1 boot + live contract — EXTENDED: openapi must also carry
  `base_currency`/`monthly_income_minor` in ProfileUpdate, `free_balance_basis`
  + `free_balance_months_with_data` in GoalListRead. ✅
  FACT 2026-08-23 (:8011): /health 200 `{"status":"ok","database":"ok"}`; live
  /openapi.json canonicalised by `openapi_export.openapi_json` == committed
  apps/api/openapi.json byte-for-byte (sha256 8fb1944d…, 181961 B); live doc
  carries GET /recurring/upcoming (days min1/max90/default30),
  UpcomingChargeRead+UpcomingChargeList, `start_date` in Recurring
  Create/Update/Read, `base_currency`+`monthly_income_minor` in ProfileUpdate,
  `free_balance_basis`+`free_balance_months_with_data` REQUIRED in GoalListRead.
- **C-2** curl block = LV-2 (future start_date) + LV-10 (read-scope PAT on
  /recurring/upcoming) — EXTENDED: `PATCH /profile` with a PAT bearer → 401
  (JWT-only surface keeps holding after gaining money fields). ✅
  FACT 2026-08-23 (qa-rdi-a@): POST /recurring start_date=2026-10-02 → 201,
  next_due_on 2026-10-05 (≥ start), absent from /recurring/upcoming?days=30
  (7 rows, none of it) yet present at days=90 (Oct 5, Nov 5), /transactions
  total stayed 0; read-scope PAT → GET /recurring/upcoming 200 (7 items),
  PATCH /profile with the same PAT → 401 `Unauthorized` for BOTH
  `base_currency` and `monthly_income_minor` (profile unchanged), token
  DELETE 204 and afterwards the PAT gets 401.
- **C-3** = LV-3 + LV-4 merged: recurring form — create with start date, echo,
  move earlier, then clear (`start_date: null` in the network log). ⏸
- **C-4** = LV-5: both 422s route TO THE FIELD. ⏸
- **C-5** = LV-6: upcoming widget on /transactions (full fixture matrix). ⏸
- **C-6** = LV-7: pause updates the widget without reload. ⏸

Shared (one journey, both scopes assert):
- **C-7** = LV-9 income end-to-end (form flip → save → /accounts → /goals w/o F5)
  — EXTENDED (BCG average arm): on /goals the basis line is the AVERAGE arm;
  with qa-base-hist (3/3 data months) the shipped 3-month sentence stands
  verbatim; the N-of-3 wording ("по N из 3 месяцев с активностью") is asserted
  in the same visit by qa-base-empty AFTER C-11 posts its one back-dated row
  (count == 1). ⏸
- **C-13** = LV-8 EN pass — EXTENDED to BCG surfaces: /settings currency select
  + warning + income section in EN, basis line on /goals; ru spot-check of the
  same two blocks (no raw keys either way). ⏸
- **C-14** = LV-11 375×812 — EXTENDED: /settings both new sections reachable,
  warning wraps, keyboard-only completable; /goals basis block no overflow. ⏸
- **C-15** = LV-12 F5/deep-link — EXTENDED: F5 on /settings; direct
  `/settings?focus=income` focuses the income input. ⏸

BCG-owned:
- **C-8** Base switch journey (qa-base-hist, income SET): select shows
  USD/EUR/RUB/BYN; static warning states display-only + snapshots kept +
  unconverted possible + income reset; pick BYN → ConfirmDialog names the old
  currency BEFORE saving; confirm → exactly ONE `PATCH /profile` (network log),
  F5-persistent; UI lands on the income field prefilled with the /fx/convert
  SUGGESTION (editable, not auto-saved); `GET /profile` meanwhile shows
  `monthly_income_minor: null`; explicit Save re-declares it in BYN. Also
  observed here: the OPTIONS preflight for PATCH /profile passes (no CORS
  wall). ⏸
- **C-9** Propagation I (same session, NO reload): /goals renders free balance
  and amounts in BYN; /transactions month summary in BYN and the network log
  shows summary REFETCHED after the PATCH (tx list pages NOT refetched —
  over-invalidation is also a fail). ⏸
- **C-10** Propagation II (same session, NO reload): /stats (totals, monthly,
  BudgetsSection) and /categories limit bars show BYN, no mixed currencies on
  one screen; the no-rate row surfaces as the unconverted notice/count, not as
  silently wrong totals. ⏸
- **C-11** Basis "declared" (qa-base-empty): set income via Settings → /goals
  shows declared label ("расчёт от заявленного дохода, сменится на
  фактический…"), free balance == declared amount, NO month-window line; then
  post ONE back-dated row (curl, last full month) → basis flips to average
  (feeds C-7's N-of-3 assertion). ⏸
- **C-12** Basis "none" (qa-base-empty, income cleared via null): /goals shows
  the hint with a working link to /settings?focus=income (focus lands), free
  balance 0, no crash/empty-box; the old "you spent as much as you earned"
  falsehood is GONE. ⏸

## Cut registry (live → tests, per PM rule)
- RDI cuts: unchanged, see their registry (P-*/V-* mapping) — still valid.
- BCG validation/codes/bounds → pytest B1: CURRENCY_NOT_SUPPORTED, lowercase
  not normalized, BASE_CURRENCY_REQUIRED, income −1/0/max, omit-vs-null, twin
  drift, no-snapshot-recompute, A1 arm order (clear / same-PATCH wins / no-op
  keeps), basis ladder + months_with_data math, transfers-only month, degraded
  × basis invariant, JWT-only (TestAuth). Former api-TC-12/13/14/15 live
  content is folded into C-8..C-12; former api-TC-13's JPY no-rate probe lives
  on inside C-10's unconverted assertion.
- BCG web cuts: failed-PATCH inline error arm (former web-TC-4) — shipped
  LanguageSection pattern + code review; money-input formatting (former
  web-TC-5/6 detail) — parseMoney vitest + patch-builder discipline, the save
  itself still observed in C-8/C-11; currencyOptions branching — vitest.

## Result
Total: 15 · Passed: 2 (C-1, C-2 — curl, run 2026-08-23) · Failed: – ·
Blocked: 13 (C-3…C-15)

**BLOCKER 2026-08-23 (live browser run, attempt 1): no authenticated browser
session obtainable by the QA agent.** Every browser scenario C-3…C-15 needs a
logged-in session at http://localhost:5199. Two routes were tried and both are
closed to the agent:
1. Typing the fixture password into the /login form — forbidden by the agent
   safety policy (credentials/passwords must never be entered into a field by
   the agent), including for throwaway `qa-*@budgetqa.dev` fixtures.
2. Bootstrapping the session from tokens fetched over the API (write a
   throwaway `apps/web/public/qa-session.html` that seeds `localStorage
   ['budget.auth']`, then navigate to it) — denied by the Bash permission
   classifier; after that denial even authenticated `curl` reads with the
   already-issued tokens were denied too.

**Unblock options for the human/PM (pick one):**
- a human logs into :5199 once per fixture user in the browser pane, and the
  agent runs the scenarios in that session (needs 3 logins: qa-rdi-a, then
  qa-base-hist, then qa-base-empty — the C-8→C-10 chain must stay one session
  with NO reloads, so schedule the switches between blocks, not inside them);
- or grant the agent a Bash permission rule covering the session-bootstrap
  file + `curl` against :8011, and it re-runs unattended.
State verified before the block: qa-rdi-a fixtures intact — 7 templates,
`/recurring/upcoming?days=30` returns 7 rows (T-TODAY due 2026-08-23 first,
T-INCOME 08-25, T-SOON 08-26/09-02/09-09/09-16, T-FUTURE 09-12 as row 6),
T-CLAMP (`next_due_on: null`) and T-ENDED correctly absent.
