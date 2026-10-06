"""The real ``PushSender.send``: how a push service's answer maps to an outcome.

Every other push test swaps in ``FakePushSender``, so this mapping (and the fresh
``vapid_claims`` per call) is reachable only here. ``_webpush`` — the process
boundary — is stubbed; the real ``webpush`` is never called.
"""

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import pytest
from pywebpush import WebPushException  # type: ignore

from budget_api.config import Settings
from budget_api.services import push_sender
from budget_api.services.push_sender import PushSender, SendOutcome


@dataclass(frozen=True)
class _Target:
    endpoint: str
    p256dh: str = "p256dh-key"
    auth: str = "auth-secret"


@dataclass(frozen=True)
class _Response:
    status_code: int
    reason: str = "reason"


def _sender() -> PushSender:
    # send() never touches the DB or JWT: dummy strings are enough.
    return PushSender(
        Settings(
            database_url="postgresql+asyncpg://unused/unused",
            jwt_secret="unused",
            vapid_public_key="dummy-public",
            vapid_private_key="dummy-private",
            vapid_subject="mailto:qa@budgetqa.dev",
        )
    )


class TestPushSenderSend:
    @pytest.mark.parametrize(
        ("raised", "expected"),
        [
            (None, SendOutcome.delivered),
            (WebPushException("gone", response=_Response(410)), SendOutcome.gone),
            (WebPushException("not found", response=_Response(404)), SendOutcome.gone),
            (WebPushException("busy", response=_Response(503)), SendOutcome.failed),
            (WebPushException("bad key", response=None), SendOutcome.failed),
            (Exception("read timed out"), SendOutcome.failed),
        ],
        ids=["ok", "410", "404", "503", "no-response", "timeout"],
    )
    async def test_maps_push_service_answer_to_outcome(
        self,
        monkeypatch: pytest.MonkeyPatch,
        raised: Exception | None,
        expected: SendOutcome,
    ) -> None:
        def stub(*, requests_session: Any, **_: Any) -> None:
            # Never follow a redirect past the endpoint guard (loopback, compose).
            assert requests_session.post.keywords == {"allow_redirects": False}
            if raised is not None:
                raise raised

        monkeypatch.setattr(push_sender, "_webpush", stub)

        outcome = await _sender().send(_Target("https://push.example/d"), {"t": "x"})

        assert outcome is expected

    async def test_each_call_gets_a_fresh_vapid_claims_dict(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: list[dict[str, Any]] = []

        def stub(
            *, subscription_info: dict[str, Any], vapid_claims: dict[str, Any], **_: Any
        ) -> None:
            # What webpush() does: fill ``aud`` from the endpoint unless already set.
            endpoint: str = subscription_info["endpoint"]
            parts = urlsplit(endpoint)
            vapid_claims.setdefault("aud", f"{parts.scheme}://{parts.netloc}")
            seen.append(vapid_claims)

        monkeypatch.setattr(push_sender, "_webpush", stub)
        sender = _sender()

        await sender.send(_Target("https://fcm.example/a"), {"t": "x"})
        await sender.send(_Target("https://mozilla.example/b"), {"t": "x"})

        assert seen[0] is not seen[1]
        assert seen[0]["aud"] == "https://fcm.example"
        assert seen[1]["aud"] == "https://mozilla.example"
