"""/tokens — issue, list, revoke, and the anti-escalation wall (5.6 S1).

Real Postgres, no mocks. Covers only what is unique to this router: the one-time
plaintext (which must also actually authenticate), the fact that a token can
neither mint nor revoke tokens, the ONE self-introspection exception, and the
single-code-path 404 on revoke. Gate behaviour (allowlist / scope / rate limit /
audit) lives in ``test_pat_auth.py``; the ``name``/``scope`` field validation is
pure Pydantic and is not re-tested here.
"""

import uuid
from typing import Any

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

PASSWORD = "password123"


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


def _pat_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class TestIssue:
    async def test_plaintext_is_returned_once_authenticates_and_is_never_listed(
        self, client: AsyncClient, db_session: AsyncSession, pat_factory: Any
    ) -> None:
        headers = await _register_and_login(client, "tok-issue@example.com")
        created = await pat_factory(client, headers, "read", "MacBook Claude")

        works = await client.get(
            "/transactions", headers=_pat_headers(created["token"])
        )
        listed = await client.get("/tokens", headers=headers)
        stored = await db_session.scalar(
            text("SELECT token_hash FROM personal_access_tokens WHERE id = :id"),
            {"id": uuid.UUID(created["id"])},
        )

        assert created["token"].startswith("bgt_pat_")
        assert works.status_code == 200, works.text
        assert listed.status_code == 200, listed.text
        items = listed.json()["items"]
        assert [item["id"] for item in items] == [created["id"]]
        # The one-time secret never comes back — not as `token`, not as the digest.
        assert "token" not in items[0]
        assert "token_hash" not in items[0]
        assert stored != created["token"]
        assert items[0]["name"] == "MacBook Claude"
        assert items[0]["scope"] == "read"


class TestAntiEscalation:
    async def test_a_token_can_neither_mint_nor_revoke_tokens_but_knows_itself(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        """The management routes are JWT-only; ``/self`` is the single exception."""
        headers = await _register_and_login(client, "tok-escalate@example.com")
        pat = await pat_factory(client, headers, "full")
        pat_headers = _pat_headers(pat["token"])

        minted = await client.post(
            "/tokens", json={"name": "second", "scope": "full"}, headers=pat_headers
        )
        revoked = await client.delete(f"/tokens/{pat['id']}", headers=pat_headers)
        listed = await client.get("/tokens", headers=pat_headers)
        introspected = await client.get("/tokens/self", headers=pat_headers)

        assert minted.status_code == 401
        assert revoked.status_code == 401
        assert listed.status_code == 401
        assert introspected.status_code == 200, introspected.text
        assert introspected.json() == {"id": pat["id"], "scope": "full"}

    async def test_a_browser_session_has_no_token_to_introspect(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "tok-self-jwt@example.com")

        resp = await client.get("/tokens/self", headers=headers)

        assert resp.status_code == 404
        assert resp.json() == {"detail": "TOKEN_NOT_FOUND"}


class TestRevoke:
    async def test_own_token_is_revoked_once_and_stops_authenticating(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        headers = await _register_and_login(client, "tok-revoke@example.com")
        pat = await pat_factory(client, headers)

        first = await client.delete(f"/tokens/{pat['id']}", headers=headers)
        after = await client.get("/transactions", headers=_pat_headers(pat["token"]))
        repeat = await client.delete(f"/tokens/{pat['id']}", headers=headers)
        listed = await client.get("/tokens", headers=headers)

        assert first.status_code == 204
        assert after.status_code == 401
        assert after.json() == {"detail": "TOKEN_INVALID"}
        # Soft revoke: the row stays listed, carrying the revocation as a fact.
        assert listed.json()["items"][0]["revoked_at"] is not None
        assert repeat.status_code == 404

    async def test_foreign_and_missing_ids_share_one_404(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        mine = await _register_and_login(client, "tok-mine@example.com")
        theirs = await _register_and_login(client, "tok-theirs@example.com")
        stranger_pat = await pat_factory(client, theirs)

        foreign = await client.delete(f"/tokens/{stranger_pat['id']}", headers=mine)
        missing = await client.delete(f"/tokens/{uuid.uuid4()}", headers=mine)

        assert foreign.status_code == 404
        assert foreign.text == missing.text == '{"detail":"TOKEN_NOT_FOUND"}'
        assert missing.status_code == 404
        # And the stranger's token is untouched by the attempt.
        still_listed = await client.get("/tokens", headers=theirs)
        assert still_listed.json()["items"][0]["revoked_at"] is None
