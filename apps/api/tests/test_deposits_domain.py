"""Deposit interest math — pure unit tests over ``domain/deposits.py``.

The whole point of extracting this module is that these numbers can be pinned at a
FIXED ``as_of`` with no database and no clock. Only the boundaries listed in
``.tasks/deposits/architecture.md`` §"Расчёт процентов" are covered; the ordinary
"a deposit earns interest" case is proved by the API tests, which need a real
timeline anyway.

Every expected figure below is arithmetic a human can redo:
``principal * rate% * days / 365``. 100000 minor units at 10.95 % is exactly 30.00
per 100 days, which is why that rate is used throughout — a rounding change shows
up as a whole minor unit, not as noise in the last digit.
"""

from dataclasses import replace
from datetime import date
from decimal import Decimal
from typing import Any

from budget_api.domain.deposits import (
    AccrualInput,
    TimelineEntry,
    accrued_minor,
    after_tax_minor,
)
from budget_api.enums import DepositCapitalization

RATE = Decimal("10.95")
OPENED = date(2025, 1, 1)
BODY = 100_000


#: The deposit every test below starts from: 1000.00 opened on 2025-01-01, simple
#: interest, read exactly 100 days later. Each test states its own deviation via
#: ``dataclasses.replace``, so what a case is ABOUT is the only thing it spells out.
_BASE = AccrualInput(
    rate_percent=RATE,
    capitalization=DepositCapitalization.none,
    opened_on=OPENED,
    term_end=None,
    timeline=[TimelineEntry(on=OPENED, delta_minor=BODY)],
    as_of=date(2025, 4, 11),  # exactly 100 days after OPENED
)


def _accrued(**overrides: Any) -> int:
    return accrued_minor(replace(_BASE, **overrides))


class TestDayCount:
    def test_leap_year_pays_366_days_over_a_365_day_divisor(self) -> None:
        # actual/365 FIXED is the chosen convention: a leap year is 366 actual days
        # over the same divisor, so it pays 366/365 of the nominal rate. An
        # actual/actual implementation would return 10950 here and pass every other
        # test in this file — this is the one place the two conventions differ.
        leap = _accrued(
            opened_on=date(2024, 1, 1),
            timeline=[TimelineEntry(on=date(2024, 1, 1), delta_minor=BODY)],
            as_of=date(2025, 1, 1),
        )
        ordinary = _accrued(as_of=date(2026, 1, 1))

        assert ordinary == 10_950  # 100000 * 10.95 % * 365/365
        assert leap == 10_980  # 100000 * 10.95 % * 366/365

    def test_zero_rate_earns_nothing_over_any_window(self) -> None:
        # Not a tautology: the segment walk still runs, and a division that assumed
        # a non-zero rate (or a "no rate → use the default" fallback) would show up
        # here as a non-zero number.
        assert _accrued(rate_percent=Decimal(0), as_of=date(2030, 1, 1)) == 0


class TestTermEnd:
    def test_accrual_freezes_on_term_end_however_long_ago_it_was(self) -> None:
        # The forecast of a matured deposit must be a CONSTANT: two reads a year
        # apart return the same number, and it is the number for the term, not for
        # the time since it was opened.
        frozen = _accrued(term_end=date(2025, 4, 11), as_of=date(2025, 12, 31))
        much_later = _accrued(term_end=date(2025, 4, 11), as_of=date(2027, 6, 1))

        assert frozen == much_later == 3_000  # 100 days, not 364 and not 881

    def test_at_maturity_equals_simple_interest_with_and_without_a_term(self) -> None:
        # Capitalizing AT maturity adds the interest to the body at the very moment
        # accrual stops, so it can earn nothing further: the honest total is the
        # simple-interest one. Pinned deliberately — an implementation that made
        # this mode pay MORE would be counting the final capitalization twice.
        # With no term at all there is nothing to mature into, so the same holds.
        simple = _accrued(as_of=date(2026, 1, 1))
        at_maturity = _accrued(
            capitalization=DepositCapitalization.at_maturity,
            term_end=date(2026, 1, 1),
            as_of=date(2026, 1, 1),
        )
        open_ended = _accrued(
            capitalization=DepositCapitalization.at_maturity, as_of=date(2026, 1, 1)
        )

        assert at_maturity == open_ended == simple == 10_950


