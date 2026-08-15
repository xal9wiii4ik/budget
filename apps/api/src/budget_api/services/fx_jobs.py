"""Rate-fetch orchestration: the DB-writing half of the FX pipeline (D3/D4).

This is deliberately the FIRST services-level module that imports ``models`` and
touches the database (sanctioned by the receipts D13 carry-forward: "second
pipeline consumer (scheduler/batch) -> extract the background task to a
services-level orchestrator"). The provider HTTP half stays pure in
``services/fx_rates.py``; this module only decides *what* to ask for and writes
the result.

Two entry points, both called from the lifespan wiring in ``app.py``:
``fetch_daily_rates`` (the cron job AND the boot catch-up job) and
``catch_up_needed`` (the boot decision — one local read, never a provider call).
"""

import logging
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import ColumnElement, and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.sql import func

from budget_api.models import ExchangeRate
from budget_api.services.fx_rates import (
    FRANKFURTER,
    NBRB,
    FetchedRate,
    FxFetchError,
    FxRateFetcher,
)

logger = logging.getLogger(__name__)

Pair = tuple[str, str]

#: The only pairs ever stored (D2): the 6 directed canonical pairs; inverses are
#: derived at read time.
FRANKFURTER_PAIRS: tuple[Pair, ...] = (("EUR", "USD"),)
NBRB_PAIRS: tuple[Pair, ...] = (
    ("BYN", "USD"),
    ("BYN", "EUR"),
    ("BYN", "RUB"),
    ("RUB", "USD"),
    ("RUB", "EUR"),
)
CANONICAL_PAIRS: tuple[Pair, ...] = FRANKFURTER_PAIRS + NBRB_PAIRS

#: A pair with no row at or after ``today - 3 days`` counts as behind (D3). Three
#: days absorbs a weekend of non-publication without arming the catch-up every
#: Monday morning.
CATCH_UP_LAG_DAYS = 3


@dataclass(frozen=True)
class _ProviderPlan:
    """One provider's pairs plus its two fetch entry points."""

    name: str
    pairs: tuple[Pair, ...]
    latest: Callable[[], Awaitable[list[FetchedRate]]]
    history: Callable[[date, date], Awaitable[list[FetchedRate]]]


def _provider_plans(fetcher: FxRateFetcher) -> tuple[_ProviderPlan, ...]:
    return (
        _ProviderPlan(
            name=FRANKFURTER,
            pairs=FRANKFURTER_PAIRS,
            latest=fetcher.fetch_frankfurter_latest,
            history=fetcher.fetch_frankfurter_history,
        ),
        _ProviderPlan(
            name=NBRB,
            pairs=NBRB_PAIRS,
            latest=fetcher.fetch_nbrb_latest,
            history=fetcher.fetch_nbrb_history,
        ),
    )


def _pairs_filter(pairs: Iterable[Pair]) -> ColumnElement[bool]:
    """``(base, quote)`` membership as an OR of equality pairs.

    Spelled out rather than ``tuple_(...).in_(...)``: row-value IN is the one
    construct whose bind-parameter expansion differs across drivers, and this
    predicate runs on every job tick and every boot.
    """
    return or_(
        *(
            and_(ExchangeRate.base == base, ExchangeRate.quote == quote)
            for base, quote in pairs
        )
    )


async def _provider_has_rows(session: AsyncSession, pairs: tuple[Pair, ...]) -> bool:
    """True iff ANY of this provider's pairs already has at least one row.

    Per-provider, not global (grooming AM-2): if frankfurter succeeds and NBRB
    fails during the initial backfill, a global emptiness probe would see a
    non-empty table forever after and NBRB would never get its history. Scoping the
    probe to the provider's own pairs makes a partial backfill self-heal on the
    next run.
    """
    existing = await session.scalar(
        select(ExchangeRate.base).where(_pairs_filter(pairs)).limit(1)
    )
    return existing is not None


async def _upsert_rates(session: AsyncSession, rates: Sequence[FetchedRate]) -> None:
    """Idempotent write (D3): ON CONFLICT on the natural PK, refreshing fetched_at.

    Rates are de-duplicated by key first — Postgres rejects a statement whose
    ON CONFLICT DO UPDATE would touch the same row twice, and a provider serving
    the same date in two history windows is a real possibility.
    """
    if not rates:
        return
    deduped: dict[tuple[str, str, date], FetchedRate] = {
        (rate.base, rate.quote, rate.as_of_date): rate for rate in rates
    }
    statement = pg_insert(ExchangeRate).values(
        [
            {
                "base": rate.base,
                "quote": rate.quote,
                "as_of_date": rate.as_of_date,
                "rate": rate.rate,
                "provider": rate.provider,
            }
            for rate in deduped.values()
        ]
    )
    await session.execute(
        statement.on_conflict_do_update(
            index_elements=["base", "quote", "as_of_date"],
            set_={
                "rate": statement.excluded.rate,
                "provider": statement.excluded.provider,
                "fetched_at": func.now(),
            },
        )
    )


async def fetch_daily_rates(
    sessionmaker: async_sessionmaker[AsyncSession],
    fetcher: FxRateFetcher,
    *,
    backfill_days: int,
) -> None:
    """Fetch and upsert every canonical pair. NEVER raises (D3).

    Each provider runs in its own ``try/except``: one provider being down, slow, or
    serving garbage logs a warning and leaves the other provider's rows written. A
    provider whose own pairs have no rows at all fetches ``backfill_days`` of history
    instead of just the latest day (D4 + AM-2).

    No session is held across the provider HTTP calls: the probe gets a short session
    that is closed before any request, and the write gets a fresh one. A backfill can
    spend minutes in ``plan.history`` and must not pin a pooled connection idle in
    transaction for that long.
    """
    today = datetime.now(UTC).date()
    start = today - timedelta(days=backfill_days)
    for plan in _provider_plans(fetcher):
        try:
            async with sessionmaker() as probe_session:
                has_rows = await _provider_has_rows(probe_session, plan.pairs)

            if has_rows:
                rates = await plan.latest()
            else:
                logger.info(
                    "fx backfill: provider %s has no rows, fetching %s..%s",
                    plan.name,
                    start,
                    today,
                )
                rates = await plan.history(start, today)

            async with sessionmaker() as session:
                await _upsert_rates(session, rates)
                await session.commit()
        except FxFetchError as exc:
            logger.warning("fx fetch failed for provider %s: %s", plan.name, exc.code)
        except Exception as exc:
            # Deliberately broad, per provider: the scheduler job must never raise
            # (a raising job would be swallowed by APScheduler as an error event and
            # could take the second provider down with it).
            logger.warning("fx fetch failed for provider %s: %r", plan.name, exc)


async def catch_up_needed(session: AsyncSession, *, today: date) -> bool:
    """True iff any canonical pair lacks a row from the last ``CATCH_UP_LAG_DAYS``.

    One local read; the caller (lifespan) uses it to decide whether to schedule an
    immediate ``fetch_daily_rates`` — startup itself never touches a provider.
    """
    cutoff = today - timedelta(days=CATCH_UP_LAG_DAYS)
    rows = await session.execute(
        select(ExchangeRate.base, ExchangeRate.quote)
        .where(_pairs_filter(CANONICAL_PAIRS), ExchangeRate.as_of_date >= cutoff)
        .distinct()
    )
    recent = {(row.base, row.quote) for row in rows}
    return not set(CANONICAL_PAIRS) <= recent
