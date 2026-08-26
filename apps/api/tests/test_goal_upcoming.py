"""GET /goals/upcoming — reminders and the window (goal-planner §6).

The closed list of `.tasks/goal-planner/plan.md` §2: what a stored reminder INTENT
means when the deadline moves, which of the two dates decides membership, and that
an archived goal takes its nodes out of the window without losing anything —
plus the QA addition of the goal with NO deadline anywhere, where the two
reminder intents part ways for a second reason.

Deliberately absent (the pytest-conventions skill): `days=0`/`days=91` — a bounded
`Query`, so Pydantic alone refuses them; the route-order landmine — any 200 here
proves `/upcoming` was not read as a goal id; the 401 wall — one test per router
already exists.

Every date is relative to TODAY, because the window is: a literal calendar date
would start failing on a Tuesday next spring.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from helpers import account_for_currency
from httpx import AsyncClient

PASSWORD = "password123"

_TODAY = datetime.now(UTC).date()


def _in(days: int) -> str:
    return (_TODAY + timedelta(days=days)).isoformat()


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


async def _upcoming_rows(
    client: AsyncClient, headers: dict[str, str], **params: Any
) -> list[dict[str, Any]]:
    """The window as the wire has it — order included."""
    resp = await client.get("/goals/upcoming", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    rows: list[dict[str, Any]] = resp.json()["items"]
    return rows


async def _upcoming(
    client: AsyncClient, headers: dict[str, str], **params: Any
) -> dict[str, dict[str, Any]]:
    """The window, keyed by item name — every test here asks "which nodes, with
    what dates", and a list index would only encode the sort order twice. The one
    test that IS about the order reads the raw list instead."""
    return {
        row["item_name"]: row for row in await _upcoming_rows(client, headers, **params)
    }


class TestReminderIntent:
    async def test_days_before_reminder_rides_the_inherited_deadline(
        self, client: AsyncClient
    ) -> None:
        """Offset vs fixed date: what is stored is the INTENT, and the two differ.

        Both nodes are read from the same window in the same call, so the contrast
        is one fact and not two tests agreeing with themselves.
        """
        headers = await _register_and_login(client, "gu-intent@x.com")
        goal = await _create_goal(client, headers, deadline=_in(20))
        # No deadline of its own: the offset counts back from the GOAL's date.
        await _create_item(
            client, headers, goal["id"], name="rides", remind_days_before=3
        )
        await _create_item(client, headers, goal["id"], name="fixed", remind_on=_in(5))

        before = await _upcoming(client, headers)
        assert before["rides"]["reminder_date"] == _in(17)  # 20 - 3
        assert before["rides"]["effective_deadline"] == _in(20)
        assert before["rides"]["deadline_inherited"] is True
        assert before["fixed"]["reminder_date"] == _in(5)

        moved = await client.patch(
            f"/goals/{goal['id']}", json={"deadline": _in(25)}, headers=headers
        )
        assert moved.status_code == 200, moved.text

        after = await _upcoming(client, headers)
        # The offset followed the deadline five days out; the fixed date did not
        # move an inch, and neither node ever stored a date of its own.
        assert after["rides"]["reminder_date"] == _in(22)  # 25 - 3
        assert after["rides"]["effective_deadline"] == _in(25)
        assert after["fixed"]["reminder_date"] == _in(5)
        assert after["fixed"]["effective_deadline"] == _in(25)


class TestWindow:
    async def test_window_selects_by_reminder_then_by_deadline(
        self, client: AsyncClient
    ) -> None:
        """A reminder, once set, decides membership ALONE.

        The middle node is the point: its deadline is comfortably inside the
        window, but the user asked to be told on a day that has passed, and this
        block is not allowed to invent a second occasion to shout.
        """
        headers = await _register_and_login(client, "gu-window@x.com")
        goal = await _create_goal(client, headers, deadline=_in(10))
        await _create_item(client, headers, goal["id"], name="soon", remind_on=_in(5))
        await _create_item(client, headers, goal["id"], name="past", remind_on=_in(-5))
        await _create_item(client, headers, goal["id"], name="bare")

        ordered = await _upcoming_rows(client, headers, days=30)
        # Soonest date first, which is what the MCP tool promises its caller:
        # "soon" is due on its reminder at +5, "bare" on its deadline at +10.
        assert [row["item_name"] for row in ordered] == ["soon", "bare"]
        rows = {row["item_name"]: row for row in ordered}

        # "bare" is here on its inherited deadline, and says so with a null
        # reminder rather than a date nobody set.
        assert rows["bare"]["reminder_date"] is None
        assert rows["bare"]["effective_deadline"] == _in(10)
        # Narrowing the window is the only lever there is: it drops "soon" and
        # keeps nothing else in.
        assert set(await _upcoming(client, headers, days=3)) == set()


class TestNoDeadlineAnywhere:
    async def test_offset_without_a_deadline_is_absent_and_a_fixed_date_is_not(
        self, client: AsyncClient
    ) -> None:
        """Neither the goal nor the item carries a deadline: honestly dateless.

        The two nodes differ ONLY in which intent was stored, and they are read
        from the same window in one call. "N days before" has nothing to count back
        from, so the node has no date and stays out — it must not be rounded into
        today. A fixed date needs no anchor and comes in with a null deadline.

        That fixed date is TODAY on purpose: the near edge of the window is
        inclusive, and a ``today < due`` reading would drop this row.
        """
        headers = await _register_and_login(client, "gu-dateless@x.com")
        goal = await _create_goal(client, headers)  # no deadline anywhere
        await _create_item(
            client, headers, goal["id"], name="offset", remind_days_before=3
        )
        await _create_item(client, headers, goal["id"], name="fixed", remind_on=_in(0))

        rows = await _upcoming(client, headers)

        assert set(rows) == {"fixed"}
        assert rows["fixed"]["reminder_date"] == _in(0)
        assert rows["fixed"]["effective_deadline"] is None
        # "Inherited" is the literal reading of the column — the ITEM set no
        # deadline of its own; there simply was nothing above it to inherit.
        assert rows["fixed"]["deadline_inherited"] is True


class TestArchivedGoal:
    async def test_archived_goal_disappears_from_upcoming(
        self, client: AsyncClient
    ) -> None:
        """Archiving hides the plan from the window; unarchiving brings it back whole.

        The linked payment rides along to prove the second half: archiving deletes
        nothing, so the node returns with its "paid" — over the SUBTREE, which is
        why the parent reports the child's payment too.
        """
        headers = await _register_and_login(client, "gu-archived@x.com")
        goal = await _create_goal(client, headers, deadline=_in(10))
        parent = await _create_item(client, headers, goal["id"], name="Tokyo")
        child = await _create_item(
            client,
            headers,
            goal["id"],
            name="Hotel",
            parent_id=parent["id"],
            amount_minor=40_000,
        )
        account = await account_for_currency(client, headers, "USD")
        paid = await client.post(
            "/transactions",
            json={
                "amount_minor": 12_300,
                "kind": "expense",
                "occurred_at": _TODAY.isoformat(),
                "account_id": account,
                "goal_item_id": child["id"],
            },
            headers=headers,
        )
        assert paid.status_code == 201, paid.text

        before = await _upcoming(client, headers)
        assert before["Hotel"]["goal_name"] == "trip"
        # Ancestors from the root, this node NOT among them.
        assert before["Hotel"]["breadcrumb"] == ["Tokyo"]
        assert before["Tokyo"]["breadcrumb"] == []
        # The node's own price is in its own currency; "paid" is the goal's.
        assert (before["Hotel"]["amount_minor"], before["Hotel"]["currency"]) == (
            40_000,
            "USD",
        )
        assert before["Hotel"]["paid_minor"] == 12_300
        assert before["Hotel"]["goal_currency"] == "USD"
        assert before["Tokyo"]["paid_minor"] == 12_300  # subtree, not own links

        archived = await client.patch(
            f"/goals/{goal['id']}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text
        assert await _upcoming(client, headers) == {}

        restored = await client.patch(
            f"/goals/{goal['id']}", json={"archived": False}, headers=headers
        )
        assert restored.status_code == 200, restored.text
        after = await _upcoming(client, headers)
        assert set(after) == {"Tokyo", "Hotel"}
        assert after["Hotel"]["paid_minor"] == 12_300
        assert uuid.UUID(after["Hotel"]["item_id"]) == uuid.UUID(child["id"])
