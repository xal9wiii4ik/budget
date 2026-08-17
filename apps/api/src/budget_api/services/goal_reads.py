"""Goal portfolio reads: the whole-portfolio assembler and its loaders (D8).

Moved verbatim out of ``routers/goals.py`` when the advisor became the second
consumer of the computed goal figures (the first/second-consumer extraction
rule). Behaviour, signatures and SQL are unchanged — the names lost their leading
underscore because they are the public surface now.

The assembler computes NO math itself: every monthly-needed / realism /
months-to-target / suggested-deadline / waterfall / free-balance figure comes from
``domain/goals.py``, every currency conversion from ``domain/fx.py`` with rates
resolved by ``services/fx_lookup``, and the free-balance window rides
``services/tx_totals.converted_totals`` (the same snapshot-aware aggregation as
the monthly summary). The only SQL aggregates here are SUM/GROUP BY.

Two-level degradation ([SL-3]): a goal whose currency has no rate to the base
today gets null realism fields, allocation 0, and is EXCLUDED from the waterfall
input (its unconvertible need must not distort other goals' allocations) — while
``monthly_needed_minor``/``saved_minor``/``completed`` stay computed
(goal-currency math). The top-level flag fires only when the free-balance window
itself was degraded (D9 unconverted rows).

The base currency is NOT re-implemented here: it is the read-only
``services/profile_reads.read_base_currency`` (a GET never writes a profile).
"""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.fx import convert_minor, invert
from budget_api.domain.goals import (
    free_balance_minor,
    is_realistic,
    monthly_needed,
    months_to_target,
    months_until,
    split_by_priority,
    suggested_deadline,
)
from budget_api.domain.periods import shift_month
from budget_api.models import Goal, GoalContribution
from budget_api.schemas.goal import GoalRead
from budget_api.services.fx_lookup import lookup_rate
from budget_api.services.profile_reads import read_base_currency
from budget_api.services.tx_totals import converted_totals

#: Full calendar months in the free-balance window (current partial month
#: excluded — it always under-states both sides; D11).
_FREE_BALANCE_MONTHS = 3


@dataclass(frozen=True)
class _ComputedFields:
    """Per-goal figures staged before the waterfall closes over all goals."""

    saved: int
    completed: bool
    needed: int
    realistic: bool | None
    to_target: int | None
    suggested: date | None
    unavailable: bool


async def saved_sum(session: AsyncSession, goal_id: uuid.UUID) -> int:
    """SUM(contributions) for one goal — the OQ-5 computed balance."""
    total = await session.scalar(
        select(func.coalesce(func.sum(GoalContribution.amount_minor), 0)).where(
            GoalContribution.goal_id == goal_id
        )
    )
    return int(total or 0)


async def assemble_goal_reads(
    session: AsyncSession,
    user_id: uuid.UUID,
    goals: list[Goal],
    *,
    today: date,
) -> tuple[list[GoalRead], int, bool, str]:
    """Assemble computed reads: ``(items, free_balance_minor, top_flag, base)``.

    Presentation assembly, not domain — it computes no math itself (module
    docstring). ``goals`` arrive already ordered (priority, created_at) and the
    output preserves that order.
    """
    base = await read_base_currency(session, user_id)

    # Per-goal saved: one grouped SUM over the ledger for all goals at once.
    saved: dict[uuid.UUID, int] = {}
    if goals:
        rows = await session.execute(
            select(GoalContribution.goal_id, func.sum(GoalContribution.amount_minor))
            .where(GoalContribution.goal_id.in_([g.id for g in goals]))
            .group_by(GoalContribution.goal_id)
        )
        saved = {goal_id: int(total) for goal_id, total in rows}

    # Free balance: 3 FULL calendar months [first_of(month-3), first_of(month)),
    # each month through the same snapshot-aware aggregation as the summary (D9).
    current_first = today.replace(day=1)
    incomes: list[int] = []
    expenses: list[int] = []
    window_degraded = False
    for offset in range(-_FREE_BALANCE_MONTHS, 0):
        start = shift_month(current_first, offset)
        totals = await converted_totals(
            session, user_id, base, start, shift_month(start, 1)
        )
        incomes.append(totals.income_minor)
        expenses.append(totals.expense_minor)
        # Excluded rows make this a lower-confidence baseline — the top-level
        # flag ([SL-3]); per-goal figures derived from it inherit the caveat.
        window_degraded = window_degraded or totals.unconverted_count > 0
    free = free_balance_minor(incomes, expenses)

    # Per-goal figures + the waterfall input (convertible, non-archived,
    # non-completed goals, in the incoming (priority, created_at) order).
    computed: list[_ComputedFields] = []
    needs: list[tuple[uuid.UUID, int, int]] = []
    for goal in goals:
        goal_saved = saved.get(goal.id, 0)
        completed = goal_saved >= goal.target_minor
        # Goal-currency math — always computable, no conversion involved. No
        # deadline → no monthly requirement (0); the realism short-circuit then
        # reads it as realistic and the waterfall allocates it nothing.
        needed = (
            monthly_needed(
                goal.target_minor, goal_saved, months_until(today, goal.deadline)
            )
            if goal.deadline is not None
            else 0
        )
        # Realism is a forward-looking projection → latest rate, not a
        # transaction-dated one (D10). Base-currency goals hit the identity
        # short-circuit and can never be unavailable.
        found = await lookup_rate(session, goal.currency, base, today)
        if found is None:
            # Per-goal degradation ([SL-3]): null realism fields, no allocation,
            # excluded from the waterfall input below.
            realistic = None
            to_target = None
            suggested = None
            unavailable = True
        else:
            # Callers convert — the domain never sees two currencies (D11).
            available_goal_cur = convert_minor(
                free, base, goal.currency, invert(found.rate)
            )
            realistic = is_realistic(needed, available_goal_cur)
            to_target = months_to_target(
                goal.target_minor, goal_saved, available_goal_cur
            )
            suggested = (
                suggested_deadline(today, to_target) if to_target is not None else None
            )
            unavailable = False
            if not goal.archived and not completed:
                needs.append(
                    (
                        goal.id,
                        convert_minor(needed, goal.currency, base, found.rate),
                        goal.priority,
                    )
                )
        computed.append(
            _ComputedFields(
                saved=goal_saved,
                completed=completed,
                needed=needed,
                realistic=realistic,
                to_target=to_target,
                suggested=suggested,
                unavailable=unavailable,
            )
        )

    allocations = split_by_priority(free, needs)

    items = [
        GoalRead(
            id=goal.id,
            name=goal.name,
            target_minor=goal.target_minor,
            currency=goal.currency,
            deadline=goal.deadline,
            priority=goal.priority,
            archived=goal.archived,
            created_at=goal.created_at,
            saved_minor=c.saved,
            completed=c.completed,
            monthly_needed_minor=c.needed,
            realistic=c.realistic,
            months_to_target=c.to_target,
            suggested_deadline=c.suggested,
            allocated_monthly_minor=allocations.get(goal.id, 0),
            realism_unavailable=c.unavailable,
            base_currency=base,
        )
        for goal, c in zip(goals, computed, strict=True)
    ]
    return items, free, window_degraded, base


async def load_goals_ordered(
    session: AsyncSession, user_id: uuid.UUID, *, include_archived: bool
) -> list[Goal]:
    stmt = select(Goal).where(Goal.user_id == user_id)
    if not include_archived:
        stmt = stmt.where(Goal.archived.is_(False))
    rows = await session.scalars(stmt.order_by(Goal.priority, Goal.created_at, Goal.id))
    return list(rows.all())
