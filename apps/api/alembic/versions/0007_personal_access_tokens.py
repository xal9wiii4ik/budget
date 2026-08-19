"""personal access tokens, pat audit log and transaction client_id

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-19

ALL DDL for the mcp-server S1 scope in one migration (the 0006 precedent), in
three blocks:

1. ``personal_access_tokens`` (architecture §1) — the PAT itself; only the
   SHA-256 hex of the token is stored, under a UNIQUE index that IS the
   authentication lookup.
2. ``pat_audit_log`` (architecture §6) — append-only row per PAT call, with the
   ONE composite index ``ix_pat_audit_token_time (token_id, occurred_at)``.
3. ``transactions.client_id`` + the PARTIAL unique index
   ``uq_transactions_user_id_client_id (user_id, client_id) WHERE client_id IS
   NOT NULL`` (B-1, pulled into this scope) — additive, nullable, no backfill:
   every existing row is correctly "no idempotency key" as NULL.

Pure DDL with a fully symmetric downgrade (the test conftest tears its schema
down with ``downgrade base``). The ``scope`` CHECK is byte-identical to the
model's enum-built constraint (PatScope definition order); ``alembic check``
guards the drift.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "personal_access_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("scope", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        # String enum, not a boolean flag: a future granular scope extends this
        # CHECK without changing the column type (architecture §1).
        sa.CheckConstraint(
            "scope IN ('read', 'full')",
            name=op.f("ck_personal_access_tokens_scope_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_personal_access_tokens_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_personal_access_tokens")),
    )
    op.create_index(
        op.f("ix_personal_access_tokens_token_hash"),
        "personal_access_tokens",
        ["token_hash"],
        unique=True,
    )
    op.create_index(
        op.f("ix_personal_access_tokens_user_id"),
        "personal_access_tokens",
        ["user_id"],
        unique=False,
    )
    op.create_table(
        "pat_audit_log",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("token_id", sa.Uuid(), nullable=False),
        # Denormalized on purpose (architecture §6): no FK, no JOIN on read; the
        # row still disappears with its token, which cascades from users.
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("method", sa.String(length=8), nullable=False),
        sa.Column("path", sa.String(length=200), nullable=False),
        sa.Column("status_code", sa.SmallInteger(), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["token_id"],
            ["personal_access_tokens.id"],
            name=op.f("fk_pat_audit_log_personal_access_tokens_token_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pat_audit_log")),
    )
    op.create_index(
        "ix_pat_audit_token_time",
        "pat_audit_log",
        ["token_id", "occurred_at"],
        unique=False,
    )
    op.add_column("transactions", sa.Column("client_id", sa.Uuid(), nullable=True))
    op.create_index(
        "uq_transactions_user_id_client_id",
        "transactions",
        ["user_id", "client_id"],
        unique=True,
        postgresql_where=sa.text("client_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_transactions_user_id_client_id", table_name="transactions")
    op.drop_column("transactions", "client_id")
    op.drop_index("ix_pat_audit_token_time", table_name="pat_audit_log")
    op.drop_table("pat_audit_log")
    op.drop_index(
        op.f("ix_personal_access_tokens_user_id"), table_name="personal_access_tokens"
    )
    op.drop_index(
        op.f("ix_personal_access_tokens_token_hash"),
        table_name="personal_access_tokens",
    )
    op.drop_table("personal_access_tokens")
