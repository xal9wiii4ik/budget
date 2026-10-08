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

Since 0016 this table carries TWO kinds of row and the CHECK says which (mcp-remote
architecture §D3): a plain PAT (``token_hash`` set, ``oauth_client_id`` NULL) and
an OAuth GRANT (``token_hash`` NULL, ``oauth_client_id`` set — the credentials live
in ``oauth_access_tokens``/``oauth_refresh_tokens`` and point back here). One table
because everything downstream of authentication — ``PatContext``, the per-token
rate limit, the fail-closed allowlist, the scope gate, ``last_used_at`` and the
``pat_audit_log`` FK — then works for both with no second code path and no ``kind``
column to disagree with the data. ``/tokens`` filters grants OUT and ``/oauth/apps``
filters plain PATs out, so neither list ever shows the other's rows.
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
        # EXACTLY ONE credential kind per row (see the module docstring). Written as
        # an XOR rather than two partial CHECKs so neither "a row with both" nor "a
        # row with neither" — an unauthenticatable orphan — can exist.
        CheckConstraint(
            "(token_hash IS NULL) <> (oauth_client_id IS NULL)", name="credential"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    #: User-supplied label ("MacBook Claude Desktop") — the only way to tell two
    #: tokens apart in the settings list once the plaintext is gone.
    name: Mapped[str] = mapped_column(String(100))
    #: Hex SHA-256 of the FULL token string (prefix included). Unique index = the
    #: authentication lookup. NULL on an OAuth grant row, which has no bearer of
    #: its own — the UNIQUE index tolerates NULLs, so grants do not collide.
    token_hash: Mapped[str | None] = mapped_column(
        String(64), unique=True, index=True, nullable=True
    )
    #: Set on a grant row, NULL on a plain PAT. ``ON DELETE RESTRICT``: a client a
    #: user actually connected can never be pruned from under its audit history.
    oauth_client_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("oauth_clients.id", ondelete="RESTRICT"),
        nullable=True,
    )
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
