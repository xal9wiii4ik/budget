# Grooming Review (Phase 4) — transactions-api (roadmap 1.4)

Senior-lead critical review of plan.md (backend, 5 endpoints, decisions a–n),
qa-checklist.md (qa-engineer, 30 checks: PC-1..4 + TC-1..25 + TC-Z1, five
uncertainties U1–U5), contract-review-web.md (frontend, ACCEPT with 2
substantive findings and 10 durable 1.6 obligations, one non-blocking
recommendation). Verdict: **accepted with the rulings and amendments below.**
No artifact goes back for rewrite; plan deltas fold at /implement, checklist
deltas fold before /test.

## 1. Team selection (recorded)

backend-engineer (all apps/api changes: router, schemas, enums.py,
category_access.py extraction, tests, contract regeneration) + qa-engineer
(endpoints → curl checklist mandatory) + frontend-engineer in the narrow
review-only role (1.6 is the direct consumer; the review returned ACCEPT but
produced two load-bearing findings — the archived-inclusive summary join /
composite (category_id, kind) key, and the 422 dual-shape type-dishonesty that
became AM-5 — it paid for itself a third time). **architect NOT invoked**,
justified: no new tables, no new modules, no dependency-direction change. The
task brief's domain-boundary question for the first aggregate is answered by
recorded precedent, not by new structure: the 1.2 grooming pinned
extraction-at-second-consumer (no speculative repository/domain layer), and
`domain/` is defined as *pure* logic (architecture §4) — a GROUP BY is a query,
not pure logic, and `services/` is for external integrations. **Precedent set
(PM-vetoable, §9 Q1): aggregate SQL lives with its router at the first
consumer; 4.1 (six aggregates, the second+ consumer) extracts, and THAT task
takes the architect look with real usage to design against.**
mobile-engineer / web-qa / mobile-qa NOT invoked: no client code, no UI.
code-reviewer arrives at /review_senior (PM pre-decision: that stage RUNS for
this task — transactions are the core domain).

