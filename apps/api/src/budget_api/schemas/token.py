"""Personal-access-token request/response schemas (architecture §1/§4).

Lean DTOs: the wire never carries ``user_id`` (ownership is forced from the
session) and NEVER carries ``token_hash`` — the digest is an authentication
secret's storage form, and a list endpoint that echoed it would hand an attacker
with read access the one value the table exists to protect.

``TokenCreated`` is the only schema carrying ``token``, and it is returned by
exactly one response, once: the plaintext is generated in the handler, hashed,
and never persisted or logged. A user who loses it revokes and re-creates.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from budget_api.enums import PatScope


class TokenCreate(BaseModel):
    #: Human label, the only way to tell two tokens apart after the plaintext is
    #: gone ("MacBook Claude Desktop").
    name: str = Field(min_length=1, max_length=100)
    scope: PatScope


class TokenRead(BaseModel):
    id: uuid.UUID
    name: str
    scope: PatScope
    created_at: datetime  # tz-aware
    #: Debounced to one write per minute (architecture §2) — "roughly when", not
    #: a per-call audit; ``pat_audit_log`` is the per-call record.
    last_used_at: datetime | None
    #: Soft revoke: a revoked token stays listed so the revocation is visible.
    revoked_at: datetime | None


class TokenCreated(BaseModel):
    """POST /tokens response — the ONLY place the plaintext ever appears."""

    id: uuid.UUID
    name: str
    scope: PatScope
    created_at: datetime
    #: Full ``bgt_pat_…`` string. Shown once; the server keeps only its SHA-256.
    token: str


class TokenList(BaseModel):
    # List envelope (the goals/recurring precedent). Unpaginated by design: a user
    # has a handful of tokens, not thousands.
    items: list[TokenRead]


class TokenSelf(BaseModel):
    """GET /tokens/self — what a token may learn about ITSELF, and nothing more.

    No name, no timestamps, no list, no plaintext: the MCP client needs its scope
    to decide which tools to publish, and it could have derived that from one
    probe call anyway, so this leaks nothing (architecture §4).
    """

    id: uuid.UUID
    scope: PatScope


class TokenError(BaseModel):
    """401/404 error envelope — mirrors ``LimitError`` / ``GoalError``."""

    detail: str
