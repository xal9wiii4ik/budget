"""Users router contracts — /users/me GET + PATCH (password change revocation)."""

from typing import Any

from httpx import AsyncClient

PASSWORD = "password123"


async def _register_and_login(client: AsyncClient, email: str) -> dict[str, Any]:
    register = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert register.status_code == 201, register.text
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return login.json()


class TestUsersMe:
    async def test_returns_lean_user(self, client: AsyncClient) -> None:
        tokens = await _register_and_login(client, "me@x.com")

        response = await client.get(
            "/users/me",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["email"] == "me@x.com"
        assert "is_superuser" not in body
        assert "is_verified" not in body

    async def test_unauthenticated_401(self, client: AsyncClient) -> None:
        response = await client.get("/users/me")

        assert response.status_code == 401

    async def test_patch_me_password_change(self, client: AsyncClient) -> None:
        tokens = await _register_and_login(client, "change@x.com")
        access = tokens["access_token"]
        old_refresh = tokens["refresh_token"]

        patched = await client.patch(
            "/users/me",
            json={"password": "brandnew123"},
            headers={"Authorization": f"Bearer {access}"},
        )
        assert patched.status_code == 200
        body = patched.json()
        assert body["email"] == "change@x.com"
        assert "is_superuser" not in body

        # New password logs in.
        relogin = await client.post(
            "/auth/login",
            data={"username": "change@x.com", "password": "brandnew123"},
        )
        assert relogin.status_code == 200

        # Pre-change refresh token is revoked (R1/AM-E) — changing the password
        # logs out everywhere.
        reuse = await client.post("/auth/refresh", json={"refresh_token": old_refresh})
        assert reuse.status_code == 401

    async def test_patch_me_null_fields_ignored(self, client: AsyncClient) -> None:
        # Finding 1/2: an explicit JSON null is "field not updated" (exclude_none) —
        # it must not reach the DB as NULL (was a 500) and must not fire the
        # password-change revocation.
        tokens = await _register_and_login(client, "nullpatch@x.com")
        access = tokens["access_token"]
        old_refresh = tokens["refresh_token"]

        patched = await client.patch(
            "/users/me",
            json={"email": None, "password": None},
            headers={"Authorization": f"Bearer {access}"},
        )
        assert patched.status_code == 200
        assert patched.json()["email"] == "nullpatch@x.com"

        # No revocation fired: a refresh token from before the PATCH still works.
        refreshed = await client.post(
            "/auth/refresh", json={"refresh_token": old_refresh}
        )
        assert refreshed.status_code == 200
