"""Plan-node CRUD — the tree half of a goal (goal-planner §1/§4/§10).

Mounted on ``/goals`` BEFORE ``routers/goals.py`` (app.py): the static segment
this router owns (``/goals/upcoming``) must be matched before ``/{goal_id}`` ever
sees it — the route-order landmine of backend.md. BOTH conditions are needed and
neither is enough on its own: the mount order settles this router against
``goals.py``, and the declaration order below settles ``/upcoming`` against the
parameterized routes in THIS file.

This module is the HTTP shell only. Every rolled-up number comes from
``services/goal_plan_reads`` (one recursive statement) and every rule about what
"the target" is comes from ``domain/goal_plan`` — nothing is computed here.

GUARD ORDER on every write, and it is load-bearing end to end:

1. the goal itself — user-scoped, foreign == missing → 404 ``GOAL_NOT_FOUND``;
2. archived goal → 422 ``GOAL_ARCHIVED``. Strictly AFTER (1), or a foreign
   archived goal would answer ARCHIVED and confirm it exists (the account_access
   rule);
3. ``parent_id`` resolved INSIDE this goal → 422 ``GOAL_ITEM_PARENT_NOT_FOUND``;
4. depth and the per-goal item limit;
5. cycle → 422 ``GOAL_ITEM_CYCLE``.

Steps 4 and 5 share ONE ancestor walk (``ancestor_ids``): the chain's LENGTH is
the depth and its MEMBERSHIP is the cycle test. The pre-write check is not the
guarantee, though — the ``trg_goal_items_no_cycle`` trigger from migration 0011
is, and the loser of a concurrent re-parent surfaces here as a ``check_violation``
which :func:`_commit` maps to the SAME 422 rather than a 500.
"""

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Request,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.domain.fx import convert_minor
from budget_api.goal_item_access import load_own_goal
from budget_api.mcp import prose
from budget_api.mcp.decorator import mcp_tool
from budget_api.models import Goal, GoalItem, GoalItemFile, User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.goal_item import (
    GoalItemCreate,
    GoalItemError,
    GoalItemList,
    GoalItemRead,
    GoalItemUpdate,
    MoveDirection,
    UpcomingDeadlineList,
    UpcomingDeadlineRead,
)
from budget_api.services.fx_lookup import lookup_rate
from budget_api.services.goal_plan_reads import (
    PlanNode,
    UpcomingItem,
    ancestor_ids,
    read_goal_tree,
    read_upcoming_deadlines,
    subtree_height,
    subtree_item_ids,
)
from budget_api.services.object_cleanup import delete_objects

router = APIRouter()

#: Gap between siblings (§10b): a plain swap needs no renumbering, and appending
#: is one max()+step. Only an exhausted gap (two equal orders) triggers the
#: renumbering arm in :func:`_apply_move`.
_SORT_STEP = 1024

#: PATCH fields that feed the goal-currency conversion — touching any of them
#: invalidates a stored auto-computed pair (the transactions ``_CONVERSION_INPUTS``
#: rule). There is no date here: an item has no operation date, so its rate is
#: always "today's" (plan §0 U-3).
_CONVERSION_INPUTS = frozenset({"amount_minor", "currency"})

_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": GoalItemError}
}
#: The honest anyOf union (house 422 pattern): business codes AND FastAPI's own
#: Pydantic array both occur at runtime, so declaring only the model would make
#: the generated client lie about one arm.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/GoalItemError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}


def _today() -> date:
    return datetime.now(UTC).date()


def _unprocessable(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=code)


async def _require_own_goal(
    session: AsyncSession, goal_id: uuid.UUID, user_id: uuid.UUID
) -> Goal:
    goal = await load_own_goal(session, goal_id, user_id)
    if goal is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_NOT_FOUND"
        )
    return goal


def _reject_archived(goal: Goal) -> None:
    """422 on a write into an archived goal (§10d). NEVER call it before the 404
    above: answering GOAL_ARCHIVED for someone else's goal would confirm it
    exists. Archiving deletes nothing — the plan and its files stay put, and
    unarchiving brings everything back."""
    if goal.archived:
        raise _unprocessable("GOAL_ARCHIVED")


async def _require_item(
    session: AsyncSession, goal: Goal, item_id: uuid.UUID
) -> GoalItem:
    """The node, scoped by BOTH the (own-checked) goal and its id.

    Foreign / missing / belonging-to-another-of-my-goals are one code path and one
    byte-identical 404 (no-oracle).
    """
    item = await session.scalar(
        select(GoalItem).where(GoalItem.id == item_id, GoalItem.goal_id == goal.id)
    )
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_ITEM_NOT_FOUND"
        )
    return item


