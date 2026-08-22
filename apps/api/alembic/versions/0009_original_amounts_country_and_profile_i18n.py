"""original amounts, country and profile i18n

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-22

ALL DDL for the transaction-details-and-i18n scope in one migration (the
0008 precedent), in two blocks:

1. ``transactions`` — the ORIGINAL leg (``original_amount_minor`` /
   ``original_currency``): what the purchase actually cost in the merchant's
   currency, next to ``amount_minor``/``currency``, which stay what the ACCOUNT
   was debited (architecture §1). Plus ``country`` (S2). Six CHECKs make "half an
   original" unrepresentable and pin the pair's meaning, mirroring the transfer
   CHECKs of 0008: the pair moves together, the amount is user-supplied and
   therefore strictly positive, the currency is a well-formed ISO code, it can
   never equal the row's own currency (NULL already means "same as the account",
   and two spellings of one fact would fork every reader), and a transfer — which
   already carries a counter leg — can never carry an original one.
2. ``profiles`` — ``country`` and ``language``, both nullable and both WITHOUT a
   server_default. NULL means "the user has not confirmed one yet", which is the
   marker the first-run locale prompt keys off; defaulting ``language`` to 'ru'
   would lie for every en user AND erase the difference between "chose ru" and
   "never chose" (architecture §6).

No backfill: every column added here is NULL-compatible, so existing rows are
already valid. Pure DDL with a fully symmetric downgrade (the test conftest tears
its schema down with ``downgrade base``).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column("original_amount_minor", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "transactions",
        sa.Column("original_currency", sa.String(length=3), nullable=True),
    )
    op.add_column(
        "transactions", sa.Column("country", sa.String(length=2), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_transactions_original_pair"),
        "transactions",
        "(original_amount_minor IS NULL) = (original_currency IS NULL)",
    )
    op.create_check_constraint(
        op.f("ck_transactions_original_amount_minor_positive"),
        "transactions",
        "original_amount_minor IS NULL OR original_amount_minor > 0",
    )
    op.create_check_constraint(
        op.f("ck_transactions_original_currency_format"),
        "transactions",
        "original_currency ~ '^[A-Z]{3}$'",
    )
    op.create_check_constraint(
        op.f("ck_transactions_original_currency_differs"),
        "transactions",
        "original_currency IS NULL OR original_currency <> currency",
    )
    op.create_check_constraint(
        op.f("ck_transactions_transfer_no_original"),
        "transactions",
        "kind <> 'transfer' "
        "OR (original_amount_minor IS NULL AND original_currency IS NULL)",
    )
    op.create_check_constraint(
        op.f("ck_transactions_country_format"),
        "transactions",
        "country ~ '^[A-Z]{2}$'",
    )

    op.add_column("profiles", sa.Column("country", sa.String(length=2), nullable=True))
    op.add_column("profiles", sa.Column("language", sa.String(length=2), nullable=True))
    op.create_check_constraint(
        op.f("ck_profiles_country_format"), "profiles", "country ~ '^[A-Z]{2}$'"
    )
    op.create_check_constraint(
        op.f("ck_profiles_language_valid"), "profiles", "language IN ('ru', 'en')"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_profiles_language_valid"), "profiles", type_="check")
    op.drop_constraint(op.f("ck_profiles_country_format"), "profiles", type_="check")
    op.drop_column("profiles", "language")
    op.drop_column("profiles", "country")

    for name in (
        "country_format",
        "transfer_no_original",
        "original_currency_differs",
        "original_currency_format",
        "original_amount_minor_positive",
        "original_pair",
    ):
        op.drop_constraint(
            op.f(f"ck_transactions_{name}"), "transactions", type_="check"
        )
    op.drop_column("transactions", "country")
    op.drop_column("transactions", "original_currency")
    op.drop_column("transactions", "original_amount_minor")
