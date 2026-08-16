"""Pure calendar math for reporting periods (D5) — no DB, no fixtures.

Only what is genuinely breakable lives here: the per-unit window boundaries and
the CALENDAR (not fixed-length) previous window. ``shift_month`` gets no test of
its own — it moved here byte-identical from the goals router, whose shipped
progress/free-balance suites already exercise it.
"""

from datetime import date

import pytest

from budget_api.domain.periods import (
    PeriodUnit,
    month_bounds,
    previous_period,
    quarter_bounds,
    year_bounds,
)


class TestPeriodBounds:
    @pytest.mark.parametrize(
        ("bounds", "expected"),
        [
            (month_bounds("2026-02"), (date(2026, 2, 1), date(2026, 3, 1))),
            # Leap February: the window still ends on the first of March.
            (month_bounds("2024-02"), (date(2024, 2, 1), date(2024, 3, 1))),
            (month_bounds("2026-12"), (date(2026, 12, 1), date(2027, 1, 1))),
            (quarter_bounds("2026-Q1"), (date(2026, 1, 1), date(2026, 4, 1))),
            # Q4 spans the year boundary — the arm a naive `quarter * 3` breaks on.
            (quarter_bounds("2026-Q4"), (date(2026, 10, 1), date(2027, 1, 1))),
            (year_bounds(2026), (date(2026, 1, 1), date(2027, 1, 1))),
        ],
        ids=["month", "month-leap-feb", "month-december", "q1", "q4", "year"],
    )
    def test_period_bounds_per_unit(
        self, bounds: tuple[date, date], expected: tuple[date, date]
    ) -> None:
        # [from, to_exclusive) — the exclusive end is the first day of the NEXT
        # period, never the last day of this one.
        assert bounds == expected


class TestPreviousPeriod:
    def test_previous_period_is_calendar_not_fixed_length(self) -> None:
        # March has 31 days; its previous period is February (28), NOT "31 days
        # before March 1" (which would land on Jan 29 and cut January in half).
        assert previous_period(
            PeriodUnit.month, date(2026, 3, 1), date(2026, 4, 1)
        ) == (date(2026, 2, 1), date(2026, 3, 1))
        # Quarter and year are calendar-previous too, across the year boundary.
        assert previous_period(
            PeriodUnit.quarter, date(2026, 1, 1), date(2026, 4, 1)
        ) == (date(2025, 10, 1), date(2026, 1, 1))
        assert previous_period(PeriodUnit.year, date(2026, 1, 1), date(2027, 1, 1)) == (
            date(2025, 1, 1),
            date(2026, 1, 1),
        )

    def test_previous_custom_is_same_length_immediately_before(self) -> None:
        # [Mar 10, Mar 20] inclusive = 11 days → the 11 days ending Mar 9.
        # Contrast with the calendar arms above: nothing here is month-aligned.
        assert previous_period(
            PeriodUnit.custom, date(2026, 3, 10), date(2026, 3, 21)
        ) == (date(2026, 2, 27), date(2026, 3, 10))
        # An inverted window (from > to — a read filter, never an error) has an
        # EMPTY previous window; without this arm the subtraction below runs on a
        # negative span and walks the window forward into the future.
        assert previous_period(
            PeriodUnit.custom, date(2026, 3, 20), date(2026, 3, 11)
        ) == (date(2026, 3, 20), date(2026, 3, 20))
        # ...and an absurd span is clamped at date.min instead of overflowing. The
        # routers' year envelope keeps HTTP callers out of this range now, so this
        # pins the pure function's totality, not a reachable 500.
        assert previous_period(
            PeriodUnit.custom, date(1, 1, 1), date(9999, 12, 31)
        ) == (date(1, 1, 1), date(1, 1, 1))
