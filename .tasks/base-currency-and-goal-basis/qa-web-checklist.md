# QA Web Checklist: base-currency-and-goal-basis (W1)

## Scope
Browser-only journeys for D1 (editable base currency + declared income in
Settings) and D2 (goals free-balance basis label). Everything else is proven
cheaper elsewhere and is NOT re-run here:

- 422 `CURRENCY_NOT_SUPPORTED`, `base_currency: null` → 422, `monthly_income_minor`
  null-clears / ≥0 CHECK, python↔shared currency-list drift — **pytest (B1)**.
- Basis resolution math (months-with-data counting, average vs declared vs none,
  the stray-row edge from task.md "Known edge") — **pytest (B1) + domain tests**.
- No recompute of stored snapshots — **pytest (B1)**.
- Money/date formatting helpers, plural rules, dict key completeness —
  **vitest / `pnpm typecheck`** (`dict.ru.ts` is a mapped type over `dict.en.ts`).

Fixtures are created with curl against the local API (8010), never by clicking
through forms. Users: `qa-base-hist@budgetqa.dev` (3 full months of tx incl. ≥1
row with no usable rate), `qa-base-empty@budgetqa.dev` (no tx at all). Log in
ONCE per user, reuse the session across all TCs.

**Blocked until B1 is committed** (contract pair + `free_balance_basis` field).

## Test cases

### Settings — base currency (D1)
- **TC-1** Open `/settings` as qa-base-hist (base RUB) → currency select is present near the language block, lists exactly USD/EUR/RUB/BYN, current value RUB. ⏸
- **TC-2** Warning copy near the control → visible without hovering/expanding, states display-only change + snapshots kept + possible unconverted rows + "заявленный доход будет сброшен — укажите его заново в новой валюте" (Amendment A1); no console errors on the screen. ⏸
- **TC-3** Switch RUB→BYN, then F5 → select still BYN, `GET /profile` returns BYN, exactly ONE `PATCH /profile` in the network log (no double-submit, no request storm). ⏸
- **TC-4** With devtools offline/blocked `PATCH /profile` (or API stopped), switch currency → inline error near the control, page not blanked, select recoverable on retry; error is role=alert. ⏸

### Settings — declared income (D2)
- **TC-5** Enter monthly income, save, F5 → value persists and renders through the money helper (no `12.500000001`, no raw minor units). ⏸
- **TC-6** Clear the field and save → field ends empty after reload (PATCH sent `null`, per patch-builder discipline: unchanged→omit, cleared→null). ⏸
- **TC-7** Income copy states the amount is in the BASE currency; switch base RUB→BYN on the same screen → the income FIELD EMPTIES (server clears it on switch, plan.md Amendment A1 — the pre-switch warning from TC-2 announced this), `GET /profile` shows null, and re-entering a value in BYN saves normally. [AMENDED by senior-lead 2026-08-22: original expectation "number does not change" predates the income-clear ruling.] ⏸

### Base switch propagation (the risky part — invalidation)
- **TC-8** As qa-base-hist on `/settings`, switch RUB→BYN, navigate to `/goals` WITHOUT reloading → free balance and goal amounts render in BYN. ⏸
- **TC-9** Same session, go to `/transactions` WITHOUT reloading → month summary shows BYN; check the network log that summary/list were refetched after the PATCH (today `useUpdateProfile` invalidates ONLY `['profile']` — if the screen still shows RUB until F5, this is a FAIL with evidence). ⏸
- **TC-10** Same session, `/stats` (totals + monthly chart + BudgetsSection) and `/categories` (limit bars) WITHOUT reloading → all base-currency amounts show BYN, no mixed RUB/BYN on one screen. ⏸
- **TC-11** After the switch, the rows with no usable rate → surface as the unconverted notice/count (`unconverted.*` copy) on summary and stats, not as silently wrong totals. ⏸

### Goals basis label (D2)
- **TC-12** qa-base-empty with `monthly_income_minor` set (curl) → `/goals` shows the DECLARED label ("расчёт от заявленного дохода, сменится на фактический при накоплении истории"), free balance equals the declared amount. ⏸
- **TC-13** qa-base-empty with income cleared (curl) → NONE hint visible with a working link to `/settings` that lands on the income field (focus/anchor), free balance 0, no crash and no empty-screen. ⏸
- **TC-14** qa-base-hist → `/goals` shows the AVERAGE label with the existing month window wording unchanged; F5 and direct deep-link to `/goals` restore the same label. ⏸

### i18n + responsive
- **TC-15** Switch language en↔ru and spot-check ONE screen each — `/settings` (currency + income + warning) in ru, `/goals` (basis label) in en → no raw keys, no English leftovers in ru; then at 375px both screens: control reachable, warning/label wrap without overflow, page completable with keyboard only (Tab to select, Enter to save). ⏸

## Result

Total: 15 · Passed: – · Failed: – · Blocked: 15 (awaiting B1 + W1)

Status: ⏸ NOT RUN
