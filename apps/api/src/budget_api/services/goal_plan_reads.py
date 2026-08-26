"""Recursive plan reads: ONE statement per tree, ONE grouped query per goal list.

The named risk of the scope (task.md §Риски) is N+1: sums, "paid" and inherited
deadlines all roll up a tree, and the obvious implementation walks it node by node.
Nothing here does. :func:`read_goal_tree` is a single recursive CTE (§4 + plan §0 U-2);
:func:`goal_plan_totals` answers the whole goal LIST with two grouped queries plus
one rate lookup per distinct currency basket.

Money reading follows the house bucket order, spelled twice for two different
questions:

* **planned** (a node's own price) reads the STORED pair only — the item's own
  currency if it already is the goal's, else the goal-currency snapshot taken at
  write time. Nothing is converted at read time; a node with neither is EXCLUDED
  from the sum and counted in ``planned_unconverted_count`` (never a silent zero).
* **paid** (linked transactions) has THREE arms (plan §5 D-1, accepted): the
  transaction's own currency when it is the goal's, else its BASE snapshot when
  that is the goal's — this arm is what makes a user's manual base override win,
  the house invariant — else the transaction's currency, live-converted ONE rate per
  currency basket (plan §0 U-3). A basket with no rate is excluded whole and its
  operation count goes to ``paid_unconverted_count``.

There is no stored "paid" anywhere (plan §0 U-3): the only new column on
``transactions`` is the link itself, so a payment edited in the transactions
screen cannot leave a stale aggregate behind on a goal.
"""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Uuid, bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.fx import convert_minor
from budget_api.domain.goal_plan import ceiling_exceeded, reminder_date
from budget_api.models import Goal
from budget_api.services.fx_lookup import lookup_rate

#: ``{currency: [amount_minor, operation_count]}`` as the SQL hands it over. The
#: operation count rides INSIDE the basket rather than as one total per node
#: (architecture §4's shape) because a rateless basket has to be counted while the
#: others are summed — a single node-level total could not tell them apart.
_Baskets = dict[str, list[int]]

#: ``(from_currency, to_currency)`` → the resolved rate, or None when there is
#: none. One entry per basket for a whole tree / a whole goal list.
_RateCache = dict[tuple[str, str], Decimal | None]


@dataclass(frozen=True)
class PlanNode:
    """One node of the tree, with everything the client must not recompute."""

    id: uuid.UUID
    parent_id: uuid.UUID | None
    depth: int
    name: str
    description: str | None
    links: list[str]
    amount_minor: int | None
    currency: str
    converted_minor: int | None
    converted_currency: str | None
    deadline: date | None
    effective_deadline: date | None
    deadline_inherited: bool
    remind_on: date | None
    remind_days_before: int | None
    sort_order: int
    created_at: datetime  # tz-aware
    #: Σ of the subtree's LEAF prices in the goal's currency — the working number
    #: that rolls up (§5). A leaf's own price IS its children_sum (one rule, not
    #: two: a leaf is the only leaf of its own subtree).
    children_sum_minor: int
    #: Leaves of this node's subtree EXCLUDED from ``children_sum_minor`` for want
    #: of a goal-currency reading (§4). Node-level, because the goal-level counter
    #: says a number is understated but not WHICH branch understates it.
    planned_unconverted_count: int
    ceiling_exceeded: bool
    paid_minor: int
    paid_unconverted_count: int
    files_count: int
    subtree_files_count: int


@dataclass(frozen=True)
class GoalTree:
    nodes: list[PlanNode]
    #: ONE echo per response: every rolled-up number above is in THIS currency,
    #: and a client must never infer a currency from a neighbouring field (AM-5).
    goal_currency: str


