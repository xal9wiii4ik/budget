# Task (verbatim scope description from PM)

SCOPE (id: `stats-advisor`, roadmap 4.1–4.5, web-only — mobile frozen):

- 4.1 aggregates API: category breakdown per period (month/quarter/year/custom),
  monthly dynamics, prev-period comparison, income vs expenses, top merchants
  (transactions.merchant exists since receipts S4), goals progress —
  render-ready series, base-currency via stage-3 snapshot semantics, index
  (user_id, occurred_at) as designed. The architect MUST rule on extracting the
  existing summary SQL from routers/transactions.py per the recorded precedent
  (.tasks/transactions-api/grooming-review.md).
- 4.2 web charts: Recharts (3.10.1 already pinned) screens over the ready series.
- 4.4 AI-advisor: POST /advisor/ask — compact summary (aggregates for 3 months,
  goals, income — NO raw transactions in prompt per architecture §security),
  Claude call, SSE streaming (0.3 recorded an SSE escape hatch in the api-client
  design — see .tasks/openapi-client-generation/architecture.md), daily rate
  limit via slowapi. BINDING USER REQUIREMENT: the web UI ships the "Спросить
  AI" button NOW; when ANTHROPIC_API_KEY is absent the backend answers honestly
  (the receipts 503 AI_NOT_CONFIGURED precedent — reuse the pattern/code, don't
  invent a second one) and the UI shows "AI недоступен — ключ не настроен". All
  pytest mocks at the Anthropic seam; no live-call gates.
- 4.5 CSV export (decide: endpoint streaming CSV of transactions with filters;
  lean).
- 4.3 mobile charts: FROZEN — exclude, note only.

Carry-forwards this grooming must address:
- transactions-api §9 Q1 / §7: aggregate-SQL extraction point is HERE; architect
  look happens here; fold the two summary queries into one grouping-set query if
  profiling cares; revisit `transactions.category_id` index (1.2 trigger).
- currencies-goals §7: summary bucket-3 fold-in revisit with EXPLAIN (D9);
  `unconverted_count` pattern extends to all stats endpoints.
- meta-review-s4-s5: joint upper-bound pass on amount columns
  (`amount_minor`/`base_amount_minor`/`target_minor`) — decide land-here vs
  stay-deferred. Also F4(a) future-dated contribution policy (PM), F4(b) chart
  reconciliation notes already in plan-web W4.

Env: PG on 5443 via TEST_DATABASE_URL, API on 8010, FX_SCHEDULER_ENABLED=false
on test servers.

Expected tiers: aggregates extraction + advisor endpoint = FULL (contract +
external integration); charts / CSV / UI = STANDARD.

Do NOT start implementation — grooming only.