async def _resolve_parent(
    session: AsyncSession, goal: Goal, parent_id: uuid.UUID
) -> GoalItem:
    """The parent, which MUST be a node of this same goal.

    422 rather than 404: the addressed resource (the goal) is fine — it is the
    BODY reference that is wrong, exactly as with a foreign ``category_id`` on a
    transaction. The composite FK spells the same rule at the DB level, so this
    check exists to produce a code the form can act on instead of a 500.
    """
    parent = await session.scalar(
        select(GoalItem).where(GoalItem.id == parent_id, GoalItem.goal_id == goal.id)
    )
    if parent is None:
        raise _unprocessable("GOAL_ITEM_PARENT_NOT_FOUND")
    return parent


async def _check_depth_and_cycle(
    session: AsyncSession,
    settings: Settings,
    goal: Goal,
    parent: GoalItem,
    *,
    moving: GoalItem | None,
) -> None:
    """ONE ancestor walk answering both questions (§4 of the plan).

    ``moving`` is the node being re-parented (None on create). Its membership in
    the target's ancestor chain is precisely "the target is my own descendant",
    and the chain's length is the depth the node lands at. A move also carries its
    SUBTREE, so the limit is checked against the subtree's height — a re-parent
    that puts a leaf on level 7 is the same refusal as creating one there.
    """
    chain = await ancestor_ids(session, goal.id, parent.id)
    if moving is not None and moving.id in chain:
        raise _unprocessable("GOAL_ITEM_CYCLE")
    height = 1 if moving is None else await subtree_height(session, goal.id, moving.id)
    if len(chain) + height > settings.goal_item_max_depth:
        raise _unprocessable("GOAL_ITEM_DEPTH_EXCEEDED")


async def _check_items_limit(
    session: AsyncSession, settings: Settings, goal: Goal
) -> None:
    """Per-goal node cap — a plain COUNT, with NO advisory lock, deliberately.

    Contrast with "one transaction belongs to one node", which IS a DB-level
    guarantee: there the cost of losing a race is MONEY counted twice, so it is
    made unrepresentable. Here the cost is a 501st item on a screen — an interface
    guard, not a money invariant — and serializing every create on a goal-wide
    lock would be a real price paid for an imaginary problem (PM, §8).
    """
    count = await session.scalar(
        select(func.count()).select_from(GoalItem).where(GoalItem.goal_id == goal.id)
    )
    if (count or 0) >= settings.goal_items_max_per_goal:
        raise _unprocessable("GOAL_ITEMS_LIMIT_EXCEEDED")


def _reject_double_reminder(remind_on: date | None, days_before: int | None) -> None:
    """Reminder intent is exactly one of two, or none (§6, CHECK in 0011).

    Refused here so the CHECK can never turn a client mistake into a 500: "on this
    date" and "N days before the deadline" are two different requests, and storing
    both would leave the reader to pick one.
    """
    if remind_on is not None and days_before is not None:
        raise _unprocessable("GOAL_ITEM_REMIND_CONFLICT")


async def _convert_to_goal_currency(
    session: AsyncSession, amount_minor: int, currency: str, goal: Goal
) -> tuple[int | None, str | None]:
    """Auto-fill the goal-currency pair, or (None, None) when no rate exists.

    NOT ``auto_snapshot``: that helper converts to the PROFILE's base currency,
    and a plan item's second amount is denominated in the GOAL's currency. The
    rate is today's (nearest-previous) because an item has no operation date —
    there is no historical moment to price it at.
    """
    found = await lookup_rate(session, currency, goal.currency, _today())
    if found is None:
        return None, None
    return convert_minor(amount_minor, currency, goal.currency, found.rate), (
        goal.currency
    )


async def _next_sort_order(
    session: AsyncSession, goal_id: uuid.UUID, parent_id: uuid.UUID | None
) -> int:
    """Append: max(sibling) + step (§10b)."""
    stmt = select(func.max(GoalItem.sort_order)).where(GoalItem.goal_id == goal_id)
    stmt = stmt.where(
        GoalItem.parent_id.is_(None)
        if parent_id is None
        else GoalItem.parent_id == parent_id
    )
    current = await session.scalar(stmt)
    return (current or 0) + _SORT_STEP


