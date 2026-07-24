# Senior Code Review — transactions-api (roadmap 1.4)

Reviewer: code-reviewer (/review_senior full-diff pass)
Scope: uncommitted working tree vs HEAD 044cd2b.
Artifacts read first: plan.md (decisions a–n), grooming-review.md (R1–R4, AM-1..AM-7, §6).

Files reviewed: `apps/api/src/budget_api/{enums.py, models/transaction.py, category_access.py, schemas/transaction.py, routers/transactions.py, routers/categories.py, app.py}`, `apps/api/tests/test_transactions.py`, `apps/api/openapi.json`, `packages/api-client/src/generated/schema.d.ts` (generated — correspondence only), plus `PLAN.md` (status flip, see note).

## Verdicts per checklist area

### 1. Plan conformance (decisions a–n) — PASS

Verified item by item against the working tree:

- **a (real DELETE, 204):** `routers/transactions.py:345-363` — `status_code=204`, `response_model=None`, real `session.delete`, 404 via user-scoped `_load_own` (one path for foreign/missing).
- **b (limit/offset + envelope):** `:174-175` `Query(default=50, ge=1, le=200)` / `Query(default=0, ge=0)`; `TransactionList {items, total}` at `schemas/transaction.py:78-82`. Confirmed in openapi (`limit` max 200 min 1, default 50).
- **c (separate `TransactionKind`, CHECK rebuilt byte-identical):** `enums.py` adds the enum with the load-bearing order comment; `models/transaction.py:31` `_KIND_VALUES = ", ".join(f"'{k.value}'" for k in TransactionKind)` → I executed the expression: renders exactly `kind IN ('expense', 'income')` — byte-identical to migration 0002. `kind: Mapped[str]` (`String(16)`) unchanged. No migration edit. openapi has a **separate** `TransactionKind` component (`CategoryKind` untouched).
- **d (no currency on the wire in; stamped from profile; in Read):** `TransactionCreate`/`TransactionUpdate` have no `currency` field (`schemas/transaction.py:48-75`); POST stamps `profile.base_currency` (`transactions.py:152-157`); `TransactionRead.currency` present.
- **e (visible-or-422; archived reject; PATCH validates only when in field set; null clears):** `_validate_category` (`:105-125`) — load-visible → `None` ⇒ 422 `CATEGORY_NOT_FOUND`, then `archived` ⇒ 422 `CATEGORY_ARCHIVED`; order preserves the existence oracle (foreign archived → NOT_FOUND). PATCH guard `:323-324` — `"category_id" in fields and payload.category_id is not None`. Null-clear applied unguarded at `:335-336`.
- **f (kind mismatch allowed):** no cross-check anywhere in the router; refund exercised in test 14.
- **g (any date incl. future):** no date restriction in schemas or router. (Pin is AM-7 curl, correctly not pytest.)
- **h (`ge=1` at contract, DB stays `>=0`):** `schemas/transaction.py:50,66`; model CHECK `amount_minor >= 0` untouched. Test 6 pins.
- **i (note ≤500 after strip, empty→None):** `_clean_note` (`:24-32`) strips first, empty→None, cap after strip; shared by create and update validators — normalization is identical on both paths by construction.
- **j (summary shape):** regex-only `month` (`:46`, `:212`), `SummaryRead`/`CategorySummary` exactly per plan incl. nullable `category_id` bucket; signed `net_minor` (`:255`); `by_category` ordered `kind, total DESC` (`:264`); empty month returns zeros via `coalesce` + empty group list, never 404.
- **k (summary SQL in router):** both queries inline in `summary()`; no `domain/`/`services/` created.
- **l (filters/ordering/shared DTO):** inclusive `>= from` / `<= to` (`:183,185`); single `category_id`; `kind`; no `from>to` validation; no existence check on the read filter; `ORDER BY occurred_at DESC, created_at DESC, id` (`:198-202`); list reuses `TransactionRead`.
- **m (no `GET /{id}`):** confirmed — only PATCH/DELETE on `/{transaction_id}`; `/summary` declared before them defensively (`:210`).
- **n (no rate limiting):** `app.py:59-64` mounts without `Depends(prime_rate_limit)`, comment mirrors the categories mount.

Route declaration order is POST, GET list, GET /summary, PATCH, DELETE — as planned.

### 2. Amendment conformance — PASS

