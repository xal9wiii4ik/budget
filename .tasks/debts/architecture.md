# Architecture Plan: debts — кому должен я и кто должен мне

## Context
A debt is a money entity whose movements must (1) change account balances like
real money, (2) stay out of every income/expense aggregate through the ONE
existing filtering point (`tx_totals`), and (3) keep `remaining` and the
account balance consistent under every edit. The deposits scope answered the
same question with "metadata table + the existing transfer mechanism". Debts
cannot reuse transfers (the counterparty is not an account), so the question is
how debt movements live in the transactions ledger. Everything else — no-oracle
access, `_UNPROCESSABLE`, `@mcp_tool`, exponent-aware money, the push window —
is reused as is.

## Proposed approach — representation (A), refined
**A debt movement IS an ordinary `transactions` row** of kind `expense`/`income`
with a nullable link trio (`debt_id`, `debt_role`, `debt_amount_minor`). The
`debts` table stores NO money (the `deposits` precedent): the principal IS the
opening movement row (`debt_role='principal'`), every repayment is a row with
`debt_role='repayment'`, and `remaining` is computed on read.

Why A:
- **Balances untouched.** `account_balances` signs by kind; lend = expense,
  borrow = income, repayment received = income, repayment paid = expense. Zero
  change, no new leg, no sign table.
- **One exclusion point.** `tx_totals._NOT_TRANSFER` widens to
  `kind != 'transfer' AND debt_id IS NULL`; stats, limits, tx summary, goals
  free balance, advisor context inherit it. No second filter anywhere.
- **The account history stays honest.** `GET /transactions?account_id=` shows the
  outflow the bank statement shows; the statement matcher compares
  `(kind, amount, date)` as the account sees them, so a bank row for a lent
  amount matches the debt movement (`exact` → default `skip`), never duplicates
  it. This is the desirable behaviour, and it falls out with zero matcher code.
- **Invalid states are unrepresentable** (the transfer precedent): CHECKs forbid
  a debt row from carrying a category, a base snapshot, a goal link, an original
  pair, a recurring attribution, or being a transfer; a partial unique index
  forbids two principals. Half a debt cannot be written from any code path.

Rejected: **(B) fourth `kind='debt'`** — `account_balances` would need a sign
column, `TransactionKind` is a load-bearing-order enum consumed by every client
(mobile is frozen and would receive an unknown kind), the recurring model pins
kinds, and the statement matcher compares `kind`, so the bank's `expense` would
no longer match a `debt` row. **(C) separate `debt_movements` ledger** — passes
requirement 2 only vacuously (rows are invisible to `tx_totals`, so nothing
"filters" them), needs a third leg in balances, hides the outflow from the
account history, and makes the statement import create a duplicate expense next
to it (balance double-counted). Both lose the one thing A gets for free: a debt
movement is what the account already says happened.

## Database changes — migration 0017

### Enums (`enums.py`, definition order load-bearing, CHECKs rebuilt from them)
- `DebtDirection`: `lent | borrowed`.
- `DebtRole`: `principal | repayment`.
- `DebtStatus` (wire-only, computed like `DepositStatus`): `open | closed`.