@dataclass(frozen=True)
class UpcomingItem:
    """One row of ``GET /goals/upcoming`` — a node whose date is coming up (§6).

    Self-contained on purpose: the list spans GOALS, so there is no single
    currency to echo once per response the way ``GoalTree`` does. Every money
    field therefore carries its own currency ON THE ROW (AM-5) — ``currency``
    labels ``amount_minor`` (the node's own price, in whatever the user typed it),
    ``goal_currency`` labels ``paid_minor`` (the goal's, because that is what a
    subtree rollup is always expressed in). The two are frequently different, and
    nothing here may be added across rows.
    """

    goal_id: uuid.UUID
    goal_name: str
    goal_currency: str
    item_id: uuid.UUID
    item_name: str
    #: Ancestor names from the root DOWN to the parent, this node excluded — what
    #: the item belongs to, which a bare name out of its tree cannot say.
    breadcrumb: list[str]
    effective_deadline: date | None
    deadline_inherited: bool
    #: The resolved reminder date (``domain.goal_plan.reminder_date``), null when
    #: the node carries no reminder — or carries an offset with no deadline to
    #: count back from.
    reminder_date: date | None
    amount_minor: int | None
    currency: str
    paid_minor: int
    paid_unconverted_count: int
    created_at: datetime  # tz-aware; the sort tiebreak


@dataclass(frozen=True)
class PlanTotals:
    """Goal-level plan figures — the ``GoalRead`` half of §5/§8."""

    has_items: bool
    planned_total_minor: int
    planned_unconverted_count: int
    paid_minor: int
    paid_unconverted_count: int


_EMPTY_TOTALS = PlanTotals(
    has_items=False,
    planned_total_minor=0,
    planned_unconverted_count=0,
    paid_minor=0,
    paid_unconverted_count=0,
)

#: The whole tree of ONE goal, with every rollup, in one statement (§4).
#:
#: ``tree`` carries only what the recursion itself needs (identity, the path array,
#: the inherited deadline and the goal-currency price); the plain display columns
#: are joined back once at the end instead of being dragged through every level.
#:
#: ``rollup``/``paid``/``files_subtree`` all use the same trick: CROSS JOIN LATERAL
#: unnest(path) turns "every node" into "every (node, ancestor) pair", so one
#: GROUP BY produces the subtree aggregate of EVERY node at once. The intermediate
#: ``paid_by_anc`` GROUP BY (anc, cur) is mandatory (plan §0 U-2): two children of one
#: ancestor paying in the same currency would otherwise hand jsonb_object_agg a
#: duplicate key.
_TREE_SQL = text(
    """
WITH RECURSIVE tree AS (
    SELECT i.id, i.parent_id, ARRAY[i.id] AS path, 1 AS depth,
           COALESCE(i.deadline, g.deadline) AS eff_deadline,
           (i.deadline IS NULL) AS deadline_inherited,
           CASE WHEN i.currency = g.currency           THEN i.amount_minor
                WHEN i.converted_currency = g.currency THEN i.converted_minor
           END AS own_goal_ccy_minor,
           (i.amount_minor IS NOT NULL AND i.currency <> g.currency
            AND i.converted_currency IS DISTINCT FROM g.currency) AS own_unconverted
    FROM goal_items i JOIN goals g ON g.id = i.goal_id
    WHERE i.goal_id = :goal_id AND i.parent_id IS NULL
  UNION ALL
    SELECT c.id, c.parent_id, t.path || c.id, t.depth + 1,
           COALESCE(c.deadline, t.eff_deadline),
           (c.deadline IS NULL),
           CASE WHEN c.currency = g.currency           THEN c.amount_minor
                WHEN c.converted_currency = g.currency THEN c.converted_minor
           END,
           (c.amount_minor IS NOT NULL AND c.currency <> g.currency
            AND c.converted_currency IS DISTINCT FROM g.currency)
    FROM goal_items c
    JOIN tree t ON c.parent_id = t.id
    JOIN goals g ON g.id = c.goal_id
),
nodes AS (
    SELECT t.*,
           NOT EXISTS (SELECT 1 FROM goal_items ch WHERE ch.parent_id = t.id) AS is_leaf
    FROM tree t
),
rollup AS (
    SELECT anc AS node_id,
           COALESCE(SUM(n.own_goal_ccy_minor) FILTER (WHERE n.is_leaf), 0)
               AS subtree_leaf_sum,
           COUNT(*) FILTER (WHERE n.is_leaf AND n.own_unconverted)
               AS planned_unconverted
    FROM nodes n CROSS JOIN LATERAL unnest(n.path) AS anc
    GROUP BY anc
),
paid_direct AS (
    SELECT tx.goal_item_id,
           CASE WHEN tx.currency = g.currency      THEN g.currency
                WHEN tx.base_currency = g.currency THEN g.currency
                ELSE tx.currency
           END AS cur,
           SUM(CASE WHEN tx.currency = g.currency      THEN tx.amount_minor
                    WHEN tx.base_currency = g.currency THEN tx.base_amount_minor
                    ELSE tx.amount_minor
               END) AS amt,
           COUNT(*) AS ops
    FROM transactions tx
    JOIN goals g ON g.id = :goal_id
    WHERE tx.goal_item_id IN (SELECT id FROM tree)
      AND tx.user_id = g.user_id
    GROUP BY tx.goal_item_id, cur
),
paid_by_anc AS (
    SELECT anc AS node_id, q.cur, SUM(q.amt) AS amt, SUM(q.ops) AS ops
    FROM (SELECT n.path, pd.cur, pd.amt, pd.ops
          FROM nodes n JOIN paid_direct pd ON pd.goal_item_id = n.id) q
    CROSS JOIN LATERAL unnest(q.path) AS anc
    GROUP BY anc, q.cur
),
paid AS (
    SELECT node_id, jsonb_object_agg(cur, jsonb_build_array(amt, ops)) AS baskets
    FROM paid_by_anc GROUP BY node_id
),
files_direct AS (
    SELECT f.goal_item_id, COUNT(*) AS cnt
    FROM goal_item_files f
    WHERE f.goal_item_id IN (SELECT id FROM tree)
    GROUP BY f.goal_item_id
),
files_subtree AS (
    SELECT anc AS node_id, SUM(q.cnt) AS cnt
    FROM (SELECT n.path, fd.cnt
          FROM nodes n JOIN files_direct fd ON fd.goal_item_id = n.id) q
    CROSS JOIN LATERAL unnest(q.path) AS anc
    GROUP BY anc
)
SELECT n.id, n.parent_id, n.depth, n.eff_deadline, n.deadline_inherited,
       n.own_goal_ccy_minor,
       i.name, i.description, i.links, i.amount_minor, i.currency,
       i.converted_minor, i.converted_currency, i.deadline,
       i.remind_on, i.remind_days_before, i.sort_order, i.created_at,
       COALESCE(r.subtree_leaf_sum, 0) AS children_sum,
       COALESCE(r.planned_unconverted, 0) AS planned_unconverted,
       p.baskets,
       COALESCE(fd.cnt, 0) AS files_count,
       COALESCE(fs.cnt, 0) AS subtree_files_count
FROM nodes n
JOIN goal_items i ON i.id = n.id
LEFT JOIN rollup r ON r.node_id = n.id
LEFT JOIN paid p ON p.node_id = n.id
LEFT JOIN files_direct fd ON fd.goal_item_id = n.id
LEFT JOIN files_subtree fs ON fs.node_id = n.id
ORDER BY n.depth, i.sort_order, n.id
"""
)

