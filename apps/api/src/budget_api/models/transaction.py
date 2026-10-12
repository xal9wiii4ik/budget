"""Transaction model — magnitude + NOT NULL kind (architecture §1 verdict (b)).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
this table serves no fastapi-users protocol.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import DebtRole, TransactionKind
from budget_api.models.base import Base

# Rebuilt from the shared enum so the enum is the single source for both model and
# schema. The rendered SQL MUST stay byte-identical to migration 0008, which drops
# and recreates the 0002 constraint under the SAME name with the appended third
# value (``kind IN ('expense', 'income', 'transfer')``); TransactionKind's
# definition order guarantees this.
_KIND_VALUES = ", ".join(f"'{k.value}'" for k in TransactionKind)
#: The one string this module compares ``kind`` against in SQL. Spelled once so a
#: transfer CHECK can never drift from the enum value the router writes.
_TRANSFER = TransactionKind.transfer.value
#: Rebuilt from DebtRole for the same reason ``_KIND_VALUES`` is rebuilt from
#: TransactionKind: the enum is the single source, and the rendered SQL must stay
#: byte-identical to migration 0017.
_DEBT_ROLE_VALUES = ", ".join(f"'{r.value}'" for r in DebtRole)


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint("amount_minor >= 0", name="amount_minor_non_negative"),
        CheckConstraint(f"kind IN ({_KIND_VALUES})", name="kind_valid"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
        # Base-currency snapshot pair (D5): both set or both NULL, never half.
        CheckConstraint(
            "(base_amount_minor IS NULL) = (base_currency IS NULL)",
            name="base_snapshot_pair",
        ),
        # >= 0, not >= 1: an auto-computed snapshot of a tiny amount can legally
        # quantize to 0 minor units (e.g. 1 minor RUB -> USD). Only *user-supplied*
        # overrides are ge=1, and that guard lives at the schema layer.
        CheckConstraint(
            "base_amount_minor >= 0", name="base_amount_minor_non_negative"
        ),
        CheckConstraint("base_currency ~ '^[A-Z]{3}$'", name="base_currency_format"),
        # ---- transfer invariants (architecture §3) ---------------------------------
        # A transfer is ONE row carrying BOTH legs. "Half a transfer" is made
        # UNREPRESENTABLE here, not merely rejected by the router: the constraints
        # below are what guarantee that no code path — router, materializer, MCP,
        # psql — can leave a source without a target or a target without an amount.
        #
        # kind='transfer' ⇔ a counter account exists (both directions in one CHECK).
        CheckConstraint(
            f"(kind = '{_TRANSFER}') = (counter_account_id IS NOT NULL)",
            name="transfer_has_counter_account",
        ),
        # …and the counter trio moves together: account, amount and the currency the
        # amount is denominated in (C-3) are all set or all NULL.
        CheckConstraint(
            "(counter_account_id IS NULL) = (counter_amount_minor IS NULL) "
            "AND (counter_account_id IS NULL) = (counter_currency IS NULL)",
            name="counter_pair",
        ),
        # > 0, not >= 0 like amount_minor: the counter amount is always user-supplied
        # and never an auto-computed snapshot that may quantize to zero.
        CheckConstraint(
            "counter_amount_minor IS NULL OR counter_amount_minor > 0",
            name="counter_amount_minor_positive",
        ),
        CheckConstraint(
            "counter_account_id IS NULL OR counter_account_id <> account_id",
            name="counter_account_differs",
        ),
        CheckConstraint(
            "counter_currency ~ '^[A-Z]{3}$'", name="counter_currency_format"
        ),
        # A transfer moves money between the user's own accounts: it is not spending
        # and not income, so it can carry no category (architecture §6 — it must never
        # reach a per-category aggregate).
        CheckConstraint(
            f"kind <> '{_TRANSFER}' OR category_id IS NULL",
            name="transfer_has_no_category",
        ),
        # …and no base-currency snapshot (architecture §5): a transfer is excluded
        # from every converted aggregate, so a snapshot would be a number nobody
        # reads and everybody could accidentally sum.
        CheckConstraint(
            f"kind <> '{_TRANSFER}' "
            "OR (base_amount_minor IS NULL AND base_currency IS NULL)",
            name="transfer_no_base_snapshot",
        ),
        # ---- original leg (S1 architecture §2) -------------------------------------
        # What the purchase actually cost in the merchant's currency, next to
        # ``amount_minor``/``currency`` — which stay what the ACCOUNT was debited
        # (the bank's own rate is baked into that number, which is why no aggregate
        # here ever re-derives it). "Half an original" is made UNREPRESENTABLE the
        # same way half a transfer is: by CHECKs, not by router goodwill.
        CheckConstraint(
            "(original_amount_minor IS NULL) = (original_currency IS NULL)",
            name="original_pair",
        ),
        # > 0, not >= 0 like amount_minor: the original amount is ALWAYS
        # user-supplied and never an auto-computed value that may quantize to zero
        # (the counter_amount_minor_positive twin).
        CheckConstraint(
            "original_amount_minor IS NULL OR original_amount_minor > 0",
            name="original_amount_minor_positive",
        ),
        CheckConstraint(
            "original_currency ~ '^[A-Z]{3}$'", name="original_currency_format"
        ),
        # Equality is FORBIDDEN, not normalized: NULL already means "the purchase
        # was in the account's own currency", and a second spelling of that one fact
        # would fork ``original_rate``, the CSV row and every PATCH branch.
        CheckConstraint(
            "original_currency IS NULL OR original_currency <> currency",
            name="original_currency_differs",
        ),
        # A transfer already carries its second leg in the counter trio; an original
        # leg on top of it would be a third, unreconcilable amount.
        CheckConstraint(
            f"kind <> '{_TRANSFER}' "
            "OR (original_amount_minor IS NULL AND original_currency IS NULL)",
            name="transfer_no_original",
        ),
        CheckConstraint("country ~ '^[A-Z]{2}$'", name="country_format"),
        # ---- the plan link (goal-planner §3) ---------------------------------------
        # "Paid" is money that LEFT: a transfer moves the user's own money between
        # their own accounts (and is excluded from every aggregate in tx_totals by
        # construction), and income is not a payment at all. v1 introduces no signed
        # "paid minus refund" arithmetic — a refund is handled by unlinking or
        # editing the row. The router refuses both directions with 422
        # GOAL_ITEM_EXPENSE_ONLY; this CHECK is what makes it unrepresentable.
        CheckConstraint(
            f"goal_item_id IS NULL OR kind = '{TransactionKind.expense.value}'",
            name="goal_item_expense_only",
        ),
        # ---- the debt link (debts architecture §Tables) -----------------------------
        # A debt movement is an ORDINARY expense/income row carrying this trio: the
        # debt it belongs to, whether it is the opening amount or a repayment, and
        # the same movement expressed in the DEBT's currency (the account may be
        # denominated in another one). "Half a debt movement" is made UNREPRESENTABLE
        # here, exactly as half a transfer is: the CHECKs below are what guarantee
        # that no code path — router, materializer, statement import, psql — can
        # produce a row the debt reads cannot interpret.
        #
        # The trio moves together: all three set, or all three NULL.
        CheckConstraint(
            "(debt_id IS NULL) = (debt_role IS NULL) "
            "AND (debt_id IS NULL) = (debt_amount_minor IS NULL)",
            name="debt_link_trio",
        ),
        CheckConstraint(
            f"debt_role IS NULL OR debt_role IN ({_DEBT_ROLE_VALUES})",
            name="debt_role_valid",
        ),
        # > 0 on BOTH amounts, not >= 0 like amount_minor: a debt movement is always
        # user-supplied (never an auto-computed snapshot that may quantize to zero),
        # and a zero movement would be a row that moves no money and repays nothing.
        CheckConstraint(
            "debt_id IS NULL OR (amount_minor > 0 AND debt_amount_minor > 0)",
            name="debt_amounts_positive",
        ),
        # A transfer already carries two legs of the user's OWN money; a debt
        # movement is money crossing to or from a person, which is why it is an
        # ordinary expense/income row instead (and why its sign falls out of
        # ``account_balances`` with no new rule).
        CheckConstraint(
            f"debt_id IS NULL OR kind <> '{_TRANSFER}'", name="debt_not_transfer"
        ),
        # Lending is not spending and getting a loan is not income (task.md §3), so a
        # debt movement is excluded from every income/expense aggregate
        # (``tx_totals``) — which means a category on it would be a category nobody
        # can ever total, and a base-currency snapshot a number nobody reads.
        CheckConstraint(
            "debt_id IS NULL OR category_id IS NULL", name="debt_no_category"
        ),
        CheckConstraint(
            "debt_id IS NULL OR (base_amount_minor IS NULL AND base_currency IS NULL)",
            name="debt_no_base_snapshot",
        ),
        # …and for the same reason it is not a payment of a goal's plan node
        # ("paid" is money that left for a purchase), it carries no display-only
        # original leg (the second amount it DOES carry is debt_amount_minor), and
        # it is never materialized from a recurring template.
        CheckConstraint(
            "debt_id IS NULL OR goal_item_id IS NULL", name="debt_no_goal_item"
        ),
        CheckConstraint(
            "debt_id IS NULL OR original_amount_minor IS NULL", name="debt_no_original"
        ),
        CheckConstraint(
            "debt_id IS NULL OR recurring_template_id IS NULL",
            name="debt_no_recurring",
        ),
        Index("ix_transactions_user_id_occurred_at", "user_id", "occurred_at"),
        # PARTIAL: the overwhelming majority of rows carry no plan link, and this
        # index exists for exactly two readers — the "paid" rollup and the
        # ``?goal_item_id=`` subtree filter. An explicit name is mandatory for the
        # same reason as the idempotency index below: a partial index cannot be
        # expressed as a constraint, and the "ix" convention would render a
        # colliding name.
        Index(
            "ix_transactions_goal_item_id",
            "goal_item_id",
            postgresql_where=text("goal_item_id IS NOT NULL"),
        ),
        # Per-user idempotency key (B-1). PARTIAL: pre-B-1 rows and every row
        # created without a client_id carry NULL and are exempt. Per-USER scoping
        # means one user's uuid can never collide with another's (no cross-user
        # oracle). An explicit name is mandatory: a partial unique index cannot be
        # a UniqueConstraint in Postgres, and Base's "ix" convention would render
        # ix_transactions_user_id, which is both wrong and collision-prone.
        Index(
            "uq_transactions_user_id_client_id",
            "user_id",
            "client_id",
            unique=True,
            postgresql_where=text("client_id IS NOT NULL"),
        ),
        # PARTIAL, for the same reason the plan-link index is: almost no row is a
        # debt movement, and this index has exactly one reader — the grouped totals
        # of ``services/debt_reads.py``. Explicit name (the "ix" convention would
        # render a colliding one) because a partial index is not a constraint.
        Index(
            "ix_transactions_debt_id",
            "debt_id",
            postgresql_where=text("debt_id IS NOT NULL"),
        ),
        # AT MOST ONE principal per debt, as a database fact rather than a promise
        # of the single writer: the principal row IS the debt's amount, so a second
        # one would silently double what is owed. (Exactly one is the writer's job —
        # it inserts the row in the same transaction as the ``debts`` row.)
        Index(
            "uq_transactions_debt_principal",
            "debt_id",
            unique=True,
            postgresql_where=text(f"debt_role = '{DebtRole.principal.value}'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE")
    )
    # The account the money left (expense/transfer) or landed on (income). NOT NULL:
    # every row belongs to exactly one account, and ``currency`` below is stamped
    # FROM it (architecture §4), which is what keeps a balance plain integer
    # arithmetic. CASCADE, not RESTRICT: an account is only ever hard-deleted by the
    # user cascade, where the transactions die anyway.
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("accounts.id", ondelete="CASCADE")
    )
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(16))
    currency: Mapped[str] = mapped_column(String(3))
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    occurred_at: Mapped[date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    receipt_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("receipts.id", ondelete="SET NULL"), nullable=True
    )
    merchant: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Attribution only (D7): every display value of a materialized row is COPIED
    # at materialization, so a template edit can never retro-write history and a
    # template DELETE sets this to NULL without touching the money. No index (D13).
    recurring_template_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("recurring_templates.id", ondelete="SET NULL"), nullable=True
    )
    # Converted-amount snapshot in the profile's base currency at write time (D5).
    # Nullable pair: NULL/NULL means "no rate was available" (never a guess).
    base_amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    base_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    # The transfer's TARGET leg (architecture §3) — NULL on every expense/income row.
    # ``counter_amount_minor`` is what actually landed, in the target account's own
    # currency (the user's real rate, not ours), and ``counter_currency`` is that
    # currency denormalized off the target account (C-3). Denormalized on purpose:
    # the account's currency is immutable, so it cannot drift, and it keeps
    # ``transaction_wire``/``tx_export_csv`` pure functions of the row — no join to
    # render the second leg at its own exponent, and none on the idempotent-replay arm.
    counter_account_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=True
    )
    counter_amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    counter_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    # The purchase as the MERCHANT priced it (S1 architecture §1) — NULL/NULL when
    # it was priced in the account's own currency. Display-only: no balance, no
    # base-currency snapshot and no aggregate reads these, because the settlement
    # pair above is what actually left the account. The reported rate between the
    # two is derived on read (``original_rate``), never stored — a stored rate could
    # only ever disagree with the two amounts after an edit.
    original_amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    original_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    # Where the money was spent (S2), ISO-3166-1 alpha-2. Free-standing: it is not
    # derived from either currency (a EUR purchase happens in a dozen countries)
    # and nothing infers one from the other. No index (no filter reads it yet).
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    # The plan node this payment belongs to (goal-planner §3), NULL for every row
    # that is not part of a goal's plan. A SCALAR column rather than a link table:
    # "one transaction belongs to at most ONE node" is then true BY CONSTRUCTION —
    # the shape of the data, not a UNIQUE that a later migration could drop — and
    # double-counted "paid" is the money risk of that whole scope. ON DELETE SET
    # NULL: deleting a node UNLINKS its payments and never deletes them.
    goal_item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("goal_items.id", ondelete="SET NULL"), nullable=True
    )
    # The debt this row is a movement of (debts architecture §Tables), NULL on
    # every ordinary row. ``debt_role`` says WHICH movement it is, and
    # ``debt_amount_minor`` is the same movement in the DEBT's currency —
    # ALWAYS set on a debt row (equal to ``amount_minor`` when the account is
    # denominated in the debt's currency), so every reader of "how much is still
    # owed" sums ONE column with no COALESCE. ON DELETE CASCADE: deleting a debt
    # takes its movements with it and the account balances revert in the same
    # statement (architecture §"Delete a whole debt").
    debt_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("debts.id", ondelete="CASCADE"), nullable=True
    )
    debt_role: Mapped[str | None] = mapped_column(String(16), nullable=True)
    debt_amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Client-generated idempotency key (B-1), NULL for every caller that does not
    # send one. Write-side only: it is absent from TransactionRead — a dedup
    # token is not a read-model fact.
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
