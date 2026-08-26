"""Goal plan tree — real Postgres, real migrations, real recursive SQL.

The closed test list of `.tasks/goal-planner/plan.md` §1 plus the four
consequences of its §8 (move semantics, the subtree filter, single/list parity,
the two file counters). Nothing else: Pydantic bound rejections, the 401 wall and
column existence are deliberately absent (the pytest-conventions skill).

Money is hand-pinned with the arithmetic in a comment at every assertion. The
profile's base currency is set to the GOAL's currency wherever the "paid" bucket
order is under test — that third arm exists precisely so a MANUAL base override
on a transaction wins over an automatic conversion (plan §5 D-1), and it is
unreachable while the base and the goal disagree.

Rates are seeded as ``exchange_rates`` rows (no fetcher, scheduler off), and only
the direction the code is expected to use is ever stored, so an accidental
inversion would show up as a wrong number rather than pass silently.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from helpers import account_for_currency
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import ExchangeRate, GoalItem, GoalItemFile

PASSWORD = "password123"

_TODAY = datetime.now(UTC).date()


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


async def _set_base_currency(
    client: AsyncClient, headers: dict[str, str], currency: str
) -> None:
    resp = await client.patch(
        "/profile", json={"base_currency": currency}, headers=headers
    )
    assert resp.status_code == 200, resp.text


async def _create_goal(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("name", "trip")
    body.setdefault("target_minor", 1_000_000)
    body.setdefault("currency", "USD")
    resp = await client.post("/goals", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def _create_item(
    client: AsyncClient, headers: dict[str, str], goal_id: str, **body: Any
) -> dict[str, Any]:
    body.setdefault("name", "item")
    resp = await client.post(f"/goals/{goal_id}/items", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def _items(
    client: AsyncClient, headers: dict[str, str], goal_id: str
) -> list[dict[str, Any]]:
    resp = await client.get(f"/goals/{goal_id}/items", headers=headers)
    assert resp.status_code == 200, resp.text
    items: list[dict[str, Any]] = resp.json()["items"]
    return items


async def _by_name(
    client: AsyncClient, headers: dict[str, str], goal_id: str
) -> dict[str, dict[str, Any]]:
    return {item["name"]: item for item in await _items(client, headers, goal_id)}


async def _read_goal(
    client: AsyncClient, headers: dict[str, str], goal_id: str
) -> dict[str, Any]:
    resp = await client.get(f"/goals/{goal_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    goal: dict[str, Any] = resp.json()
    return goal


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", _TODAY.isoformat())
    if "account_id" not in body:
        body["account_id"] = await account_for_currency(
            client, headers, body.get("currency")
        )
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def _seed_rate(session: AsyncSession, base: str, quote: str, rate: str) -> None:
    session.add(
        ExchangeRate(
            base=base,
            quote=quote,
            as_of_date=_TODAY,
            rate=Decimal(rate),
            provider="test",
        )
    )
    await session.commit()


class TestCycle:
    async def test_move_under_own_descendant_is_422(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "gi-cycle@x.com")
        goal = await _create_goal(client, headers)
        a = await _create_item(client, headers, goal["id"], name="A")
        b = await _create_item(client, headers, goal["id"], name="B", parent_id=a["id"])
        c = await _create_item(client, headers, goal["id"], name="C", parent_id=b["id"])

        resp = await client.patch(
            f"/goals/{goal['id']}/items/{a['id']}",
            json={"parent_id": c["id"]},
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "GOAL_ITEM_CYCLE"}
        # Its own parent is the same refusal, and neither attempt moved anything.
        self_move = await client.patch(
            f"/goals/{goal['id']}/items/{a['id']}",
            json={"parent_id": a["id"]},
            headers=headers,
        )
        assert self_move.status_code == 422, self_move.text
        assert self_move.json() == {"detail": "GOAL_ITEM_CYCLE"}
        parents = {
            item["name"]: item["parent_id"]
            for item in await _items(client, headers, goal["id"])
        }
        assert parents == {"A": None, "B": a["id"], "C": b["id"]}

    async def test_trigger_backstop_rejects_direct_sql_cycle(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The DB itself refuses a cycle — the router's check is not the guarantee.

        Straight UPDATE, no router: this is what holds when two concurrent
        re-parents each pass the pre-write check (the live A3 scenario).
        """
        headers, _ = await _register_and_login(client, "gi-trigger@x.com")
        goal = await _create_goal(client, headers)
        a = await _create_item(client, headers, goal["id"], name="A")
        b = await _create_item(client, headers, goal["id"], name="B", parent_id=a["id"])

        with pytest.raises(DBAPIError) as excinfo:
            await db_session.execute(
                text("UPDATE goal_items SET parent_id = :b WHERE id = :a"),
                {"a": uuid.UUID(a["id"]), "b": uuid.UUID(b["id"])},
            )
            await db_session.commit()

        assert getattr(excinfo.value.orig, "sqlstate", None) == "23514"