#: Every node of every NON-archived goal of one user, with the same inherited
#: deadline and subtree "paid" the per-goal tree computes — for `GET /goals/upcoming`
#: (§6). ONE statement for the WHOLE portfolio: the anchor is "all roots of all my
#: live goals" rather than one goal's roots, which is the only difference that
#: matters. A per-goal loop here would be the scope's named N+1 wearing a hat.
#:
#: The window is NOT applied in SQL. Which date decides — the reminder or the
#: deadline — is ``domain.goal_plan.reminder_date`` plus one rule, and spelling
#: that rule a second time in SQL is exactly how the two would drift; the row set
#: is bounded by the user's plans (<= 500 nodes per goal), so filtering in Python
#: costs a walk and saves a duplicate definition.
#:
#: ``breadcrumb`` rides down the recursion next to ``path``: the parent's own name
#: is appended as the recursion steps INTO the child, so a node's array holds its
#: ancestors from the root and never itself.
_UPCOMING_SQL = text(
    """
WITH RECURSIVE tree AS (
    SELECT i.id, i.goal_id, ARRAY[i.id] AS path, ARRAY[]::text[] AS breadcrumb,
           i.name, i.amount_minor, i.currency, i.created_at,
           i.remind_on, i.remind_days_before,
           COALESCE(i.deadline, g.deadline) AS eff_deadline,
           (i.deadline IS NULL) AS deadline_inherited
    FROM goal_items i JOIN goals g ON g.id = i.goal_id
    WHERE g.user_id = :user_id AND g.archived IS FALSE AND i.parent_id IS NULL
  UNION ALL
    SELECT c.id, c.goal_id, t.path || c.id, t.breadcrumb || t.name::text,
           c.name, c.amount_minor, c.currency, c.created_at,
           c.remind_on, c.remind_days_before,
           COALESCE(c.deadline, t.eff_deadline),
           (c.deadline IS NULL)
    FROM goal_items c JOIN tree t ON c.parent_id = t.id
),
paid_direct AS (
    SELECT tx.goal_item_id,
           CASE WHEN tx.currency = g.currency      THEN g.currency
                WHEN tx.base_currency = g.currency THEN g.currency
                ELSE tx.currency
           END AS cur,
           SUM(CASE WHEN tx.currency = g.currency      THEN tx.amount_minor
                    WHEN tx.base_currency = g.currency THEN tx.base_amount_minor
                    ELSE tx.amount_minor
               END) AS amt,
           COUNT(*) AS ops
    FROM transactions tx
    JOIN tree t ON t.id = tx.goal_item_id
    JOIN goals g ON g.id = t.goal_id
    WHERE tx.user_id = g.user_id
    GROUP BY tx.goal_item_id, cur
),
paid_by_anc AS (
    SELECT anc AS node_id, q.cur, SUM(q.amt) AS amt, SUM(q.ops) AS ops
    FROM (SELECT t.path, pd.cur, pd.amt, pd.ops
          FROM tree t JOIN paid_direct pd ON pd.goal_item_id = t.id) q
    CROSS JOIN LATERAL unnest(q.path) AS anc
    GROUP BY anc, q.cur
),
paid AS (
    SELECT node_id, jsonb_object_agg(cur, jsonb_build_array(amt, ops)) AS baskets
    FROM paid_by_anc GROUP BY node_id
)
SELECT t.id AS item_id, t.name AS item_name, t.breadcrumb,
       t.goal_id, g.name AS goal_name, g.currency AS goal_currency,
       t.eff_deadline, t.deadline_inherited,
       t.remind_on, t.remind_days_before,
       t.amount_minor, t.currency, t.created_at,
       p.baskets
FROM tree t
JOIN goals g ON g.id = t.goal_id
LEFT JOIN paid p ON p.node_id = t.id
"""
)

