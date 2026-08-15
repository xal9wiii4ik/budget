# Grooming Review (Phase 4): receipts-ocr — SCOPE grooming (first run of scope mode)

Senior-lead review of architecture.md + plan.md + plan-web.md + qa-checklist.md.
Verdict: **ACCEPTED with four binding amendments (AM-1..AM-4)** folded at each
subtask's /implement — no artifact re-write round needed (established AM
precedent). Subtasks S1–S6 go straight to implementation against the scope plan;
NO per-subtask grooming. If implementation reveals the scope plan wrong, STOP and
re-groom the affected part (skill rule) — do not silently deviate.

## 1. Team & artifacts

| Agent | Artifact | Status |
|---|---|---|
| architect | architecture.md (D1–D14) | accepted; 2 factual corrections by backend, both verified by me (§2) |
| backend-engineer | plan.md (S1–S4, flags 1–3, disagreements 1–3) | accepted + AM-1/AM-2/AM-3/AM-4 |
| frontend-engineer | plan-web.md (S5–S6, contract feedback, Q1–Q4) | accepted; Q1–Q4 ruled (§3) |
| qa-engineer | qa-checklist.md (TC-S1..S4, Claude ruling, G1–G4) | accepted; G1→AM-1, G2→AM-4, G3 ruled curl-only |

NOT invoked: mobile-engineer/mobile-qa (mobile FROZEN, PM constraint);
web-qa (checklist deferred to S5/S6 /test, PM instruction); code-reviewer
(only at /review_senior of FULL-tier subtasks).

## 2. My independent verifications (not delegated)

- **V1 — minio-py cannot sign Content-Type into a presigned PUT.** Verified
  against minio-py 7.2.20 source (`signer.py:275`:
  `canonical_headers, signed_headers = "host:" + url.netloc, "host"` — hardcoded;
  `presigned_put_object` takes no headers param). Backend Disagreement 1 is
  CORRECT; architecture D9's "enforced Content-Type" is hereby amended to
  **advisory**. The real gate is the parse-time HEAD Content-Length (422
  IMAGE_TOO_LARGE). Recorded so nobody "fixes" the advisory header later.
- **V2 — parse-route 422 must be the anyOf union.** Verified against committed
  `openapi.json`: `DELETE /transactions/{id}` carries the auto
  `HTTPValidationError` arm; `POST /transactions` carries the
  `anyOf[TransactionError, HTTPValidationError]` union. FastAPI auto-emits the
  validation arm for the uuid path param, so declaring `ReceiptError` alone on
  `POST /receipts/{id}/parse` would suppress it — the exact AM-5 (1.4) lie.
  Backend Disagreement 2 is CORRECT; D12 amended: parse 422 = anyOf union,
  GET stays 404-only with the auto arm.
- **V3 — shared exponent semantics.** `packages/shared/src/money.ts` converts
  via the `CURRENCY_EXPONENTS` exception table (default 2). The plan's
  `to_minor_units` sketch hardcodes ×100 for ALL currencies → cross-layer 100×
  corruption for exponent-0 receipts (JPY et al.): server stores `total_minor`
  ×100, web `toInputString(total_minor, 'JPY')` renders it as whole yen.
  Independently corroborated by QA G1. → AM-1.
- **V4 — `visible_categories_clause` has NO archived filter** (read
  `category_access.py`): it is own-or-system only; archived-exclusion is a
  separate predicate. QA G2 is a real gap. → AM-4.

## 3. Rulings

### R1 — G3 (advisory Content-Type coverage): curl-only, ACCEPTED as a decision.
The advisory property is a behavior of MinIO + SigV4 presigning, not of our
code; a mocked-seam pytest "proving" it would assert the fake. TC-S2-7 (PUT
without header lands) + TC-S3-1 (it still parses) own it. Not a plan gap.

### R2 — Claude-dependency test strategy: QA's ruling ADOPTED, PM authorization recorded.
Mock at the `app.state.receipt_parser` seam for all pytest; exactly ONE
guaranteed real Haiku call at S3 /test (TC-S3-1, shape+plausibility asserts,
never exact values), optional 2nd call (TC-S3-10 NOT_A_RECEIPT) at QA
discretion — hard cap 2 live calls/run; VCR cassettes rejected (D10 reasoning).
STOP-rule split: pipeline failure (500 on GET re-validate / stuck processing /
DOWNLOAD_FAILED on present object) = STOP; model-quality miss = recorded
degradation, pipeline still passes. **PM GRANTED the live call** (2026-07-26):
key from env (`ANTHROPIC_API_KEY`, already in api .env locally, never
committed, never CI); photo = any clear local photo/screenshot, worst case a
rendered fake receipt — it tests the pipeline, not OCR quality. TC-S3-8
(live map-precedence) ruled as QA proposed: pytest test 9 authoritative, live
TC best-effort within the call budget.

