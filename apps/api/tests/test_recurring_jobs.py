"""Recurring materialization against a REAL Postgres, nothing mocked by default.

The job is DB-local (no provider, no Anthropic), so there is no boundary to fake:
the watermark arithmetic, the ``FOR UPDATE`` lock, the per-template transaction
and the snapshot lookups all run for real against budget_test. The only two
tests that patch anything patch an INTERNAL seam, and both say why in place —
an injected fault is the only way to reach the mid-batch rollback path, and a
deleted-between-probe-and-lock row is unreachable without interleaving.

No app is constructed here and no scheduler ever starts; ``materialize_due`` is
called directly with an explicit ``today`` (the wiring lives in
``test_scheduler_wiring.py``).
"""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.config import Settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.domain.recurrence import MAX_OCCURRENCES
from budget_api.models import (
    Category,
    ExchangeRate,
    Profile,
    RecurringTemplate,
    Transaction,
)
from budget_api.services import recurring_jobs
from budget_api.services.recurring_jobs import materialize_due

#: A fixed "now" for every test: the job takes ``today`` explicitly precisely so
#: the assertions are not a function of the day the suite runs.
TODAY = date(2026, 8, 5)

#: Nothing is listening here — a closed local port refuses instantly (the same
#: construction ``test_health.py`` uses for its unreachable-DB case).
UNREACHABLE_DATABASE_URL = "postgresql+asyncpg://budget:budget@localhost:5599/budget"


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


async def _create_user(
    sessionmaker: async_sessionmaker[AsyncSession], email: str
) -> uuid.UUID:
    """Insert a bare user via raw SQL (no register hook, so no profile side effect)."""
    user_id = uuid.uuid4()
    async with sessionmaker() as session:
        await session.execute(
            text(
                "INSERT INTO users (id, email, hashed_password) "
                "VALUES (:id, :email, :pw)"
            ),
            {"id": user_id, "email": email, "pw": "x"},
        )
        await session.commit()
    return user_id


async def _set_base_currency(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    base_currency: str,
) -> None:
    async with sessionmaker() as session:
        session.add(Profile(user_id=user_id, base_currency=base_currency))
        await session.commit()


async def _add_category(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    *,
    name: str = "Subscriptions",
) -> uuid.UUID:
    async with sessionmaker() as session:
        category = Category(user_id=user_id, name=name, kind="expense")
        session.add(category)
        await session.commit()
        return category.id


async def _archive_category(
    sessionmaker: async_sessionmaker[AsyncSession], category_id: uuid.UUID
) -> None:
    async with sessionmaker() as session:
        category = await session.get(Category, category_id)
        assert category is not None
        category.archived = True
        await session.commit()


async def _add_template(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    *,
    last_materialized_on: date,
    name: str = "Netflix",
    amount_minor: int = 10_000,
    kind: str = "expense",
    currency: str = "RUB",
    interval_unit: str = "month",
    day_of_month: int | None = 1,
    weekday: int | None = None,
    end_date: date | None = None,
    paused: bool = False,
    category_id: uuid.UUID | None = None,
    merchant: str | None = "netflix",
    note: str | None = "subscription",
) -> uuid.UUID:
    async with sessionmaker() as session:
        template = RecurringTemplate(
            user_id=user_id,
            name=name,
            amount_minor=amount_minor,
            kind=kind,
            currency=currency,
            interval_unit=interval_unit,
            day_of_month=day_of_month,
            weekday=weekday,
            end_date=end_date,
            paused=paused,
            category_id=category_id,
            merchant=merchant,
            note=note,
            last_materialized_on=last_materialized_on,
        )
        session.add(template)
        await session.commit()
        return template.id


async def _seed_rate(
    sessionmaker: async_sessionmaker[AsyncSession],
    base: str,
    quote: str,
    value: str,
    *,
    as_of: date,
) -> None:
    async with sessionmaker() as session:
        session.add(
            ExchangeRate(
                base=base,
                quote=quote,
                as_of_date=as_of,
                rate=Decimal(value),
                provider="seed",
            )
        )
        await session.commit()


