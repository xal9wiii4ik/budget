# Scope: currencies-goals (roadmap 3.1–3.5, WEB-ONLY — mobile FROZEN)

USER REQUIREMENTS verbatim (binding, from the product owner reviewing the live
web app):

1. Transaction form must allow choosing the currency (currently base-only).
2. Daily FX rates parsed and stored for exactly these pairs: EUR→USD, RUB→USD,
   RUB→EUR, BYN→RUB, BYN→USD, BYN→EUR. NOTE for architect: frankfurter.app/ECB
   has NO BYN — Belarus National Bank has a free API (api.nbrb.by); decompose
   the source decision per-currency, don't assume one provider. APScheduler
   daily job per architecture; rates as Decimal never float; cached in
   exchange_rates table so conversion never depends on external API
   availability.
3. On creating a transaction in a non-base currency: auto-convert and display
   the converted amount in a SEPARATE SECTION of the form, EDITABLE by the user
   (their override wins). Architect must decompose the storage question this
   raises: architecture doc says transactions store native currency and
   aggregates convert at display time — an editable per-transaction conversion
   implies storing a base-amount snapshot (or rate override) on the
   transaction. Surface the fork explicitly with a recommendation; do NOT
   silently pick.
4. Goals (цели накоплений): domain math in domain/goals.py (pure, unit-tested:
   monthly_needed, realism check vs actual 3-month free balance, reverse
   deadline calc, priorities), goals + goal_contributions tables/API, web UI
   with the honest "unrealistic" messaging per architecture doc.

## Binding constraints

- Mobile is FROZEN — no apps/mobile work anywhere in this scope.
- AM-5 carry-forward from .tasks/receipts-ocr/grooming-review.md §4 (BINDING
  for ALL new money UI): never `currency ?? baseCurrency` in minor-unit
  decode — null/absent currency decodes at exponent 2, NEVER the base
  currency's exponent (100x bug under non-exponent-2 base).
- Receipts §7 carry-forwards owned by this scope: 3.2 closes the
  foreign-currency confirm gap (D8); revisit single-sourcing the
  currency-exponent table (AM-1 twin-table risk: domain/money.py vs
  packages/shared/src/currencies.ts).
- Existing web patterns: .tasks/web-transactions-ui/obligations.md (T4/T8:
  formatMoney with row currency, no hardcoded currency, moneyAmountSchema;
  query-key and PATCH-builder disciplines) remain binding.
- Env: PG on 5443 via TEST_DATABASE_URL, API on 8010; do NOT touch
  compose/.env.

## Expected artifacts (scope grooming mode)

architecture.md, plan.md, plan-web.md (ordered one-engineer-run subtasks with
dependencies + review tier each), qa-checklist.md (lightweight format for
STANDARD subtasks; live-layer strategy for scheduler/external FX APIs — mock
at seam in pytest + one real fetch check at /test), grooming-review.md
(per-subtask tier table + amendments + open questions with recommendations).

Expected tiers (PM guidance): rates-fetch job + conversion math + migrations =
FULL; goals domain = FULL (money math); web UI = STANDARD.