#: Goal-level "paid", for the whole goal list in ONE grouped query (§8: never N+1).
#: Same three-arm bucket as the tree's ``paid_direct`` — spelled again rather than
#: shared because it groups by GOAL, not by node; the arms are what must not drift,
#: and the pair of them is pinned by the paid tests.
_PAID_BY_GOAL_SQL = text(
    """
SELECT g.id AS goal_id,
       CASE WHEN tx.currency = g.currency      THEN g.currency
            WHEN tx.base_currency = g.currency THEN g.currency
            ELSE tx.currency
       END AS cur,
       SUM(CASE WHEN tx.currency = g.currency      THEN tx.amount_minor
                WHEN tx.base_currency = g.currency THEN tx.base_amount_minor
                ELSE tx.amount_minor
           END) AS amt,
       COUNT(*) AS ops
FROM transactions tx
JOIN goal_items i ON i.id = tx.goal_item_id
JOIN goals g ON g.id = i.goal_id
WHERE g.id = ANY(:goal_ids) AND g.user_id = :user_id
GROUP BY g.id, cur
"""
).bindparams(bindparam("goal_ids", type_=ARRAY(Uuid())))

#: Goal-level planned total: Σ of the goal's LEAF prices (a goal's roots' subtrees
#: partition its leaves, so no recursion is needed for this question) + the honest
#: count of leaves whose price has no goal-currency reading.
_PLANNED_BY_GOAL_SQL = text(
    """
WITH leaves AS (
    SELECT i.goal_id, i.amount_minor, i.currency, i.converted_minor,
           i.converted_currency
    FROM goal_items i
    WHERE i.goal_id = ANY(:goal_ids)
      AND NOT EXISTS (SELECT 1 FROM goal_items c WHERE c.parent_id = i.id)
)
SELECT l.goal_id,
       COALESCE(SUM(CASE WHEN l.currency = g.currency           THEN l.amount_minor
                         WHEN l.converted_currency = g.currency THEN l.converted_minor
                    END), 0) AS planned,
       COUNT(*) FILTER (WHERE l.amount_minor IS NOT NULL
                          AND l.currency <> g.currency
                          AND l.converted_currency IS DISTINCT FROM g.currency)
           AS unconverted
FROM leaves l JOIN goals g ON g.id = l.goal_id
WHERE g.user_id = :user_id
GROUP BY l.goal_id
"""
).bindparams(bindparam("goal_ids", type_=ARRAY(Uuid())))

