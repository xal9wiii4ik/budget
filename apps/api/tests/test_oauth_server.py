"""The OAuth 2.1 authorization server, driven over the real ASGI app (mcp-remote B1).

Real Postgres, real SDK handlers, no mocks: every test below is a sequence of HTTP
requests a Claude client would make, so what is proven is the wire behaviour and
not our idea of it.

Every app here is built with ``public_base_url`` set — without it the OAuth routes
are not registered at all, which is the state of the rest of the suite. ``http://``
is allowed only for loopback hosts (ruling R6), so the base URL is
``http://localhost`` rather than the ``http://testserver`` of the grooming note:
widening a security validator to suit a test is not on the table.

Lifetimes are shrunk through ``Settings`` (``oauth_*_lifetime_seconds=0``) instead
of by sleeping; the expiry predicates read the DATABASE clock, so a zero lifetime
is deterministically "already expired" on the next statement.

Deliberately NOT here: PKCE method ``plain`` and a missing ``code_verifier`` (the
SDK's request model is ``Literal["S256"]`` and a required field — pydantic alone
refuses them), the shape of the SDK's error envelopes, and a 401 test per OAuth
route (``test_oauth_routes.py`` owns the four contract routes).
"""

import uuid
from typing import Any

import pytest
from helpers import (
    OAUTH_REDIRECT_URI,
    ConnectedApp,
    account_for_currency,
    basic_auth_header,
    connect_oauth_app,
    consent_request_id,
    pkce_pair,
    redirect_params,
    register_oauth_client,
)
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.oauth.tokens import OAUTH_ACCESS_PREFIX, OAUTH_REFRESH_PREFIX

PASSWORD = "password123"

#: Every OAuth test app needs this; the suite's other apps deliberately do not.
PUBLIC_BASE_URL = "http://localhost"


async def _register_and_login(
    client: AsyncClient, email: str
) -> tuple[dict[str, str], uuid.UUID]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    user_id = uuid.UUID(reg.json()["id"])
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}, user_id


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _authorize(client: AsyncClient, client_id: str, **overrides: Any) -> Any:
    params: dict[str, Any] = {
        "client_id": client_id,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "response_type": "code",
        "code_challenge": pkce_pair()[1],
        "code_challenge_method": "S256",
        "state": "client-nonce",
    }
    params.update(overrides)
    params = {k: v for k, v in params.items() if v is not None}
    return await client.get("/oauth/authorize", params=params)


async def _refresh(client: AsyncClient, app: ConnectedApp, token: str) -> Any:
    return await client.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": token,
            "client_id": app.client_id,
        },
    )


async def _exchange(client: AsyncClient, app: ConnectedApp, code: str) -> Any:
    return await client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": app.redirect_uri,
            "client_id": app.client_id,
            "code_verifier": app.verifier,
        },
    )


