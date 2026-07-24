"""Category model — system (user_id IS NULL) or user-owned (architecture §3/§6).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
this table serves no fastapi-users protocol.
"""

import uuid

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, String, Uuid, false
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import CategoryKind
from budget_api.models.base import Base

# Rebuilt from the shared enum so the enum is the single source for both model and
# schema. The rendered SQL MUST stay byte-identical to migration 0002
# (``kind IN ('expense', 'income')``); CategoryKind's definition order guarantees
# this, and `alembic check` / the autogenerate probe guards drift.
_KIND_VALUES = ", ".join(f"'{k.value}'" for k in CategoryKind)


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (CheckConstraint(f"kind IN ({_KIND_VALUES})", name="kind_valid"),)

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