class TestTreeAggregates:
    async def test_leaf_sums_roll_up_and_ceiling_flag(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "gi-rollup@x.com")
        goal = await _create_goal(client, headers, target_minor=500_000)
        root = await _create_item(
            client, headers, goal["id"], name="R", amount_minor=200_000
        )
        parent = await _create_item(
            client,
            headers,
            goal["id"],
            name="P",
            parent_id=root["id"],
            amount_minor=100_000,
        )
        for name, amount in (("L1", 90_000), ("L2", 60_000)):
            await _create_item(
                client,
                headers,
                goal["id"],
                name=name,
                parent_id=parent["id"],
                amount_minor=amount,
            )

        items = await _by_name(client, headers, goal["id"])

        # Leaves are their own working number (one rule, not two).
        assert items["L1"]["children_sum_minor"] == 90_000
        # P: 90000 + 60000 = 150000 from the leaves, over its own 100000 ceiling.
        assert items["P"]["children_sum_minor"] == 150_000
        assert items["P"]["ceiling_exceeded"] is True
        # R: the LEAVES roll up, not P's own 100000 — 150000, under R's 200000.
        assert items["R"]["children_sum_minor"] == 150_000
        assert items["R"]["ceiling_exceeded"] is False
        goal_read = await _read_goal(client, headers, goal["id"])
        assert goal_read["planned_total_minor"] == 150_000

    async def test_unconverted_leaf_is_counted_not_summed(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "gi-unconverted@x.com")
        goal = await _create_goal(client, headers)  # USD
        near = await _create_item(client, headers, goal["id"], name="near")
        await _create_item(
            client,
            headers,
            goal["id"],
            name="near-leaf",
            parent_id=near["id"],
            amount_minor=5_000,
        )
        far = await _create_item(client, headers, goal["id"], name="far")
        # No ZWL rate is seeded, so the pair stays NULL/NULL — the node is present
        # in the tree but has no goal-currency reading.
        exotic = await _create_item(
            client,
            headers,
            goal["id"],
            name="far-leaf",
            parent_id=far["id"],
            amount_minor=10_000,
            currency="ZWL",
        )

        assert exotic["converted_minor"] is None
        assert exotic["converted_currency"] is None
        goal_read = await _read_goal(client, headers, goal["id"])
        # 5000 only: the exotic leaf is EXCLUDED, never summed as zero.
        assert goal_read["planned_total_minor"] == 5_000
        assert goal_read["planned_unconverted_count"] == 1
        # ...and the same honesty per NODE: the goal-level count says the plan is
        # understated, this one says which branch. "far" sums to 0 but admits why;
        # "near", whose subtree is fully readable, claims nothing.
        items = await _by_name(client, headers, goal["id"])
        far_node = items["far"]
        assert (
            far_node["children_sum_minor"],
            far_node["planned_unconverted_count"],
        ) == (
            0,
            1,
        )
        near_node = items["near"]
        assert (
            near_node["children_sum_minor"],
            near_node["planned_unconverted_count"],
        ) == (5_000, 0)


