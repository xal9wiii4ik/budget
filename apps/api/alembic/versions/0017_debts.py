"""debts: the metadata table, the transaction link trio and the fourth push counter

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-12

Three blocks, no backfill (debts architecture §"Migration steps"):

1. ``debts`` (+ ``ix_debts_user_id``) — metadata only. No amount column (the
   principal IS the opening movement row), no ``remaining`` and no ``closed``
   (both are arithmetic over the movements, computed on read). ``direction`` and
   ``currency`` carry the two CHECKs the model rebuilds from ``DebtDirection``.
2. ``transactions`` — the link trio ``debt_id``/``debt_role``/
   ``debt_amount_minor``, the FK, the NINE CHECKs that make half a debt movement
   unrepresentable, and two PARTIAL indexes (the read path's, and the unique one
   that allows AT MOST ONE principal per debt). Every CHECK here is written BY
   HAND and its name is byte-identical to the model's: alembic cannot diff CHECK
   constraints on an existing table (the 0016 rule), so a drift would be silent.
   No backfill — every existing row is correctly "not a debt" as NULL.
3. ``push_reminder_sends.debts`` — the fourth family's counter, appended after
   the existing three with ``server_default 0`` so existing claim rows stay
   readable.

**The downgrade is symmetric and deliberately keeps the money.** Dropping the
three columns leaves former debt movements as plain expense/income rows: the
account balances stay right (they were always read off ``kind`` + ``amount_minor``)
and the aggregates absorb them again. That is the honest rollback — balances are
the harder truth than a category of row — so the rows are NOT deleted, unlike the
0012/0016 downgrades where the row itself was unrepresentable in the older schema.
The test conftest tears its schema down with ``downgrade base``, so this path runs
on every suite.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "debts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("direction", sa.String(length=8), nullable=False),
        sa.Column("counterparty", sa.String(length=100), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("due_on", sa.Date(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # models/debt.py renders exactly this string from DebtDirection, so a drift
        # here is a red `alembic check`.
        sa.CheckConstraint(
            "direction IN ('lent', 'borrowed')",
            name=op.f("ck_debts_direction_valid"),
        ),
        sa.CheckConstraint(
            "currency ~ '^[A-Z]{3}$'", name=op.f("ck_debts_currency_format")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_debts_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_debts")),
    )
    op.create_index(op.f("ix_debts_user_id"), "debts", ["user_id"], unique=False)

    op.add_column("transactions", sa.Column("debt_id", sa.Uuid(), nullable=True))
    op.add_column(
        "transactions", sa.Column("debt_role", sa.String(length=16), nullable=True)
    )
    op.add_column(
        "transactions", sa.Column("debt_amount_minor", sa.BigInteger(), nullable=True)
    )
    op.create_foreign_key(
        op.f("fk_transactions_debts_debt_id"),
        "transactions",
        "debts",
        ["debt_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_check_constraint(
        op.f("ck_transactions_debt_link_trio"),
        "transactions",
        "(debt_id IS NULL) = (debt_role IS NULL) "
        "AND (debt_id IS NULL) = (debt_amount_minor IS NULL)",
    )
    op.create_check_constraint(
        op.f("ck_transactions_debt_role_valid"),
        "transactions",
        "debt_role IS NULL OR debt_role IN ('principal', 'repayment')",
    )
    op.create_check_constraint(
        op.f("ck_transactions_debt_amounts_positive"),
        "transactions",
        "debt_id IS NULL OR (amount_minor > 0 AND debt_amount_minor > 0)",
    )
    op.create_check_constraint(
        op.f("ck_transactions_debt_not_transfer"),
        "transactions",
        "debt_id IS NULL OR kind <> 'transfer'",
    )
    op.create_check_constraint(
        op.f("ck_transactions_debt_no_category"),
        "transactions",
        "debt_id IS NULL OR category_id IS NULL",
    )
    op.create_check_constraint(
        op.f("ck_transactions_debt_no_base_snapshot"),
        "transactions",
        "debt_id IS NULL OR (base_amount_minor IS NULL AND base_currency IS NULL)",
    )
    op.create_check_constraint(
        op.f("ck_transactions_debt_no_goal_item"),
        "transactions",
        "debt_id IS NULL OR goal_item_id IS NULL",
    )
    op.create_check_constraint(
        op.f("ck_transactions_debt_no_original"),
        "transactions",
        "debt_id IS NULL OR original_amount_minor IS NULL",
    )
    op.create_check_constraint(
        op.f("ck_transactions_debt_no_recurring"),
        "transactions",
        "debt_id IS NULL OR recurring_template_id IS NULL",
    )
    op.create_index(
        "ix_transactions_debt_id",
        "transactions",
        ["debt_id"],
        unique=False,
        postgresql_where=sa.text("debt_id IS NOT NULL"),
    )
    op.create_index(
        "uq_transactions_debt_principal",
        "transactions",
        ["debt_id"],
        unique=True,
        postgresql_where=sa.text("debt_role = 'principal'"),
    )

    op.add_column(
        "push_reminder_sends",
        sa.Column(
            "debts", sa.SmallInteger(), server_default=sa.text("0"), nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_column("push_reminder_sends", "debts")

    op.drop_index("uq_transactions_debt_principal", table_name="transactions")
    op.drop_index("ix_transactions_debt_id", table_name="transactions")
    for name in (
        "ck_transactions_debt_no_recurring",
        "ck_transactions_debt_no_original",
        "ck_transactions_debt_no_goal_item",
        "ck_transactions_debt_no_base_snapshot",
        "ck_transactions_debt_no_category",
        "ck_transactions_debt_not_transfer",
        "ck_transactions_debt_amounts_positive",
        "ck_transactions_debt_role_valid",
        "ck_transactions_debt_link_trio",
    ):
        op.drop_constraint(op.f(name), "transactions", type_="check")
    op.drop_constraint(
        op.f("fk_transactions_debts_debt_id"), "transactions", type_="foreignkey"
    )
    # The movements SURVIVE as plain expense/income rows (see the module docstring):
    # their balances were never derived from these columns, so keeping them is the
    # honest rollback. Only the link is dropped.
    op.drop_column("transactions", "debt_amount_minor")
    op.drop_column("transactions", "debt_role")
    op.drop_column("transactions", "debt_id")

    op.drop_index(op.f("ix_debts_user_id"), table_name="debts")
    op.drop_table("debts")
