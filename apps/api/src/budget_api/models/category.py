"""Category model — system (user_id IS NULL) or user-owned (architecture §3/§6).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
this table serves no fastapi-users protocol.
"""

import uuid

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, String, Uuid, false
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (
        CheckConstraint("kind IN ('expense', 'income')", name="kind_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    icon: Mapped[str | None] = mapped_column(String(16), nullable=True)
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    kind: Mapped[str] = mapped_column(String(16))
    archived: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
