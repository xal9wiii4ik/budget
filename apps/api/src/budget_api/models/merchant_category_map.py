"""MerchantCategoryMap — per-user learned merchant→category mapping (architecture D3).

Composite primary key ``(user_id, merchant_norm)`` is the exact
``ON CONFLICT (user_id, merchant_norm)`` upsert target the S4 learning write and
the S3 suggestion read depend on. Plain ``Mapped[...]``/``mapped_column`` style
WITHOUT the ``TYPE_CHECKING`` split: this table serves no fastapi-users protocol.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class MerchantCategoryMap(Base):
    __tablename__ = "merchant_category_map"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    merchant_norm: Mapped[str] = mapped_column(String(255), primary_key=True)
    category_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="CASCADE")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