async def _apply_move(
    session: AsyncSession, item: GoalItem, direction: MoveDirection
) -> None:
    """Swap the node with its neighbour among siblings, inside THIS transaction.

    The client never sends a position (PM Q3): "up" is resolved against the
    sibling order as it is right now, under ``FOR UPDATE`` on the sibling set, so
    two concurrent moves cannot interleave into an order neither user asked for.
    At the boundary it is an idempotent no-op.

    The normal case is one swap of two integers. The renumbering arm exists for
    siblings that ended up sharing an order (the step is finite, and rows can be
    imported): it re-lays the whole sibling list at ``_SORT_STEP`` intervals — in
    the same transaction, so nobody can observe a half-renumbered tree.
    """
    stmt = (
        select(GoalItem)
        .where(GoalItem.goal_id == item.goal_id)
        .where(
            GoalItem.parent_id.is_(None)
            if item.parent_id is None
            else GoalItem.parent_id == item.parent_id
        )
        .order_by(GoalItem.sort_order, GoalItem.id)
        .with_for_update()
        # The lock is only half the guarantee: whoever waited here would otherwise
        # get the identity map's PRE-lock rows back and swap STALE sort_order
        # values over the winner's write. populate_existing refreshes them.
        .execution_options(populate_existing=True)
    )
    siblings = list((await session.scalars(stmt)).all())
    index = next((i for i, sib in enumerate(siblings) if sib.id == item.id), None)
    if index is None:
        # Deleted or re-parented by a concurrent request between the load and the
        # lock: the node this move addresses is no longer here, which is the house
        # 404 — never a StopIteration 500.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_ITEM_NOT_FOUND"
        )
    target = index - 1 if direction == "up" else index + 1
    if target < 0 or target >= len(siblings):
        return  # already first / last — nothing to do, and that is not an error
    neighbour = siblings[target]
    if neighbour.sort_order != item.sort_order:
        item.sort_order, neighbour.sort_order = neighbour.sort_order, item.sort_order
        return
    siblings[index], siblings[target] = siblings[target], siblings[index]
    for position, sibling in enumerate(siblings, start=1):
        sibling.sort_order = position * _SORT_STEP


def _is_cycle_violation(exc: IntegrityError) -> bool:
    """Was this the cycle backstop (or its cheap ``parent_id <> id`` twin)?

    Decided by SQLSTATE + the trigger's own message rather than by sniffing the
    driver: 23514 is ``check_violation``, which every other CHECK on the table
    also raises, and turning an unrelated one into GOAL_ITEM_CYCLE would be a lie.
    """
    orig = exc.orig
    if getattr(orig, "sqlstate", None) != "23514":
        return False
    message = str(orig)
    return "cycle" in message or "parent_not_self" in message


@asynccontextmanager
async def _cycle_guard(session: AsyncSession) -> AsyncGenerator[None]:
    """Map the trigger's refusal — wherever it surfaces — to the router's own 422.

    The loser of two concurrent re-parents passes the pre-write check (it reads a
    state in which the winner has not committed yet) and is stopped by
    ``trg_goal_items_no_cycle``. That must reach the client as the SAME
    GOAL_ITEM_CYCLE the sequential case produces — a 500 would tell a user who did
    something ordinary that the server broke.

    It wraps the whole write region, not just ``commit()``, and that is
    load-bearing: a pending ``parent_id`` change is flushed by the very next SELECT
    (autoflush), so the trigger can fire while the handler is still deciding a sort
    order — well before any commit.
    """
    try:
        yield
    except IntegrityError as exc:
        await session.rollback()
        if _is_cycle_violation(exc):
            raise _unprocessable("GOAL_ITEM_CYCLE") from exc
        raise


def _serialize(node: PlanNode, goal_id: uuid.UUID) -> GoalItemRead:
    return GoalItemRead(
        id=node.id,
        goal_id=goal_id,
        parent_id=node.parent_id,
        depth=node.depth,
        name=node.name,
        description=node.description,
        links=node.links,
        amount_minor=node.amount_minor,
        currency=node.currency,
        converted_minor=node.converted_minor,
        converted_currency=node.converted_currency,
        deadline=node.deadline,
        effective_deadline=node.effective_deadline,
        deadline_inherited=node.deadline_inherited,
        remind_on=node.remind_on,
        remind_days_before=node.remind_days_before,
        children_sum_minor=node.children_sum_minor,
        planned_unconverted_count=node.planned_unconverted_count,
        ceiling_exceeded=node.ceiling_exceeded,
        paid_minor=node.paid_minor,
        paid_unconverted_count=node.paid_unconverted_count,
        files_count=node.files_count,
        subtree_files_count=node.subtree_files_count,
        sort_order=node.sort_order,
        created_at=node.created_at,
    )


