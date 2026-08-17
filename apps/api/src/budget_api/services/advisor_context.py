"""Pure mapping from the shared aggregates into the advisor's context (D7).

The router does the I/O — ``monthly_converted_totals``, ``converted_totals``,
``merchant_converted_totals``, ``goal_reads.assemble_goal_reads``,
``profile_reads`` and the category-name lookup — and hands the results here. This
module then does the shaping and NOTHING else: no session, no awaits, no
``models`` import. That split is load-bearing beyond tidiness — a
``StreamingResponse``'s generator runs AFTER FastAPI has closed the ``get_session``
dependency (≥0.106), so the whole context must be a plain frozen value by the time
the stream starts, and a pure builder is the only kind that cannot regress into a
lazy ORM access.

Windowing (OQ-2, confirmed at grooming review R2): the advisor looks at the **3
FULL calendar months** ending with the last complete one — the current partial
month is EXCLUDED. It is the same window the goals free balance is computed over
(``goal_reads._FREE_BALANCE_MONTHS``), and comparing a 9-day stub against three
full months is exactly how an advisor invents a trend that is not there.
"""

import uuid
from collections.abc import Mapping, Sequence
from datetime import date, timedelta

from budget_api.domain.periods import month_key, shift_month
from budget_api.schemas.goal import GoalRead
from budget_api.services.advisor import (
    AdvisorContext,
    CategorySpend,
    GoalSummary,
    MerchantSpend,
    MonthPoint,
)
from budget_api.services.tx_totals import ConvertedTotals, MerchantTotals, MonthTotals

#: Display name of the ``category_id IS NULL`` bucket. Russian because it is
#: rendered verbatim into the Russian prompt (R4.2) next to the real category
#: names — an English "Uncategorized" in that list would read as a category the
#: user actually created. A category id the caller could not resolve (deleted
#: between the two reads) degrades to the same label rather than leaking a UUID
#: into the prompt; the two buckets stay separate rows, they are never merged.
UNCATEGORIZED_NAME = "Без категории"

#: Full calendar months the advisor reasons over (OQ-2/R2).
#:
#: CHANGE BOTH TOGETHER: ``advisor.render_prompt`` spells this number out in Russian
#: words ("три полных календарных месяца"), which no format string derives from the
#: constant. ``test_render_prompt_states_window_income_and_plain_text_rule`` pins the
#: pair, so editing this alone fails a test that points at the wording.
ADVISOR_WINDOW_MONTHS = 3


def advisor_window(today: date) -> tuple[date, date]:
    """``today`` → ``[from, to_exclusive)`` of the 3 last FULL calendar months.

    The current (partial) month is excluded, so on 2026-08-16 the window is
    ``[2026-05-01, 2026-08-01)`` — and it is the same on 2026-08-01, where the
    "partial" month is one day old.
    """
    current_first = today.replace(day=1)
    return shift_month(current_first, -ADVISOR_WINDOW_MONTHS), current_first


def build_advisor_context(
    *,
    base_currency: str,
    monthly_income_minor: int | None,
    window_from: date,
    window_to_exclusive: date,
    months: Sequence[MonthTotals],
    totals: ConvertedTotals,
    category_names: Mapping[uuid.UUID, str],
    merchants: MerchantTotals,
    goals: Sequence[GoalRead],
) -> AdvisorContext:
    """Shape already-fetched aggregates into the frozen :class:`AdvisorContext`.

    PURE: every argument is a value the caller already awaited. ``window_from`` /
    ``window_to_exclusive`` are the half-open window the aggregates were read over
    (:func:`advisor_window`); the context carries the INCLUSIVE ``window_to`` the
    prompt states in words.

    ``goals`` are mapped verbatim and in order — WHICH goals the advisor sees
    (archived or not) is the caller's decision, not a filter hidden in here.
    """
    by_category = [
        CategorySpend(
            name=(
                category_names.get(category_id, UNCATEGORIZED_NAME)
                if category_id is not None
                else UNCATEGORIZED_NAME
            ),
            kind=kind,
            total_minor=total,
        )
        # The /stats and /transactions summary ordering (kind, total DESC), with
        # the category id AS A STRING as the final tie-break so equal totals keep a
        # deterministic order between calls (the displayed name is NOT the key —
        # two buckets can render the same label, e.g. UNCATEGORIZED_NAME).
        for (category_id, kind), total in sorted(
            totals.by_bucket.items(),
            key=lambda item: (item[0][1], -item[1], str(item[0][0])),
        )
    ]
    return AdvisorContext(
        base_currency=base_currency,
        monthly_income_minor=monthly_income_minor,
        window_from=window_from,
        window_to=window_to_exclusive - timedelta(days=1),
        months=tuple(
            MonthPoint(
                month=month_key(point.month),
                income_minor=point.income_minor,
                expense_minor=point.expense_minor,
                net_minor=point.income_minor - point.expense_minor,  # signed
            )
            for point in months
        ),
        by_category=tuple(by_category),
        top_merchants=tuple(
            MerchantSpend(
                merchant=item.merchant,
                total_minor=item.total_minor,
                tx_count=item.tx_count,
            )
            for item in merchants.items
        ),
        goals=tuple(
            GoalSummary(
                name=goal.name,
                currency=goal.currency,
                target_minor=goal.target_minor,
                saved_minor=goal.saved_minor,
                deadline=goal.deadline,
                monthly_needed_minor=goal.monthly_needed_minor,
                realistic=goal.realistic,
                allocated_monthly_minor=goal.allocated_monthly_minor,
            )
            for goal in goals
        ),
        unconverted_count=_window_unconverted_count(months, totals, merchants),
    )


def _window_unconverted_count(
    months: Sequence[MonthTotals],
    totals: ConvertedTotals,
    merchants: MerchantTotals,
) -> int:
    """How many rows of the window are in NO total above (exclude-and-flag).

    The three aggregates count the SAME rows over the SAME window from three
    angles — the monthly series partitions them by month, the summary counts them
    all, and the merchant series sees only the expense-with-merchant subset — so
    summing would report one excluded row up to three times. The maximum is the
    honest number: the whole-window counts already equal the true total, and the
    subset can only be ``<=`` it. Taking the max (rather than trusting one source)
    also means a future caller that passes a narrower ``totals`` window cannot
    silently under-report.
    """
    return max(
        totals.unconverted_count,
        sum(point.unconverted_count for point in months),
        merchants.unconverted_count,
    )
