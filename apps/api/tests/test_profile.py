"""``GET`` / ``PATCH /profile`` (S1) — the settings row's first HTTP surface.

Four things here can genuinely break: the GET's promise NOT to write (it is the
one read in this router that could quietly turn a page load into an INSERT), the
PATCH's omit/null/value mechanics on the nullable columns, the base-currency arm
(its string codes, and the A1 rule that a real switch CLEARS the declared income
while a no-op switch does not), and the JWT-only dependency (a personal access
token must not reach settings at all).

Not written: that ``language`` rejects 'de' via anything other than the schema
(pure Pydantic), and a second 401 per method — the router has one dependency.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from helpers import account_for_currency
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


class TestBaseCurrency:
    """D1: the base currency became writable — this class REPLACES the test that
    pinned the old read-only behaviour (``test_base_currency_is_not_writable_here``).
    """

    async def test_switch_persists_and_leaves_snapshots_alone(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # The D1 promise: a switch is a DISPLAY change. Nothing recomputes the
        # stored base snapshot of an existing row — aggregates already read a
        # post-switch row correctly (services/tx_totals bucket order), and a
        # future "helpful" recompute would rewrite history the user never edited.
        headers, _ = await _register_and_login(client, "prof-switch@x.com")
        # A USD row under the RUB base, with the base amount sent as an override
        # so the snapshot exists without seeding a rate.
        account = await account_for_currency(client, headers, "USD")
        created = await client.post(
            "/transactions",
            json={
                "amount_minor": 10_000,
                "kind": "expense",
                "account_id": account,
                "base_amount_minor": 800_000,
                "occurred_at": datetime.now(UTC).date().isoformat(),
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text
        before = created.json()
        assert (before["base_amount_minor"], before["base_currency"]) == (
            800_000,
            "RUB",
        )

        switched = await client.patch(
            "/profile", json={"base_currency": "USD"}, headers=headers
        )

        assert switched.status_code == 200, switched.text
        assert switched.json()["base_currency"] == "USD"
        assert (await client.get("/profile", headers=headers)).json()[
            "base_currency"
        ] == "USD"
        # Byte-identical IN THE LEDGER: the switch redefines what the screen
        # shows, never what was stored (there is no single-row GET to read it
        # back through, and the stored bytes are the actual promise).
        stored = (
            await db_session.execute(
                text(
                    "SELECT base_amount_minor, base_currency FROM transactions "
                    "WHERE id = :id"
                ),
                {"id": uuid.UUID(before["id"])},
            )
        ).one()
        assert stored == (800_000, "RUB")

    @pytest.mark.parametrize(
        ("body", "detail"),
        [
            # Well-formed, real, and unsupported: no rate infrastructure reaches
            # it, so the whole screen would render as unconverted.
            ({"base_currency": "JPY"}, "CURRENCY_NOT_SUPPORTED"),
            # NOT NULL column: the explicit null is a 422, not a clear (the
            # GoalUpdate *_REQUIRED precedent).
            ({"base_currency": None}, "BASE_CURRENCY_REQUIRED"),
        ],
    )
    async def test_rejected_base_currency_codes(
        self, client: AsyncClient, body: dict[str, Any], detail: str
    ) -> None:
        headers, _ = await _register_and_login(client, "prof-badcur@x.com")

        resp = await client.patch("/profile", json=body, headers=headers)

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": detail}
        assert (await client.get("/profile", headers=headers)).json()[
            "base_currency"
        ] == "RUB"

    async def test_lowercase_is_refused_not_normalized(
        self, client: AsyncClient
    ) -> None:
        # The COUNTRY_PATTERN house rule reaches the base currency too: 'usd' is
        # rejected (on the schema pattern, so the body is the Pydantic array),
        # never silently upper-cased into a successful switch.
        headers, _ = await _register_and_login(client, "prof-lowcur@x.com")

        resp = await client.patch(
            "/profile", json={"base_currency": "usd"}, headers=headers
        )

        assert resp.status_code == 422, resp.text
        assert (await client.get("/profile", headers=headers)).json()[
            "base_currency"
        ] == "RUB"


class TestDeclaredIncome:
    async def test_set_cleared_and_bounded(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "prof-income@x.com")

        set_ = await client.patch(
            "/profile", json={"monthly_income_minor": 25_000_000}, headers=headers
        )
        assert set_.status_code == 200, set_.text
        assert set_.json()["monthly_income_minor"] == 25_000_000

        cleared = await client.patch(
            "/profile", json={"monthly_income_minor": None}, headers=headers
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["monthly_income_minor"] is None  # explicit null CLEARS

        # ge=0 mirrors the monthly_income_minor_non_negative CHECK: without it on
        # the schema this would reach Postgres and surface as an IntegrityError 500.
        negative = await client.patch(
            "/profile", json={"monthly_income_minor": -1}, headers=headers
        )
        assert negative.status_code == 422, negative.text

    async def test_base_switch_clears_the_declared_income(
        self, client: AsyncClient
    ) -> None:
        # A1: the stored number carries no currency — it is read in whatever base
        # is stored. Keeping 250000 across RUB→USD would silently redefine it as
        # $2500, a ~30x-wrong "declared" basis; an honest empty state wins.
        headers, _ = await _register_and_login(client, "prof-clear@x.com")
        seeded = await client.patch(
            "/profile", json={"monthly_income_minor": 25_000_000}, headers=headers
        )
        assert seeded.status_code == 200, seeded.text

        switched = await client.patch(
            "/profile", json={"base_currency": "USD"}, headers=headers
        )

        assert switched.status_code == 200, switched.text
        # The PATCH response is the whole profile — the web seeds its cache from
        # exactly this body, so the clear must be visible here, not only on a
        # follow-up GET.
        assert switched.json()["monthly_income_minor"] is None
        assert (await client.get("/profile", headers=headers)).json()[
            "monthly_income_minor"
        ] is None

    async def test_income_sent_with_the_switch_wins(self, client: AsyncClient) -> None:
        # A1, arm ORDER: re-declaring the income in the new currency in the SAME
        # request must survive the switch's clear. Running the income arm first
        # would wipe the number the user just typed.
        headers, _ = await _register_and_login(client, "prof-both@x.com")
        seeded = await client.patch(
            "/profile", json={"monthly_income_minor": 25_000_000}, headers=headers
        )
        assert seeded.status_code == 200, seeded.text

        both = await client.patch(
            "/profile",
            json={"base_currency": "USD", "monthly_income_minor": 300_000},
            headers=headers,
        )

        assert both.status_code == 200, both.text
        assert both.json()["base_currency"] == "USD"
        assert both.json()["monthly_income_minor"] == 300_000

    async def test_same_value_switch_keeps_the_income(
        self, client: AsyncClient
    ) -> None:
        # The no-op edge: a PATCH that re-sends the CURRENT base is not a switch
        # (the web may send the whole settings form), so it must not wipe income.
        headers, _ = await _register_and_login(client, "prof-noop@x.com")
        seeded = await client.patch(
            "/profile", json={"monthly_income_minor": 25_000_000}, headers=headers
        )
        assert seeded.status_code == 200, seeded.text

        resent = await client.patch(
            "/profile", json={"base_currency": "RUB"}, headers=headers
        )

        assert resent.status_code == 200, resent.text
        assert resent.json()["monthly_income_minor"] == 25_000_000


class TestAuth:
    async def test_reading_takes_any_token_but_writing_takes_a_browser_session(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        """Split by METHOD since 2026-08-23 (user decision, architecture §4).

        A PAT reads the settings because the base currency is the unit every
        server-computed total is in — an AI client may not quote a number without
        it. Writing them stays a browser concern: changing the base currency is
        cascading, so even a ``full`` token is refused at the JWT decode.
        """
        headers, _ = await _register_and_login(client, "prof-auth@x.com")
        token = (await pat_factory(client, headers, "full"))["token"]
        pat_headers = {"Authorization": f"Bearer {token}"}

        assert (await client.get("/profile")).status_code == 401
        assert (await client.get("/profile", headers=pat_headers)).status_code == 200
        assert (
            await client.patch("/profile", json={"language": "en"}, headers=pat_headers)
        ).status_code == 401
