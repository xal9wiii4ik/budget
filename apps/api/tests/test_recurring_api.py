"""/recurring CRUD + transaction attribution (plan B2, AM-7/8/9) — real Postgres.

Covers only what is unique to this router: the watermark writes that are invisible
on the wire (create stamps yesterday; unpause is a TRANSITION, never the mere
presence of ``paused: false``), the server-computed ``next_due_on`` and its
today-floor, the PATCH unit/anchor rules with their two distinct codes, the hard
DELETE that keeps history, and the server-managed attribution field.

The date math itself is NOT re-pinned here — ``tests/test_recurrence.py`` owns the
clamp and strict-after rules, and ``tests/test_recurring_jobs.py`` owns the job's
catch-up/atomicity behaviour. The tests below that call ``materialize_due`` call
it for its effect on rows this router's writes made due, not to re-test it.

Fixtures are dated relative to the real "today": the router reads the clock (the
watermark stamp and ``next_due_on`` both depend on it), so a fixed calendar date
could not exercise them.
"""

import calendar
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from helpers import account_for_currency, create_account
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.config import Settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.models import RecurringTemplate, Transaction
from budget_api.schemas.transaction import MAX_MINOR_AMOUNT
from budget_api.services.recurring_jobs import materialize_due

PASSWORD = "password123"

_TODAY = datetime.now(UTC).date()
_YESTERDAY = _TODAY - timedelta(days=1)


def _shift_month_clamped(d: date, months: int) -> date:
    """``d`` shifted by whole months, day clamped to the target month's end.

    A test-local calendar helper (the ``test_goals_api._add_months_clamped``
    precedent) so the fixtures below can name a watermark and the due dates it
    leaves pending without importing the code under test as its own oracle.
    """
    total = d.year * 12 + (d.month - 1) + months
    year, month0 = divmod(total, 12)
    month = month0 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


