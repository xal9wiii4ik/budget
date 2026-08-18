"""recurring templates and category limits

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-18

ALL DDL for the recurring-and-limits scope in one migration (architecture D19):
the ``recurring_templates`` table (D2), ``category_limits`` (D14), and the
``transactions.recurring_template_id`` attribution FK (D7). Pure DDL — no rows
seeded and no backfill of the new column (every existing row is correctly "not
from a template" as NULL), with a fully symmetric downgrade (mirroring 0004/0005;
the test conftest tears its schema down with ``downgrade base``). No index beyond
``recurring_templates.user_id`` and the primary keys themselves —
``recurring_templates`` has a plain ``id`` PK; only ``category_limits`` is
composite, and its leading ``user_id`` covers the list-by-user read (D13).
The ``kind`` / ``interval_unit`` CHECKs are byte-identical to the model's
enum-built constraints (TransactionKind / RecurrenceUnit definition order);
``alembic check`` guards the drift.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "recurring_templates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("merchant", sa.String(length=255), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("interval_unit", sa.String(length=8), nullable=False),
        sa.Column("day_of_month", sa.SmallInteger(), nullable=True),
        sa.Column("weekday", sa.SmallInteger(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column(
            "paused",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column("last_materialized_on", sa.Date(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "amount_minor > 0",
            name=op.f("ck_recurring_templates_amount_minor_positive"),
        ),
        sa.CheckConstraint(
            "kind IN ('expense', 'income')",
            name=op.f("ck_recurring_templates_kind_valid"),
        ),
        sa.CheckConstraint(
            "currency ~ '^[A-Z]{3}$'",
            name=op.f("ck_recurring_templates_currency_format"),
        ),
        sa.CheckConstraint(
            "interval_unit IN ('month', 'week')",
            name=op.f("ck_recurring_templates_interval_unit_valid"),
        ),
        sa.CheckConstraint(
            "day_of_month BETWEEN 1 AND 31",
            name=op.f("ck_recurring_templates_day_of_month_range"),
        ),
        sa.CheckConstraint(
            "weekday BETWEEN 0 AND 6",
            name=op.f("ck_recurring_templates_weekday_range"),
        ),
        # Both-or-neither, per unit: an inconsistent unit/anchor pair is
        # structurally unrepresentable (D2), which is what the domain's due-date
        # math and the materialization job rely on.
        sa.CheckConstraint(
            "(interval_unit = 'month') = (day_of_month IS NOT NULL) "
            "AND (interval_unit = 'week') = (weekday IS NOT NULL)",
            name=op.f("ck_recurring_templates_anchor_matches_unit"),
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_recurring_templates_categories_category_id"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_recurring_templates_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recurring_templates")),
    )
    op.create_index(
        op.f("ix_recurring_templates_user_id"),
        "recurring_templates",
        ["user_id"],
        unique=False,
    )
    op.create_table(
        "category_limits",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "amount_minor > 0", name=op.f("ck_category_limits_amount_minor_positive")
        ),
        sa.CheckConstraint(
            "currency ~ '^[A-Z]{3}$'", name=op.f("ck_category_limits_currency_format")
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_category_limits_categories_category_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_category_limits_users_user_id"),
            ondelete="CASCADE",
        ),
        # Composite natural PK: the uniqueness constraint AND the upsert conflict
        # target; its leading user_id covers the list-by-user read (D14/D13).
        sa.PrimaryKeyConstraint(
            "user_id", "category_id", name=op.f("pk_category_limits")
        ),
    )
    op.add_column(
        "transactions", sa.Column("recurring_template_id", sa.Uuid(), nullable=True)
    )
    op.create_foreign_key(
        op.f("fk_transactions_recurring_templates_recurring_template_id"),
        "transactions",
        "recurring_templates",
        ["recurring_template_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_transactions_recurring_templates_recurring_template_id"),
        "transactions",
        type_="foreignkey",
    )
    op.drop_column("transactions", "recurring_template_id")
    op.drop_table("category_limits")
    op.drop_index(
        op.f("ix_recurring_templates_user_id"), table_name="recurring_templates"
    )
    op.drop_table("recurring_templates")
