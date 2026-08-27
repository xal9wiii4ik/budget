"""BankCategoryMap — per-user learned bank-category→category mapping (§5).

The exact mirror of ``merchant_category_map``: composite primary key
``(user_id, bank_category)`` is the ``ON CONFLICT`` target of the S2 learning
upsert, and the same table is the fallback the S2 suggestion read consults after
the merchant map (a merchant is more specific than one of the bank's 22 buckets).

The key is the bank's string as the FILE spells it, stripped and no more (unlike
``merchant_norm``, which is normalized): it is a lookup key inside ONE parser's
output, where the spelling is stable, and normalizing it would only create a
second key for the same bucket.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class BankCategoryMap(Base):
    __tablename__ = "bank_category_map"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    bank_category: Mapped[str] = mapped_column(String(255), primary_key=True)
    category_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("categories.id", ondelete="CASCADE")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
