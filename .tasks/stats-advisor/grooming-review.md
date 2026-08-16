# Grooming Review (Phase 4): stats-advisor — SCOPE grooming (4.1/4.2/4.4/4.5, web-only)

Senior-lead review of architecture.md + plan.md + plan-web.md + qa-checklist.md.
Verdict: **ACCEPTED with ten binding amendments (AM-1..AM-10)**, folded at each
owning subtask's /implement (receipts/currencies-goals precedent — no artifact
re-write round). Subtasks B1/B2a/B2b/B3 + W1–W4 go straight to implementation;
NO per-subtask grooming. If implementation reveals the scope plan wrong, STOP
and re-groom the affected part. 4.3 mobile is FROZEN (carry-forward notes only).

## 1. Team & artifacts

| Agent | Artifact | Status |
|---|---|---|
| architect | architecture.md (D1–D16, OQ-1..8) | accepted; D1 discharges the transactions-api §9-Q1 precedent (extraction verified already-done at 3.2; services/ definition amended in writing); D14 land-here recommendation adopted |
| backend-engineer | plan.md (B1/B2a/B2b/B3; Disagreements 1–3; OQ 1–3) | accepted; all three disagreements UPHELD (§3 R1); OQ-1/OQ-2 confirmed as recommended; B2 split (B2a/B2b) endorsed |
| frontend-engineer | plan-web.md (W1–W4, WS-1..9, Disagreements 1–3, OQ 1–5 incl. CA-1/CA-2) | accepted; 4-way split deviation endorsed; rulings in §3 R4/R5 |
| qa-engineer | qa-checklist.md (CFG-U/D/K strategy, TC-B1/B2a/B2b/B3, GAP-1..7, Q1–4) | accepted; CFG strategy adopted; GAP rulings in §3 R3 |

NOT invoked: mobile-engineer/mobile-qa (frozen); web-qa (client checklists at
each W-subtask's /test — standing precedent); code-reviewer (/review_senior of
FULL subtasks only).

## 2. My independent verifications (not delegated)

- **V1 — QA's fixture-F pins recomputed by hand**: Feb (250000/700000/450000,
  unconverted 1), Q1 (950000 = 100000+250000+300000+300000-CHF-converted,
  unconverted 3), year (+r10 → 960000), custom Feb 1–10 incl. the inclusive-`to`
  r4 and the same-length-prev vs calendar-prev distinguishability, monthly 8-point
  series with flag distribution 2/1/0, top-merchants ALFA 800000/3 + GAMMA
  omission. All correct. The CHF→RUB=100.0 seed makes every conversion exact.
- **V2 — D1's "extraction already happened at 3.2"**: verified in source —
  `converted_totals` consumed at routers/transactions.py:347 AND
  routers/goals.py:193; the summary router is a thin shell. The precedent's
  ruling therefore lands as a doctrine amendment, not a move; correct.
- **V3 — OQ-2 (advisor window) consistency**: `_FREE_BALANCE_MONTHS = 3` at
  goals.py:70 with the "current partial month excluded" comment — the advisor
  window ruling matches the shipped free-balance semantics exactly.
- **V4 — D10/D11/CA-1 substrate**: inline 503 at receipts.py:267-272,
  `_rl_stash_user`:117, `receipt_rl_key`, `headers_enabled=False` at
  rate_limit.py:45 — all real; the CA-1 decline (§3 R5) rests on that last one.
- **V5 — feasibility spot-checks**: anthropic 0.120.0 in pyproject/uv.lock;
  `CategorySummary` at schemas/transaction.py:146 (the reuse D-decision is
  real); `_MONTH_PATTERN` at transactions.py:64.
- **V6 — the B3 resequencing contradiction QA caught is real**: plan intro
  ("B3 may be resequenced ahead of B2") vs B3 header ("Depends on: B2b" for
  `to_major_string`). → AM-9.
- **V7 — D14's "existing rows can't exceed it" was overstated** (no upper bound
  ever existed at the schema layer) — covered by plan O-2's one-time
  `SELECT max()` pre-flight, which I mandated and the plan carries. Verified
  present.

## 3. Rulings