@pytest.fixture
async def job_sessionmaker(
    test_database_url: str,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """The sessionmaker the scheduler hands ``materialize_due`` in production.

    Mirrors ``tests/test_recurring_jobs.py``'s fixture of the same name: the job
    takes a sessionmaker (it owns a session per template), and neither the ASGI
    ``client`` nor the single-session ``db_session`` fixture can supply one.
    """
    engine = build_engine(
        Settings(database_url=test_database_url, jwt_secret="test-jwt-secret")
    )
    try:
        yield build_sessionmaker(engine)
    finally:
        await engine.dispose()


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


def _body(**overrides: Any) -> dict[str, Any]:
    """A valid monthly-template payload, overridable per arm."""
    body: dict[str, Any] = {
        "name": "Netflix",
        "amount_minor": 10_000,
        "kind": "expense",
        "interval_unit": "month",
        "day_of_month": 15,
    }
    body.update(overrides)
    return body


async def _create_template(
    client: AsyncClient, headers: dict[str, str], **overrides: Any
) -> dict[str, Any]:
    body = _body(**overrides)
    if "account_id" not in body:
        # Required since the accounts scope: the rows this template books belong to
        # an account, and its currency is stamped from that account (§4/§7).
        body["account_id"] = await account_for_currency(
            client, headers, body.get("currency")
        )
    resp = await client.post("/recurring", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _create_category(
    client: AsyncClient, headers: dict[str, str], name: str
) -> str:
    resp = await client.post(
        "/categories", json={"name": name, "kind": "expense"}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def _watermark(session: AsyncSession, template_id: str) -> date:
    """The stored ``last_materialized_on`` — deliberately off the wire (D10).

    Selected as a COLUMN, not via ``session.get``, so the identity map can never
    hand back a value this session read before the request under test ran.
    """
    stored = await session.scalar(
        select(RecurringTemplate.last_materialized_on).where(
            RecurringTemplate.id == uuid.UUID(template_id)
        )
    )
    assert stored is not None
    return stored


async def _rewind_watermark(session: AsyncSession, template_id: str, to: date) -> None:
    """Put a template in arrears — the only way to reach a pending catch-up."""
    await session.execute(
        update(RecurringTemplate)
        .where(RecurringTemplate.id == uuid.UUID(template_id))
        .values(last_materialized_on=to)
    )
    await session.commit()


async def _materialized(
    session: AsyncSession, template_id: str | None = None
) -> list[Transaction]:
    stmt = select(Transaction).order_by(Transaction.occurred_at)
    if template_id is not None:
        stmt = stmt.where(Transaction.recurring_template_id == uuid.UUID(template_id))
    rows = await session.scalars(stmt)
    return list(rows.all())


class TestCreate:
    async def test_create_defaults_and_projection(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """B2-1 + AM-8: the base-currency stamp, the hidden watermark, next_due_on."""
        headers = await _register_and_login(client, "rec-create@x.com")

        body = await _create_template(client, headers, day_of_month=_TODAY.day)

        assert body["currency"] == "RUB"  # profile base, stamped server-side
        assert body["paused"] is False
        # The watermark is machinery, never a client's business (D10).
        assert "last_materialized_on" not in body
        # Created today, not yet materialized → today is still ahead.
        assert body["next_due_on"] == _TODAY.isoformat()
        assert await _watermark(db_session, body["id"]) == _YESTERDAY

        # AM-8: an explicit currency is stored as sent, never re-stamped to base.
        explicit = await _create_template(client, headers, currency="USD")

        assert explicit["currency"] == "USD"
        stored = await db_session.scalar(
            select(RecurringTemplate.currency).where(
                RecurringTemplate.id == uuid.UUID(explicit["id"])
            )
        )
        assert stored == "USD"

    @pytest.mark.parametrize(
        ("body", "expected_status"),
        [
            (_body(day_of_month=None), 422),
            (_body(weekday=3), 422),
            (_body(interval_unit="week", day_of_month=None), 422),
            (_body(interval_unit="week", day_of_month=None, weekday=7), 422),
            (_body(day_of_month=0), 422),
            (_body(day_of_month=32), 422),
            (_body(amount_minor=0), 422),
            (_body(amount_minor=MAX_MINOR_AMOUNT + 1), 422),
            (_body(name="   "), 422),
            # Accept arms: without them every rejection above would also pass
            # against a route that 422s everything.
            (_body(amount_minor=MAX_MINOR_AMOUNT), 201),
            (_body(interval_unit="week", day_of_month=None, weekday=6), 201),
        ],
        ids=[
            "month-without-day-of-month",
            "month-with-weekday",
            "week-without-weekday",
            "weekday-out-of-range",
            "day-of-month-zero",
            "day-of-month-32",
            "amount-zero",
            "amount-over-max",
            "blank-name",
            "amount-at-max",
            "week-with-weekday-6",
        ],
    )
    async def test_create_validation_matrix(
        self,
        client: AsyncClient,
        body: dict[str, Any],
        expected_status: int,
    ) -> None:
        """B2-2: the anchor/bounds contract, rejections AND their accept contrasts."""
        headers = await _register_and_login(client, "rec-validate@x.com")
        body = {**body, "account_id": await account_for_currency(client, headers)}

        resp = await client.post("/recurring", json=body, headers=headers)

        assert resp.status_code == expected_status, resp.text

    async def test_create_category_refs(self, client: AsyncClient) -> None:
        """B2-3: a body category ref is a 422, and foreign == missing (no-oracle)."""
        headers = await _register_and_login(client, "rec-cat@x.com")
        other = await _register_and_login(client, "rec-cat-other@x.com")
        own = await _create_category(client, headers, "Subscriptions")
        archived = await _create_category(client, headers, "Old")
        patch = await client.patch(
            f"/categories/{archived}", json={"archived": True}, headers=headers
        )
        assert patch.status_code == 200, patch.text
        foreign = await _create_category(client, other, "Theirs")

        account = await account_for_currency(client, headers)

        missing_resp = await client.post(
            "/recurring",
            json=_body(category_id=str(uuid.uuid4()), account_id=account),
            headers=headers,
        )
        foreign_resp = await client.post(
            "/recurring",
            json=_body(category_id=foreign, account_id=account),
            headers=headers,
        )
        archived_resp = await client.post(
            "/recurring",
            json=_body(category_id=archived, account_id=account),
            headers=headers,
        )
        own_resp = await client.post(
            "/recurring",
            json=_body(category_id=own, account_id=account),
            headers=headers,
        )

        assert missing_resp.status_code == 422
        assert missing_resp.json()["detail"] == "CATEGORY_NOT_FOUND"
        # Byte-identical to the missing one: a foreign id must not confirm it exists.
        assert foreign_resp.status_code == 422
        assert foreign_resp.json() == missing_resp.json()
        assert archived_resp.status_code == 422
        assert archived_resp.json()["detail"] == "CATEGORY_ARCHIVED"
        assert own_resp.status_code == 201, own_resp.text
        assert own_resp.json()["category_id"] == own


class TestList:
    async def test_list_is_own_only_and_includes_paused_and_ended(
        self, client: AsyncClient
    ) -> None:
        """B2-4: the list IS the management screen — nothing live is filtered out."""
        headers = await _register_and_login(client, "rec-list@x.com")
        other = await _register_and_login(client, "rec-list-other@x.com")
        active = await _create_template(client, headers, name="active")
        paused = await _create_template(client, headers, name="paused", paused=True)
        ended = await _create_template(
            client,
            headers,
            name="ended",
            end_date=(_TODAY - timedelta(days=30)).isoformat(),
        )
        theirs = await _create_template(client, other, name="theirs")

        resp = await client.get("/recurring", headers=headers)

        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        # Creation order (created_at, id) — a paused row and an ended row are both
        # still listed, because pausing/ending is exactly what a user comes here
        # to undo.
        assert [item["id"] for item in items] == [
            active["id"],
            paused["id"],
            ended["id"],
        ]
        assert theirs["id"] not in {item["id"] for item in items}
        assert items[1]["next_due_on"] is None  # paused
        assert items[2]["next_due_on"] is None  # ended in the past


class TestPatch:
    async def test_patch_partial_and_required_nulls(self, client: AsyncClient) -> None:
        """B2-5: an amount-only edit changes exactly one field; nulls split two ways."""
        headers = await _register_and_login(client, "rec-patch@x.com")
        created = await _create_template(
            client,
            headers,
            name="Gym",
            merchant="gym",
            note="membership",
            end_date=(_TODAY + timedelta(days=365)).isoformat(),
        )

        partial = await client.patch(
            f"/recurring/{created['id']}",
            json={"amount_minor": 55_555},
            headers=headers,
        )

        assert partial.status_code == 200, partial.text
        body = partial.json()
        assert body["amount_minor"] == 55_555
        assert {k: v for k, v in body.items() if k != "amount_minor"} == {
            k: v for k, v in created.items() if k != "amount_minor"
        }

        # NOT NULL columns: an explicit null is a rejection with its own code,
        # never a silent no-op and never a 500 from the DB.
        for field, code in (
            ("name", "NAME_REQUIRED"),
            ("amount_minor", "AMOUNT_REQUIRED"),
            ("kind", "KIND_REQUIRED"),
            ("account_id", "ACCOUNT_REQUIRED"),
            ("currency", "CURRENCY_REQUIRED"),
            ("interval_unit", "INTERVAL_UNIT_REQUIRED"),
            ("paused", "PAUSED_REQUIRED"),
        ):
            resp = await client.patch(
                f"/recurring/{created['id']}", json={field: None}, headers=headers
            )

            assert resp.status_code == 422, f"{field}: {resp.text}"
            assert resp.json()["detail"] == code

        # The nullable-clears contrast: end_date IS clearable by an explicit null.
        cleared = await client.patch(
            f"/recurring/{created['id']}", json={"end_date": None}, headers=headers
        )

        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["end_date"] is None

    async def test_patch_unit_switch_rules(self, client: AsyncClient) -> None:
        """B2-6: a unit switch carries its anchor, and the two failures differ."""
        headers = await _register_and_login(client, "rec-anchor@x.com")
        switched = await _create_template(client, headers, name="switch")
        anchorless = await _create_template(client, headers, name="anchorless")
        weekly = await _create_template(
            client,
            headers,
            name="weekly",
            interval_unit="week",
            day_of_month=None,
            weekday=1,
        )

        ok = await client.patch(
            f"/recurring/{switched['id']}",
            json={"interval_unit": "week", "weekday": 2},
            headers=headers,
        )
        missing = await client.patch(
            f"/recurring/{anchorless['id']}",
            json={"interval_unit": "week"},
            headers=headers,
        )
        mismatch = await client.patch(
            f"/recurring/{anchorless['id']}", json={"weekday": 3}, headers=headers
        )
        # The mirror of `mismatch` on the other branch: a monthly anchor sent to a
        # template that stays weekly.
        week_mismatch = await client.patch(
            f"/recurring/{weekly['id']}", json={"day_of_month": 10}, headers=headers
        )
        # ...and the mirror of `ok`: the week->month switch, carrying its anchor.
        to_month = await client.patch(
            f"/recurring/{weekly['id']}",
            json={"interval_unit": "month", "day_of_month": 5},
            headers=headers,
        )

        assert ok.status_code == 200, ok.text
        assert ok.json()["weekday"] == 2
        # The stored monthly anchor is cleared server-side: nothing the client
        # sent is discarded, and an inconsistent pair is unrepresentable anyway.
        assert ok.json()["day_of_month"] is None
        assert missing.status_code == 422
        assert missing.json()["detail"] == "ANCHOR_REQUIRED"
        # Explicitly sent and unusable — a different mistake from forgetting one.
        assert mismatch.status_code == 422
        assert mismatch.json()["detail"] == "ANCHOR_MISMATCH"
        assert week_mismatch.status_code == 422
        assert week_mismatch.json()["detail"] == "ANCHOR_MISMATCH"
        assert to_month.status_code == 200, to_month.text
        assert to_month.json()["day_of_month"] == 5
        # The stored weekly anchor is cleared server-side, same as `ok`'s.
        assert to_month.json()["weekday"] is None


class TestPatchAccountMove:
    """B3: a standing order can be moved between accounts, and the move restamps.

    The account is what the template's currency is a stamp OF (§4/OQ-1), so the
    move is the only write on this router that changes ``currency`` — every arm
    below exists because getting that pair wrong books money into a balance it
    does not belong to.
    """

    async def test_move_restamps_currency_from_the_target_account(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "rec-move@x.com")
        template = await _create_template(client, headers)  # RUB account
        usd = await create_account(client, headers, currency="USD", name="USD card")

        # The echo goes FIRST, while the template is still on the RUB account:
        # that is the only moment the "currency belongs to the TARGET account"
        # rule is under test. Sent after the move, this arm would pass even if
        # the gate compared against the template's own currency — the bug the
        # stale-echo test below exists to catch.
        echoed = await client.patch(
            f"/recurring/{template['id']}",
            json={"account_id": str(usd["id"]), "currency": "USD"},
            headers=headers,
        )

        assert echoed.status_code == 200, echoed.text
        assert echoed.json()["account_id"] == str(usd["id"])
        # The stamp follows the account: leaving RUB here would describe the
        # template's own amount in a currency its account cannot hold.
        assert echoed.json()["currency"] == "USD"

        # And the move without an echo restamps just the same.
        rub = await create_account(client, headers, currency="RUB", name="RUB card")
        moved = await client.patch(
            f"/recurring/{template['id']}",
            json={"account_id": str(rub["id"])},
            headers=headers,
        )

        assert moved.status_code == 200, moved.text
        assert moved.json()["currency"] == "RUB"

    async def test_move_rejects_the_outgoing_currency_echo(
        self, client: AsyncClient
    ) -> None:
        """A web form that resends the currently displayed currency must not win.

        Applying the move and ignoring the stale echo would leave a template whose
        stamp disagrees with its own account; applying the echo would leave the
        opposite. Both are refused as one payload.
        """
        headers = await _register_and_login(client, "rec-move-echo@x.com")
        template = await _create_template(client, headers)  # RUB
        usd = await create_account(client, headers, currency="USD", name="USD card")

        resp = await client.patch(
            f"/recurring/{template['id']}",
            json={"account_id": str(usd["id"]), "currency": "RUB", "name": "Moved"},
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "ACCOUNT_CURRENCY_MISMATCH"}
        after = await client.get("/recurring", headers=headers)
        assert after.json()["items"][0] == template  # nothing half-applied

    async def test_move_target_refs_are_refused(self, client: AsyncClient) -> None:
        """Foreign == missing (404, byte-identical); archived is its own 422."""
        headers = await _register_and_login(client, "rec-move-refs@x.com")
        other = await _register_and_login(client, "rec-move-other@x.com")
        template = await _create_template(client, headers)
        foreign = await create_account(client, other, name="Theirs")
        archived = await create_account(client, headers, name="Old card")
        closed = await client.patch(
            f"/accounts/{archived['id']}", json={"archived": True}, headers=headers
        )
        assert closed.status_code == 200, closed.text

        missing_resp = await client.patch(
            f"/recurring/{template['id']}",
            json={"account_id": str(uuid.uuid4())},
            headers=headers,
        )
        foreign_resp = await client.patch(
            f"/recurring/{template['id']}",
            json={"account_id": str(foreign["id"])},
            headers=headers,
        )
        archived_resp = await client.patch(
            f"/recurring/{template['id']}",
            json={"account_id": str(archived["id"])},
            headers=headers,
        )

        assert missing_resp.status_code == 404
        assert missing_resp.json() == {"detail": "ACCOUNT_NOT_FOUND"}
        # No-oracle: someone else's live account answers exactly like a gone one.
        assert foreign_resp.status_code == 404
        assert foreign_resp.json() == missing_resp.json()
        assert archived_resp.status_code == 422
        assert archived_resp.json() == {"detail": "ACCOUNT_ARCHIVED"}
        after = await client.get("/recurring", headers=headers)
        assert after.json()["items"][0] == template  # no refusal moved anything

    async def test_moved_template_materializes_onto_the_new_account(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        job_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        """The move is only real if the JOB honours it — it books tpl.account_id.

        Also pins that the move leaves the watermark alone: today is still due
        after the PATCH, so the occurrence the template was created for is booked
        once, onto the new account, in the new currency.
        """
        headers = await _register_and_login(client, "rec-move-job@x.com")
        template = await _create_template(client, headers, day_of_month=_TODAY.day)
        usd = await create_account(client, headers, currency="USD", name="USD card")
        moved = await client.patch(
            f"/recurring/{template['id']}",
            json={"account_id": str(usd["id"])},
            headers=headers,
        )
        assert moved.status_code == 200, moved.text

        await materialize_due(job_sessionmaker, today=_TODAY)

        rows = await _materialized(db_session, template["id"])
        assert [
            (row.occurred_at, str(row.account_id), row.currency) for row in rows
        ] == [(_TODAY, str(usd["id"]), "USD")]


class TestNextDueOn:
    async def test_next_due_on_semantics(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """B2-7 + AM-9: a promise about the future, floored at today, ended → null."""
        headers = await _register_and_login(client, "rec-next@x.com")

        due_today = await _create_template(client, headers, day_of_month=_TODAY.day)
        paused = await _create_template(
            client, headers, day_of_month=_TODAY.day, paused=True
        )
        ended = await _create_template(
            client,
            headers,
            day_of_month=_TODAY.day,
            end_date=(_TODAY - timedelta(days=1)).isoformat(),
        )
        ending_today = await _create_template(
            client,
            headers,
            day_of_month=_TODAY.day,
            end_date=_TODAY.isoformat(),
        )

        assert due_today["next_due_on"] == _TODAY.isoformat()
        assert paused["next_due_on"] is None
        assert ended["next_due_on"] is None
        # end_date is INCLUSIVE: a template ending exactly on its next due date
        # still owes that date (the boundary the null arm above would swallow).
        assert ending_today["next_due_on"] == _TODAY.isoformat()

        # AM-9 (OQ-1): a template in arrears renders the date the job will book
        # NEXT, never the pending past one.
        arrears = _shift_month_clamped(_TODAY, -2)
        await _rewind_watermark(db_session, due_today["id"], arrears)

        listed = await client.get("/recurring", headers=headers)

        assert listed.status_code == 200, listed.text
        item = next(
            row for row in listed.json()["items"] if row["id"] == due_today["id"]
        )
        assert item["next_due_on"] == _TODAY.isoformat()
        assert item["next_due_on"] > arrears.isoformat()


class TestPauseSemantics:
    async def test_unpause_makes_the_unpause_day_live_but_never_backfills(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        job_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        """B2-8 (SL-A): the unpause DAY is booked, the skipped weeks stay skipped."""
        headers = await _register_and_login(client, "rec-unpause@x.com")
        template = await _create_template(
            client,
            headers,
            interval_unit="week",
            day_of_month=None,
            weekday=_TODAY.weekday(),
            paused=True,
        )
        # Paused three weeks ago: today, today-7 and today-14 are all due dates.
        await _rewind_watermark(db_session, template["id"], _TODAY - timedelta(days=21))

        unpaused = await client.patch(
            f"/recurring/{template['id']}", json={"paused": False}, headers=headers
        )
        assert unpaused.status_code == 200, unpaused.text
        await materialize_due(job_sessionmaker, today=_TODAY)

        rows = await _materialized(db_session, template["id"])
        assert [row.occurred_at for row in rows] == [_TODAY]

    async def test_same_day_pause_unpause_does_not_duplicate(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        job_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        """B2-9 (SL-A's max()): a pause/unpause cycle cannot rewind the watermark."""
        headers = await _register_and_login(client, "rec-cycle@x.com")
        template = await _create_template(
            client,
            headers,
            interval_unit="week",
            day_of_month=None,
            weekday=_TODAY.weekday(),
        )
        await materialize_due(job_sessionmaker, today=_TODAY)
        assert await _watermark(db_session, template["id"]) == _TODAY

        for paused in (True, False):
            resp = await client.patch(
                f"/recurring/{template['id']}",
                json={"paused": paused},
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
        await materialize_due(job_sessionmaker, today=_TODAY)

        # A bare `= today - 1` on unpause would rewind past today's occurrence and
        # book it a second time.
        rows = await _materialized(db_session, template["id"])
        assert [row.occurred_at for row in rows] == [_TODAY]
        assert await _watermark(db_session, template["id"]) == _TODAY

    async def test_non_transition_paused_false_keeps_pending_dates(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        job_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        """AM-7 (GAP-7): the web edit form sends ``paused: false`` on every save.

        A transition-blind unpause would treat that as an unpause, raise the
        watermark to yesterday, and silently swallow every date the job still owes
        this never-paused template.
        """
        headers = await _register_and_login(client, "rec-nontransition@x.com")
        template = await _create_template(client, headers, day_of_month=_TODAY.day)
        arrears = _shift_month_clamped(_TODAY, -2)
        await _rewind_watermark(db_session, template["id"], arrears)

        edited = await client.patch(
            f"/recurring/{template['id']}",
            json={"amount_minor": 12_345, "paused": False},
            headers=headers,
        )

        assert edited.status_code == 200, edited.text
        assert edited.json()["amount_minor"] == 12_345
        assert await _watermark(db_session, template["id"]) == arrears

        await materialize_due(job_sessionmaker, today=_TODAY)

        rows = await _materialized(db_session, template["id"])
        assert [row.occurred_at for row in rows] == [
            _shift_month_clamped(_TODAY, -1),
            _TODAY,
        ]


class TestDelete:
    async def test_delete_keeps_history_and_drops_attribution(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        job_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        """B2-10 (SL-C): the money survives a hard delete, the attribution does not."""
        headers = await _register_and_login(client, "rec-delete@x.com")
        other = await _register_and_login(client, "rec-delete-other@x.com")
        theirs = await _create_template(client, other, name="theirs")
        template = await _create_template(
            client, headers, amount_minor=77_700, day_of_month=_TODAY.day
        )
        await materialize_due(job_sessionmaker, today=_TODAY)
        booked = await client.get("/transactions", headers=headers)
        assert booked.status_code == 200, booked.text
        assert len(booked.json()["items"]) == 1

        deleted = await client.delete(f"/recurring/{template['id']}", headers=headers)

        assert deleted.status_code == 204, deleted.text
        survivor = await client.get("/transactions", headers=headers)
        assert survivor.status_code == 200, survivor.text
        rows = survivor.json()["items"]
        assert len(rows) == 1
        assert rows[0]["amount_minor"] == 77_700
        assert rows[0]["currency"] == "RUB"
        assert rows[0]["occurred_at"] == _TODAY.isoformat()
        # ON DELETE SET NULL: the row keeps its money and loses its badge.
        assert rows[0]["recurring_template_id"] is None
        assert await _materialized(db_session, template["id"]) == []

        again = await client.delete(f"/recurring/{template['id']}", headers=headers)
        foreign = await client.delete(f"/recurring/{theirs['id']}", headers=headers)

        assert again.status_code == 404
        assert again.json()["detail"] == "RECURRING_TEMPLATE_NOT_FOUND"
        # No-oracle: someone else's live template answers exactly like a gone one.
        assert foreign.status_code == 404
        assert foreign.json() == again.json()


class TestAttribution:
    async def test_transaction_read_carries_attribution(
        self,
        client: AsyncClient,
        job_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        """B2-11: the badge's data — set on materialized rows, null on manual ones."""
        headers = await _register_and_login(client, "rec-attr@x.com")
        template = await _create_template(client, headers, day_of_month=_TODAY.day)
        await materialize_due(job_sessionmaker, today=_TODAY)
        manual = await client.post(
            "/transactions",
            json={
                "amount_minor": 500,
                "kind": "expense",
                "account_id": await account_for_currency(client, headers),
                "occurred_at": _TODAY.isoformat(),
            },
            headers=headers,
        )
        assert manual.status_code == 201, manual.text

        listed = await client.get("/transactions", headers=headers)

        assert listed.status_code == 200, listed.text
        by_id = {row["id"]: row for row in listed.json()["items"]}
        assert by_id[manual.json()["id"]]["recurring_template_id"] is None
        materialized_id = next(
            tx_id
            for tx_id, row in by_id.items()
            if row["recurring_template_id"] is not None
        )
        assert by_id[materialized_id]["recurring_template_id"] == template["id"]

        edited = await client.patch(
            f"/transactions/{materialized_id}",
            json={"note": "edited"},
            headers=headers,
        )

        # An edit of a materialized row must not orphan it from its template.
        assert edited.status_code == 200, edited.text
        assert edited.json()["recurring_template_id"] == template["id"]

    async def test_client_supplied_template_id_is_ignored(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        job_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        """B2-12 (SL-B): attribution is server-managed — ignored on write, not obeyed.

        The house DTOs are ``extra="ignore"`` (no schema sets ``extra="forbid"``),
        so the contract here is "a sent value has no effect", which is what a web
        client round-tripping a TransactionRead into a PATCH body would rely on.
        """
        headers = await _register_and_login(client, "rec-forge@x.com")
        template = await _create_template(client, headers, day_of_month=_TODAY.day)
        decoy = await _create_template(client, headers, name="decoy")
        await materialize_due(job_sessionmaker, today=_TODAY)
        rows = await _materialized(db_session, template["id"])
        assert len(rows) == 1
        materialized_id = rows[0].id

        forged = await client.post(
            "/transactions",
            json={
                "amount_minor": 500,
                "kind": "expense",
                "account_id": await account_for_currency(client, headers),
                "occurred_at": _TODAY.isoformat(),
                "recurring_template_id": template["id"],
            },
            headers=headers,
        )
        repointed = await client.patch(
            f"/transactions/{materialized_id}",
            json={"recurring_template_id": decoy["id"]},
            headers=headers,
        )

        assert forged.status_code == 201, forged.text
        assert forged.json()["recurring_template_id"] is None
        assert repointed.status_code == 200, repointed.text
        assert repointed.json()["recurring_template_id"] == template["id"]
        stored = await db_session.scalars(
            select(Transaction.recurring_template_id).where(
                Transaction.id.in_([uuid.UUID(forged.json()["id"]), materialized_id])
            )
        )
        assert sorted(str(value) for value in stored.all() if value is not None) == [
            template["id"]
        ]


class TestTransferKind:
    async def test_transfer_kind_is_refused_on_both_writes(
        self, client: AsyncClient
    ) -> None:
        """C-2: recurring transfers are unsupported (§7) — a 422, never a 500.

        ``kind`` is typed ``TransactionKind`` here on purpose (a narrower enum
        would rename a generated contract component), so ``transfer`` IS
        representable on the wire and reaches the router; the template's CHECK is
        still ``('expense','income')``, so without this guard the commit would be
        an IntegrityError 500. PATCH needs the same refusal because it can rewrite
        ``kind`` on a template that was created as an expense.
        """
        headers = await _register_and_login(client, "rec-transfer@x.com")
        account = await account_for_currency(client, headers)

        created = await client.post(
            "/recurring",
            json=_body(kind="transfer", account_id=account),
            headers=headers,
        )

        assert created.status_code == 422, created.text
        assert created.json() == {"detail": "RECURRING_TRANSFER_UNSUPPORTED"}

        template = await _create_template(client, headers, account_id=account)
        morphed = await client.patch(
            f"/recurring/{template['id']}", json={"kind": "transfer"}, headers=headers
        )

        assert morphed.status_code == 422, morphed.text
        assert morphed.json() == {"detail": "RECURRING_TRANSFER_UNSUPPORTED"}
        listed = await client.get("/recurring", headers=headers)
        assert listed.json()["items"][0]["kind"] == "expense"  # nothing half-applied


class TestAuth:
    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("POST", "/recurring"),
            ("GET", "/recurring"),
            ("PATCH", f"/recurring/{uuid.uuid4()}"),
            ("DELETE", f"/recurring/{uuid.uuid4()}"),
        ],
        ids=["post", "get", "patch", "delete"],
    )
    async def test_recurring_requires_auth(
        self, client: AsyncClient, method: str, path: str
    ) -> None:
        """B2-13: one unauthenticated call per method on the new router."""
        resp = await client.request(method, path, json=_body())

        assert resp.status_code == 401, resp.text
