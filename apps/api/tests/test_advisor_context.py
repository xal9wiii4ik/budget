"""Pure unit tests for the advisor's window + context builder — no DB, no client.

The builder is the one place where the honest-but-boring facts about the advisor's
input are decided (which months it sees, whose name a bucket gets, how many rows
were silently excluded), and every one of them is invisible from the wire: the
prompt is assembled downstream in B2b. So they are pinned here, where the function
is a plain value → value mapping.
"""

import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime

import pytest

from budget_api.schemas.goal import GoalRead
from budget_api.services.advisor import AdvisorContext, GoalSummary
from budget_api.services.advisor_context import (
    UNCATEGORIZED_NAME,
    advisor_window,
    build_advisor_context,
)
from budget_api.services.tx_totals import (
    Bucket,
    ConvertedTotals,
    MerchantTotal,
    MerchantTotals,
    MonthTotals,
)


def _month(
    month: date, *, income: int = 0, expense: int = 0, unconverted: int = 0
) -> MonthTotals:
    return MonthTotals(
        month=month,
        income_minor=income,
        expense_minor=expense,
        unconverted_count=unconverted,
    )


def _totals(
    *, by_bucket: dict[Bucket, int] | None = None, unconverted: int = 0
) -> ConvertedTotals:
    buckets = by_bucket or {}
    return ConvertedTotals(
        income_minor=sum(t for (_, kind), t in buckets.items() if kind == "income"),
        expense_minor=sum(t for (_, kind), t in buckets.items() if kind == "expense"),
        by_bucket=buckets,
        unconverted_count=unconverted,
    )


def _goal_read() -> GoalRead:
    return GoalRead(
        id=uuid.uuid4(),
        name="Отпуск",
        target_minor=30000000,
        currency="EUR",
        deadline=date(2027, 1, 1),
        priority=1,
        archived=False,
        created_at=datetime(2026, 1, 1, 12, 0, tzinfo=UTC),
        saved_minor=500000,
        completed=False,
        monthly_needed_minor=2950000,
        realistic=False,
        months_to_target=40,
        suggested_deadline=date(2029, 5, 1),
        allocated_monthly_minor=120000,
        realism_unavailable=False,
        base_currency="RUB",
        # A goal in PLANNING mode (goal-planner §5): its manual ``target_minor``
        # is stale, and the number the user actually sees is the bottom-up
        # ``effective_target_minor`` below. That is what the advisor must be told
        # (plan §5 D-2) — hence the two differ here on purpose.
        goal_currency="EUR",
        has_items=True,
        planned_total_minor=28000000,
        planned_unconverted_count=0,
        effective_target_minor=28000000,
        final_cost_override_minor=None,
        initial_budget_minor=None,
        paid_minor=0,
        paid_unconverted_count=0,
        remaining_to_find_minor=27500000,
    )


def _build(
    *,
    monthly_income_minor: int | None = None,
    months: Sequence[MonthTotals] = (),
    totals: ConvertedTotals | None = None,
    category_names: Mapping[uuid.UUID, str] | None = None,
    merchants: MerchantTotals | None = None,
    goals: Sequence[GoalRead] = (),
) -> AdvisorContext:
    """The builder with the boring arguments defaulted; window fixed to May-Jul."""
    return build_advisor_context(
        base_currency="RUB",
        monthly_income_minor=monthly_income_minor,
        window_from=date(2026, 5, 1),
        window_to_exclusive=date(2026, 8, 1),
        months=months,
        totals=totals if totals is not None else _totals(),
        category_names=category_names if category_names is not None else {},
        merchants=(
            merchants
            if merchants is not None
            else MerchantTotals(items=[], unconverted_count=0)
        ),
        goals=goals,
    )


class TestAdvisorWindow:
    def test_window_is_three_full_months_excluding_current(self) -> None:
        # Mid-month: August is IN PROGRESS, so the window stops at Aug 1 and
        # reaches back three FULL months (May, June, July). A window that merely
        # subtracted 3 months from `today` would start 2026-05-16.
        assert advisor_window(date(2026, 8, 16)) == (date(2026, 5, 1), date(2026, 8, 1))
        # First of the month: the "partial" month is one day old and is still
        # excluded — the contrast that catches an off-by-one `-(months - 1)`
        # (which would answer 2026-06-01 here).
        assert advisor_window(date(2026, 8, 1)) == (date(2026, 5, 1), date(2026, 8, 1))
        # Across the year boundary.
        assert advisor_window(date(2026, 1, 15)) == (
            date(2025, 10, 1),
            date(2026, 1, 1),
        )


