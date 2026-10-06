"""The lifespan scheduler gate — the ONE pytest file that builds gated-ON apps.

Authorized by the grooming review (OQ-2) and deliberately narrow: it asserts what
was REGISTERED (jobs, triggers, kwargs), never behaviour. That is safe because the
recurring job is DB-local against a template-free test database and never raises,
and because the fx provider seam is swapped for a no-network fake before the
lifespan starts (the ``app.state.fx_fetcher`` precedent from test_receipts.py).

Why registrations are recorded rather than read back off ``scheduler.get_jobs()``:
a ``next_run_time=now`` job is submitted and REMOVED from the jobstore on the
scheduler's first wakeup, which happens before this test can look — so the boot
catch-up job would be invisible exactly where AM-6 requires it to be asserted. The
recording subclass delegates to the real ``add_job``, so every recorded Job is a
real APScheduler Job with a real trigger.
"""

from datetime import date
from typing import Any
from unittest.mock import patch

import pytest

# Same APScheduler-has-no-stubs situation as app.py: the ignores below are that
# and only that.
from apscheduler.schedulers.asyncio import AsyncIOScheduler  # type: ignore
from apscheduler.triggers.cron import CronTrigger  # type: ignore
from apscheduler.triggers.date import DateTrigger  # type: ignore
from asgi_lifespan import LifespanManager

from budget_api.app import create_app
from budget_api.config import Settings
from budget_api.services.fx_jobs import fetch_daily_rates
from budget_api.services.fx_rates import FetchedRate, FxRateFetcher
from budget_api.services.push_jobs import send_daily_reminders
from budget_api.services.recurring_jobs import materialize_due

_HOUR_UTC = 3
_MINUTE_UTC = 17


class _NoNetworkFetcher(FxRateFetcher):
    """The provider seam, neutered: no pytest app may reach a provider.

    Subclasses the real seam (deliberately not calling ``super().__init__``: every
    HTTP method is overridden), the test_fx_jobs.py construction.
    """

    def __init__(self) -> None:
        pass

    async def fetch_frankfurter_latest(self) -> list[FetchedRate]:
        return []

    async def fetch_frankfurter_history(
        self, start: date, end: date
    ) -> list[FetchedRate]:
        return []

    async def fetch_nbrb_latest(self) -> list[FetchedRate]:
        return []

    async def fetch_nbrb_history(self, start: date, end: date) -> list[FetchedRate]:
        return []


