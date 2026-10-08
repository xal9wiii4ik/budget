"""OAuthAuthorizationRequest — a pending consent decision (mcp-remote §Database).

``/oauth/authorize`` does not decide anything: it validates what the client sent,
parks it here and redirects the browser to the SPA's consent page with this row's
id in ``?req=``. The decision route then reads the row, and **composes the
redirect back to the client from THIS row** — never from anything the browser
sends. That is the whole reason the table exists: an open redirect would otherwise
be one forged request body away.

The id is a plain ``uuid4`` PK rather than a 256-bit opaque credential, and that is
a decision (architecture §D6): holding it lets the HOLDER see a client name and
decide for the HOLDER's OWN account — the decision binds to the logged-in user, so
the id authorises nothing. 122 random bits make guessing moot and every other
table here is uuid-keyed.

``consumed_at`` makes the row single-use under a race (``UPDATE … WHERE
consumed_at IS NULL AND expires_at > now() RETURNING``), and expired rows are
pruned lazily by the next ``authorize`` call — the ``statement_import_ttl_days``
precedent, no scheduler job for a table that holds tens of bytes per abandoned tab.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class OAuthAuthorizationRequest(Base):
    __tablename__ = "oauth_authorization_requests"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    client_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("oauth_clients.id", ondelete="CASCADE")
    )
    #: The URI the authorization response will be sent to, exactly as it was
    #: validated at ``/authorize``. THE source of ``redirect_to``.
    redirect_uri: Mapped[str] = mapped_column(Text)
    #: PKCE S256 challenge — a hash, not a secret; carried to the code row and
    #: compared by the SDK at ``/token``.
    code_challenge: Mapped[str] = mapped_column(String(128))
    #: The client's opaque nonce, echoed back untouched. Text, capped at 2 KB by
    #: the provider (ruling R2) — a client may legitimately pack a return path in
    #: here, and 512 would have refused Claude's own.
    state: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: RFC 8707 resource indicator as sent (already checked against ours).
    resource: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: Indexed because the lazy prune is the only query that reads this column.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
