"""CategoryLimit model — per-user monthly spending cap on a category (architecture D14).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
this table serves no fastapi-users protocol.

The limit cannot live as a column on ``categories``: system categories are SHARED
rows (``user_id IS NULL``), so a per-user budget on them would need either
copy-on-limit forking or an unqueryable JSON blob (D14). Composite natural PK
``(user_id, category_id)`` — the profiles/merchant_category_map precedent — IS the
uniqueness constraint AND the ``ON CONFLICT (user_id, category_id)`` upsert target,
and its leading column covers the list-by-user read, so no secondary index (D13).

``currency`` is stamped from the profile's base currency at set time and NEVER
re-interpreted or auto-converted afterwards (D15): a budget is a user-declared
threshold, not an observed transaction.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class CategoryLimit(Base):
    __tablename__ = "category_limits"
    __table_args__ = (
        # Naming convention turns name="amount_minor_positive" into
        # ck_category_limits_amount_minor_positive.
        CheckConstraint("amount_minor > 0", name="amount_minor_positive"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    category_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True
    )
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # Refreshed by the upsert (the merchant_category_map construction).
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