class TestHonestFlow:
    async def test_registration_consent_and_exchange_yield_a_working_bearer(
        self, make_client: Any
    ) -> None:
        """DCR → authorize → consent → token, and the token reaches a data route.

        The one test that proves the feature exists. It also pins the two shapes
        the SPA and the client depend on: the 302 to the consent page carrying
        ``?req=``, and ``GET /oauth/requests/{id}`` describing the app by its
        declared name, its redirect HOST and the loopback flag.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers, _ = await _register_and_login(client, "flow@example.com")
        registered = await register_oauth_client(client)
        verifier, challenge = pkce_pair()

        started = await _authorize(
            client,
            registered["client_id"],
            code_challenge=challenge,
            # RFC 8707: Claude names the audience it wants the token for, and the
            # matching value has to be ACCEPTED — the refusal of a foreign one is
            # only meaningful next to this.
            resource=f"{PUBLIC_BASE_URL}/mcp",
        )
        assert started.status_code == 302
        location = started.headers["location"]
        assert location.startswith(f"{PUBLIC_BASE_URL}/oauth/consent?req=")
        request_id = consent_request_id(location)

        described = await client.get(f"/oauth/requests/{request_id}", headers=headers)
        assert described.status_code == 200, described.text
        assert described.json()["client_name"] == "Test AI app"
        assert described.json()["redirect_host"] == "localhost"
        assert described.json()["loopback"] is True

        decided = await client.post(
            f"/oauth/requests/{request_id}/decision",
            json={"decision": "allow", "scope": "read"},
            headers=headers,
        )
        assert decided.status_code == 200, decided.text
        granted = redirect_params(decided.json()["redirect_to"])
        assert decided.json()["redirect_to"].startswith("http://localhost:4242/cb?")
        # The client's nonce comes back untouched — it is how a client matches the
        # response to the request it started.
        assert granted["state"] == "client-nonce"

        exchanged = await client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "code": granted["code"],
                "redirect_uri": OAUTH_REDIRECT_URI,
                "client_id": registered["client_id"],
                "code_verifier": verifier,
            },
        )
        assert exchanged.status_code == 200, exchanged.text
        tokens = exchanged.json()
        # The mode the USER picked, not the (absent) wire scope.
        assert tokens["scope"] == "read"
        assert tokens["token_type"] == "Bearer"
        assert tokens["expires_in"] == 3600
        assert tokens["access_token"].startswith(OAUTH_ACCESS_PREFIX)
        assert tokens["refresh_token"].startswith(OAUTH_REFRESH_PREFIX)

        served = await client.get(
            "/transactions", headers=_bearer(tokens["access_token"])
        )
        assert served.status_code == 200, served.text

        listed = await client.get("/oauth/apps", headers=headers)
        assert [
            (row["client_name"], row["scope"], row["revoked_at"])
            for row in listed.json()["items"]
        ] == [("Test AI app", "read", None)]

    async def test_refresh_rotates_and_reusing_the_old_token_revokes_the_grant(
        self, make_client: Any
    ) -> None:
        """Rotation issues a NEW pair; presenting the spent one kills the family.

        The family IS the grant (there is no ``family`` column), so the proof that
        reuse was detected is that the ALREADY-ROTATED access token stops working
        too — a stolen refresh token cannot outlive its detection.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers, _ = await _register_and_login(client, "refresh@example.com")
        app = await connect_oauth_app(client, headers, scope="full")

        rotated = await _refresh(client, app, app.refresh_token)
        assert rotated.status_code == 200, rotated.text
        fresh = rotated.json()
        assert fresh["access_token"] != app.access_token
        assert fresh["refresh_token"] != app.refresh_token
        assert fresh["scope"] == "full"
        assert (
            await client.get("/transactions", headers=_bearer(fresh["access_token"]))
        ).status_code == 200

        reused = await _refresh(client, app, app.refresh_token)
        assert reused.status_code == 400
        assert reused.json()["error"] == "invalid_grant"
        assert (
            await client.get("/transactions", headers=_bearer(fresh["access_token"]))
        ).status_code == 401
        revoked = await client.get("/oauth/apps", headers=headers)
        assert revoked.json()["items"][0]["revoked_at"] is not None

    async def test_replaying_a_consumed_code_revokes_the_grant_it_produced(
        self, make_client: Any
    ) -> None:
        """RFC 6749 §4.1.2: a code presented twice is assumed to have leaked."""
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers, _ = await _register_and_login(client, "replay@example.com")
        app = await connect_oauth_app(client, headers)

        replayed = await _exchange(client, app, app.code)
        assert replayed.status_code == 400
        assert replayed.json()["error"] == "invalid_grant"
        assert (
            await client.get("/transactions", headers=_bearer(app.access_token))
        ).status_code == 401
        listed = await client.get("/oauth/apps", headers=headers)
        assert listed.json()["items"][0]["revoked_at"] is not None

    async def test_a_wrong_code_verifier_is_refused(self, make_client: Any) -> None:
        """PKCE is what binds the code to the client that started the flow."""
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers, _ = await _register_and_login(client, "pkce@example.com")
        registered = await register_oauth_client(client)
        _, challenge = pkce_pair()
        started = await _authorize(
            client, registered["client_id"], code_challenge=challenge
        )
        request_id = consent_request_id(started.headers["location"])
        decided = await client.post(
            f"/oauth/requests/{request_id}/decision",
            json={"decision": "allow", "scope": "read"},
            headers=headers,
        )
        code = redirect_params(decided.json()["redirect_to"])["code"]

        refused = await client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": OAUTH_REDIRECT_URI,
                "client_id": registered["client_id"],
                # A verifier from a DIFFERENT pair: right shape, wrong secret.
                "code_verifier": pkce_pair()[0],
            },
        )
        assert refused.status_code == 400
        assert refused.json()["error"] == "invalid_grant"

    async def test_a_denied_consent_tells_the_client_access_denied(
        self, make_client: Any
    ) -> None:
        """Deny spends the request and answers on the client's own redirect URI."""
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers, _ = await _register_and_login(client, "deny@example.com")
        registered = await register_oauth_client(client)
        started = await _authorize(client, registered["client_id"])
        request_id = consent_request_id(started.headers["location"])

        denied = await client.post(
            f"/oauth/requests/{request_id}/decision",
            json={"decision": "deny", "scope": "read"},
            headers=headers,
        )
        assert denied.status_code == 200, denied.text
        params = redirect_params(denied.json()["redirect_to"])
        assert params["error"] == "access_denied"
        assert params["state"] == "client-nonce"
        assert "code" not in params
        # Spent: a denial cannot be re-decided into an allow.
        again = await client.post(
            f"/oauth/requests/{request_id}/decision",
            json={"decision": "allow", "scope": "full"},
            headers=headers,
        )
        assert again.status_code == 404
        assert again.json()["detail"] == "OAUTH_REQUEST_NOT_FOUND"

    async def test_an_expired_consent_request_is_gone_for_both_routes(
        self, make_client: Any
    ) -> None:
        """A parked request that nobody decided in time is a 404, not a grant."""
        client = await make_client(
            public_base_url=PUBLIC_BASE_URL, oauth_request_lifetime_seconds=0
        )
        headers, _ = await _register_and_login(client, "expired@example.com")
        registered = await register_oauth_client(client)
        started = await _authorize(client, registered["client_id"])
        request_id = consent_request_id(started.headers["location"])

        assert (
            await client.get(f"/oauth/requests/{request_id}", headers=headers)
        ).status_code == 404
        decided = await client.post(
            f"/oauth/requests/{request_id}/decision",
            json={"decision": "allow", "scope": "read"},
            headers=headers,
        )
        assert decided.status_code == 404
        assert decided.json()["detail"] == "OAUTH_REQUEST_NOT_FOUND"