#: Every node of a subtree INCLUDING its root — the ``?goal_item_id=`` filter (Q4)
#: and, on delete, the set of rows the CASCADE is about to take.
_SUBTREE_SQL = text(
    """
WITH RECURSIVE sub AS (
    SELECT i.id FROM goal_items i WHERE i.id = :root_id AND i.goal_id = :goal_id
  UNION ALL
    SELECT c.id FROM goal_items c JOIN sub ON c.parent_id = sub.id
)
SELECT id FROM sub
"""
)

#: The chain from a node up to its root, nearest ancestor first. ONE query answers
#: BOTH questions the write path has (§4 of the plan): is the target a descendant
#: of the node being moved (cycle), and how deep does the move land (depth limit).
_ANCESTORS_SQL = text(
    """
WITH RECURSIVE anc AS (
    SELECT i.id, i.parent_id, 1 AS lvl
    FROM goal_items i WHERE i.id = :node_id AND i.goal_id = :goal_id
  UNION ALL
    SELECT p.id, p.parent_id, anc.lvl + 1
    FROM goal_items p JOIN anc ON p.id = anc.parent_id
)
SELECT id, lvl FROM anc ORDER BY lvl
"""
)

#: How many levels a subtree is TALL (1 = a leaf). A move must not push the
#: subtree's own leaves past the depth limit, which its root's new depth alone
#: cannot tell.
_SUBTREE_HEIGHT_SQL = text(
    """
WITH RECURSIVE sub AS (
    SELECT i.id, 1 AS lvl FROM goal_items i
    WHERE i.id = :root_id AND i.goal_id = :goal_id
  UNION ALL
    SELECT c.id, sub.lvl + 1 FROM goal_items c JOIN sub ON c.parent_id = sub.id
)
SELECT COALESCE(MAX(lvl), 1) FROM sub
"""
)


async def _rate(
    session: AsyncSession,
    cache: _RateCache,
    from_currency: str,
    to_currency: str,
    on_date: date,
) -> Decimal | None:
    """Nearest-previous rate, resolved at most ONCE per currency pair (plan §0 U-3)."""
    key = (from_currency, to_currency)
    if key not in cache:
        found = await lookup_rate(session, from_currency, to_currency, on_date)
        cache[key] = None if found is None else found.rate
    return cache[key]


async def _convert_baskets(
    session: AsyncSession,
    cache: _RateCache,
    baskets: _Baskets | None,
    goal_currency: str,
    on_date: date,
) -> tuple[int, int]:
    """``{currency: [amount, ops]}`` → ``(paid in goal currency, rateless ops)``.

    The goal-currency basket needs no rate at all (it already holds every payment
    the SQL could read directly, including the ones a manual base override made
    readable). Every other basket costs one lookup, shared through ``cache``, and
    is either converted whole or dropped whole — a partially converted basket
    would be a number that is not any currency.
    """
    if not baskets:
        return 0, 0
    paid = 0
    unconverted = 0
    for currency, (amount, ops) in baskets.items():
        if currency == goal_currency:
            paid += amount
            continue
        rate = await _rate(session, cache, currency, goal_currency, on_date)
        if rate is None:
            unconverted += ops
            continue
        paid += convert_minor(amount, currency, goal_currency, rate)
    return paid, unconverted


