# Review B2 — aggregates & periphery (FULL tier)

Reviewer: code-reviewer. Scope: commit `82385d6` (whole B2 diff).
Gates not re-run (orchestrator's 412-pass run authoritative). Probes: greps only —
every `func.sum`/fold over money in `apps/api/src`, every `select(Transaction)` in
non-test source, MCP `allowlist.ts` param sets, `fx_lookup` inversion path. No DB
probe was needed: each focus point resolved conclusively by reading.

**Verdict: 0 BLOCKER, 0 MAJOR, 1 MINOR, 2 NIT.** The money-corruption surface this
review exists for is clean: the predicate is in all four passes, no fifth
aggregation site leaks a transfer, the one site that must COUNT transfers
(balances) counts both legs, and the CSV/filter/recurring edges match the
architecture. The one real gap is in the MCP tool surface, not in any number.

## Findings

### MINOR-1 — MCP `list_transactions` never got the new `account_id` filter param
`packages/mcp-server/src/allowlist.ts:90-98`.

Plan M1 assigned "curated descriptions of new fields in … `list_transactions`",
but the only new list param — `account_id` — entered the contract only in B2's
regeneration, AFTER M1 landed (`5981d2f` precedes `82385d6`; a param name absent
from the contract crashes MCP start, so M1 *could not* have added it). B2
regenerated the contract and did not circle back. Result: the MCP agent can mint
`account_id`s via `list_accounts` and use them in `create_transaction`, but cannot
filter history by account — a silent capability gap, not wrong data. Evidence:
current `params` block is `from,to,category_id,kind,limit,offset` — no
`account_id`. Fix is one curated param line (+ no count changes: same 27 tools).

### NIT-1 — plan test theme "шаблон копирует account_id в строку" not delivered
`apps/api/tests/test_recurring_jobs.py` (no assertion on the materialized row's
`account_id`; only the fixture at :138 mentions it). Defensible under the
no-vacuous-tests rule: `transactions.account_id` is NOT NULL since 0008 and the
materializer has exactly one account in reach (`tpl.account_id`), so a wrong-copy
failure mode barely exists — but it is a deviation from plan B2's listed themes,
so recording it here rather than letting it pass silently.

### NIT-2 — `account_id` filter exercised on `/transactions` only, not `/export`
`apps/api/tests/test_transfers.py::TestAccountFilter`. Both endpoints consume the
same `_read_filters` (one definition, verified), so an export variant would be a
near-duplicate — acceptable under the redundancy rule; noted so QA marks the
checklist item consciously, not by assumption.

## Checked and clean (per focus point)

1. **Four passes + fifth-place hunt.** `_NOT_TRANSFER` present in all four:
   `_bucket_three_rows` (tx_totals.py:118), `converted_totals` period tuple
   (:140), `monthly_converted_totals` grouped where (:231),
   `merchant_converted_totals` grouped where (:330); the merchant bucket-3 scan
   reuses `_bucket_three_rows(...).where(*of_kind)` so it inherits it too.
   Exhaustive sweep of every money fold in `apps/api/src`: goals sums are over
   `GoalContribution` (own table); `domain/goals.py` free balance, limits
   (:114), stats summary/monthly/top-merchants, tx summary (:730), goal_reads
   (:111) and advisor context all ride tx_totals — inherited. The ONE other
   Transaction aggregate, `services/account_balances.py`, must INCLUDE transfers
   and does, correctly on both legs: own leg subtracts like an expense, incoming
   leg adds `counter_amount_minor` (target currency, no conversion), scoped
   `user_id` on both selects. The remaining `select(Transaction)` sites
   (idempotency replay/recovery :439/:455, list :697, export :800) fold nothing.
   No client-side folding of `amount_minor` in apps/web or apps/mobile (grep).
   Transfers excluded from `unconverted_count` too — a snapshot-less transfer is
   by design, not a conversion gap; tests pin `unconverted_count == 0` against a
   rateless KRW leg.

2. **Top merchants — senior-lead's no-test claim VERIFIED.** `of_kind =
   (merchant IS NOT NULL, kind == kind.value)` is applied in BOTH the grouped
   select AND the bucket-3 scan; the route hardcodes `kind=TransactionKind.expense`
   with no query knob (stats.py:313, docstring :300). A transfer is doubly
   unreachable (kind pin + `_NOT_TRANSFER`). No test needed — agreed.

3. **`account_id` filter.** `or_(account_id == X, counter_account_id == X)` ANDed
   with the always-present `Transaction.user_id == user_id` — a foreign account id
   matches nothing and returns the same 200-empty as an existing-but-quiet
   account: no oracle. One `_read_filters` definition wired into list (:690, incl.
   the count query) and export (:801) identically. Test covers both legs AND the
   negative (third account sees only its own row — the OR does not widen).

4. **`RECURRING_TRANSFER_UNSUPPORTED`.** POST: `_reject_transfer_kind` is the
   FIRST statement, before `_require_own_account` and the category lookup — the
   422 is identical whatever the ids point at, no existence oracle. PATCH: no
   `account_id` field exists on `RecurringTemplateUpdate` at all (comment
   :113-116), so no account lookup to leak; the guard sits before the category
   lookup; `kind` is written ONLY from the guarded payload (`"kind" in fields`
   arm), explicit `kind: null` hits `KIND_REQUIRED` via `_REQUIRED_FIELDS`
   BEFORE the assert (the B1 MAJOR-1 500 pattern does NOT recur here). No other
   morph path; DB CHECK still `('expense','income')` as backstop. Test covers
   POST + PATCH + nothing-half-applied.

5. **CSV export.** `counter_amount` rendered via
   `to_major_string(counter_amount_minor, tx.counter_currency)` — the COUNTER
   currency's exponent, pinned by the JPY test ("15000", would be "150.00" at the
   source's exponent). Transfer base cells empty (no snapshot by CHECK), never
   zero. Account-name map `WHERE Account.user_id == user_id` only — user-scoped,
   archived-inclusive. New columns APPENDED to `_EXPORT_COLUMNS` and `_export_row`
   in lockstep; full header string and a full-row dict are both pinned by tests,
   including the empty-counter contrast on a non-transfer and the
   `endswith("counter_amount\r\n")` empty-body check.

- **Contract pair**: openapi.json + schema.d.ts moved in the same commit; changes
  are exactly the two optional `account_id` query params + the export docstring;
  schema.d.ts shape is generator output, no hand-edit signature.
- **Tests**: the five per-surface aggregate tests are NOT redundant — five
  endpoints with five response shapes, and the shared fixture deliberately arms
  both bucket-3 failure modes (seeded-rate USD leg → would convert into expense;
  rateless KRW leg → would flag), with `fx_lookup` inversion confirming the
  RUB/USD seed resolves. Exact-dict assertions catch a leaked (uncategorized,
  expense) bucket. No vacuous tests found.
- **Docs**: the `docs/backend.md` recurring_jobs line accurately pins B1/MINOR-1
  as a decision, matching the expanded code comment; nothing else in the doc was
  invalidated by this diff.