### R3 — web Q1 (shared schema `merchant` field): APPROVED, optional-additive, frontend-owned.
`z.string().optional()` on `transactionFormSchema` in `packages/shared` —
additive, mobile-frozen-safe (optional key cannot break mobile's
defaultValues typing). Form schemas in shared are frontend-owned by 0.4/1.6
precedent; the senior-lead nod Q1 asked for is hereby given. Input rendered
only in confirm mode.

### R4 — web Q2 (cross-exponent prefill): prefill-and-warn ACCEPTED.
With AM-1 fixed, `toInputString(total_minor, parsed.currency)` is
client/server-consistent for every currency. Residual: a prefilled string in
the parsed currency's decimals may fail `moneyAmountSchema(baseCurrency)`
validation when exponents differ — rare, visibly flagged by the mismatch
banner, and the field is editable. Empty-prefill rejected (punishes the
overwhelming same-currency case). 3.2 closes the window for real.

### R5 — web Q3 (retry granularity): ACCEPTED as planned.
`timedout`/409/failed-status → re-`POST /parse` (object already uploaded);
image-rejection codes (`IMAGE_TOO_LARGE`, decode failure,
`RECEIPT_NOT_UPLOADED`) → restart from downscale.

### R6 — web Q4 (confirm form placement): ACCEPTED — capture modal swaps inline.
`ReceiptCaptureModal` swaps its body from progress to the confirm form
(`TransactionFormModal` confirm mode); `TransactionsPage` manages one modal
variant. Self-contained flow, page stays dumb.

### R7 — the two contract confirm-on-regen asks: CONFIRMED, verified at S2/S4 regen.
(a) `PresignedUpload.headers: dict[str, str]` → OpenAPI
`additionalProperties: {type: string}` → generated `{[key: string]: string}`,
directly assignable to fetch `HeadersInit`, no cast. (b) Pydantic `date` →
`format: date` string, serializes date-only `YYYY-MM-DD` — matches the
`occurred_at` contract. Both get a one-line verification item in the S2 (a)
and S3 (b) /implement reports against the regenerated `schema.d.ts`; if either
generates otherwise, that is a STOP-and-report, not a client cast.

### R8 — S4 review tier: **STANDARD** (the call PM deferred to me).
No external integration, no new auth surface, no money math — an upsert, a
pure normalize function, additive schema fields. The risky DDL already landed
under S1 (FULL). The one security assertion (cross-user receipt_id → 422) is
pinned twice: pytest S4-4 + live TC-S4-3 (byte-identical no-oracle).
**Escalation clause:** if S4's implementation ends up touching category/
receipt authorization logic beyond reusing the existing validated load paths,
it escalates to FULL — the implementing engineer must flag it, not absorb it.

## 4. Binding amendments (folded at the owning subtask's /implement)

### AM-1 (S3, bug — MUST) — `to_minor_units` mirrors the shared exponent table.
`domain/money.py` ports the exception-only exponent table from
`packages/shared/src/currencies.ts` (`CURRENCY_EXPONENTS`, default 2, the 0.4
decision): known exceptions (JPY/KRW/… exponent 0, BHD/… exponent 3) at their
real exponent, unknown/None → 2. The `currency` param becomes live, with a
comment cross-referencing the shared table as the twin source (drift between
the two tables is a recorded risk; QA's TC-S3-1 shape check and the S6
round-trip are the canaries — a generated single-source is 3.2's concern if
multi-currency makes the table load-bearing). Add ONE pytest contrasting an
exponent-0 currency against USD (non-vacuous: different expected minors from
the same string). Closes QA G1: the divergence is NOT accepted — it is fixed.

### AM-2 (S3, poisoned-row risk — MUST) — `ParsedReceipt.total` validates as a decimal.
Validator on `ParsedReceipt.total`: well-formed non-negative decimal string
(parseable by `Decimal`, `.`-separator, no signs/exponents/grouping — align
with the shared `MONEY_INPUT_PATTERN` intent). A malformed model total then
fails Pydantic at parse time → `INVALID_MODEL_OUTPUT` (transient, retryable),
instead of being stored and turning every subsequent GET into a permanent 500
via `_serialize_receipt`. The loud-500-on-drift design (D12) is for schema
drift, not for predictably-dirty model output. Covered by extending plan S3
test 8's parametrization (malformed-total case) — no new test file.

