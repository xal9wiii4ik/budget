"""``GET`` / ``PATCH /profile`` (S1) — the settings row's first HTTP surface.

Three things here can genuinely break: the GET's promise NOT to write (it is the
one read in this router that could quietly turn a page load into an INSERT), the
PATCH's omit/null/value mechanics on two nullable columns, and the JWT-only
dependency (a personal access token must not reach settings at all).

Not written: that ``language`` rejects 'de' via anything other than the schema
(pure Pydantic), and a second 401 per method — the router has one dependency.
"""

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

PASSWORD = "password123"


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


class TestReadProfile:
    async def test_missing_row_reads_as_defaults_and_stays_missing(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """A pre-1.2 user has no ``profiles`` row; a GET must not create one."""
        headers, user_id = await _register_and_login(client, "prof-get@x.com")
        await db_session.execute(
            text("DELETE FROM profiles WHERE user_id = :id"), {"id": user_id}
        )
        await db_session.commit()

        resp = await client.get("/profile", headers=headers)

        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "base_currency": "RUB",
            "monthly_income_minor": None,
            "country": None,
            "language": None,
        }
        rows = await db_session.scalar(
            text("SELECT count(*) FROM profiles WHERE user_id = :id"), {"id": user_id}
        )
        assert rows == 0

    async def test_new_users_start_with_no_country_and_no_language(
        self, client: AsyncClient
    ) -> None:
        # NULL is the marker the first-run locale prompt keys off. A default 'ru'
        # would be indistinguishable from a user who deliberately chose Russian.
        headers, _ = await _register_and_login(client, "prof-fresh@x.com")

        resp = await client.get("/profile", headers=headers)

        assert resp.status_code == 200, resp.text
        assert resp.json()["country"] is None
        assert resp.json()["language"] is None


class TestUpdateProfile:
    async def test_set_omit_and_clear(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "prof-patch@x.com")
        await db_session.execute(
            text("DELETE FROM profiles WHERE user_id = :id"), {"id": user_id}
        )
        await db_session.commit()

        # Self-heals the missing row on the way (the write half of the policy).
        created = await client.patch(
            "/profile", json={"country": "BY", "language": "ru"}, headers=headers
        )
        assert created.status_code == 200, created.text
        assert created.json()["country"] == "BY"
        assert created.json()["language"] == "ru"
        assert created.json()["base_currency"] == "RUB"

        # Omitted keys are untouched — a language switch must not wipe the country.
        partial = await client.patch(
            "/profile", json={"language": "en"}, headers=headers
        )
        assert partial.status_code == 200, partial.text
        assert partial.json() == {
            "base_currency": "RUB",
            "monthly_income_minor": None,
            "country": "BY",
            "language": "en",
        }

        cleared = await client.patch(
            "/profile", json={"country": None, "language": None}, headers=headers
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["country"] is None
        assert cleared.json()["language"] is None
        assert (await client.get("/profile", headers=headers)).json()["country"] is None

    @pytest.mark.parametrize(
        "body",
        [
            {"language": "de"},  # well-formed but not a shipped UI language
            {"country": "by"},  # lowercase is refused, NOT normalized
            {"country": "BYN"},
            {"country": ""},
        ],
    )
    async def test_unsupported_values_are_422_not_500(
        self, client: AsyncClient, body: dict[str, Any]
    ) -> None:
        # Both columns carry a DB CHECK spelling the same rule, so anything the
        # schema lets through would surface as an IntegrityError 500.
        headers, _ = await _register_and_login(client, "prof-bad@x.com")

        resp = await client.patch("/profile", json=body, headers=headers)

        assert resp.status_code == 422, resp.text

    async def test_base_currency_is_not_writable_here(
        self, client: AsyncClient
    ) -> None:
        # Changing it retroactively redefines every stored base-currency snapshot,
        # so it is absent from the update schema and a sent value is ignored
        # (the house extra="ignore" default), never applied.
        headers, _ = await _register_and_login(client, "prof-basecur@x.com")

        resp = await client.patch(
            "/profile", json={"base_currency": "USD", "language": "en"}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["base_currency"] == "RUB"


class TestAuth:
    async def test_requires_a_browser_session(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        """Settings are JWT-only: a PAT authenticates nothing here (§tokens.py)."""
        headers, _ = await _register_and_login(client, "prof-auth@x.com")
        token = (await pat_factory(client, headers, "full"))["token"]
        pat_headers = {"Authorization": f"Bearer {token}"}

        assert (await client.get("/profile")).status_code == 401
        assert (await client.get("/profile", headers=pat_headers)).status_code == 401
        assert (
            await client.patch("/profile", json={"language": "en"}, headers=pat_headers)
        ).status_code == 401
