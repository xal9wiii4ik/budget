"""Rate-fetch orchestration against a REAL Postgres, with the provider seam faked.

Only the network boundary is faked (a ``FxRateFetcher`` subclass): the upserts, the
per-provider emptiness probe and the catch-up query all run for real against
budget_test, because the things that can break here are SQL-level (ON CONFLICT
target, per-provider scoping, the DDL CHECKs). No app is constructed, so the
scheduler never starts — its wiring is verified live at /test.
"""

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from helpers import add_account
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.config import Settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.models import ExchangeRate, Transaction
from budget_api.services.fx_jobs import (
    CANONICAL_PAIRS,
    NBRB_PAIRS,
    catch_up_needed,
    fetch_daily_rates,
)
from budget_api.services.fx_rates import (
    FRANKFURTER,
    NBRB,
    FetchedRate,
    FxFetchError,
    FxRateFetcher,
)

_BACKFILL_DAYS = 400
_TODAY = datetime.now(UTC).date()


@pytest.fixture
async def fx_sessionmaker(
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


def _rate(base: str, quote: str, value: str, provider: str) -> FetchedRate:
    return FetchedRate(
        base=base,
        quote=quote,
        rate=Decimal(value),
        as_of_date=_TODAY,
        provider=provider,
    )


def _frankfurter_rates(value: str = "1.10") -> list[FetchedRate]:
    return [_rate("EUR", "USD", value, FRANKFURTER)]


def _nbrb_rates(value: str = "0.30") -> list[FetchedRate]:
    return [_rate(base, quote, value, NBRB) for base, quote in NBRB_PAIRS]


class _FakeFetcher(FxRateFetcher):
    """Records what the job asked for and returns canned rates.

    Subclasses the real seam (deliberately not calling ``super().__init__``: every
    HTTP method is overridden) so the job is exercised with exactly the production
    parameter type.
    """

    def __init__(
        self,
        *,
        frankfurter: list[FetchedRate] | None = None,
        nbrb: list[FetchedRate] | None = None,
        nbrb_error: Exception | None = None,
    ) -> None:
        self.frankfurter = frankfurter if frankfurter is not None else []
        self.nbrb = nbrb if nbrb is not None else []
        self.nbrb_error = nbrb_error
        self.calls: list[tuple[str, str]] = []
        self.windows: dict[str, tuple[date, date]] = {}

    async def fetch_frankfurter_latest(self) -> list[FetchedRate]:
        self.calls.append((FRANKFURTER, "latest"))
        return list(self.frankfurter)

    async def fetch_frankfurter_history(
        self, start: date, end: date
    ) -> list[FetchedRate]:
        self.calls.append((FRANKFURTER, "history"))
        self.windows[FRANKFURTER] = (start, end)
        return list(self.frankfurter)

    async def fetch_nbrb_latest(self) -> list[FetchedRate]:
        self.calls.append((NBRB, "latest"))
        if self.nbrb_error is not None:
            raise self.nbrb_error
        return list(self.nbrb)

    async def fetch_nbrb_history(self, start: date, end: date) -> list[FetchedRate]:
        self.calls.append((NBRB, "history"))
        self.windows[NBRB] = (start, end)
        if self.nbrb_error is not None:
            raise self.nbrb_error
        return list(self.nbrb)


async def _stored(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> dict[tuple[str, str], ExchangeRate]:
    async with sessionmaker() as session:
        rows = (await session.execute(select(ExchangeRate))).scalars().all()
    return {(row.base, row.quote): row for row in rows}


async def _seed(
    sessionmaker: async_sessionmaker[AsyncSession],
    pairs: list[tuple[str, str]],
    *,
    as_of: date,
) -> None:
    async with sessionmaker() as session:
        for base, quote in pairs:
            session.add(
                ExchangeRate(
                    base=base,
                    quote=quote,
                    as_of_date=as_of,
                    rate=Decimal("1.00000000"),
                    provider="seed",
                )
            )
        await session.commit()


class TestFetchDailyRates:
    async def test_upserts_are_idempotent(
        self, fx_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        fetcher = _FakeFetcher(frankfurter=_frankfurter_rates(), nbrb=_nbrb_rates())
        await fetch_daily_rates(fx_sessionmaker, fetcher, backfill_days=_BACKFILL_DAYS)
        first = await _stored(fx_sessionmaker)
        assert set(first) == set(CANONICAL_PAIRS)

        # Same day, corrected EUR->USD: the re-run must converge on the PK, not
        # insert a seventh row.
        fetcher.frankfurter = _frankfurter_rates("1.20")
        await fetch_daily_rates(fx_sessionmaker, fetcher, backfill_days=_BACKFILL_DAYS)
        second = await _stored(fx_sessionmaker)

        assert set(second) == set(CANONICAL_PAIRS)
        assert second[("EUR", "USD")].rate == Decimal("1.20")
        assert second[("EUR", "USD")].fetched_at > first[("EUR", "USD")].fetched_at
        assert second[("BYN", "USD")].rate == first[("BYN", "USD")].rate

    @pytest.mark.parametrize(
        "error",
        [FxFetchError(NBRB, "HTTP_ERROR"), RuntimeError("provider exploded")],
        ids=["taxonomy-error", "unexpected-error"],
    )
    async def test_one_provider_failing_never_blocks_the_other(
        self, fx_sessionmaker: async_sessionmaker[AsyncSession], error: Exception
    ) -> None:
        fetcher = _FakeFetcher(
            frankfurter=_frankfurter_rates(), nbrb=_nbrb_rates(), nbrb_error=error
        )

        # The job must not raise, whichever except branch catches.
        await fetch_daily_rates(fx_sessionmaker, fetcher, backfill_days=_BACKFILL_DAYS)

        stored = await _stored(fx_sessionmaker)
        assert set(stored) == {("EUR", "USD")}


class TestBackfillTrigger:
    """The history/latest decision is PER PROVIDER, not per table (grooming AM-2)."""

    async def test_both_providers_empty_fetch_history(
        self, fx_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        fetcher = _FakeFetcher(frankfurter=_frankfurter_rates(), nbrb=_nbrb_rates())

        await fetch_daily_rates(fx_sessionmaker, fetcher, backfill_days=_BACKFILL_DAYS)

        assert fetcher.calls == [(FRANKFURTER, "history"), (NBRB, "history")]
        window = (_TODAY - timedelta(days=_BACKFILL_DAYS), _TODAY)
        assert fetcher.windows == {FRANKFURTER: window, NBRB: window}

    async def test_provider_with_rows_takes_latest_while_the_other_backfills(
        self, fx_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        # The AM-2 case: a partial first backfill (frankfurter landed, NBRB failed).
        # A global emptiness probe would see a non-empty table and leave NBRB
        # without history forever.
        await _seed(fx_sessionmaker, [("EUR", "USD")], as_of=_TODAY - timedelta(days=5))
        fetcher = _FakeFetcher(frankfurter=_frankfurter_rates(), nbrb=_nbrb_rates())

        await fetch_daily_rates(fx_sessionmaker, fetcher, backfill_days=_BACKFILL_DAYS)

        assert fetcher.calls == [(FRANKFURTER, "latest"), (NBRB, "history")]
        assert set(fetcher.windows) == {NBRB}

    async def test_both_providers_populated_take_latest(
        self, fx_sessionmaker: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed(
            fx_sessionmaker,
            [("EUR", "USD"), ("BYN", "USD")],
            as_of=_TODAY - timedelta(days=5),
        )
        fetcher = _FakeFetcher(frankfurter=_frankfurter_rates(), nbrb=_nbrb_rates())

        await fetch_daily_rates(fx_sessionmaker, fetcher, backfill_days=_BACKFILL_DAYS)

        assert fetcher.calls == [(FRANKFURTER, "latest"), (NBRB, "latest")]
        assert fetcher.windows == {}


class TestCatchUpNeeded:
    async def test_empty_table_needs_catch_up(self, db_session: AsyncSession) -> None:
        assert await catch_up_needed(db_session, today=_TODAY) is True

    async def test_all_pairs_recent_does_not(
        self,
        db_session: AsyncSession,
        fx_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        await _seed(fx_sessionmaker, list(CANONICAL_PAIRS), as_of=_TODAY)

        assert await catch_up_needed(db_session, today=_TODAY) is False

    async def test_one_stale_pair_is_enough(
        self,
        db_session: AsyncSession,
        fx_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        # Every pair recent except BYN->EUR, whose only row predates the 3-day lag.
        fresh = [pair for pair in CANONICAL_PAIRS if pair != ("BYN", "EUR")]
        await _seed(fx_sessionmaker, fresh, as_of=_TODAY)
        await _seed(
            fx_sessionmaker, [("BYN", "EUR")], as_of=_TODAY - timedelta(days=10)
        )

        assert await catch_up_needed(db_session, today=_TODAY) is True


class TestScopeConstraints:
    """The two 0005 CHECKs the write paths rely on, proved through the ORM."""

    async def test_half_set_snapshot_pair_is_rejected(
        self, db_session: AsyncSession
    ) -> None:
        user_id = uuid.uuid4()
        await db_session.execute(
            text(
                "INSERT INTO users (id, email, hashed_password) "
                "VALUES (:id, :email, :pw)"
            ),
            {"id": user_id, "email": "snapshot@x.com", "pw": "x"},
        )
        account = await add_account(db_session, user_id, "USD")
        db_session.add(
            Transaction(
                user_id=user_id,
                account_id=account.id,
                amount_minor=1000,
                kind="expense",
                currency="USD",
                occurred_at=_TODAY,
                base_amount_minor=500,  # base_currency left NULL -> CHECK must fire
            )
        )

        with pytest.raises(IntegrityError, match="base_snapshot_pair"):
            await db_session.commit()

    async def test_non_positive_rate_is_rejected(
        self, db_session: AsyncSession
    ) -> None:
        db_session.add(
            ExchangeRate(
                base="EUR",
                quote="USD",
                as_of_date=_TODAY,
                rate=Decimal("0"),
                provider="nbrb",
            )
        )

        with pytest.raises(IntegrityError, match="rate_positive"):
            await db_session.commit()
