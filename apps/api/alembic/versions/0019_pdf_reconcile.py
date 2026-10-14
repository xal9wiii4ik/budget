"""pdf-reconcile: balance anchors, the statement self-check, the post-import
balance check and the reconcile agent's state

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-14

Sixteen columns on ``statement_imports`` and nothing else — no new table, no
backfill, no data touched (pdf-reconcile architecture §6). Four independent
families, added in four blocks:

1. The ANCHORS the file prints: ``opening_balance_minor`` /
   ``closing_balance_minor``, NULL for a format that carries none (every
   Priorbank session, and every session parsed before this migration).
2. The SELF-CHECK: did the statement prove its own arithmetic
   (``self_check_status`` NOT NULL, server_default ``'not_available'`` — which is
   exactly what was true of the existing rows) and, when it did not, WHICH check
   failed with both numbers. Four typed columns and not a JSONB blob (D-M1): the
   apply gate reads one of them, and the preview renders two integers without
   parsing JSON.
3. The POST-IMPORT CHECK: the balance the app shows for the account on the
   statement's ``period_to`` against the printed closing balance, stamped inside
   the apply/replace transaction (D-B1). Informational: it refuses nothing.
4. The reconcile AGENT's state: the claim (``reconciliation_status`` NOT NULL,
   server_default ``'none'`` + ``reconciliation_started_at``), the report
   (``reconciliation`` JSONB + ``reconciled_at``) and the provenance trio.

**Every CHECK below is written BY HAND and must stay byte-identical to what
``models/statement_import.py`` renders** — four from the enums' definition order
(``StatementSelfCheckStatus``, ``StatementSelfCheckFailure``,
``StatementBalanceCheck``, ``StatementReconciliationStatus``) and three pair
constraints that are literals in both places. Alembic cannot diff a CHECK on an
existing table (the 0016/0018 rule), so a drift here would be silent and
``tests/test_core_model.py`` is the only alarm there is.

``source_format`` is NOT widened: ``String(32)`` already holds ``alfa_pdf_v1``.
No index is added — every read of a session is by primary key or through the
existing ``(user_id, account_id)`` index.

**The downgrade keeps every row.** Unlike 0012/0016 there is nothing here a
narrower schema cannot represent: a session parsed by a format the old registry
no longer names survives as the journal row it is (it reads fine, and it cannot
be re-applied — it is already ``applied``/``replaced``, or a stale preview the
TTL sweep removes). So the symmetric drop of the CHECKs and the columns is the
whole of it. The test conftest tears its schema down with ``downgrade base``, so
this path runs on every suite.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. The anchors the file prints.
    op.add_column(
        "statement_imports",
        sa.Column("opening_balance_minor", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "statement_imports",
        sa.Column("closing_balance_minor", sa.BigInteger(), nullable=True),
    )

    # 2. The self-check. models/statement_import.py renders exactly these three
    # strings from StatementSelfCheckStatus / StatementSelfCheckFailure and the
    # hand-written pair.
    op.add_column(
        "statement_imports",
        sa.Column(
            "self_check_status",
            sa.String(length=16),
            server_default=sa.text("'not_available'"),
            nullable=False,
        ),
    )
    op.add_column(
        "statement_imports",
        sa.Column("self_check_failed", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "statement_imports",
        sa.Column("self_check_expected_minor", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "statement_imports",
        sa.Column("self_check_actual_minor", sa.BigInteger(), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_statement_imports_self_check_status_valid"),
        "statement_imports",
        "self_check_status IN ('not_available', 'passed', 'failed')",
    )
    op.create_check_constraint(
        op.f("ck_statement_imports_self_check_failed_valid"),
        "statement_imports",
        "self_check_failed IS NULL OR self_check_failed IN "
        "('balance', 'income_total', 'expense_total', 'date_range')",
    )
    op.create_check_constraint(
        op.f("ck_statement_imports_self_check_detail"),
        "statement_imports",
        "(self_check_status = 'failed') = (self_check_failed IS NOT NULL)",
    )

    # 3. The post-import balance check.
    op.add_column(
        "statement_imports",
        sa.Column(
            "balance_check",
            sa.String(length=16),
            server_default=sa.text("'not_available'"),
            nullable=False,
        ),
    )
    op.add_column(
        "statement_imports",
        sa.Column("app_balance_minor_at_end", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "statement_imports",
        sa.Column("balance_diff_minor", sa.BigInteger(), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_statement_imports_balance_check_valid"),
        "statement_imports",
        "balance_check IN ('not_available', 'match', 'mismatch')",
    )
    op.create_check_constraint(
        op.f("ck_statement_imports_balance_check_pair"),
        "statement_imports",
        "((balance_check = 'not_available') = (app_balance_minor_at_end IS NULL))"
        " AND ((app_balance_minor_at_end IS NULL) = (balance_diff_minor IS NULL))",
    )

    # 4. The reconcile agent: the claim, the report, the provenance.
    op.add_column(
        "statement_imports",
        sa.Column(
            "reconciliation_status",
            sa.String(length=16),
            server_default=sa.text("'none'"),
            nullable=False,
        ),
    )
    op.add_column(
        "statement_imports",
        sa.Column(
            "reconciliation_started_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.add_column(
        "statement_imports",
        sa.Column("reconciled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "statement_imports",
        sa.Column(
            "reconciliation",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.add_column(
        "statement_imports",
        sa.Column("reconcile_provider", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "statement_imports",
        sa.Column("reconcile_model", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "statement_imports",
        sa.Column("reconcile_prompt_version", sa.String(length=32), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_statement_imports_reconciliation_status_valid"),
        "statement_imports",
        "reconciliation_status IN ('none', 'running', 'ok', 'failed')",
    )
    op.create_check_constraint(
        op.f("ck_statement_imports_reconciliation_present"),
        "statement_imports",
        "(reconciliation_status = 'ok') = (reconciliation IS NOT NULL)",
    )


def downgrade() -> None:
    # Symmetric, and the rows stay: nothing added above is load-bearing for a row
    # that already exists (see the module docstring).
    op.drop_constraint(
        op.f("ck_statement_imports_reconciliation_present"),
        "statement_imports",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_statement_imports_reconciliation_status_valid"),
        "statement_imports",
        type_="check",
    )
    op.drop_column("statement_imports", "reconcile_prompt_version")
    op.drop_column("statement_imports", "reconcile_model")
    op.drop_column("statement_imports", "reconcile_provider")
    op.drop_column("statement_imports", "reconciliation")
    op.drop_column("statement_imports", "reconciled_at")
    op.drop_column("statement_imports", "reconciliation_started_at")
    op.drop_column("statement_imports", "reconciliation_status")

    op.drop_constraint(
        op.f("ck_statement_imports_balance_check_pair"),
        "statement_imports",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_statement_imports_balance_check_valid"),
        "statement_imports",
        type_="check",
    )
    op.drop_column("statement_imports", "balance_diff_minor")
    op.drop_column("statement_imports", "app_balance_minor_at_end")
    op.drop_column("statement_imports", "balance_check")

    op.drop_constraint(
        op.f("ck_statement_imports_self_check_detail"),
        "statement_imports",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_statement_imports_self_check_failed_valid"),
        "statement_imports",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_statement_imports_self_check_status_valid"),
        "statement_imports",
        type_="check",
    )
    op.drop_column("statement_imports", "self_check_actual_minor")
    op.drop_column("statement_imports", "self_check_expected_minor")
    op.drop_column("statement_imports", "self_check_failed")
    op.drop_column("statement_imports", "self_check_status")

    op.drop_column("statement_imports", "closing_balance_minor")
    op.drop_column("statement_imports", "opening_balance_minor")