class TestItemMoney:
    async def test_converted_patch_semantics(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """omit=keep / value=override / null=clear+recompute, contrasted in one test."""
        headers, _ = await _register_and_login(client, "gi-money@x.com")
        await _seed_rate(db_session, "EUR", "USD", "1.05")
        goal = await _create_goal(client, headers)  # USD
        item = await _create_item(
            client,
            headers,
            goal["id"],
            name="hotel",
            amount_minor=10_000,
            currency="EUR",
        )
        # 100.00 EUR * 1.05 = 105.00 USD
        assert (item["converted_minor"], item["converted_currency"]) == (10_500, "USD")

        url = f"/goals/{goal['id']}/items/{item['id']}"
        kept = await client.patch(url, json={"name": "hotel 2"}, headers=headers)
        assert kept.status_code == 200, kept.text
        assert kept.json()["converted_minor"] == 10_500  # omit = keep

        overridden = await client.patch(
            url, json={"converted_minor": 20_000}, headers=headers
        )
        assert overridden.status_code == 200, overridden.text
        # Manual wins: NOT recomputed to 10500.
        assert overridden.json()["converted_minor"] == 20_000

        cleared = await client.patch(
            url, json={"converted_minor": None}, headers=headers
        )
        assert cleared.status_code == 200, cleared.text
        # Explicit null discards the override and recomputes — it does not claim
        # "no rate existed".
        assert (
            cleared.json()["converted_minor"],
            cleared.json()["converted_currency"],
        ) == (
            10_500,
            "USD",
        )


class TestDeadlineInheritance:
    async def test_goal_deadline_move_shifts_only_unset_items(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "gi-deadline@x.com")
        goal = await _create_goal(client, headers, deadline="2026-06-15")
        free = await _create_item(client, headers, goal["id"], name="free")
        own = await _create_item(
            client, headers, goal["id"], name="own", deadline="2026-05-01"
        )
        await _create_item(
            client, headers, goal["id"], name="child", parent_id=own["id"]
        )

        before = await _by_name(client, headers, goal["id"])
        assert (
            before["free"]["effective_deadline"],
            before["free"]["deadline_inherited"],
        ) == (
            "2026-06-15",
            True,
        )
        assert (
            before["own"]["effective_deadline"],
            before["own"]["deadline_inherited"],
        ) == (
            "2026-05-01",
            False,
        )
        # Two-level COALESCE: the child inherits from its PARENT, not from the goal.
        assert before["child"]["effective_deadline"] == "2026-05-01"

        moved = await client.patch(
            f"/goals/{goal['id']}", json={"deadline": "2026-07-15"}, headers=headers
        )
        assert moved.status_code == 200, moved.text

        after = await _by_name(client, headers, goal["id"])
        assert after["free"]["effective_deadline"] == "2026-07-15"
        assert after["own"]["effective_deadline"] == "2026-05-01"
        assert after["child"]["effective_deadline"] == "2026-05-01"
        # And nothing was ever materialized into the column — that is what makes
        # the move work at all.
        stored = await db_session.scalar(
            select(GoalItem.deadline).where(GoalItem.id == uuid.UUID(free["id"]))
        )
        assert stored is None


class TestReminderIntent:
    async def test_two_intents_at_once_are_refused_but_switching_between_them_is_not(
        self, client: AsyncClient
    ) -> None:
        """A reminder is "on this date" OR "N days before", never both (§6).

        The PATCH arms are the point: the guard reads the EFFECTIVE pair, so a bare
        `remind_on` sent to a node that already stores an offset is the same illegal
        row as sending both at once — while the SAME date sent together with an
        explicit `remind_days_before: null` is the intent switch the form makes, and
        must pass. Without that last arm the guard would be a dead end: a node with
        an offset could never be given a fixed date again.
        """
        headers, _ = await _register_and_login(client, "gi-remind@x.com")
        goal = await _create_goal(client, headers, deadline="2026-06-15")
        today = _TODAY.isoformat()

        both = await client.post(
            f"/goals/{goal['id']}/items",
            json={"name": "both", "remind_on": today, "remind_days_before": 3},
            headers=headers,
        )
        assert both.status_code == 422, both.text
        assert both.json() == {"detail": "GOAL_ITEM_REMIND_CONFLICT"}

        item = await _create_item(
            client, headers, goal["id"], name="offset", remind_days_before=3
        )
        collided = await client.patch(
            f"/goals/{goal['id']}/items/{item['id']}",
            json={"remind_on": today},
            headers=headers,
        )
        assert collided.status_code == 422, collided.text
        assert collided.json() == {"detail": "GOAL_ITEM_REMIND_CONFLICT"}

        switched = await client.patch(
            f"/goals/{goal['id']}/items/{item['id']}",
            json={"remind_on": today, "remind_days_before": None},
            headers=headers,
        )
        assert switched.status_code == 200, switched.text
        assert switched.json()["remind_on"] == today
        assert switched.json()["remind_days_before"] is None


class TestDelete:
    async def test_subtree_cascade_unlinks_transactions_but_keeps_them(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "gi-delete@x.com")
        await _set_base_currency(client, headers, "USD")
        goal = await _create_goal(client, headers)  # USD
        a = await _create_item(client, headers, goal["id"], name="A")
        a1 = await _create_item(
            client,
            headers,
            goal["id"],
            name="A1",
            parent_id=a["id"],
            amount_minor=1_000,
        )
        a2 = await _create_item(
            client,
            headers,
            goal["id"],
            name="A2",
            parent_id=a1["id"],
            amount_minor=1_000,
        )
        tx1 = await _create_tx(
            client, headers, currency="USD", amount_minor=3_000, goal_item_id=a1["id"]
        )
        tx2 = await _create_tx(
            client, headers, currency="USD", amount_minor=4_000, goal_item_id=a2["id"]
        )
        assert (await _read_goal(client, headers, goal["id"]))["paid_minor"] == 7_000
        # The TREE's rollup, on the ancestor, before anything is deleted: A1 and A2
        # are two descendants of A paying in ONE currency, which is exactly the
        # duplicate key jsonb_object_agg would silently swallow (it keeps the last)
        # without the paid_by_anc GROUP BY. 3_000 + 4_000 = 7_000, not 4_000.
        before = await _by_name(client, headers, goal["id"])
        assert before["A"]["paid_minor"] == 7_000

        deleted = await client.delete(
            f"/goals/{goal['id']}/items/{a['id']}", headers=headers
        )
        assert deleted.status_code == 204, deleted.text

        assert await _items(client, headers, goal["id"]) == []
        listed = await client.get("/transactions", headers=headers)
        assert listed.status_code == 200, listed.text
        rows = {row["id"]: row for row in listed.json()["items"]}
        for tx_id in (tx1["id"], tx2["id"]):
            # The money survives, the attribution does not (ON DELETE SET NULL).
            assert tx_id in rows
            assert rows[tx_id]["goal_item_id"] is None
        assert (await _read_goal(client, headers, goal["id"]))["paid_minor"] == 0


class TestLinking:
    async def test_income_cannot_be_linked_and_patching_kind_of_linked_is_422(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "gi-expense@x.com")
        goal = await _create_goal(client, headers)
        item = await _create_item(client, headers, goal["id"], name="A")
        account = await account_for_currency(client, headers)

        linked_income = await client.post(
            "/transactions",
            json={
                "amount_minor": 1_000,
                "kind": "income",
                "account_id": account,
                "occurred_at": _TODAY.isoformat(),
                "goal_item_id": item["id"],
            },
            headers=headers,
        )
        assert linked_income.status_code == 422, linked_income.text
        assert linked_income.json() == {"detail": "GOAL_ITEM_EXPENSE_ONLY"}

        # The other direction: a linked expense may not become an income row.
        expense = await _create_tx(client, headers, goal_item_id=item["id"])
        rekinded = await client.patch(
            f"/transactions/{expense['id']}", json={"kind": "income"}, headers=headers
        )
        assert rekinded.status_code == 422, rekinded.text
        assert rekinded.json() == {"detail": "GOAL_ITEM_EXPENSE_ONLY"}

    async def test_foreign_item_is_byte_identical_404(
        self, client: AsyncClient
    ) -> None:
        headers_a, _ = await _register_and_login(client, "gi-own@x.com")
        headers_b, _ = await _register_and_login(client, "gi-other@x.com")
        goal_b = await _create_goal(client, headers_b)
        item_b = await _create_item(client, headers_b, goal_b["id"], name="theirs")
        account = await account_for_currency(client, headers_a)

        bodies: list[tuple[int, str]] = []
        for item_id in (item_b["id"], str(uuid.uuid4())):
            resp = await client.post(
                "/transactions",
                json={
                    "amount_minor": 1_000,
                    "kind": "expense",
                    "account_id": account,
                    "occurred_at": _TODAY.isoformat(),
                    "goal_item_id": item_id,
                },
                headers=headers_a,
            )
            bodies.append((resp.status_code, resp.text))

        assert bodies[0] == bodies[1]
        assert bodies[0][0] == 404
        assert bodies[0][1] == '{"detail":"GOAL_ITEM_NOT_FOUND"}'


class TestPaid:
    async def test_paid_converts_one_rate_per_basket_and_counts_rateless(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """All three "paid" arms in one goal, plus the honest rateless counter."""
        headers, _ = await _register_and_login(client, "gi-paid@x.com")
        await _set_base_currency(client, headers, "USD")
        await _seed_rate(db_session, "EUR", "USD", "1.05")
        goal = await _create_goal(client, headers, target_minor=100_000)  # USD
        item = await _create_item(
            client, headers, goal["id"], name="A", amount_minor=50_000
        )
        await client.post(
            f"/goals/{goal['id']}/contributions",
            json={"amount_minor": 10_000},
            headers=headers,
        )

        # Arm 1 — the transaction is already in the goal's currency.
        await _create_tx(
            client,
            headers,
            currency="USD",
            amount_minor=30_000,
            goal_item_id=item["id"],
        )
        # Arm 2 — a MANUAL base override in the goal's currency beats the rate:
        # 100.00 EUR booked as 120.00 USD by hand (the automatic 1.05 would be 105.00).
        await _create_tx(
            client,
            headers,
            currency="EUR",
            amount_minor=10_000,
            base_amount_minor=12_000,
            goal_item_id=item["id"],
        )
        # Arm 3, rateless — no CZK->USD rate exists, so the basket is excluded whole.
        await _create_tx(
            client,
            headers,
            currency="CZK",
            amount_minor=50_000,
            goal_item_id=item["id"],
        )

        goal_read = await _read_goal(client, headers, goal["id"])

        # 30000 + 12000 (the override, NOT 10500) = 42000; the CZK basket is counted.
        assert goal_read["paid_minor"] == 42_000
        assert goal_read["paid_unconverted_count"] == 1
        # effective 50000 (bottom-up) - paid 42000 - saved 10000 = -2000: over-funded
        # is returned NEGATIVE, not clamped.
        assert goal_read["effective_target_minor"] == 50_000
        assert goal_read["remaining_to_find_minor"] == -2_000
        node = (await _by_name(client, headers, goal["id"]))["A"]
        assert (node["paid_minor"], node["paid_unconverted_count"]) == (42_000, 1)


class TestEffectiveTarget:
    async def test_manual_target_switches_to_bottom_up_and_back(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "gi-target@x.com")
        goal = await _create_goal(client, headers, target_minor=2_000_000)

        before = await _read_goal(client, headers, goal["id"])
        assert before["has_items"] is False
        assert before["planned_total_minor"] == 0
        # Byte-identical to the pre-scope behaviour for a goal with no plan.
        assert before["effective_target_minor"] == 2_000_000

        await _create_item(
            client, headers, goal["id"], name="first", amount_minor=500_000
        )
        with_items = await _read_goal(client, headers, goal["id"])
        assert with_items["has_items"] is True
        assert with_items["planned_total_minor"] == 500_000
        assert with_items["effective_target_minor"] == 500_000
        # The manual target is still in the response: the disagreement is a fact
        # the user is entitled to see.
        assert with_items["target_minor"] == 2_000_000

        override = await client.patch(
            f"/goals/{goal['id']}",
            json={"final_cost_override_minor": 1_800_000},
            headers=headers,
        )
        assert override.status_code == 200, override.text
        assert override.json()["effective_target_minor"] == 1_800_000
        assert override.json()["planned_total_minor"] == 500_000  # both visible

        cleared = await client.patch(
            f"/goals/{goal['id']}",
            json={"final_cost_override_minor": None},
            headers=headers,
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["effective_target_minor"] == 500_000


class TestArchivedGoal:
    async def test_write_to_archived_goal_is_422_and_foreign_is_404(
        self, client: AsyncClient
    ) -> None:
        headers_a, _ = await _register_and_login(client, "gi-arch-own@x.com")
        headers_b, _ = await _register_and_login(client, "gi-arch-other@x.com")
        own = await _create_goal(client, headers_a)
        item = await _create_item(client, headers_a, own["id"], name="A")
        foreign = await _create_goal(client, headers_b)
        for headers, goal_id in ((headers_a, own["id"]), (headers_b, foreign["id"])):
            archived = await client.patch(
                f"/goals/{goal_id}", json={"archived": True}, headers=headers
            )
            assert archived.status_code == 200, archived.text

        created = await client.post(
            f"/goals/{own['id']}/items", json={"name": "nope"}, headers=headers_a
        )
        assert created.status_code == 422, created.text
        assert created.json() == {"detail": "GOAL_ARCHIVED"}
        patched = await client.patch(
            f"/goals/{own['id']}/items/{item['id']}",
            json={"name": "nope"},
            headers=headers_a,
        )
        assert patched.status_code == 422, patched.text

        # Someone else's archived goal must not admit that it exists.
        probe = await client.post(
            f"/goals/{foreign['id']}/items", json={"name": "nope"}, headers=headers_a
        )
        assert probe.status_code == 404, probe.text
        assert probe.json() == {"detail": "GOAL_NOT_FOUND"}


class TestLimits:
    async def test_depth_limit_rejects_seventh_level(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "gi-depth@x.com")
        goal = await _create_goal(client, headers)
        parent_id: str | None = None
        for level in range(6):
            created = await _create_item(
                client, headers, goal["id"], name=f"L{level}", parent_id=parent_id
            )
            assert created["depth"] == level + 1
            parent_id = created["id"]

        resp = await client.post(
            f"/goals/{goal['id']}/items",
            json={"name": "L6", "parent_id": parent_id},
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "GOAL_ITEM_DEPTH_EXCEEDED"}

    async def test_items_limit_is_per_goal(self, make_client: Any) -> None:
        client: AsyncClient = await make_client(goal_items_max_per_goal=2)
        headers, _ = await _register_and_login(client, "gi-limit@x.com")
        first = await _create_goal(client, headers, name="first")
        second = await _create_goal(client, headers, name="second")
        for index in range(2):
            await _create_item(client, headers, first["id"], name=f"a{index}")

        refused = await client.post(
            f"/goals/{first['id']}/items", json={"name": "a2"}, headers=headers
        )
        assert refused.status_code == 422, refused.text
        assert refused.json() == {"detail": "GOAL_ITEMS_LIMIT_EXCEEDED"}

        # The cap is PER GOAL: the other goal is unaffected.
        allowed = await client.post(
            f"/goals/{second['id']}/items", json={"name": "b0"}, headers=headers
        )
        assert allowed.status_code == 201, allowed.text


class TestMove:
    async def test_move_swaps_with_the_neighbour_and_is_a_no_op_at_the_top(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "gi-move@x.com")
        goal = await _create_goal(client, headers)
        for name in ("A", "B", "C"):
            await _create_item(client, headers, goal["id"], name=name)

        items = await _by_name(client, headers, goal["id"])
        moved = await client.patch(
            f"/goals/{goal['id']}/items/{items['B']['id']}",
            json={"move": "up"},
            headers=headers,
        )
        assert moved.status_code == 200, moved.text
        assert [item["name"] for item in await _items(client, headers, goal["id"])] == [
            "B",
            "A",
            "C",
        ]

        # Already first: idempotent, not an error — the order does not change.
        again = await client.patch(
            f"/goals/{goal['id']}/items/{items['B']['id']}",
            json={"move": "up"},
            headers=headers,
        )
        assert again.status_code == 200, again.text
        assert [item["name"] for item in await _items(client, headers, goal["id"])] == [
            "B",
            "A",
            "C",
        ]


class TestSubtreeFilter:
    async def test_grandchild_payment_is_listed_and_exported_by_its_ancestor(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "gi-filter@x.com")
        goal = await _create_goal(client, headers)
        parent = await _create_item(client, headers, goal["id"], name="P")
        child = await _create_item(
            client, headers, goal["id"], name="C", parent_id=parent["id"]
        )
        grandchild = await _create_item(
            client, headers, goal["id"], name="G", parent_id=child["id"]
        )
        tx = await _create_tx(client, headers, goal_item_id=grandchild["id"])
        await _create_tx(client, headers)  # unlinked, must not appear

        listed = await client.get(
            "/transactions", params={"goal_item_id": parent["id"]}, headers=headers
        )
        assert listed.status_code == 200, listed.text
        assert [row["id"] for row in listed.json()["items"]] == [tx["id"]]
        assert listed.json()["total"] == 1

        exported = await client.get(
            "/transactions/export",
            params={"goal_item_id": parent["id"]},
            headers=headers,
        )
        assert exported.status_code == 200, exported.text
        body = exported.text
        assert tx["id"] in body
        assert body.count("\r\n") == 2  # header + exactly the one row

        # An unknown node is a 404, never an empty list that reads as "no payments".
        missing = await client.get(
            "/transactions", params={"goal_item_id": str(uuid.uuid4())}, headers=headers
        )
        assert missing.status_code == 404, missing.text
        assert missing.json() == {"detail": "GOAL_ITEM_NOT_FOUND"}


class TestGoalPlanFields:
    async def test_single_goal_and_list_row_carry_the_same_plan_fields(
        self, client: AsyncClient
    ) -> None:
        """The plan screen reads the single GET; a drift between the two is a bug."""
        headers, _ = await _register_and_login(client, "gi-parity@x.com")
        await _set_base_currency(client, headers, "USD")
        goal = await _create_goal(client, headers, target_minor=90_000)
        item = await _create_item(
            client, headers, goal["id"], name="A", amount_minor=40_000
        )
        await _create_tx(
            client,
            headers,
            currency="USD",
            amount_minor=15_000,
            goal_item_id=item["id"],
        )

        single = await _read_goal(client, headers, goal["id"])
        listed = await client.get("/goals", headers=headers)
        assert listed.status_code == 200, listed.text
        row = next(g for g in listed.json()["items"] if g["id"] == goal["id"])

        assert single == row
        assert single["goal_currency"] == "USD"
        # 40000 bottom-up - 15000 paid - 0 saved = 25000.
        assert single["remaining_to_find_minor"] == 25_000


class TestFileCounters:
    async def test_a_child_file_counts_once_own_and_once_for_the_subtree(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Two counters, two questions (PM Q1) — the row vs the delete warning.

        The file ROW is inserted directly: file routes land in subtask 3, and the
        two counters are already contract for the tree response.
        """
        headers, user_id = await _register_and_login(client, "gi-files@x.com")
        goal = await _create_goal(client, headers)
        parent = await _create_item(client, headers, goal["id"], name="P")
        child = await _create_item(
            client, headers, goal["id"], name="C", parent_id=parent["id"]
        )
        db_session.add(
            GoalItemFile(
                goal_item_id=uuid.UUID(child["id"]),
                user_id=user_id,
                storage_path=f"{user_id}/goal-items/{uuid.uuid4()}.jpg",
            )
        )
        await db_session.commit()

        items = await _by_name(client, headers, goal["id"])

        assert (items["C"]["files_count"], items["C"]["subtree_files_count"]) == (1, 1)
        assert (items["P"]["files_count"], items["P"]["subtree_files_count"]) == (0, 1)