async def _rows(
    sessionmaker: async_sessionmaker[AsyncSession], template_id: uuid.UUID
) -> list[Transaction]:
    """Every materialized row of one template, oldest first (a FRESH session)."""
    async with sessionmaker() as session:
        rows = await session.scalars(
            select(Transaction)
            .where(Transaction.recurring_template_id == template_id)
            .order_by(Transaction.occurred_at)
        )
        return list(rows.all())


async def _template(
    sessionmaker: async_sessionmaker[AsyncSession], template_id: uuid.UUID
) -> RecurringTemplate:
    """Re-read the template in a FRESH session (AM-4: never trust a stale identity)."""
    async with sessionmaker() as session:
        template = await session.get(RecurringTemplate, template_id)
        assert template is not None
        return template


class TestCatchUp:
    async def test_catch_up_materializes_each_missed_date_once(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """B1b-1 (+AM-2): three missed months, three rows, three DIFFERENT rates.

        The template is foreign-currency with a different USD->RUB rate seeded on
        each due date, so a hoisted single lookup (one rate reused for the whole
        batch) fails here — with one rate the assertion would be blind to it.
        """
        user_id = await _create_user(job_sessionmaker, "catchup@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        category_id = await _add_category(job_sessionmaker, user_id)
        template_id = await _add_template(
            job_sessionmaker,
            user_id,
            currency="USD",
            category_id=category_id,
            last_materialized_on=date(2026, 5, 20),
        )
        for due, rate in (
            (date(2026, 6, 1), "80"),
            (date(2026, 7, 1), "90"),
            (date(2026, 8, 1), "100"),
        ):
            await _seed_rate(job_sessionmaker, "USD", "RUB", rate, as_of=due)

        await materialize_due(job_sessionmaker, today=TODAY)

        rows = await _rows(job_sessionmaker, template_id)
        assert [row.occurred_at for row in rows] == [
            date(2026, 6, 1),
            date(2026, 7, 1),
            date(2026, 8, 1),
        ]
        # 100.00 USD at 80 / 90 / 100 RUB per USD.
        assert [row.base_amount_minor for row in rows] == [800_000, 900_000, 1_000_000]
        assert {row.base_currency for row in rows} == {"RUB"}
        # Every display value is COPIED at materialization (D7), and the row is
        # attributed to its template without inheriting a receipt.
        assert [
            (
                row.user_id,
                row.amount_minor,
                row.kind,
                row.currency,
                row.category_id,
                row.note,
                row.merchant,
                row.receipt_id,
            )
            for row in rows
        ] == [
            (
                user_id,
                10_000,
                "expense",
                "USD",
                category_id,
                "subscription",
                "netflix",
                None,
            )
        ] * 3
        assert (
            await _template(job_sessionmaker, template_id)
        ).last_materialized_on == date(2026, 8, 1)

    async def test_second_run_is_a_no_op(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """B1b-2: the watermark IS the idempotency mechanism (D6).

        There is no UNIQUE backstop behind it — a second run that re-derived the
        same dates would simply book them again.
        """
        user_id = await _create_user(job_sessionmaker, "idempotent@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        template_id = await _add_template(
            job_sessionmaker, user_id, last_materialized_on=date(2026, 5, 20)
        )

        await materialize_due(job_sessionmaker, today=TODAY)
        first = await _rows(job_sessionmaker, template_id)
        await materialize_due(job_sessionmaker, today=TODAY)
        second = await _rows(job_sessionmaker, template_id)

        assert len(first) == 3
        assert [row.id for row in second] == [row.id for row in first]
        assert (
            await _template(job_sessionmaker, template_id)
        ).last_materialized_on == date(2026, 8, 1)

    async def test_paused_template_is_skipped_and_watermark_frozen(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """B1b-3: the live sibling is the contrast that proves the run happened."""
        user_id = await _create_user(job_sessionmaker, "paused@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        paused_id = await _add_template(
            job_sessionmaker,
            user_id,
            name="Paused",
            paused=True,
            last_materialized_on=date(2026, 5, 20),
        )
        live_id = await _add_template(
            job_sessionmaker,
            user_id,
            name="Live",
            last_materialized_on=date(2026, 5, 20),
        )

        await materialize_due(job_sessionmaker, today=TODAY)

        assert await _rows(job_sessionmaker, paused_id) == []
        assert (
            await _template(job_sessionmaker, paused_id)
        ).last_materialized_on == date(2026, 5, 20)
        assert len(await _rows(job_sessionmaker, live_id)) == 3

    async def test_end_date_boundary(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """B1b-4: a due date ON end_date materializes; the next one never does."""
        user_id = await _create_user(job_sessionmaker, "ended@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        template_id = await _add_template(
            job_sessionmaker,
            user_id,
            end_date=date(2026, 7, 1),
            last_materialized_on=date(2026, 5, 20),
        )

        await materialize_due(job_sessionmaker, today=TODAY)

        rows = await _rows(job_sessionmaker, template_id)
        assert [row.occurred_at for row in rows] == [date(2026, 6, 1), date(2026, 7, 1)]
        assert (
            await _template(job_sessionmaker, template_id)
        ).last_materialized_on == date(2026, 7, 1)

        # A month later the template is still ended, not merely caught up.
        await materialize_due(job_sessionmaker, today=date(2026, 9, 5))

        assert [row.id for row in await _rows(job_sessionmaker, template_id)] == [
            row.id for row in rows
        ]
        assert (
            await _template(job_sessionmaker, template_id)
        ).last_materialized_on == date(2026, 7, 1)


class TestSnapshot:
    async def test_snapshot_uses_the_due_date_rate_not_the_run_date(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """B1b-5: during a catch-up the fx table already holds the historical row."""
        user_id = await _create_user(job_sessionmaker, "duedate@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        template_id = await _add_template(
            job_sessionmaker,
            user_id,
            currency="USD",
            last_materialized_on=date(2026, 7, 15),
        )
        await _seed_rate(job_sessionmaker, "USD", "RUB", "80", as_of=date(2026, 8, 1))
        await _seed_rate(job_sessionmaker, "USD", "RUB", "200", as_of=date(2026, 8, 4))

        await materialize_due(job_sessionmaker, today=TODAY)

        rows = await _rows(job_sessionmaker, template_id)
        assert [row.occurred_at for row in rows] == [date(2026, 8, 1)]
        assert (rows[0].base_amount_minor, rows[0].base_currency) == (800_000, "RUB")

    async def test_rate_only_on_the_run_date_snapshots_null(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """AM-3: nothing at or before the due date — a run-date row must not leak in."""
        user_id = await _create_user(job_sessionmaker, "ratemiss@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        template_id = await _add_template(
            job_sessionmaker,
            user_id,
            currency="USD",
            last_materialized_on=date(2026, 7, 15),
        )
        await _seed_rate(job_sessionmaker, "USD", "RUB", "200", as_of=TODAY)

        await materialize_due(job_sessionmaker, today=TODAY)

        rows = await _rows(job_sessionmaker, template_id)
        assert [row.occurred_at for row in rows] == [date(2026, 8, 1)]
        assert (rows[0].base_amount_minor, rows[0].base_currency) == (None, None)

    async def test_base_currency_template_never_self_copies(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """B1b-5 contrast: a redundant self-copy goes stale the day the base changes."""
        user_id = await _create_user(job_sessionmaker, "samecur@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        template_id = await _add_template(
            job_sessionmaker,
            user_id,
            currency="RUB",
            last_materialized_on=date(2026, 7, 15),
        )
        # An identity rate exists in lookup_rate; only the currency==base short
        # circuit keeps it out of the row.
        await _seed_rate(job_sessionmaker, "RUB", "RUB", "1", as_of=date(2026, 8, 1))

        await materialize_due(job_sessionmaker, today=TODAY)

        rows = await _rows(job_sessionmaker, template_id)
        assert [row.occurred_at for row in rows] == [date(2026, 8, 1)]
        assert (rows[0].base_amount_minor, rows[0].base_currency) == (None, None)

    async def test_snapshot_uses_each_owners_base_currency(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """B1b-6: a ``read_base_currency(session, wrong_user)`` bug is invisible
        in a single-user fixture — same template currency, two different bases."""
        rub_user = await _create_user(job_sessionmaker, "rubowner@x.com")
        eur_user = await _create_user(job_sessionmaker, "eurowner@x.com")
        await _set_base_currency(job_sessionmaker, rub_user, "RUB")
        await _set_base_currency(job_sessionmaker, eur_user, "EUR")
        rub_template = await _add_template(
            job_sessionmaker,
            rub_user,
            currency="USD",
            last_materialized_on=date(2026, 7, 15),
        )
        eur_template = await _add_template(
            job_sessionmaker,
            eur_user,
            currency="USD",
            last_materialized_on=date(2026, 7, 15),
        )
        await _seed_rate(job_sessionmaker, "USD", "RUB", "80", as_of=date(2026, 8, 1))
        await _seed_rate(job_sessionmaker, "USD", "EUR", "0.9", as_of=date(2026, 8, 1))

        await materialize_due(job_sessionmaker, today=TODAY)

        (rub_row,) = await _rows(job_sessionmaker, rub_template)
        (eur_row,) = await _rows(job_sessionmaker, eur_template)
        assert (rub_row.user_id, rub_row.base_amount_minor, rub_row.base_currency) == (
            rub_user,
            800_000,
            "RUB",
        )
        assert (eur_row.user_id, eur_row.base_amount_minor, eur_row.base_currency) == (
            eur_user,
            9_000,
            "EUR",
        )

    async def test_profile_less_user_materializes_at_the_default_base(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """AM-12: a pre-1.2 user reads as RUB and the job does NOT self-heal.

        A background job creating a profiles row would be a write nobody can trace
        back to a request — the read side's no-self-heal rule, held by the job too.
        """
        user_id = await _create_user(job_sessionmaker, "noprofile@x.com")
        template_id = await _add_template(
            job_sessionmaker,
            user_id,
            currency="USD",
            last_materialized_on=date(2026, 7, 15),
        )
        await _seed_rate(job_sessionmaker, "USD", "RUB", "80", as_of=date(2026, 8, 1))

        await materialize_due(job_sessionmaker, today=TODAY)

        (row,) = await _rows(job_sessionmaker, template_id)
        assert (row.base_amount_minor, row.base_currency) == (800_000, "RUB")
        async with job_sessionmaker() as session:
            assert await session.get(Profile, user_id) is None


class TestCategoryStamping:
    async def test_archived_category_still_materializes(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """B1b-7 (D11): stamped AS STORED — archiving a category is not a pause."""
        user_id = await _create_user(job_sessionmaker, "archived@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        category_id = await _add_category(job_sessionmaker, user_id)
        template_id = await _add_template(
            job_sessionmaker,
            user_id,
            category_id=category_id,
            last_materialized_on=date(2026, 7, 15),
        )
        await _archive_category(job_sessionmaker, category_id)

        await materialize_due(job_sessionmaker, today=TODAY)

        (row,) = await _rows(job_sessionmaker, template_id)
        assert row.category_id == category_id
        assert (await _template(job_sessionmaker, template_id)).paused is False


class TestCap:
    async def test_cap_truncates_and_resumes(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """B1b-8 (+AM-1): capped, not dropped — 366 + 54 + 0 across three runs.

        Eight years of a forgotten weekly template is 420 Mondays, so the first run
        must actually hit ``MAX_OCCURRENCES``; the watermark stops at the 366th date
        and the remainder arrives on the next run.
        """
        user_id = await _create_user(job_sessionmaker, "cap@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        template_id = await _add_template(
            job_sessionmaker,
            user_id,
            interval_unit="week",
            day_of_month=None,
            weekday=0,
            last_materialized_on=date(2018, 8, 1),
        )
        today = date(2026, 8, 18)

        await materialize_due(job_sessionmaker, today=today)

        first = await _rows(job_sessionmaker, template_id)
        assert len(first) == MAX_OCCURRENCES == 366
        assert first[0].occurred_at == date(2018, 8, 6)
        assert first[-1].occurred_at == date(2025, 8, 4)
        assert (
            await _template(job_sessionmaker, template_id)
        ).last_materialized_on == date(2025, 8, 4)

        await materialize_due(job_sessionmaker, today=today)

        second = await _rows(job_sessionmaker, template_id)
        assert len(second) == 420
        assert second[-1].occurred_at == date(2026, 8, 17)
        assert (
            await _template(job_sessionmaker, template_id)
        ).last_materialized_on == date(2026, 8, 17)

        await materialize_due(job_sessionmaker, today=today)

        assert len(await _rows(job_sessionmaker, template_id)) == 420


class TestAtomicity:
    @pytest.mark.parametrize("fail_on", [3, 4], ids=["mid-batch", "last-date"])
    async def test_failure_mid_batch_rolls_back_that_template_only(
        self, job_sessionmaker: async_sessionmaker[AsyncSession], fail_on: int
    ) -> None:
        """B1b-9 (+AM-4): the crash-atomicity pin the whole design rests on.

        Internal mocking is deliberate: an injected fault is the only way to reach
        the mid-batch rollback path, and ``patch`` is used as a context manager (not
        the usual decorator) because the second half of the test must re-run the
        job UNPATCHED to prove the failed template resumes exactly once per date.
        ``fail_on=4`` is the last due date, where every insert is already staged.

        There are TWO survivors, one created before the failing template and one
        after, because that is what pins the OTHER half of the contract — that the
        loop continues past a failure. ``_due_template_ids`` has no ``ORDER BY``,
        so under an insertion-order scan a single survivor created first is already
        committed when the fault fires, and a handler that aborted the whole run
        (``break``) would keep every assertion true.
        """
        user_id = await _create_user(job_sessionmaker, "atomic@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        # Base-currency: never calls auto_snapshot, so the fault counter below is
        # the failing template's alone and the assertions do not depend on order.
        earlier_id = await _add_template(
            job_sessionmaker,
            user_id,
            name="Base currency (before)",
            currency="RUB",
            last_materialized_on=date(2026, 5, 20),
        )
        failing_id = await _add_template(
            job_sessionmaker,
            user_id,
            name="Foreign currency",
            currency="USD",
            last_materialized_on=date(2026, 4, 20),
        )
        later_id = await _add_template(
            job_sessionmaker,
            user_id,
            name="Base currency (after)",
            currency="RUB",
            last_materialized_on=date(2026, 5, 20),
        )
        for due in (
            date(2026, 5, 1),
            date(2026, 6, 1),
            date(2026, 7, 1),
            date(2026, 8, 1),
        ):
            await _seed_rate(job_sessionmaker, "USD", "RUB", "80", as_of=due)
        calls = 0

        def _snapshot(
            session: AsyncSession,
            amount_minor: int,
            currency: str,
            base: str,
            on_date: date,
        ) -> tuple[int | None, str | None]:
            nonlocal calls
            calls += 1
            if calls == fail_on:
                raise RuntimeError("injected snapshot failure")
            return amount_minor, base

        with patch(
            "budget_api.services.recurring_jobs.auto_snapshot", side_effect=_snapshot
        ):
            assert await materialize_due(job_sessionmaker, today=TODAY) is None

        for survivor_id in (earlier_id, later_id):
            assert len(await _rows(job_sessionmaker, survivor_id)) == 3
            assert (
                await _template(job_sessionmaker, survivor_id)
            ).last_materialized_on == date(2026, 8, 1)
        assert await _rows(job_sessionmaker, failing_id) == []
        assert (
            await _template(job_sessionmaker, failing_id)
        ).last_materialized_on == date(2026, 4, 20)

        await materialize_due(job_sessionmaker, today=TODAY)

        assert [
            row.occurred_at for row in await _rows(job_sessionmaker, failing_id)
        ] == [
            date(2026, 5, 1),
            date(2026, 6, 1),
            date(2026, 7, 1),
            date(2026, 8, 1),
        ]
        assert len(await _rows(job_sessionmaker, earlier_id)) == 3
        assert len(await _rows(job_sessionmaker, later_id)) == 3

    async def test_template_deleted_between_probe_and_lock_is_skipped(
        self,
        job_sessionmaker: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """B1b-10: the ``tpl is None`` arm the two-phase (probe, then lock) shape adds.

        Deviation from the plan's mechanics, deliberately: deleting the row BEFORE
        the run would never reach this branch (the probe simply would not return the
        id), so the deletion is injected at the probe seam — the real probe runs,
        then the row disappears, exactly the production race. A job that must never
        raise cannot be left to discover this branch in production.
        """
        user_id = await _create_user(job_sessionmaker, "deleted@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        template_id = await _add_template(
            job_sessionmaker, user_id, last_materialized_on=date(2026, 5, 20)
        )
        real_probe = recurring_jobs._due_template_ids  # pyright: ignore[reportPrivateUsage]
        probed: list[uuid.UUID] = []

        async def _probe_then_delete(
            session: AsyncSession, today: date
        ) -> list[uuid.UUID]:
            ids = list(await real_probe(session, today))
            probed.extend(ids)
            async with job_sessionmaker() as other:
                await other.execute(
                    delete(RecurringTemplate).where(RecurringTemplate.id == template_id)
                )
                await other.commit()
            return ids

        with (
            caplog.at_level(logging.WARNING, logger=recurring_jobs.__name__),
            patch(
                "budget_api.services.recurring_jobs._due_template_ids",
                side_effect=_probe_then_delete,
            ),
        ):
            assert await materialize_due(job_sessionmaker, today=TODAY) is None

        assert probed == [template_id]
        # Row counts alone cannot tell "skipped via the ``tpl is None`` arm" from
        # "crashed on ``None.paused`` and the broad per-template except swallowed
        # it" — both write nothing. The absence of the failure warning can.
        assert [
            record.getMessage()
            for record in caplog.records
            if "recurring materialization failed" in record.getMessage()
        ] == []
        async with job_sessionmaker() as session:
            assert (
                await session.scalar(
                    select(Transaction).where(Transaction.user_id == user_id)
                )
            ) is None

    async def test_concurrent_runs_materialize_each_date_once(
        self, job_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        """AM-5: the FOR UPDATE pin — the boot run-now and the cron are separate job
        ids that can interleave on one loop, and nothing else stops a double booking.

        The rendezvous at the probe seam is what makes the race REAL rather than
        theatre: a bare ``asyncio.gather`` was measured to serialize on connection
        setup — it passes even with ``with_for_update()`` deleted from the job, so
        it would pin nothing. Held at the barrier, both runs enter the per-template
        phase together, so the second one's locking read is in flight before the
        first one commits (verified: deleting the lock turns this red, 6 rows).
        """
        user_id = await _create_user(job_sessionmaker, "concurrent@x.com")
        await _set_base_currency(job_sessionmaker, user_id, "RUB")
        template_id = await _add_template(
            job_sessionmaker, user_id, last_materialized_on=date(2026, 5, 20)
        )
        real_probe = recurring_jobs._due_template_ids  # pyright: ignore[reportPrivateUsage]
        barrier = asyncio.Barrier(2)

        async def _probe_then_rendezvous(
            session: AsyncSession, today: date
        ) -> list[uuid.UUID]:
            ids = list(await real_probe(session, today))
            await barrier.wait()
            return ids

        with patch(
            "budget_api.services.recurring_jobs._due_template_ids",
            side_effect=_probe_then_rendezvous,
        ):
            await asyncio.gather(
                materialize_due(job_sessionmaker, today=TODAY),
                materialize_due(job_sessionmaker, today=TODAY),
            )

        rows = await _rows(job_sessionmaker, template_id)
        assert [row.occurred_at for row in rows] == [
            date(2026, 6, 1),
            date(2026, 7, 1),
            date(2026, 8, 1),
        ]
        assert (
            await _template(job_sessionmaker, template_id)
        ).last_materialized_on == date(2026, 8, 1)


class TestNeverRaises:
    async def test_unreachable_database_is_warned_not_raised(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """D5: a DB that is down when the job runs costs one warning, not a raise.

        The probe runs before any per-template ``try``, so a dead DB is the one
        way the "never raises" contract can be broken from outside the loop — and
        the boot catch-up run is UNCONDITIONAL, so a DB-down boot hits exactly
        this path. The caplog assertion is what separates "handled" from
        "silently lost": returning quietly on a dead DB would be its own bug.
        """
        engine = build_engine(
            Settings(
                database_url=UNREACHABLE_DATABASE_URL, jwt_secret="test-jwt-secret"
            )
        )
        try:
            with caplog.at_level(logging.WARNING, logger=recurring_jobs.__name__):
                assert (
                    await materialize_due(build_sessionmaker(engine), today=TODAY)
                    is None
                )
        finally:
            await engine.dispose()

        (record,) = caplog.records
        assert record.levelname == "WARNING"
        assert record.getMessage().startswith("recurring probe failed:")