class TestAuthorizeHardening:
    @pytest.mark.parametrize(
        ("overrides", "expected_error"),
        [
            # The path must match exactly even on a registered loopback host.
            pytest.param(
                {"redirect_uri": "http://localhost:4242/evil"},
                None,
                id="tampered-path",
            ),
            pytest.param(
                {"redirect_uri": "https://evil.example/cb"}, None, id="foreign-host"
            ),
            # Without an explicit redirect_uri the consent page cannot show the
            # user where their data would go (provider.authorize) — and here the
            # URI is trusted (the client has exactly one), so the refusal is
            # redirected rather than shown.
            pytest.param(
                {"redirect_uri": None}, "invalid_request", id="missing-redirect-uri"
            ),
            # Ruling R2: 2 KB of state is accepted, one byte more is not.
            pytest.param({"state": "s" * 2049}, "invalid_request", id="state-over-2kb"),
            pytest.param(
                {"resource": "https://other.example/mcp"},
                "invalid_target",
                id="foreign-resource",
            ),
        ],
    )
    async def test_authorize_refusals(
        self, make_client: Any, overrides: dict[str, Any], expected_error: str | None
    ) -> None:
        """Each refusal, and WHERE it is answered.

        A redirect_uri we cannot trust is answered to the END USER (a 400 body):
        redirecting the error would use the very URI under suspicion. Once the URI
        IS trusted, RFC 6749 §4.1.2.1 requires the error to go BACK to the client,
        so these arrive as a 302 carrying ``error=`` — the live-probe sheet's "400"
        for those two cases is the RFC-wrong expectation, not this.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        registered = await register_oauth_client(client)
        refused = await _authorize(client, registered["client_id"], **overrides)
        if expected_error is None:
            assert refused.status_code == 400, refused.text
            assert refused.json()["error"] == "invalid_request"
        else:
            assert refused.status_code == 302, refused.text
            params = redirect_params(refused.headers["location"])
            assert params["error"] == expected_error
            assert params["state"] == overrides.get("state", "client-nonce")

    async def test_a_loopback_redirect_may_change_its_port(
        self, make_client: Any
    ) -> None:
        """Claude Code gets a fresh ephemeral port per login and registers none."""
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        registered = await register_oauth_client(client)
        started = await _authorize(
            client, registered["client_id"], redirect_uri="http://localhost:9999/cb"
        )
        assert started.status_code == 302
        assert started.headers["location"].startswith(
            f"{PUBLIC_BASE_URL}/oauth/consent?req="
        )


class TestRegistration:
    @pytest.mark.parametrize(
        "overrides",
        [
            # The prefix-match trap: a host that merely STARTS with claude.ai.
            pytest.param(
                {
                    "redirect_uris": [
                        "https://claude.ai.evil.example/api/mcp/auth_callback"
                    ]
                },
                id="lookalike-host",
            ),
            pytest.param(
                {"redirect_uris": ["https://app.example/cb"]}, id="arbitrary-https"
            ),
            pytest.param(
                {"redirect_uris": [f"http://localhost:{p}/cb" for p in range(11)]},
                id="too-many-uris",
            ),
            pytest.param({"client_name": "n" * 101}, id="long-name"),
            pytest.param(
                {"response_types": ["code", "token"]}, id="implicit-response-type"
            ),
            pytest.param(
                {"grant_types": ["authorization_code", "client_credentials"]},
                id="foreign-grant",
            ),
            pytest.param(
                {"token_endpoint_auth_method": "private_key_jwt"}, id="jwt-auth-method"
            ),
        ],
    )
    async def test_registration_refusals(
        self, make_client: Any, overrides: dict[str, Any]
    ) -> None:
        """Every DCR cap, each one a refusal an anonymous caller must not get past."""
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        body: dict[str, Any] = {
            "redirect_uris": [OAUTH_REDIRECT_URI],
            "client_name": "Test AI app",
            "response_types": ["code"],
            "grant_types": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_method": "none",
        }
        body.update(overrides)
        refused = await client.post("/oauth/register", json=body)
        assert refused.status_code == 400, refused.text
        assert refused.json()["error"] in {
            "invalid_redirect_uri",
            "invalid_client_metadata",
        }

    async def test_an_oversized_registration_body_is_refused_unread(
        self, make_client: Any
    ) -> None:
        """16 KiB cap (the SDK's own middleware), so a megabyte is never parsed."""
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        refused = await client.post(
            "/oauth/register",
            json={
                "redirect_uris": [OAUTH_REDIRECT_URI],
                "client_name": "x" * 20000,
            },
        )
        assert refused.status_code == 413

    async def test_a_secret_bearing_client_round_trips_and_stores_only_a_digest(
        self, make_client: Any, db_session: AsyncSession
    ) -> None:
        """Ruling R1: the two secret methods work, and the secret is never stored.

        Also the one place the whole flow runs for a confidential client, so the
        wrong-secret 401 is proven against a client that otherwise works.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers, _ = await _register_and_login(client, "secret@example.com")
        app = await connect_oauth_app(
            client, headers, token_endpoint_auth_method="client_secret_post"
        )
        assert app.client_secret is not None
        stored = (
            await db_session.execute(
                text("SELECT client_secret_hash FROM oauth_clients WHERE id = :id"),
                {"id": uuid.UUID(app.client_id)},
            )
        ).scalar_one()
        assert stored is not None
        assert app.client_secret not in stored

        wrong = await client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": app.refresh_token,
                "client_id": app.client_id,
                "client_secret": "not-the-secret",
            },
        )
        assert wrong.status_code == 401
        assert wrong.json()["error"] == "invalid_client"
        # And the real secret still works, so the refusal was about the secret.
        accepted = await client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": app.refresh_token,
                "client_id": app.client_id,
                "client_secret": app.client_secret,
            },
        )
        assert accepted.status_code == 200, accepted.text

    async def test_a_basic_auth_client_authenticates_through_the_header(
        self, make_client: Any, db_session: AsyncSession
    ) -> None:
        """``client_secret_basic`` — the most hand-written parsing in the scope.

        The completed flow IS the positive half: the code exchange inside the
        helper carries the credentials in the ``Authorization`` header, so base64
        decoding, RFC 6749 §2.3.1 percent-decoding and the cross-check against the
        body's ``client_id`` all have to accept it. The wrong secret then proves
        the digest comparison is a comparison and not a formality. The row is read
        as text, so a plaintext secret in ANY column fails this.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers, _ = await _register_and_login(client, "basic@example.com")
        app = await connect_oauth_app(
            client, headers, token_endpoint_auth_method="client_secret_basic"
        )
        assert app.client_secret is not None

        row = (
            await db_session.execute(
                text("SELECT c::text FROM oauth_clients c WHERE c.id = :id"),
                {"id": uuid.UUID(app.client_id)},
            )
        ).scalar_one()
        assert app.client_secret not in row

        wrong = await client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": app.refresh_token,
                "client_id": app.client_id,
            },
            headers=basic_auth_header(app.client_id, "not-the-secret"),
        )
        assert wrong.status_code == 401
        assert wrong.json()["error"] == "invalid_client"

    async def test_a_registration_that_is_refused_still_spends_the_bucket(
        self, make_client: Any
    ) -> None:
        """Ruling R8: the per-IP limiter sits AHEAD of validation.

        Otherwise an attacker registers garbage for free and the limit protects
        nothing — the cost is the request, not the row.
        """
        client = await make_client(
            public_base_url=PUBLIC_BASE_URL,
            rate_limit_enabled=True,
            oauth_register_rate_limit="2/hour",
        )
        first = await client.post("/oauth/register", json={"redirect_uris": []})
        assert first.status_code == 400
        second = await client.post("/oauth/register", json={"redirect_uris": []})
        assert second.status_code == 400
        third = await client.post(
            "/oauth/register", json={"redirect_uris": [OAUTH_REDIRECT_URI]}
        )
        assert third.status_code == 429
        assert third.json() == {"detail": "RATE_LIMITED"}

    async def test_the_pre_grant_endpoints_are_rate_limited_per_ip(
        self, make_client: Any
    ) -> None:
        """``/authorize`` and ``/token`` have no token to key a budget on (§D9)."""
        client = await make_client(
            public_base_url=PUBLIC_BASE_URL,
            rate_limit_enabled=True,
            oauth_endpoint_rate_limit="1/minute",
        )
        registered = await register_oauth_client(client)
        assert (await _authorize(client, registered["client_id"])).status_code == 302
        throttled = await _authorize(client, registered["client_id"])
        assert throttled.status_code == 429
        assert throttled.json() == {"detail": "RATE_LIMITED"}
        # A separate bucket per endpoint: one hot endpoint must not close the other.
        first_token = await client.post(
            "/oauth/token", data={"grant_type": "refresh_token"}
        )
        assert first_token.status_code in {400, 401}
        assert (
            await client.post("/oauth/token", data={"grant_type": "refresh_token"})
        ).status_code == 429

    async def test_a_json_body_at_the_token_endpoint_is_invalid_request(
        self, make_client: Any
    ) -> None:
        """RFC 6749 §4.1.3 wants a form; Anthropic's notes name a 415 here as THE break.

        A JSON body must come back as ``400 invalid_request`` — not a 415, and not
        the "missing client_id" 401 an empty parsed form would produce.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        refused = await client.post(
            "/oauth/token", json={"grant_type": "authorization_code", "code": "x"}
        )
        assert refused.status_code == 400
        assert refused.json()["error"] == "invalid_request"


class TestGrantEnforcement:
    async def test_a_write_under_a_read_grant_is_refused_and_audited(
        self, make_client: Any, db_session: AsyncSession
    ) -> None:
        """The grant IS a PAT row, so the ONE enforcement pipeline runs unchanged.

        Proven by the two things only that pipeline produces: the scope gate's 403
        ``TOKEN_SCOPE_READONLY``, and a ``pat_audit_log`` row whose ``token_id`` is
        the GRANT id — the refusal is in the audit trail, not just the success.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers, _ = await _register_and_login(client, "readonly@example.com")
        app = await connect_oauth_app(client, headers, scope="read")

        refused = await client.post(
            "/categories",
            json={"name": "Nope", "kind": "expense"},
            headers=_bearer(app.access_token),
        )
        assert refused.status_code == 403
        assert refused.json()["detail"] == "TOKEN_SCOPE_READONLY"

        rows = (
            await db_session.execute(
                text(
                    "SELECT method, path, status_code FROM pat_audit_log "
                    "WHERE token_id = :grant ORDER BY occurred_at"
                ),
                {"grant": uuid.UUID(app.grant_id)},
            )
        ).all()
        assert ("POST", "/categories", 403) in [tuple(row) for row in rows]

    async def test_revoking_the_app_kills_its_credentials_immediately(
        self, make_client: Any
    ) -> None:
        """Settings → Revoke is the kill switch: no grace, no cached token."""
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers, _ = await _register_and_login(client, "revoke@example.com")
        app = await connect_oauth_app(client, headers, scope="full")
        account = await account_for_currency(client, headers)
        assert account

        revoked = await client.delete(f"/oauth/apps/{app.grant_id}", headers=headers)
        assert revoked.status_code == 204
        assert (
            await client.get("/transactions", headers=_bearer(app.access_token))
        ).status_code == 401
        refused = await _refresh(client, app, app.refresh_token)
        assert refused.status_code == 400
        assert refused.json()["error"] == "invalid_grant"
        # A second DELETE is the same 404 a stranger's id gets.
        again = await client.delete(f"/oauth/apps/{app.grant_id}", headers=headers)
        assert again.status_code == 404
        assert again.json()["detail"] == "OAUTH_APP_NOT_FOUND"


