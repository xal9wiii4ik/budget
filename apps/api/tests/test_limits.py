"""/limits — set / clear / list with month spend (plan B3, AM-10/AM-11), real Postgres.

Covers only what is unique to this router: the upsert (one row per
``(user, category)``, re-stamped on rewrite), the currency stamp that a base
switch must NOT re-interpret (D15/OQ-4), the category-eligibility codes with
their accept contrasts, and the read's fold — expense bucket only, limits
without spending listed, spending without a limit absent, and a period-level
``unconverted_count``.

The three-bucket conversion itself is NOT re-pinned here
(``test_transactions.py::TestSummaryConverted`` and ``test_stats.py`` own it):
these tests use base-currency rows for the ordinary fold, one snapshotted
foreign row for "included", and one rateless foreign row for "excluded".

Fixture months are fixed (``2026-02``) except in the default-month arm, which
must read the real clock — the two are kept in separate categories so the suite
is correct whatever today happens to be.
"""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.periods import month_key
from budget_api.models import Category, ExchangeRate, Profile
from budget_api.schemas.transaction import MAX_MINOR_AMOUNT

PASSWORD = "password123"
# Seed system category (migration 0003): Продукты, expense — the shared row a
# fresh user budgets against before creating any category of their own (AM-11).
PRODUKTY_ID = "ce814749-2554-40be-8952-3a63d505694f"
MONTH = "2026-02"


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


