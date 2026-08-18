# Grooming Review (Phase 4): recurring-and-limits — SCOPE grooming (5.3 + 5.4, web + backend, mobile FROZEN)

Senior-lead review of architecture.md + plan.md + plan-web.md + qa-checklist.md.
Verdict: **ACCEPTED with twelve binding amendments (AM-1..AM-12)** plus the three
pre-fan-out senior rulings (SL-A/B/C, already folded into plan.md/plan-web.md).
Amendments fold at each owning subtask's /implement (standing precedent — no
artifact re-write round). Subtasks B1a/B1b/B2/B3 + W1–W5 go straight to
implementation; NO per-subtask grooming. If implementation reveals the scope plan
wrong, STOP and re-groom the affected part.

## 1. Team & artifacts

| Agent | Artifact | Status |
|---|---|---|
| architect | architecture.md (D1–D22, OQ-1..7) | accepted; refined by SL-A (unpause watermark) and completed by backend Disagreement 2 (FOR UPDATE) |
| backend-engineer | plan.md (B1a/B1b/B2/B3, 41 tests, Disagreements 1–5, OQ 1–3) | accepted + AM-1..AM-9/AM-12; all five disagreements UPHELD (§3 R1) |
| frontend-engineer | plan-web.md (W1–W5, WR-1..12, Disagreements 1–5, OQ 1–3) | accepted; all five disagreements accepted (§3 R5); P1 diagnosis verified in-source by the engineer, escalation clause stands |
| qa-engineer | qa-checklist.md (CFG-J/S/R/P/C, TC-B1a..B3, GAP-1..12, Q-1..4) | accepted; ALL 12 GAPs adopted (§3 R3); Q-1..3 authorized with constraints (§3 R4) |

NOT invoked: mobile-engineer/mobile-qa (mobile FROZEN — carry-forward §7);
web-qa (client checklists at each W-subtask's /test — standing precedent);
code-reviewer (/review_senior of FULL subtasks only).

## 2. My independent verifications (not delegated)

- **V1 — the "joint upper-bound pass" carry-forward (meta-review-s4-s5) is ALREADY
  CLOSED**: `MAX_MINOR_AMOUNT` with `le=` verified on `schemas/transaction.py`
  (amount + base_amount, create + update) and `schemas/goal.py` (±MAX on
  contributions). D21 correctly reuses it; nothing to re-open.
- **V2 — GAP-12's arm is sound**: `services/profile_reads.read_base_currency`
  returns `DEFAULT_BASE_CURRENCY` for a profile-less user and never writes
  (read in source). The job's profile-less path is default-RUB + no self-heal,
  exactly what the arm asserts — not a warn-and-skip.
- **V3 — GAP-1's arithmetic is right**: 3 years of weekly ≈ 156–157 dates; the
  plan's cap fixtures could never reach 366. 2018-08-01 → 2026-08-18 ≈ 419–420
  Mondays — the proposed 366 + 54 + 0 three-run shape holds.
- **V4 — SL-A/B/C provenance**: my pre-fan-out rulings on architecture.md —
  (A) unpause watermark `max(last_materialized_on, today−1)` so the unpause DAY
  is live and a same-day pause/unpause cannot duplicate; (B) `recurring_template_id`
  server-managed, ignored (not rejected) on write DTOs per the house
  `extra="ignore"` default (backend verified: no DTO sets `extra="forbid"`);
  (C) SET NULL means no persistent orphan-id state. All three are in plan.md with
  named tests (B2-8/9/10/12) and in plan-web (WR-5/W3).
- **V5 — the scheduler-flag substrate**: `fx_scheduler_enabled` gate + lifespan
  wiring + the four test app-construction sites re-checked in source; the
  `recurring_scheduler_enabled` twin (O-3) is the correct analogue the task env
  asked for. Test servers: `RECURRING_SCHEDULER_ENABLED=false`.
- **V6 — polish item sources**: qa-web stats-advisor D1 (stall on outage,
  app-wide, reproduced on /goals) and D4 (ru double terminator, also on the
  shipped transactions empty state) re-read; both match the P1/P3 designs.

## 3. Rulings

### R1 — backend Disagreements 1–5: ALL UPHELD.
(1) `auto_snapshot` extraction lands in **B1b** — my grooming-brief skeleton had
it in B2; the job is the second consumer and `services → routers` is forbidden,
so B1b is simply correct. (2) **FOR UPDATE on the watermark row is a genuine gap
in D6** — the unconditional boot run-now and the 00:30 cron are separate job ids
that can interleave on one event loop; the lock completes the atomicity story
rather than contradicting it. Pinned by AM-5. (3) `domain/recurrence` importing
`budget_api.enums` is within the rule's purpose (enums.py imports nothing
internal); the alternative adds a heavier `models → domain` edge. The domain-
purity doctrine is hereby amended in writing: stdlib + `domain/` + `enums.py`.
(4) SL-A supersedes D6's unpause line — recorded, no conflict. (5) Two anchor
codes (`ANCHOR_REQUIRED`/`ANCHOR_MISMATCH`) stand; web Disagreement 3 confirms
the split costs clients nothing.

