# base-currency-and-goal-basis — task (groomed 2026-08-22)

Two live-user defects. Web only (mobile frozen). Parallel scope in flight:
`recurring-dates-and-income` (uncommitted contract pair — see collisions).

## Confirmed facts

1. **Base currency is not changeable at all.** `ProfileUpdate` = {country, language};
   `base_currency` read-only by an explicit earlier decision ("its own scope" —
   schemas/profile.py docstring). The aggregate side is ALREADY correct:
   `tx_totals.py` bucket order was designed for a base switch (stale snapshots
   fall into the convertible bucket, unconvertible rows counted honestly).
   `SUPPORTED_CURRENCIES` (packages/shared/src/currencies.ts) = USD/EUR/RUB/BYN;
   all four pairs covered by frankfurter+NBRB. No python twin of that list yet.
2. **Goals show zero for a history-less user.** `free_balance_minor` averages
   income−expense over 3 FULL months with hard n=3 (domain/goals.py, D11: current
   month excluded — understates both sides). DB was emptied 2026-08-22 → zero for
   ~3 months. `profiles.monthly_income_minor` exists, advisor-only, not writable.

## Decisions (v1)

### D1. Base currency becomes editable
- `ProfileUpdate` += `base_currency` (optional, NOT nullable — null → 422;
  omit=keep). Validated against a server-side supported list (python twin of
  shared `SUPPORTED_CURRENCIES`, drift pinned by a sync test — exponent-table
  precedent). 422 `CURRENCY_NOT_SUPPORTED`.
- NO recompute of stored snapshots — display-only change by design; aggregates
  already handle it (fact 1).
- Declared income on base switch (QA flag 1, ruled 2026-08-22): the stored
  `monthly_income_minor` has NO currency on the wire — it is interpreted in the
  CURRENT base. A base switch therefore CLEARS it server-side (same PATCH
  transaction): a silently re-denominated number (250000 RUB read as 2500.00
  BYN) is a ~30x-wrong "declared" basis wearing a working-feature face — worse
  than an honest empty state. No currency column in v1 (migration not worth
  it). UI copy at the switch MUST state: "заявленный доход будет сброшен —
  укажите его заново в новой валюте". Basis falls to "none" until re-entered;
  goals page hint guides back to Settings.
- Web: currency select in Settings next to language + honest warning copy:
  display changes only; historical snapshots stay; some rows may show as
  unconverted if no rate.

### D2. Free-balance basis resolution (goals)
Order of resolution in `assemble_goal_reads`:
1. **average** — months WITH data among the 3 full months (a month "has data"
   when income>0 or expense>0 or unconverted_count>0); divide by count of such
   months, not by 3. Math for the with-history user unchanged in spirit.
   Ruled (QA flag 2): a month of ONLY transfers counts as NO data — transfers
   are movement between own accounts, zero signal about saving capacity;
   `tx_totals` excluding them at the source is correct here too. TC-8 asserts
   basis="declared" for the transfers-only user.
2. **declared** — no month has data AND `monthly_income_minor` set → free
   balance = declared monthly income (interpreted in base currency).
3. **none** — neither → 0.
- Response: `GoalsListResponse` += `free_balance_basis: "average"|"declared"|"none"`.
- `monthly_income_minor` += to `ProfileUpdate` (nullable: null clears; ≥0 CHECK
  exists on the model).
- Web: basis label on GoalsPage — declared → "расчёт от заявленного дохода,
  сменится на фактический при накоплении истории"; none → hint + link to
  Settings income field.

### D3. Cache invalidation is a PLAN REQUIREMENT, not a QA scenario (PM 2026-08-22)
Today a profile write seeds/invalidates ONLY `['profile']` — correct for the
common case and it stays the default. Two explicit exceptions, and the
difference must be EXPLICIT in code (per-field branch in the mutation's
onSuccess, not a blanket invalidate on every profile save):
- `base_currency` changed → additionally invalidate `['goals']` (prefix),
  `['stats']`, `['limits']`, and summaries via predicate
  `key[0]==='transactions' && key[1]==='summary'`. NOT tx lists (rows echo
  stored snapshots — identical bytes, would refetch every infinite page) and
  NOT `['fx','convert']` (base is part of the key — a switch is a new key by
  construction). Evidence table: plan-web.md §5.