class TestExpiry:
    """The two expiry predicates, with a lifetime of 0 standing in for the clock.

    They are the kind of thing that breaks silently: drop either comparison and
    every test in this file still passes, because nothing else here ever holds a
    credential long enough to notice.
    """

    async def test_an_expired_access_token_is_refused_at_both_front_doors(
        self, make_client: Any
    ) -> None:
        """One resolver guards the data routes and ``/mcp``, so BOTH must say no."""
        client = await make_client(
            public_base_url=PUBLIC_BASE_URL, oauth_access_token_lifetime_seconds=0
        )
        headers, _ = await _register_and_login(client, "stale-access@example.com")
        app = await connect_oauth_app(client, headers, scope="full")

        on_data_route = await client.get(
            "/transactions", headers=_bearer(app.access_token)
        )
        assert on_data_route.status_code == 401
        assert on_data_route.json()["detail"] == "TOKEN_INVALID"

        over_mcp = await client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={
                **_bearer(app.access_token),
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
        )
        assert over_mcp.status_code == 401

    async def test_an_expired_refresh_token_cannot_be_rotated(
        self, make_client: Any
    ) -> None:
        """An expired refresh is ``invalid_grant``, NOT reuse — the grant survives."""
        client = await make_client(
            public_base_url=PUBLIC_BASE_URL, oauth_refresh_token_lifetime_seconds=0
        )
        headers, _ = await _register_and_login(client, "stale-refresh@example.com")
        app = await connect_oauth_app(client, headers)

        refused = await _refresh(client, app, app.refresh_token)
        assert refused.status_code == 400
        assert refused.json()["error"] == "invalid_grant"
        # Not reuse: the refusal happens before the claim, so the grant's own
        # access token keeps working (reuse would have revoked it).
        alive = await client.get("/transactions", headers=_bearer(app.access_token))
        assert alive.status_code == 200, alive.text


