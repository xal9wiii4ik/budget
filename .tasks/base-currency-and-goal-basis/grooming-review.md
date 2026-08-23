# grooming-review — base-currency-and-goal-basis (2026-08-22, senior-lead)

Team: backend-engineer, frontend-engineer, qa-engineer, web-qa. Architect NOT
invoked: no new tables/modules, additive fields on existing schemas only
(wall-clock policy narrowing). Mobile out by brief. Grooming wall-clock: ~28 min
to all artifacts; acceptance rulings after PM inputs.

## Tier classification
| Subtask | Tier | Why |
|---|---|---|
| B1 backend | FULL | contract change + money-adjacent math (free-balance basis, base switch) |
| W1 web | STANDARD | consumes contract; no client money arithmetic; engineer self-review /review-pr |

## Subtasks & estimates (agent-minutes: write / gates / verify-fix circles)
| # | What | Write | Gates | Fix circles |
|---|---|---|---|---|
| B1 | ProfileUpdate += base_currency (+CURRENCY_NOT_SUPPORTED, BASE_CURRENCY_REQUIRED) + monthly_income_minor; A1 income clear on switch; months-with-data divisor + basis + A2 count field; GoalPortfolio dataclass; twin list in domain/money.py + sync test; contract regen | 55 | 17 | ~18 |
| W1 | Settings currency+income sections, FreeBalanceSummary 5 arms, i18n, D3 invalidation (comparison trigger) | 68 | 12 | ~36 |
| QA | ONE combined live program `qa-live-combined.md`: 15 scenarios TOTAL for both scopes (RDI 6 + shared 4 + BCG 5); per-scope live sections superseded | — | — | 95–110 total (both scopes) |

Sequencing is HARD (task.md): recurring contract-pair commit → PM go → B1 →
(recurring W1 in parallel, zero file overlap) → our W1 → combined live run.

## Decisions log (all recorded in task.md/plans)
- D1 editable base, display-only, no snapshot recompute; twin list in
  domain/money.py next to exponents (PM); null → BASE_CURRENCY_REQUIRED (PM).
- D2 basis ladder average(months-with-data) → declared → none; transfers-only
  month = no data (ruled); current-partial-month inclusion REJECTED with reasons.
- A1: base switch CLEARS declared income (ruled post-QA; same-PATCH income wins,
  no-op switch keeps). PM veto window open — flagged.
- A2: free_balance_months_with_data on the wire (OQ-2; engineer's disagreement
  upheld — copy must not claim 3 months for a 1-month figure).
- D3 invalidation: per-field, comparison trigger (engineer's argument beat my
  body-presence rule — catches the A1 server-side clear); targets exclude tx
  lists and fx-convert with evidence (plan-web §5).
- Accounts-near-goals + Intl.DisplayNames + current-month inclusion → backlog.

## My pushbacks / overrides during acceptance
1. plan.md predated A1 → amended (arm order + 3 tests), dropped test replaced.
2. qa-web TC-7 asserted the OPPOSITE of A1 → amended with attribution.
3. plan-web §3 "rewrite the block" vs PM "extend the caption": judged compliant
   (caption survives verbatim in average arm) — PM can veto.
4. web-qa omitted run estimate → supplied mine above.

## PM sign-offs received (2026-08-22)
- A1 APPROVED + UX requirement → ConfirmDialog when income set + /fx/convert
  suggestion prefill (plan-web.md W-A1-UX; W1 now 80/12/~40).
- A2 APPROVED (+10/2/2 → B1 55/17/~18 stands, count field included).
- Caption interpretation APPROVED.
- QA cap: 15 TOTAL across both scopes → `qa-live-combined.md`; RDI's own
  checklist NOT edited by me (their line has it in flight) — PM announces the
  supersession of its live section.

## Open items for PM
- Go-signal for B1 after recurring commit (agreed trigger) — the only gate left.

## Artifacts
task.md · plan.md (+A1,A2) · plan-web.md (+rulings) · qa-checklist.md (15 TC,
11 pytest / 5 live) · qa-web-checklist.md (15 TC) · grooming-review.md