### R1 — backend Disagreements 1–3: ALL UPHELD (communicated pre-fan-out; recorded).
(1) `AI_NOT_CONFIGURED` 503 does NOT consume advisor quota — the gate is a
dependency resolving before the limiter; the binding UI copy must not become
"RATE_LIMITED" on the second click; receipts bytes/order unchanged (inline call
site kept). Pinned by pytest B2b-4 + live TC-B2b-3 (whose CFG-D contrast arm is
what makes it non-vacuous). (2) `services/advisor.py` imports config + stdlib
only — the §security "no raw transactions" becomes an import-graph property.
(3) No anyOf 422 on /advisor/ask (no emittable business 422 — declaring one
inverts AM-5); stats keeps its union (`PERIOD_ANCHOR_REQUIRED` is real).

### R2 — backend OQ 1–3.
OQ-1 CONFIRMED: `read_base_currency` → `services/profile_reads.py` in B1, both
shipped call sites refactored (4 consumers; D1's amended definition).
OQ-2 CONFIRMED: advisor window = 3 FULL months, current partial excluded (V3).
OQ-3 (B2a tier): **STANDARD stands, conditioned** — B2b's FULL code-review
explicitly re-reads the B2a extraction diff as context (rate-limit keying is
security-adjacent and its cross-namespace pin lands only in B2b-6). → AM-10.

### R3 — QA GAP-1..7: six become mandatory pytest arms; GAP-3 is a spec ruling.
- **GAP-1 AGREE (vacuity is real)**: B1-9 as written pins `previous.
  unconverted_count == 0`, which a hardcoded 0 or a copied current-window value
  passes. → AM-1.
- **GAP-2 AGREE**: no pytest arm asserts an exact negative `net_minor`; `abs()`
  would pass the suite while breaking F4(b)'s consumers. → AM-2.
- **GAP-3 RULED — redundant-but-correct anchors are IGNORED.** The resolver
  reads only the chosen unit's anchor; extra stale params (a client switching
  tabs) do not 422 a request whose intent is unambiguous. "Mismatched" in D5
  means the CHOSEN unit's anchor is absent. One pytest arm pins it; QA TC-B1-2
  flips from "record" to assert 200. → AM-3.
- **GAP-4 AGREE (the sharpest catch)**: nothing asserts `payload.history`
  reaches the seam — a router dropping it passes all 11 cases while chat memory
  is dead. → AM-4.
- **GAP-5 AGREE**: the strip/blank/2000 question validator is custom validation
  with zero pytest arms. → AM-5.
- **GAP-6 AGREE**: CSV `content-type`/`Content-Disposition` ARE the download
  affordance and were unpinned. → AM-6.
- **GAP-7 AGREE**: context `unconverted_count` hardcoded to 0 passes every
  case; it is a designed honesty field. → AM-7.

