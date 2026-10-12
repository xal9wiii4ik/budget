# Implementation Plan: debts — B1 (backend, FULL tier)

Design = `architecture.md`, amended by `grooming-review.md` (tool name
`record_debt_repayment`). Nothing here re-opens a decision; this is the file-level
thesis of how it lands, plus FULL detail for the two risky pieces
(`services/debt_writes.py`, the grouped read query) and the test list.

## Approach

Representation (A) verbatim: a debt movement IS a `transactions` row of kind
expense|income carrying the link trio `debt_id / debt_role / debt_amount_minor`;
`debts` stores no money; `remaining`/`status`/`closed_on` are derived per read.
Two mechanisms carry the whole scope: the ONE exclusion predicate in `tx_totals`
(so no aggregate needs a debt-aware filter) and the single writer
(`services/debt_writes.py`) that stamps the kind, takes the row lock and refuses
overpayment — with nine CHECKs making half a debt unrepresentable underneath it.

Dependency direction as stated in architecture §"Module structure": the router is
routes + HTTP only, services never raise `HTTPException` (`DebtWriteError(code)`
is translated by the router), `domain/debts.py` is pure.

## New files

- `src/budget_api/models/debt.py` — `Debt` (no money columns; direction/currency
  immutable by schema, CHECKed here).
- `alembic/versions/0017_debts.py` — hand-written DDL, symmetric downgrade.
- `src/budget_api/domain/debts.py` — pure: `movement_kind`, `remaining`,
  `status_of`, `closed_on`.
- `src/budget_api/services/debt_reads.py` — `DebtView`, `debt_views`,
  `movement_totals`, `debt_repayments`, `debt_summary`, `read_upcoming_due`.
- `src/budget_api/services/debt_writes.py` — `DebtWriteError`, `create_debt`,
  `update_debt_fields`, `add_repayment`, `update_repayment`.
- `src/budget_api/services/tx_idempotency.py` — `load_by_client_id`, extracted
  from `routers/transactions.py` at its second consumer (architecture
  §"Idempotency"); it stays a one-function module, each router keeps its own
  `IntegrityError` recovery arm.
- `src/budget_api/debt_access.py` — `load_own_debt`, `load_own_repayment`
  (`deposit_access.py` shape, one `None` path → one 404).
- `src/budget_api/schemas/debt.py` — `DebtRead/DebtDetailRead/DebtRepaymentRead/
  DebtSummary/DebtList/DebtCreate/DebtUpdate/DebtRepaymentCreate/
  DebtRepaymentUpdate/DebtError`.
- `src/budget_api/routers/debts.py` — the eight routes of the table in
  architecture §Endpoints.
- `tests/test_debts.py`, `tests/test_debts_money.py` — see "Tests".

## Files to modify

- `enums.py` — `DebtDirection(lent, borrowed)`, `DebtRole(principal, repayment)`,
  `DebtStatus(open, closed)`; the first two are CHECK sources (definition order
  load-bearing, like every enum there), the third is wire-only.
- `models/transaction.py` — the three nullable columns + nine CHECKs
  (`debt_link_trio`, `debt_role_valid`, `debt_amounts_positive`,
  `debt_not_transfer`, `debt_no_category`, `debt_no_base_snapshot`,
  `debt_no_goal_item`, `debt_no_original`, `debt_no_recurring`) + two partial
  indexes (`ix_transactions_debt_id`, `uq_transactions_debt_principal`); names
  byte-identical to 0017.
- `models/push.py` — `PushReminderSend.debts` SmallInteger server_default 0.
- `models/__init__.py` — export `Debt`.
- `app.py` — `include_router(debts.router, prefix="/debts")`, no
  `prime_rate_limit` (no limiter in the router), mounted after `/deposits` (the
  Money group order of grooming-review §3). No new CORS verb.
- `services/tx_totals.py` — `_NOT_TRANSFER` → `_NOT_TRANSFER_OR_DEBT =
  (kind != transfer) & debt_id IS NULL`, applied in the same four passes; module
  docstring + the predicate comment updated.
