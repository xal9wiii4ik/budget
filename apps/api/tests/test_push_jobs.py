"""The daily push digest against a REAL Postgres, the push service faked at its seam.

``send_daily_reminders`` is called directly with a fixed ``today`` and a
``FakePushSender`` (helpers.py) — no app, no scheduler (the wiring lives in
``test_scheduler_wiring.py``). Rows are seeded straight through the ORM: the job
reads three families the API already serves, and what is under test is the job's
claim, its fan-out and its bookkeeping, not those routes.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import date, timedelta
from decimal import Decimal

import pytest
from helpers import FakePushSender, add_account
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.config import Settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.models import (
    Deposit,
    Goal,
    GoalItem,
    Profile,
    PushReminderSend,
    PushSubscription,
    RecurringTemplate,
)
from budget_api.services.push_jobs import send_daily_reminders
from budget_api.services.push_sender import SendOutcome

#: A fixed run date: the window is [TODAY, TOMORROW] with horizon 1.
TODAY = date(2026, 8, 5)
TOMORROW = TODAY + timedelta(days=1)

#: Amounts whose digit strings would be unmistakable in a notification text.
GOAL_ITEM_AMOUNT = 123456
CHARGE_AMOUNT = 987654
DEPOSIT_BALANCE = 246802


@pytest.fixture
async def job_sessionmaker(
    test_database_url: str,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """The sessionmaker the scheduler job is handed in production."""
    engine = build_engine(
        Settings(database_url=test_database_url, jwt_secret="test-jwt-secret")
    )
    try:
        yield build_sessionmaker(engine)
    finally:
        await engine.dispose()


async def _run(
    sessionmaker: async_sessionmaker[AsyncSession], sender: FakePushSender
) -> None:
    await send_daily_reminders(sessionmaker, sender=sender, horizon_days=1, today=TODAY)


async def _user(
    sessionmaker: async_sessionmaker[AsyncSession],
    email: str,
    *,
    language: str | None = None,
    active: bool = True,
) -> uuid.UUID:
    """A bare user via raw SQL (no register hook); a profile only with a language."""
    user_id = uuid.uuid4()
    async with sessionmaker() as session:
        await session.execute(
            text(
                "INSERT INTO users (id, email, hashed_password, is_active) "
                "VALUES (:id, :email, 'x', :active)"
            ),
            {"id": user_id, "email": email, "active": active},
        )
        if language is not None:
            session.add(
                Profile(user_id=user_id, base_currency="RUB", language=language)
            )
        await session.commit()
    return user_id


async def _device(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    name: str,
    *,
    lang: str = "ru",
) -> str:
    endpoint = f"https://push.example.com/send/{name}"
    async with sessionmaker() as session:
        session.add(
            PushSubscription(
                user_id=user_id,
                endpoint=endpoint,
                p256dh="BKey",
                auth="auth",
                lang=lang,
            )
        )
        await session.commit()
    return endpoint


async def _goal_item(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    *,
    goal_name: str = "Vacation",
    item_name: str = "Tickets",
    remind_on: date = TODAY,
) -> uuid.UUID:
    async with sessionmaker() as session:
        goal = Goal(
            user_id=user_id,
            name=goal_name,
            target_minor=GOAL_ITEM_AMOUNT * 2,
            currency="RUB",
            priority=0,
        )
        session.add(goal)
        await session.flush()
        session.add(
            GoalItem(
                goal_id=goal.id,
                name=item_name,
                amount_minor=GOAL_ITEM_AMOUNT,
                currency="RUB",
                remind_on=remind_on,
                sort_order=0,
            )
        )
        await session.commit()
        return goal.id


async def _charge(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    name: str,
    *,
    day_of_month: int,
) -> None:
    """A monthly template already booked THROUGH today (the 00:30 run happened)."""
    async with sessionmaker() as session:
        account = await add_account(session, user_id)
        session.add(
            RecurringTemplate(
                user_id=user_id,
                account_id=account.id,
                name=name,
                amount_minor=CHARGE_AMOUNT,
                kind="expense",
                currency="RUB",
                interval_unit="month",
                day_of_month=day_of_month,
                last_materialized_on=TODAY,
            )
        )
        await session.commit()


async def _deposit(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    name: str,
    *,
    term_end: date,
) -> None:
    async with sessionmaker() as session:
        ledger = await add_account(
            session,
            user_id,
            name=f"{name} ledger",
            type="deposit",
            starting_balance_minor=DEPOSIT_BALANCE,
        )
        session.add(
            Deposit(
                user_id=user_id,
                account_id=ledger.id,
                name=name,
                rate_percent=Decimal("12.3456"),
                capitalization="none",
                opened_on=TODAY - timedelta(days=90),
                term_end=term_end,
            )
        )
        await session.commit()


async def _claims(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> list[PushReminderSend]:
    async with sessionmaker() as session:
        return list((await session.scalars(select(PushReminderSend))).all())


async def _endpoints(sessionmaker: async_sessionmaker[AsyncSession]) -> list[str]:
    async with sessionmaker() as session:
        return sorted((await session.scalars(select(PushSubscription.endpoint))).all())


def _counters(claim: PushReminderSend) -> tuple[int, int, int, int, int]:
    return (
        claim.goal_items,
        claim.charges,
        claim.deposits,
        claim.delivered,
        claim.removed,
    )


class TestDailyReminders:
    async def test_concurrent_and_repeated_runs_push_each_device_once(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """The (user_id, sent_on) claim: two runs at once, then a rerun.

        The ``gather`` arm MAY overlap at the PK lock (both INSERTs in flight), but
        the assertions hold either way; the rerun arm is the deterministic one.
        """
        user_id = await _user(job_sessionmaker, "push-race@example.com")
        phone = await _device(job_sessionmaker, user_id, "phone")
        laptop = await _device(job_sessionmaker, user_id, "laptop")
        await _goal_item(job_sessionmaker, user_id)
        sender = FakePushSender()

        await asyncio.gather(
            _run(job_sessionmaker, sender), _run(job_sessionmaker, sender)
        )
        await _run(job_sessionmaker, sender)

        assert sorted(endpoint for endpoint, _ in sender.sent) == sorted(
            [phone, laptop]
        )
        assert len(await _claims(job_sessionmaker)) == 1

    async def test_gone_device_is_deleted_failed_one_kept_and_outcomes_counted(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _user(job_sessionmaker, "push-outcomes@example.com")
        ok = await _device(job_sessionmaker, user_id, "ok")
        gone = await _device(job_sessionmaker, user_id, "gone")
        failed = await _device(job_sessionmaker, user_id, "failed")
        await _goal_item(job_sessionmaker, user_id)
        sender = FakePushSender(
            outcomes={gone: SendOutcome.gone, failed: SendOutcome.failed}
        )

        await _run(job_sessionmaker, sender)

        assert await _endpoints(job_sessionmaker) == sorted([ok, failed])
        (claim,) = await _claims(job_sessionmaker)
        assert _counters(claim) == (1, 0, 0, 1, 1)

    async def test_profile_language_wins_and_device_language_fills_in_when_unset(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        set_profile = await _user(
            job_sessionmaker, "push-lang-set@example.com", language="ru"
        )
        overridden = await _device(job_sessionmaker, set_profile, "a-en", lang="en")
        await _goal_item(job_sessionmaker, set_profile)
        no_profile = await _user(job_sessionmaker, "push-lang-null@example.com")
        english = await _device(job_sessionmaker, no_profile, "b-en", lang="en")
        russian = await _device(job_sessionmaker, no_profile, "b-ru", lang="ru")
        await _goal_item(job_sessionmaker, no_profile)
        sender = FakePushSender()

        await _run(job_sessionmaker, sender)

        titles = {endpoint: payload["title"] for endpoint, payload in sender.sent}
        assert titles == {overridden: "Скоро", english: "Coming up", russian: "Скоро"}

    async def test_digest_names_every_family_without_any_amount(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _user(job_sessionmaker, "push-privacy@example.com")
        phone = await _device(job_sessionmaker, user_id, "phone")
        await _goal_item(job_sessionmaker, user_id, goal_name="Car", item_name="Tyres")
        await _charge(job_sessionmaker, user_id, "Rent", day_of_month=TOMORROW.day)
        # Booked by today's 00:30 run already: real money that has moved, NOT news.
        await _charge(job_sessionmaker, user_id, "Booked", day_of_month=TODAY.day)
        await _deposit(job_sessionmaker, user_id, "Savings", term_end=TOMORROW)
        await _deposit(
            job_sessionmaker, user_id, "Later", term_end=TODAY + timedelta(days=2)
        )
        idle_id = await _user(job_sessionmaker, "push-idle@example.com")
        await _device(job_sessionmaker, idle_id, "idle")
        sender = FakePushSender()

        await _run(job_sessionmaker, sender)

        ((endpoint, payload),) = sender.sent
        assert endpoint == phone
        assert set(payload) == {"title", "body", "url", "tag"}
        assert payload["body"] == "Car: Tyres, Rent, Savings"
        assert payload["url"] == "/transactions"
        visible = payload["title"] + payload["body"] + payload["url"]
        for amount in (GOAL_ITEM_AMOUNT, CHARGE_AMOUNT, DEPOSIT_BALANCE):
            assert str(amount) not in visible
            assert str(amount)[:4] not in visible  # nor its major-unit prefix
        assert not any(char.isdigit() for char in visible)
        claims = {
            claim.user_id: _counters(claim) for claim in await _claims(job_sessionmaker)
        }
        # The idle user is claimed too, with zeros — "evaluated today" is recorded.
        assert claims == {user_id: (1, 1, 1, 1, 0), idle_id: (0, 0, 0, 0, 0)}

    async def test_inactive_account_and_keyless_sender_send_and_claim_nothing(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        inactive = await _user(
            job_sessionmaker, "push-inactive@example.com", active=False
        )
        await _device(job_sessionmaker, inactive, "inactive")
        await _goal_item(job_sessionmaker, inactive)
        active = await _user(job_sessionmaker, "push-active@example.com")
        await _device(job_sessionmaker, active, "active")
        await _goal_item(job_sessionmaker, active)
        keyless = FakePushSender(enabled=False)

        await _run(job_sessionmaker, keyless)

        assert keyless.sent == []
        assert await _claims(job_sessionmaker) == []

        sender = FakePushSender()
        await _run(job_sessionmaker, sender)

        assert [endpoint for endpoint, _ in sender.sent] == [
            "https://push.example.com/send/active"
        ]
        assert [claim.user_id for claim in await _claims(job_sessionmaker)] == [active]
