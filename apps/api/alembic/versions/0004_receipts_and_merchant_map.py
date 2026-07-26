"""receipts and merchant map

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-26

Receipts OCR schema (roadmap 2.1-2.5, architecture D1/D2/D3): the ``receipts``
table (async upload+parse lifecycle), the ``transactions.receipt_id`` /
``transactions.merchant`` carry-forward columns (D2), and the
``merchant_category_map`` learned-mapping table (D3). Pure DDL — no rows seeded,
fully symmetric downgrade (mirroring 0002). The ``receipts.status`` CHECK is
byte-identical to the model's enum-built constraint (ReceiptStatus definition
order); ``alembic check`` guards the drift.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "receipts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("storage_path", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column(
            "parsed_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("error", sa.String(length=64), nullable=True),
        sa.Column("parse_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'processing', 'parsed', 'failed')",
            name=op.f("ck_receipts_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_receipts_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_receipts")),
    )
    op.create_index(op.f("ix_receipts_user_id"), "receipts", ["user_id"], unique=False)
    op.add_column("transactions", sa.Column("receipt_id", sa.Uuid(), nullable=True))
    op.add_column(
        "transactions", sa.Column("merchant", sa.String(length=255), nullable=True)
    )
    op.create_foreign_key(
        op.f("fk_transactions_receipts_receipt_id"),
        "transactions",
        "receipts",
        ["receipt_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_table(
        "merchant_category_map",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("merchant_norm", sa.String(length=255), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_merchant_category_map_categories_category_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_merchant_category_map_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "user_id", "merchant_norm", name=op.f("pk_merchant_category_map")
        ),
    )


def downgrade() -> None:
    op.drop_table("merchant_category_map")
    op.drop_constraint(
        op.f("fk_transactions_receipts_receipt_id"),
        "transactions",
        type_="foreignkey",
    )
    op.drop_column("transactions", "merchant")
    op.drop_column("transactions", "receipt_id")
    op.drop_index(op.f("ix_receipts_user_id"), table_name="receipts")
    op.drop_table("receipts")