- **AM-1:** test 15 (`test_transactions.py:431-457`) deletes the caller's `profiles` row, GETs summary, asserts 200/zeros/`currency=="RUB"`, **and** asserts the profiles row still absent after the GET (`:454-457`) — the fallback branch actually runs and the no-write-on-GET asymmetry is pinned. Exactly the AM-1 rewrite.
- **AM-3:** `category_access.py:12` imports `select`. Module compiles as specified.
- **AM-5:** `_UNPROCESSABLE` (`transactions.py:60-74`) declares the raw content-schema `anyOf` union; no hand-declared `HTTPValidationError` model anywhere. Verified in the regenerated `openapi.json`: POST and PATCH 422 both carry `anyOf[$ref TransactionError, $ref HTTPValidationError]`; both components exist unmangled (no `budget_api__...` prefix); `TransactionError` component emitted via the 404 `{"model": ...}` declarations. `schema.d.ts` renders the union as `TransactionError | HTTPValidationError` on both operations.
- **AM-6:** `month` is validated **only** by `Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")` (`:46`, `:212`); `int(month[:4])`/`int(month[5:7])` and `date()` run strictly after the pattern has guaranteed validity (`:218-220`). No parse-based validation path exists; `2026-00`/`2026-13` die at the Query layer and can never reach `date()`.
- (AM-2, AM-4, AM-7 require no code: verified nothing contradicts them — no `ON CONFLICT` machinery, no `extra="forbid"` on transaction schemas, no future-date guard.)

### 3. Security — PASS

Every query is user-scoped; checked each one individually:

