"""deposits: the metadata table and the widened account-type CHECK

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-27

Two blocks, no backfill:

1. ``ck_accounts_type_valid`` is DROPPED and recreated under the very same name
   with the appended third value ``deposit`` (the 0008 precedent for
   ``ck_transactions_kind_valid``), so the rendered SQL stays byte-identical to
   the constraint ``models/account.py`` builds from ``AccountType`` — a drift here
   is a red ``alembic check``.
2. ``deposits`` (deposits architecture §Tables) — metadata only. No ``currency``
   column (the linked account is the single source) and no principal column (the
   opening body is the account's ``starting_balance_minor``, AMENDMENT §1); the
   only stored money is the manual anchor ``accrued_override_minor`` and its date,
   and the two are a PAIR by CHECK.

``account_id`` is UNIQUE with ``ON DELETE RESTRICT``: the 1:1 is a database fact,
and accounts are archived rather than deleted, so a delete reaching this FK is a
bug that should fail loudly instead of orphaning a deposit.

Pure DDL with a symmetric downgrade (the test conftest tears its schema down with
``downgrade base``). The downgrade DELETEs the deposit ACCOUNTS along with the
table: a ``type='deposit'`` account is unrepresentable in the pre-0012 schema —
the narrowed CHECK would refuse to be created while one exists — exactly as a
transfer was unrepresentable before 0008, whose downgrade deletes those rows for
the same reason. Its transactions go with it through the existing
``ON DELETE CASCADE`` on ``transactions.account_id``.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Same NAME as in 0008, one more accepted value — models/account.py renders
    # exactly this string from AccountType, so a drift here is a red `alembic check`.
    op.drop_constraint(op.f("ck_accounts_type_valid"), "accounts", type_="check")
    op.create_check_constraint(
        op.f("ck_accounts_type_valid"),
        "accounts",
        "type IN ('card', 'cash', 'deposit')",
    )

    op.create_table(
        "deposits",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("rate_percent", sa.Numeric(precision=8, scale=4), nullable=False),
        sa.Column("capitalization", sa.String(length=16), nullable=False),
        sa.Column("opened_on", sa.Date(), nullable=False),
        sa.Column("term_end", sa.Date(), nullable=True),
        sa.Column("tax_rate_percent", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("accrued_override_minor", sa.BigInteger(), nullable=True),
        sa.Column("accrued_override_as_of", sa.Date(), nullable=True),
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
            "capitalization IN ('none', 'monthly', 'quarterly', 'at_maturity')",
            name=op.f("ck_deposits_capitalization_valid"),
        ),
        sa.CheckConstraint(
            "rate_percent >= 0", name=op.f("ck_deposits_rate_non_negative")
        ),
        sa.CheckConstraint(
            "tax_rate_percent IS NULL OR (tax_rate_percent >= 0 AND "
            "tax_rate_percent <= 100)",
            name=op.f("ck_deposits_tax_rate_range"),
        ),
        # NULL term_end = open-ended (a savings account), so the NULL arm is spelled
        # out rather than left to SQL's NULL-passes rule.
        sa.CheckConstraint(
            "term_end IS NULL OR term_end > opened_on",
            name=op.f("ck_deposits_term_after_opening"),
        ),
        # The manual anchor is a PAIR: a number with no date anchors nothing in
        # time, a date with no number anchors nothing at all.
        sa.CheckConstraint(
            "(accrued_override_minor IS NULL) = (accrued_override_as_of IS NULL)",
            name=op.f("ck_deposits_accrued_override_pair"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_deposits_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_deposits_accounts_account_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_deposits")),
        sa.UniqueConstraint("account_id", name=op.f("uq_deposits_account_id")),
    )
    op.create_index(op.f("ix_deposits_user_id"), "deposits", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_deposits_user_id"), table_name="deposits")
    op.drop_table("deposits")
    # The deposits table is gone, so the RESTRICT FK no longer holds these rows —
    # and a type='deposit' account cannot survive the narrowed CHECK below (0008
    # precedent: its downgrade deletes the transfer rows for the same reason).
    # Their transactions follow through transactions.account_id's ON DELETE CASCADE.
    op.execute("DELETE FROM accounts WHERE type = 'deposit'")
    op.drop_constraint(op.f("ck_accounts_type_valid"), "accounts", type_="check")
    op.create_check_constraint(
        op.f("ck_accounts_type_valid"), "accounts", "type IN ('card', 'cash')"
    )
