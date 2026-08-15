"""Pure goal math (architecture D11) — no DB, no app, no fixtures.

Every D11 edge pinned with a contrasting arm (plan S4 test matrix (a)-(u)):
the calendar-month floor, deadline-passed honesty, both integer rounding idioms
(ceil never under-asks, free-balance floor toward -∞ on BOTH signs), the
reached-goal realism short-circuit (Disagreement §2), month-end clamping
including leap Feb 29, and the waterfall's partial-fill / tie / zero-need arms.
"""

import uuid
from datetime import date

from budget_api.domain.goals import (
    free_balance_minor,
    is_realistic,
    monthly_needed,
    months_to_target,
    months_until,
    split_by_priority,
    suggested_deadline,
)


class TestMonthsUntil:
    def test_past_and_same_month_floor_at_zero(self) -> None:
        # (a) Both non-future cases floor at 0 — never a negative month count.
        assert months_until(date(2026, 8, 15), date(2026, 5, 1)) == 0
        assert months_until(date(2026, 8, 1), date(2026, 8, 31)) == 0

    def test_day_of_month_ignored(self) -> None:
        # (b) Jan 31 → Feb 1 is ONE calendar month (a deadline "Feb" means "by
        # Feb"); a naive day-diff (1 day) would give 0.
        assert months_until(date(2026, 1, 31), date(2026, 2, 1)) == 1


class TestMonthlyNeeded:
    def test_target_reached_is_zero(self) -> None:
        # (c) Reached (and over-saved) → 0, whatever the months left.
        assert monthly_needed(1000, 1000, 5) == 0
        assert monthly_needed(1000, 1200, 5) == 0

    def test_deadline_passed_needs_full_remaining(self) -> None:
        # (d) months_left <= 0 → the whole remainder now (honest, not an error).
        assert monthly_needed(1000, 400, 0) == 600
        assert monthly_needed(1000, 400, -2) == 600

    def test_ceil_exact_vs_one_off(self) -> None:
        # (e) Exact division stays exact; one minor over bumps the whole month up
        # (never under-asks).
        assert monthly_needed(300, 0, 3) == 100
        assert monthly_needed(301, 0, 3) == 101


class TestFreeBalanceMinor:
    def test_empty_history_is_zero(self) -> None:
        # (f) No full-month history yet → nothing to average.
        assert free_balance_minor([], []) == 0

    def test_positive_non_exact_average_floors_down(self) -> None:
        # (g) diff 301 over 3 months → 100 (understates the surplus).
        assert free_balance_minor([200, 100, 1], [0, 0, 0]) == 100

    def test_negative_non_exact_average_floors_toward_minus_infinity(self) -> None:
        # (h) diff -301 over 3 months → -101, NOT -100: toward -∞ is the
        # conservative direction on the negative sign too (plan Disagreement §1,
        # contrasting (g) — toward-zero would give -100 here).
        assert free_balance_minor([0, 0, 0], [200, 100, 1]) == -101

    def test_single_month_history(self) -> None:
        # (i) Caller truncation to what exists: n=1 is a plain difference.
        assert free_balance_minor([500], [200]) == 300


class TestIsRealistic:
    def test_needed_equals_available_boundary(self) -> None:
        # (j) Exactly affordable IS realistic (<=, not <).
        assert is_realistic(100, 100) is True

    def test_no_surplus_with_need_is_unrealistic(self) -> None:
        # (k) Zero or negative surplus can never fund a positive need.
        assert is_realistic(1, 0) is False
        assert is_realistic(1, -50) is False

    def test_reached_goal_realistic_even_with_negative_surplus(self) -> None:
        # (l) needed == 0, available < 0 → True: nothing needed is always
        # realistic (Disagreement §2 pin — the literal D11 formula would say
        # False here, contradicting (k)'s rationale).
        assert is_realistic(0, -50) is True


class TestMonthsToTarget:
    def test_reached_is_zero_regardless_of_surplus(self) -> None:
        # (m) Reached → 0 even when available <= 0 — the reached check
        # short-circuits BEFORE the unreachable check.
        assert months_to_target(1000, 1000, 100) == 0
        assert months_to_target(1000, 1200, -50) == 0

    def test_no_surplus_unreachable_is_none(self) -> None:
        # (n) Not reached + no surplus → None (honest "unreachable", not a
        # huge number).
        assert months_to_target(1000, 400, 0) is None
        assert months_to_target(1000, 400, -50) is None

    def test_ceil_exact_vs_one_off(self) -> None:
        # (o) Ceil parity with monthly_needed (e): a partial final month counts.
        assert months_to_target(300, 0, 100) == 3
        assert months_to_target(301, 0, 100) == 4


class TestSuggestedDeadline:
    def test_month_end_clamp_including_leap_february(self) -> None:
        # (p) Jan 31 + 1 month clamps to Feb's last day: 28 normally, 29 in a
        # leap year (both arms of the clamp).
        assert suggested_deadline(date(2026, 1, 31), 1) == date(2026, 2, 28)
        assert suggested_deadline(date(2028, 1, 31), 1) == date(2028, 2, 29)

    def test_twelve_months_crosses_the_year(self) -> None:
        # (q) +12 lands on the same day next year (no clamp needed mid-month).
        assert suggested_deadline(date(2026, 8, 15), 12) == date(2027, 8, 15)

    def test_impossible_horizon_is_none_sane_horizon_is_date(self) -> None:
        # (v) months_to_target is unbounded (1-minor surplus vs 100_000-minor
        # remainder → 100_000 months), but MAXYEAR is 9999: beyond it → None,
        # never a ValueError; the contrasting sane horizon still returns a date.
        assert suggested_deadline(date(2026, 8, 15), 100_000) is None
        assert suggested_deadline(date(2026, 8, 15), 4) == date(2026, 12, 15)


class TestSplitByPriority:
    def test_partial_fill_of_first_unfilled_goal(self) -> None:
        # (r) Free covers the first goal + half the second: the first unfilled
        # goal gets the partial remainder (not all-or-nothing).
        first, second = uuid.uuid4(), uuid.uuid4()
        assert split_by_priority(150, [(first, 100, 1), (second, 100, 2)]) == {
            first: 100,
            second: 50,
        }

    def test_priority_tie_broken_by_caller_order(self) -> None:
        # (s) Same priority → caller order (created_at) decides: swapping the
        # input order swaps the winner (non-vacuous — free covers only one).
        a, b = uuid.uuid4(), uuid.uuid4()
        assert split_by_priority(100, [(a, 100, 1), (b, 100, 1)]) == {a: 100, b: 0}
        assert split_by_priority(100, [(b, 100, 1), (a, 100, 1)]) == {b: 100, a: 0}

    def test_no_free_balance_allocates_all_zeros(self) -> None:
        # (t) free <= 0 → everyone gets 0 (both the zero and negative arms).
        a, b = uuid.uuid4(), uuid.uuid4()
        assert split_by_priority(0, [(a, 100, 1), (b, 50, 2)]) == {a: 0, b: 0}
        assert split_by_priority(-50, [(a, 100, 1), (b, 50, 2)]) == {a: 0, b: 0}

    def test_zero_needed_goal_does_not_block_later_goals(self) -> None:
        # (u) A reached goal (need 0) takes 0 and the waterfall flows past it.
        reached, active = uuid.uuid4(), uuid.uuid4()
        assert split_by_priority(100, [(reached, 0, 1), (active, 100, 2)]) == {
            reached: 0,
            active: 100,
        }
