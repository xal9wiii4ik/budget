"""accounts and transfers

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-19

ALL DDL for the accounts-and-transfers scope in one migration (the 0006/0007
precedent), in three blocks:

1. ``accounts`` (architecture §1) — the categories-shaped table: boolean
   ``archived``, no unique(user_id, name), but ``user_id`` NOT NULL (there are no
   shared system accounts). The balance is NOT a column: it is summed on read from
   the transaction legs (§2).
2. ``transactions`` — the NOT NULL ``account_id`` FK plus the transfer's target
   leg (``counter_account_id`` / ``counter_amount_minor`` / ``counter_currency``),
   the rebuilt ``kind`` CHECK, and the seven CHECKs that make "half a transfer"
   UNREPRESENTABLE (§3/§5).
3. ``recurring_templates.account_id`` NOT NULL FK (§7) — the materializer books a
   transaction, and that transaction now needs an account.

The two NOT NULL columns carry NO server_default and NO backfill: both tables are
EMPTY at the time this migration runs (the data reset of §11 is performed before
it). That is deliberate — a default would silently attach every future row to one
arbitrary account, which is worse than a failed migration.

``ck_transactions_kind_valid`` is DROPPED and recreated under the very same name
with the appended third value, so the rendered SQL stays byte-identical to the
model's enum-built constraint (TransactionKind definition order).
``ck_recurring_templates_kind_valid`` is deliberately NOT touched: recurring
transfers are unsupported in v1, which is why the templates model pins its tuple
instead of iterating the enum (conflict C-1).

Pure DDL with a fully symmetric downgrade (the test conftest tears its schema down
with ``downgrade base``).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "accounts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("type", sa.String(length=16), nullable=False),
        sa.Column(
            "starting_balance_minor",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "archived",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # No sign CHECK on starting_balance_minor: a credit card legitimately
        # starts in the red (architecture §1).
        sa.CheckConstraint(
            "type IN ('card', 'cash')", name=op.f("ck_accounts_type_valid")
        ),
        sa.CheckConstraint(
            "currency ~ '^[A-Z]{3}$'", name=op.f("ck_accounts_currency_format")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_accounts_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_accounts")),
    )
    op.create_index(op.f("ix_accounts_user_id"), "accounts", ["user_id"], unique=False)

    op.add_column("transactions", sa.Column("account_id", sa.Uuid(), nullable=False))
    op.add_column(
        "transactions", sa.Column("counter_account_id", sa.Uuid(), nullable=True)
    )
    op.add_column(
        "transactions",
        sa.Column("counter_amount_minor", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "transactions",
        sa.Column("counter_currency", sa.String(length=3), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_transactions_accounts_account_id"),
        "transactions",
        "accounts",
        ["account_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        op.f("fk_transactions_accounts_counter_account_id"),
        "transactions",
        "accounts",
        ["counter_account_id"],
        ["id"],
        ondelete="CASCADE",
    )
    # Same NAME as in 0002, one more accepted value — the model renders exactly
    # this string from TransactionKind, so a drift here is a red `alembic check`.
    op.drop_constraint(
        op.f("ck_transactions_kind_valid"), "transactions", type_="check"
    )
    op.create_check_constraint(
        op.f("ck_transactions_kind_valid"),
        "transactions",
        "kind IN ('expense', 'income', 'transfer')",
    )
    op.create_check_constraint(
        op.f("ck_transactions_transfer_has_counter_account"),
        "transactions",
        "(kind = 'transfer') = (counter_account_id IS NOT NULL)",
    )
    op.create_check_constraint(
        op.f("ck_transactions_counter_pair"),
        "transactions",
        "(counter_account_id IS NULL) = (counter_amount_minor IS NULL) "
        "AND (counter_account_id IS NULL) = (counter_currency IS NULL)",
    )
    op.create_check_constraint(
        op.f("ck_transactions_counter_amount_minor_positive"),
        "transactions",
        "counter_amount_minor IS NULL OR counter_amount_minor > 0",
    )
    op.create_check_constraint(
        op.f("ck_transactions_counter_account_differs"),
        "transactions",
        "counter_account_id IS NULL OR counter_account_id <> account_id",
    )
    op.create_check_constraint(
        op.f("ck_transactions_counter_currency_format"),
        "transactions",
        "counter_currency ~ '^[A-Z]{3}$'",
    )
    op.create_check_constraint(
        op.f("ck_transactions_transfer_has_no_category"),
        "transactions",
        "kind <> 'transfer' OR category_id IS NULL",
    )
    op.create_check_constraint(
        op.f("ck_transactions_transfer_no_base_snapshot"),
        "transactions",
        "kind <> 'transfer' OR (base_amount_minor IS NULL AND base_currency IS NULL)",
    )

    op.add_column(
        "recurring_templates", sa.Column("account_id", sa.Uuid(), nullable=False)
    )
    op.create_foreign_key(
        op.f("fk_recurring_templates_accounts_account_id"),
        "recurring_templates",
        "accounts",
        ["account_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_recurring_templates_accounts_account_id"),
        "recurring_templates",
        type_="foreignkey",
    )
    op.drop_column("recurring_templates", "account_id")

    for name in (
        "transfer_no_base_snapshot",
        "transfer_has_no_category",
        "counter_currency_format",
        "counter_account_differs",
        "counter_amount_minor_positive",
        "counter_pair",
        "transfer_has_counter_account",
    ):
        op.drop_constraint(
            op.f(f"ck_transactions_{name}"), "transactions", type_="check"
        )
    op.drop_constraint(
        op.f("ck_transactions_kind_valid"), "transactions", type_="check"
    )
    # A transfer is UNREPRESENTABLE in the pre-0008 schema: its target leg lives in
    # the three columns dropped below, so a surviving row would be a source without
    # a destination — money that left an account and arrived nowhere. The rows go
    # with their columns, which is what lets the 0002 CHECK be re-applied.
    op.execute("DELETE FROM transactions WHERE kind = 'transfer'")
    op.create_check_constraint(
        op.f("ck_transactions_kind_valid"),
        "transactions",
        "kind IN ('expense', 'income')",
    )
    op.drop_constraint(
        op.f("fk_transactions_accounts_counter_account_id"),
        "transactions",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("fk_transactions_accounts_account_id"), "transactions", type_="foreignkey"
    )
    op.drop_column("transactions", "counter_currency")
    op.drop_column("transactions", "counter_amount_minor")
    op.drop_column("transactions", "counter_account_id")
    op.drop_column("transactions", "account_id")

    op.drop_index(op.f("ix_accounts_user_id"), table_name="accounts")
    op.drop_table("accounts")