### R4 — frontend Disagreements 1–3.
(1) **Monthly-not-period-scoped: SHIP THE UI WORKAROUND** (separate "Last N
months" section, own selector, outside the period card). Adding D5 period
params to /stats/monthly would make the default month view show one bar —
worse; the trailing-window chart is the honest design. Recorded deliberate;
re-visit trigger: real user misreading reported. (2) **Advisor panel fully in
Russian** — the binding copy and the model's answers are Russian; a Russian
conversation in an English shell with mixed errors is the incoherent option.
No other screen's copy is touched (`receiptErrorMessage` English entry stays).
App-wide i18n recorded as a carry-forward (§7), not started. (3) **D14 client
mirror DECLINED** — the server 422 routes to the amount field via shipped
machinery; mirroring touches three schemas the frozen mobile imports. Trigger
to revisit: anyone actually hits the bound.

### R5 — contract asks CA-1 / CA-2.
**CA-1 (Retry-After on 429): NOT granted** — `headers_enabled=False` is shipped
surface (V4); reopening it for tier-disambiguation copy on a personal app buys
almost nothing. The vague "подождите" copy stands. **CA-2 (plain-text prompt
instruction): GRANTED** — one line in `render_prompt` ("отвечай простым
текстом, без markdown-разметки"), because the web renders `pre-wrap` and will
not add a markdown dependency. → AM-8. A markdown renderer remains a separate
approval-gated ask (frontend OQ-4 fallback recorded).

### R6 — QA questions Q1–4 (with PM decisions recorded).
Q1 → R3/GAP-3 ruling above. Q2 → **CFG-K waived**: no key at /test; TC-B2b-8
is 🚫 blocked-non-gating, scope passes (PM decision, receipts 2026-07-29
precedent). Q3 → **CFG-D egress ACCEPTED** (auth-failing requests to
api.anthropic.com bill zero tokens; offline fallback is equivalent — PM
decision). Q4 → all six gaps land as pytest arms per R3; QA's live pins stay
(deliberate overlap: the vacuity was found at the pytest layer, the wire pin
survives regardless).

### R7 — architect OQ-1..8: CONCUR with all eight recommendations.
Keep both summaries (OQ-1); client-carried history (OQ-2); `5/minute;20/day`
knob (OQ-3); verbatim merchant grouping, duplicate-rows re-visit trigger
(OQ-4); LAND the upper-bound pass (OQ-5, V7); CSV major-unit strings (OQ-6);
keep allowing future-dated contributions — F4(a) closed as documented-not-
changed (OQ-7); dedicated Sonnet-default `advisor_model` (OQ-8).

### R8 — frontend OQ 1 and 5.
Entry point = dedicated `/advisor` route + nav + the binding "Спросить AI"
button on /stats navigating to it (a modal loses the transcript and traps focus
around a streaming region). `/transactions` stays untouched apart from the W4
export button — no SummaryHeader migration to /stats/summary (consistent with
architect OQ-1).

## 4. Binding amendments (folded at the owning subtask's /implement)

| # | Amendment | Owner |
|---|---|---|
| AM-1 | B1-9 fixture gains a DIFFERENT no-rate count in the previous window (current 1 / previous 2) so `previous.unconverted_count` must differ from the current block (closes GAP-1; mirrors QA's live fixture) | B1 |
| AM-2 | One pytest arm asserts an exact NEGATIVE `net_minor` (expense-only month, e.g. `-100000`), in B1-4 or B1-10 (closes GAP-2) | B1 |
| AM-3 | Redundant-but-correct anchor IGNORED (R3 ruling): `period=month&month=2026-02&quarter=2026-Q1` → 200 byte-identical to the request without the stray; one pytest arm in B1-7's parametrization; `resolve_period` docstring states the rule; QA TC-B1-2's observation flips to an assertion | B1 |
| AM-4 | B2b-7 accept arm additionally asserts `fake.last_history` equals the posted turns, in order, roles intact (closes GAP-4) | B2b |
| AM-5 | B2b-7 gains the question-validator arms: `""`, `"   "`, 2001 chars → 422; 2000 chars → 200 (closes GAP-5) | B2b |
| AM-6 | B3-2 gains two header assertions: `content-type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="transactions.csv"` (closes GAP-6) | B3 |
| AM-7 | B2b-8's fixture gains one no-rate foreign row; asserts `last_context.unconverted_count == 1` AND that `render_prompt` mentions it (closes GAP-7) | B2b |
| AM-8 | CA-2: `render_prompt` includes the plain-text/no-markdown instruction line; the render_prompt unit test (B2b-11 family) gains a presence arm so a prompt edit cannot silently drop it | B2b |
| AM-9 | Plan-intro contradiction resolved: default order B1→B2a→B2b→B3 stands; IF B3 is ever resequenced ahead, `domain/money.to_major_string` lands with B3 instead of B2b (one-line plan note, no behavior change) | B2b/B3 |
| AM-10 | B2a ships STANDARD on condition: the B2b /review_senior pass explicitly includes the B2a extraction diff (ai_gate, user_rl_key factory, goal_reads move) as in-scope review context | B2a/B2b review |

Standing plan obligations O-1..O-9 remain in force unchanged (incl. O-1 EXPLAIN
ANALYZE evidence, O-2 max() pre-flight, O-9 with the CFG-K waiver of R6 —
its mandatory half is the Excel/BOM check plus the unkeyed-503 live arm).

## 5. Review-tier table (FINAL) + execution order

| # | Subtask | Tier | Pipeline |
|---|---|---|---|
| B1 | aggregates + periods + D14 bounds + profile_reads extraction | **FULL** | implement → diff gate → QA → code-reviewer → meta-review |
| B2a | plumbing extractions (ai_gate, user_rl_key, goal_reads) | **STANDARD** (AM-10 condition) | implement (+ /review-pr) → diff gate → QA (CT-B2a) |
| B2b | advisor seam + SSE endpoint | **FULL** (reviews B2a diff too) | full |
| B3 | CSV export | **STANDARD** | implement (+ /review-pr) → diff gate → QA (CT-B3) |
| W1 | stats-core: route, period grammar, summary + comparison | **STANDARD** | implement (+ /review-pr) → diff gate → web-qa |
| W2 | stats-charts: monthly, merchants, goals section | **STANDARD** | same |
| W3 | advisor: SSE client + chat screen | **STANDARD** (escalation clause: parser can't stay pure ⇒ ask for FULL) | same |
| W4 | CSV export button | **STANDARD** | same |

Canonical order: **B1 → B2a → B2b → B3 → W1 → W2 → W3 → W4**. W1/W2 MAY start
any time after B1's regen commit (web never runs `pnpm openapi`, so no regen
race with the backend chain); W3 needs B2b's regen, W4 needs B3's. Web-qa
checklists are written at each W-subtask's /test. My diff gate at every tier.

## 6. Open questions for PM (veto-style; defaults = what ships)

1. **Architect OQ-1..8** — I CONCUR with all eight defaults (§3 R7). The two
   with real product texture: OQ-3 advisor limit `5/minute;20/day` (pure
   Settings knob), OQ-8 dedicated Sonnet-default model (advice quality is the
   feature; OCR economics don't transfer).
2. **Advisor panel language = Russian** (R4.2), everything else untouched;
   app-wide i18n is a recorded carry-forward, not scope. Veto = one message
   table + three labels.
3. **Advisor entry = `/advisor` route + nav**, "Спросить AI" button on /stats
   navigates there (R8). Veto to modal = W3-internal change, no re-groom.
4. **CA-1 Retry-After NOT added** (R5). Veto = reopen `headers_enabled` on the
   shipped limiter surface.
5. **`/transactions` untouched** apart from the export button (R8). Veto =
   a migration subtask appears.

Already decided by PM this grooming (recorded, not open): CFG-K waived
non-gating; CFG-D dummy-key egress accepted; GAP dispositions per R3.

## 7. Carry-forwards to future tasks (durable record)

- **Deploy (1.7):** reverse-proxy buffering kills SSE — nginx needs
  `proxy_buffering off` / `X-Accel-Buffering: no`; a buffered stream degrades
  silently to non-streaming (correct but lumpy — web-qa told it's a deploy
  symptom, not a web bug). Inherits the existing single-instance scheduler note.
- **Mobile unfreeze (4.3):** same contract; Victory Native XL over the same
  `points[]`/`by_category[]`; RN fetch cannot stream → D12's `?stream=false`
  collected-JSON trigger; check `TextDecoder` under Hermes; quarter helpers,
  `advisorAskSchema`, `buildHistory`, `askAdvisor` seam all port; mobile becomes
  the third exponent-table consumer → fires the OQ-6@3.x codegen re-evaluation.
  CSV stays web-only.
- **i18n:** the app now deliberately ships an English shell + Russian advisor
  panel (R4.2). Trigger for an app-wide localization pass: stage-5 polish or
  first non-Russian-speaking user.
- **D14 client mirror** (R4.3): revisit if anyone hits the bound in a form.
- **Merchant normalization** (OQ-4): trigger = visible duplicate merchant rows
  on the real screen; fix is fold-in-side, no contract change.
- **Monthly period-scoping** (R4.1): trigger = real user misreading of the two
  time scopes on /stats.
- **Advisor markdown rendering**: separate approval-gated ask; AM-8's plain-text
  instruction is the current contract.
- **Per-delta render jank** (plan-web risk): fix is rAF-buffered deltas;
  recorded, not built.
- **Stats >100 ms at realistic volume** (D3/O-1): re-arm the EXPLAIN/index
  discussion.

## 8. Ready state

Scope groomed. B1 ready for /implement on PM's go (defaults as above; veto
window per item = before the owning subtask's /implement). Each /implement
report ticks its AM rows (§4) + plan obligations O-1..O-9 row by row. PLAN.md
stage-4 statuses flip per subtask as they land.