class TestDiscovery:
    async def test_the_three_metadata_documents_and_the_exposure_walk(
        self, make_client: Any
    ) -> None:
        """Ruling R3. The bytes Claude discovers us by, and the tripwire they pass.

        Byte equality matters here beyond pedantry: a trailing slash on the issuer
        (which ``AnyHttpUrl`` adds the moment a URL is built outside the metadata
        model) makes Claude read the discovery document as belonging to a different
        server, and the audience check refuse every token.

        Building the app at all is the other half of the assertion: ``create_app``
        derives the PAT allowlist by walking EVERY route, and an OAuth route the
        walk could not read would raise ``TypeError`` here (``mcp/exposure.py``).
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        metadata = await client.get("/.well-known/oauth-authorization-server")
        assert metadata.status_code == 200
        assert metadata.json() == {
            "issuer": "http://localhost",
            "authorization_endpoint": "http://localhost/api/oauth/authorize",
            "token_endpoint": "http://localhost/api/oauth/token",
            "registration_endpoint": "http://localhost/api/oauth/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": [
                "client_secret_basic",
                "client_secret_post",
                "none",
            ],
            "code_challenge_methods_supported": ["S256"],
        }
        expected_resource = {
            "resource": "http://localhost/mcp",
            "authorization_servers": ["http://localhost"],
            "bearer_methods_supported": ["header"],
        }
        for path in (
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-protected-resource",
        ):
            served = await client.get(path)
            assert served.status_code == 200, path
            assert served.json() == expected_resource

    async def test_without_a_public_base_url_the_oauth_endpoints_do_not_exist(
        self, client: AsyncClient
    ) -> None:
        """The feature switch: dev and the rest of the suite serve none of this."""
        for path in (
            "/.well-known/oauth-authorization-server",
            "/.well-known/oauth-protected-resource",
            "/oauth/authorize",
        ):
            assert (await client.get(path)).status_code == 404, path
