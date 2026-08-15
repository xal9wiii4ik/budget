"""exchange rates, goals and transaction base snapshot

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-15

ALL DDL for the currencies-goals scope in one migration (architecture D14): the
``exchange_rates`` table (D2), ``goals`` + ``goal_contributions`` (D10), and the
``transactions`` base-snapshot pair (D5). Pure DDL — no rows seeded, no backfill
of the snapshot columns (they stay NULL until a write path recomputes them), and
a fully symmetric downgrade (mirroring 0002/0004). ``alembic check`` guards drift
against the models.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "exchange_rates",
        sa.Column("base", sa.String(length=3), nullable=False),
        sa.Column("quote", sa.String(length=3), nullable=False),
        sa.Column("as_of_date", sa.Date(), nullable=False),
        sa.Column("rate", sa.Numeric(precision=18, scale=8), nullable=False),
        sa.Column("provider", sa.String(length=16), nullable=False),
        sa.Column(
            "fetched_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("rate > 0", name=op.f("ck_exchange_rates_rate_positive")),
        sa.CheckConstraint(
            "base ~ '^[A-Z]{3}$'", name=op.f("ck_exchange_rates_base_format")
        ),
        sa.CheckConstraint(
            "quote ~ '^[A-Z]{3}$'", name=op.f("ck_exchange_rates_quote_format")
        ),
        # No secondary index: this PK btree IS the nearest-previous lookup index (D2).
        sa.PrimaryKeyConstraint(
            "base", "quote", "as_of_date", name=op.f("pk_exchange_rates")
        ),
    )
    op.create_table(
        "goals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("target_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("deadline", sa.Date(), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False),
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
        sa.CheckConstraint(
            "target_minor > 0", name=op.f("ck_goals_target_minor_positive")
        ),
        sa.CheckConstraint(
            "currency ~ '^[A-Z]{3}$'", name=op.f("ck_goals_currency_format")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_goals_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goals")),
    )
    op.create_index(op.f("ix_goals_user_id"), "goals", ["user_id"], unique=False)
    op.create_table(
        "goal_contributions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("goal_id", sa.Uuid(), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("occurred_at", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "amount_minor <> 0",
            name=op.f("ck_goal_contributions_amount_minor_nonzero"),
        ),
        sa.ForeignKeyConstraint(
            ["goal_id"],
            ["goals.id"],
            name=op.f("fk_goal_contributions_goals_goal_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goal_contributions")),
    )
    op.create_index(
        "ix_goal_contributions_goal_id_occurred_at",
        "goal_contributions",
        ["goal_id", "occurred_at"],
        unique=False,
    )
    op.add_column(
        "transactions", sa.Column("base_amount_minor", sa.BigInteger(), nullable=True)
    )
    op.add_column(
        "transactions", sa.Column("base_currency", sa.String(length=3), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_transactions_base_snapshot_pair"),
        "transactions",
        "(base_amount_minor IS NULL) = (base_currency IS NULL)",
    )
    op.create_check_constraint(
        op.f("ck_transactions_base_amount_minor_non_negative"),
        "transactions",
        "base_amount_minor >= 0",
    )
    op.create_check_constraint(
        op.f("ck_transactions_base_currency_format"),
        "transactions",
        "base_currency ~ '^[A-Z]{3}$'",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_transactions_base_currency_format"), "transactions", type_="check"
    )
    op.drop_constraint(
        op.f("ck_transactions_base_amount_minor_non_negative"),
        "transactions",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_transactions_base_snapshot_pair"), "transactions", type_="check"
    )
    op.drop_column("transactions", "base_currency")
    op.drop_column("transactions", "base_amount_minor")
    op.drop_index(
        "ix_goal_contributions_goal_id_occurred_at", table_name="goal_contributions"
    )
    op.drop_table("goal_contributions")
    op.drop_index(op.f("ix_goals_user_id"), table_name="goals")
    op.drop_table("goals")
    op.drop_table("exchange_rates")
