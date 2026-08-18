# Code review — B3 /limits (scope recurring-and-limits, tier FULL)

Reviewer: code-reviewer · Diff: uncommitted on top of HEAD c849018 · Files:
`routers/limits.py`, `schemas/limit.py`, `tests/test_limits.py`, `app.py`
(mount), regenerated contract artifacts (not re-reviewed line-by-line;
additive-only already gate-verified).

## What was verified (money-honesty surface)

- **GET fold single-sourcing (D16).** The handler computes no aggregation of its
  own: `read_base_currency` → `month_bounds` → `services/tx_totals.converted_totals`
  — the identical call chain `/transactions/summary` and `/stats` ride. `spent_minor`
  reads `by_bucket[(category_id, TransactionKind.expense.value)]`, which matches
  the `Bucket` key type (`uuid.UUID | None`, kind wire-string) exactly as
  `tx_totals` itself builds and compares it, so a drift from /stats for the same
  month is structurally impossible — both read the same dict. Income rows are a
  different bucket key, never an offset. `unconverted_count` is the period-level
  counter straight off `ConvertedTotals`, not recomputed.
- **OQ-4 / D15 stamp semantics.** The stored `amount_minor`/`currency` are never
  touched on any read path: GET copies `row.amount_minor` / `row.currency`
  verbatim into `limit_minor` / `limit_currency` and separately reports the
  CURRENT base as `LimitsRead.currency`; no conversion call exists anywhere in
  the router for limit amounts. The re-stamp is confined to the PUT upsert
  (`values(currency=base)` + `set_={"currency": base}`), stamped from
  `read_base_currency` — the read-only profile read (no self-heal; profile-less
  user stamps the RUB default, consistent with the write-path default).
  Test B3-2 contrasts both halves (mismatch surfaced, rewrite re-stamps) in one test.
- **No-oracle.** PUT resolves foreign and missing via ONE code path
  (`load_visible_category` → `None` → 404 `CATEGORY_NOT_FOUND`), so a foreign
  *archived* category is 404, never 422 — guard order preserves the oracle.
  DELETE's user-scoped load gives byte-identical 404 `LIMIT_NOT_FOUND` for
  missing and foreign; test B3-5 asserts `foreign.content == again.content` AND
  that the foreign row survived (refusal, not a laundered cross-user delete).
  No route path leaks existence pre-auth (auth dependency present on all three).
- **Upsert.** `pg_insert(...).on_conflict_do_update(index_elements=["user_id",
  "category_id"], ...)` targets the composite natural PK — the actual uniqueness
  constraint — so two concurrent PUTs serialize on the index instead of racing a
  read-modify-write; `updated_at: func.now()` refreshed on the update arm
  (merchant_category_map precedent, matches plan). Response body is built from
  `payload.amount_minor` + `base` — exactly what the upsert wrote on either arm,
  so response == stored state deterministically; no re-read needed.
- **Contract honesty.** Verified in the regenerated `openapi.json`: PUT 422
  carries the honest `anyOf[LimitError, HTTPValidationError]` union (goals/AM-5
  construction, byte-parallel to `routers/goals.py`); GET's 422 is the auto
  `HTTPValidationError` arm alone (its only 422 is the month pattern) as the plan
  demands; `LimitItem.limit_currency`, `spent_minor` and
  `LimitsRead.unconverted_count` are all **required** (the plan's B3 report
  line); DTOs carry no `user_id`/timestamps, no `status`/`exceeded` (D18).
- **House conventions.** 404/422 code-in-detail envelopes mirror goals; auth
  dependency ahead of query params on GET (the /stats 401-before-422 ordering);
  mount has no `prime_rate_limit` (D1) with the standard explanatory comment;
  no migration touched; sessions commit only on the two write paths.
