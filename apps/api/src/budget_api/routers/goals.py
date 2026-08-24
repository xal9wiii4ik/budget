"""Goals CRUD + contributions + computed realism/waterfall (architecture D12).

The calculator is server-side ONLY (the D8 stance): every computed number a
client renders comes from ``services/goal_reads.assemble_goal_reads`` — which
itself computes NO math and is shared with the advisor. This module is the HTTP
shell: routing, own-checks, the write transactions and their invariants.

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
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.db import get_session
from budget_api.domain.periods import shift_month
from budget_api.models import Goal, GoalContribution, User
from budget_api.pat_auth import current_user_jwt_or_pat
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
from budget_api.services.goal_reads import (
    assemble_goal_reads,
    load_goals_ordered,
    saved_sum,
)

router = APIRouter()

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


def _today() -> date:
    return datetime.now(UTC).date()


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
    goals = await load_goals_ordered(session, user_id, include_archived=True)
    portfolio = await assemble_goal_reads(session, user_id, goals, today=_today())
    item = next((item for item in portfolio.items if item.id == goal_id), None)
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
    user: User = Depends(current_user_jwt_or_pat),
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
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> GoalListRead:
    goals = await load_goals_ordered(
        session, user.id, include_archived=include_archived
    )
    portfolio = await assemble_goal_reads(session, user.id, goals, today=_today())
    return GoalListRead(
        items=portfolio.items,
        free_balance_minor=portfolio.free_balance_minor,
        free_balance_basis=portfolio.free_balance_basis,
        free_balance_months_with_data=portfolio.free_balance_months_with_data,
        realism_unavailable=portfolio.realism_unavailable,
        base_currency=portfolio.base_currency,
    )


@router.get("/{goal_id}", response_model=GoalRead, responses=_NOT_FOUND)
async def get_goal(
    goal_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
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
    user: User = Depends(current_user_jwt_or_pat),
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
    if "initial_budget_minor" in fields:
        goal.initial_budget_minor = payload.initial_budget_minor  # null clears
    if "final_cost_override_minor" in fields:
        # Null returns the goal to counting its final cost from the plan items
        # (goal-planner §5) — the nullable-clears rule, no *_REQUIRED code.
        goal.final_cost_override_minor = payload.final_cost_override_minor

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
    user: User = Depends(current_user_jwt_or_pat),
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
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> ContributionRead:
    # FOR UPDATE: the SUM invariant below spans rows, so concurrent writes to
    # this goal must serialize on the goal row (D10).
    goal = await _load_own_goal(session, goal_id, user.id, for_update=True)
    # Withdrawal guard: never below zero; exactly-to-zero is allowed.
    if (
        payload.amount_minor < 0
        and await saved_sum(session, goal.id) + payload.amount_minor < 0
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
    user: User = Depends(current_user_jwt_or_pat),
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
    user: User = Depends(current_user_jwt_or_pat),
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
        and await saved_sum(session, goal.id) - row.amount_minor < 0
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
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> list[ProgressPoint]:
    """Monthly series for the chart, current month included, empty months as 0.

    ``saved_end_minor`` is cumulative and includes the pre-window base sum, so
    the chart starts at the true balance (the client renders, never computes).
    """
    goal = await _load_own_goal(session, goal_id, user.id)
    current_first = _today().replace(day=1)
    window_start = shift_month(current_first, -(months - 1))

    month_col = func.date_trunc("month", GoalContribution.occurred_at)
    grouped = await session.execute(
        select(month_col, func.sum(GoalContribution.amount_minor))
        .where(
            GoalContribution.goal_id == goal.id,
            GoalContribution.occurred_at >= window_start,
            # Future-dated rows are excluded from the chart by decision
            # (card-vs-chart reconciliation flagged to plan-web).
            GoalContribution.occurred_at < shift_month(current_first, 1),
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
        month_first = shift_month(window_start, offset)
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