- List: `filters` starts with `Transaction.user_id == user.id` (`:181`) and **the same `filters` list object** feeds both the count (`:191-193`) and the rows query (`:194-206`) — the two WHEREs cannot diverge.
- Summary: the shared `period` tuple (`:221-225`) includes `user_id == user.id` and feeds **both** the totals query (`:253`) and the breakdown (`:262`) — same guarantee.
- `_load_own` (`:128-136`) filters `user_id == user_id`; PATCH (`:297`) and DELETE (`:357`) both go through it — cross-user and missing take one code path → one 404 body.
- POST: `user_id=user.id` forced (`:154`); neither schema carries `user_id` (and test 1 asserts it's not in the DTO and is forced in the DB).
- Category body ref: `load_visible_category` returns `None` for foreign and missing alike (single query, `category_access.py:32-36`) → single 422 `CATEGORY_NOT_FOUND`; archived check only after visibility, so a foreign archived category never leaks `CATEGORY_ARCHIVED`.
- Error bodies carry only stable UPPER_SNAKE codes — no ids, no existence hints.

### 4. Correctness — PASS

- **Money stays int:** `amount_minor: int` end-to-end; `BigInteger` column; `func.sum` over an integer column returns Python `int` via asyncpg; `coalesce(..., 0)` int; `net_minor = income - expense` int arithmetic. No float or Decimal anywhere in the diff. (The `minimum: 1.0` in openapi is Pydantic's JSON-Schema rendering of `ge=1`, generated output, not a runtime float.)
- **Month bounds:** half-open `[month_start, next_month_start)` (`:223-224`); rollover `date(year + (mon == 12), (mon % 12) + 1, 1)` — December: `year+1`, month `1`; all other months: same year, `mon+1`. Correct.
- **PATCH field-set mechanics:** null on NOT NULL columns → `*_REQUIRED` 422 before any apply (`:306-318`); nullable columns clear on explicit null (`:335-338`); omitted fields untouched (every apply gated on `in fields`). The `assert ... is not None  # 422-guarded above` narrowing comments are the exact categories.py idiom (categories.py:178-201).
- **Note normalization:** one `_clean_note` shared by both schemas — create and update cannot drift.
- **Count/rows duplication risk:** none — single shared `filters` list (see §3).

### 5. Code quality — PASS

Idioms match categories.py precisely: module docstring stating the authorization pillars, `_serialize` helper, `_NOT_FOUND`-style responses constants with the same `dict[int | str, dict[str, object]]` annotation, `status.HTTP_422_UNPROCESSABLE_CONTENT` constant (same as categories.py:156), UPPER_SNAKE detail codes, assert-narrowing comments. The categories refactor is complete and non-behavioral: HEAD had exactly two visibility sites (`_load_visible` at old :57-68 + inline `or_` at old :107) and both now route through `category_access` (:97, :142); `or_` dropped from the categories imports (no dangling import); `_load_visible` dropped rather than aliased, per the plan's stated lean; docstring updated to name the extraction. No dead code, no unused imports found in any new file. `category_access.py` placement/docstring match the plan's neutral-module rationale.

### 6. Tests — PASS (one minor finding)

All 16 planned tests present, names matching the plan. Spot-checks:

- **Test 3** (`:116-147`): userB POSTs with userA's category id AND a random uuid; asserts both 422 and `foreign.json() == missing.json() == {"detail": "CATEGORY_NOT_FOUND"}` — asserts exactly the claimed cross-user-authz + no-oracle identity. (JSON-equality rather than raw-bytes comparison is the standing categories idiom — test_categories.py:201 — not a deviation.)
- **Test 7** (`:188-207`): cross-user PATCH + random-uuid PATCH → both 404, identical body. As claimed.
- **Test 10** (`:256-277`): (a) archives the category *after* the tx exists, amount-only PATCH → 200 (pins the field-set guard — the decision-e trap); (b) repoint to a foreign uuid → 422 `CATEGORY_NOT_FOUND`. Both arms real.
- **Test 14** (`:376-429`): refund (income on the same expense category) counted in `income_minor` not netted; `expense_minor == 1500` proves the April row is excluded (it would also corrupt the `(None, "expense")` bucket, doubly pinned); `net_minor == -1200` proves signedness; buckets keyed on the composite `(category_id, kind)` — the same key 1.6 is obligated to use. The strongest test in the file and it earns its claims.
- **Test 15** (`:431-457`): see AM-1 above — the fallback branch genuinely runs (profile deleted first), and the no-write pin is asserted. Not vacuous.
- No vacuous tests found; no plan-mandated test missing. The exclusion list (pure-Pydantic rejections → QA curl) matches the grooming split.

### 7. Contract — PASS

Structural diff of `openapi.json` vs HEAD: **zero** changes to existing paths and existing components; additions are exactly `/transactions`, `/transactions/summary`, `/transactions/{transaction_id}` + 8 new components (`CategorySummary`, `SummaryRead`, `TransactionCreate`, `TransactionError`, `TransactionKind`, `TransactionList`, `TransactionRead`, `TransactionUpdate`). Response maps match the plan table (POST 201/422-union; list 200 + auto-array-422; summary 200 + auto-array-422 with the pinned month pattern, `month` required; PATCH 200/404/422-union; DELETE 204/404 — the extra auto-422 on DELETE is FastAPI's standard path-param validation response, present on categories PATCH too, not a deviation). `schema.d.ts` corresponds: all three paths, the 422 unions, separate `"expense" | "income"` `TransactionKind` component, `TransactionUpdate` all-optional-nullable, `TransactionRead.category_id/note` `| null`. No unintended drift.

## Findings

1. **[minor] apps/api/tests/test_transactions.py:340-354 — the "inclusive bounds" claim in `test_list_filters_period_category_kind` is not actually pinned at the boundary.** The in-range row sits at `2026-02-05`, strictly inside `from=2026-02-01`/`to=2026-02-28`; a regression from `>=`/`<=` to strict `>`/`<` (decision l says inclusive) would still pass this test — the inclusivity the test names is never contrasted. Suggested fix: move the boundary rows onto the edges (e.g. one tx at exactly `2026-02-01` and one at exactly `2026-02-28`, with out-of-range neighbors at `2026-01-31`/`2026-03-01`) so the inclusive semantics go red if loosened. One-line data change, no new test needed.

2. **[nit] PLAN.md:18 — root `PLAN.md` status flip (⬜ → 🔄 for 1.4) is in the working tree but outside the declared review scope / plan's files-to-modify list.** The plan's standing-infra section says no root-file edits expected with stop-and-escalate. This is orchestration bookkeeping, not a code change, and clearly intentional — recording it so the commit gate includes it deliberately (and flips it to ✅ at close), not by accident.

## Verdict: APPROVE-WITH-NITS

The implementation is a faithful, line-for-line discharge of plan decisions a–n and amendments AM-1/AM-3/AM-5/AM-6, with the AM-5 union and AM-6 regex-only month validation verified in both the router source and the regenerated contract artifacts, the CHECK rebuild verified byte-identical to migration 0002 by executing the expression, and the categories extraction confirmed complete and non-behavioral (both HEAD visibility sites moved, no leftover `or_`/`_load_visible`). Security scoping is structural on every one of the six queries, count/rows and totals/breakdown WHERE-divergence is impossible by construction (shared `filters`/`period` objects), and money is integer end-to-end. The only substantive gap is a test that names inclusive date bounds but never exercises the boundary (finding 1) — a one-line fixture tweak, not a code defect; nothing blocks merge.