async def _read_one(
    session: AsyncSession, goal: Goal, item_id: uuid.UUID
) -> GoalItemRead:
    """One node, computed by the SAME whole-tree read the list uses.

    A node's numbers are rollups over its subtree, so there is no cheaper honest
    answer than the tree — and computing a write's response any other way is how
    a single GET and a POST start disagreeing.
    """
    tree = await read_goal_tree(session, goal, today=_today())
    node = next((n for n in tree.nodes if n.id == item_id), None)
    if node is None:
        # Concurrent delete between the write and this re-read: the same no-oracle
        # 404, never a 500.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_ITEM_NOT_FOUND"
        )
    return _serialize(node, goal.id)


def _serialize_upcoming(item: UpcomingItem) -> UpcomingDeadlineRead:
    return UpcomingDeadlineRead(
        goal_id=item.goal_id,
        goal_name=item.goal_name,
        goal_currency=item.goal_currency,
        item_id=item.item_id,
        item_name=item.item_name,
        breadcrumb=item.breadcrumb,
        effective_deadline=item.effective_deadline,
        deadline_inherited=item.deadline_inherited,
        reminder_date=item.reminder_date,
        amount_minor=item.amount_minor,
        currency=item.currency,
        paid_minor=item.paid_minor,
        paid_unconverted_count=item.paid_unconverted_count,
    )


@router.get("/upcoming", response_model=UpcomingDeadlineList, tags=["goal-items"])
@mcp_tool(
    name="list_upcoming_goal_deadlines",
    description=(
        "What is coming up across ALL of the user's goal plans: the plan items whose "
        "reminder or deadline falls inside the next few days, in one list, soonest "
        'date first. Use it for "what do I need to deal with soon" — it is about '
        "DATES, not about progress; goal-wide money lives in list_goals and a single "
        "plan in get_goal_plan. THE SERVER WORKS THE DATES OUT, NEVER YOU: "
        "`effective_deadline` is the date actually in force (an item inherits it "
        "from its parent, and in the end from the goal — `deadline_inherited` says "
        "whether it did), and `reminder_date` is where the user's reminder actually "
        "falls; a null `reminder_date` simply means this row is here on its "
        "deadline. Never add or subtract days to produce a date of your own. "
        '`breadcrumb` is the chain of parent items above this one ("Japan trip" > '
        '"Tokyo"), which is what tells the user WHAT the item belongs to — say it, '
        'because an item name on its own ("Hotel") is ambiguous. Money is INTEGER '
        "MINOR UNITS (12.34 EUR is 1234; JPY has no minor unit, so 500 JPY is 500): "
        "`amount_minor` is the item's own price in its OWN `currency`, while "
        "`paid_minor` is what has already been paid for the item AND everything "
        "under it, in `goal_currency` — the two are often different currencies, so "
        "never add them and never add rows together; this list spans goals and has "
        "no single currency. `paid_unconverted_count` above zero means some payments "
        "had no rate and are missing from `paid_minor` — say so rather than treating "
        "them as nothing. ARCHIVED goals are not here at all, so a missing item may "
        "just belong to one."
    ),
    params={
        "days": (
            "How far ahead to look, in days from today (1-90, default 30) — this is "
            "the ONLY lever on what is listed, so an item the user expected is "
            "usually just outside the window. Dates already in the past are never "
            "returned."
        ),
    },
)
async def list_upcoming_deadlines(
    user: User = Depends(current_user_jwt_or_pat),
    days: int = Query(default=30, ge=1, le=90),
    session: AsyncSession = Depends(get_session),
) -> UpcomingDeadlineList:
    """Plan nodes across ALL live goals whose date lands in the next ``days`` (§6).

    Declared BEFORE every ``/{goal_id}`` route in this module (see the module
    docstring): after them, "upcoming" would be read as a goal id and 404.

    A node is here for exactly one of two reasons, and the reminder wins: with a
    reminder set, the REMINDER date decides alone — a node whose reminder has
    already passed stays out even though its deadline is days away, because the
    user chose when to be told. Without one, the effective (inherited) deadline
    decides. Archived goals are absent entirely (§10d): archiving deletes nothing,
    so unarchiving brings every row straight back.

    No business 422 of its own — ``days`` is a bounded Query, so FastAPI's own
    ``HTTPValidationError`` is the only honest 422 arm (the ``/recurring/upcoming``
    precedent) and no ``responses`` override is declared.
    """
    today = _today()
    items = await read_upcoming_deadlines(
        session, user.id, today=today, through=today + timedelta(days=days)
    )
    return UpcomingDeadlineList(items=[_serialize_upcoming(item) for item in items])


