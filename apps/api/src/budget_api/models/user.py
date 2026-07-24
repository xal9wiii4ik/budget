"""User model.

Own model on our naming-convention ``Base`` rather than the library mixin
(``SQLAlchemyBaseUserTable`` names the table ``user`` and uses the library's GUID
TypeDecorator — see architecture §3). ``SQLAlchemyUserDatabase`` accepts any model
exposing the protocol columns, so the mixin is optional. Column types/lengths
mirror the mixin deliberately so the adapter's assumptions hold.

The ``TYPE_CHECKING`` split mirrors the library mixin: type checkers see the plain
attribute types ``fastapi_users.models.UserProtocol`` requires (``email: str`` etc.,
not ``Mapped[str]``), while the runtime mapping uses ``mapped_column`` so Alembic
and SQLAlchemy behave normally.
"""

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, String, Uuid, false, func, true
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class User(Base):
    __tablename__ = "users"

    if TYPE_CHECKING:
        id: uuid.UUID
        email: str
        hashed_password: str
        is_active: bool
        is_superuser: bool
        is_verified: bool
        created_at: datetime
    else:
        id: Mapped[uuid.UUID] = mapped_column(
            Uuid, primary_key=True, default=uuid.uuid4
        )
        email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
        hashed_password: Mapped[str] = mapped_column(String(1024))
        is_active: Mapped[bool] = mapped_column(default=True, server_default=true())
        is_superuser: Mapped[bool] = mapped_column(
            default=False, server_default=false()
        )
        is_verified: Mapped[bool] = mapped_column(default=False, server_default=false())
        created_at: Mapped[datetime] = mapped_column(
            DateTime(timezone=True), server_default=func.now()
        )