- `services/statement_import/apply.py` — `NOT_TRANSFER` →
  `DELETABLE_BY_REPLACE` (same widening; renamed so the name stays honest),
  `_replaceable_targets` refuses a debt target with `DEBT_MOVEMENT_READONLY`.
- `routers/statement_imports.py` — the preview's grouped query gains
  `debt_movements_kept`; `_reject_unreplaceable` refuses a debt row with
  `DEBT_MOVEMENT_READONLY` (the `TRANSFER_REPLACE_FORBIDDEN` site).
- `schemas/statement_import.py` — `StatementReplacePreview.debt_movements_kept`
  (+ the docstring's "nothing survives unannounced" arithmetic).
- `routers/transactions.py` — `DEBT_MOVEMENT_READONLY` 422 right after the 404 in
  PATCH and DELETE (reads `tx.debt_id`, imports nothing new); `_load_by_client_id`
  → `services/tx_idempotency.load_by_client_id`.
- `schemas/transaction.py` + `transaction_wire.py` — `TransactionRead.debt_id`
  (read-only badge; absent from both write DTOs by construction).
- `services/tx_export_csv.py` — `debt_id` column APPENDED to `_EXPORT_COLUMNS`.
- `domain/push_digest.py` — `DigestInput.debts: Sequence[str]`, `is_empty`,
  families count, `_url` (`/debts` for a debts-only digest), names appended after
  deposits.
- `services/push_jobs.py` — `_Snapshot.debts`, `_read_snapshot` →
  `read_upcoming_due`, `nothing_due`, the `debts` counter in session C.
- `tests/test_pat_auth.py` (38→43 / 27→30), `tests/test_mcp_tools.py`
  (READ_TOOLS +2, WRITE_TOOLS +3, full 35→40, the curation loop +3 tools),
  `tests/fixtures/mcp_tools_snapshot.json` (five entries ADDED; `source.*`
  untouched), `tests/test_mcp_remote.py` (20/35 → 22/40),
  `tests/test_mcp_server.py` (35 → 40), `tests/test_statement_replace.py`
  (preview dict gains `debt_movements_kept`).
- `docs/backend.md`, `docs/mcp.md` — see the brief's doc list.

## Code skeletons

### `domain/debts.py` (pure)

```python
def movement_kind(direction: DebtDirection, role: DebtRole) -> TransactionKind: ...
def remaining(principal_minor: int, repaid_minor: int) -> int: ...
def status_of(remaining_minor: int) -> DebtStatus: ...
def closed_on(remaining_minor: int, last_repayment_on: date | None) -> date | None: ...
```

`movement_kind` is the four-case table (lent+principal=expense,
lent+repayment=income, borrowed+principal=income, borrowed+repayment=expense).

### The grouped read query (`services/debt_reads.py`) — FULL detail

ONE definition of per-debt money, read by the list, the detail, the summary, the
push family AND the write guards, so no two of them can disagree:

```python
@dataclass(frozen=True)
class MovementTotals:
    principal_minor: int          # the principal row's debt_amount_minor
    repaid_minor: int             # Σ repayments, debt currency
    repayments_count: int
    last_repayment_on: date | None

async def movement_totals(
    session, user_id, debt_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, MovementTotals]:
    """ONE grouped pass over the user's debt rows — `count(*) FILTER` style:

    SELECT debt_id,
           COALESCE(SUM(debt_amount_minor) FILTER (WHERE debt_role='principal'),0),
           COALESCE(SUM(debt_amount_minor) FILTER (WHERE debt_role='repayment'),0),
           COUNT(*)      FILTER (WHERE debt_role='repayment'),
           MAX(occurred_at) FILTER (WHERE debt_role='repayment')
      FROM transactions
     WHERE user_id = :u AND debt_id = ANY(:ids)
     GROUP BY debt_id
    """
```

`debt_views` = (1) the debts rows (`user_id`-scoped, optional single id, ORDER BY
`created_at DESC, id`) INNER JOINed to their principal movement for
`opened_on / account_id / account_currency / account_amount_minor`, (2) one
`movement_totals` call. Two queries for one debt and for two hundred — the
`deposit_reads` rule. `remaining/status/closed_on` come from `domain/debts`, never
from SQL, so there is exactly one definition of the arithmetic.

`read_upcoming_due(session, user_id, *, today, through) -> list[str]` filters
those same views by `due_on` inside the inclusive window AND `remaining > 0`,
ordered `due_on, created_at`, and returns `counterparty` only — no amount ever
enters `DigestInput`.

`debt_summary(session, user_id, views)` — base currency from
`profile_reads.read_base_currency`, then per OPEN view: debt currency == base →
add `remaining` as is; else one `lookup_rate(debt.currency, base, today)` through
a per-call `dict[(from,to), Decimal | None]` cache (the `goal_plan_reads` rule) +
`convert_minor`; no rate → the side's `*_unconverted_count`, never summed as zero.
Side = `direction` (lent → `owed_to_me_minor`, borrowed → `i_owe_minor`).

### `services/debt_writes.py` — FULL detail

```python
class DebtWriteError(Exception):          # the StatementApplyError precedent
    def __init__(self, code: str) -> None: ...

async def _lock(session, user_id, debt_id) -> None:
    """SELECT 1 FROM debts WHERE id AND user_id FOR UPDATE — taken by EVERY
    movement write before the totals are read, so two concurrent repayments
    cannot both see the same `remaining` (architecture §Overpayment)."""

def _amounts(*, debt_currency: str, account_currency: str,
             amount_minor: int, account_amount_minor: int | None) -> tuple[int, int]:
    """ONE currency-pair rule for every movement, opening included.

    Returns (debt_amount_minor, account_amount_minor).
    * currencies differ → account_amount_minor REQUIRED, else
      DEBT_ACCOUNT_AMOUNT_REQUIRED (no rate snapshot, no guess);
    * currencies equal → the server COPIES amount_minor; a sent value that
      disagrees → DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE (the
      ACCOUNT_CURRENCY_MISMATCH shape, refused rather than restamped).
    """

async def create_debt(session, user_id, *, payload, account) -> tuple[Debt, Transaction]:
    """The debts row + its principal movement, added to the CALLER's transaction
    (the router owns the commit and the replay-race arm). `kind` from
    `movement_kind(direction, principal)`; `currency` from the ACCOUNT (stamped,
    as every transaction); base snapshot / category / goal link stay NULL (the
    CHECKs forbid them). `due_on < opened_on` → DEBT_DUE_BEFORE_OPENING."""

async def add_repayment(session, user_id, debt, *, account, payload) -> Transaction:
    """_lock → movement_totals → repaid + amount > principal ⇒
    DEBT_REPAYMENT_EXCEEDS_REMAINING (a repayment on a CLOSED debt is the same
    refusal: remaining is 0, no DEBT_CLOSED code) → insert the row, kind from
    movement_kind(direction, repayment)."""

async def update_repayment(session, user_id, debt, row, *, payload, account) -> None:
    """Same lock; the ceiling is checked on the EFFECTIVE sum
    (repaid − stored + new). An account move across currencies must carry the
    account amount → AMOUNT_REQUIRED_ON_CURRENCY_CHANGE; the `kind` is restamped
    from (direction, role) so it can never go stale."""

async def update_debt_fields(session, user_id, debt, principal, *, payload, account) -> None:
    """Metadata (counterparty/due_on/note — allowed on a CLOSED debt: closed is a
    filter state, not a lock) plus the principal movement. Shrinking the principal
    below what is already repaid → DEBT_PRINCIPAL_BELOW_REPAID, under the same
    lock. `direction`/`currency` are absent from DebtUpdate (immutable by schema)."""
```

### `routers/debts.py`

Eight routes, `_UNPROCESSABLE` anyOf + `_NOT_FOUND` as in `deposits.py`;
`DebtWriteError` → 422 in one `except` per write route; account refs through the
EXISTING `transaction_guards` trio (`require_own_account` → `reject_archived` →
`reject_deposit_spending(is_transfer=False)`), in that order. Guard order on every
`{debt_id}` route: `load_own_debt` → 404 `DEBT_NOT_FOUND` FIRST. Both POSTs take
`client_id`: select-first via `tx_idempotency.load_by_client_id`, then the stored
debt with 200 (the entity, not the row), plus the post-`IntegrityError` re-select
arm. Markers: `list_debts`, `get_debt`, `create_debt`, `update_debt`,
`record_debt_repayment` (curated `params=` for EVERY property, managed
`client_id` on the two POSTs); `# MCP: no — …` on the three remaining routes.

## Tests

~22 tests in two new files (`test_debts.py` — router/access/contract;
`test_debts_money.py` — balances, aggregates, arithmetic, concurrency) plus the
pin edits listed above and one `debt_movements_kept` expectation in
`test_statement_replace.py`. Themes: balance movement per direction/role; the
four-case `movement_kind`; aggregate exclusion; remaining/status/closed_on
arithmetic incl. reopening; overpayment refusals; the currency-pair rule; edit and
delete of a repayment; cascade DELETE; the `/transactions` refusal; no-oracle 404
byte-identity at both levels; `client_id` replay; push family + privacy; the
replace sparing debt rows.

Enumerated for the money rules only (the rest is one test per theme):

1. lend → account balance −amount, `/transactions/summary` expense 0 and
   `/stats/summary` unchanged (ONE test: the three sources in one place).
2. borrow → balance +amount; repayment of each direction moves the balance the
   other way.
3. `remaining` after a partial repayment; `status=closed` + `closed_on` = the last
   repayment date at exactly 0; deleting that repayment reopens it.
4. repayment over `remaining` → 422 `DEBT_REPAYMENT_EXCEEDS_REMAINING`
   (including on a closed debt — same code).
5. principal shrunk below repaid → 422 `DEBT_PRINCIPAL_BELOW_REPAID`.
6. differing currencies without `account_amount_minor` → 422
   `DEBT_ACCOUNT_AMOUNT_REQUIRED`; equal currencies copy it; a disagreeing value →
   422 `DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE`.
7. editing a repayment's amount keeps `remaining` and the balance consistent;
   deleting it reverts both.
8. summary: two sides in the base currency with a per-side `unconverted_count`
   when a rate is missing.

No test for: Pydantic bounds, 401 per route (one per router), column existence,
or the nine CHECKs individually (two representative ones only — the unique
principal and the no-category CHECK — since no API path can reach them).

## Open questions

- The architecture's parenthetical on the cross-currency PATCH names
  `AMOUNT_REQUIRED_ON_CURRENCY_CHANGE` "for the account amount" and
  `DEBT_ACCOUNT_AMOUNT_REQUIRED` "for the debt one". The debt currency is
  IMMUTABLE, so only the account-currency amount can ever need restating: this
  plan uses `AMOUNT_REQUIRED_ON_CURRENCY_CHANGE` on a PATCH that moves a movement
  to an account of another currency without `account_amount_minor`, and
  `DEBT_ACCOUNT_AMOUNT_REQUIRED` on create/repayment where the currencies differ
  and it is simply absent. Both codes exist exactly as listed in the Endpoints
  table.
- `apply.NOT_TRANSFER` is renamed `DELETABLE_BY_REPLACE` ("under its own name",
  architecture §tricky predicate) — the widened predicate would otherwise carry a
  name that lies.

## Risks

- **Nine CHECKs vs the model**: a drift turns a legal write into a 500. Mitigated
  by `alembic check` in the gates and by rebuilding the role CHECK from the enum.
- **`tx_totals` predicate**: missing one of the four passes hides the bug on
  base-currency rows and ships it on foreign ones (the comment there says exactly
  this). All four are edited in one change.
- **The replay arm of `POST /debts`** returns the DEBT, not the row: the stored
  `client_id` sits on the principal movement, so the lookup resolves row →
  `debt_id` → `debt_views`. A naive copy of the transactions arm would answer with
  a transaction.
- **`debt_amount_minor` always set**: every reader sums ONE column; a NULL-when-equal
  variant would need the debt currency denormalized onto the row.
- **Mobile is frozen**: `TransactionRead.debt_id` is additive, so the regenerated
  types must not break its typecheck; verified in the gates, never edited.
