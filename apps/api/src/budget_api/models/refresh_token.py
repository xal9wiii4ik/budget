"""Refresh-token model.

Role-named ``refresh_tokens`` (not the library mixin's ``accesstoken``). Backs the
``DatabaseStrategy`` refresh primitive via ``SQLAlchemyAccessTokenDatabase``, which
accepts any model exposing ``token`` (pk), ``user_id``, and a tz-aware
``created_at`` (architecture §3).

The ``TYPE_CHECKING`` split lets the class satisfy
``AccessTokenProtocol`` (``token: str`` etc.) for the type checker while the runtime
mapping uses ``mapped_column``.
"""

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


def _utcnow() -> datetime:
    return datetime.now(UTC)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    if TYPE_CHECKING:
        token: str
        user_id: uuid.UUID
        created_at: datetime
    else:
        # secrets.token_urlsafe() emits 43 chars (DatabaseStrategy default).
        token: Mapped[str] = mapped_column(String(43), primary_key=True)
        user_id: Mapped[uuid.UUID] = mapped_column(
            Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
        )
        # tz-aware Python default: the adapter's create() supplies no created_at and
        # DatabaseStrategy.read_token compares max age against it, so the model must
        # populate it before the post-commit refresh (architecture §3, plan §13.4).
        created_at: Mapped[datetime] = mapped_column(
            DateTime(timezone=True), default=_utcnow
        )