- `monthly_income_minor` changed → additionally `['goals','list']` only
  (advisor reads income server-side per request, no client cache).
- `language`/`country` changed → `['profile']` only, unchanged.
Trigger (REVISED at plan acceptance, supersedes the body-presence rule first
written here): compare CACHED profile vs the PATCH RESPONSE per field. Wins
over inspecting the sent body: catches server-side effects (the A1 income
clear on a base switch) and a base that changed under this tab since the cache
was seeded; never fires on a same-value PATCH. Empty cache must FAIL OPEN
(`previous?.field !== updated.field` → invalidate).

### Considered and rejected for v1
- **Include current partial month**: figure would change daily and distort both
  directions (salary on the 1st ⇒ huge overstatement; early month ⇒ zero); the
  declared-income fallback covers exactly the no-history case. Backlog if ever.
- **Account balances next to goals**: stock-vs-flow confusion, accounts screen
  already shows balances; v1 limits itself to the basis label + settings link.
  Backlog: a small "on accounts: X" line, needs no new API (accounts cache).
- **Auto-converting declared income on base switch**: never — user-entered
  number, warn in UI instead.

## QA-surfaced notes (2026-08-22)
- The "no rate to new base" arm is unreachable within the supported four
  (all pairs covered by providers); QA reaches it via a JPY account. FRAGILE:
  any future scope restricting account currencies to SUPPORTED_CURRENCIES
  kills that probe — re-plan the TC then, don't drop the arm.
- B1 MUST rewrite `tests/test_profile.py::test_base_currency_is_not_writable_here`
  (pins the old read-only behaviour) into the new valid/invalid/null trio —
  not silently delete it.

## Known edge (accepted)
A single stray row in one of 3 months flips basis to "average" over 1 month —
honest but potentially surprising. QA covers; no special-casing in v1.

## Subtasks
- **B1 (backend, FULL tier — contract change + money math):** D1 + D2 server
  side, one contract regen, tests. Files: schemas/profile.py, routers/profile.py,
  domain/goals.py, services/goal_reads.py, schemas/goal.py, openapi.json+schema.d.ts.
- **W1 (web, STANDARD tier):** Settings currency select + income field + warning;
  GoalsPage basis label; i18n keys (en+ru); D3 per-field invalidation branch.
  Files: SettingsPage.tsx, data/profile.ts, GoalsPage.tsx, i18n dicts.

## Sequencing (HARD, PM decisions 2026-08-22)
1. WAIT: recurring-dates-and-income backend commit (holds the contract pair;
   final circle in flight). B1 starts ONLY on PM's explicit go.
2. B1 (backend) — in parallel PM runs recurring W1 (recurring screen + tx
   screen widget; zero file overlap with us).
3. W1 (web) — strictly after our B1. NO early start against hand-declared
   types: the QA surface and goals-basis UI depend on contract fields that do
   not exist yet; early start here is rework, not savings. (Overrides the
   wall-clock parallel-default for THIS scope.)
4. ONE COMBINED live QA run for BOTH scopes, single environment bring-up (PM):
   base-currency switch gets verified on data that includes recurring/upcoming
   rows — cheaper and a more honest dataset. Our qa-checklist.md and
   qa-web-checklist.md execute inside that combined run.

## Collisions with recurring-dates-and-income
- `openapi.json` + `schema.d.ts`: recurring B1 sits UNCOMMITTED in the working
  tree (last review circle: row-lock + 2 NITs). RESOLVED: our B1 starts only on
  PM's go after that commit; contract pair regenerates on top.
- GoalsPage.tsx: RESOLVED by PM 2026-08-22 — goals screen is OURS alone.
  Recurring's goals-screen work (W2 window caption) is finished in main
  (d0dd244); its remaining web line (W1: start-date field + upcoming widget)
  touches recurring/transactions screens only. REQUIREMENT for our W1: do not
  rewrite the committed window caption — EXTEND it, so the user reads one
  coherent explanation of the free-balance basis (window + basis arm), not two
  paragraphs about the same thing in different words.
- routers/recurring.py etc.: zero file overlap with our scope.
