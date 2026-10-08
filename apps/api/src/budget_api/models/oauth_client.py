"""OAuthClient — one dynamically registered AI application (mcp-remote §Database).

A row is created by RFC 7591 dynamic client registration (``POST /oauth/register``)
and is **anonymous**: nobody vouched for it, and everything it declared about
itself is self-asserted. That is why so little of what DCR sends is stored —
``client_uri``/``logo_uri``/``tos_uri``/``policy_uri`` are deliberately dropped
(they would be a phishing surface on the consent page), and ``client_name`` is
shown to the user only under the label "the name this app gave itself".

``id`` IS the ``client_id``: the SDK's registration handler mints
``str(uuid4())``, so a ``client_id`` that is not a uuid is answered "unknown
client" without touching the database at all.

``client_secret_hash`` is SHA-256 hex and NEVER the secret (ruling R1): the SDK's
own ``ClientAuthenticator`` compares a plaintext ``client_secret``, which is why
``oauth/client_auth.py`` replaces it. A public client (``token_endpoint_auth_method
= none``, PKCE being the binding) has no secret at all and this column stays NULL.

Rows are never pruned by a job: a grant's FK is ``ON DELETE RESTRICT``, so a
client that a user actually connected can never be deleted from under its audit
history. The orphan-client cleanup query is documented in ``apps/api/MCP.md``.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import OAuthClientAuthMethod
from budget_api.models.base import Base

# Rebuilt from the shared enum so the enum is the single source for the model, the
# DCR policy (``oauth/clients.py``) and the published AS metadata. The rendered SQL
# MUST stay byte-identical to migration 0016; the enum's definition order
# guarantees it and ``alembic check`` guards the drift.
_AUTH_METHOD_VALUES = ", ".join(f"'{m.value}'" for m in OAuthClientAuthMethod)


class OAuthClient(Base):
    __tablename__ = "oauth_clients"
    __table_args__ = (
        CheckConstraint(
            f"token_endpoint_auth_method IN ({_AUTH_METHOD_VALUES})",
            name="auth_method_valid",
        ),
    )

    #: The ``client_id`` itself (see the module docstring) — minted by the SDK's
    #: registration handler, not by us.
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    #: Self-declared, capped at 100 characters by ``oauth/clients.py``. NULL when
    #: the registrant named itself nothing, which the consent page must be able to
    #: say out loud.
    client_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    #: The exact strings registration accepted, 1..10 of them. JSONB rather than a
    #: child table: the list is read whole, written once, and never queried into.
    redirect_uris: Mapped[list[Any]] = mapped_column(JSONB)
    token_endpoint_auth_method: Mapped[str] = mapped_column(String(32))
    #: SHA-256 hex of the secret the registration response returned once, or NULL
    #: for a public client. The secret itself is stored nowhere (R1).
    client_secret_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
