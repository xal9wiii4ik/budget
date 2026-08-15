# Grooming Review (Phase 4): currencies-goals — SCOPE grooming (3.1–3.5, web-only)

Senior-lead review of architecture.md + plan.md + plan-web.md + qa-checklist.md.
Verdict: **ACCEPTED with four binding amendments (AM-1..AM-4)**, folded at each
owning subtask's /implement (receipts AM precedent — no artifact re-write
round). Subtasks S1–S5 / W1–W4 go straight to implementation against the scope
plan; NO per-subtask grooming. If implementation reveals the scope plan wrong,
STOP and re-groom the affected part.

## 1. Team & artifacts

| Agent | Artifact | Status |
|---|---|---|
| architect | architecture.md (D1–D14, OQ-1..7) | accepted; two nits I raised were folded by backend ([SL-1] `from` alias, [SL-2] currency→base clears, [SL-3] per-goal flag) |
| backend-engineer | plan.md (S1–S5, Disagreements 1–5, OQ 1–3 to me) | accepted + AM-1/AM-2/AM-3; all disagreements upheld (§3) |
| frontend-engineer | plan-web.md (W1–W4, Disagreements 1–3/CA-1) | accepted; CA-1 GRANTED → AM-4 |
| qa-engineer | qa-checklist.md (TC-S1..S5, G1–G5, P1–P3) | accepted; G1→AM-1, G3→AM-2, G2/G4→AM-3, G5→AM-4; P1–P3 adopted |

NOT invoked: mobile-engineer/mobile-qa (mobile FROZEN); web-qa (client
checklists written at W-subtask /test — receipts S5/S6 precedent); code-reviewer
(/review_senior of FULL subtasks only).

## 2. My independent verifications (not delegated)

- **V1 — default base currency is RUB**: `DEFAULT_BASE_CURRENCY` stamped in
  `routers/transactions.py:109`, RUB profiles backfilled in migration 0003.
  Both plans' day-one-inversion argument (USD→RUB via stored RUB→USD) stands.
- **V2 — QA G1 is mathematically correct**: `b(RUB)` = BYN per 1 RUB ≈
  0.02–0.05 is the INTERMEDIATE; the stored `BYN→RUB` rate is its inverse
  (RUB per 1 BYN ≈ 25–35). Plan [SL-4].2's band as written would STOP a
  correct implementation AND pass the Cur_Scale-ignored bug (which produces
  ~0.3, inside neither band but closer to the wrong one). → AM-1.
- **V3 — D1 cross-rate math dimensional check**: RUB→USD = b(RUB)/b(USD)
  (BYN/RUB ÷ BYN/USD = USD-per-RUB ✓); BYN→X = 1/b(X) ✓. Table accepted.
- **V4 — G3 (backfill poisoning) is real**: D4's trigger is GLOBAL table
  emptiness; a partial-provider success during the one backfill run makes the
  table non-empty, so the failed provider's pairs permanently lose history
  (next runs are latest-mode). → AM-2.

## 3. Rulings

### R1 — backend plan OQ 1–3: all three CONFIRMED as recommended.
(1) PATCH `base_amount_minor: null` = discard-override-recompute (the snapshot
is server-managed; nullable-clears is a rule about user-owned data — the
"un-override" affordance is otherwise unreachable). (2) `allocated_monthly_minor`
in profile base currency (share of a base-currency number; per-goal conversion
would compound roundings and break the "Σ allocations ≤ free balance" display
invariant). (3) `is_realistic(needed<=0) → True` short-circuit (a reached goal
labeled unrealistic is absurd; pinned by S4 test (l)).

### R2 — backend Disagreements 1–5: ALL UPHELD.
Notably: (1) floor toward −∞ is the conservative direction on BOTH signs —
correct correction of D11's wording; (4) `fx_lookup`/`tx_totals` born-extracted
is right because both consumers are in-scope at grooming time; S5 at **FULL**
against receipts-R8's letter — new auth surface + money-adjacent assembler glue;
the escalation clause would fire anyway.