### Tables
- `debts` (new):
  - `id` (UUID PK)
  - `user_id` (UUID, FK users ON DELETE CASCADE, NOT NULL, `ix_debts_user_id`)
  - `direction` (String(8), CHECK IN ('lent','borrowed')) — IMMUTABLE
  - `counterparty` (String(100), NOT NULL; free text, no normalization, no
    uniqueness — two debts with one person are two debts)
  - `currency` (String(3), CHECK `~ '^[A-Z]{3}$'`) — the debt's ONE currency,
    explicit in POST (the web defaults it to the opening account's), IMMUTABLE
  - `due_on` (Date NULL)
  - `note` (Text NULL)
  - `created_at` (timestamptz, server_default now())
  - No money columns. No `closed`/`archived` column (status is derived, below).

- `transactions` (ALTER, three nullable columns — the counter-trio shape):
  - `debt_id` (UUID NULL, FK debts ON DELETE CASCADE)
  - `debt_role` (String(16) NULL)
  - `debt_amount_minor` (BigInteger NULL) — the movement in the DEBT currency;
    equals `amount_minor` when the account currency is the debt currency
    (always set on a debt row — reads sum ONE column, no COALESCE)
  - CHECKs (hand-written in 0017 — autogenerate cannot diff CHECKs on an
    existing table, the 0016 rule — names byte-identical to the model):
    - `debt_link_trio`: `(debt_id IS NULL) = (debt_role IS NULL) AND
      (debt_id IS NULL) = (debt_amount_minor IS NULL)`
    - `debt_role_valid`: `debt_role IS NULL OR debt_role IN ('principal','repayment')`
    - `debt_amounts_positive`: `debt_id IS NULL OR (amount_minor > 0 AND debt_amount_minor > 0)`
    - `debt_not_transfer`: `debt_id IS NULL OR kind <> 'transfer'`
    - `debt_no_category`: `debt_id IS NULL OR category_id IS NULL`
    - `debt_no_base_snapshot`: `debt_id IS NULL OR (base_amount_minor IS NULL AND base_currency IS NULL)`
    - `debt_no_goal_item`: `debt_id IS NULL OR goal_item_id IS NULL`
    - `debt_no_original`: `debt_id IS NULL OR original_amount_minor IS NULL`
    - `debt_no_recurring`: `debt_id IS NULL OR recurring_template_id IS NULL`
  - Indexes: `ix_transactions_debt_id` PARTIAL `WHERE debt_id IS NOT NULL`;
    `uq_transactions_debt_principal` UNIQUE `(debt_id) WHERE debt_role = 'principal'`
    (at most one principal by construction; exactly one is the single writer's
    job — inserted in the same transaction as the `debts` row).

- `push_reminder_sends`: `debts` (SmallInteger, NOT NULL, server_default 0) —
  the fourth family's counter next to the existing three.

### Migration steps
1. Create `debts` (+ index).
2. Add the three transaction columns, FK, the nine CHECKs, the two partial
   indexes. No backfill — every existing row is correctly "not a debt" as NULL.
3. Add `push_reminder_sends.debts`.
4. Downgrade: symmetric DDL. Dropping the columns leaves former debt rows as
   plain expense/income — balances stay right, stats absorb them. That is the
   honest rollback (balances are the harder truth); do NOT delete the rows.

## Decisions

### Kind is a function of (direction, role) — `domain/debts.py:movement_kind`
lent+principal = expense, lent+repayment = income, borrowed+principal = income,
borrowed+repayment = expense. Applied by the single writer on every insert;
`direction` is immutable, so a stored row's kind can never go stale. A
cross-table CHECK is impossible; the pure function + immutability + one writer
is the drift guard, pinned by a four-case test.

### Remaining, status, closed — DERIVED, never stored
`remaining = debt_amount_minor(principal) − Σ debt_amount_minor(repayments)`,
all in the debt currency, computed per read in ONE grouped query
(`services/debt_reads.py`, the computed-balance precedent). `status = closed`
⇔ `remaining == 0`; `closed_on` = the latest repayment date when closed, else
null — both response fields. Nothing to maintain, nothing to drift: deleting a
repayment of a closed debt reopens it by arithmetic. Editing a closed debt
(note, due date, counterparty) is allowed — "closed" is a filter state, not a
lock. Forgiving a remainder (write-off) is out of scope; recorded below.

### Overpayment — FORBIDDEN, under a row lock
Any write that would make `remaining < 0` is refused: new/edited repayment →
422 `DEBT_REPAYMENT_EXCEEDS_REMAINING`; principal shrunk below what is already
repaid → 422 `DEBT_PRINCIPAL_BELOW_REPAID`. Every movement write in
`debt_writes` first takes `SELECT … FOR UPDATE` on the `debts` row, so two
concurrent repayments cannot both pass the check (the goal-items advisory-lock
precedent, in its cheapest form). A repayment on a closed debt is the same
refusal (remaining is 0) — no separate `DEBT_CLOSED` code.

### Currency — ONE rule for every movement (opening included)
A movement row carries `amount_minor` in the ACCOUNT currency (stamped from the
account, as every transaction) and `debt_amount_minor` in the DEBT currency.
When the two currencies differ, the debt-currency amount is REQUIRED from the
client (the transfer precedent: `counter_amount_minor` is the user's real rate,
never ours — what the counterparty counts as repaid is a fact the user knows,
not a daily-rate guess); omitted → 422 `DEBT_ACCOUNT_AMOUNT_REQUIRED`. When they
are equal, the server copies; a sent value that disagrees → 422
`DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE` (the `ACCOUNT_CURRENCY_MISMATCH` shape).
No rate snapshot, no `DEBT_RATE_UNAVAILABLE`, no null-recompute branch — the
web may prefill the second field from the existing `GET /fx/convert` preview.
Consequently the opening account MAY differ from the debt currency, and the
debt currency is explicit, not stamped. PATCH moving a movement across
currencies must carry both amounts (`AMOUNT_REQUIRED_ON_CURRENCY_CHANGE` reused
for the account amount, `DEBT_ACCOUNT_AMOUNT_REQUIRED` for the debt one).

Wire naming inside `/debts` (the debt currency is the headline there):
`amount_minor` = debt-currency amount, `account_amount_minor` = what moved on
the account (`+ account_currency` on read). In the DB that maps to
`debt_amount_minor` / `amount_minor` respectively. `TransactionRead` exposes
only `debt_id` (the badge/link); the debt amount is the debt view's business.

### Editing/deleting through `/transactions` — REFUSED
`PATCH`/`DELETE /transactions/{id}` on a row with `debt_id` → 422
`DEBT_MOVEMENT_READONLY`, checked right after the 404 (the "what the row IS
decides" rule of the transfer guards). Allowing with recompute would mean
re-deriving the debt rules (kind flip = direction flip, category/goal/snapshot
CHECK violations → 500, remaining going negative) inside a router that must not
know debts. One guard, one code; edits go through `/debts`. The MCP
`update_transaction`/`delete_transaction` tools get the same refusal.
`TransactionCreate`/`TransactionUpdate` do NOT carry any debt field, so
`create_transaction` cannot produce a half-debt by construction.

### Archived accounts, deposits, materializer, statement import
- Every movement write resolves its account through the EXISTING
  `transaction_guards` trio in the router: `require_own_account` (404
  `ACCOUNT_NOT_FOUND`) → `reject_archived` (422) → `reject_deposit_spending(
  is_transfer=False)` (422 `DEPOSIT_ACCOUNT_TRANSFER_ONLY` — a deposit ledger
  holds transfers only; unchanged rule). Stored accounts are not re-validated.
- Recurring materializer, statement-import apply, MCP `create_transaction`:
  untouched — they never set `debt_id` (defaults NULL).
- Statement-import REPLACE: its selection predicate (`apply.NOT_TRANSFER`,
  shared with the preview) widens to also spare `debt_id IS NOT NULL` rows —
  the same reason transfers are spared (the row is another entity's history;
  deleting it would silently reopen a debt and the bank's copy would come back
  as an unlinked expense, the exact "money vanishes as expense" problem this
  scope fixes). Preview gains `debt_movements_kept` next to `transfers_kept`.
  `replace_own` targeting a debt row → 422 `DEBT_MOVEMENT_READONLY` at the
  same two sites as `TRANSFER_REPLACE_FORBIDDEN`.
- CSV export: append ONE column `debt_id` (append-only format, pure function of
  the row); base cells are empty on debt rows exactly as on transfers.
- `?kind=` on `/transactions` keeps matching debt rows by their real kind; no
  `?debt_id=` filter (the detail embeds the history).

### Delete a whole debt — REAL DELETE with cascade
`DELETE /debts/{id}` → 204; `transactions.debt_id` is `ON DELETE CASCADE`, so
the movements go and balances revert in the same statement. Accounts/deposits
are archive-only because they are LEDGERS other rows point at; a debt owns a
handful of leaf rows and nothing points at it — and it is a small record a
human mistypes (wrong person, wrong direction), where "delete and redo" is the
honest fix (the no-direction-PATCH decision relies on it). Transactions already
have a real DELETE, so this is not a new destructive class. No archive flag.

### Idempotency for the two MCP writes
`POST /debts` and `POST /debts/{id}/repayments` accept optional `client_id`,
stored on the row they insert (principal / repayment) — the EXISTING partial
unique index `(user_id, client_id)` serves them. Replay → 200 with the stored
entity. The `_load_by_client_id` lookup is extracted to a shared helper at this
second consumer (the `tx_totals` extraction rule); each router keeps its own
IntegrityError recovery arm. Both tools get `managed_body client_id=uuid4`.

### Push + "coming up" — a fourth family
`push_jobs._read_snapshot` adds `debts = read_upcoming_due(session, user_id,
today=, through=)` from `services/debt_reads.py`: OPEN debts (remaining > 0 —
same grouped query) with `due_on BETWEEN today AND through`, names =
`counterparty` only. `DigestInput.debts: Sequence[str]`, `is_empty`/families
count/`nothing_due` updated, `_url` → `/debts` for a debts-only digest, mixed
stays `/transactions`; counter column `debts`. No amounts cross into
`DigestInput` (the pinned invariant). No `/debts/upcoming` endpoint: the web
applies the same inclusive date window to the cached list (`depositDeadlines.ts`
twin), and the `/transactions` "coming up" block merges the fourth list.

## Endpoints (`routers/debts.py`, mounted at `/debts`)
| Route | 2xx | Errors | MCP |
|---|---|---|---|
| `GET /debts` | 200 `DebtList` | — | `@mcp_tool list_debts` |
| `POST /debts` | 201 `DebtDetailRead` (200 on `client_id` replay) | 404 `ACCOUNT_NOT_FOUND`; 422 `ACCOUNT_ARCHIVED`, `DEPOSIT_ACCOUNT_TRANSFER_ONLY`, `DEBT_ACCOUNT_AMOUNT_REQUIRED`, `DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE`, `DEBT_DUE_BEFORE_OPENING` | `@mcp_tool create_debt` (managed `client_id`) |
| `GET /debts/{id}` | 200 `DebtDetailRead` | 404 `DEBT_NOT_FOUND` | `@mcp_tool get_debt` |
| `PATCH /debts/{id}` | 200 `DebtDetailRead` | 404 `DEBT_NOT_FOUND`/`ACCOUNT_NOT_FOUND`; 422 as POST + `DEBT_PRINCIPAL_BELOW_REPAID`, `AMOUNT_REQUIRED_ON_CURRENCY_CHANGE`, `DEBT_<FIELD>_REQUIRED` (null on NOT NULL) | `@mcp_tool update_debt` |
| `DELETE /debts/{id}` | 204 | 404 | `# MCP: no — cascades the movements, balances revert; delete_transaction stays the only irreversible tool` |
| `POST /debts/{id}/repayments` | 201 `DebtDetailRead` (200 on replay) | 404 both; 422 `DEBT_REPAYMENT_EXCEEDS_REMAINING`, `ACCOUNT_ARCHIVED`, `DEPOSIT_ACCOUNT_TRANSFER_ONLY`, `DEBT_ACCOUNT_AMOUNT_*` | `@mcp_tool record_repayment` (managed `client_id`) |
| `PATCH /debts/{id}/repayments/{rid}` | 200 `DebtDetailRead` | 404 `DEBT_NOT_FOUND` (both levels, the `IMPORT_NOT_FOUND` precedent); 422 as above | `# MCP: no — correction of a recorded money movement stays on the screen where remaining and balance are both visible; agents record, humans correct` |
| `DELETE /debts/{id}/repayments/{rid}` | 204 | 404 | `# MCP: no — irreversible` |

- `direction` and `currency` are ABSENT from `DebtUpdate` (immutable by schema,
  invisible to the MCP tool). `update_debt` curates `params=` for the money
  fields (prose: minor units, debt currency, omit = keep).
- Write bodies: POST — `direction, counterparty, currency, amount_minor,
  account_id, opened_on, account_amount_minor?, due_on?, note?, client_id?`;
  repayment — `amount_minor, account_id, occurred_at, account_amount_minor?,
  note?, client_id?`. `opened_on` required (the `occurred_at` rule).
  `due_on < opened_on` (effective pair) → 422 `DEBT_DUE_BEFORE_OPENING`.
  A repayment dated before `opened_on` is NOT refused (dates are the user's
  facts; transfers have no such rule either).
- POST creates TWO rows in one transaction (debt + principal row), the deposits
  shape; replay returns 200 with the stored debt.
- `DEBT_NOT_FOUND` via new top-level `debt_access.load_own_debt` (the
  `deposit_access` file, verbatim shape) — one query, one `None`, one 404 for
  foreign and missing; a repayment is loaded `WHERE id AND debt_id AND user_id`
  through the same `None` path.
- Errors go out as `DebtError` + the `_UNPROCESSABLE` anyOf. PAT allowlist grows
  by the five marked pairs (`test_pat_auth` 38→43, `NEVER_PAT` 27→30); tool
  counts 20→22 read, 35→40 full. CORS: no new verb.

### Read models (decided shape)
- `DebtRead` (list row): `id, direction, counterparty, currency, principal_minor,
  repaid_minor, remaining_minor, status, closed_on, opened_on, account_id,
  account_amount_minor, account_currency, due_on, note, repayments_count,
  created_at`. All money SERVER-computed, debt currency unless named `account_*`.
- `DebtDetailRead = DebtRead + repayments: list[DebtRepaymentRead]` (embedded,
  ordered `occurred_at, created_at, id`; a debt has a handful — one request per
  screen, no separate GET). `DebtRepaymentRead`: `id` (= transaction id),
  `occurred_at, account_id, account_currency, account_amount_minor,
  amount_minor, note`.
- `DebtList = { items: list[DebtRead], summary: DebtSummary }` —
  archived-inclusive style: ALL debts, no `?status=`; the web splits into the
  three groups. `DebtSummary`: `base_currency, owed_to_me_minor, i_owe_minor,
  owed_to_me_unconverted_count, i_owe_unconverted_count` — Σ `remaining` of
  OPEN debts converted debt→base at TODAY's nearest-previous rate
  (`profile_reads.read_base_currency` + `fx_lookup`/`convert_minor`, per-call
  rate cache as in `goal_plan_reads`); no rate → counted per side, never summed
  as zero. Fields on the list, not a second endpoint: one screen, one round
  trip, and `list_debts` answers "how much am I owed" in one call.

## Module structure
- `enums.py` — `DebtDirection`, `DebtRole`, `DebtStatus`.
- `models/debt.py` (+ the three columns, CHECKs and indexes in
  `models/transaction.py`; `models/push.py` counter).
- `domain/debts.py` (pure) — `movement_kind`, `remaining`, `status_of`,
  `closed_on`; no currency math.
- `services/debt_reads.py` — `debt_views` (one grouped query over the user's
  debt rows joined to `debts`, optional id filter; repayment rows for the
  detail), `debt_summary`, `read_upcoming_due` (push).
- `services/debt_writes.py` — `create_debt`, `update_principal`,
  `add_repayment`, `update_repayment`; the FOR UPDATE lock, the overpayment and
  currency-pair rules, kind stamping; raises `DebtWriteError(code)` (the
  `StatementApplyError` precedent) — NO `HTTPException` in services.
- `debt_access.py` (top-level) — `load_own_debt`, `load_own_repayment`.
- `routers/debts.py` — routes + HTTP only: account guards via
  `transaction_guards`, `DebtWriteError` → 422, serialization.
- Touch points elsewhere: `tx_totals` (predicate), `routers/transactions.py`
  (two guards), `transaction_wire`/`schemas/transaction.py` (`debt_id` on read),
  `tx_export_csv` (column), `statement_import/apply.py` + router (spare + refuse
  + preview field), `push_jobs`/`push_digest`/`models/push.py` (family), `app.py`
  (`include_router`), `tests/test_pat_auth.py`/`test_mcp_tools.py` pins,
  `docs/backend.md` (`/debts` entry, `tx_totals` sentence, 0017, codes).

Dependency direction: `routers/debts.py → debt_access, transaction_guards,
services/debt_{reads,writes}, schemas → domain/debts, models`. `push_jobs →
services/debt_reads`. `tx_totals → models`. No service imports a router or
raises HTTP; no new import into `routers/transactions.py` (its guard reads
`tx.debt_id`).

The one tricky predicate (`tx_totals`, renamed so the name stays honest):
```python
_NOT_TRANSFER_OR_DEBT = (Transaction.kind != TransactionKind.transfer.value) & Transaction.debt_id.is_(None)
```
applied in the same four passes; `apply.NOT_TRANSFER` gets the same widening
under its own name (it is the replace's selection, a different question).

## Trade-offs considered
- **Principal as the opening row vs a `principal_minor` column**: the column
  would be a second copy of the opening row's amount, updated by a dual write
  on every principal edit; the row is the single source and the `deposits`
  "no money on the metadata table" precedent. Cost: `opened_on`/`account_id`
  are read through a join — one query, tiny volumes.
- **Derived closed vs `closed_at`**: derived cannot drift and reopens itself on
  a deleted repayment; a maintained flag would need every movement write (and
  delete) to recompute it. Forgiveness/write-off is the one thing derived
  cannot express — deferred, not forgotten.
- **Forbid cross-currency accounts vs convert vs explicit second amount**:
  forbid breaks the realistic case (USD debt from a BYN card); server
  conversion stores a guess as the debt's truth and needs rate-missing and
  recompute branches; the explicit amount is the transfer precedent and one
  rule for all movements.
- **Refuse vs recompute on `/transactions` PATCH/DELETE**: one guard vs a copy
  of the debt rules in the wrong router.
- **Delete vs archive**: see above; also keeps "no direction change" cheap.
- **Embedded repayments vs separate GET; summary on the list vs its own route**:
  fewer round trips for a one-screen feature, tiny per-debt history.
- **`debt_amount_minor` always set vs NULL-when-equal**: a NULL-iff-equal CHECK
  would need the debt currency denormalized onto the row; always-set keeps the
  CHECK pair expressible and every reader on one column.

## What this does NOT decide
- Pydantic bounds/field names beyond the shapes above, helper names, the exact
  grouped SQL, the recovery-arm code, test list (FULL tier: migration + money
  + contract).
- Web plan: the three groups, forms, `/fx/convert` prefill in the cross-currency
  case, the `debtDeadlines` twin rule, badge/name index from the cached debts
  list for `debt_id` rows, i18n strings; digest body ordering of the fourth
  family (append after deposits).
- Left for later scopes: write-off/forgiveness of a remainder, multiple
  principals (running tabs), direction change in place, a reminder N days
  before `due_on`, paging/closed-debt retention on `GET /debts`, a `?debt_id=`
  transactions filter, mobile.