async def read_goal_tree(session: AsyncSession, goal: Goal, *, today: date) -> GoalTree:
    """The goal's whole plan, flat, with every rollup already computed.

    Flat + ``parent_id`` + ``depth`` rather than a nested document: the tree is
    what the client assembles for rendering, while every NUMBER on it — the
    rollups, the inherited deadlines, the ceiling flags — is the server's answer.
    """
    rows = (await session.execute(_TREE_SQL, {"goal_id": goal.id})).mappings().all()
    cache: _RateCache = {}
    nodes: list[PlanNode] = []
    for row in rows:
        paid, paid_unconverted = await _convert_baskets(
            session, cache, row["baskets"], goal.currency, today
        )
        children_sum = int(row["children_sum"])
        nodes.append(
            PlanNode(
                id=row["id"],
                parent_id=row["parent_id"],
                depth=int(row["depth"]),
                name=row["name"],
                description=row["description"],
                links=list(row["links"]),
                amount_minor=row["amount_minor"],
                currency=row["currency"],
                converted_minor=row["converted_minor"],
                converted_currency=row["converted_currency"],
                deadline=row["deadline"],
                effective_deadline=row["eff_deadline"],
                deadline_inherited=bool(row["deadline_inherited"]),
                remind_on=row["remind_on"],
                remind_days_before=row["remind_days_before"],
                sort_order=int(row["sort_order"]),
                created_at=row["created_at"],
                children_sum_minor=children_sum,
                planned_unconverted_count=int(row["planned_unconverted"]),
                ceiling_exceeded=ceiling_exceeded(
                    own_goal_ccy_minor=row["own_goal_ccy_minor"],
                    children_sum_minor=children_sum,
                ),
                paid_minor=paid,
                paid_unconverted_count=paid_unconverted,
                files_count=int(row["files_count"]),
                subtree_files_count=int(row["subtree_files_count"]),
            )
        )
    return GoalTree(nodes=nodes, goal_currency=goal.currency)


async def read_upcoming_deadlines(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    today: date,
    through: date,
) -> list[UpcomingItem]:
    """The user's plan nodes whose date falls inside ``[today, through]`` (§6).

    ONE statement for the whole portfolio (``_UPCOMING_SQL``), then two pure
    decisions per row:

    * WHEN — ``reminder_date`` resolves the stored intent against the inherited
      deadline;
    * WHETHER — a node that HAS a reminder is judged by that reminder ALONE: a
      reminder already in the past does not pull the node back into the window on
      the strength of its deadline, because the user asked to be told at a moment
      that has been and gone. Only a node with NO reminder at all falls back to
      its effective deadline.

    Currency baskets are converted AFTER the window filter, so a portfolio-wide
    read costs rate lookups only for the handful of rows it actually returns.

    Sorted by the date that put the row in the window, then ``created_at``, then
    id — the ``/recurring/upcoming`` key, so the two widgets order ties alike.
    """
    rows = (await session.execute(_UPCOMING_SQL, {"user_id": user_id})).mappings().all()
    cache: _RateCache = {}
    selected: list[tuple[date, datetime, uuid.UUID, UpcomingItem]] = []
    for row in rows:
        remind_at = reminder_date(
            remind_on=row["remind_on"],
            remind_days_before=row["remind_days_before"],
            effective_deadline=row["eff_deadline"],
        )
        # ``is not None``, never truthiness: ``remind_days_before = 0`` is a real
        # reminder meaning "on the day itself", and a falsy test would quietly
        # demote it to "no reminder" and judge the node by its deadline instead.
        has_reminder = (
            row["remind_on"] is not None or row["remind_days_before"] is not None
        )
        due = remind_at if has_reminder else row["eff_deadline"]
        if due is None or not (today <= due <= through):
            continue
        paid, paid_unconverted = await _convert_baskets(
            session, cache, row["baskets"], row["goal_currency"], today
        )
        selected.append(
            (
                due,
                row["created_at"],
                row["item_id"],
                UpcomingItem(
                    goal_id=row["goal_id"],
                    goal_name=row["goal_name"],
                    goal_currency=row["goal_currency"],
                    item_id=row["item_id"],
                    item_name=row["item_name"],
                    breadcrumb=list(row["breadcrumb"]),
                    effective_deadline=row["eff_deadline"],
                    deadline_inherited=bool(row["deadline_inherited"]),
                    reminder_date=remind_at,
                    amount_minor=row["amount_minor"],
                    currency=row["currency"],
                    paid_minor=paid,
                    paid_unconverted_count=paid_unconverted,
                    created_at=row["created_at"],
                ),
            )
        )
    selected.sort(key=lambda entry: (entry[0], entry[1], entry[2]))
    return [item for *_, item in selected]