### R3 — web Disagreements 1–2: ACCEPTED.
Create omits an untouched auto value (server recomputes authoritatively —
kills the stale-debounce hazard); edit mode shows the stored snapshot + a
"will recompute" hint instead of live re-autofill (matches PATCH row 6
semantics; live autofill would misrepresent an unsent value as stored).
W-subtask escalation clause (trichotomy logic leaking out of pure helpers ⇒
escalate) recorded — implementing engineer must flag it, not absorb it.

### R4 — web CA-1: GRANTED → AM-4.
`GoalListRead` (and the single-GET shape) gains `base_currency: str`. Without
it the goals screen must borrow the transactions-summary query solely to learn
the base currency, and AM-5 forbids defaulting/guessing a currency at any
decode site. One additive field, S5 owns it.

### R5 — QA pushbacks P1–P3: ADOPTED.
P1: the single live external session is split S1 (fetch/probes) / S2 (convert
curl) but remains ONE session against one populated table — cap respected.
P2: a provider failure that produces NO warning log is a STOP (our code's
contract, not the provider's availability). P3: /test servers for S2–S5 run
with `FX_SCHEDULER_ENABLED=false` (rates seeded; determinism).

### R6 — W2's "banner retirement is a doc supersession": ACCEPTED.
Receipts S5/S6 web work is not yet in-tree (blocked on the live-call gate), so
the foreign-currency warning banner is superseded on paper: plan-web W2 amends
the receipts plan-web spec; whoever implements receipts-S6 after this scope
builds currency pass-through directly. Cross-file note added by W2, not code.

## 4. Binding amendments (folded at the owning subtask's /implement)

### AM-1 (S1, /test-gate bug — MUST; closes QA G1)
[SL-4].2 plausibility bands corrected: stored `BYN→RUB` ∈ ~[20, 45]
(inverse of b(RUB)); the 0.02–0.05 band applies to the INTERMEDIATE b(RUB)
only, and a Cur_Scale-ignored bug shows up as stored BYN→RUB ~100× off
(≈0.2–0.45). The /test check asserts the stored row, with the corrected band.

### AM-2 (S1, backfill-trigger gap — MUST; closes QA G3)
The D4 history-mode trigger becomes PER-PROVIDER: a provider fetches history
iff NONE of ITS canonical pairs has any row (frankfurter: EUR→USD; NBRB: the
other 5). A partial-provider failure during backfill then self-heals on the
next run instead of permanently poisoning the global emptiness probe. Plan S1
test 7 gains the contrast arm: frankfurter-only rows present → NBRB still
history-fetches, frankfurter does not.

### AM-3 (S3, unpinned arms — MUST; closes QA G2 + G4)
(a) Recompute-to-MISS: PATCH moving `occurred_at` before any stored rate →
snapshot goes `NULL/NULL` (extend S3 test 7 with the miss arm — non-vacuous
against its hit arm). (b) Stale-base + no-rate: extend S3 test 15's fixture
with a second stale-base row whose native currency has NO rate → excluded and
`unconverted_count` incremented (contrasts test 15's converted row).

### AM-4 (S5, contract + consistency — MUST; grants CA-1, closes QA G5)
`base_currency: str` added to the goals list/single response (R4). Plus one
consistency test: `GET /goals/{id}` returns the SAME `allocated_monthly_minor`
as that goal's row in the list response (pins the whole-portfolio-assembler
rule against a future "optimize the single GET" regression).

### Carry-forward checklist (/implement reports tick these)

| Item | Owner | Verified by |
|---|---|---|
| AM-1 corrected bands in /test probe | S1 | TC-S1 live session |
| AM-2 per-provider backfill trigger + test 7 contrast | S1 | diff gate + pytest |
| AM-3a recompute-to-miss arm (test 7) | S3 | diff gate + pytest |
| AM-3b stale-base+no-rate arm (test 15) | S3 | diff gate + pytest |
| AM-4 base_currency field + list/single consistency test | S5 | diff gate + TC-S5 |
| [SL-1] `from` key un-mangled in regenerated schema.d.ts | S2 | regen line in report |
| [SL-4].1 frankfurter-RUB STOP probe | S1 /test | TC-S1 |
| Exponent guard test FAIL-not-skip | S2 | diff gate |
| Contract regen+commit together | S2/S3/S5 | drift test + diff gate |
| AM-5 (receipts) decode discipline at every new money decode | W1–W4 | diff gate + vitest contrast |
| T8→T8′ supersession recorded in obligations trail | W1 | diff gate |
| Scheduler disabled in all pytest apps + rates table cleanup | S1 | conftest diff |

## 5. Review-tier table (FINAL) + execution order

| # | Subtask | Tier | Pipeline |
|---|---|---|---|
| S1 | rates-infra-and-migration | **FULL** | implement → diff gate → QA → code-reviewer → meta-review |
| S2 | fx-domain-and-preview | **FULL** | full |
| S3 | tx-snapshot-and-aggregates | **FULL** | full |
| S4 | goals-domain | **FULL** | full (pure module; QA = TC-Z1 only) |
| S5 | goals-api | **FULL** (R2 — plan's escalation upheld) | full |
| W1 | tx-form currency + converted section | **STANDARD** | implement (+ /review-pr) → diff gate → web-qa |
| W2 | summary banner + display + supersession | **STANDARD** | same |
| W3 | goals screen core | **STANDARD** | same |
| W4 | contributions + progress chart | **STANDARD** | same |

Order: **S1 → S2 → S3 → S4 → S5 → W1 → W2 → W3 → W4**. S4 may run any time
after S1; sequential recommended (openapi.json regen races — receipts §5
argument). W1 needs S3's regen (uses S2's endpoint); W3/W4 need S5's.
Web-qa checklists are written at each W-subtask's /test. STANDARD = engineer
self-review via /review-pr before reporting done; my diff gate at every tier.

## 6. Open questions for PM (veto-style; defaults = what ships)

1. **OQ-1 — conversion storage (THE central fork): default (b), nullable
   base-snapshot pair on transactions.** I CONCUR with the architect: it is the
   only option that honors the binding "override wins"; base-currency rows stay
   NULL/NULL; no backfill; stale-base snapshots fall back to display-time
   conversion. Veto to (a) requires renegotiating requirement 3 itself.
2. **OQ-2 — providers: frankfurter (EUR→USD) + NBRB (5 pairs).** CONCUR.
   NBRB-only is the fallback if the [SL-4].1 probe surprises us.
3. **OQ-3 — 400-day backfill on (per-provider, AM-2) empty history.** CONCUR;
   shrink to 90 is a config change (`fx_backfill_days`).
4. **OQ-4 — API validates currency format-only; the PICKER restricts to
   {USD, EUR, RUB, BYN}.** CONCUR — hard server restriction would re-open the
   receipts exotic-currency confirm gap.
5. **OQ-5 — `goals.saved_minor` column DROPPED (computed SUM); explicit
   deviation from the architecture doc's data-model table.** CONCUR — the
   doc's redundancy is an update anomaly in money; initial amount = first
   contribution row.
6. **OQ-6 — exponent twin-table: pytest cross-layer guard now, codegen
   deferred.** CONCUR — test-time is the only layer that can see both files.
7. **OQ-7 — waterfall priority split (not proportional).** CONCUR —
   explainable in one sentence, which is the product's honesty stance.

None block S1. Веto window: before the owning subtask's /implement.

## 7. Carry-forwards to future tasks (durable record)

- **Receipts S6 (when unblocked):** implement currency pass-through per W2's
  spec amendment — the warning banner is superseded, do not build it.
- **Mobile unfreeze:** tx-form currency picker + converted section + goals
  screens must replicate W1–W4 against the same contract; `SUPPORTED_CURRENCIES`
  and the new form schema live in packages/shared already (R3 ownership).
  Mobile becomes the third exponent-table consumer → fires the OQ-6 codegen
  trigger — re-evaluate single-sourcing then.
- **4.1 statistics:** summary bucket-3 fold-in revisit with EXPLAIN (D9);
  `unconverted_count` pattern extends to all stats endpoints.
- **Deploy (1.7/1.8):** scheduler runs in-process — single-instance assumption;
  if the API ever scales horizontally, the daily job needs a lock/leader
  (recorded trigger, not built).
- **Goals reorder bulk endpoint:** trigger = drag-reorder UI actually built
  (D10 YAGNI note).

## 8. Ready state

Scope groomed. S1 ready for /implement on PM's go (open questions default as
above). Each /implement report ticks its §4 checklist rows + plan-section
obligations row by row. PLAN.md stage-3 statuses flip per subtask as they land.
