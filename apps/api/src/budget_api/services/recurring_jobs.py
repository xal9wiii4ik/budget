"""Recurring materialization: the scheduled job that books standing orders (D5/D6).

The runtime half of 5.3 (``domain/recurrence.py`` is the pure half: it owns the
date math and this module owns the transaction boundaries). One entry point,
``materialize_due``, called from the lifespan wiring in ``app.py`` by both the
daily cron and the unconditional boot catch-up.

Strictly DB-local: no provider, no Anthropic, no HTTP of any kind (O-9). The one
profile access is ``read_base_currency``, which never self-heals a missing
``profiles`` row — a job that silently created rows for a user who never asked
would be a write nobody can trace back to a request.

Two phases, deliberately (D6):

* a short **probe** session reads candidate ids and is closed before any work —
  the ``fx_jobs`` no-session-across-work discipline;
* then **one session and one commit per template**, with the template row locked
  ``FOR UPDATE``. The lock is what makes the boot run-now job and the cron job
  safe to interleave on one loop: they are separate job ids, and the watermark is
  the only thing standing between "materialized once" and "materialized twice".

A failure while processing one template rolls that template back whole (inserts
AND watermark) and leaves every other template alone. The job never raises: an
APScheduler job that raises is swallowed as an error event, and the next run
would have to re-derive everything anyway.
"""

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.domain.recurrence import MAX_OCCURRENCES, due_dates_between
from budget_api.enums import RecurrenceUnit
from budget_api.models import RecurringTemplate, Transaction
from budget_api.services.fx_lookup import auto_snapshot
from budget_api.services.profile_reads import read_base_currency

logger = logging.getLogger(__name__)


async def _due_template_ids(session: AsyncSession, today: date) -> Sequence[uuid.UUID]:
    """Ids of every live template whose watermark is behind ``today``.

    The ``end_date > last_materialized_on`` clause drops a template only once its
    watermark has REACHED ``end_date``, which happens naturally only when
    ``end_date`` lands on a due date. A template ended BETWEEN due dates keeps a
    watermark strictly before ``end_date``, so it stays a candidate and is locked
    and re-evaluated daily until it is deleted — correctly producing nothing
    (``through`` clamps to ``end_date``, so no date is ever due), and cheap at
    D13 scale. No index (D13): this is tens of rows, once a day.
    """
    rows = await session.scalars(
        select(RecurringTemplate.id).where(
            RecurringTemplate.paused.is_(False),
            RecurringTemplate.last_materialized_on < today,
            or_(
                RecurringTemplate.end_date.is_(None),
                RecurringTemplate.end_date > RecurringTemplate.last_materialized_on,
            ),
        )
    )
    return rows.all()


async def materialize_due(
    sessionmaker: async_sessionmaker[AsyncSession], *, today: date | None = None
) -> None:
    """Materialize every due occurrence of every live template. NEVER raises (D5).

    ``today`` defaults to ``datetime.now(UTC).date()`` and is a parameter ONLY for
    tests. It is deliberately NOT bound in the scheduler's job kwargs: kwargs are
    frozen at schedule time, so a bound ``today`` would freeze the job's idea of
    the date until the next process restart (the fx job computes its own ``today``
    for the same reason).
    """
    run_date = today if today is not None else datetime.now(UTC).date()
    try:
        async with sessionmaker() as probe_session:
            template_ids = await _due_template_ids(probe_session, run_date)
    except Exception as exc:
        # Broad on purpose, like the per-template handler below: "never raises"
        # is this function's contract, and the boot catch-up run is
        # UNCONDITIONAL — a DB that is down at boot (or at 00:30 UTC) must cost
        # one warning, not an APScheduler error event with a traceback. Nothing
        # is materialized and the next run re-derives everything anyway.
        logger.warning("recurring probe failed: %r", exc)
        return

    for template_id in template_ids:
        try:
            async with sessionmaker() as session:
                tpl = await session.scalar(
                    select(RecurringTemplate)
                    .where(RecurringTemplate.id == template_id)
                    .with_for_update()
                )
                if tpl is None or tpl.paused:
                    # Deleted, or paused, between the probe and the lock.
                    continue
                through = (
                    tpl.end_date
                    if tpl.end_date is not None and tpl.end_date < run_date
                    else run_date
                )
                dates = due_dates_between(
                    RecurrenceUnit(tpl.interval_unit),
                    day_of_month=tpl.day_of_month,
                    weekday=tpl.weekday,
                    after=tpl.last_materialized_on,
                    through=through,
                )
                if not dates:
                    # The watermark advances ONLY to a date that was materialized:
                    # moving it on an empty run would skip occurrences forever.
                    # This is also the arm a concurrent run lands on — it acquires
                    # the lock after the winner committed the advanced watermark.
                    continue
                base = await read_base_currency(session, tpl.user_id)
                for due in dates:
                    base_amount_minor, base_currency = (
                        (None, None)
                        if tpl.currency == base
                        else await auto_snapshot(
                            session, tpl.amount_minor, tpl.currency, base, due
                        )
                    )
                    session.add(
                        Transaction(
                            user_id=tpl.user_id,
                            amount_minor=tpl.amount_minor,
                            kind=tpl.kind,
                            currency=tpl.currency,
                            category_id=tpl.category_id,
                            occurred_at=due,
                            note=tpl.note,
                            merchant=tpl.merchant,
                            receipt_id=None,
                            recurring_template_id=tpl.id,
                            base_amount_minor=base_amount_minor,
                            base_currency=base_currency,
                        )
                    )
                tpl.last_materialized_on = dates[-1]
                if len(dates) == MAX_OCCURRENCES:
                    logger.warning(
                        "recurring: template %s capped at %s dates",
                        tpl.id,
                        MAX_OCCURRENCES,
                    )
                # Inserts + watermark: ONE transaction. A partial commit here is
                # exactly the duplicate-money bug the design carries no UNIQUE
                # backstop against.
                await session.commit()
        except Exception as exc:
            # Deliberately broad, PER TEMPLATE (the fx per-provider argument): one
            # template's bad data must not cost every other template its run, and
            # the scheduler job itself must never raise.
            logger.warning(
                "recurring materialization failed for %s: %r", template_id, exc
            )
