# Task: transactions-api (roadmap 1.4)

PM description (verbatim):

TASK (id: `transactions-api`, roadmap item 1.4): CRUD API for transactions + the
monthly summary endpoint. State: HEAD 044cd2b — categories API live (CategoryRead
with is_system, CategoryKind enum in enums.py), transactions table live
(kind-on-transaction sign model, amount_minor >= 0 CHECK, currency char3 CHECK,
category SET NULL, composite index user_id+occurred_at), shared parseMoney rejects
negatives, single currency for MVP (multi-currency is stage 3).

Scope per roadmap 1.4 and architecture:
- CRUD: create/update/delete transactions (DELETE is real here, unlike categories —
  architecture implies transactions are deletable; decide and justify), list with
  filters (period from/to, category, kind), pagination decision (architecture says
  personal volumes are small — decide: none vs limit/offset vs cursor; surface the
  tradeoff, lean answer preferred)
- Fields: amount_minor (positive int, validate against CHECK), kind (expense|income —
  reuse CategoryKind or separate TransactionKind? decide), currency (MVP: what does
  the API accept? profile.base_currency only? free ISO code? decide against the
  stage-3 multi-currency plan), category_id (nullable, must be visible-to-user
  category — validate; what happens when category kind mismatches transaction kind?
  decide: reject vs allow-with-kind-authority-on-tx per 1.2 model), occurred_at
  (date; future dates allowed? decide), note (length limit)
- Monthly summary endpoint per roadmap "сводка за месяц": decide shape — this is
  the FIRST aggregate; architecture says SQL aggregates returning render-ready
  series; keep it lean for 1.6's web needs (income total, expense total, net,
  optionally per-category breakdown — decide what 1.6 actually needs, name the
  consumer)
- Authorization: categories-api precedent applies (user-scoped every query,
  no-oracle 404)
- Contract regeneration + frontend contract review (lean role — 1.6 consumes this)
- Tests: pytest + QA curl; existing infra available

Team: backend + qa + frontend (contract review). Architect: senior-lead's call —
first aggregate endpoint MIGHT deserve a look at the domain/ layer boundary
(architecture says domain/ holds pure logic; is the summary SQL-in-router,
SQL-in-service, or domain function? decide — this sets the precedent for ALL
stage-4 statistics). Justify either way.

Process notes from the PM: proceed without waiting; artifacts to
.tasks/transactions-api/; Phase 4 with per-amendment checklist; /review_senior
stage will run after QA (PM pre-decision — transactions are the core domain).

Standing rules: root-file ownership = backend; per-amendment checklist; contract
artifacts same-commit; PG 5443 local / 5433 committed. NEW standing rule from the
1.3 retro: any post-gate fix round MUST re-run the FULL lint gate including
`ruff format --check` — 1.3's nit-fix round skipped it and the PM caught
unformatted files at commit time.
