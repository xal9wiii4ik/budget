"""oauth connector: clients, pending consents, codes and the two token tables

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-08

ALL DDL for the mcp-remote B1 scope in one migration (the 0007 precedent), in six
blocks that must run in this order because of the FK graph:

1. ``oauth_clients`` — one row per dynamically registered AI application. Created
   FIRST: ``personal_access_tokens`` grows an FK into it in block 2.
2. ``personal_access_tokens`` (ALTER) — the table now carries two kinds of row
   (architecture §D3): a plain PAT and an OAuth GRANT. ``token_hash`` becomes
   NULLABLE (its UNIQUE index tolerates NULLs, so grants do not collide),
   ``oauth_client_id`` arrives as a nullable FK with ``ON DELETE RESTRICT`` (a
   client a user connected can never be pruned from under its audit history), and
   ``ck_personal_access_tokens_credential`` is the XOR that says exactly one kind
   per row. That CHECK is the one piece of this migration autogenerate CANNOT
   produce or verify (alembic does not diff CHECK constraints on existing tables),
   so it is written by hand and the model's constraint name is byte-identical.
3. ``oauth_authorization_requests`` — a parked consent decision. Indexed on
   ``expires_at``: the lazy prune is the only query that reads that column.
4. ``oauth_access_tokens`` / 5. ``oauth_authorization_codes`` /
   6. ``oauth_refresh_tokens`` — the credentials, each keyed on the grant.

Pure DDL, no backfill: every pre-existing ``personal_access_tokens`` row is
correctly "a plain PAT" as ``oauth_client_id IS NULL``.

**The downgrade is symmetric and DESTRUCTIVE, deliberately**: it
``DELETE``s every grant row (and with it, by cascade, that grant's
``pat_audit_log`` history) because a grant cannot exist without the
``oauth_client_id`` column the downgrade removes and cannot satisfy the
``token_hash NOT NULL`` it restores. Rolling 0016 back means disconnecting every
connected AI application — which is exactly what rolling back the feature is. The
test conftest tears its schema down with ``downgrade base``, so this path runs on
every suite.

Expired rows of blocks 3-6 are pruned LAZILY at the matching provider call (the
``statement_import_ttl_days`` precedent) — no scheduler job, no retention DDL.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "oauth_clients",
        # No server_default and no python default: the id IS the client_id the
        # SDK's registration handler minted (``str(uuid4())``), never one of ours.
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_name", sa.String(length=100), nullable=True),
        sa.Column(
            "redirect_uris",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("token_endpoint_auth_method", sa.String(length=32), nullable=False),
        sa.Column("client_secret_hash", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # Byte-identical to the model's enum-built constraint (enums.py
        # OAuthClientAuthMethod definition order); ``alembic check`` guards it.
        sa.CheckConstraint(
            "token_endpoint_auth_method IN "
            "('none', 'client_secret_post', 'client_secret_basic')",
            name=op.f("ck_oauth_clients_auth_method_valid"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_clients")),
    )

    op.add_column(
        "personal_access_tokens", sa.Column("oauth_client_id", sa.Uuid(), nullable=True)
    )
    op.alter_column(
        "personal_access_tokens",
        "token_hash",
        existing_type=sa.VARCHAR(length=64),
        nullable=True,
    )
    op.create_foreign_key(
        op.f("fk_personal_access_tokens_oauth_clients_oauth_client_id"),
        "personal_access_tokens",
        "oauth_clients",
        ["oauth_client_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    # Hand-written: autogenerate neither emits nor diffs a CHECK added to an
    # existing table, so this name and this SQL are the only copy there is besides
    # the model's (models/personal_access_token.py).
    op.create_check_constraint(
        "credential",
        "personal_access_tokens",
        "(token_hash IS NULL) <> (oauth_client_id IS NULL)",
    )

    op.create_table(
        "oauth_authorization_requests",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("code_challenge", sa.String(length=128), nullable=False),
        sa.Column("state", sa.Text(), nullable=True),
        sa.Column("resource", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["client_id"],
            ["oauth_clients.id"],
            name=op.f("fk_oauth_authorization_requests_oauth_clients_client_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_authorization_requests")),
    )
    op.create_index(
        op.f("ix_oauth_authorization_requests_expires_at"),
        "oauth_authorization_requests",
        ["expires_at"],
        unique=False,
    )

    op.create_table(
        "oauth_access_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("grant_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["grant_id"],
            ["personal_access_tokens.id"],
            name=op.f("fk_oauth_access_tokens_personal_access_tokens_grant_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_access_tokens")),
    )
    op.create_index(
        op.f("ix_oauth_access_tokens_grant_id"),
        "oauth_access_tokens",
        ["grant_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_oauth_access_tokens_token_hash"),
        "oauth_access_tokens",
        ["token_hash"],
        unique=True,
    )

    op.create_table(
        "oauth_authorization_codes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("scope", sa.String(length=32), nullable=False),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("code_challenge", sa.String(length=128), nullable=False),
        sa.Column("resource", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("grant_id", sa.Uuid(), nullable=True),
        # The same enum-built SQL as personal_access_tokens.scope_valid: the mode on
        # a code row is the mode the grant it produces will carry.
        sa.CheckConstraint(
            "scope IN ('read', 'full')",
            name=op.f("ck_oauth_authorization_codes_scope_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["client_id"],
            ["oauth_clients.id"],
            name=op.f("fk_oauth_authorization_codes_oauth_clients_client_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["grant_id"],
            ["personal_access_tokens.id"],
            name=op.f("fk_oauth_authorization_codes_personal_access_tokens_grant_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_oauth_authorization_codes_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_authorization_codes")),
    )
    op.create_index(
        op.f("ix_oauth_authorization_codes_code_hash"),
        "oauth_authorization_codes",
        ["code_hash"],
        unique=True,
    )

    op.create_table(
        "oauth_refresh_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("grant_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("replaced_by_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["grant_id"],
            ["personal_access_tokens.id"],
            name=op.f("fk_oauth_refresh_tokens_personal_access_tokens_grant_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["replaced_by_id"],
            ["oauth_refresh_tokens.id"],
            name=op.f("fk_oauth_refresh_tokens_oauth_refresh_tokens_replaced_by_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_refresh_tokens")),
    )
    op.create_index(
        op.f("ix_oauth_refresh_tokens_grant_id"),
        "oauth_refresh_tokens",
        ["grant_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_oauth_refresh_tokens_token_hash"),
        "oauth_refresh_tokens",
        ["token_hash"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_oauth_refresh_tokens_token_hash"), table_name="oauth_refresh_tokens"
    )
    op.drop_index(
        op.f("ix_oauth_refresh_tokens_grant_id"), table_name="oauth_refresh_tokens"
    )
    op.drop_table("oauth_refresh_tokens")
    op.drop_index(
        op.f("ix_oauth_authorization_codes_code_hash"),
        table_name="oauth_authorization_codes",
    )
    op.drop_table("oauth_authorization_codes")
    op.drop_index(
        op.f("ix_oauth_access_tokens_token_hash"), table_name="oauth_access_tokens"
    )
    op.drop_index(
        op.f("ix_oauth_access_tokens_grant_id"), table_name="oauth_access_tokens"
    )
    op.drop_table("oauth_access_tokens")
    op.drop_index(
        op.f("ix_oauth_authorization_requests_expires_at"),
        table_name="oauth_authorization_requests",
    )
    op.drop_table("oauth_authorization_requests")

    op.drop_constraint(
        op.f("ck_personal_access_tokens_credential"),
        "personal_access_tokens",
        type_="check",
    )
    # DESTRUCTIVE AND DELIBERATE (see the module docstring): a grant row has no
    # ``token_hash`` and cannot survive either the dropped column or the restored
    # NOT NULL. Its ``pat_audit_log`` rows go with it by cascade.
    op.execute("DELETE FROM personal_access_tokens WHERE oauth_client_id IS NOT NULL")
    op.drop_constraint(
        op.f("fk_personal_access_tokens_oauth_clients_oauth_client_id"),
        "personal_access_tokens",
        type_="foreignkey",
    )
    op.drop_column("personal_access_tokens", "oauth_client_id")
    op.alter_column(
        "personal_access_tokens",
        "token_hash",
        existing_type=sa.VARCHAR(length=64),
        nullable=False,
    )

    op.drop_table("oauth_clients")
