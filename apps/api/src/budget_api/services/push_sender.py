"""Web Push delivery seam — the ONE place this API talks to a push service (§3).

Constructed once per app in ``create_app`` (``app.state.push_sender``), stateless
past its Settings, no I/O at build time — the ``fx_fetcher``/``advisor`` seam
contract. ``/push/test`` reads it off ``app.state``; the daily job is handed it in
its kwargs; pytest swaps a recording fake at exactly this seam, so no test ever
reaches the network.

``send`` NEVER raises. It answers one of three outcomes and the callers decide
what each means for the stored row:

* ``delivered`` — the push service accepted the message;
* ``gone`` — 404/410: the subscription is dead for good (the user revoked the
  permission, cleared the site data, the browser rotated it) and the row should be
  deleted;
* ``failed`` — anything else (a 5xx, a 403 after a VAPID key rotation, a timeout,
  a refused connection, a malformed stored key). The row is KEPT: a push service
  having a bad minute is not a dead device.

``pywebpush.webpush`` is synchronous (``requests``), so it runs in a worker thread
— the ``fx_jobs`` rule that no event loop ever blocks on outbound HTTP, without a
second HTTP client stack for ``webpush_async``.

Redirects are NEVER followed (``_NO_REDIRECTS``): ``requests`` follows 30x by
default, so a redirecting https name that passes ``endpoint_allowed`` could bounce
the POST to loopback or a compose host. A 3xx is a ``failed`` outcome, row kept.
"""

import asyncio
import functools
import json
import logging
from enum import StrEnum
from typing import Any, Protocol, cast
from urllib.parse import urlsplit

import requests

# pywebpush ships no ``py.typed`` (APScheduler/slowapi situation): the ignores and
# the ``Any`` aliases below are that and only that.
from pywebpush import WebPushException, webpush  # type: ignore

from budget_api.config import Settings

logger = logging.getLogger(__name__)

_webpush: Any = cast(Any, webpush)
_WebPushError: Any = WebPushException

#: Seconds the push service may hold the message for an offline device. A reminder
#: older than its day is stale, so one day and no longer — a constant, not a
#: setting.
_TTL_SECONDS = 86_400
#: ``webpush()`` defaults to ``timeout=None``, i.e. ``requests`` waits FOREVER: one
#: hung push service would pin a worker thread and stall /push/test or the job.
_TIMEOUT_SECONDS = 10
#: The push service's answer for "this subscription no longer exists".
_GONE_STATUSES = frozenset({404, 410})


class _NoRedirects:
    """The ``requests_session`` pywebpush POSTs through — it uses only ``.post``."""

    post = staticmethod(functools.partial(requests.post, allow_redirects=False))


_NO_REDIRECTS = _NoRedirects()


class PushTarget(Protocol):
    """Whatever carries a device's three browser values — an ORM row or a DTO."""

    @property
    def endpoint(self) -> str: ...

    @property
    def p256dh(self) -> str: ...

    @property
    def auth(self) -> str: ...


class SendOutcome(StrEnum):
    delivered = "delivered"
    gone = "gone"
    failed = "failed"


def _host(endpoint: str) -> str:
    """The endpoint's host, the ONLY part of it this module ever logs.

    The full endpoint URL is a bearer capability: anyone holding it (plus the
    server's VAPID key) can message that device. Logs are read by more people and
    kept longer than the table, so they get the push SERVICE, never the device.
    """
    return urlsplit(endpoint).hostname or "?"


class PushSender:
    def __init__(self, settings: Settings) -> None:
        self._public_key = settings.vapid_public_key
        self._private_key = settings.vapid_private_key
        self._subject = settings.vapid_subject

    @property
    def enabled(self) -> bool:
        """ON if and only if the whole VAPID trio is configured (§2)."""
        return bool(self._public_key and self._private_key and self._subject)

    @property
    def public_key(self) -> str | None:
        """The browser's ``applicationServerKey`` — ``None`` while disabled."""
        return self._public_key if self.enabled else None

    async def send(self, target: PushTarget, payload: dict[str, str]) -> SendOutcome:
        """Encrypt + deliver one payload to one device. Never raises."""
        try:
            await asyncio.to_thread(
                _webpush,
                subscription_info={
                    "endpoint": target.endpoint,
                    "keys": {"p256dh": target.p256dh, "auth": target.auth},
                },
                data=json.dumps(payload, ensure_ascii=False),
                vapid_private_key=self._private_key,
                # A FRESH dict on every call, never a shared one: webpush() MUTATES
                # it, writing ``aud`` (the origin of THIS endpoint) and ``exp``. A
                # dict reused across devices would carry the first push service's
                # audience to every other one, which they reject as a bad JWT.
                vapid_claims={"sub": self._subject},
                ttl=_TTL_SECONDS,
                timeout=_TIMEOUT_SECONDS,
                requests_session=_NO_REDIRECTS,
            )
        except _WebPushError as exc:
            response: Any = exc.response
            if response is None:
                # A local refusal before any request (a malformed stored key): its
                # message names the problem and carries no endpoint.
                logger.warning(
                    "push failed host=%s: %s", _host(target.endpoint), exc.message
                )
                return SendOutcome.failed
            status_code: int = response.status_code
            if status_code in _GONE_STATUSES:
                return SendOutcome.gone
            # Status + reason only: the exception message embeds the response BODY,
            # which is the push service's to word and may echo the subscription.
            logger.warning(
                "push failed (%s %s) host=%s",
                status_code,
                response.reason,
                _host(target.endpoint),
            )
            return SendOutcome.failed
        except Exception as exc:
            # Deliberately broad: requests' timeouts and connection errors are NOT
            # wrapped by pywebpush, nor are key-decoding errors, and "never raises"
            # is this method's contract (one device must not cost the others). The
            # TYPE only: a requests error's text spells out the full request URL.
            logger.warning(
                "push failed host=%s: %s", _host(target.endpoint), type(exc).__name__
            )
            return SendOutcome.failed
        return SendOutcome.delivered
