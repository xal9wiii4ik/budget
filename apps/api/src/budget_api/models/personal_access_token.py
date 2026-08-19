"""PersonalAccessToken model — long-lived API credential for MCP clients (5.6 §1).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split
(the ``category_limit.py`` precedent): this table serves no fastapi-users protocol
— it is authenticated by ``pat_auth.py``, not by a fastapi-users strategy.

Only the SHA-256 hex digest of the token is stored, never the token itself. Not
argon2 deliberately (architecture §1): the token carries 256 bits of entropy from
``secrets.token_urlsafe(32)``, so brute force is irrelevant and a KDF would only
buy a per-request cost on every MCP call. The digest is a UNIQUE index, so the
lookup is O(1).

``revoked_at`` is a SOFT revoke: the row stays in the user's list (revoking is a
visible, auditable event) and ``pat_audit_log`` rows keep pointing at a live FK.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import PatScope
from budget_api.models.base import Base

# Rebuilt from the shared enum so the enum is the single source for both model and
# schema (the TransactionKind precedent). The rendered SQL MUST stay byte-identical
# to migration 0007 (``scope IN ('read', 'full')``); PatScope's definition order
# guarantees this and ``alembic check`` guards the drift.
_SCOPE_VALUES = ", ".join(f"'{s.value}'" for s in PatScope)


class PersonalAccessToken(Base):
    __tablename__ = "personal_access_tokens"
    __table_args__ = (
        CheckConstraint(f"scope IN ({_SCOPE_VALUES})", name="scope_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    #: User-supplied label ("MacBook Claude Desktop") — the only way to tell two
    #: tokens apart in the settings list once the plaintext is gone.
    name: Mapped[str] = mapped_column(String(100))
    #: Hex SHA-256 of the FULL token string (prefix included). Unique index = the
    #: authentication lookup.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    scope: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: Debounced to one write per ``pat_last_used_debounce_seconds`` (architecture
    #: §2): minute granularity is honest for a "last used" UI and costs no write
    #: per request.
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
