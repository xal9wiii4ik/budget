# Review B1 — accounts-and-transfers core (FULL tier)

Reviewer: code-reviewer. Scope: uncommitted diff under `apps/api` + contract pair.
Gates not re-run (orchestrator's run authoritative). One targeted pytest probe was
run to confirm MAJOR-1 (probe file created and deleted; see repro below).

**Verdict: 1 MAJOR, 1 MINOR, 2 NIT, 0 BLOCKER.** The security surface, money
math, migration and idempotency are clean — the one defect is a reachable 500 on
an edge PATCH payload.

## Findings

### MAJOR-1 — 500 (AssertionError) on PATCH of a non-transfer with explicit `"counter_amount_minor": null`
`apps/api/src/budget_api/routers/transactions.py:929-933` (guard gap at 814-829).

The transfer-shape guard rejects explicit-null counter fields only when
`is_transfer` (line 814); the non-transfer `elif` (822) compares payload *values*
(`is not None`), so an explicit null passes it. The write block then does
`if "counter_amount_minor" in fields: assert payload.counter_amount_minor is not None`
— the comment `# 422-guarded above` is false for the non-transfer path.

Repro (confirmed by probe): create an expense, then
`PATCH /transactions/{id}` body `{"counter_amount_minor": null}` →
`AssertionError transactions.py:930` → 500. Schema-valid payload
(`counter_amount_minor: int | None`), any authed user, own row.

Same-family asymmetry (fold into the fix): `{"counter_account_id": null}` on a
non-transfer is silently ignored (200 no-op) — one sibling 500s, the other no-ops.
Recommended fix: on a non-transfer, decide by field-set, not value — either treat
both explicit nulls as no-ops, or (matching the R1(5) "explicitly sent and
unusable → 422" precedent, cf. recurring ANCHOR_MISMATCH) answer
`COUNTER_FIELDS_WITHOUT_TRANSFER` for any counter field present in
`model_fields_set`. Add the contrast test either way.

### MINOR-1 — recurring materializer books onto an ARCHIVED account, undocumented
`apps/api/src/budget_api/services/recurring_jobs.py:131-141` +
`routers/recurring.py` (account validated on template create only).

`POST/PATCH` guard writes to archived accounts (`ACCOUNT_ARCHIVED` 422), but a
template whose account is archived *after* creation keeps materializing rows onto
it — the scheduler path has no archived check, so money keeps landing on a retired
account with no user-visible refusal. There is precedent (archived categories
after the fact are tolerated by design), and silently skipping in the scheduler
would be worse — so this is likely the RIGHT behavior, but it is currently an
accident, not a decision. Ask senior-lead to pin it (one sentence in
architecture/docs, or an explicit B2 item), not necessarily to change it.

### NIT-1 — no indexes on the three new FK columns
`transactions.account_id`, `transactions.counter_account_id`,
`recurring_templates.account_id` (migration 0008 / models). Every current query
rides the existing `user_id` indexes (balance union filters `user_id`; B2's
account filter will combine with it), and volumes are small (D13) — noting only
so it is a known decision. The `accounts→transactions` CASCADE would seq-scan,
but accounts are only hard-deleted inside the user cascade.

### NIT-2 — IntegrityError-recovery arm not exercised with a transfer body
`tests/test_transaction_idempotency.py::TestRace` races an expense; qa-checklist
P-6 says "including recovery arm" for transfers. The arm is shape-agnostic
(`_serialize` is a pure function of the row; `counter_currency` is on the row —
the C-3 payoff), so a transfer variant would be a near-duplicate; acceptable
under the no-redundant-tests rule. Note for qa-engineer when marking P-6.

## What was checked and is clean

- **No-oracle / scoping**: foreign==missing→one `load_own_account` path, byte-identical
  `{"detail":"ACCOUNT_NOT_FOUND"}` for `account_id` AND `counter_account_id`, in
  create AND update, transactions AND recurring; NOT_FOUND strictly before ARCHIVED
  everywhere (create order matches plan risk 1 exactly; update: account 404 →
  archived → counter 404 → SAME on the *effective* pair → counter archived).
  Every new query (`account_balances` union both legs, list, load) is user_id-scoped.
  Tests pin foreign-ARCHIVED→404 (P-8/P-9) with own-archived→422 contrast.
- **Money**: pure integer arithmetic in balances (no conversion, JPY leg verbatim —
  pinned by test); `transfer_rate` the only Decimal — 6 *significant* digits
  ROUND_HALF_UP, exponent crossing via `scaleb` outside the reduced context,
  `format(rate,"f")` avoids scientific notation, 0→None; no float, no x100,
  currency argument live everywhere. P-1/P-2 pinned incl. VND→USD and half-up cases.
- **Migration 0008**: seven CHECKs render byte-identical to the model
  (`(kind='transfer') = (counter_account_id IS NOT NULL)` biconditional, counter
  trio pairing, differs, positive, no category, no base snapshot); `kind_valid`
  dropped/recreated under the same `op.f` name; C-1 tuple pinned in the
  recurring model so the templates CHECK stays 0006; symmetric downgrade
  (transfer-row DELETE documented and deliberate); NOT NULL w/o default legal
  (tables empty per §11). P-3 pins all five CHECKs by direct insert + accept contrast.
- **PATCH semantics**: transfer rows never enter the snapshot branches (explicit
  `pass` arm, risk 4 — pinned by test asserting `base_amount_minor is None` after
  edit); kind change to/from transfer → 422 both directions (pinned); account move
  restamps currency + recomputes snapshot via `account_id ∈ _CONVERSION_INPUTS`
  (rows 2/6/3 retargeted tests cover clear/populate/override-reject); recurring
  currency locked to the account stamp with `CURRENCY_REQUIRED` still first.
- **Idempotent replay**: replay arm before all account guards; `_serialize` pure
  (C-3 denormalized `counter_currency`); replay-with-different-amounts test proves
  no re-stamp/re-validate via balances; recovery arm re-select unaffected by the
  new NOT NULL.
- **Contract**: pair regenerated together; `TransactionCreate.account_id` required,
  Read carries the counter trio + `transfer_rate` (all in `required`), `AccountRead`
  has `balance_minor`, POST /transactions declares 404, accounts PATCH declares
  404+422 anyOf with `AccountError`; schema.d.ts consistent with generation.
- **Tests**: no vacuous tests found; the accept-contrast and no-oracle contrasts are
  genuine. Fixture repair across 11 files is mechanical (`account_for_currency`).

Known planned gaps NOT reported (per brief): `kind=transfer` on /recurring 500s
until B2's `RECURRING_TRANSFER_UNSUPPORTED`; transfers not yet filtered out of
`tx_totals` aggregates (B2 owns the `_NOT_TRANSFER` predicate).
