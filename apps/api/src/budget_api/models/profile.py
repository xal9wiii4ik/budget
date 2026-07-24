"""Profile model — per-user settings extension of the user row (architecture §2).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split
used by ``user.py``/``refresh_token.py``: that split exists only to satisfy the
fastapi-users protocols, and this table serves no library protocol.
"""

import uuid

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base

# Single definition: the register hook uses this; the 0003 backfill duplicates it
# as a literal 'RUB' (migrations are frozen snapshots, must not import app code).
DEFAULT_BASE_CURRENCY = "RUB"


class Profile(Base):
    __tablename__ = "profiles"
    __table_args__ = (
        CheckConstraint("base_currency ~ '^[A-Z]{3}$'", name="base_currency_format"),
        CheckConstraint(
            "monthly_income_minor >= 0", name="monthly_income_minor_non_negative"
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    base_currency: Mapped[str] = mapped_column(String(3))
    monthly_income_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
