"""Consent and connected-app schemas — the four JWT-only routes (§Contract).

What is NOT here is the point:

* no ``client_id`` on ``OAuthAppRead`` — a uuid the user cannot act on, and
  connectors are told apart by name and timestamps (plan open question 4);
* no ``state``, ``code_challenge`` or full ``redirect_uri`` on
  ``OAuthRequestRead`` — the consent page shows the redirect HOST, the one part a
  human can judge, plus whether it is a loopback address;
* no token, code or secret anywhere, in any direction.

``OAuthRequestRead.client_name`` is nullable and self-asserted: the app chose it,
nobody verified it, and the web renders it under a label saying exactly that. The
same field on ``OAuthAppRead`` is the name of the client the grant belongs to, so
the two routes agree about what an app is called.
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from budget_api.enums import PatScope


class OAuthRequestRead(BaseModel):
    """GET /oauth/requests/{id} — what the consent screen renders."""

    #: Declared by the app itself; null when it declared nothing.
    client_name: str | None
    #: Host of the URI the authorization response will go to, e.g. ``claude.ai``.
    redirect_host: str
    #: True when that host is loopback — "a program running on your own machine".
    loopback: bool
    #: The pending request dies at this moment (10 minutes). Part of the contract
    #: but not rendered today (grooming ruling, web open question 4).
    expires_at: datetime


class OAuthDecision(BaseModel):
    """POST /oauth/requests/{id}/decision body."""

    decision: Literal["allow", "deny"]
    #: The mode the user picked. Ignored on ``deny`` — the request is spent either
    #: way, so a denied flow cannot be re-decided into an allow.
    scope: PatScope


class OAuthDecisionResult(BaseModel):
    """Where the browser must go next — composed by the SERVER from the stored row."""

    redirect_to: str


class OAuthAppRead(BaseModel):
    """One connected AI application: the grant, as Settings shows it."""

    id: uuid.UUID
    client_name: str | None
    scope: PatScope
    created_at: datetime
    #: Debounced to one write per minute, exactly as for a PAT.
    last_used_at: datetime | None
    #: Revoked grants stay listed (the ``/tokens`` precedent: a revocation is a
    #: fact, and the web dims the row).
    revoked_at: datetime | None


class OAuthAppList(BaseModel):
    # List envelope (the tokens/goals precedent). Unpaginated: a user connects a
    # handful of AI apps, not thousands.
    items: list[OAuthAppRead]


class OAuthError(BaseModel):
    """404 error envelope — mirrors ``TokenError``."""

    detail: str
