"""statement-import AI pass: session stamps, row verdicts, the third suggestion source

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-14

Four blocks, no backfill (ai-layer architecture §"Database changes"):

1. ``statement_imports`` — ``ai_status`` (NOT NULL, server_default
   ``'not_configured'``) plus the provenance trio ``ai_provider``/``ai_model``/
   ``ai_prompt_version``. Existing sessions read ``not_configured``, which is
   exactly what was true of them, so the default is honest rather than a
   placeholder.
2. ``ck_statement_imports_ai_status_valid`` — written BY HAND and byte-identical
   to what ``models/statement_import.py`` renders from ``StatementAiStatus``
   (definition order is the whole guard).
3. ``statement_import_rows`` — ``ai_confidence``/``ai_reason``/``needs_review``.
   Only ``needs_review`` is NOT NULL: "no AI verdict" is a real state of a row and
   NULL is how it is spelled, while "needs a look" is a yes/no for every row.
4. ``ck_statement_import_rows_suggestion_source_valid`` is DROPPED and recreated
   under the VERY SAME NAME with the appended third value ``llm`` (the 0012
   ``ck_accounts_type_valid`` precedent): alembic cannot diff CHECK constraints on
   an existing table, so a drift between this string and the model's would be
   silent — and a red ``alembic check`` is the only alarm there is.

**The downgrade keeps the money and drops the guess.** An ``llm`` suggestion is
unrepresentable in the two-value CHECK, so ``suggestion_source`` and
``suggested_category_id`` are NULLed for exactly those rows — but ``category_id``
is KEPT: that is the value the user saw in the preview and the one apply would
file, and silently re-emptying the category of a preview somebody already reviewed
would be a worse rollback than forgetting where it came from. Rows seeded by the
merchant or bank-category maps are untouched. The test conftest tears its schema
down with ``downgrade base``, so this path runs on every suite.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "statement_imports",
        sa.Column(
            "ai_status",
            sa.String(length=16),
            server_default=sa.text("'not_configured'"),
            nullable=False,
        ),
    )
    op.add_column(
        "statement_imports",
        sa.Column("ai_provider", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "statement_imports", sa.Column("ai_model", sa.String(length=64), nullable=True)
    )
    op.add_column(
        "statement_imports",
        sa.Column("ai_prompt_version", sa.String(length=32), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_statement_imports_ai_status_valid"),
        "statement_imports",
        "ai_status IN ('not_configured', 'skipped', 'ok', 'partial', 'failed')",
    )

    op.add_column(
        "statement_import_rows",
        sa.Column("ai_confidence", sa.Numeric(precision=4, scale=3), nullable=True),
    )
    op.add_column(
        "statement_import_rows",
        sa.Column("ai_reason", sa.String(length=300), nullable=True),
    )
    op.add_column(
        "statement_import_rows",
        sa.Column(
            "needs_review",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )

    # Same NAME as in 0013, one more accepted value — models/statement_import.py
    # renders exactly this string from StatementSuggestionSource.
    op.drop_constraint(
        op.f("ck_statement_import_rows_suggestion_source_valid"),
        "statement_import_rows",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_statement_import_rows_suggestion_source_valid"),
        "statement_import_rows",
        "suggestion_source IS NULL OR suggestion_source IN "
        "('merchant', 'bank_category', 'llm')",
    )


def downgrade() -> None:
    # The guess goes, the reviewed value stays (see the module docstring): an
    # ``llm`` source cannot survive the narrowed CHECK below, and neither can the
    # suggestion it points at, but ``category_id`` is what apply would file.
    op.execute(
        "UPDATE statement_import_rows "
        "SET suggestion_source = NULL, suggested_category_id = NULL "
        "WHERE suggestion_source = 'llm'"
    )
    op.drop_constraint(
        op.f("ck_statement_import_rows_suggestion_source_valid"),
        "statement_import_rows",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_statement_import_rows_suggestion_source_valid"),
        "statement_import_rows",
        "suggestion_source IS NULL OR suggestion_source IN "
        "('merchant', 'bank_category')",
    )

    op.drop_column("statement_import_rows", "needs_review")
    op.drop_column("statement_import_rows", "ai_reason")
    op.drop_column("statement_import_rows", "ai_confidence")

    op.drop_constraint(
        op.f("ck_statement_imports_ai_status_valid"),
        "statement_imports",
        type_="check",
    )
    op.drop_column("statement_imports", "ai_prompt_version")
    op.drop_column("statement_imports", "ai_model")
    op.drop_column("statement_imports", "ai_provider")
    op.drop_column("statement_imports", "ai_status")
