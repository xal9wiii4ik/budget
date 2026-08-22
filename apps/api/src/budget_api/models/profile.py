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
        CheckConstraint("country ~ '^[A-Z]{2}$'", name="country_format"),
        # An enumeration, not a format: the app ships exactly two UI languages, and
        # a well-formed-but-unsupported code ('de') would render as untranslated
        # keys rather than as a graceful fallback.
        CheckConstraint("language IN ('ru', 'en')", name="language_valid"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    base_currency: Mapped[str] = mapped_column(String(3))
    monthly_income_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # The user's country and UI language (S1/S5), both NULL until confirmed. NO
    # server_default on either: NULL is the marker the first-run prompt keys off,
    # and a default 'ru' would be indistinguishable from a deliberate choice.
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    language: Mapped[str | None] = mapped_column(String(2), nullable=True)