class TestBuildAdvisorContext:
    def test_maps_window_series_goals_and_income(self) -> None:
        goal = _goal_read()
        context = _build(
            monthly_income_minor=15000000,
            months=[
                _month(date(2026, 5, 1), income=10000000, expense=4000000),
                _month(date(2026, 6, 1)),
                _month(date(2026, 7, 1), income=1000000, expense=3500000),
            ],
            merchants=MerchantTotals(
                items=[MerchantTotal(merchant="ALFA", total_minor=800000, tx_count=3)],
                unconverted_count=0,
            ),
            goals=[goal],
        )

        assert context.base_currency == "RUB"
        assert context.monthly_income_minor == 15000000
        # window_to is INCLUSIVE: the caller's half-open Aug 1 is July 31 here.
        assert (context.window_from, context.window_to) == (
            date(2026, 5, 1),
            date(2026, 7, 31),
        )
        assert [(p.month, p.net_minor) for p in context.months] == [
            ("2026-05", 6000000),
            ("2026-06", 0),  # an empty month stays in the series, as a zero point
            ("2026-07", -2500000),  # signed: a deficit month is NEGATIVE, not abs()
        ]
        assert context.top_merchants[0].tx_count == 3
        # Goals arrive as computed figures only — no id, no ledger row, and the
        # nullable realism flag is carried as-is rather than defaulted to True.
        assert context.goals == (
            GoalSummary(
                name="Отпуск",
                currency="EUR",
                # The EFFECTIVE target, not the raw ``target_minor`` of 30000000
                # the goal still carries (plan §5 D-2).
                target_minor=28000000,
                saved_minor=500000,
                deadline=date(2027, 1, 1),
                monthly_needed_minor=2950000,
                realistic=False,
                allocated_monthly_minor=120000,
            ),
        )

    def test_category_names_resolved_including_uncategorized(self) -> None:
        food = uuid.uuid4()
        rent = uuid.uuid4()
        salary = uuid.uuid4()
        gone = uuid.uuid4()  # resolvable id the caller's map does not carry
        context = _build(
            totals=_totals(
                by_bucket={
                    (food, "expense"): 300000,
                    (rent, "expense"): 900000,
                    (None, "expense"): 100000,
                    (gone, "expense"): 50000,
                    (salary, "income"): 5000000,
                }
            ),
            category_names={food: "Еда", rent: "Аренда", salary: "Зарплата"},
        )

        # Ordered (kind ASC, total DESC) — the /stats summary ordering, expenses
        # first — and every bucket is a NAME: a UUID must never reach the prompt.
        assert [(c.name, c.kind, c.total_minor) for c in context.by_category] == [
            ("Аренда", "expense", 900000),
            ("Еда", "expense", 300000),
            (UNCATEGORIZED_NAME, "expense", 100000),
            # An id the caller could not resolve degrades to the same label
            # instead of leaking the raw uuid.
            (UNCATEGORIZED_NAME, "expense", 50000),
            ("Зарплата", "income", 5000000),
        ]

    @pytest.mark.parametrize(
        ("months", "totals", "merchants", "expected"),
        [
            (
                [_month(date(2026, 5, 1), unconverted=2), _month(date(2026, 6, 1))],
                _totals(unconverted=2),
                MerchantTotals(items=[], unconverted_count=1),
                2,
            ),
            (
                [_month(date(2026, 5, 1)), _month(date(2026, 6, 1))],
                _totals(unconverted=0),
                MerchantTotals(items=[], unconverted_count=0),
                0,
            ),
        ],
        ids=["some-excluded", "none-excluded"],
    )
    def test_unconverted_count_comes_from_the_inputs(
        self,
        months: list[MonthTotals],
        totals: ConvertedTotals,
        merchants: MerchantTotals,
        expected: int,
    ) -> None:
        # Two inputs, two answers: a hardcoded 0 (the GAP-7 failure mode) passes
        # the second arm and fails the first. The first arm also pins that the
        # three overlapping sources are NOT summed — one excluded row seen by all
        # three would report as 5.
        context = _build(months=months, totals=totals, merchants=merchants)

        assert context.unconverted_count == expected
