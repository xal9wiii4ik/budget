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
``services/profile_reads.read_profile_settings`` (a GET never writes a profile),
which since the base-currency scope also carries the DECLARED monthly income —
the free-balance fallback for a user with no history yet (D2).
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
    months_with_data,
    split_by_priority,
    suggested_deadline,
)
from budget_api.domain.periods import shift_month
from budget_api.models import Goal, GoalContribution
from budget_api.schemas.goal import FreeBalanceBasis, GoalRead
from budget_api.services.fx_lookup import lookup_rate
from budget_api.services.profile_reads import read_profile_settings
from budget_api.services.tx_totals import converted_totals

#: Full calendar months in the free-balance window (current partial month
#: excluded — it always under-states both sides; D11).
_FREE_BALANCE_MONTHS = 3


@dataclass(frozen=True)
class GoalPortfolio:
    """Everything one portfolio assembly produced — the whole-list return shape.

    A dataclass rather than the 4-tuple this used to be: the basis made two
    adjacent elements both ``str``, and a positional swap between them would be
    invisible at the call sites (all three pass the parts on by keyword).
    """

    items: list[GoalRead]
    free_balance_minor: int
    realism_unavailable: bool
    base_currency: str
    free_balance_basis: FreeBalanceBasis
    free_balance_months_with_data: int


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
) -> GoalPortfolio:
    """Assemble the computed portfolio (see :class:`GoalPortfolio`).

    Presentation assembly, not domain — it computes no math itself (module
    docstring). ``goals`` arrive already ordered (priority, created_at) and the
    output preserves that order.
    """
    settings = await read_profile_settings(session, user_id)
    base = settings.base_currency

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
    unconverted_counts: list[int] = []
    for offset in range(-_FREE_BALANCE_MONTHS, 0):
        start = shift_month(current_first, offset)
        totals = await converted_totals(
            session, user_id, base, start, shift_month(start, 1)
        )
        incomes.append(totals.income_minor)
        expenses.append(totals.expense_minor)
        unconverted_counts.append(totals.unconverted_count)
    # Excluded rows make this a lower-confidence baseline — the top-level flag
    # ([SL-3]); per-goal figures derived from it inherit the caveat.
    window_degraded = any(count > 0 for count in unconverted_counts)

    # Basis resolution (D2), in order. INVARIANT, and the reason the top-level
    # flag stays readable: an unconverted row IMPLIES its month has data, so a
    # degraded window always lands in the `average` arm — and conversely
    # `declared`/`none` can only be reached with every count 0, i.e. with
    # window_degraded False. No basis arm may ever be special-cased on the flag.
    data_months = months_with_data(incomes, expenses, unconverted_counts)
    basis: FreeBalanceBasis
    if data_months > 0:
        basis = "average"
        free = free_balance_minor(incomes, expenses, unconverted_counts)
    elif settings.monthly_income_minor is not None:
        # No history at all, but the user told us what they earn. Read in the
        # base currency verbatim — never converted (task.md D1: a user-entered
        # number is not re-denominated behind their back).
        basis = "declared"
        free = settings.monthly_income_minor
    else:
        basis = "none"
        free = 0

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
    return GoalPortfolio(
        items=items,
        free_balance_minor=free,
        realism_unavailable=window_degraded,
        base_currency=base,
        free_balance_basis=basis,
        free_balance_months_with_data=data_months,
    )


async def load_goals_ordered(
    session: AsyncSession, user_id: uuid.UUID, *, include_archived: bool
) -> list[Goal]:
    stmt = select(Goal).where(Goal.user_id == user_id)
    if not include_archived:
        stmt = stmt.where(Goal.archived.is_(False))
    rows = await session.scalars(stmt.order_by(Goal.priority, Goal.created_at, Goal.id))
    return list(rows.all())