class _RecordingScheduler(AsyncIOScheduler):  # type: ignore[misc]
    """The real scheduler, keeping every ``Job`` it was handed."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[misc]
        self.registered: list[Any] = []

    def add_job(
        self, func: Any, trigger: Any = None, *args: Any, **options: Any
    ) -> Any:
        job = super().add_job(func, trigger, *args, **options)  # type: ignore[misc]
        self.registered.append(job)
        return job


def _jobs_for(scheduler: Any, func: Any) -> list[Any]:
    return [job for job in scheduler.registered if job.func is func]


class TestSchedulerGate:
    @pytest.mark.parametrize(
        ("fx_on", "recurring_on"),
        [(False, False), (True, False), (False, True), (True, True)],
        ids=["neither", "fx-only", "recurring-only", "both"],
    )
    @patch("budget_api.app.AsyncIOScheduler", _RecordingScheduler)
    async def test_scheduler_gate_combinations(
        self,
        test_database_url: str,
        test_jwt_secret: str,
        fx_on: bool,
        recurring_on: bool,
    ) -> None:
        """B1b-11 (+AM-6): one scheduler, two independent gates, four combinations.

        The recurring pair is asserted by TRIGGER, not by function identity: two
        jobs pointing at ``materialize_due`` say nothing about whether the daily
        cron or the boot catch-up is the one that went missing. ``kwargs`` is
        checked for the ABSENCE of ``today`` — kwargs are frozen at schedule time,
        so a bound date would freeze the job's idea of "today" until restart.
        """
        app = create_app(
            Settings(
                database_url=test_database_url,
                jwt_secret=test_jwt_secret,
                fx_scheduler_enabled=fx_on,
                recurring_scheduler_enabled=recurring_on,
                push_scheduler_enabled=False,
                recurring_materialize_hour_utc=_HOUR_UTC,
                recurring_materialize_minute_utc=_MINUTE_UTC,
            )
        )
        app.state.fx_fetcher = _NoNetworkFetcher()

        async with LifespanManager(app):
            scheduler = app.state.scheduler

            if not fx_on and not recurring_on:
                assert scheduler is None
                return

            assert scheduler is not None
            fx_crons = [
                job
                for job in _jobs_for(scheduler, fetch_daily_rates)
                if isinstance(job.trigger, CronTrigger)
            ]
            assert len(fx_crons) == (1 if fx_on else 0)

            recurring_jobs_registered = _jobs_for(scheduler, materialize_due)
            if not recurring_on:
                assert recurring_jobs_registered == []
                return

            assert len(recurring_jobs_registered) == 2
            crons = [
                job
                for job in recurring_jobs_registered
                if isinstance(job.trigger, CronTrigger)
            ]
            run_now = [
                job
                for job in recurring_jobs_registered
                if isinstance(job.trigger, DateTrigger)
            ]
            assert len(crons) == 1
            assert len(run_now) == 1

            (cron,) = crons
            fields = {field.name: str(field) for field in cron.trigger.fields}
            assert str(cron.trigger.timezone) == "UTC"
            assert fields["hour"] == str(_HOUR_UTC)
            assert fields["minute"] == str(_MINUTE_UTC)
            assert cron.misfire_grace_time == 3600
            assert cron.coalesce is True

            # The boot catch-up is unconditional (D5) and explicitly grace-less:
            # APScheduler's 1s default would discard it as a misfire on a busy loop.
            assert run_now[0].misfire_grace_time is None

            for job in recurring_jobs_registered:
                assert set(job.kwargs) == {"sessionmaker"}

    @patch("budget_api.app.AsyncIOScheduler", _RecordingScheduler)
    async def test_push_gate_registers_one_cron_and_no_boot_run(
        self, test_database_url: str, test_jwt_secret: str
    ) -> None:
        """The push gate alone builds the scheduler; its job is a cron, never run-now.

        No VAPID keys are configured here on purpose: registration must not depend
        on them (a keyless job no-ops), and with no keys nothing could ever be
        sent even if the job did fire. ZERO DateTrigger jobs is the architecture's
        no-boot-run decision — a restart must not push.
        """
        app = create_app(
            Settings(
                database_url=test_database_url,
                jwt_secret=test_jwt_secret,
                fx_scheduler_enabled=False,
                recurring_scheduler_enabled=False,
                push_scheduler_enabled=True,
                push_reminder_hour_utc=_HOUR_UTC,
                push_reminder_minute_utc=_MINUTE_UTC,
            )
        )

        async with LifespanManager(app):
            scheduler = app.state.scheduler

            assert scheduler is not None
            # ONE job in total, and it is the cron: no DateTrigger run-now sibling.
            assert len(scheduler.registered) == 1
            (cron,) = _jobs_for(scheduler, send_daily_reminders)
            fields = {field.name: str(field) for field in cron.trigger.fields}
            assert str(cron.trigger.timezone) == "UTC"
            assert fields["hour"] == str(_HOUR_UTC)
            assert fields["minute"] == str(_MINUTE_UTC)
            assert cron.misfire_grace_time == 3600
            assert cron.coalesce is True
            # ``today`` must NOT be bound (frozen kwargs, the D5 rule).
            assert set(cron.kwargs) == {"sessionmaker", "sender", "horizon_days"}
            assert cron.kwargs["sender"] is app.state.push_sender
            assert isinstance(cron.trigger, CronTrigger)
