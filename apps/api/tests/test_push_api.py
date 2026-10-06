"""/push/* routes against a real Postgres, the push service faked at its seam.

``FakePushSender`` (helpers.py) replaces ``app.state.push_sender`` wherever a send
could happen; the two tests that keep the REAL sender never reach a send (the
config/503 honesty check, the endpoint guard). PAT refusal of the four pairs is
pinned by ``test_pat_auth.py``'s ``NEVER_PAT``; Pydantic-only 422s are not tested.
"""

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from helpers import FakePushSender
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import PushSubscription
from budget_api.services.push_sender import SendOutcome

PASSWORD = "password123"

MakePushClient = Callable[..., Awaitable[AsyncClient]]


async def _register_and_login(client: AsyncClient, email: str) -> dict[str, str]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def _endpoint(name: str) -> str:
    return f"https://push.example.com/send/{name}"


def _body(
    endpoint: str, *, p256dh: str = "BKeyOne", lang: str = "ru"
) -> dict[str, Any]:
    return {
        "endpoint": endpoint,
        "keys": {"p256dh": p256dh, "auth": "authsecret"},
        "lang": lang,
    }


async def _subscribe(
    client: AsyncClient, headers: dict[str, str], endpoint: str, **body: Any
) -> dict[str, Any]:
    resp = await client.post(
        "/push/subscriptions", json=_body(endpoint, **body), headers=headers
    )
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


@dataclass(frozen=True)
class _Row:
    endpoint: str
    user_id: uuid.UUID
    p256dh: str
    lang: str


async def _rows(session: AsyncSession) -> list[_Row]:
    """The table as plain values (a rollback would expire ORM instances)."""
    result = await session.execute(
        select(
            PushSubscription.endpoint,
            PushSubscription.user_id,
            PushSubscription.p256dh,
            PushSubscription.lang,
        )
    )
    rows = [_Row(*row) for row in result.all()]
    await session.rollback()
    return rows


class TestSubscriptions:
    async def test_unsubscribe_removes_only_own_row_and_answers_foreign_identically(
        self, make_push_client: MakePushClient, db_session: AsyncSession
    ) -> None:
        client = await make_push_client(sender=FakePushSender())
        alice = await _register_and_login(client, "push-unsub-a@example.com")
        bob = await _register_and_login(client, "push-unsub-b@example.com")
        await _subscribe(client, alice, _endpoint("alice"))
        await _subscribe(client, bob, _endpoint("bob"))

        own = await client.post(
            "/push/unsubscribe", json={"endpoint": _endpoint("alice")}, headers=alice
        )
        foreign = await client.post(
            "/push/unsubscribe", json={"endpoint": _endpoint("bob")}, headers=alice
        )
        missing = await client.post(
            "/push/unsubscribe", json={"endpoint": _endpoint("never")}, headers=alice
        )

        # No-oracle: deleted / someone else's / never existed are one response.
        for resp in (own, foreign, missing):
            assert resp.status_code == 204
            assert resp.content == b""
            assert dict(resp.headers) == dict(own.headers)
        assert [row.endpoint for row in await _rows(db_session)] == [_endpoint("bob")]

    async def test_resubscribe_updates_the_row_in_place_and_keeps_its_id(
        self, make_push_client: MakePushClient, db_session: AsyncSession
    ) -> None:
        client = await make_push_client(sender=FakePushSender())
        alice = await _register_and_login(client, "push-resub@example.com")

        first = await _subscribe(client, alice, _endpoint("dev"), p256dh="BOld")
        second = await _subscribe(
            client, alice, _endpoint("dev"), p256dh="BNew", lang="en"
        )

        assert second["id"] == first["id"]
        assert second["created_at"] == first["created_at"]
        (row,) = await _rows(db_session)
        assert (row.p256dh, row.lang) == ("BNew", "en")

    async def test_another_account_posting_the_endpoint_takes_the_device_over(
        self, make_push_client: MakePushClient, db_session: AsyncSession
    ) -> None:
        client = await make_push_client(sender=FakePushSender())
        alice = await _register_and_login(client, "push-rebind-a@example.com")
        bob = await _register_and_login(client, "push-rebind-b@example.com")
        first = await _subscribe(client, alice, _endpoint("shared"))

        rebound = await _subscribe(client, bob, _endpoint("shared"))

        assert rebound["id"] == first["id"]
        bob_id = uuid.UUID((await client.get("/users/me", headers=bob)).json()["id"])
        (row,) = await _rows(db_session)
        assert row.user_id == bob_id

    async def test_endpoint_must_be_https_to_a_named_host_unless_the_stand_flag_is_on(
        self, make_push_client: MakePushClient, db_session: AsyncSession
    ) -> None:
        """The server POSTs to the stored URL itself — a loopback/LAN target is SSRF."""
        guarded = await make_push_client()
        alice = await _register_and_login(guarded, "push-ssrf@example.com")
        insecure = [
            "http://push.example.com/send/x",
            "https://127.0.0.1/send/x",
            "https://minio/send/x",  # bare label: a compose service name
            "https://\uff11\uff12\uff17.\uff10.\uff10.\uff11/send/x",  # fullwidth
        ]

        for endpoint in insecure:
            resp = await guarded.post(
                "/push/subscriptions", json=_body(endpoint), headers=alice
            )
            assert resp.status_code == 422, endpoint
            assert resp.json() == {"detail": "PUSH_ENDPOINT_INVALID"}
        assert await _rows(db_session) == []

        stand = await make_push_client(push_allow_insecure_endpoints=True)
        for endpoint in insecure:
            await _subscribe(stand, alice, endpoint)
        assert sorted(row.endpoint for row in await _rows(db_session)) == sorted(
            insecure
        )


