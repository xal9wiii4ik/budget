"""Receipt model — uploaded receipt image + async parse lifecycle (architecture D1).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
this table serves no fastapi-users protocol.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import ReceiptStatus
from budget_api.models.base import Base

# Rebuilt from the shared enum so the enum is the single source for both model and
# schema. The rendered SQL MUST stay byte-identical to migration 0004
# (``status IN ('pending', 'processing', 'parsed', 'failed')``); ReceiptStatus's
# definition order guarantees this, and `alembic check` / the autogenerate probe
# guards drift.
_STATUS_VALUES = ", ".join(f"'{s.value}'" for s in ReceiptStatus)


class Receipt(Base):
    __tablename__ = "receipts"
    __table_args__ = (
        # Naming convention turns name="status_valid" into ck_receipts_status_valid.
        CheckConstraint(f"status IN ({_STATUS_VALUES})", name="status_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    storage_path: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(16))
    parsed_json: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parse_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
