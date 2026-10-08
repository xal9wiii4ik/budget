"""OAuthAccessToken — one live ``bgt_oat_…`` bearer of a grant (§Database).

The GRANT is a ``personal_access_tokens`` row (architecture §D3); this table holds
the short-lived credentials pointing at it, so authenticating an OAuth call ends
in the same ``PatContext`` a plain PAT produces and the one enforcement pipeline
(``pat_auth`` → allowlist → scope → ``pat_audit``) runs unchanged.

Only the SHA-256 hex is stored, under the UNIQUE index that IS the lookup. Nothing
here says "revoked": revocation lives on the grant (``revoked_at``) and the single
resolver (``oauth/tokens.resolve_access_token``) joins it, so revoking cannot be
half-applied. Expired rows are pruned lazily at the next exchange.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class OAuthAccessToken(Base):
    __tablename__ = "oauth_access_tokens"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: The grant — a ``personal_access_tokens`` row with ``token_hash`` NULL and
    #: ``oauth_client_id`` set.
    grant_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("personal_access_tokens.id", ondelete="CASCADE"),
        index=True,
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