class TestConfiguration:
    async def test_keyless_server_says_so_and_refuses_only_what_needs_keys(
        self, make_push_client: MakePushClient
    ) -> None:
        # The REAL sender on both apps: "configured" is the whole VAPID trio, so
        # blanking ONE member (both keys still set) is already "not configured".
        keyless = await make_push_client(vapid_subject="")
        assert (await keyless.post("/push/test")).status_code == 401  # 401 first
        alice = await _register_and_login(keyless, "push-keyless@example.com")

        config = await keyless.get("/push/config", headers=alice)
        subscribe = await keyless.post(
            "/push/subscriptions", json=_body(_endpoint("x")), headers=alice
        )
        test = await keyless.post("/push/test", headers=alice)
        unsubscribe = await keyless.post(
            "/push/unsubscribe", json={"endpoint": _endpoint("x")}, headers=alice
        )

        assert config.json() == {"enabled": False, "public_key": None}
        for resp in (subscribe, test):
            assert resp.status_code == 503
            assert resp.json() == {"detail": "PUSH_NOT_CONFIGURED"}
        assert unsubscribe.status_code == 204

        keyed = await make_push_client(vapid_public_key="BPublicKey")
        config = await keyed.get("/push/config", headers=alice)
        assert config.json() == {"enabled": True, "public_key": "BPublicKey"}


class TestTestPush:
    async def test_reaches_own_devices_prunes_gone_keeps_failed_and_is_rate_limited(
        self, make_push_client: MakePushClient, db_session: AsyncSession
    ) -> None:
        sender = FakePushSender(
            outcomes={
                _endpoint("gone"): SendOutcome.gone,
                _endpoint("failed"): SendOutcome.failed,
            }
        )
        client = await make_push_client(
            sender=sender, rate_limit_enabled=True, push_test_rate_limit="1/minute"
        )
        alice = await _register_and_login(client, "push-test-a@example.com")
        bob = await _register_and_login(client, "push-test-b@example.com")
        for name in ("ok", "gone", "failed"):
            await _subscribe(client, alice, _endpoint(name))
        await _subscribe(client, bob, _endpoint("bob"))

        resp = await client.post("/push/test", headers=alice)

        assert resp.status_code == 200, resp.text
        assert resp.json() == {"sent": 1, "removed": 1}
        assert sorted(endpoint for endpoint, _ in sender.sent) == sorted(
            [_endpoint("ok"), _endpoint("gone"), _endpoint("failed")]
        )
        assert sorted(row.endpoint for row in await _rows(db_session)) == sorted(
            [_endpoint("ok"), _endpoint("failed"), _endpoint("bob")]
        )

        again = await client.post("/push/test", headers=alice)
        assert again.status_code == 429
        assert again.json() == {"detail": "RATE_LIMITED"}