### AM-3 (S1, dependency contradiction — MUST) — `domain/merchant.py` moves to S1.
Plan has S3 importing `normalize_merchant` while S4 (declared parallel-with-
S3) creates it — S3-first ordering would be an ImportError, not the claimed
"empty map". Fix: `domain/merchant.py` + the `TestNormalizeMerchant` pure unit
tests move to **S1** (pure stdlib module, zero risk in the infra subtask).
S3 and S4 both import it in any landing order. S4's file list drops it; S1's
gains it.

### AM-4 (S3, correctness gap — MUST; closes QA G2) — archived filter on the prompt list.
`_load_visible_options` filters `Category.archived.is_(False)` IN ADDITION to
`visible_categories_clause` (verified: the clause alone is own-or-system, no
archived filter). Without this, archived categories leak into the Claude
prompt AND into `visible_ids`, making D6's archived-skip dead code and plan
S3 test 9(b) vacuous. Test 9(b) must seed an archived own category as the map
target and assert it is skipped BECAUSE it is absent from the loaded options
(the contrast QA demanded). The prompt list and `visible_ids` stay one loaded
list (no second query) — D6's design, now with the filter stated.

### AM-5 (S6, cross-layer decode invariant — MUST; from combined-review finding 8, see meta-review.md)
`total_minor` decodes with the PARSED currency's exponent; **null currency →
exponent 2 — NEVER the base currency's exponent**. plan-web's sketched
`toInputString(parsed.total_minor, parsed.currency ?? baseCurrency)` is wrong
under a non-exponent-2 base currency (JPY base: 100x error on null-currency
receipts) because the server encodes null-currency totals at exponent 2.
S6 implements an explicit exponent-2 decode path when `parsed.currency` is null;
`confirmDefaults.test.ts` must contrast a null-currency receipt under a
non-exponent-2 base (non-vacuous both-arms).

### Per-amendment / carry-forward checklist (Phase 4 obligation — /implement reports tick these)

| Item | Owner subtask | Folded where | Verified by |
|---|---|---|---|
| AM-1 exponent table server-side | S3 | domain/money.py + 1 contrast pytest | my diff gate + TC-S3-1 shape |
| AM-2 total decimal validator | S3 | ParsedReceipt validator + test 8 param | my diff gate + pytest |
| AM-3 merchant.py in S1 | S1 (S4 drops it) | S1 files + unit tests | my diff gate |
| AM-4 archived filter + honest 9(b) | S3 | _load_visible_options + test 9(b) seed | my diff gate + pytest |
| D9 advisory Content-Type wording (V1) | S2 | storage.py comment + PresignedUpload docstring | TC-S2-7 live |
| D12 parse-422 anyOf union (V2) | S3 | responses= per plan | TC-S3-11 live |
| Contract ask (a) headers map type | S2 | regen verification line in report | my diff gate on schema.d.ts |
| Contract ask (b) date date-only | S3 | regen verification line in report | my diff gate on schema.d.ts |
| 1.2 carry-forward: receipt_id FK same migration | S1 | migration 0004 | TC-S1-2/S1-6 |
| Contract artifacts regen+commit together | S2/S3/S4 | plan regen steps | TC-S2-8/S3-11/S4-5 |
| PM live-call grant recorded (R2) | S3 /test | qa-checklist PC-D/Q4 | this file |
| AM-5 null-currency decode = exponent 2 | S6 | buildConfirmDefaults + contrast test | senior diff gate + web-qa |

## 5. Review-tier table (FINAL) + execution order

| # | Subtask | Tier | Pipeline | Notes |
|---|---|---|---|---|
| S1 | infra-and-migration | **FULL** | implement → diff gate → QA (TC-S1) → code-reviewer → meta-review | migration + root compose; AM-3 folded |
| S2 | storage-and-receipt-create | **FULL** | full | external storage integration + contract |
| S3 | parse-pipeline | **FULL** | full | Anthropic integration, money path; AM-1/2/4; ≤2 live calls at /test |
| S4 | merchant-learning-and-confirm-fields | **STANDARD** (R8) | implement (+ /review-pr self-review) → diff gate → QA (TC-S4) | escalation clause in R8 |
| S5 | web-upload-and-poll | **STANDARD** | implement (+ /review-pr) → diff gate → web-qa | web-qa checklist written at S5 |
| S6 | web-confirm-prefill | **STANDARD** | implement (+ /review-pr) → diff gate → web-qa | shared-schema edit per R3 |

