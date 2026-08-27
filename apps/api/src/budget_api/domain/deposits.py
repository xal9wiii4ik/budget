"""Pure deposit-interest math (deposits architecture §"Расчёт процентов").

Imports stdlib + ``decimal`` + ``domain/`` + ``enums.py`` only — no models, no
session, no framework (the ``domain/recurrence.py`` precedent, whose
``monthly_due`` clamp this module reuses for capitalization anniversaries rather
than growing a second month-arithmetic).

Nothing here reads the clock or the database: ``as_of`` and the whole timeline are
parameters, which is what makes a year-old deposit and today's one the same code
path.

Three rules the whole module hangs on:

* **Day count is actual/365 fixed** — ONE convention (:data:`_DAYS_IN_YEAR`).
  Retail BY/RU deposits are quoted this way, and actual/actual would buy a
  fraction of a kopeck in a FORECAST at the price of a leap-year branch. A leap
  year therefore yields 366/365 of a year's rate, deliberately, and a test pins it.
* **Money is integer minor units, rates are Decimal, and float appears nowhere.**
  Intermediate interest is carried as an unrounded ``Decimal``; ROUND_HALF_UP (the
  codebase's single money-rounding mode, ``domain/money.py``) is applied when — and
  only when — money actually becomes money: at each capitalization boundary and
  once at the end.
* **A negative body earns nothing** (``max(principal, 0)``). The ledger permits
  withdrawing more than is there; negative interest is not a thing this product
  invents on the way out.

The manual anchor (``override``) is the whole "manual beats computed" rule
(task.md §4) expressed in the math: the forecast RESUMES from the anchor instead
of freezing at it. Freezing would make the number a lie one day later; discarding
it would make the user's own correction disappear on the next read. So the anchor
seeds the accrued balance at its own date, and for a compounding deposit it joins
the principal at the next boundary like any other accrued interest.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from itertools import pairwise

from budget_api.domain.recurrence import monthly_due
from budget_api.enums import DepositCapitalization

#: Actual/365 FIXED — see the module docstring. Not a setting: a deposit whose
#: day-count convention changed between two reads would restate its own history.
_DAYS_IN_YEAR = Decimal(365)
_HUNDRED = Decimal(100)
#: Months between capitalization boundaries, per mode. ``none`` and
#: ``at_maturity`` are absent on purpose: neither produces a boundary at all
#: (see ``_capitalization_boundaries`` for why ``at_maturity`` produces none).
_BOUNDARY_MONTHS: dict[DepositCapitalization, int] = {
    DepositCapitalization.monthly: 1,
    DepositCapitalization.quarterly: 3,
}


@dataclass(frozen=True)
class TimelineEntry:
    """One movement of the deposit's BODY, in minor units of its own currency.

    Seeded from two sources by ``services/deposit_reads.py`` and from nowhere else:
    the opening body ``(opened_on, starting_balance_minor)`` (AMENDMENT §1) and
    every transfer leg touching the deposit's account. ``delta_minor`` is signed —
    a withdrawal is negative.
    """

    on: date
    delta_minor: int


@dataclass(frozen=True)
class AccrualInput:
    """Everything :func:`accrued_minor` needs. No currency: minor units in, minor
    units out, and the exponent never enters the arithmetic (a rate applies to a
    number of minor units the same way whatever the exponent)."""

    rate_percent: Decimal
    capitalization: DepositCapitalization
    opened_on: date
    #: ``None`` = open-ended: accrual runs to ``as_of`` and never freezes.
    term_end: date | None
    timeline: Sequence[TimelineEntry]
    as_of: date
    #: ``(taken_on, accrued_minor)`` — the user's correction and the date it was
    #: true on. The server stamps that date; a client never sends it.
    override: tuple[date, int] | None = None


def _quantize(amount: Decimal) -> int:
    """Decimal → integer minor units, ROUND_HALF_UP (the codebase's one mode)."""
    return int(amount.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _capitalization_boundaries(
    capitalization: DepositCapitalization,
    *,
    opened_on: date,
    start: date,
    end: date,
) -> list[date]:
    """Dates STRICTLY inside ``(start, end)`` at which accrued interest joins the body.

    Anniversaries are counted from ``opened_on`` — never from the previous
    boundary — so a deposit opened on the 31st capitalizes on Feb 28 and then
    again on Mar 31 instead of walking backwards a day a month
    (``domain/recurrence.py:monthly_due`` owns that clamp).

    The interval is OPEN at both ends on purpose: a boundary at ``end`` would only
    round the very same total one step earlier, and rounding money twice for one
    read is how two reads of one deposit start to disagree.

    ``at_maturity`` therefore has NO boundary at all. Its only candidate is
    ``term_end``, and accrual already stops at ``min(as_of, term_end)`` — so the
    candidate is always AT or after ``end``, i.e. outside the open interval.
    Rounding at the point where accrual stops changes nothing: the accumulated
    interest is rounded once in the final step either way. An ``at_maturity``
    deposit is thus simple interest on reads (the honest reading, pinned by
    ``test_at_maturity_equals_simple_interest_with_and_without_a_term``), and with
    no term at all there is nothing to mature into to begin with.
    """
    if capitalization in (
        DepositCapitalization.none,
        DepositCapitalization.at_maturity,
    ):
        return []
    step = _BOUNDARY_MONTHS[capitalization]
    boundaries: list[date] = []
    index = 1
    while True:
        # Month index arithmetic (0-based months since year 0) — the same shape
        # domain/recurrence.py uses to step a monthly template.
        months = opened_on.year * 12 + opened_on.month - 1 + step * index
        year, month_index = divmod(months, 12)
        moment = monthly_due(year, month_index + 1, opened_on.day)
        index += 1
        if moment <= start:
            continue
        if moment >= end:
            return boundaries
        boundaries.append(moment)


def accrued_minor(inp: AccrualInput) -> int:
    """Interest accrued on the deposit as of ``as_of``, GROSS, in minor units.

    Stops at ``min(as_of, term_end)``: after the term the number freezes on the end
    date, because a matured deposit that kept growing on screen would be the app
    lying about money every day (architecture §Срок).

    Returns the anchor value unchanged when there is no time to accrue over — and
    ``0``, never a negative number, when there is none and no anchor either.
    """
    start = inp.opened_on if inp.override is None else inp.override[0]
    anchor_minor = 0 if inp.override is None else inp.override[1]
    end = inp.as_of if inp.term_end is None else min(inp.as_of, inp.term_end)
    if end <= start:
        return anchor_minor

    boundaries = _capitalization_boundaries(
        inp.capitalization,
        opened_on=inp.opened_on,
        start=start,
        end=end,
    )
    # Segment edges: every date at which either the body or the compounding base
    # changes. A movement dated exactly ``end`` is deliberately outside — money
    # that arrives today has not earned anything today.
    edges = sorted(
        {start, end}
        | {entry.on for entry in inp.timeline if start < entry.on < end}
        | set(boundaries)
    )
    boundary_set = set(boundaries)

    #: Interest already capitalized (i.e. already part of the body), integer minor.
    capitalized_minor = 0
    #: Interest accrued since the last capitalization, unrounded. For a compounding
    #: deposit the anchor sits here, so it joins the body at the next boundary.
    pending = Decimal(anchor_minor)
    for segment_start, segment_end in pairwise(edges):
        if segment_start in boundary_set:
            # The bank credits whole minor units; the sub-unit remainder is not
            # carried forward, exactly as a real capitalization drops it.
            capitalized_minor += _quantize(pending)
            pending = Decimal(0)
        body = sum(
            entry.delta_minor for entry in inp.timeline if entry.on <= segment_start
        )
        principal = max(body + capitalized_minor, 0)
        days = (segment_end - segment_start).days
        pending += (Decimal(principal) * inp.rate_percent * Decimal(days)) / (
            _HUNDRED * _DAYS_IN_YEAR
        )
    return capitalized_minor + _quantize(pending)


def after_tax_minor(gross_minor: int, tax_rate_percent: Decimal | None) -> int | None:
    """What is left after withholding, or ``None`` when no rate is recorded.

    ``None`` is NOT zero and NOT the gross: "this deposit is not taxed as far as we
    know" is a different statement from either, and the client shows the field only
    when the server put a number in it. The withheld part is what gets rounded
    (ROUND_HALF_UP, once), so the net is the gross minus a whole number of minor
    units and the two figures on screen always subtract to the tax shown.
    """
    if tax_rate_percent is None:
        return None
    withheld = _quantize(Decimal(gross_minor) * tax_rate_percent / _HUNDRED)
    return gross_minor - withheld
