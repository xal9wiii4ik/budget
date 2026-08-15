# Code Review: S1 — rates-infra-and-migration (FULL tier)

Reviewer pass over the uncommitted S1 working-tree diff, against plan.md S1
(lines 56–272), grooming-review.md AM-1/AM-2, and codebase conventions
(migrations 0001–0004, storage/receipt_parser seam style, conftest patterns,
domain/money.py Decimal rules). Gates green before review: pytest 123, ruff
check, ruff format, pyright strict, alembic upgrade+check + symmetric downgrade.
Live QA (TC-S1-1..5, TC-Z1) fully green.

## Findings

1. **MINOR — `services/fx_rates.py:153, 180–183` — `derive_nbrb` runs outside
   the BAD_PAYLOAD guard.** A payload with `Cur_OfficialRate: 0` passes
   `b`-construction, then `_ONE / rub` raises `decimal.DivisionByZero` — an
   `ArithmeticError` in `_PAYLOAD_ERRORS`, but the `derive_nbrb(...)` calls in
   both `parse_nbrb` and `parse_nbrb_dynamics` sit *outside* their `try`
   blocks, so a raw `DivisionByZero` escapes instead of
   `FxFetchError(NBRB, "BAD_PAYLOAD")`. The job's broad `except Exception`
   contains it (logged `%r`, not the taxonomy code) — no crash, but the module
   docstring's taxonomy contract is breached. Fix: move the `derive_nbrb` call
   inside the existing `try` in both parsers; `FxFetchError` from `_finalize`
   is not in `_PAYLOAD_ERRORS`, so it still propagates unchanged.

2. **MINOR — `services/fx_jobs.py:164–178` — session/transaction held across
   provider HTTP.** The probe SELECT opens a transaction, then the session
   stays open through `plan.latest()`/`plan.history()` — in backfill mode up
   to ~9 sequential NBRB requests at a 30 s timeout each, i.e. minutes of
   idle-in-transaction pinning a pool connection (and vulnerable to any
   `idle_in_transaction_session_timeout`). Low impact for a daily job, but
   this is the scheduler precedent. Fix: probe in a short session (close it),
   fetch with no session held, open a fresh session for `_upsert_rates` +
   commit.

3. **NIT — `fx_rates.py:150` — `min()` of the three NBRB doc dates.**
   Deviation from the plan's "Cur_Date per document" but a defensible
   tightening: a derived pair is only honest for a date all inputs were
   published on. Residual hazard: divergent doc dates upsert mixed-date math
   over a genuine prior-day row. NBRB publishes as one batch, so pathological —
   suggest a `logger.warning` when the three dates differ. Not blocking.

4. **NIT — `fx_jobs.py:170` — backfill INFO line invisible under uvicorn
   defaults.** Root logger has no handler; `lastResort` surfaces WARNING+
   only. Backfill is a rare, operationally notable event — consider warning
   level or a minimal app logging config later. Fine for S1.

5. **NIT — `tests/test_fx_jobs.py:38` — `_TODAY` frozen at import.**
   `fetch_daily_rates` computes its own `now(UTC).date()`; a suite straddling
   UTC midnight flakes the window/seed assertions. Optional.

**Ruling on lead nit (migration index name):** plain-string
`ix_goal_contributions_goal_id_occurred_at` is correct as written — the exact
precedent is 0002's composite `ix_transactions_user_id_occurred_at`, also
plain-string; `op.f()` is used only for convention-generated single-column
names. No change.

## Verified clean

- Migration ↔ model parity exact (names, types, server defaults, CHECK
  expressions); downgrade fully symmetric in reverse order.
- Seam purity: `fx_rates.py` imports only httpx + Settings; `fx_jobs.py` is
  the sole DB toucher.
- Dedupe-before-ON-CONFLICT in `_upsert_rates` preempts the "same row twice in
  one statement" Postgres error.
- `TimeoutException` caught before parent `HTTPError`; misfire settings
  (None / 3600+coalesce) sound; shutdown-before-dispose ordering correct
  (`wait=False` mid-flight race absorbed by the job's broad except).
- All three pytest app factories gate the scheduler; `exchange_rates` cleanup
  present in `_clean_tables`.
- Tests: every pair contrasted (scale 100 vs 1, cross vs inversion, latest vs
  history per provider, stale vs fresh); no vacuous tests; all Decimal
  expectations reproduce exactly to the 8th dp (verified independently).

## Verdict

**APPROVE WITH COMMENTS** — findings 1 and 2 worth fixing before commit
(small, local edits); 3–5 discretionary.