### R2 — backend OQ 1–3.
OQ-1 **CONFIRMED**: `next_due_on` floored at today via
`next_due(after=max(watermark, today−1))` — a pending catch-up never renders a
past "next" date; web Disagreement 4's dependency is thereby satisfied (no
fourth "catching up" UI arm). OQ-2 **ALLOWED, exactly one**:
`test_scheduler_wiring.py` may construct gated-on apps; it asserts registration/
triggers/kwargs (per AM-6), nothing behavioural; every other pytest app stays
gated off (O-3). OQ-3 **GRANTED**: B1 splits into B1a/B1b as argued — two review
surfaces, and the date math is pinned before its consumer exists.

### R3 — QA GAP-1..12: ALL ADOPTED as mandatory pytest changes (→ AM-1..AM-12).
The audit found two vacuous-by-arithmetic tests (GAP-1), one hoisted-lookup
blind spot (GAP-2), one unobservable-ordering fault injection (GAP-4), and the
sharpest catch of the scope — **GAP-7**: a web edit form sends `paused: false`
on every save, and a transition-blind unpause implementation would silently
swallow every pending catch-up date while passing all 41 planned cases. GAP-5's
concurrency test (`asyncio.gather` of two runs) is mandatory: it is the only pin
on the FOR UPDATE that the no-backstop design leans on; if it proves flaky in
CI, the engineer escalates to me — silent deletion is not an option. GAP-9:
the API-level Feb-clamp arm is unwritable without controlling `today` — dropped
in favour of the floor arm (which also pins R2's OQ-1); the clamp stays owned by
domain test B1a-1 and QA's live TC-B1b-6/TC-B2-4c.

### R4 — QA Q-1..4 (with my decisions recorded).
**Q-1 AUTHORIZED**: CFG-S2 — a short-lived server on port **8011** with
`RECURRING_SCHEDULER_ENABLED=true`, `FX_SCHEDULER_ENABLED=false`, cron set ~2 min
ahead, one throwaway template, killed immediately after. It is the smallest
honest reconciliation of O-11 ("the scheduler really fires") with the
no-live-scheduler-on-8010 rule. **Q-2 AUTHORIZED**: psql writes to `profiles`
(base-currency switch, profile delete) on rows THIS RUN created only — no
endpoint exists (verified by QA in the committed contract); cascade cleanup
covers it. **Q-3 CONFIRMED**: non-empty template census at PC-C → STOP-and-ask
(the job is global); future-dated rows on throwaway users are fine and die at
cleanup. **Q-4**: disposition per R3 — all 12 GAPs land as pytest arms; QA's
live pins stay (deliberate overlap, the stats-advisor R6 stance).

### R5 — frontend Disagreements 1–5: ALL ACCEPTED.
(1) The /stats budgets section renders ONLY for `period=month` (+ one
explanatory line otherwise) — anything else re-imports the contract lie D16
rejected. (2) `unconverted_count` renders once per screen, never per bar —
matches the server's period-level design. (3) Anchor-code split unreachable from
the web → bug-signal family; recorded. (4) Satisfied by R2/OQ-1. (5) P3 ships in
W1 (no backend dep; W1 already edits both files) — the brief's "whichever
subtask touches stats copy" is satisfied in spirit, deviation recorded.

### R6 — frontend OQ 1–3: CONFIRMED as recommended.
(1) Template form keeps a real `CurrencySelect` with the base read via the
shipped summary-shell pattern — a EUR subscription is the paradigm recurring
case, and dropping the picker would regress the 3.2 currency-as-form-field
stance. (2) `/recurring` is a top-level nav item — it is the screen that
explains machine-created money (D9's honesty mechanism). (3) Limits on
`/categories` are current-month-only, no stepper — the settings screen keeps
its nature; past-month review is W5's stats section.

### R7 — architect OQ-1..7: CONCUR with all seven recommendations.
Month+week single-interval grammar (OQ-1); none/end_date only (OQ-2); hard
DELETE + SET NULL (OQ-3); **limit currency stamped at set time, mismatch
surfaced, never auto-converted (OQ-4 — the central fork of 5.4; it is the
stage-3 no-guess stance applied to thresholds)**; full catch-up with the 366
safety valve (OQ-5); same-day-due template materializes at the next run, ≤24h,
correct occurred_at (OQ-6); limits on income categories rejected 422
CATEGORY_NOT_EXPENSE (OQ-7).

### R8 — P1's `networkMode: 'always'` is accepted WITH conditions.
It is an app-wide behaviour change on the busiest layer. Conditions: (a) W1
opens with the bounded instrumented reproduction and its finding goes in the
W1 report — if the root cause contradicts the paused-query mechanism, the fix
shrinks to the `queryPhase` + `QueryStateNotice` half; (b) web-qa's W1 checklist
regression-sweeps the SHIPPED screens (transactions, categories, goals, stats,
advisor), not just the new states; (c) the escalation clause stands even though
the engineer's in-source diagnosis says the coordinator is clean — A4's
coordinator vitest stays green and unmodified, stated in the report.

### R9 — doc nits (recorded, no rewrite round).
plan.md §Risks last bullet says "the web degrades to a badge-only state for a
NULL id" — wrong per SL-C (NULL id = no badge; badge-only degradation is the
transient cache-staleness case). The plan's tests (B2-10/11) and plan-web (W3)
are correct; the sentence is noise. Also plan.md's "39 cases" header vs 41
actual — QA counted; 41 is the contract.

## 4. Binding amendments (folded at the owning subtask's /implement)

| # | Amendment (closes) | Owner |
|---|---|---|
| AM-1 | Cap fixtures re-based: weekly watermark ≥8 years back (e.g. 2018-08-01, today 2026-08-18 → 420 Mondays: 366 + 54 + 0 across three runs) in B1a-5 AND B1b-8 (GAP-1) | B1a, B1b |
| AM-2 | B1b-1's template is foreign-currency with three DIFFERENT seeded rates on the three due dates → three different `base_amount_minor` (GAP-2) | B1b |
| AM-3 | B1b-5 rate-miss arm: rate seeded on the RUN date only, nothing at/before the due date → still `NULL/NULL` (GAP-3) | B1b |
| AM-4 | B1b-9: second fault position on the LAST due date (inserts staged when it fires); watermark read back in a FRESH session; assert `materialize_due` returned normally (GAP-4) | B1b |
| AM-5 | New test: `asyncio.gather` of two `materialize_due(sm, today=T)` against real Postgres → exactly N rows, one watermark advance (pins Disagreement 2's FOR UPDATE; flaky ⇒ escalate to senior-lead, never delete) (GAP-5) | B1b |
| AM-6 | B1b-11 asserts by TRIGGER, not func identity: with recurring on, exactly TWO `materialize_due` jobs — one UTC CronTrigger (configured h/m, grace 3600, coalesce) and one run-now with `misfire_grace_time is None`; BOTH jobs' kwargs keys == `{"sessionmaker"}` (GAP-6) | B1b |
| AM-7 | New arm: non-transition PATCH carrying `paused: false` on a never-paused template with a 2-month-old watermark leaves the watermark alone; subsequent `materialize_due` still materializes the pending dates (GAP-7 — transition-blind unpause) | B2 |
| AM-8 | B2-1 gains: explicit `currency: "USD"` on create → stored AND returned "USD" (GAP-8) | B2 |
| AM-9 | B2-7's API Feb-clamp arm REPLACED by the OQ-1 floor arm: watermark 2 months back → `next_due_on >= today`, never the pending past date. Clamp ownership: B1a-1 (domain) + QA live (GAP-9) | B2 |
| AM-10 | B3-7's rateless row moves to a category with NO limit → still counted in `unconverted_count` (pins period-level, not per-item) (GAP-10) | B3 |
| AM-11 | B3 gains: `items` ordering arm with two limits whose `str(category_id)` order differs from insertion order; and a limit on a SYSTEM (shared) category — the fresh-user normal case (GAP-11) | B3 |
| AM-12 | B1b-6 gains the profile-less arm: user with no `profiles` row materializes at the RUB default AND `profiles` still has no row afterwards (GAP-12; sound per V2) | B1b |

SL-A / SL-B / SL-C remain binding and are already planned+tested (plan.md B2-8/9/10/12).

## 5. Review-tier table (FINAL) + execution order

| # | Subtask | Tier | Pipeline |
|---|---|---|---|
| B1a | migration 0006 + models + domain/recurrence | **FULL** | implement → diff gate → QA → code-reviewer → meta-review |
| B1b | auto_snapshot extraction + materialization job + scheduler wiring | **FULL** | full |
| B2 | /recurring CRUD + tx attribution + regen | **FULL** | full |
| B3 | /limits + regen | **FULL** (granted — the GET fold is a money-honesty surface; goals-api S5 precedent) | full |
| W1 | P1 network surfacing + P3 ru terminator | **STANDARD** (R8 conditions; coordinator escalation clause) | implement (+ /review-pr) → diff gate → web-qa |
| W2 | /recurring screen + P2 shared-modal discard guard | **STANDARD** (receipt-flow escalation clause) | same |
| W3 | tx-list recurring badge | **STANDARD** | same |
| W4 | limits on /categories | **STANDARD** (screen-nature escalation clause) | same |
| W5 | budgets on /stats, month unit only | **STANDARD** | same |

Order: backend chain **B1a → B1b → B2 → B3** (strictly sequential; the two
regens must not race). Web: **W1 may start immediately** (no backend dep;
recommended first — it touches files every later W edits); **W2 → W3** after
B2's regen commit; **W4 → W5** after B3's. Web never runs `pnpm openapi`.
Web-qa checklists are written at each W-subtask's /test. My diff gate at every
tier. Code-reviewer briefings per the 2026-08-17 rule: review code, targeted
probes only — my gate re-runs are authoritative.

## 6. Open questions for PM (veto-style; defaults = what ships)

1. **Architect OQ-1..7 — I concur with all seven** (§3 R7). The two with real
   product texture: **OQ-4** (limit stores amount + currency stamped at set
   time; after a base switch the UI shows a mismatch prompt instead of silently
   reinterpreting 30 000 RUB as 30 000 USD) and **OQ-6** (a template created on
   its own due day materializes at the next daily run, ≤24h late with the
   correct date — no inline materialization on POST).
2. **Silent materialization (D9)** — deliberate inversion of the OCR rule: the
   template IS the standing confirmation; the tx-list badge + /recurring nav
   item are the honesty mechanism. Veto = per-occurrence confirms, which
   re-opens 5.2 territory.
3. **`/recurring` as a sixth top-level nav item** (R6.2). Veto = bury it in
   /categories.
4. **Polish fold-ins P1/P2/P3 are IN scope** (my call per the brief's
   authority, recorded): P1 app-wide `networkMode:'always'` + unreachable state
   (R8 conditions), P2 dirty-guard on the shared Modal (four shipped modals
   gain it), P3 `sentenceEnd` in packages/shared. Veto per item = drop from W1/W2.

Already decided this grooming (recorded, not open): all §3 rulings, QA Q-1..3
authorizations, B3 = FULL.

## 7. Carry-forwards to future tasks (durable record)

- **Deploy (1.7):** the in-process scheduler now carries TWO features; the
  single-instance assumption is unchanged, but the new FOR UPDATE means a second
  instance duplicates nothing on the recurring side — the fx job remains the one
  needing a leader/lock. Inherits the SSE proxy-buffering note.
- **Mobile unfreeze:** plan-web §Mobile carry-forward (R1–R6) is the contract —
  notably ISO weekday 0=Monday in RN pickers, `networkMode:'always'` must be
  re-decided under NetInfo (offline is usually TRUE there), and the discard
  guard needs an Android back-button channel. All shared additions are additive;
  `pnpm -r typecheck` guards the frozen app each W subtask.
- **Per-user timezone** (D3): dueness is UTC-date-based; re-arm when a timezone
  field lands on profiles.
- **`interval_count` / N-occurrences / RRULE** (OQ-1/2): additive later; the
  unit enum is the corner-avoidance.
- **Template archived-flag alternative** (OQ-3 veto path) — revisit only if a
  user actually mourns lost badges after a delete.
- **D13 re-arm triggers**: per-template tx-list endpoint or a measured slow
  template delete → index on `transactions.recurring_template_id`; a >100 ms
  limits screen → the tx_totals EXPLAIN discussion.
- **i18n**: unchanged from stats-advisor §7; P3 is a punctuation fix, not
  localization.

## 8. Ready state

Scope groomed. **B1a and W1 are both ready for /implement on PM's go**
(independent chains; defaults as above, veto window per item = before the
owning subtask's /implement). Each /implement report ticks its AM rows (§4),
plan obligations O-1..O-11, and the SL-A/B/C pins. PLAN.md 5.3/5.4 stay 🔄
until their subtasks land.
