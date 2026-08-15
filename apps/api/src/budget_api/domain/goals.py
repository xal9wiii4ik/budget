"""Pure goal math (architecture D11) — stdlib + ``datetime`` only, no IO.

The ``domain/money.py`` / ``domain/fx.py`` precedent: no ORM, no models, no
framework. All amounts are integer minor units in ONE currency per call —
currency conversion happens BEFORE these functions (callers convert via
``domain/fx.py``; the domain never sees two currencies). ``today`` is always an
explicit parameter (testability — nothing here reads the clock).

Rounding is integer-only and explicit (plan S4 resolutions):

- **ceil** (``monthly_needed``, ``months_to_target``): ``-(-a // b)`` — never
  under-asks; no float, no ``math.ceil`` on Decimals.
- **floor toward -∞** (``free_balance_minor``): plain Python ``//`` on ONE
  division of the difference of sums. "Conservative" means never overstating
  the money available for goals, and toward -∞ understates on BOTH signs
  (avg -100.33 → -101, not -100); two per-average floors would also compound
  (⌊i/n⌋ - ⌊e/n⌋ ≠ ⌊(i-e)/n⌋). Recorded as plan S4 Disagreement §1.

No Decimal quantization occurs here — where it does elsewhere, ROUND_HALF_UP is
the codebase's single money-rounding mode (``domain/money.py``, ``domain/fx.py``).
"""

import calendar
import uuid
from collections.abc import Sequence
from datetime import date


def months_until(today: date, deadline: date) -> int:
    """Whole calendar months from ``today`` to ``deadline``, floored at 0.

    ``(deadline.year - today.year) * 12 + (deadline.month - today.month)`` —
    day-of-month is deliberately ignored: a deadline "May 2027" means "by May",
    and documenting this beats fake precision (D11). Past or same-month → 0.
    """
    months = (deadline.year - today.year) * 12 + (deadline.month - today.month)
    return max(months, 0)


def monthly_needed(target_minor: int, saved_minor: int, months_left: int) -> int:
    """Minor units to save per month to hit ``target_minor`` in ``months_left``.

    ``remaining = max(target - saved, 0)``; already reached → 0.
    ``months_left <= 0`` → full ``remaining`` (deadline passed/this month: need
    it all now; the realism check will call it unrealistic — honest, not an
    error). Else integer ceil — never under-asks.
    """
    remaining = max(target_minor - saved_minor, 0)
    if remaining == 0:
        return 0
    if months_left <= 0:
        return remaining
    return -(-remaining // months_left)


def free_balance_minor(
    monthly_income_minor: Sequence[int], monthly_expense_minor: Sequence[int]
) -> int:
    """Average monthly surplus over the caller-supplied full-month history.

    Inputs are per-month base-currency sums for the last 3 FULL calendar months
    (current partial month EXCLUDED — it always under-states both sides); with
    fewer than 3 months of history the caller passes what exists (>= 1 month).
    Equal lengths are a caller invariant (asserted). Empty history → 0.

    One floor-toward -∞ division on the difference of sums — see the module
    docstring for why this direction and shape are the conservative ones. May
    be negative (spending exceeds income).
    """
    assert len(monthly_income_minor) == len(monthly_expense_minor)
    n = len(monthly_income_minor)
    if n == 0:
        return 0
    return (sum(monthly_income_minor) - sum(monthly_expense_minor)) // n


def is_realistic(monthly_needed_minor: int, available_monthly_minor: int) -> bool:
    """Whether the required monthly saving fits the available monthly surplus.

    ``needed <= 0`` → True short-circuit: nothing needed is always realistic,
    even with a negative surplus — D11's literal ``needed <= available`` would
    label an already-reached goal unrealistic (plan S4 Disagreement §2). Else
    ``needed <= available`` (so ``available <= 0`` with ``needed > 0`` → False).
    """
    if monthly_needed_minor <= 0:
        return True
    return monthly_needed_minor <= available_monthly_minor


def months_to_target(
    target_minor: int, saved_minor: int, available_monthly_minor: int
) -> int | None:
    """Reverse calc for "сдвинуть дедлайн": months to reach target at current pace.

    ``remaining <= 0`` → 0 (reached — regardless of the surplus);
    ``available <= 0`` → None (unreachable — the UI's honest message);
    else integer ceil of ``remaining / available``.
    """
    remaining = target_minor - saved_minor
    if remaining <= 0:
        return 0
    if available_monthly_minor <= 0:
        return None
    return -(-remaining // available_monthly_minor)


def suggested_deadline(today: date, months: int) -> date | None:
    """``today`` + ``months`` calendar months, day clamped to the target month's end.

    Jan 31 + 1 month → Feb 28 (Feb 29 in a leap year) via
    ``calendar.monthrange``; days that fit are preserved as-is.

    ``months_to_target`` is unbounded (a tiny surplus against a large remainder
    yields a huge ceil), but ``datetime.MAXYEAR`` is 9999 — an impossible
    horizon returns ``None`` instead of overflowing ``date`` (the wire field is
    already nullable; callers never see exceptions).
    """
    total = today.year * 12 + (today.month - 1) + months
    year, month = divmod(total, 12)
    month += 1
    if year > 9999:
        return None
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(today.day, last_day))


def split_by_priority(
    free_minor: int,
    # needs items: (goal_id, monthly_needed_minor, priority)
    needs: Sequence[tuple[uuid.UUID, int, int]],
) -> dict[uuid.UUID, int]:
    """WATERFALL split of the free balance across goals by priority.

    Sort by priority (lower = higher priority) with the caller-provided order —
    ``created_at`` — breaking ties via stable sort. Sequential
    ``alloc = min(monthly_needed, remaining)``: each goal fills fully before the
    next, the first unfilled goal receives the partial remainder, later goals 0
    (plan S4 resolution — all-or-nothing would leave free money unallocated).
    ``free_minor <= 0`` → all zeros. Proportional split rejected: priorities
    decide, and waterfall is explainable in one sentence (OQ-7).
    """
    remaining = max(free_minor, 0)
    allocations: dict[uuid.UUID, int] = {}
    for goal_id, needed, _priority in sorted(needs, key=lambda need: need[2]):
        alloc = min(max(needed, 0), remaining)
        allocations[goal_id] = alloc
        remaining -= alloc
    return allocations
