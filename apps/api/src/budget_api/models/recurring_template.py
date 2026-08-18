"""RecurringTemplate model — a standing order the materializer books (architecture D2).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
this table serves no fastapi-users protocol.

The template is machinery, not money history: it carries NO base-currency snapshot
pair (D2). Each materialized transaction computes its own pair at its own due date
(D8), so a stored pair here would be a pre-computed guess that goes stale by
construction. ``last_materialized_on`` is the idempotency watermark (D6) and stays
off the wire (D10).
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    SmallInteger,
    String,
    Text,
    Uuid,
    false,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import RecurrenceUnit, TransactionKind
from budget_api.models.base import Base

# Rebuilt from the shared enums so each enum is the single source for both model
# and schema. The rendered SQL MUST stay byte-identical to migration 0006
# (``kind IN ('expense', 'income')``, ``interval_unit IN ('month', 'week')``); the
# enums' definition order guarantees this, and `alembic check` guards drift.
_KIND_VALUES = ", ".join(f"'{k.value}'" for k in TransactionKind)
_UNIT_VALUES = ", ".join(f"'{u.value}'" for u in RecurrenceUnit)


class RecurringTemplate(Base):
    __tablename__ = "recurring_templates"
    __table_args__ = (
        # Naming convention turns name="amount_minor_positive" into
        # ck_recurring_templates_amount_minor_positive.
        # > 0, not >= 0 like transactions: a template amount is always
        # user-supplied, never an auto-computed snapshot that can quantize to 0
        # (the goals target_minor_positive precedent).
        CheckConstraint("amount_minor > 0", name="amount_minor_positive"),
        CheckConstraint(f"kind IN ({_KIND_VALUES})", name="kind_valid"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
        CheckConstraint(
            f"interval_unit IN ({_UNIT_VALUES})", name="interval_unit_valid"
        ),
        CheckConstraint("day_of_month BETWEEN 1 AND 31", name="day_of_month_range"),
        CheckConstraint("weekday BETWEEN 0 AND 6", name="weekday_range"),
        # Both-or-neither, per unit: an inconsistent unit/anchor pair is
        # UNREPRESENTABLE, not review-guarded (the base_snapshot_pair style). The
        # domain's due-date math relies on this — a NULL anchor for its own unit is
        # a programming error there, not a user path.
        CheckConstraint(
            "(interval_unit = 'month') = (day_of_month IS NOT NULL) "
            "AND (interval_unit = 'week') = (weekday IS NOT NULL)",
            name="anchor_matches_unit",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(16))
    currency: Mapped[str] = mapped_column(String(3))
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    merchant: Mapped[str | None] = mapped_column(String(255), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    interval_unit: Mapped[str] = mapped_column(String(8))
    # Exactly one anchor is set, chosen by interval_unit (the CHECK above).
    day_of_month: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # ISO-style: 0 = Monday (== date.weekday() == isoweekday() - 1).
    weekday: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    paused: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    # Idempotency watermark (D6): the last date this template was materialized
    # through. NEVER on the wire.
    last_materialized_on: Mapped[date] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