@router.get(
    "/{goal_id}/items",
    response_model=GoalItemList,
    responses=_NOT_FOUND,
    tags=["goal-items"],
)
@mcp_tool(
    name="get_goal_plan",
    description=(
        'The PLAN of ONE goal: every item the user broke it into ("flights", '
        '"hotel", "visa"), flat, with the numbers the server already computed. This '
        "is where every plan node id — the `item_id` and `parent_id` of the "
        "goal-item tools and the `goal_item_id` of a transaction — comes from. "
        "Assemble the TREE from `parent_id` (null means a root, `depth` is 1 there); "
        "the rows arrive in display order. MONEY IS SUMMED BOTTOM-UP BY THE SERVER: "
        "`children_sum_minor` is what a node and everything under it costs, in the "
        "goal currency named ONCE per response in `goal_currency`; for a leaf it is "
        "just its own price. NEVER add the rows up — a parent already contains its "
        "children, so a sum over the list double-counts; the goal-wide totals are in "
        "get_goal. `amount_minor` is the node's OWN price, in its own `currency`, "
        "which may differ from the goal's: it is what the user said this item should "
        "cost, a guideline — `ceiling_exceeded: true` means the children add up to "
        "more than it, which is worth telling the user and is NOT an error. "
        "`converted_minor` is that price in the goal currency; when it and "
        "`converted_currency` are null there was no rate, the node is counted in "
        "`planned_unconverted_count` instead of being summed, and any total you "
        "quote is understated — say so rather than treating it as zero. DATES ARE "
        "INHERITED: `deadline` is the node's own and is often null, "
        "`effective_deadline` is the one actually in force (nearest ancestor with a "
        "date, else the goal's) and `deadline_inherited` says which — quote "
        "`effective_deadline`, never work a date out yourself. `paid_minor` is what "
        "has already been paid against the node AND its subtree (the transactions "
        "linked to it; list them with list_transactions.goal_item_id), with the same "
        "caveat in `paid_unconverted_count`. `files_count` and `subtree_files_count` "
        "count attachments the user manages in the apps — there is no file tool here."
    ),
    params={
        "goal_id": "Goal id from list_goals.",
    },
)
async def list_goal_items(
    goal_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> GoalItemList:
    """The goal's whole plan, flat, in ONE recursive statement (never N+1)."""
    goal = await _require_own_goal(session, goal_id, user.id)
    tree = await read_goal_tree(session, goal, today=_today())
    return GoalItemList(
        items=[_serialize(node, goal.id) for node in tree.nodes],
        goal_currency=tree.goal_currency,
    )


@router.post(
    "/{goal_id}/items",
    response_model=GoalItemRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
    tags=["goal-items"],
)
@mcp_tool(
    name="create_goal_item",
    description=(
        "Add ONE item to ONE goal's plan — something that has to be bought or "
        'booked. Only `name` is required: a grouping node ("Transport") needs NO '
        "price of its own, the children carry the money and the server adds them up. "
        "Call get_goal_plan FIRST — a second node for something the plan already has "
        "splits one cost into two, and it is also the only source of `parent_id`. "
        "Amounts are INTEGER MINOR UNITS and the SERVER does every sum and every "
        "conversion: never total a plan up yourself. One node per call; the new id "
        "comes back in the response. The plan of an ARCHIVED goal is closed to "
        "writes. There is no tool to remove a node — deleting one would take its "
        "whole subtree and the user's files with it, so it is done in the app."
    ),
    params={
        "goal_id": (
            "Goal id from list_goals — the plan belongs to this goal, and so must "
            "`parent_id`."
        ),
        "name": 'What the user calls this item, e.g. "Flights" or "Hotel in Kyoto".',
        "parent_id": (
            "Nest this node under an existing one. "
            + prose.GOAL_ITEM_PARENT
            + " Omit it for a top-level item of the plan."
        ),
        "description": (
            "Free-text details the user gave: booking reference, address, what is "
            "included. Not a place for amounts — those belong in `amount_minor`."
        ),
        "links": (
            "Reference URLs the user pasted (a listing, a booking page). Send them "
            "as given."
        ),
        "amount_minor": (
            "What THIS item costs, in `currency` and "
            + prose.GOAL_ITEM_MINOR
            + ". Optional: leave it out for a pure grouping node. "
            + prose.GOAL_ITEM_CEILING
        ),
        "currency": (
            "Currency of `amount_minor`, ISO 4217 uppercase. OMIT it and the GOAL's "
            "currency is stamped — send it only for an item genuinely priced in "
            "another one (a hotel billed in JPY inside a EUR goal), and the server "
            "then converts it into the goal currency at its own daily rate."
        ),
        "converted_minor": (
            "What this item comes to in the goal's currency, "
            + prose.GOAL_ITEM_CONVERTED
        ),
        "deadline": (
            "The date THIS item must be done by, as YYYY-MM-DD. Omit it and the node "
            "INHERITS the date in force: the nearest ancestor that has one, else the "
            "goal's deadline. Prefer inheriting — copying the parent's date down "
            "freezes it, so it stops following when the parent moves."
        ),
        "remind_on": prose.GOAL_ITEM_REMIND_ON,
        "remind_days_before": prose.GOAL_ITEM_REMIND_DAYS,
    },
)
async def create_goal_item(
    goal_id: uuid.UUID,
    payload: GoalItemCreate,
    request: Request,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> GoalItemRead:
    settings: Settings = request.app.state.settings
    goal = await _require_own_goal(session, goal_id, user.id)
    _reject_archived(goal)
    parent = (
        None
        if payload.parent_id is None
        else await _resolve_parent(session, goal, payload.parent_id)
    )
    if parent is not None:
        # No cycle is possible on create — the row does not exist yet, so it cannot
        # be its own ancestor. The same walk still owns the depth check.
        await _check_depth_and_cycle(session, settings, goal, parent, moving=None)
    await _check_items_limit(session, settings, goal)
    _reject_double_reminder(payload.remind_on, payload.remind_days_before)

    currency = payload.currency or goal.currency
    if payload.amount_minor is None:
        if payload.converted_minor is not None:
            # A conversion of nothing (the DB CHECK agrees) — refused with the
            # code the form already knows from transactions.
            raise _unprocessable("AMOUNT_REQUIRED")
        converted_minor, converted_currency = None, None
    elif currency == goal.currency:
        if payload.converted_minor is not None:
            # The item's amount ALREADY is the goal-currency number; a second,
            # independently editable copy of it could only ever be a lie (the
            # BASE_AMOUNT_WITHOUT_CURRENCY precedent).
            raise _unprocessable("GOAL_ITEM_CONVERTED_NOT_APPLICABLE")
        converted_minor, converted_currency = None, None
    elif payload.converted_minor is not None:
        # Manual wins over automatic — the house invariant, stored verbatim.
        converted_minor, converted_currency = payload.converted_minor, goal.currency
    else:
        converted_minor, converted_currency = await _convert_to_goal_currency(
            session, payload.amount_minor, currency, goal
        )

    item = GoalItem(
        goal_id=goal.id,
        parent_id=None if parent is None else parent.id,
        name=payload.name,
        description=payload.description,
        links=payload.links or [],
        amount_minor=payload.amount_minor,
        currency=currency,
        converted_minor=converted_minor,
        converted_currency=converted_currency,
        deadline=payload.deadline,
        remind_on=payload.remind_on,
        remind_days_before=payload.remind_days_before,
        sort_order=await _next_sort_order(
            session, goal.id, None if parent is None else parent.id
        ),
    )
    async with _cycle_guard(session):
        session.add(item)
        await session.commit()
    return await _read_one(session, goal, item.id)


@router.patch(
    "/{goal_id}/items/{item_id}",
    response_model=GoalItemRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
    tags=["goal-items"],
)
@mcp_tool(
    name="update_goal_item",
    description=(
        "Correct ONE node of a goal's plan, or move it. Send only the fields that "
        "change; omitted fields keep their value. Take `goal_id` from list_goals and "
        "`item_id` from get_goal_plan, never guess either. RESTRUCTURING happens "
        "here too: `parent_id` moves the node WITH everything under it, and `move` "
        "swaps it with the neighbouring sibling. Money stays the server's: a node's "
        "own price is a guideline, the sums are recomputed from the leaves on the "
        "next get_goal_plan. Always prefer fixing a node to asking the user to "
        "recreate it — there is no delete tool here at all."
    ),
    params={
        "goal_id": "Goal id from list_goals.",
        "item_id": "Plan node id from get_goal_plan.",
        "name": "New name.",
        "parent_id": (
            "Move this node — with its whole subtree — under another node. "
            + prose.GOAL_ITEM_PARENT
            + " A node cannot be moved under itself or under one of its own "
            "descendants, and the plan has a maximum nesting depth; both are "
            "refused. "
            + prose.KEEP
            + " So a nested node cannot be made a top-level one here — that is done in "
            "the app."
        ),
        "description": ("New details, replacing the old text. " + prose.KEEP),
        "links": (
            "New list of reference URLs. It REPLACES the whole list rather than "
            "adding to it, so include the links that should stay."
        ),
        "amount_minor": (
            "New price for THIS node, in its own currency and "
            + prose.GOAL_ITEM_MINOR
            + ". "
            + prose.GOAL_ITEM_CEILING
        ),
        "currency": (
            "New currency of `amount_minor`, ISO 4217 uppercase. Changing it makes "
            "the server redo the goal-currency conversion, so do not send a stale "
            "`converted_minor` beside it — only a figure the user just gave you."
        ),
        "converted_minor": (
            "New goal-currency figure for this node, " + prose.GOAL_ITEM_CONVERTED
        ),
        "deadline": (
            "New own date for this node, as YYYY-MM-DD. "
            + prose.KEEP
            + " So a node that inherits its date can be given one here, but a date "
            "once set cannot be handed back to inheritance through this server — "
            "that is done in the app."
        ),
        "remind_on": (
            prose.GOAL_ITEM_REMIND_ON + " " + prose.KEEP + " " + prose.REMIND_SWITCH
        ),
        "remind_days_before": (
            prose.GOAL_ITEM_REMIND_DAYS + " " + prose.KEEP + " " + prose.REMIND_SWITCH
        ),
        "move": (
            "Reorder among SIBLINGS: `up` swaps this node with the one before it, "
            "`down` with the one after. There is no position or sort number to write "
            "— the server owns those and does the swap in one step. ONE step per "
            "call, and at the top (or the bottom) it simply does nothing instead of "
            "failing. It changes only the display order: no amount, no parent, no "
            "date."
        ),
    },
)
async def update_goal_item(
    goal_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: GoalItemUpdate,
    request: Request,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> GoalItemRead:
    settings: Settings = request.app.state.settings
    goal = await _require_own_goal(session, goal_id, user.id)
    _reject_archived(goal)
    item = await _require_item(session, goal, item_id)

    fields = payload.model_fields_set
    # NOT NULL columns reject an explicit null with the house *_REQUIRED code;
    # every other field here is nullable and an explicit null clears it.
    if "name" in fields and payload.name is None:
        raise _unprocessable("NAME_REQUIRED")
    if "currency" in fields and payload.currency is None:
        raise _unprocessable("CURRENCY_REQUIRED")

    # ---- re-parenting ---------------------------------------------------------
    reparent = "parent_id" in fields and payload.parent_id != item.parent_id
    new_parent: GoalItem | None = None
    if reparent and payload.parent_id is not None:
        if payload.parent_id == item.id:
            # Its own parent: the cheap self-cycle, refused before the CHECK can
            # turn it into a 500.
            raise _unprocessable("GOAL_ITEM_CYCLE")
        new_parent = await _resolve_parent(session, goal, payload.parent_id)
        await _check_depth_and_cycle(session, settings, goal, new_parent, moving=item)

    # ---- reminder intent ------------------------------------------------------
    eff_remind_on = payload.remind_on if "remind_on" in fields else item.remind_on
    eff_days_before = (
        payload.remind_days_before
        if "remind_days_before" in fields
        else item.remind_days_before
    )
    # The EFFECTIVE pair, not the sent one: setting a fixed date on a node that
    # already asks for "N days before" is the same illegal row as sending both.
    _reject_double_reminder(eff_remind_on, eff_days_before)

    # ---- money ----------------------------------------------------------------
    # The values this PATCH will LEAVE BEHIND decide the pair, so "change the
    # currency and send an override" is resolved once instead of half-applied.
    eff_currency = payload.currency if "currency" in fields else item.currency
    assert eff_currency is not None  # 422-guarded above
    eff_amount = payload.amount_minor if "amount_minor" in fields else item.amount_minor
    sent_converted = "converted_minor" in fields and payload.converted_minor is not None
    if eff_amount is None:
        if sent_converted:
            raise _unprocessable("AMOUNT_REQUIRED")
        converted_minor, converted_currency = None, None
    elif eff_currency == goal.currency:
        if sent_converted:
            raise _unprocessable("GOAL_ITEM_CONVERTED_NOT_APPLICABLE")
        converted_minor, converted_currency = None, None
    elif sent_converted:
        assert payload.converted_minor is not None
        converted_minor, converted_currency = payload.converted_minor, goal.currency
    elif "converted_minor" in fields or fields & _CONVERSION_INPUTS:
        # An explicit null DISCARDS the override and recomputes, and a moved
        # conversion input does the same: a bare clear would claim "no rate
        # existed", which is a different fact (the transactions row-5 rule).
        converted_minor, converted_currency = await _convert_to_goal_currency(
            session, eff_amount, eff_currency, goal
        )
    else:
        converted_minor, converted_currency = (
            item.converted_minor,
            item.converted_currency,
        )

    # The append position in the NEW sibling list, resolved before the parent write:
    # afterwards the pending change would be autoflushed into the max() itself.
    appended_sort_order = (
        await _next_sort_order(session, goal.id, payload.parent_id)
        if reparent
        else None
    )

    async with _cycle_guard(session):
        await _apply_update(
            session,
            payload,
            item,
            fields=fields,
            eff_currency=eff_currency,
            converted=(converted_minor, converted_currency),
            reparent=reparent,
            appended_sort_order=appended_sort_order,
        )
        await session.commit()
    return await _read_one(session, goal, item.id)


async def _apply_update(
    session: AsyncSession,
    payload: GoalItemUpdate,
    item: GoalItem,
    *,
    fields: set[str],
    eff_currency: str,
    converted: tuple[int | None, str | None],
    reparent: bool,
    appended_sort_order: int | None,
) -> None:
    """The field writes of one PATCH — every guard has already passed.

    Extracted so the whole write region sits inside ONE ``_cycle_guard`` (see its
    docstring: an autoflush can fire the trigger before the commit does).
    """
    converted_minor, converted_currency = converted
    if "name" in fields:
        assert payload.name is not None  # 422-guarded above
        item.name = payload.name
    if "description" in fields:
        item.description = payload.description  # null/"" clears (validator normalized)
    if "links" in fields:
        item.links = payload.links or []
    if "amount_minor" in fields:
        item.amount_minor = payload.amount_minor  # explicit null clears
    if "currency" in fields:
        item.currency = eff_currency
    item.converted_minor, item.converted_currency = converted_minor, converted_currency
    if "deadline" in fields:
        # An explicit null RESTORES inheritance — the column is never filled in
        # with the date the node was showing (task.md).
        item.deadline = payload.deadline
    if "remind_on" in fields:
        item.remind_on = payload.remind_on
    if "remind_days_before" in fields:
        item.remind_days_before = payload.remind_days_before
    if reparent:
        item.parent_id = payload.parent_id
        # A moved node joins the end of its new sibling list; its old order number
        # means nothing there.
        assert appended_sort_order is not None
        item.sort_order = appended_sort_order
    if payload.move is not None:
        # AFTER the re-parent above, so "move up" in one request with a move means
        # "up among the NEW siblings" — the only reading that is not surprising.
        await _apply_move(session, item, payload.move)


@router.delete(
    "/{goal_id}/items/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
    tags=["goal-items"],
)
# MCP: no — cascades over the subtree and the user's files
async def delete_goal_item(
    goal_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    background: BackgroundTasks,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete the node AND its subtree; linked transactions survive, unlinked.

    Both halves are constraints, not code (§3/§7): ``parent_id`` cascades over the
    subtree, and ``transactions.goal_item_id`` is ON DELETE SET NULL — so no path
    through this app, or through psql, can delete a user's money by deleting a
    plan node. Attached FILES are removed with the rows by the same cascade, and
    their stored objects are swept afterwards by a best-effort background job.

    The object keys are collected BEFORE the delete, and that order is the whole
    trick: once the CASCADE has run, nothing on this server knows what the subtree
    used to hold. The sweep then runs after the COMMIT, so unreachable storage
    cannot block a user from deleting their own node — the row is the truth, and
    an orphaned object is a leak of disk, not of data (§7).
    """
    goal = await _require_own_goal(session, goal_id, user.id)
    _reject_archived(goal)
    item = await _require_item(session, goal, item_id)
    node_ids = await subtree_item_ids(session, goal.id, item.id)
    storage_paths = list(
        (
            await session.scalars(
                select(GoalItemFile.storage_path).where(
                    GoalItemFile.goal_item_id.in_(node_ids)
                )
            )
        ).all()
    )
    await session.delete(item)
    await session.commit()
    background.add_task(delete_objects, request.app.state.storage, storage_paths)
