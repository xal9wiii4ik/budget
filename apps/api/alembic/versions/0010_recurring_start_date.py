"""recurring templates: user-controlled first-charge date

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-22

One nullable column, ``recurring_templates.start_date`` (architecture A1/A6).

It is INPUT to the ``last_materialized_on`` watermark at create/PATCH time and a
stored echo for the edit form; ``services/recurring_jobs.py`` never reads it, so
the watermark stays the sole idempotency truth. NULL therefore means exactly
"legacy behaviour, no floor" — which is why there is NO backfill of
``created_at::date`` and NO server_default: writing a start date onto rows the
user never gave one to would either lie about what they asked for or, worse,
invite a later reading of that column into the materializer.

The watermarks themselves are NOT touched: this migration must not move a single
template's idea of what it has already booked (double booking is the scope's #1
risk).

No CHECK for ``start_date <= end_date`` (A6, PM 2026-08-22): both dates are
nullable, so the constraint would carry three NULL branches for a rule the API
already owns end-to-end on both writes, and the legacy rows are unconstrained
anyway.

Pure DDL with a fully symmetric downgrade (the test conftest tears its schema
down with ``downgrade base``).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "recurring_templates", sa.Column("start_date", sa.Date(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("recurring_templates", "start_date")
