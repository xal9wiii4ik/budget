"""Pure due-date math for recurring templates (D3) — no DB, no fixtures.

Every materialized row's DATE comes from this module, so what is pinned here is
exactly what is genuinely breakable: the short-month clamp (including the leap
arm), the strictly-after watermark contract, the 0=Monday weekday convention in
both spellings, the half-open-left catch-up window, the 366 cap being resumable
rather than lossy, and the missing-anchor precondition the DB CHECK enforces.
"""

from datetime import date

import pytest

from budget_api.domain.recurrence import (
    MAX_OCCURRENCES,
    due_dates_between,
    monthly_due,
    next_due,
)
from budget_api.enums import RecurrenceUnit


class TestMonthlyClamp:
    @pytest.mark.parametrize(
        ("year", "month", "day_of_month", "expected"),
        [
            (2026, 1, 31, date(2026, 1, 31)),
            (2026, 2, 31, date(2026, 2, 28)),
            # Leap February: the clamp is calendar-aware, not a hardcoded 28.
            (2028, 2, 31, date(2028, 2, 29)),
            (2026, 4, 31, date(2026, 4, 30)),
            # No-clamp contrast: an in-range day is returned untouched, so the
            # clamp cannot be "always the last day of the month".
            (2026, 2, 15, date(2026, 2, 15)),
        ],
        ids=["jan-31", "feb-28", "feb-leap-29", "apr-30", "feb-15-no-clamp"],
    )
    def test_monthly_day_clamps_to_short_months(
        self, year: int, month: int, day_of_month: int, expected: date
    ) -> None:
        assert monthly_due(year, month, day_of_month) == expected


class TestNextDue:
    def test_next_due_is_strictly_after_the_anchor(self) -> None:
        # The watermark contract: the job enumerates (last_materialized_on, ...],
        # so the anchor day itself must NOT come back — a `>=` bug would duplicate
        # every already-materialized occurrence.
        assert next_due(
            RecurrenceUnit.month,
            day_of_month=15,
            weekday=None,
            after=date(2026, 3, 15),
        ) == date(2026, 4, 15)
        # ...while the day before it still yields this month's occurrence (the arm
        # that a `>` bug alone would pass).
        assert next_due(
            RecurrenceUnit.month,
            day_of_month=15,
            weekday=None,
            after=date(2026, 3, 14),
        ) == date(2026, 3, 15)

    def test_next_due_resumes_from_a_clamped_watermark(self) -> None:
        # The clamp x strictly-after crossing. For dom=31, February's due date IS
        # Feb 28 (clamped), so Feb 28 is also the watermark the job stored;
        # resuming from it must yield Mar 31. This is the arm that fails for the
        # plausible implementation that compares the RAW anchor against the
        # watermark (`day_of_month > after.day` -> 31 > 28 -> "February is still
        # ahead"), which would hand back the already-materialized Feb 28 forever.
        # Every dom=15 / dom=1 arm in this file passes that bug.
        assert next_due(
            RecurrenceUnit.month,
            day_of_month=31,
            weekday=None,
            after=date(2026, 2, 28),
        ) == date(2026, 3, 31)
        # ...one day earlier still yields the clamped Feb 28: the clamped day is a
        # real due date in its own month, not a month the template skips.
        assert next_due(
            RecurrenceUnit.month,
            day_of_month=31,
            weekday=None,
            after=date(2026, 2, 27),
        ) == date(2026, 2, 28)

    @pytest.mark.parametrize(
        ("weekday", "expected"),
        [
            (0, date(2026, 8, 24)),
            (1, date(2026, 8, 25)),
            # after IS the anchor weekday -> next week's, never the same day.
            (2, date(2026, 8, 26)),
            (3, date(2026, 8, 20)),
            (4, date(2026, 8, 21)),
            (5, date(2026, 8, 22)),
            (6, date(2026, 8, 23)),
        ],
        ids=["mon", "tue", "wed-same-weekday", "thu", "fri", "sat", "sun"],
    )
    def test_weekly_weekday_is_monday_zero_and_strictly_after(
        self, weekday: int, expected: date
    ) -> None:
        after = date(2026, 8, 19)  # a Wednesday
        result = next_due(
            RecurrenceUnit.week, day_of_month=None, weekday=weekday, after=after
        )
        assert result == expected
        # Both spellings of the convention: 0 = Monday. JavaScript's getDay() is
        # 0 = Sunday, so an off-by-one here is silently wrong for six of seven.
        assert result.weekday() == weekday
        assert result.isoweekday() - 1 == weekday