Process note: backend planned first (plan.md is the oracle); my gate review ran
BEFORE the QA/frontend fan-out and produced AM-1..AM-4, so both downstream
artifacts were written against the amended state (verified: QA's binding-
amendments header covers all four incl. the TC-4 AM-4 pin; the contract
review's item 11 addresses AM-4). QA and frontend then ran in parallel — safe
because they consume the contract, not each other.

## 2. Cross-check results

- **plan ↔ qa-checklist**: every endpoint, decision, and error code has a live
  check; the division-of-labor section correctly declines to duplicate pytest
  (ownership internals, self-heal branch, model_fields_set mechanics) while
  owning the Pydantic-layer wire rejections pytest excludes (note>500, bad
  kind/date/month, limit/offset bounds — the 1.3 split applied correctly). The
  string-vs-array envelope contrast is called out as itself the contract,
  consistent with the contract review's item 6. TC-20's summary numbers
  (refund/uncategorized/other-month) mirror pytest test 14 exactly — the
  documented overlap is deliberate and endorsed (first aggregate, worth a live
  wire pin). One gap found: decision g (future dates allowed) had NO pin in
  either layer → AM-7. QA's five uncertainties are ruled in §3.
- **plan ↔ contract review**: all eleven surfaces ACCEPT. The subtlest plan
  decisions are validated by their actual consumer against the live generated
  artifact (`from` as an object key; TransactionKind assignability direction
  incl. the stage-5 widening; JSON.stringify-drops-undefined PATCH discipline).
  The one substantive contract delta it recommends (422 union) is ruled AM-5.
  Its 10 obligations are recorded as durable 1.6 carry-forwards in §7.
- **qa ↔ contract review**: consistent on every shared surface (envelope
  shapes, byte-identity semantics, separate-enum-component check TC-24d ↔
  item 5, AM-4 TC-4 ↔ item 11).
- **Conflicts**: none requiring arbitration.

## 3. Rulings

### R1 — 422 dual-shape on POST/PATCH (contract review's recommendation; PM lean: accept). RULED: ACCEPT — AM-5.

The finding is real and verified: the plan's `_UNPROCESSABLE = {422: {"model":
TransactionError}}` suppresses FastAPI's auto `HTTPValidationError` for that
status, so the generated POST/PATCH 422 type claims `{detail: string}` while
the runtime also emits the Pydantic array (ge=1, bad enum, bad date, note cap).
The generated type lies about one runtime arm. Fix is cheap and the schema
stops lying; stage-4 endpoints will copy whichever pattern ships, so ship the
honest one. **Mechanics pinned (binding on /implement):** do NOT hand-declare a
Pydantic model named `HTTPValidationError` (component-name collision → mangled
`budget_api__…__HTTPValidationError` names in the schema). Instead declare the
union as a raw content schema in the shared responses constant:

```python
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {"application/json": {"schema": {"anyOf": [
            {"$ref": "#/components/schemas/TransactionError"},
            {"$ref": "#/components/schemas/HTTPValidationError"},
        ]}}},
    }
}
```

The `$ref` cannot dangle: the `HTTPValidationError` component already exists in
the committed schema (generated by existing parameterized routes; verified at
schema.d.ts:303) and the new GET list/summary routes keep generating it.
`TransactionError` must still be referenced by a real model somewhere so its
component is emitted — the 404 responses (`_NOT_FOUND`) keep `{"model":
TransactionError}`, which guarantees it. Diff-gate item: I verify the anyOf
appears on POST/PATCH 422 in the regenerated openapi.json and that both
components exist unmangled. QA TC-24 gains one jq check (AM-5 delta); frontend
obligation 6 stands unchanged — the runtime narrow is still required (a union
type does not narrow itself).

### R2 — QA uncertainties U1–U5. RULED in writing.

- **U1 (/test BASE port, server ownership):** 8010 stands; QA starts uvicorn
  exactly as written in the preconditions (mirror 1.3). If the PM provides a
  running server at /test, QA adjusts BASE only — no checklist change needed.
- **U2 (501-spaces → 201 curl):** NOT added — correct call. Strip-before-cap is
  a validator-internal ordering whose two observable behaviors are already
  pinned (whitespace-only → null TC-8; >500 non-space → 422 TC-8). A third curl
  would re-prove the same normalization — vacuous per the test policy.
- **U3 (month `2026-00`; regex-vs-parse — must never 500):** RULED BINDING: the
  `Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")` regex from the plan skeleton is
  the contract, and validation MUST happen at the Pydantic/Query layer BEFORE
  any `date()` construction. `2026-00`, `2026-13`, garbage → Pydantic array
  422, never a 500 from `date(year, 0, 1)`. An implementation that parses
  instead of pattern-matching is a diff-gate rejection. TC-22 stays exactly as
  written, `2026-00` included. (AM-6)
- **U4 (same-commit check degradation):** ACCEPTED, mirror 1.3 — if no commit
  exists at /test, TC-24c degrades to the working-tree "both artifacts modified
  together" check; the strict same-commit property is re-verified by me at the
  final commit gate (orchestrator reviews the commit anyway).
