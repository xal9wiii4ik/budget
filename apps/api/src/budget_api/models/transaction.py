"""Transaction model — magnitude + NOT NULL kind (architecture §1 verdict (b)).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
this table serves no fastapi-users protocol.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import TransactionKind
from budget_api.models.base import Base

# Rebuilt from the shared enum so the enum is the single source for both model and
# schema. The rendered SQL MUST stay byte-identical to migration 0002
# (``kind IN ('expense', 'income')``); TransactionKind's definition order guarantees
# this, and `alembic check` / the autogenerate probe guards drift.
_KIND_VALUES = ", ".join(f"'{k.value}'" for k in TransactionKind)


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint("amount_minor >= 0", name="amount_minor_non_negative"),
        CheckConstraint(f"kind IN ({_KIND_VALUES})", name="kind_valid"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
        # Base-currency snapshot pair (D5): both set or both NULL, never half.
        CheckConstraint(
            "(base_amount_minor IS NULL) = (base_currency IS NULL)",
            name="base_snapshot_pair",
        ),
        # >= 0, not >= 1: an auto-computed snapshot of a tiny amount can legally
        # quantize to 0 minor units (e.g. 1 minor RUB -> USD). Only *user-supplied*
        # overrides are ge=1, and that guard lives at the schema layer.
        CheckConstraint(
            "base_amount_minor >= 0", name="base_amount_minor_non_negative"
        ),
        CheckConstraint("base_currency ~ '^[A-Z]{3}$'", name="base_currency_format"),
        Index("ix_transactions_user_id_occurred_at", "user_id", "occurred_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE")
    )
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(16))
    currency: Mapped[str] = mapped_column(String(3))
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    occurred_at: Mapped[date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    receipt_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("receipts.id", ondelete="SET NULL"), nullable=True
    )
    merchant: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Attribution only (D7): every display value of a materialized row is COPIED
    # at materialization, so a template edit can never retro-write history and a
    # template DELETE sets this to NULL without touching the money. No index (D13).
    recurring_template_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("recurring_templates.id", ondelete="SET NULL"), nullable=True
    )
    # Converted-amount snapshot in the profile's base currency at write time (D5).
    # Nullable pair: NULL/NULL means "no rate was available" (never a guess).
    base_amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    base_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
