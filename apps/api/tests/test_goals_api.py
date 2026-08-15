"""Goals API (plan S5 tests 1-16 + AM-4) — real Postgres, real migrations.

Covers only what is unique to this router: CRUD mechanics with the atomic
initial-saved contribution, priority defaulting/ordering, the no-oracle 404s
(goal wall + the fresh wrong-own-goal contribution path), the computed
realism/waterfall math assembled from the S4-proven domain functions, the
two-level [SL-3] degradation, the contribution SUM >= 0 invariant boundaries,
and the progress series. Pure-Pydantic rejections (pattern/bounds 422s) and the
401 wall are QA-curl-owned per the grooming split (TC-S5-1/2).

Every money assertion is hand-pinned with the computation in a comment. Dates
are derived from the real "today" (the router reads the clock for the
free-balance window and the latest-rate lookup), so fixtures compute month
boundaries relative to it rather than using fixed dates.

Rates are seeded as ``exchange_rates`` rows (no fetcher, scheduler off). Only
the canonical RUB→USD direction is ever stored, so USD numbers ride the
inversion path exactly as production does: stored 0.0125 ⇒ 80 RUB per USD.
"""

import calendar
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import ExchangeRate, GoalContribution

PASSWORD = "password123"

_TODAY = datetime.now(UTC).date()


def _month_first(d: date, shift: int = 0) -> date:
    """First of ``d``'s month shifted by ``shift`` calendar months."""
    total = d.year * 12 + (d.month - 1) + shift
    year, month0 = divmod(total, 12)
    return date(year, month0 + 1, 1)


