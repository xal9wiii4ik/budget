"""GET /fx/convert against a real Postgres — rates seeded as rows, no fetcher.

Covers only what is unique to this endpoint: the four resolution branches
(direct, inverse, nearest-previous, none), the honest ``rate_as_of`` disclosure,
and the no-rate degradation to a 200 with the null triple. Malformed-param 422s
are pure Pydantic and QA-curl-owned per the grooming split.
"""

import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import ExchangeRate

PASSWORD = "password123"

_DAY = date(2026, 8, 10)


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
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return headers, user_id


async def _seed_rate(
    session: AsyncSession, base: str, quote: str, rate: str, as_of: date
) -> None:
    session.add(
        ExchangeRate(
            base=base,
            quote=quote,
            as_of_date=as_of,
            rate=Decimal(rate),
            provider="test",
        )
    )
    await session.commit()


async def _convert(
    client: AsyncClient,
    headers: dict[str, str],
    from_currency: str,
    to: str,
    *,
    amount_minor: int = 1000,
    on_date: date = _DAY,
) -> dict[str, Any]:
    """GET the preview. ``from`` is spelled as a dict key — it is the wire name."""
    resp = await client.get(
        "/fx/convert",
        params={
            "amount_minor": amount_minor,
            "from": from_currency,
            "to": to,
            "date": on_date.isoformat(),
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


class TestConvert:
    async def test_convert_direct_rate(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "fxdirect@x.com")
        await _seed_rate(db_session, "EUR", "USD", "1.10", _DAY)

        body = await _convert(client, headers, "EUR", "USD")

        assert body == {
            "converted_minor": 1100,  # 10.00 EUR x 1.10 = 11.00 USD
            "rate": "1.10000000",
            "rate_as_of": "2026-08-10",
            "from": "EUR",  # [SL-1]: wire name is the literal `from`
            "to": "USD",
            "amount_minor": 1000,
        }

    async def test_convert_inverse_rate(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Only the canonical direction is ever stored (RUB base, day one) — the
        # requested USD->RUB direction is derived by inversion.
        headers, _ = await _register_and_login(client, "fxinverse@x.com")
        await _seed_rate(db_session, "RUB", "USD", "0.0125", _DAY)

        body = await _convert(client, headers, "USD", "RUB")

        # 1 / 0.0125 = 80 exactly: 10.00 USD -> 800.00 RUB.
        assert body["converted_minor"] == 80000
        assert body["rate"] == "80.00000000"
        assert body["rate_as_of"] == "2026-08-10"

    async def test_convert_nearest_previous(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "fxnearest@x.com")
        await _seed_rate(db_session, "EUR", "USD", "1.00", date(2026, 8, 5))
        await _seed_rate(db_session, "EUR", "USD", "2.00", date(2026, 8, 9))

        newer = await _convert(client, headers, "EUR", "USD", on_date=date(2026, 8, 10))
        # Newest row at or before the requested date wins, and its own date — not
        # the requested one — is disclosed.
        assert newer["converted_minor"] == 2000
        assert newer["rate_as_of"] == "2026-08-09"

        older = await _convert(client, headers, "EUR", "USD", on_date=date(2026, 8, 7))
        # A date before the newer row falls back to the 08-05 row (range scan's
        # other arm), never forward to a rate that did not exist yet.
        assert older["converted_minor"] == 1000
        assert older["rate_as_of"] == "2026-08-05"

    async def test_convert_no_rate_degrades(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "fxnorate@x.com")

        body = await _convert(client, headers, "JPY", "BHD")

        # 200 with the null triple — never 404/500 (D7); the echo still answers
        # "what did I ask for".
        assert body == {
            "converted_minor": None,
            "rate": None,
            "rate_as_of": None,
            "from": "JPY",
            "to": "BHD",
            "amount_minor": 1000,
        }

    async def test_convert_identity(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "fxidentity@x.com")

        body = await _convert(client, headers, "RUB", "RUB")

        # No row needed: same-currency short circuit, rate 1 at the asked-for date.
        assert body["converted_minor"] == 1000
        assert body["rate"] == "1.00000000"
        assert body["rate_as_of"] == "2026-08-10"

    async def test_convert_requires_auth(self, client: AsyncClient) -> None:
        resp = await client.get(
            "/fx/convert", params={"amount_minor": 1000, "from": "EUR", "to": "USD"}
        )

        assert resp.status_code == 401
