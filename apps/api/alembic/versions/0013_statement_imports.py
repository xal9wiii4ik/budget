"""statement import: sessions, parsed rows and the bank-category map

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-27

Three tables in ONE migration (statement-import architecture §1), because they
are one feature and there is no state of the schema where a subset of them makes
sense: rows without their session are orphans, and the bank-category map is the
learning half of the same import flow.

No backfill and no touch of ``transactions``: a session is a PROPOSAL, and the
only edge into real money is ``statement_import_rows.matched_tx_id``
(``ON DELETE SET NULL`` — deleting a transaction must not delete the preview row
that points at it, and deleting a preview must never reach a transaction).

Pure DDL with a symmetric downgrade (the test conftest tears its schema down with
``downgrade base``): all three tables are new, so the downgrade is three drops and
nothing else — no data of any other table is touched on the way down.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "statement_imports",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("source_format", sa.String(length=32), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("statement_currency", sa.String(length=3), nullable=False),
        sa.Column("period_from", sa.Date(), nullable=False),
        sa.Column("period_to", sa.Date(), nullable=False),
        sa.Column("rows_total", sa.Integer(), nullable=False),
        sa.Column("rows_blocked", sa.Integer(), nullable=False),
        sa.Column("rows_zero_skipped", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        # Rendered from budget_api.enums.StatementImportStatus in
        # models/statement_import.py — the definition order there must keep
        # emitting exactly this string, or `alembic check` goes red.
        sa.CheckConstraint(
            "status IN ('parsed', 'applied', 'replaced')",
            name=op.f("ck_statement_imports_status_valid"),
        ),
        sa.CheckConstraint(
            "statement_currency ~ '^[A-Z]{3}$'",
            name=op.f("ck_statement_imports_statement_currency_format"),
        ),
        sa.CheckConstraint(
            "period_to >= period_from",
            name=op.f("ck_statement_imports_period_ordered"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_statement_imports_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_statement_imports_accounts_account_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_statement_imports")),
    )
    op.create_index(
        "ix_statement_imports_user_id_account_id",
        "statement_imports",
        ["user_id", "account_id"],
        unique=False,
    )
    # ONE live preview per account, enforced by the database. The router supersedes
    # an existing ``parsed`` session with a DELETE before its INSERT, but two
    # parallel uploads of the same account both delete what they can SEE and then
    # both insert; the loser of that race is recovered by one retry in the router
    # (the B-1 precedent), so a double-submit ends up exactly where a sequential
    # pair of uploads would. PARTIAL and therefore an explicit index name: applied
    # and replaced sessions are the JOURNAL of what was done and accumulate freely.
    op.create_index(
        "uq_statement_imports_live_preview",
        "statement_imports",
        ["user_id", "account_id"],
        unique=True,
        postgresql_where=sa.text("status = 'parsed'"),
    )

    op.create_table(
        "statement_import_rows",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("import_id", sa.Uuid(), nullable=False),
        sa.Column("row_index", sa.Integer(), nullable=False),
        sa.Column("section", sa.String(length=16), nullable=False),
        sa.Column("txn_date", sa.Date(), nullable=False),
        sa.Column("txn_time", sa.Time(), nullable=True),
        sa.Column("booked_date", sa.Date(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("bank_category", sa.String(length=255), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("original_amount_minor", sa.BigInteger(), nullable=True),
        sa.Column("original_currency", sa.String(length=3), nullable=True),
        # PM §10.2: a typed column, not a corner of ``raw``. NOT NULL with a 0
        # default, so "no fee" and "zero fee" are one value for every reader.
        sa.Column(
            "fee_minor",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("raw", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("match_status", sa.String(length=16), nullable=False),
        sa.Column("matched_tx_id", sa.Uuid(), nullable=True),
        sa.Column(
            "candidate_tx_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
        sa.Column(
            "possible_transfer",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column("suggested_category_id", sa.Uuid(), nullable=True),
        sa.Column("suggestion_source", sa.String(length=16), nullable=True),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column(
            "category_user_set",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column("decision", sa.String(length=16), nullable=False),
        sa.CheckConstraint(
            "section IN ('contract', 'card')",
            name=op.f("ck_statement_import_rows_section_valid"),
        ),
        sa.CheckConstraint(
            "match_status IN ('exact', 'similar', 'new')",
            name=op.f("ck_statement_import_rows_match_status_valid"),
        ),
        sa.CheckConstraint(
            "decision IN ('import', 'skip', 'replace_own')",
            name=op.f("ck_statement_import_rows_decision_valid"),
        ),
        sa.CheckConstraint(
            "suggestion_source IS NULL OR suggestion_source IN "
            "('merchant', 'bank_category')",
            name=op.f("ck_statement_import_rows_suggestion_source_valid"),
        ),
        sa.CheckConstraint(
            "amount_minor >= 0",
            name=op.f("ck_statement_import_rows_amount_minor_non_negative"),
        ),
        # The transactions table's own original-leg pair (0009), repeated here so a
        # half-pair cannot even be PROPOSED — apply must never discover it at
        # INSERT time.
        sa.CheckConstraint(
            "(original_amount_minor IS NULL) = (original_currency IS NULL)",
            name=op.f("ck_statement_import_rows_original_pair"),
        ),
        sa.CheckConstraint(
            "original_currency ~ '^[A-Z]{3}$'",
            name=op.f("ck_statement_import_rows_original_currency_format"),
        ),
        sa.ForeignKeyConstraint(
            ["import_id"],
            ["statement_imports.id"],
            name=op.f("fk_statement_import_rows_statement_imports_import_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["matched_tx_id"],
            ["transactions.id"],
            name=op.f("fk_statement_import_rows_transactions_matched_tx_id"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["suggested_category_id"],
            ["categories.id"],
            name=op.f("fk_statement_import_rows_categories_suggested_category_id"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_statement_import_rows_categories_category_id"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_statement_import_rows")),
    )
    # UNIQUE: the preview is paged by ``row_index`` alone, and offset paging can
    # only be total if that order is total. The parser numbers the rows of one file
    # 0..n-1, so uniqueness costs nothing and pins the invariant the router's
    # ordering already assumes.
    op.create_index(
        "ix_statement_import_rows_import_id_row_index",
        "statement_import_rows",
        ["import_id", "row_index"],
        unique=True,
    )

    # The merchant_category_map twin (0004), keyed by the bank's own category
    # string: same composite PK, same ON CONFLICT upsert target, same CASCADEs.
    op.create_table(
        "bank_category_map",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("bank_category", sa.String(length=255), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_bank_category_map_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_bank_category_map_categories_category_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "user_id", "bank_category", name=op.f("pk_bank_category_map")
        ),
    )


def downgrade() -> None:
    op.drop_table("bank_category_map")
    op.drop_index(
        "ix_statement_import_rows_import_id_row_index",
        table_name="statement_import_rows",
    )
    op.drop_table("statement_import_rows")
    op.drop_index("uq_statement_imports_live_preview", table_name="statement_imports")
    op.drop_index(
        "ix_statement_imports_user_id_account_id", table_name="statement_imports"
    )
    op.drop_table("statement_imports")