class TestCapitalization:
    def test_monthly_and_quarterly_beat_simple_over_the_same_year(self) -> None:
        # The three modes must be three different numbers, ordered — a mode that
        # silently fell through to simple interest is the failure this catches, and
        # the gap (5.70 and 4.58 on 1000.00) is what the user is told they earn.
        year_end = date(2026, 1, 1)

        assert _accrued(as_of=year_end) == 10_950
        assert (
            _accrued(capitalization=DepositCapitalization.quarterly, as_of=year_end)
            == 11_408
        )
        assert (
            _accrued(capitalization=DepositCapitalization.monthly, as_of=year_end)
            == 11_520
        )

    def test_a_top_up_mid_period_compounds_differently_than_it_accrues(self) -> None:
        # The scenario task.md calls out: a deposit topped up between two
        # capitalization dates. The two modes MUST disagree — if the top-up were
        # (wrongly) applied from the start of the period, or the compounding base
        # were not re-read after it, both numbers would collapse to one.
        timeline = [
            TimelineEntry(on=OPENED, delta_minor=BODY),
            TimelineEntry(on=date(2025, 1, 15), delta_minor=50_000),
        ]
        as_of = date(2025, 4, 1)

        simple = _accrued(timeline=timeline, as_of=as_of)
        monthly = _accrued(
            timeline=timeline,
            capitalization=DepositCapitalization.monthly,
            as_of=as_of,
        )

        # 100000 * 14 days + 150000 * 76 days, at 10.95 %/365.
        assert simple == 3_840
        assert monthly == 3_873


class TestNegativeBody:
    def test_withdrawing_more_than_the_body_stops_accrual_instead_of_reversing_it(
        self,
    ) -> None:
        # The ledger allows the overdraft (it is one account among many); the
        # forecast must not answer it with negative interest, which would read as
        # the bank charging the user for a deposit.
        timeline = [
            TimelineEntry(on=OPENED, delta_minor=BODY),
            TimelineEntry(on=date(2025, 2, 1), delta_minor=-150_000),
        ]

        accrued = _accrued(timeline=timeline, as_of=date(2025, 4, 1))

        # Exactly the 31 days the body was positive, and nothing after it.
        assert accrued == 930
        assert accrued == _accrued(timeline=timeline, as_of=date(2027, 1, 1))


class TestManualOverride:
    def test_the_forecast_continues_from_the_anchor_instead_of_freezing_at_it(
        self,
    ) -> None:
        # "Manual beats computed" must not mean "manual freezes the number": the
        # deposit keeps earning after the correction, at exactly the rate it would
        # have earned without one. The contrast is what proves it — the unanchored
        # deposit gains the SAME 12.30 over the same window, from a different base.
        anchored = _accrued(override=(date(2025, 3, 1), 5_000))
        unanchored_at_anchor_date = _accrued(as_of=date(2025, 3, 1))
        unanchored_now = _accrued()

        assert anchored == 6_230
        assert anchored - 5_000 == unanchored_now - unanchored_at_anchor_date == 1_230

    def test_a_compounding_anchor_joins_the_body_at_the_next_boundary(self) -> None:
        # The anchor is accrued interest, so on a compounding deposit it must start
        # earning at the next capitalization date like any other accrued interest.
        # Simple interest on the same anchor is the contrast: 0.18 less.
        compounding = _accrued(
            capitalization=DepositCapitalization.monthly,
            override=(date(2025, 3, 1), 5_000),
        )

        assert compounding == 6_248
        assert compounding > _accrued(override=(date(2025, 3, 1), 5_000))


class TestTax:
    def test_withholding_rounds_half_up_and_absence_is_not_zero(self) -> None:
        # The withheld part is what gets rounded, so the two figures on screen
        # always subtract to a whole number of minor units: 3005 * 13 % = 390.65 →
        # 391. A truncating implementation would answer 2615.
        assert after_tax_minor(3_005, Decimal("13.00")) == 2_614
        # No rate is a different statement from a zero rate: null, not the gross.
        assert after_tax_minor(3_005, None) is None
        assert after_tax_minor(3_005, Decimal(0)) == 3_005
