"""Pure calendar math for reporting periods (architecture D5).

Imports stdlib only — no models, no session, no Pydantic. Every window is
``[from, to_exclusive)`` internally; the WIRE echoes an inclusive ``to``
(``to_exclusive - 1 day``), which is the routers' job, not this module's.

The anchor strings (``"2026-08"``, ``"2026-Q1"``) are validated at the Query
layer with the patterns exported here (AM-6: pattern-validate on the boundary,
never parse-then-catch), so the parsers below can index the string without
guarding — a malformed anchor is a 422 before they are reached.

``shift_month`` moved here verbatim from ``routers/goals.py`` when the stats
window math became its second consumer (the first/second-consumer extraction
rule); the goals router imports it from here now.
"""

from datetime import date, timedelta
from enum import StrEnum

#: ONE year envelope for all four grammars. Anchors near ``date.max`` are
#: syntactically fine but arithmetically fatal — ``month_bounds("9999-12")`` asks
#: for ``date(10000, 1, 1)`` and ``to=9999-12-31`` has no representable exclusive
#: successor — so the envelope is what keeps every *valid* request off a 500.
#: 1970 is the epoch floor; 2999 is the ceiling the ``year`` query param already
#: declared, and month/quarter/custom now match it instead of each inventing one.
MIN_YEAR = 1970
MAX_YEAR = 2999
MIN_DATE = date(MIN_YEAR, 1, 1)
MAX_DATE = date(MAX_YEAR, 12, 31)

#: Moved from routers/transactions.py (the shipped ``/summary`` pattern) — a new
#: router importing a private name out of another router is coupling, not reuse —
#: with the year alternation widened from ``\d{4}`` to the envelope above. AM-6:
#: the boundary pattern IS the validator, so the range belongs in the regex and an
#: out-of-envelope anchor is an automatic 422, never a parse-then-catch. The two
#: alternations spell out ``MIN_YEAR``/``MAX_YEAR``; keep them in step.
MONTH_PATTERN = r"^(19[7-9]\d|2\d{3})-(0[1-9]|1[0-2])$"
QUARTER_PATTERN = r"^(19[7-9]\d|2\d{3})-Q[1-4]$"


class PeriodUnit(StrEnum):
    """The four period grammars (D5). Wire values; used as a query enum."""

    month = "month"
    quarter = "quarter"
    year = "year"
    custom = "custom"


def shift_month(first_of_month: date, months: int) -> date:
    """First-of-month shifted by ``months`` — window boundaries only, no money."""
    total = first_of_month.year * 12 + (first_of_month.month - 1) + months
    year, month0 = divmod(total, 12)
    return date(year, month0 + 1, 1)


def month_key(d: date) -> str:
    """``date`` → ``"YYYY-MM"`` (the wire key of a monthly point)."""
    return f"{d.year:04d}-{d.month:02d}"


def month_bounds(month: str) -> tuple[date, date]:
    """``"2026-08"`` → ``(2026-08-01, 2026-09-01)``. Caller pattern-validates."""
    first = date(int(month[:4]), int(month[5:7]), 1)
    return first, shift_month(first, 1)


def quarter_bounds(quarter: str) -> tuple[date, date]:
    """``"2026-Q1"`` → ``(2026-01-01, 2026-04-01)``. Caller pattern-validates."""
    first = date(int(quarter[:4]), (int(quarter[6]) - 1) * 3 + 1, 1)
    return first, shift_month(first, 3)


def year_bounds(year: int) -> tuple[date, date]:
    """``2026`` → ``(2026-01-01, 2027-01-01)``."""
    return date(year, 1, 1), date(year + 1, 1, 1)


def previous_period(
    unit: PeriodUnit, date_from: date, date_to_exclusive: date
) -> tuple[date, date]:
    """The window immediately preceding ``[date_from, date_to_exclusive)``.

    Calendar-previous for month/quarter/year (February follows January whether it
    has 28 days or 29 — a fixed-length shift would land mid-month); for ``custom``
    it is the same-length window ending exactly at ``date_from``. The invariant
    for all four units: the returned ``to_exclusive`` IS ``date_from``.

    A degenerate custom window (``to_exclusive <= from``, i.e. ``from > to`` —
    a read filter that never errors) has an empty previous window, and the span
    is clamped at ``date.min`` so an absurd range cannot overflow ``date``.
    """
    if unit is PeriodUnit.month:
        return shift_month(date_from, -1), date_from
    if unit is PeriodUnit.quarter:
        return shift_month(date_from, -3), date_from
    if unit is PeriodUnit.year:
        return date(date_from.year - 1, 1, 1), date_from
    span = (date_to_exclusive - date_from).days
    if span <= 0:
        return date_from, date_from
    return date_from - timedelta(days=min(span, (date_from - date.min).days)), date_from
