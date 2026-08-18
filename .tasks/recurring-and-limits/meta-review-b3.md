# Meta-review: B3 (senior-lead over review-b3.md)

## Rulings on findings
1. **AGREE (minor, pre-flagged by me at the diff gate).** 401 wall was pinned
   on GET only; house convention (B2-13 precedent) is one unauthenticated call
   per method per new router. FIXED: PUT + DELETE 401 arms added in
   `test_limits_are_user_scoped_and_require_auth` against a fresh uuid (wall
   answers before routing/validation). Re-run green.
2. **AGREE (nit).** The "rated foreign row IS folded in" comment implied the
   read-time bucket-3 fold is covered in this file; it is the write-time
   (bucket-2) snapshot. FIXED: comment reworded, ownership of the read-time
   path (test_transactions.py/test_stats.py) stated inline.
3. **AGREE (nit).** `unconverted_count` docstring overstated "excluded from
   EVERY spent_minor" — the counter is the same period-level any-kind count
   /stats reports (income/uncategorized rows included). FIXED: docstring now
   says so; behaviour unchanged (AM-10 single-sourcing is exactly why).
4. **DEFER (nit).** UTC month-rollover flake in the default-month arm — same
   inherent class as the B2 midnight-straddle note (meta-review-b2 §1.3).
   Recorded here as the diagnosis if a last-day-of-month 00:00-UTC flake ever
   appears; not a product bug, no code change.

## Senior diff-gate notes (pre-review, for the record)
- Spent-fold single-sourced: read_base_currency → month_bounds →
  converted_totals; router does ZERO conversion math; expense bucket only via
  `(category_id, TransactionKind.expense.value)` — the exact Bucket key
  tx_totals builds. unconverted_count passed through period-level (AM-10).
- OQ-4/D15: currency stamped from base at PUT (create AND conflict arms),
  never converted on read; GET returns both `currency` (current base) and
  `limit_currency` (stamp); re-stamp confined to rewrite. Pinned by B3-2.
- No-oracle: PUT via load_visible_category (one code path, foreign archived →
  404 not 422 — guard order correct); DELETE user-scoped load, byte-identical
  404, test also proves the foreign row survived.
- Upsert on the composite natural PK; no read-modify-write; no migration; no
  new index (O-5); system categories accepted (AM-11b); MONTH_PATTERN reused
  from domain/periods (year envelope intact).
- AM-10/AM-11 both landed as named tests; every rejection has its accept
  contrast; ordering arm uses controlled UUIDs so str-order ≠ insertion order.
- Accepted engineer test-mechanics deviations (argued in-report): archived-
  category tx created before archiving (only writable order — write path
  rejects archived); separate categories for the fixed-month vs default-month
  windows (clock-independence).

## Gate trail (senior re-run, authoritative; fix round re-run by engineer)
- `uv run pytest` on PG 5443 (TEST_DATABASE_URL): **334 passed**
  (323 at HEAD c849018 + 11 in test_limits.py).
- `ruff check` / `ruff format --check` (104 files) / pyright strict: clean.
- Contract pair: one `pnpm openapi`, **520 insertions / 0 deletions**
  (additive-only): paths `/limits`, `/limits/{category_id}`; schemas
  Limit{Upsert,Read,Item,Error} + LimitsRead; `limit_currency` and
  `unconverted_count` required (no `?`). PUT 422 carries the
  anyOf[LimitError, HTTPValidationError] union; GET 422 is the auto arm alone.
- `pnpm --filter @budget/api-client typecheck` clean; `test` 46 passed.
- Fix round touched tests + one schema docstring only; contract provably
  unchanged (`test_openapi_export` byte-equality passed in the 334).
- O-1: both artifacts regenerated together, to be committed WITH the code.
  O-5: no new index. No migration authored (stop-signal never tripped).
- QA per 2026-08-18 cadence: NO live QA at B3 (no new integration boundary);
  TC-B3-1..7 stay pending for the scope-end full run.

## Commit scope note for PM
The tree also carries parallel pipelines' writes: apps/mobile/* (defect fix),
apps/web + packages/shared + `packages/api-client/src/index.ts` +
`patch.test.ts` (web W2+). B3's commit is ONLY: apps/api/src/budget_api/
{routers/limits.py, schemas/limit.py, app.py}, apps/api/tests/test_limits.py,
apps/api/openapi.json, packages/api-client/src/generated/schema.d.ts.

**B3 verdict: ACCEPTED — ready for PM commit** (B3 paths only).
