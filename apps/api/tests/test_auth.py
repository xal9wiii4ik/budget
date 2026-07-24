"""Auth endpoint contracts — real Postgres, real crypto, no mocks.

Covers the custom login/refresh/logout lifecycle, the lean register schema, the
password-reset revocation, and rate limiting. Framework behavior (Pydantic
validation, JWT internals) is not re-tested — only what is unique to these routes.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

PASSWORD = "password123"


async def _register(
    client: AsyncClient, email: str, password: str = PASSWORD
) -> dict[str, Any]:
    response = await client.post(
        "/auth/register", json={"email": email, "password": password}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _login(
    client: AsyncClient, email: str, password: str = PASSWORD
) -> dict[str, Any]:
    response = await client.post(
        "/auth/login", data={"username": email, "password": password}
    )
    assert response.status_code == 200, response.text
    return response.json()


class TestRegister:
    async def test_returns_lean_user(self, client: AsyncClient) -> None:
        body = await _register(client, "lean@x.com")

        assert body["email"] == "lean@x.com"
        assert body["is_active"] is True
        assert "id" in body
        # Privilege fields are structurally absent from the wire (architecture §5).
        assert "is_superuser" not in body
        assert "is_verified" not in body

    async def test_case_insensitive_duplicate_400(self, client: AsyncClient) -> None:
        await _register(client, "foo@x.com")

        response = await client.post(
            "/auth/register", json={"email": "FOO@x.com", "password": PASSWORD}
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "REGISTER_USER_ALREADY_EXISTS"

    async def test_short_password_400(self, client: AsyncClient) -> None:
        response = await client.post(
            "/auth/register", json={"email": "short@x.com", "password": "short"}
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "REGISTER_INVALID_PASSWORD"


class TestLogin:
    async def test_returns_token_pair(self, client: AsyncClient) -> None:
        await _register(client, "login@x.com")

        body = await _login(client, "login@x.com")

        assert body["token_type"] == "bearer"
        assert body["access_token"]
        assert body["refresh_token"]

    async def test_bad_password_400(self, client: AsyncClient) -> None:
        await _register(client, "badpw@x.com")

        response = await client.post(
            "/auth/login", data={"username": "badpw@x.com", "password": "wrongpass1"}
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "LOGIN_BAD_CREDENTIALS"

    async def test_inactive_user_400(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # authenticate() does not check is_active — the route re-check is the SUT.
        await _register(client, "inactive@x.com")
        await db_session.execute(
            text("UPDATE users SET is_active = false WHERE email = :e"),
            {"e": "inactive@x.com"},
        )
        await db_session.commit()

        response = await client.post(
            "/auth/login", data={"username": "inactive@x.com", "password": PASSWORD}
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "LOGIN_BAD_CREDENTIALS"


class TestRefresh:
    async def test_rotates_and_revokes_old(self, client: AsyncClient) -> None:
        await _register(client, "rotate@x.com")
        old = (await _login(client, "rotate@x.com"))["refresh_token"]

        rotated = await client.post("/auth/refresh", json={"refresh_token": old})
        assert rotated.status_code == 200
        new = rotated.json()["refresh_token"]
        assert new != old

        # Reusing the consumed token is rejected — the security-critical contrast.
        reused = await client.post("/auth/refresh", json={"refresh_token": old})
        assert reused.status_code == 401
        assert reused.json()["detail"] == "REFRESH_TOKEN_INVALID"

    async def test_expired_token_401(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        user = await _register(client, "expired@x.com")
        stale_token = "x" * 43
        await db_session.execute(
            text(
                "INSERT INTO refresh_tokens (token, user_id, created_at) "
                "VALUES (:t, :u, :c)"
            ),
            {
                "t": stale_token,
                "u": uuid.UUID(user["id"]),
                "c": datetime.now(UTC) - timedelta(days=40),
            },
        )
        await db_session.commit()

        response = await client.post(
            "/auth/refresh", json={"refresh_token": stale_token}
        )

        assert response.status_code == 401
        assert response.json()["detail"] == "REFRESH_TOKEN_INVALID"

    async def test_unknown_token_401(self, client: AsyncClient) -> None:
        response = await client.post(
            "/auth/refresh", json={"refresh_token": "not-a-real-token"}
        )

        assert response.status_code == 401
        assert response.json()["detail"] == "REFRESH_TOKEN_INVALID"

    async def test_inactive_user_401(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # read_token enforces existence + max age but NOT is_active — the route
        # re-check is the SUT. A deactivated user holding a live, stored refresh
        # token must not be able to mint fresh access JWTs.
        await _register(client, "inactive-refresh@x.com")
        refresh = (await _login(client, "inactive-refresh@x.com"))["refresh_token"]
        await db_session.execute(
            text("UPDATE users SET is_active = false WHERE email = :e"),
            {"e": "inactive-refresh@x.com"},
        )
        await db_session.commit()

        response = await client.post("/auth/refresh", json={"refresh_token": refresh})

        assert response.status_code == 401
        assert response.json()["detail"] == "REFRESH_TOKEN_INVALID"


class TestLogout:
    async def test_revokes_token(self, client: AsyncClient) -> None:
        await _register(client, "logout@x.com")
        refresh = (await _login(client, "logout@x.com"))["refresh_token"]

        logout = await client.post("/auth/logout", json={"refresh_token": refresh})
        assert logout.status_code == 204

        reuse = await client.post("/auth/refresh", json={"refresh_token": refresh})
        assert reuse.status_code == 401

    async def test_unknown_token_204(self, client: AsyncClient) -> None:
        # No 404 oracle — logout of an unknown token is indistinguishable from a real
        # one (a deliberate security decision).
        response = await client.post(
            "/auth/logout", json={"refresh_token": "unknown-token"}
        )

        assert response.status_code == 204


class TestSecurity:
    async def test_refresh_token_rejected_as_bearer(self, client: AsyncClient) -> None:
        # F6 structural guarantee: the opaque refresh token can never authenticate a
        # protected route (JWT-backend-only Authenticator).
        await _register(client, "bearer@x.com")
        refresh = (await _login(client, "bearer@x.com"))["refresh_token"]

        response = await client.get(
            "/users/me", headers={"Authorization": f"Bearer {refresh}"}
        )

        assert response.status_code == 401


class TestForgotPassword:
    async def test_always_202(self, client: AsyncClient) -> None:
        await _register(client, "known@x.com")

        known = await client.post(
            "/auth/forgot-password", json={"email": "known@x.com"}
        )
        unknown = await client.post(
            "/auth/forgot-password", json={"email": "nobody@x.com"}
        )

        # Same 202 for both — no account-existence oracle.
        assert known.status_code == 202
        assert unknown.status_code == 202


class TestResetPassword:
    async def test_reset_revokes_refresh_tokens(
        self, client: AsyncClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        await _register(client, "reset@x.com")
        old_refresh = (await _login(client, "reset@x.com"))["refresh_token"]

        with caplog.at_level(logging.WARNING, logger="budget_api.auth"):
            await client.post("/auth/forgot-password", json={"email": "reset@x.com"})
        reset_token = next(
            record.getMessage().rsplit(": ", 1)[1]
            for record in caplog.records
            if record.getMessage().startswith("password reset token")
        )

        reset = await client.post(
            "/auth/reset-password",
            json={"token": reset_token, "password": "newpassword1"},
        )
        assert reset.status_code == 200

        # The pre-reset refresh token is revoked (R1/AM-E) — a reset logs you out.
        reuse = await client.post("/auth/refresh", json={"refresh_token": old_refresh})
        assert reuse.status_code == 401


class TestRateLimit:
    async def test_login_429(
        self, make_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        limited = await make_client(
            rate_limit_enabled=True, login_rate_limit="2/minute"
        )

        codes = [
            (
                await limited.post(
                    "/auth/login", data={"username": "x@x.com", "password": "nope1234"}
                )
            ).status_code
            for _ in range(3)
        ]

        assert codes[-1] == 429
        response = await limited.post(
            "/auth/login", data={"username": "x@x.com", "password": "nope1234"}
        )
        assert response.json() == {"detail": "RATE_LIMITED"}

    async def test_register_429(
        self, make_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        # Guards the fragile post-decoration of the stock register route (AM-D).
        limited = await make_client(
            rate_limit_enabled=True, register_rate_limit="2/minute"
        )

        codes = [
            (
                await limited.post(
                    "/auth/register",
                    json={"email": f"rl{i}@x.com", "password": PASSWORD},
                )
            ).status_code
            for i in range(3)
        ]

        assert codes[-1] == 429