- **U5 (/summary route-ordering):** confirmed a non-finding today (no
  `GET /{transaction_id}` exists — different methods don't collide); the
  defensive declaration order stands and the trap is recorded against the
  decision-m future trigger. TC-22's reachability check is the live proof.

### R3 — (my cross-check) decision g had zero pins. AM-7.

"Future dates allowed" is a deliberate decision a well-meaning future guard
could silently reverse, and neither pytest nor curl exercised it. One curl
line: POST with `occurred_at: "2030-01-01"` → 201 (fold into TC-7 as the
allowed-contrast case). No pytest — the wire pin is enough for a
no-custom-logic pass-through.

### R4 — (my gate, pre-fan-out, recorded) AM-1..AM-4.

See §4. AM-1 caught a vacuous-fallback pytest claim (test 15 asserted the RUB
fallback on a user who HAS a profile — the branch never ran); AM-4 caught a
missing decision (unknown-body-field policy) and turned the silent default into
documented, QA-pinned behavior.

## 4. Amendments (binding)

- **AM-1** — pytest test 15 rewritten: delete the caller's `profiles` row, GET
  summary → 200/zeros/`currency=="RUB"`, AND assert no profile row was created
  by the GET (pins the read-only fallback branch for real, plus the
  write-on-GET asymmetry which otherwise had zero coverage). Plan folds at
  /implement.
- **AM-2** — profile get-or-create PK race (two concurrent first-POSTs → dup-PK
  IntegrityError 500) accepted in writing as a single-user-app tradeoff (AM-5
  @1.3 pattern). Revisit trigger: `ON CONFLICT DO NOTHING` + re-select if real
  multi-user concurrency appears. Recorded, not built.
- **AM-3** — `category_access.py` skeleton missing `select` import; fold at
  /implement.
- **AM-4** — unknown body fields silently ignored (Pydantic default, no
  `extra="forbid"`): DECIDED behavior, wire-pinned by TC-4 (`"currency":"USD"`
  → 201, currency RUB). Closed by stage 3.2 when currency becomes a real field.
- **AM-5** — POST/PATCH 422 declared as `anyOf[TransactionError,
  HTTPValidationError]` via raw content schema (R1 mechanics — no hand-declared
  HTTPValidationError model). Plan folds at /implement; QA TC-24 gains the
  anyOf jq check; my diff gate verifies the regenerated schema.
- **AM-6** — month param validated by the pinned regex at the Query layer,
  never by parsing; malformed month can never 500 (R2/U3). Diff-gate item.
- **AM-7** — future-date acceptance pinned: one curl in TC-7 (POST
  `occurred_at: "2030-01-01"` → 201). Checklist folds before /test.

## 5. Per-amendment / carry-forward checklist (Phase 4 obligation)

| Binding item | Source | In plan.md | In qa-checklist.md | Verdict |
|---|---|---|---|---|
| visible-categories query EXTRACTED (2nd consumer) + categories.py refactored, same task | 1.2/1.3 §7 | ✓ `category_access.py` + refactor plan; existing test_categories.py is the guard | ✓ TC-25 smoke + TC-Z1 | covered |
| write-path category authz (load visible, system-or-own) pytest-covered | 1.2 §7 (MUST) | ✓ tests 3, 10 | ✓ TC-9/TC-13b live byte-identity | covered |
| required `kind` on tx schemas; tx.kind = sign authority; cross-kind allowed (refunds) | 1.2 §7 | ✓ schemas + decision f | ✓ TC-20 refund scenario | covered |
| summary via CASE aggregate | arch §1 | ✓ SQL sketch | ✓ TC-20 live numbers | covered |
| zero-amount API policy (deferred from 1.2) | 1.2 §7 | ✓ decision h, ge=1 + test 6 (R6-analogue keep) | ✓ TC-5 wire shape | covered |
| note length cap | 1.2 §7 | ✓ decision i (500, strip, empty→None) | ✓ TC-8 | covered |
| profile get-or-create at first profile read | 1.2 §6 | ✓ POST-only helper, GET read-only fallback + AM-1 test | ✓ TC-21 wire value (pytest owns the rest) | covered |
| contract artifacts regenerate/commit together | standing | ✓ exact `pnpm openapi` commands + drift gates | ✓ TC-23/24 (incl. same-commit, U4 degradation ruled) | covered |
| local PG 5443 via TEST_DATABASE_URL (committed 5433 foreign) | standing | ✓ standing-infra section (no Makefile — verified, `pnpm --filter @budget/api test`) | ✓ preconditions + STOP rules | covered |
| root-file ownership = backend; none expected | standing | ✓ stop-and-escalate clause | n/a | covered |
| FULL lint gate incl. `ruff format --check` on ANY fix round | 1.3 retro (standing) | ✓ restated in standing-infra | n/a (/implement report obligation) | covered; /implement report MUST show the full gate on every round |
| per-amendment checklist in /implement report | standing | ✓ obligation restated | ✓ summary gates table | covered; /implement ticks AM-1..AM-7 + this table row by row |
| AM-1/AM-3/AM-5 (plan deltas) | this review | → fold at /implement | AM-5 → TC-24 jq check | fold at /implement |
| AM-6 (regex-not-parse) | this review | → fold at /implement | ✓ TC-22 already exact | diff-gate item |
| AM-7 (future-date pin) | this review | n/a (no pytest) | → fold into TC-7 before /test | fold before /test |

## 6. Risky spots — my own verification (not delegated)

1. **Plan's repo claims re-verified**: no Makefile (confirmed); `pnpm openapi`
   → root turbo `generate` + `@budget/api#openapi` script (package.json:12 /
   apps/api package.json:9); app.py:58 categories mount with the
   no-prime_rate_limit comment — the transactions mount mirrors a real pattern;
   `make_client`/`client`/`db_session` fixtures at conftest.py:130/153/160;
   committed DEFAULT_TEST_DATABASE_URL is 5433 (foreign), 5443 env-only.
2. **CHECK byte-identity target confirmed**: `models/transaction.py:31` today
   hardcodes `"kind IN ('expense', 'income')"`; the enum-rebuilt f-string with
   definition order (expense, income) reproduces it exactly. Diff-gate item: I
   compare the rendered string; `alembic check` is the mechanical backstop
   (same discipline that held at 1.3).
3. **AM-5 $ref safety verified**: `HTTPValidationError` exists as a component
   in the committed schema.d.ts (:303) — generated by existing routes with
   params; the anyOf $ref cannot dangle. `TransactionError`'s component
   emission is guaranteed by the 404 `{"model": ...}` declarations.
4. **Contract review's shared-package claims verified in source**: `formatMoney`
   → `assertSafeMinor` (money.ts:137 — negatives legitimate);
   `toInputString` → `assertNonNegativeMinor` (money.ts:160 — throws on
   negatives). Obligation 4's trap is real, not inferred. `drift.test.ts`
   exists in packages/api-client/src (TC-24b's command is runnable).
5. **No-oracle structure is by construction**: `_load_own` filters
   `user_id = me` (tx 404); `load_visible_category` filters visible (category
   422) — cross-user and missing take the same code path in both cases;
   tests 3/7/11 + TC-9/14/15 are regression guards, not the mechanism.
6. **Two-query summary consistency**: totals and breakdown run in one session
   on sequential awaits — a write between them could skew one vs the other in
   theory; unreachable single-user, and both queries share the same WHERE. Not
   worth a CTE merge now; 4.1's extraction folds them if it ever matters.
   Recorded so the reviewer doesn't flag it as a miss.
7. **Profile fallback duplication**: summary's read-only fallback uses
   `DEFAULT_BASE_CURRENCY` — the same constant the register hook and helper
   use (models/profile.py:17, single definition). No literal duplication.

## 7. Carry-forwards to future tasks (durable record; each grooming reads this)

- **1.6 (web: transactions + categories UI)** — from contract-review-web.md,
  ALL TEN obligations are 1.6 scope (its grooming MUST read that file's
  obligations section in full; they compose with the eight 1.3 category
  obligations, still in force). Highlights the PM asked verified as recorded:
  **obligation 3 — the summary join targets the `include_archived=true`
  category set** (a since-archived category still owns historical buckets;
  the default 1.3 cache would render "unknown") **and breakdown rows key on
  the composite `${category_id ?? 'uncategorized'}:${kind}`** (the refund case
  repeats a category_id under both kinds; category_id alone collides). Both
  recorded. Also: month-list paging via limit=200/offset (obl. 1), `from` as
  object key + toApiDate (obl. 2), signed net via formatMoney / never
  toInputString (obl. 4), no Kind alias across the two enums (obl. 5),
  getErrorCode extension + 422 runtime narrow `string | ValidationError[]`
  even with the AM-5 union type (obl. 6), PATCH body builder (obl. 7), no
  currency in forms (obl. 8), query keys + invalidate list AND affected-month
  summary after every mutation (obl. 9), month-string/datetime helper gap —
  propose shared helper at 1.6, don't open-code (obl. 10).
- **4.1 (statistics)**: extraction point for aggregate SQL (the decision-k
  precedent) — architect look happens THERE; fold the two summary queries into
  one grouping-set query if profiling ever cares; revisit
  `transactions.category_id` index (1.2 trigger stands).
- **2.1 (receipts)**: `transactions.receipt_id` FK arrives with the receipts
  table (1.2 trigger stands); transaction DELETE stays real — receipt FK
  direction doesn't block it (decision a reasoning).
- **Future trigger — `GET /transactions/{id}`**: add when 2.2's confirm flow or
  a 1.6/1.8 deep-link needs an out-of-cache single row; `/summary` MUST stay
  declared before it (U5 / Risks).
- **Future trigger — second profile-reading consumer extracts
  `_get_or_create_profile`** out of routers/transactions.py (first-consumer
  rule, recorded in plan).
- **Future trigger — AM-2 race**: real multi-user concurrency → ON CONFLICT
  DO NOTHING + re-select.
- **Stage 3.2**: optional `currency` field added to create (additive); summary
  becomes conversion-aware; AM-4's silent-ignore window closes.
- **Stage 5 (transfers)**: third value lands in `TransactionKind` ONLY —
  the separate-enum decision (c) exists for this; TC-24d guards the
  components stay separate until then.

## 8. Decisions made this grooming (PM may veto, no answer required)

Real DELETE 204 (leaf rows; no archive); limit/offset + `{items, total}`
envelope (50 default / 200 max); separate `TransactionKind` StrEnum (stage-5
divergence-proof) with CHECK rebuilt byte-identical; server-stamped
`profile.base_currency`, no currency on the wire in, currency in Read; body
category miss = 422 `CATEGORY_NOT_FOUND` byte-identical foreign-vs-missing,
archived target = 422 `CATEGORY_ARCHIVED`, category validated only when in the
PATCH field set; kind mismatch allowed (refunds; 1.2 ruling recorded, not
reopened); any `occurred_at` incl. future (AM-7 pin); `amount_minor ge=1` at
the contract (DB stays >=0); note ≤500 after strip, empty→None; summary
`GET /transactions/summary?month=YYYY-MM` returning totals + signed net +
by_category reference-by-id with NULL uncategorized bucket, zeros for empty
month, ordered kind then total DESC; summary SQL in the router (4.1 extracts —
the stage-4 precedent); read filters never error (foreign category filter and
from>to → empty 200); ORDER BY occurred_at DESC, created_at DESC, id; single
shared TransactionRead; no `GET /{id}`; no rate limiting; POST-only profile
self-heal, read-only GET fallback; AM-4 silent-ignore of unknown body fields;
AM-5 honest 422 union; no root-file edits; contract artifacts same-commit.

## 9. Open questions for the PM (veto-style; defaults = recommendations, none blocking)

1. **Architect skipped; aggregate-SQL-in-router precedent for stage 4.**
   Recommend **as ruled** (first-consumer rule; architect joins at 4.1's
   extraction with real usage). Veto = architect reviews the boundary now,
   before /implement.
2. **Body category miss = 422 vs 404 (plan decision e).** Recommend **422
   `CATEGORY_NOT_FOUND`** — 404 on POST /transactions misleads about the
   addressed resource; byte-identity preserves the no-oracle either way. Veto =
   404 to match the categories PATH-id precedent.
3. **`from > to` and foreign category filter return empty vs 422.** Recommend
   **empty 200** (read filters never error; self-evidencing). Veto = add
   `INVALID_PERIOD` + a code, an existence check, and two tests.
4. **AM-4: unknown body fields silently ignored vs `extra="forbid"`.**
   Recommend **silent-ignore** (Pydantic default, consistent with every
   existing schema; the generated client physically can't send unknown fields —
   verified closed types). Veto = forbid on transaction schemas only, accepting
   the idiom split with categories.
5. **AM-5: 422 anyOf union vs plan-as-written (`TransactionError` only).**
   Recommend **union** (PM lean concurred; schema stops lying, stage 4 copies
   the honest pattern, client unaffected). Veto = ship as written; frontend
   obligation 6 already makes the client robust to either.
6. **`limit` 50/200, note cap 500, by_category order (kind, total DESC).**
   Recommend as stated — pure tuning knobs, cheap to change now, contract-baked
   after 1.6 ships.

No blocking questions. Ready for /implement on PM's go: backend implements
plan.md + AM-1/AM-3/AM-5/AM-6 folds (16 pytest tests incl. the AM-1 rewrite);
QA folds AM-5's TC-24 jq check and AM-7's TC-7 line before /test; /test runs
TC-1..25 + TC-Z1 on :5443/8010 per R2; /review_senior runs after QA (PM
pre-decision); every fix round re-runs the FULL lint gate incl.
`ruff format --check` (1.3 retro rule); /implement report ticks §5 row by row.