async def paid_by_goal(
    session: AsyncSession,
    user_id: uuid.UUID,
    goal_currencies: Mapping[uuid.UUID, str],
    *,
    today: date,
) -> dict[uuid.UUID, tuple[int, int]]:
    """``{goal_id: (paid_minor, paid_unconverted_count)}`` — ONE grouped query.

    Takes the goals' currencies rather than looking them up: the caller has the
    rows in hand, and a second read of a column it already holds is how an N+1
    starts. Only goals that actually have payments appear in the result.
    """
    if not goal_currencies:
        return {}
    rows = (
        await session.execute(
            _PAID_BY_GOAL_SQL,
            {"goal_ids": list(goal_currencies), "user_id": user_id},
        )
    ).all()
    baskets_by_goal: dict[uuid.UUID, _Baskets] = {}
    for goal_id, currency, amount, ops in rows:
        baskets_by_goal.setdefault(goal_id, {})[currency] = [int(amount), int(ops)]
    cache: _RateCache = {}
    result: dict[uuid.UUID, tuple[int, int]] = {}
    for goal_id, baskets in baskets_by_goal.items():
        result[goal_id] = await _convert_baskets(
            session, cache, baskets, goal_currencies[goal_id], today
        )
    return result


async def goal_plan_totals(
    session: AsyncSession,
    user_id: uuid.UUID,
    goals: list[Goal],
    *,
    today: date,
) -> dict[uuid.UUID, PlanTotals]:
    """Plan figures for a whole portfolio: two grouped queries, no per-goal walk."""
    if not goals:
        return {}
    goal_currencies = {goal.id: goal.currency for goal in goals}
    goal_ids = list(goal_currencies)
    planned_rows = (
        await session.execute(
            _PLANNED_BY_GOAL_SQL, {"goal_ids": goal_ids, "user_id": user_id}
        )
    ).all()
    planned = {
        goal_id: (int(total), int(unconverted))
        for goal_id, total, unconverted in planned_rows
    }
    paid = await paid_by_goal(session, user_id, goal_currencies, today=today)
    totals: dict[uuid.UUID, PlanTotals] = {}
    for goal in goals:
        planned_total, planned_unconverted = planned.get(goal.id, (0, 0))
        paid_total, paid_unconverted = paid.get(goal.id, (0, 0))
        totals[goal.id] = PlanTotals(
            # A goal with items always has at least one LEAF, so the planned query
            # answers "has items" too — no third query for one boolean.
            has_items=goal.id in planned,
            planned_total_minor=planned_total,
            planned_unconverted_count=planned_unconverted,
            paid_minor=paid_total,
            paid_unconverted_count=paid_unconverted,
        )
    return totals


def empty_plan_totals() -> PlanTotals:
    """The all-zero figures of a goal with no plan (shared, so it is spelled once)."""
    return _EMPTY_TOTALS


async def subtree_item_ids(
    session: AsyncSession, goal_id: uuid.UUID, root_id: uuid.UUID
) -> list[uuid.UUID]:
    """The subtree of ``root_id``, root included (the ``?goal_item_id=`` filter).

    The filter resolves the SUBTREE and not the single node on purpose (PM Q4): a
    parent's "paid" already aggregates its subtree, so a transaction list that
    showed only the direct links would be a second, disagreeing answer to the same
    question.
    """
    rows = await session.scalars(_SUBTREE_SQL, {"root_id": root_id, "goal_id": goal_id})
    return list(rows.all())


async def ancestor_ids(
    session: AsyncSession, goal_id: uuid.UUID, node_id: uuid.UUID
) -> list[uuid.UUID]:
    """``node_id`` and its ancestors, nearest first — the write path's ONE walk.

    Its length IS the node's depth, and membership in it IS the cycle test, so the
    router asks this question once and answers both.
    """
    rows = (
        await session.execute(_ANCESTORS_SQL, {"node_id": node_id, "goal_id": goal_id})
    ).all()
    return [row[0] for row in rows]


async def subtree_height(
    session: AsyncSession, goal_id: uuid.UUID, root_id: uuid.UUID
) -> int:
    """Levels below (and including) ``root_id``; 1 for a leaf."""
    height = await session.scalar(
        _SUBTREE_HEIGHT_SQL, {"root_id": root_id, "goal_id": goal_id}
    )
    return int(height or 1)
