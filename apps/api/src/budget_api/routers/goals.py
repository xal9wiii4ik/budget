"""Goals CRUD + contributions + computed realism/waterfall (architecture D12).

The calculator is server-side ONLY (the D8 stance): every computed number a
client renders comes from here, assembled by ``_assemble_goal_reads`` — which
itself computes NO math. Every monthly-needed / realism / months-to-target /
suggested-deadline / waterfall / free-balance figure comes from
``domain/goals.py``; every currency conversion from ``domain/fx.py`` with rates
resolved by ``services/fx_lookup``; the free-balance window rides
``services/tx_totals.converted_totals`` (the same snapshot-aware aggregation as
the monthly summary). The only SQL aggregates here are SUM/GROUP BY.

Two-level degradation ([SL-3], plan D-List): a goal whose currency has no rate
to the base today gets null realism fields, allocation 0, and is EXCLUDED from
the waterfall input (its unconvertible need must not distort other goals'
allocations) — while ``monthly_needed_minor``/``saved_minor``/``completed`` stay
computed (goal-currency math). The top-level flag fires only when the
free-balance window itself was degraded (D9 unconverted rows).

No-oracle: the goal path id resolves foreign and missing alike to 404
``GOAL_NOT_FOUND`` (user-scoped ``_load_own_goal``, one code path); a
contribution id is scoped by BOTH the (own-checked) goal and its own id, so
foreign / missing / wrong-own-goal are byte-identical 404
``CONTRIBUTION_NOT_FOUND``.

The ``SUM >= 0`` per-goal invariant spans rows, so it is guarded here inside the
write transaction with the goal row locked ``FOR UPDATE`` — concurrent
contribution writes to one goal serialize on that lock (D10).
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.auth import current_active_user
from budget_api.db import get_session
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
from budget_api.models import Goal, GoalContribution, Profile, User
from budget_api.models.profile import DEFAULT_BASE_CURRENCY
from budget_api.schemas.goal import (
    ContributionCreate,
    ContributionList,
    ContributionRead,
    GoalCreate,
    GoalError,
    GoalListRead,
    GoalRead,
    GoalUpdate,
    ProgressPoint,
)
from budget_api.services.fx_lookup import lookup_rate
from budget_api.services.tx_totals import converted_totals

router = APIRouter()

#: Full calendar months in the free-balance window (current partial month
#: excluded — it always under-states both sides; D11).
_FREE_BALANCE_MONTHS = 3

# Mirrors routers/transactions.py: stable UPPER_SNAKE codes in {"detail": ...}.
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": GoalError}
}
# The honest anyOf union (receipts V2/AM-5): business codes (GoalError) AND
# FastAPI's auto Pydantic array (HTTPValidationError) both occur at runtime;
# declaring only the model would suppress the auto arm.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/GoalError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}


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


def _today() -> date:
    return datetime.now(UTC).date()


def _shift_month(first_of_month: date, months: int) -> date:
    """First-of-month shifted by ``months`` — window boundaries only, no money."""
    total = first_of_month.year * 12 + (first_of_month.month - 1) + months
    year, month0 = divmod(total, 12)
    return date(year, month0 + 1, 1)


async def _load_own_goal(
    session: AsyncSession,
    goal_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> Goal:
    """user_id-scoped load; foreign/missing → one 404 code path (no-oracle).

    ``for_update`` locks the goal row so the cross-row ``SUM >= 0`` invariant
    check serializes against concurrent contribution writes to the same goal.
    """
    stmt = select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id)
    if for_update:
        stmt = stmt.with_for_update()
    goal = await session.scalar(stmt)
    if goal is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_NOT_FOUND"
        )
    return goal


async def _saved_sum(session: AsyncSession, goal_id: uuid.UUID) -> int:
    """SUM(contributions) for one goal — the OQ-5 computed balance."""
    total = await session.scalar(
        select(func.coalesce(func.sum(GoalContribution.amount_minor), 0)).where(
            GoalContribution.goal_id == goal_id
        )
    )
    return int(total or 0)


async def _base_currency(session: AsyncSession, user_id: uuid.UUID) -> str:
    # Read-only fallback (the summary GET precedent): goals never write the
    # profile; a pre-1.2 user without one reads as the default base.
    profile = await session.get(Profile, user_id)
    return profile.base_currency if profile is not None else DEFAULT_BASE_CURRENCY


async def _assemble_goal_reads(
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
    base = await _base_currency(session, user_id)

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
        start = _shift_month(current_first, offset)
        totals = await converted_totals(
            session, user_id, base, start, _shift_month(start, 1)
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


async def _load_goals_ordered(
    session: AsyncSession, user_id: uuid.UUID, *, include_archived: bool
) -> list[Goal]:
    stmt = select(Goal).where(Goal.user_id == user_id)
    if not include_archived:
        stmt = stmt.where(Goal.archived.is_(False))
    rows = await session.scalars(stmt.order_by(Goal.priority, Goal.created_at, Goal.id))
    return list(rows.all())


async def _single_goal_read(
    session: AsyncSession, user_id: uuid.UUID, goal_id: uuid.UUID
) -> GoalRead:
    """One item, computed via the SAME whole-portfolio assembler as the list.

    ``allocated_monthly_minor`` is a whole-portfolio number — computing it
    against one goal would lie (AM-4 pins list/single equality). Archived goals
    are included in the load so an archived goal's own GET works; they are
    excluded from the waterfall input inside the assembler regardless, so the
    numbers match the default list exactly.
    """
    goals = await _load_goals_ordered(session, user_id, include_archived=True)
    items, _, _, _ = await _assemble_goal_reads(session, user_id, goals, today=_today())
    item = next((item for item in items if item.id == goal_id), None)
    if item is None:
        # Concurrent delete between the caller's own-check and this re-query:
        # resolve to the same no-oracle 404, not a 500.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_NOT_FOUND"
        )
    return item


def _serialize_contribution(row: GoalContribution) -> ContributionRead:
    return ContributionRead(
        id=row.id,
        goal_id=row.goal_id,
        amount_minor=row.amount_minor,
        occurred_at=row.occurred_at,
        note=row.note,
        created_at=row.created_at,
    )


@router.post("", response_model=GoalRead, status_code=status.HTTP_201_CREATED)
async def create_goal(
    payload: GoalCreate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> GoalRead:
    if payload.priority is not None:
        priority = payload.priority
    else:
        # Appended last: max(priority) + 1, empty portfolio → 1. Duplicates are
        # tolerated (no DB uniqueness — D10); created_at tie-breaks.
        max_priority = await session.scalar(
            select(func.max(Goal.priority)).where(Goal.user_id == user.id)
        )
        priority = (max_priority if max_priority is not None else 0) + 1
    goal = Goal(
        user_id=user.id,
        name=payload.name,
        target_minor=payload.target_minor,
        currency=payload.currency,
        deadline=payload.deadline,
        priority=priority,
    )
    session.add(goal)
    if payload.initial_saved_minor is not None:
        # "Already saved" = the first ledger row, atomically in this commit
        # (D10/OQ-5) — there is no stored saved_minor to drift from it.
        await session.flush()
        session.add(
            GoalContribution(
                goal_id=goal.id,
                amount_minor=payload.initial_saved_minor,
                occurred_at=_today(),
            )
        )
    await session.commit()
    await session.refresh(goal)
    return await _single_goal_read(session, user.id, goal.id)


@router.get("", response_model=GoalListRead)
async def list_goals(
    include_archived: bool = Query(default=False),
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> GoalListRead:
    goals = await _load_goals_ordered(
        session, user.id, include_archived=include_archived
    )
    items, free, window_degraded, base = await _assemble_goal_reads(
        session, user.id, goals, today=_today()
    )
    return GoalListRead(
        items=items,
        free_balance_minor=free,
        realism_unavailable=window_degraded,
        base_currency=base,
    )


@router.get("/{goal_id}", response_model=GoalRead, responses=_NOT_FOUND)
async def get_goal(
    goal_id: uuid.UUID,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> GoalRead:
    await _load_own_goal(session, goal_id, user.id)
    return await _single_goal_read(session, user.id, goal_id)


@router.patch(
    "/{goal_id}",
    response_model=GoalRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def update_goal(
    goal_id: uuid.UUID,
    payload: GoalUpdate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> GoalRead:
    goal = await _load_own_goal(session, goal_id, user.id)

    fields = payload.model_fields_set
    # NOT NULL columns reject explicit null with the *_REQUIRED house pattern;
    # deadline is the one nullable column here — explicit null clears it.
    required: tuple[tuple[str, str], ...] = (
        ("name", "NAME_REQUIRED"),
        ("target_minor", "TARGET_REQUIRED"),
        ("currency", "CURRENCY_REQUIRED"),
        ("priority", "PRIORITY_REQUIRED"),
        ("archived", "ARCHIVED_REQUIRED"),
    )
    for field, code in required:
        if field in fields and getattr(payload, field) is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=code
            )

    if "name" in fields:
        assert payload.name is not None  # 422-guarded above
        goal.name = payload.name
    if "target_minor" in fields:
        assert payload.target_minor is not None  # 422-guarded above
        goal.target_minor = payload.target_minor
    if "currency" in fields:
        assert payload.currency is not None  # 422-guarded above
        # Relabel only (D12): contribution rows are amounts in the goal's
        # currency context and are never rewritten — the web warns.
        goal.currency = payload.currency
    if "deadline" in fields:
        goal.deadline = payload.deadline  # explicit null clears
    if "priority" in fields:
        assert payload.priority is not None  # 422-guarded above
        goal.priority = payload.priority
    if "archived" in fields:
        assert payload.archived is not None  # 422-guarded above
        goal.archived = payload.archived

    await session.commit()
    await session.refresh(goal)
    return await _single_goal_read(session, user.id, goal.id)


@router.delete(
    "/{goal_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=_NOT_FOUND,
)
async def delete_goal(
    goal_id: uuid.UUID,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    # Real delete; contributions CASCADE (owned leaf subtree — archive covers
    # "keep for history", D12).
    goal = await _load_own_goal(session, goal_id, user.id)
    await session.delete(goal)
    await session.commit()


@router.post(
    "/{goal_id}/contributions",
    response_model=ContributionRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def create_contribution(
    goal_id: uuid.UUID,
    payload: ContributionCreate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> ContributionRead:
    # FOR UPDATE: the SUM invariant below spans rows, so concurrent writes to
    # this goal must serialize on the goal row (D10).
    goal = await _load_own_goal(session, goal_id, user.id, for_update=True)
    # Withdrawal guard: never below zero; exactly-to-zero is allowed.
    if (
        payload.amount_minor < 0
        and await _saved_sum(session, goal.id) + payload.amount_minor < 0
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CONTRIBUTION_EXCEEDS_SAVED",
        )
    row = GoalContribution(
        goal_id=goal.id,
        amount_minor=payload.amount_minor,
        occurred_at=payload.occurred_at or _today(),
        note=payload.note,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _serialize_contribution(row)


@router.get(
    "/{goal_id}/contributions",
    response_model=ContributionList,
    responses=_NOT_FOUND,
)
async def list_contributions(
    goal_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> ContributionList:
    goal = await _load_own_goal(session, goal_id, user.id)
    total = await session.scalar(
        select(func.count())
        .select_from(GoalContribution)
        .where(GoalContribution.goal_id == goal.id)
    )
    rows = (
        await session.scalars(
            select(GoalContribution)
            .where(GoalContribution.goal_id == goal.id)
            .order_by(
                GoalContribution.occurred_at.desc(),
                GoalContribution.created_at.desc(),
                GoalContribution.id,
            )
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return ContributionList(
        items=[_serialize_contribution(r) for r in rows], total=total or 0
    )


@router.delete(
    "/{goal_id}/contributions/{contribution_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def delete_contribution(
    goal_id: uuid.UUID,
    contribution_id: uuid.UUID,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    # Own-goal check FIRST (its own 404), then the contribution scoped by BOTH
    # goal_id and id: foreign / missing / wrong-own-goal are byte-identical
    # (no-oracle, one code path). Same FOR-UPDATE + SUM guard as the create —
    # deleting a positive row is a withdrawal in disguise.
    goal = await _load_own_goal(session, goal_id, user.id, for_update=True)
    row = await session.scalar(
        select(GoalContribution).where(
            GoalContribution.id == contribution_id,
            GoalContribution.goal_id == goal.id,
        )
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="CONTRIBUTION_NOT_FOUND"
        )
    if (
        row.amount_minor > 0
        and await _saved_sum(session, goal.id) - row.amount_minor < 0
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CONTRIBUTION_EXCEEDS_SAVED",
        )
    await session.delete(row)
    await session.commit()


@router.get(
    "/{goal_id}/progress",
    response_model=list[ProgressPoint],
    responses=_NOT_FOUND,
)
async def goal_progress(
    goal_id: uuid.UUID,
    months: int = Query(default=12, ge=1, le=60),
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[ProgressPoint]:
    """Monthly series for the chart, current month included, empty months as 0.

    ``saved_end_minor`` is cumulative and includes the pre-window base sum, so
    the chart starts at the true balance (the client renders, never computes).
    """
    goal = await _load_own_goal(session, goal_id, user.id)
    current_first = _today().replace(day=1)
    window_start = _shift_month(current_first, -(months - 1))

    month_col = func.date_trunc("month", GoalContribution.occurred_at)
    grouped = await session.execute(
        select(month_col, func.sum(GoalContribution.amount_minor))
        .where(
            GoalContribution.goal_id == goal.id,
            GoalContribution.occurred_at >= window_start,
            # Future-dated rows are excluded from the chart by decision
            # (card-vs-chart reconciliation flagged to plan-web).
            GoalContribution.occurred_at < _shift_month(current_first, 1),
        )
        .group_by(month_col)
    )
    by_month: dict[tuple[int, int], int] = {
        (bucket.year, bucket.month): int(total) for bucket, total in grouped
    }
    pre_window = await session.scalar(
        select(func.coalesce(func.sum(GoalContribution.amount_minor), 0)).where(
            GoalContribution.goal_id == goal.id,
            GoalContribution.occurred_at < window_start,
        )
    )

    running = int(pre_window or 0)
    points: list[ProgressPoint] = []
    for offset in range(months):
        month_first = _shift_month(window_start, offset)
        contributed = by_month.get((month_first.year, month_first.month), 0)
        running += contributed
        points.append(
            ProgressPoint(
                month=f"{month_first.year:04d}-{month_first.month:02d}",
                contributed_minor=contributed,
                saved_end_minor=running,
            )
        )
    return points
