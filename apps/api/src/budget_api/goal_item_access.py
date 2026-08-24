"""Shared goal/plan-node visibility helpers (the ``account_access.py`` shape).

Top-level neutral module for the same reason ``account_access.py`` is one: it
imports ``models`` and is imported by routers (``goal_items``, ``transactions``),
so there is no import cycle and no router imports another router.

Plan nodes carry no ``user_id`` of their own — ownership is the goal's, one JOIN
away (``goal_id`` is denormalized onto every node precisely so that this stays ONE
hop, §1). A foreign node and a missing node therefore resolve through ONE query to
ONE ``None``, which is what makes the ``404 GOAL_ITEM_NOT_FOUND`` they produce
byte-identical. The transactions write path leans on that: a payment aimed at
someone else's plan node must be indistinguishable from one aimed at nothing.

Archived goals are NOT filtered out here (the ``load_own_account`` rule): "exists
but the goal is archived" is a different answer from "does not exist", and the
caller decides — which is what lets the guard order stay NOT_FOUND before
ARCHIVED.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Goal, GoalItem


async def load_own_goal(
    session: AsyncSession, goal_id: uuid.UUID, user_id: uuid.UUID
) -> Goal | None:
    """The caller's own goal. Foreign/missing → None (one code path, no-oracle)."""
    return await session.scalar(
        select(Goal).where(Goal.id == goal_id, Goal.user_id == user_id)
    )


async def load_own_goal_item(
    session: AsyncSession, item_id: uuid.UUID, user_id: uuid.UUID
) -> tuple[GoalItem, Goal] | None:
    """The caller's own plan node AND its goal, in one query.

    The goal comes back with it because every caller needs it in the same breath:
    the archived gate reads ``goal.archived`` and every money read needs
    ``goal.currency``. Returning it here is what stops a second round-trip — and a
    second, possibly unscoped, way to fetch it.
    """
    row = (
        await session.execute(
            select(GoalItem, Goal)
            .join(Goal, Goal.id == GoalItem.goal_id)
            .where(GoalItem.id == item_id, Goal.user_id == user_id)
        )
    ).first()
    if row is None:
        return None
    return row[0], row[1]
