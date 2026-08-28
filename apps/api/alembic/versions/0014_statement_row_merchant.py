"""statement import rows: the parser's isolated shop name as a column

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-28

One nullable column, ``statement_import_rows.merchant`` — the shop name a parser
could isolate inside a sentence-shaped description ("გადახდა - YANDEX.EDA 56.10
BYN 01.08.2026" → "YANDEX.EDA"). It replaces the reserved ``raw["__merchant__"]``
key the first Credo pass used: the value DECIDES what apply writes and what the
category maps are keyed by, so it has to be visible in the preview
(``StatementRowRead.merchant``) and queryable — neither of which a corner of an
untyped JSONB blob can be.

``String(255)`` to match ``transactions.merchant``, which is where the value
ends up; NULL means exactly "no name could be isolated, the description IS the
name" — the Priorbank case and the default, so that format's behaviour is
untouched by this column existing.

No backfill and no server_default. Nothing to backfill: no Credo row has ever
been stored (the format shipped in the same scope), and writing a name derived
from a description onto Priorbank rows would invent data the parser never
claimed. Doing it now is also the last moment it is free — a later migration
would be an edit of live previews.

Pure additive DDL with a symmetric downgrade (the test conftest tears its schema
down with ``downgrade base``): no existing column, index or CHECK is touched, so
an old server keeps reading every row it could read before.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "statement_import_rows",
        sa.Column("merchant", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("statement_import_rows", "merchant")