async def _create_category(
    client: AsyncClient, headers: dict[str, str], name: str, kind: str = "expense"
) -> str:
    resp = await client.post(
        "/categories", json={"name": name, "kind": kind}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", f"{MONTH}-15")
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _put_limit(
    client: AsyncClient, headers: dict[str, str], category_id: str, amount_minor: int
) -> Any:
    return await client.put(
        f"/limits/{category_id}",
        json={"amount_minor": amount_minor},
        headers=headers,
    )


async def _set_limit(
    client: AsyncClient, headers: dict[str, str], category_id: str, amount_minor: int
) -> None:
    """A PUT that must succeed — fixture setup, not the property under test."""
    resp = await _put_limit(client, headers, category_id, amount_minor)
    assert resp.status_code == 200, resp.text


async def _get_limits(
    client: AsyncClient, headers: dict[str, str], **params: Any
) -> dict[str, Any]:
    resp = await client.get("/limits", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _by_category(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["category_id"]: item for item in body["items"]}


async def _set_base_currency(
    session: AsyncSession, user_id: uuid.UUID, currency: str
) -> None:
    """Switch the profile base directly — there is no endpoint for it (QA Q-2)."""
    profile = await session.get(Profile, user_id)
    if profile is None:
        session.add(Profile(user_id=user_id, base_currency=currency))
    else:
        profile.base_currency = currency
    await session.commit()


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


class TestSetLimit:
    async def test_put_creates_then_replaces(self, client: AsyncClient) -> None:
        """B3-1: the second PUT REPLACES — one row, not a second one."""
        headers, _ = await _register_and_login(client, "limitput@x.com")
        category = await _create_category(client, headers, "Groceries")

        created = await _put_limit(client, headers, category, 30_000)
        replaced = await _put_limit(client, headers, category, 45_000)

        assert created.status_code == 200, created.text
        assert created.json() == {
            "category_id": category,
            "limit_minor": 30_000,
            "limit_currency": "RUB",
        }
        assert replaced.status_code == 200, replaced.text
        body = await _get_limits(client, headers)
        # Exactly ONE item carrying the new amount: the composite PK is the
        # ON CONFLICT target, so an upsert bug shows up as two rows here.
        assert body["items"] == [
            {
                "category_id": category,
                "limit_minor": 45_000,
                "limit_currency": "RUB",
                "spent_minor": 0,
            }
        ]

    async def test_base_switch_surfaces_mismatch_and_rewrite_restamps(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """B3-2 (D15/OQ-4): a base switch is SURFACED, never applied to the limit."""
        headers, user_id = await _register_and_login(client, "limitbase@x.com")
        category = await _create_category(client, headers, "Groceries")
        await _set_base_currency(db_session, user_id, "RUB")

        stamped = await _put_limit(client, headers, category, 30_000)
        assert stamped.json()["limit_currency"] == "RUB"

        await _set_base_currency(db_session, user_id, "USD")
        after_switch = await _get_limits(client, headers)

        # The read reports both halves and reinterprets neither: 30 000 RUB does
        # not silently become 30 000 USD, and it is not converted either.
        assert after_switch["currency"] == "USD"
        assert after_switch["items"][0]["limit_currency"] == "RUB"
        assert after_switch["items"][0]["limit_minor"] == 30_000

        # Only a rewrite re-stamps — the user restating the threshold today.
        rewritten = await _put_limit(client, headers, category, 30_000)
        assert rewritten.json()["limit_currency"] == "USD"
        assert (await _get_limits(client, headers))["items"][0][
            "limit_currency"
        ] == "USD"

    async def test_put_category_rules(self, client: AsyncClient) -> None:
        """B3-3 + OQ-7: the four rejections, each against the accept contrast."""
        headers, _ = await _register_and_login(client, "limitcat@x.com")
        other, _ = await _register_and_login(client, "limitcatother@x.com")
        own = await _create_category(client, headers, "Groceries")
        foreign = await _create_category(client, other, "TheirGroceries")
        archived = await _create_category(client, headers, "Old")
        patched = await client.patch(
            f"/categories/{archived}", json={"archived": True}, headers=headers
        )
        assert patched.status_code == 200, patched.text
        income = await _create_category(client, headers, "Salary", kind="income")

        missing_resp = await _put_limit(client, headers, str(uuid.uuid4()), 1_000)
        foreign_resp = await _put_limit(client, headers, foreign, 1_000)
        archived_resp = await _put_limit(client, headers, archived, 1_000)
        income_resp = await _put_limit(client, headers, income, 1_000)
        own_resp = await _put_limit(client, headers, own, 1_000)

        assert missing_resp.status_code == 404
        assert missing_resp.json() == {"detail": "CATEGORY_NOT_FOUND"}
        # No-oracle: a foreign category is indistinguishable from a missing one.
        assert foreign_resp.status_code == 404
        assert foreign_resp.content == missing_resp.content
        assert archived_resp.status_code == 422
        assert archived_resp.json() == {"detail": "CATEGORY_ARCHIVED"}
        # OQ-7: a budget caps spending; an income category has none.
        assert income_resp.status_code == 422
        assert income_resp.json() == {"detail": "CATEGORY_NOT_EXPENSE"}
        assert own_resp.status_code == 200, own_resp.text

    async def test_put_amount_bounds(self, client: AsyncClient) -> None:
        """B3-4: both ends rejected, and the boundary value itself accepted."""
        headers, _ = await _register_and_login(client, "limitbounds@x.com")
        category = await _create_category(client, headers, "Groceries")

        zero = await _put_limit(client, headers, category, 0)
        over = await _put_limit(client, headers, category, MAX_MINOR_AMOUNT + 1)
        at_max = await _put_limit(client, headers, category, MAX_MINOR_AMOUNT)

        assert zero.status_code == 422
        assert over.status_code == 422
        # Without this arm both rejections would also pass against a bound of 1.
        assert at_max.status_code == 200, at_max.text
        assert at_max.json()["limit_minor"] == MAX_MINOR_AMOUNT

    async def test_limit_on_system_category_is_accepted_and_folds(
        self, client: AsyncClient
    ) -> None:
        """AM-11(b): the fresh-user normal case — a SHARED (user_id IS NULL) row.

        A per-user limit on a shared category is only representable because the
        limit lives in its own table with a composite PK (D14); a naive column on
        ``categories`` would have had nowhere to put this row.
        """
        headers, _ = await _register_and_login(client, "limitsystem@x.com")

        put = await _put_limit(client, headers, PRODUKTY_ID, 50_000)
        await _create_tx(client, headers, amount_minor=12_345, category_id=PRODUKTY_ID)

        assert put.status_code == 200, put.text
        body = await _get_limits(client, headers, month=MONTH)
        assert body["items"] == [
            {
                "category_id": PRODUKTY_ID,
                "limit_minor": 50_000,
                "limit_currency": "RUB",
                "spent_minor": 12_345,
            }
        ]


class TestDeleteLimit:
    async def test_delete_removes_and_is_no_oracle(self, client: AsyncClient) -> None:
        """B3-5: gone from the list; the repeat and the foreign id are identical."""
        headers, _ = await _register_and_login(client, "limitdel@x.com")
        other, _ = await _register_and_login(client, "limitdelother@x.com")
        own = await _create_category(client, headers, "Groceries")
        theirs = await _create_category(client, other, "TheirGroceries")
        await _set_limit(client, headers, own, 30_000)
        await _set_limit(client, other, theirs, 40_000)

        removed = await client.delete(f"/limits/{own}", headers=headers)
        again = await client.delete(f"/limits/{own}", headers=headers)
        foreign = await client.delete(f"/limits/{theirs}", headers=headers)

        assert removed.status_code == 204
        assert (await _get_limits(client, headers))["items"] == []
        assert again.status_code == 404
        assert again.json() == {"detail": "LIMIT_NOT_FOUND"}
        assert foreign.status_code == 404
        assert foreign.content == again.content
        # ...and the foreign limit is still there — the 404 was a refusal, not a
        # successful cross-user delete reported as missing.
        assert len((await _get_limits(client, other))["items"]) == 1


class TestListLimits:
    async def test_get_folds_spent_from_expense_rows_only(
        self, client: AsyncClient
    ) -> None:
        """B3-6: every arm is a different way the fold could lie."""
        headers, _ = await _register_and_login(client, "limitfold@x.com")
        summed = await _create_category(client, headers, "Groceries")
        other_bucket = await _create_category(client, headers, "Transport")
        untouched = await _create_category(client, headers, "Books")
        unlimited = await _create_category(client, headers, "Cafe")
        archived = await _create_category(client, headers, "Old")
        for category in (summed, other_bucket, untouched, archived):
            await _set_limit(client, headers, category, 90_000)

        await _create_tx(client, headers, amount_minor=60_000, category_id=summed)
        await _create_tx(client, headers, amount_minor=40_000, category_id=summed)
        await _create_tx(
            client, headers, amount_minor=500_000, kind="income", category_id=summed
        )
        await _create_tx(client, headers, amount_minor=25_000, category_id=other_bucket)
        await _create_tx(client, headers, amount_minor=77_777, category_id=unlimited)
        await _create_tx(client, headers, amount_minor=5_000, category_id=archived)
        # Archived only now: the write path refuses an archived category, so the
        # row that proves an archived limit still folds has to precede it.
        assert (
            await client.patch(
                f"/categories/{archived}", json={"archived": True}, headers=headers
            )
        ).status_code == 200

        body = await _get_limits(client, headers, month=MONTH)

        items = _by_category(body)
        # A category with spending but NO limit is absent: this endpoint lists
        # budgets, not spending.
        assert set(items) == {summed, other_bucket, untouched, archived}
        # Two expense rows summed; the income row in the SAME category does not
        # offset them (D16).
        assert items[summed]["spent_minor"] == 100_000
        assert items[other_bucket]["spent_minor"] == 25_000
        # A limit with no rows is still listed, at zero.
        assert items[untouched]["spent_minor"] == 0
        # Archiving the category after setting the limit does not hide the limit.
        assert items[archived]["spent_minor"] == 5_000
        assert body["unconverted_count"] == 0

    async def test_get_excludes_and_flags_unconverted_rows(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """B3-7 + AM-10: the flag is PERIOD-level, not per item.

        The rateless row deliberately sits in a category with NO limit, so it can
        only surface through ``unconverted_count`` — a per-item implementation
        would report zero here and quietly claim the month is fully converted.
        """
        headers, _ = await _register_and_login(client, "limitfx@x.com")
        limited = await _create_category(client, headers, "Groceries")
        unlimited = await _create_category(client, headers, "Cafe")
        await _seed_rate(db_session, "USD", "RUB", "100", date(2026, 2, 1))
        await _set_limit(client, headers, limited, 500_000)

        await _create_tx(
            client,
            headers,
            amount_minor=1_000,  # $10.00 at 100 RUB/USD -> 1 000.00 RUB
            currency="USD",
            category_id=limited,
            occurred_at=f"{MONTH}-10",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=5_000,
            currency="JPY",  # no rate at all -> excluded and flagged
            category_id=unlimited,
            occurred_at=f"{MONTH}-11",
        )

        body = await _get_limits(client, headers, month=MONTH)

        # The snapshotted foreign row IS included (its base amount was stamped at
        # write time) — the flag is not "any foreign row". The read-time rate fold
        # is not exercised here; test_transactions.py/test_stats.py own that.
        assert _by_category(body)[limited]["spent_minor"] == 100_000
        assert body["unconverted_count"] == 1

    async def test_get_month_window_and_default(self, client: AsyncClient) -> None:
        """B3-8: the requested window, the defaulted one, and a malformed anchor.

        The two windows use separate categories on purpose: the default arm reads
        the real clock, so a shared category would make the assertions depend on
        which month the suite happens to run in.
        """
        headers, _ = await _register_and_login(client, "limitmonth@x.com")
        windowed = await _create_category(client, headers, "Groceries")
        current = await _create_category(client, headers, "Transport")
        for category in (windowed, current):
            await _set_limit(client, headers, category, 90_000)
        await _create_tx(
            client,
            headers,
            amount_minor=111,
            category_id=windowed,
            occurred_at="2026-02-15",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=222,
            category_id=windowed,
            occurred_at="2026-03-01",
        )
        today = datetime.now(UTC).date()
        await _create_tx(
            client,
            headers,
            amount_minor=333,
            category_id=current,
            occurred_at=today.isoformat(),
        )

        requested = await _get_limits(client, headers, month=MONTH)
        defaulted = await _get_limits(client, headers)
        malformed = await client.get(
            "/limits", params={"month": "2026-13"}, headers=headers
        )

        assert requested["month"] == MONTH
        # The March row is outside the requested window.
        assert _by_category(requested)[windowed]["spent_minor"] == 111
        assert defaulted["month"] == month_key(today)
        assert _by_category(defaulted)[current]["spent_minor"] == 333
        assert malformed.status_code == 422

    async def test_items_are_ordered_by_category_id(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """AM-11(a): ordered by ``str(category_id)``, not by insertion.

        The ids are fixed so the two orders genuinely disagree — the limit rows
        are written high-id first, and the table carries no timestamp the router
        could accidentally be ordering by.
        """
        headers, user_id = await _register_and_login(client, "limitorder@x.com")
        low = "00000000-0000-4000-8000-000000000001"
        high = "ffffffff-0000-4000-8000-000000000001"
        db_session.add_all(
            [
                Category(
                    id=uuid.UUID(high), user_id=user_id, name="Zeta", kind="expense"
                ),
                Category(
                    id=uuid.UUID(low), user_id=user_id, name="Alpha", kind="expense"
                ),
            ]
        )
        await db_session.commit()

        await _set_limit(client, headers, high, 10_000)
        await _set_limit(client, headers, low, 20_000)

        body = await _get_limits(client, headers, month=MONTH)

        assert [item["category_id"] for item in body["items"]] == [low, high]

    async def test_limits_are_user_scoped_and_require_auth(
        self, client: AsyncClient
    ) -> None:
        """B3-9: two distinct scoping mistakes are possible — the rows and the fold.

        Both users budget the SAME shared system category and both spend in it,
        which is the only fixture in which an unscoped aggregate is observable:
        with private categories the ids could never collide.
        """
        headers, _ = await _register_and_login(client, "limitscope@x.com")
        other, _ = await _register_and_login(client, "limitscopeother@x.com")
        theirs = await _create_category(client, other, "TheirCat")
        await _set_limit(client, headers, PRODUKTY_ID, 90_000)
        await _set_limit(client, other, PRODUKTY_ID, 10_000)
        await _set_limit(client, other, theirs, 10_000)
        await _create_tx(client, headers, amount_minor=1_000, category_id=PRODUKTY_ID)
        await _create_tx(client, other, amount_minor=5_000, category_id=PRODUKTY_ID)

        body = await _get_limits(client, headers, month=MONTH)
        # One unauthenticated call per method: the wall must answer before any
        # routing/validation of the path id, so a never-created uuid is enough.
        unknown = uuid.uuid4()
        unauthenticated = await client.get("/limits")
        unauthenticated_put = await client.put(
            f"/limits/{unknown}", json={"amount_minor": 1}
        )
        unauthenticated_delete = await client.delete(f"/limits/{unknown}")

        # The other user's limit row is absent...
        assert [item["category_id"] for item in body["items"]] == [PRODUKTY_ID]
        # ...and their spending in the shared category is not in my total.
        assert body["items"][0]["spent_minor"] == 1_000
        assert body["items"][0]["limit_minor"] == 90_000
        assert unauthenticated.status_code == 401
        assert unauthenticated_put.status_code == 401, unauthenticated_put.text
        assert unauthenticated_delete.status_code == 401, unauthenticated_delete.text