class TestDueDatesBetween:
    def test_due_dates_between_catch_up_window(self) -> None:
        three_months = due_dates_between(
            RecurrenceUnit.month,
            day_of_month=1,
            weekday=None,
            after=date(2025, 12, 15),
            through=date(2026, 3, 10),
        )
        assert three_months == [date(2026, 1, 1), date(2026, 2, 1), date(2026, 3, 1)]
        # `through` exactly ON a due date still includes it (half-open LEFT).
        assert (
            due_dates_between(
                RecurrenceUnit.month,
                day_of_month=1,
                weekday=None,
                after=date(2025, 12, 15),
                through=date(2026, 3, 1),
            )
            == three_months
        )
        # ...one day short of March excludes it — the contrast that proves the
        # right edge is inclusive, not "the whole month of `through`".
        assert due_dates_between(
            RecurrenceUnit.month,
            day_of_month=1,
            weekday=None,
            after=date(2025, 12, 15),
            through=date(2026, 2, 28),
        ) == [date(2026, 1, 1), date(2026, 2, 1)]

    def test_due_dates_between_walks_dom_31_across_february(self) -> None:
        # The clamping arm walked end to end: every step resumes from the PREVIOUS
        # clamped date, so the raw-comparison bug described in
        # TestNextDue.test_next_due_resumes_from_a_clamped_watermark stalls on
        # 2026-02-28 and repeats it up to the cap instead of advancing. Also pins
        # that the clamp is recomputed per month (Feb 28, Apr 30) and never rolls
        # into the following month.
        assert due_dates_between(
            RecurrenceUnit.month,
            day_of_month=31,
            weekday=None,
            after=date(2026, 1, 15),
            through=date(2026, 4, 30),
        ) == [
            date(2026, 1, 31),
            date(2026, 2, 28),
            date(2026, 3, 31),
            date(2026, 4, 30),
        ]

    def test_due_dates_between_is_capped_and_resumable(self) -> None:
        # 2018-08-01 -> 2026-08-18 is 420 Mondays: enough to overshoot the 366 cap
        # by a margin no fixture-length coincidence can fake.
        through = date(2026, 8, 18)
        first_run = due_dates_between(
            RecurrenceUnit.week,
            day_of_month=None,
            weekday=0,
            after=date(2018, 8, 1),
            through=through,
        )
        assert len(first_run) == MAX_OCCURRENCES == 366
        assert first_run[0] == date(2018, 8, 6)  # first Monday after the watermark
        assert first_run[-1] == date(2025, 8, 4)

        # Capped, not dropped: re-enumerating from the returned last date (which is
        # what the job stores as the watermark) yields the remaining 54.
        second_run = due_dates_between(
            RecurrenceUnit.week,
            day_of_month=None,
            weekday=0,
            after=first_run[-1],
            through=through,
        )
        assert len(second_run) == 420 - MAX_OCCURRENCES == 54
        assert second_run[0] == date(2025, 8, 11)
        assert second_run[-1] == date(2026, 8, 17)

        # Third run: fully caught up, nothing left.
        assert (
            due_dates_between(
                RecurrenceUnit.week,
                day_of_month=None,
                weekday=0,
                after=second_run[-1],
                through=through,
            )
            == []
        )

        # Contrast: a four-week window returns 4 — the cap is a ceiling, not a
        # constant-length answer.
        assert due_dates_between(
            RecurrenceUnit.week,
            day_of_month=None,
            weekday=0,
            after=date(2026, 7, 20),
            through=date(2026, 8, 17),
        ) == [
            date(2026, 7, 27),
            date(2026, 8, 3),
            date(2026, 8, 10),
            date(2026, 8, 17),
        ]

    @pytest.mark.parametrize(
        ("unit", "day_of_month", "weekday"),
        [
            (RecurrenceUnit.month, 15, None),
            (RecurrenceUnit.week, None, 0),
        ],
        ids=["month", "week"],
    )
    def test_empty_window_yields_no_dates(
        self, unit: RecurrenceUnit, day_of_month: int | None, weekday: int | None
    ) -> None:
        watermark = date(2026, 8, 18)
        # Already caught up (through == the watermark)...
        assert (
            due_dates_between(
                unit,
                day_of_month=day_of_month,
                weekday=weekday,
                after=watermark,
                through=watermark,
            )
            == []
        )
        # ...and ended before the watermark (through < it).
        assert (
            due_dates_between(
                unit,
                day_of_month=day_of_month,
                weekday=weekday,
                after=watermark,
                through=date(2026, 8, 1),
            )
            == []
        )


class TestAnchorPrecondition:
    def test_missing_anchor_for_its_unit_raises(self) -> None:
        after = date(2026, 8, 18)
        # A monthly template reads day_of_month only: a stray weekday cannot stand
        # in for it (and vice versa).
        with pytest.raises(ValueError, match="day_of_month"):
            next_due(RecurrenceUnit.month, day_of_month=None, weekday=3, after=after)
        with pytest.raises(ValueError, match="weekday"):
            next_due(RecurrenceUnit.week, day_of_month=15, weekday=None, after=after)
        # Matching pairs return a date — the accept contrast without which both
        # raises could pass against a function that always raised.
        assert next_due(
            RecurrenceUnit.month, day_of_month=15, weekday=None, after=after
        ) == date(2026, 9, 15)
        assert next_due(
            RecurrenceUnit.week, day_of_month=None, weekday=3, after=after
        ) == date(2026, 8, 20)
