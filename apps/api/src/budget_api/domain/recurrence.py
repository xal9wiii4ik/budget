"""Pure due-date math for recurring templates (architecture D3).

Imports stdlib (``calendar``/``datetime``) plus ``budget_api.enums`` only — no
models, no session, no framework (the ``domain/periods.py`` / ``domain/goals.py``
precedent). ``enums.py`` has ZERO internal imports and contains only ``StrEnum``
definitions, so no cycle is possible and the domain stays framework-free; the
grooming review amended the domain-purity doctrine in writing to
``stdlib + domain/ + enums.py`` (R1.3) precisely so models and schemas can share
``RecurrenceUnit``.

Nothing here reads the clock: every window boundary is an explicit parameter.
"""

import calendar
from datetime import date, timedelta

from budget_api.enums import RecurrenceUnit

#: Safety valve (D6): a pathological clock jump or a years-forgotten weekly
#: template mass-inserts at most this many rows per template per run; the
#: watermark advances only through what was inserted, so the remainder arrives on
#: subsequent runs. A module constant, not a Settings knob — no one tunes this.
MAX_OCCURRENCES = 366


def monthly_due(year: int, month: int, day_of_month: int) -> date:
    """``min(day_of_month, days_in(month))`` — the D3 clamp rule.

    Day 31 clamps to Jan 31, Feb 28 (29 in a leap year), Apr 30. No skipping, no
    rolling into the next month: a monthly template has exactly one due date per
    month, always inside that month.
    """
    return date(year, month, min(day_of_month, calendar.monthrange(year, month)[1]))


def next_due(
    unit: RecurrenceUnit,
    *,
    day_of_month: int | None,
    weekday: int | None,
    after: date,
) -> date:
    """The first due date STRICTLY after ``after``. Never skips, never rolls over.

    monthly: this month's clamped due date if it is still ahead of ``after``,
    else next month's.
    weekly: ``delta = (weekday - after.weekday()) % 7 or 7`` → ``after + delta``,
    so an ``after`` that already IS the anchor weekday yields the NEXT week's.
    ``weekday`` is 0=Monday (== ``date.weekday()`` == ``isoweekday() - 1``).

    Strictness is the watermark contract: the job enumerates
    ``(last_materialized_on, ...]``, so a due date already materialized must
    never come back.

    Raises ``ValueError`` if the anchor for ``unit`` is ``None`` — a programming
    error, not a user path: the DB CHECK ``anchor_matches_unit`` and the schema
    validators make an inconsistent pair unrepresentable.
    """
    if unit is RecurrenceUnit.month:
        if day_of_month is None:
            raise ValueError("day_of_month is required for a monthly template")
        this_month = monthly_due(after.year, after.month, day_of_month)
        if this_month > after:
            return this_month
        # Index of the month AFTER `after` (0-based months since year 0).
        year, month_index = divmod(after.year * 12 + after.month, 12)
        return monthly_due(year, month_index + 1, day_of_month)
    if weekday is None:
        raise ValueError("weekday is required for a weekly template")
    return after + timedelta(days=(weekday - after.weekday()) % 7 or 7)


def due_dates_between(
    unit: RecurrenceUnit,
    *,
    day_of_month: int | None,
    weekday: int | None,
    after: date,
    through: date,
    limit: int = MAX_OCCURRENCES,
) -> list[date]:
    """Ascending due dates in the HALF-OPEN-LEFT window ``(after, through]``.

    Empty when ``through <= after`` (an ended or already-caught-up template).
    Truncated at ``limit`` — the caller (the job) advances the watermark only
    through what it materialized and logs when the cap is hit, so the remainder
    arrives on the next run rather than being dropped.
    """
    dates: list[date] = []
    cursor = after
    while len(dates) < limit:
        cursor = next_due(
            unit, day_of_month=day_of_month, weekday=weekday, after=cursor
        )
        if cursor > through:
            break
        dates.append(cursor)
    return dates