def _month_str(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _add_months_clamped(d: date, months: int) -> date:
    """today + months with day clamped to month end — the expected
    suggested_deadline (mirrors the S4-proven domain algorithm; asserting via it
    here pins that the router passed *these* inputs, which is the router's job)."""
    total = d.year * 12 + (d.month - 1) + months
    year, month0 = divmod(total, 12)
    month = month0 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


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


async def _create_goal(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("name", "goal")
    body.setdefault("target_minor", 1_000_000)
    body.setdefault("currency", "RUB")
    resp = await client.post("/goals", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", _TODAY.isoformat())
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _contribute(
    client: AsyncClient, headers: dict[str, str], goal_id: str, **body: Any
) -> Any:
    return await client.post(
        f"/goals/{goal_id}/contributions", json=body, headers=headers
    )


async def _seed_rate(
    session: AsyncSession, base: str, quote: str, rate: str, as_of: date = _TODAY
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


async def _seed_three_months(client: AsyncClient, headers: dict[str, str]) -> None:
    """3 FULL months of history: income 10_000_000 + expense 7_000_000 each.

    free = (3*10_000_000 - 3*7_000_000) // 3 = 3_000_000 (base RUB, default).
    """
    for shift in (-3, -2, -1):
        day = _month_first(_TODAY, shift).replace(day=10).isoformat()
        await _create_tx(
            client, headers, amount_minor=10_000_000, kind="income", occurred_at=day
        )
        await _create_tx(
            client, headers, amount_minor=7_000_000, kind="expense", occurred_at=day
        )


async def _contribution_rows(session: AsyncSession, goal_id: str) -> list[int]:
    rows = await session.scalars(
        select(GoalContribution.amount_minor).where(
            GoalContribution.goal_id == uuid.UUID(goal_id)
        )
    )
    return list(rows.all())


class TestGoalCrud:
    async def test_create_with_initial_saved_atomic(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "goalinit@x.com")

        with_initial = await _create_goal(
            client, headers, initial_saved_minor=2_000_000
        )
        # The initial amount IS the first ledger row (OQ-5), echoed as saved.
        assert with_initial["saved_minor"] == 2_000_000
        rows = await _contribution_rows(db_session, with_initial["id"])
        assert rows == [2_000_000]

        without = await _create_goal(client, headers, name="bare")
        # Contrast arm: no initial amount → no ledger row at all.
        assert without["saved_minor"] == 0
        assert await _contribution_rows(db_session, without["id"]) == []

    async def test_default_priority_appends(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goalprio@x.com")

        first = await _create_goal(client, headers, name="a")
        second = await _create_goal(client, headers, name="b")
        # Empty portfolio starts at 1; each default create appends after the max.
        assert first["priority"] == 1
        assert second["priority"] == 2

        explicit = await _create_goal(client, headers, name="c", priority=10)
        assert explicit["priority"] == 10
        after_explicit = await _create_goal(client, headers, name="d")
        assert after_explicit["priority"] == 11  # max(priority)=10 → +1

    async def test_list_order_and_archived_filter(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goalorder@x.com")
        low = await _create_goal(client, headers, name="low", priority=2)
        tie_first = await _create_goal(client, headers, name="tie1", priority=1)
        tie_second = await _create_goal(client, headers, name="tie2", priority=1)

        listed = (await client.get("/goals", headers=headers)).json()
        # priority asc; the priority-1 tie broken by created_at (tie1 first).
        assert [g["name"] for g in listed["items"]] == ["tie1", "tie2", "low"]
        assert [g["id"] for g in listed["items"]] == [
            tie_first["id"],
            tie_second["id"],
            low["id"],
        ]

        archived = await client.patch(
            f"/goals/{low['id']}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text
        default = (await client.get("/goals", headers=headers)).json()
        assert [g["name"] for g in default["items"]] == ["tie1", "tie2"]
        resp = await client.get(
            "/goals", params={"include_archived": True}, headers=headers
        )
        included = resp.json()
        assert [g["name"] for g in included["items"]] == ["tie1", "tie2", "low"]

    async def test_goal_no_oracle_404(self, client: AsyncClient) -> None:
        headers_a, _ = await _register_and_login(client, "goalowner@x.com")
        headers_b, _ = await _register_and_login(client, "goalother@x.com")
        goal = await _create_goal(client, headers_a)
        foreign = f"/goals/{goal['id']}"
        missing = f"/goals/{uuid.uuid4()}"

        # Foreign and missing must be byte-identical on every verb (no-oracle).
        for url in (foreign, missing):
            got = await client.get(url, headers=headers_b)
            assert (got.status_code, got.json()) == (404, {"detail": "GOAL_NOT_FOUND"})
            patched = await client.patch(url, json={"name": "x"}, headers=headers_b)
            assert (patched.status_code, patched.json()) == (
                404,
                {"detail": "GOAL_NOT_FOUND"},
            )
            deleted = await client.delete(url, headers=headers_b)
            assert deleted.status_code == 404
            assert deleted.json() == {"detail": "GOAL_NOT_FOUND"}
            contributed = await client.post(
                f"{url}/contributions", json={"amount_minor": 100}, headers=headers_b
            )
            assert (contributed.status_code, contributed.json()) == (
                404,
                {"detail": "GOAL_NOT_FOUND"},
            )

    async def test_patch_mechanics(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "goalpatch@x.com")
        deadline = _add_months_clamped(_TODAY, 6).isoformat()
        goal = await _create_goal(
            client, headers, deadline=deadline, initial_saved_minor=1000
        )

        cleared = await client.patch(
            f"/goals/{goal['id']}", json={"deadline": None}, headers=headers
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["deadline"] is None  # explicit null clears

        rejected = await client.patch(
            f"/goals/{goal['id']}", json={"target_minor": None}, headers=headers
        )
        assert rejected.status_code == 422
        assert rejected.json() == {"detail": "TARGET_REQUIRED"}

        relabeled = await client.patch(
            f"/goals/{goal['id']}", json={"currency": "USD"}, headers=headers
        )
        assert relabeled.status_code == 200, relabeled.text
        assert relabeled.json()["currency"] == "USD"
        # Relabel only (D12): the ledger row is untouched, the sum unchanged.
        assert await _contribution_rows(db_session, goal["id"]) == [1000]
        assert relabeled.json()["saved_minor"] == 1000

    async def test_delete_cascades_contributions(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "goaldel@x.com")
        goal = await _create_goal(client, headers, initial_saved_minor=500)
        resp = await _contribute(client, headers, goal["id"], amount_minor=300)
        assert resp.status_code == 201, resp.text

        deleted = await client.delete(f"/goals/{goal['id']}", headers=headers)
        assert deleted.status_code == 204
        count = await db_session.scalar(
            select(func.count())
            .select_from(GoalContribution)
            .where(GoalContribution.goal_id == uuid.UUID(goal["id"]))
        )
        assert count == 0


class TestGoalComputed:
    async def test_computed_math_happy(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goalmath@x.com")
        await _seed_three_months(client, headers)  # free = 3_000_000 (RUB)
        deadline = _month_first(_TODAY, 4).replace(day=28)  # months_until = 4
        await _create_goal(
            client,
            headers,
            name="vacation",
            target_minor=12_000_000,
            deadline=deadline.isoformat(),
            initial_saved_minor=2_000_000,
        )

        body = (await client.get("/goals", headers=headers)).json()

        assert body["free_balance_minor"] == 3_000_000  # (30M - 21M) // 3
        assert body["realism_unavailable"] is False
        assert body["base_currency"] == "RUB"  # AM-4, top level
        (item,) = body["items"]
        assert item["saved_minor"] == 2_000_000
        assert item["completed"] is False
        # ceil((12_000_000 - 2_000_000) / 4 months) = 2_500_000 RUB/month
        assert item["monthly_needed_minor"] == 2_500_000
        assert item["realistic"] is True  # 2_500_000 <= 3_000_000
        # ceil(10_000_000 remaining / 3_000_000 free) = 4 months at current pace
        assert item["months_to_target"] == 4
        assert item["suggested_deadline"] == _add_months_clamped(_TODAY, 4).isoformat()
        # Single goal, need 2_500_000 <= free 3_000_000 → fully allocated (base RUB).
        assert item["allocated_monthly_minor"] == 2_500_000
        assert item["realism_unavailable"] is False
        assert item["base_currency"] == "RUB"  # AM-4, per item

    async def test_partial_current_month_excluded(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goalwindow@x.com")
        await _seed_three_months(client, headers)  # free = 3_000_000
        await _create_goal(client, headers)

        await _create_tx(
            client,
            headers,
            amount_minor=99_000_000,
            kind="income",
            occurred_at=_TODAY.isoformat(),
        )
        current = (await client.get("/goals", headers=headers)).json()
        # The current partial month is OUTSIDE the window — heavy income today
        # must not move the free balance.
        assert current["free_balance_minor"] == 3_000_000

        await _create_tx(
            client,
            headers,
            amount_minor=3_000_000,
            kind="income",
            occurred_at=_month_first(_TODAY, -1).replace(day=11).isoformat(),
        )
        moved = (await client.get("/goals", headers=headers)).json()
        # Contrast arm: the same money INSIDE the window does move it:
        # (30M + 3M - 21M) // 3 = 4_000_000.
        assert moved["free_balance_minor"] == 4_000_000

    async def test_waterfall_allocation(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goalwater@x.com")
        await _seed_three_months(client, headers)  # free = 3_000_000
        deadline_4 = _month_first(_TODAY, 4).replace(day=28).isoformat()
        deadline_2 = _month_first(_TODAY, 2).replace(day=28).isoformat()
        first = await _create_goal(
            client,
            headers,
            name="first",
            priority=1,
            target_minor=12_000_000,
            deadline=deadline_4,
            initial_saved_minor=2_000_000,
        )
        second = await _create_goal(
            client,
            headers,
            name="second",
            priority=2,
            target_minor=3_000_000,
            deadline=deadline_2,
        )
        done = await _create_goal(
            client,
            headers,
            name="done",
            priority=3,
            target_minor=1_000,
            initial_saved_minor=1_000,
        )

        body = (await client.get("/goals", headers=headers)).json()
        by_id = {g["id"]: g for g in body["items"]}

        # Waterfall over free 3_000_000: first needs ceil(10M/4)=2_500_000 →
        # fully filled; second needs ceil(3M/2)=1_500_000 → gets the 500_000
        # remainder (partial); the completed third is excluded → 0.
        assert by_id[first["id"]]["allocated_monthly_minor"] == 2_500_000
        assert by_id[second["id"]]["allocated_monthly_minor"] == 500_000
        assert by_id[done["id"]]["completed"] is True
        assert by_id[done["id"]]["allocated_monthly_minor"] == 0

        # AM-4 consistency: the single GET runs the same whole-portfolio
        # assembler, so allocated_monthly_minor matches the list row exactly —
        # asserted in a fixture where OTHER goals exist (closes QA G5).
        for goal_id in (first["id"], second["id"], done["id"]):
            single = await client.get(f"/goals/{goal_id}", headers=headers)
            assert single.status_code == 200, single.text
            assert (
                single.json()["allocated_monthly_minor"]
                == by_id[goal_id]["allocated_monthly_minor"]
            )

        # ARCHIVED exclusion arm: an archived goal with a live deadline and a
        # positive need — priority 0 (ahead of everyone), need ceil(12M/2) =
        # 6_000_000 > free, so if it entered the waterfall it would consume
        # the ENTIRE flow and starve both live goals.
        arch = await _create_goal(
            client,
            headers,
            name="arch",
            priority=0,
            target_minor=12_000_000,
            deadline=deadline_2,
        )
        archived = await client.patch(
            f"/goals/{arch['id']}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text

        with_archived = await client.get(
            "/goals", params={"include_archived": True}, headers=headers
        )
        assert with_archived.status_code == 200, with_archived.text
        arch_by_id = {g["id"]: g for g in with_archived.json()["items"]}
        # The archived goal allocates 0 despite its priority and positive need...
        assert arch_by_id[arch["id"]]["allocated_monthly_minor"] == 0
        # ...and the live goals' rows are byte-unchanged by its presence.
        for goal_id in (first["id"], second["id"], done["id"]):
            assert arch_by_id[goal_id] == by_id[goal_id]

        # AM-4 arm for the archived goal: its single GET (which always loads
        # archived goals) equals its include_archived=true list row exactly.
        arch_single = await client.get(f"/goals/{arch['id']}", headers=headers)
        assert arch_single.status_code == 200, arch_single.text
        assert arch_single.json() == arch_by_id[arch["id"]]

    async def test_foreign_currency_goal_converts(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "goalusd@x.com")
        await _seed_three_months(client, headers)  # free = 3_000_000 RUB
        # Stored canonical direction only; USD→RUB derives by inversion: 80 RUB/USD.
        await _seed_rate(db_session, "RUB", "USD", "0.0125")
        await _create_goal(
            client,
            headers,
            name="usd goal",
            currency="USD",
            target_minor=100_000,  # $1000.00
            deadline=_month_first(_TODAY, 4).replace(day=28).isoformat(),
        )

        (item,) = (await client.get("/goals", headers=headers)).json()["items"]

        # Needed in GOAL currency: ceil(100_000 / 4 months) = 25_000 ($250/mo).
        assert item["monthly_needed_minor"] == 25_000
        # Free 3_000_000 RUB → USD at 0.0125: 30_000.00 * 0.0125 = $375.00.
        # realistic: 25_000 <= 37_500 → True.
        assert item["realistic"] is True
        # ceil(100_000 / 37_500) = 3 months at current pace.
        assert item["months_to_target"] == 3
        # Allocation in PROFILE BASE currency (R1(2)): $250.00 * 80 = 20_000.00
        # RUB = 2_000_000 minor — free covers it in full.
        assert item["allocated_monthly_minor"] == 2_000_000
        assert item["base_currency"] == "RUB"
        assert item["realism_unavailable"] is False

    async def test_per_goal_realism_unavailable_isolated(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "goalexotic@x.com")
        await _seed_three_months(client, headers)  # free = 3_000_000
        exotic = await _create_goal(
            client,
            headers,
            name="exotic",
            currency="JPY",  # no rate seeded — unconvertible
            priority=1,
            target_minor=1_000_000,
            deadline=_month_first(_TODAY, 2).replace(day=28).isoformat(),
        )
        plain = await _create_goal(
            client,
            headers,
            name="plain",
            priority=2,
            target_minor=8_000_000,
            deadline=_month_first(_TODAY, 4).replace(day=28).isoformat(),
        )

        body = (await client.get("/goals", headers=headers)).json()
        by_id = {g["id"]: g for g in body["items"]}

        # [SL-3] pin: the exotic goal degrades ALONE — null realism fields,
        # zero allocation — while its goal-currency math stays computed:
        # ceil(1_000_000 / 2 months) = 500_000 JPY/month.
        exotic_item = by_id[exotic["id"]]
        assert exotic_item["realism_unavailable"] is True
        assert exotic_item["realistic"] is None
        assert exotic_item["months_to_target"] is None
        assert exotic_item["suggested_deadline"] is None
        assert exotic_item["allocated_monthly_minor"] == 0
        assert exotic_item["monthly_needed_minor"] == 500_000
        assert exotic_item["saved_minor"] == 0
        assert exotic_item["completed"] is False

        # The other goal computes as if the exotic one did not exist: despite
        # being LOWER priority it receives its full need, ceil(8M/4) = 2_000_000
        # (the exotic goal is excluded from the waterfall input, not zero-need).
        plain_item = by_id[plain["id"]]
        assert plain_item["realism_unavailable"] is False
        assert plain_item["allocated_monthly_minor"] == 2_000_000
        assert plain_item["realistic"] is True  # 2_000_000 <= 3_000_000

        # Per-goal vs top-level contrast in ONE fixture: the free-balance window
        # itself is clean, so the top-level flag stays FALSE.
        assert body["realism_unavailable"] is False

    async def test_top_level_flag_on_degraded_window(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goaldegraded@x.com")
        await _seed_three_months(client, headers)  # free = 3_000_000
        # An unconvertible foreign tx INSIDE the window: GBP has no rate, so the
        # row is excluded from the sums and counted (D9).
        await _create_tx(
            client,
            headers,
            amount_minor=5_000_000,
            kind="income",
            currency="GBP",
            occurred_at=_month_first(_TODAY, -2).replace(day=15).isoformat(),
        )
        await _create_goal(
            client,
            headers,
            target_minor=6_000_000,
            deadline=_month_first(_TODAY, 4).replace(day=28).isoformat(),
        )

        body = (await client.get("/goals", headers=headers)).json()

        # The other direction of the [SL-3] contrast: the WINDOW is degraded
        # (top-level flag), the excluded row moved no sum (free unchanged), and
        # the base-currency goal's per-goal flag is untouched.
        assert body["realism_unavailable"] is True
        assert body["free_balance_minor"] == 3_000_000
        (item,) = body["items"]
        assert item["realism_unavailable"] is False
        assert item["realistic"] is True  # ceil(6M/4)=1_500_000 <= 3_000_000


class TestContributions:
    async def test_contribution_invariant(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goalcontrib@x.com")
        goal = await _create_goal(client, headers, initial_saved_minor=2_500)

        to_zero = await _contribute(client, headers, goal["id"], amount_minor=-2_500)
        assert to_zero.status_code == 201, to_zero.text  # exactly-to-zero allowed

        beyond = await _contribute(client, headers, goal["id"], amount_minor=-1)
        # One minor unit past zero: SUM(0) + (-1) < 0.
        assert beyond.status_code == 422
        assert beyond.json() == {"detail": "CONTRIBUTION_EXCEEDS_SAVED"}

        zero = await _contribute(client, headers, goal["id"], amount_minor=0)
        assert zero.status_code == 422  # validator: sign IS the semantics, 0 has none

    async def test_delete_contribution_guarded(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goalundo@x.com")
        goal = await _create_goal(client, headers)
        deposit = await _contribute(client, headers, goal["id"], amount_minor=1_000)
        assert deposit.status_code == 201, deposit.text
        withdrawal = await _contribute(client, headers, goal["id"], amount_minor=-1_000)
        assert withdrawal.status_code == 201, withdrawal.text  # saved now 0

        blocked = await client.delete(
            f"/goals/{goal['id']}/contributions/{deposit.json()['id']}",
            headers=headers,
        )
        # Deleting the +1_000 row would leave SUM = -1_000 < 0.
        assert blocked.status_code == 422
        assert blocked.json() == {"detail": "CONTRIBUTION_EXCEEDS_SAVED"}

        allowed = await client.delete(
            f"/goals/{goal['id']}/contributions/{withdrawal.json()['id']}",
            headers=headers,
        )
        assert allowed.status_code == 204  # deleting the withdrawal restores 1_000

    async def test_contribution_list_order_and_pagination(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "goalhistory@x.com")
        goal = await _create_goal(client, headers)
        earlier = _month_first(_TODAY, -1).replace(day=5)
        later = _month_first(_TODAY, -1).replace(day=20)
        # Creation order: late_old (later date), mid (earlier date), late_new
        # (later date, created LAST) — two rows share `later` so the
        # created_at DESC tie-break is pinned, not just occurred_at.
        ids: list[str] = []
        for amount, day in ((100, later), (200, earlier), (300, later)):
            resp = await _contribute(
                client,
                headers,
                goal["id"],
                amount_minor=amount,
                occurred_at=day.isoformat(),
            )
            assert resp.status_code == 201, resp.text
            ids.append(resp.json()["id"])
        late_old, mid, late_new = ids

        url = f"/goals/{goal['id']}/contributions"
        full = (await client.get(url, headers=headers)).json()
        # occurred_at DESC puts the later date first; within it created_at DESC
        # puts the most recently created row first.
        assert [r["id"] for r in full["items"]] == [late_new, late_old, mid]
        assert full["total"] == 3

        page = (
            await client.get(url, params={"limit": 2, "offset": 2}, headers=headers)
        ).json()
        # Offset applies AFTER ordering: the slice past the two later-date rows
        # is exactly the earlier-date one; total stays the unpaginated count.
        assert [r["id"] for r in page["items"]] == [mid]
        assert page["total"] == 3

    async def test_contribution_no_oracle(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goalscope@x.com")
        goal_one = await _create_goal(client, headers, name="one")
        goal_two = await _create_goal(client, headers, name="two")
        row = await _contribute(client, headers, goal_one["id"], amount_minor=100)
        assert row.status_code == 201, row.text

        # The fresh wrong-own-goal path: goal_two is MINE, the contribution id is
        # real but belongs to goal_one — byte-identical to a missing id.
        wrong_goal = await client.delete(
            f"/goals/{goal_two['id']}/contributions/{row.json()['id']}",
            headers=headers,
        )
        missing = await client.delete(
            f"/goals/{goal_two['id']}/contributions/{uuid.uuid4()}",
            headers=headers,
        )
        assert (wrong_goal.status_code, wrong_goal.json()) == (
            404,
            {"detail": "CONTRIBUTION_NOT_FOUND"},
        )
        assert (missing.status_code, missing.json()) == (
            404,
            {"detail": "CONTRIBUTION_NOT_FOUND"},
        )


class TestProgress:
    async def test_progress_series(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "goalprogress@x.com")
        goal = await _create_goal(client, headers)
        gid = goal["id"]
        # Pre-window base (months=3 window starts at month -2): +500 at month -3.
        for amount, shift in ((500, -3), (1_000, -2)):
            resp = await _contribute(
                client,
                headers,
                gid,
                amount_minor=amount,
                occurred_at=_month_first(_TODAY, shift).replace(day=5).isoformat(),
            )
            assert resp.status_code == 201, resp.text
        current = await _contribute(
            client, headers, gid, amount_minor=-200, occurred_at=_TODAY.isoformat()
        )
        assert current.status_code == 201, current.text

        resp = await client.get(
            f"/goals/{gid}/progress", params={"months": 3}, headers=headers
        )
        assert resp.status_code == 200, resp.text

        # Window months: [-2, -1, current]. saved_end is cumulative INCLUDING
        # the pre-window +500; the empty middle month is present with 0.
        assert resp.json() == [
            {
                "month": _month_str(_month_first(_TODAY, -2)),
                "contributed_minor": 1_000,
                "saved_end_minor": 1_500,  # 500 pre-window + 1_000
            },
            {
                "month": _month_str(_month_first(_TODAY, -1)),
                "contributed_minor": 0,
                "saved_end_minor": 1_500,
            },
            {
                "month": _month_str(_TODAY),
                "contributed_minor": -200,
                "saved_end_minor": 1_300,
            },
        ]
