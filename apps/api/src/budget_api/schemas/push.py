"""Web push request/response schemas (web-push architecture §6).

Lean DTOs: the wire never carries ``user_id`` (ownership is forced from the
session), and nothing here can carry money — a push is shown on a locked screen.

The subscribe body is the browser's ``PushSubscription.toJSON()`` shape
(``endpoint`` + ``keys.{p256dh, auth}``) plus the UI language and an optional,
client-truncated user agent. Whether the server may POST to ``endpoint`` at all is
a ROUTE decision (``domain/push_endpoint.py`` → 422 ``PUSH_ENDPOINT_INVALID``),
not a schema one: it depends on a per-app setting.
"""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

#: base64url, padding tolerated — what ``toJSON()`` emits for the two keys.
_B64URL = r"^[A-Za-z0-9_-]+={0,2}$"
#: Real endpoints run ~200-400 characters; the cap only refuses garbage early.
_MAX_ENDPOINT = 2048


class PushConfigRead(BaseModel):
    #: False while the server's VAPID keys are not configured — the web explains
    #: "not configured on the server" instead of offering a button that 503s.
    enabled: bool
    #: The VAPID public key (base64url, uncompressed P-256 point) for
    #: ``PushManager.subscribe({applicationServerKey})``; null while disabled.
    public_key: str | None


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=256, pattern=_B64URL)
    auth: str = Field(min_length=1, max_length=256, pattern=_B64URL)


class PushSubscriptionCreate(BaseModel):
    endpoint: str = Field(min_length=1, max_length=_MAX_ENDPOINT)
    keys: PushKeys
    #: The language the digest is rendered in when the profile has none.
    lang: Literal["ru", "en"]
    #: Support-only label for the device row; the web truncates to 255.
    user_agent: str | None = Field(default=None, max_length=255)


class PushSubscriptionRead(BaseModel):
    #: STABLE across re-subscribes of the same endpoint (the UPSERT keeps the row).
    id: uuid.UUID
    endpoint: str
    created_at: datetime  # tz-aware


class PushUnsubscribe(BaseModel):
    endpoint: str = Field(min_length=1, max_length=_MAX_ENDPOINT)


class PushTestResult(BaseModel):
    #: Devices the push service accepted the test message for.
    sent: int
    #: Devices the push service reported dead (404/410); their rows are deleted.
    removed: int


class PushError(BaseModel):
    """``PUSH_NOT_CONFIGURED`` (503) / ``PUSH_ENDPOINT_INVALID`` (422) /
    ``RATE_LIMITED`` (429) — one ``detail`` string code, the API-wide envelope."""

    detail: str