- **Test kill-power (mutation check).** Wrong-kind bucket key → B3-6 fails
  (500 000 income row); summed-both-kinds → 100 000 ≠ 600 000; conflict target
  broken / do_nothing → B3-1 fails (45 000 + exactly-one-item); read-time
  currency reinterpretation → B3-2; scope leak in rows OR aggregate → B3-9's
  shared-PRODUKTY fixture (the only fixture where an unscoped aggregate is even
  observable); per-item unconverted flag → B3-7/AM-10 (rateless row in an
  UNLIMITED category); ordering by insertion → AM-11(a)'s fixed high-then-low
  UUIDs; window off-by-one → B3-8's 2026-03-01 boundary row. Amount-bounds test
  carries the accept arm (MAX passes). No vacuous arms found: every assertion
  contrasts a distinct failure mode.
- **Fixture hygiene.** `conftest._clean_tables` deletes `users` (cascades limits,
  categories, transactions) and `exchange_rates` per test, so `_seed_rate`'s
  USD/RUB row and the fixed AM-11 category UUIDs cannot leak across tests.
  `PRODUKTY_ID` matches migration `0003_seed_and_backfill.py` and the constant
  already used by `test_categories.py`/`test_core_model.py`.

## Findings

### 1. [minor — KNOWN, pre-flagged by senior-lead, recorded for tracking only]
401 wall is tested only on GET; PUT and DELETE have no unauthenticated arm.
House convention is one unauthenticated call per method per new router.
**Fix:** add `client.put("/limits/<uuid>", json={"amount_minor": 1})` and
`client.delete("/limits/<uuid>")` without headers to
`test_limits_are_user_scoped_and_require_auth`, both asserting 401.

### 2. [nit] Misleading comment: "The rated foreign row IS folded in"
`tests/test_limits.py:365`. The USD rate is seeded BEFORE the tx write, so the
write path snapshots `base_amount_minor` and the row is included via **bucket 2**
(stored snapshot), not via the read-time bucket-3 rate fold. The file docstring
says this correctly ("one snapshotted foreign row for 'included'"), but the
inline comment could lead a future editor to believe the display-time-conversion
path (rate seeded AFTER the write / after a base switch) is covered here — it is
not (deliberately: `test_transactions.py`/`test_stats.py` own the three-bucket
pinning). **Fix:** reword to "The snapshotted foreign row IS included — the flag
is not 'any foreign row'".

### 3. [nit] `unconverted_count` doc slightly overstates
`schemas/limit.py:56-59`: "rows in the month that had no usable rate and are
therefore excluded from EVERY `spent_minor`". The counter (correctly, per AM-10
single-sourcing with `converted_totals`) also counts unconvertible **income**
and uncategorized rows, which were never candidates for any `spent_minor`. The
number is intentionally identical to /stats for the same month; the wording just
shouldn't imply the count is expense-only. **Fix:** one clause, e.g. "...had no
usable rate (any kind — the same period counter /stats reports) and are
therefore absent from every sum on this screen."

### 4. [nit] Theoretical UTC-month-rollover flake in the default-month arm
`tests/test_limits.py:395-414`: the test creates a tx dated `today` and then
asserts the defaulted GET both echoes `month_key(today)` and counts that row. A
run that straddles UTC midnight on the last day of a month between the two calls
fails. Sub-second window, once a month, same exposure as the existing
current-clock arms elsewhere in the suite — note only, no change requested. (If
it ever bites, capture `today` from the response's echoed month instead.)

## Verdict

**APPROVE.** No major findings. The two FULL-tier risk surfaces — the GET fold
and the D15 stamp — are implemented exactly as ruled (single-sourced through
`converted_totals`; re-stamp confined to PUT), no-oracle holds on both mutating
routes, the upsert targets the real uniqueness constraint, and the contract
declares the honest 422 union on PUT only. Finding 1 is the senior-lead's
already-known 401-wall gap (two-line test addition); 2–4 are comment/wording
nits that need no re-review after fixing.