STANDARD = implementing engineer runs `/review-pr` self-review before
reporting done (senior-lead.md tiers). My diff gate is never skipped at any
tier. Order: **S1 → S2 → S3 → S4 → S5 → S6**; S4 may run parallel with S3
after AM-3 (both only import merchant.py from S1), and S5 needs S3, S6 needs
S4+S5. Practical recommendation: run sequentially — single-engineer runs,
parallelism buys nothing and the S3/S4 contract regens would race on
openapi.json.

## 6. Decisions made this grooming (PM may veto; defaults = what ships)

Confirm = generalized POST /transactions, no /receipts/{id}/confirm (D8);
1:N receipt→tx, no receipt DELETE/LIST, no storage GC (D1/D12, triggers
recorded); parsed re-parse 409; suggestion resolved server-side at parse
completion, map>model>null, stored in parsed_json (D6); always-upsert
learning on create, PATCH does not learn (D7); per-user rate keys
(create 30/min, parse 10/min;100/day); minio-py presign + httpx I/O, bucket
via compose mc-init, ports 9010/9011 (D9); forced tool-use two-tool JSON
(D10); Haiku default via env; claim-token = RETURNING parse_started_at (D5);
polling only, no SSE (0.3 carry-forward honored); web: hand-rolled dropzone,
Query refetchInterval polling with 60s client deadline, TransactionFormModal
third mode, canvas downscale 1500px/0.8 JPEG; S4 tier STANDARD (R8).

## 7. Carry-forwards to future tasks (durable record; each grooming reads this)

- **1.7/deploy (API containerized):** split public/internal S3 endpoint pair
  becomes necessary (presign host consistency, D9). Recorded trigger, not built.
- **3.2 (multi-currency):** closes the foreign-currency confirm gap (D8);
  revisit single-sourcing the currency-exponent table (AM-1 twin-table risk).
- **Second pipeline consumer (scheduler/batch):** extract the background task
  from routers/receipts.py to a services-level orchestrator (D13 trigger).
- **Receipt DELETE / split-by-item / receipts LIST / storage GC:** all
  recorded-not-built (D1/D10/D12); receipt_id index revisit rides the
  1.2/1.4 `transactions.category_id` index trigger (2.5/4.1, EXPLAIN-driven).
- **Merchant fuzzy matching:** trigger = real-world merchant strings too noisy
  for exact normalized match (D4).
- **4.1 (statistics):** `transactions.merchant` feeds топ-мерчанты (if PM
  confirms store — open Q1).
- **QA opt-in real-MinIO integration module:** if written later, IT adds its
  own TEST_S3_*/skip-env and the turbo env line (plan.md turbo note).

## 8. Open questions for PM (veto-style; defaults = recommendations, none block S1)

1. **Store `transactions.merchant` (architect Open-Q1 — the one live fork).**
   Both plans assume STORE per the architect's recommendation; I CONCUR:
   auditable learning pairs, stage-4 топ-мерчанты needs it (JSONB-mining
   receipts misses manual entries), one nullable column in a migration we
   write anyway. Veto before S1 ⇒ column drops from 0004 + model; learning
   still works off the request field; S4 read-echo test adjusts.
2. Remaining architect Open-Q2–Q7 are implemented at their recommended
   defaults and were not re-litigated by any engineer: re-parse 409; PATCH
   does not learn; Haiku default (env-swap to Sonnet); foreign-currency
   deferred to 3.2 with web warning; no per-receipt retry cap (100/day is the
   spend guard); one-transaction-per-receipt (items display-only). Veto any
   individually; each is a small, localized change.

## 9. Ready state

Scope groomed. S1 is ready for /implement on PM's go (with open Q1 answered
or defaulted to STORE). Each subtask's /implement report must tick the §4
checklist rows it owns plus its plan-section obligations row by row (1.2
report precedent). PLAN.md stage-2 statuses flip per subtask as they land.

## PM product amendment (2026-07-28, binding for S5/S6)

After upload the user chooses one of TWO actions (not auto-parse):
1. **"Сохранить"** — receipt stored as-is, NO parse call; it can be attached to a
   manually created transaction via the existing receipt_id field. No Claude cost.
2. **"Распознать (AI)"** — the existing flow: POST /parse → poll → prefilled confirm form.
Backend already supports both (parse is a separate explicit endpoint); this is a UI-flow
requirement for S5 (two actions) and S6 (confirm form only on the AI path). A saved-but-
unparsed receipt must be visible/linkable when creating a transaction manually.
