"""OAuthAuthorizationCode — the 60-second bearer of a granted consent (§Database).

Minted when the user clicks Allow, redeemed once at ``/oauth/token``. It carries
everything the exchange needs to build the grant: WHO allowed it (``user_id``),
WHAT they allowed (``scope`` — the mode chosen on the consent page, not the
``scope`` the client asked for on the wire), and the PKCE challenge the SDK
compares the verifier against.

Only the SHA-256 hex of the code is stored (``token_hash`` precedent): the code is
a credential, and the UNIQUE index on the digest IS the lookup.

``used_at`` is set by ``UPDATE … WHERE used_at IS NULL RETURNING``, so two
simultaneous exchanges cannot both win. A REPLAY — presenting a code whose
``used_at`` is already set — revokes the grant in ``grant_id`` (RFC 6749 §4.1.2,
symmetric with refresh-token reuse): a code that leaked is assumed to have leaked
to somebody.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import PatScope
from budget_api.models.base import Base

# Rebuilt from the shared enum, exactly as personal_access_tokens does it: the
# mode on a code row is the mode the grant will carry, so one enum feeds both
# CHECKs. Byte-identical SQL to migration 0016 is guaranteed by PatScope's
# definition order and guarded by ``alembic check``.
_SCOPE_VALUES = ", ".join(f"'{s.value}'" for s in PatScope)


class OAuthAuthorizationCode(Base):
    __tablename__ = "oauth_authorization_codes"
    __table_args__ = (
        CheckConstraint(f"scope IN ({_SCOPE_VALUES})", name="scope_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: SHA-256 hex of the full ``bgt_oac_…`` string; the code itself is stored
    #: nowhere and logged nowhere.
    code_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE")
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("oauth_clients.id", ondelete="CASCADE")
    )
    #: The mode the USER picked at consent — the wire ``scope`` is advisory and is
    #: deliberately ignored (architecture §Security, scope escalation).
    scope: Mapped[str] = mapped_column(String(32))
    redirect_uri: Mapped[str] = mapped_column(Text)
    code_challenge: Mapped[str] = mapped_column(String(128))
    resource: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: The grant this code produced, filled at exchange — what a replay revokes.
    grant_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("personal_access_tokens.id", ondelete="CASCADE"),
        nullable=True,
    )
