"""transaction_embeddings: the pull-built search index

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-19

ONE new table and nothing else — ``transactions`` is not touched, because
indexing is PULL (rag architecture D-I1): no writer learns about this table, and
a row is current iff its ``model`` stamp and ``text_hash`` still match what the
live embedder and ``services/tx_text.py`` would produce.

**No backfill, deliberately.** The boot run-now sweep IS the backfill (amendment
A2), and it is bounded by ``EMBEDDINGS_SWEEP_MAX_ROWS`` — a migration that
embedded the ledger inline would need the model inside the alembic process and
would turn a deploy into a multi-minute inference job.

The three CHECKs are written BY HAND and their names are byte-identical to
``models/transaction_embedding.py``: alembic cannot diff CHECK constraints on a
table (the 0016/0018/0019 rule), so a drift would be silent and
``tests/test_core_model.py`` is the only alarm.

Downgrade drops the table whole. Nothing is lost that cannot be recomputed: this
table holds derived data only, and re-running the sweep rebuilds all of it.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "transaction_embeddings",
        sa.Column("transaction_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("text_hash", sa.String(length=64), nullable=False),
        sa.Column("vector", sa.LargeBinary(), nullable=False),
        sa.Column(
            "embedded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # 384 float32, little-endian. models/transaction_embedding.py renders
        # exactly these three strings, so a drift here is a red `alembic check`
        # only for the columns — the CHECKs themselves are pinned by the suite.
        sa.CheckConstraint(
            "octet_length(vector) = 1536",
            name=op.f("ck_transaction_embeddings_vector_dim"),
        ),
        sa.CheckConstraint(
            "text_hash ~ '^[0-9a-f]{64}$'",
            name=op.f("ck_transaction_embeddings_text_hash_format"),
        ),
        sa.CheckConstraint(
            "model <> ''", name=op.f("ck_transaction_embeddings_model_present")
        ),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["transactions.id"],
            name=op.f("fk_transaction_embeddings_transactions_transaction_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_transaction_embeddings_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "transaction_id", name=op.f("pk_transaction_embeddings")
        ),
    )
    op.create_index(
        op.f("ix_transaction_embeddings_user_id"),
        "transaction_embeddings",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_transaction_embeddings_user_id"),
        table_name="transaction_embeddings",
    )
    op.drop_table("transaction_embeddings")
