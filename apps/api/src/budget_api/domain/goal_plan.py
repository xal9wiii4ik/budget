"""Pure plan math (goal-planner §5/§8) — stdlib only, no IO, no ORM.

The ``domain/goals.py`` contract, applied to the plan: integer minor units, ONE
currency per call (the goal's), and every rule spelled exactly once so the ladder,
the progress card, the realism projection and the advisor cannot disagree about
what "the target" is.

Reminder math is deliberately NOT here yet: it lands with ``GET /goals/upcoming``
in subtask 2, whose columns migration 0011 already carries.
"""


def effective_target(
    *,
    target_minor: int,
    has_items: bool,
    planned_total_minor: int,
    final_cost_override_minor: int | None,
) -> int:
    """The number the goal is actually chasing (§5) — THE definition, used everywhere.

    Three modes, in this order:

    * **no plan items** → ``target_minor``, the manual goal. This arm is what keeps
      every existing goal byte-identical to its pre-scope behaviour;
    * **items + a manual final cost** → the override wins (the user decided what
      the plan costs; the bottom-up number stays visible next to it so the client
      can show the disagreement honestly);
    * **items only** → the bottom-up sum of the plan's leaves.

    The bottom-up arm is deliberately allowed to be 0 (a plan of grouping nodes
    with no prices yet, or one whose every leaf is unconvertible): a "helpfully"
    substituted ``target_minor`` would hide exactly the transition task.md
    requires the UI to announce — that the total is under-stated until the plan is
    complete.
    """
    if not has_items:
        return target_minor
    if final_cost_override_minor is not None:
        return final_cost_override_minor
    return planned_total_minor


def remaining_to_find(
    *, effective_target_minor: int, paid_minor: int, saved_minor: int
) -> int:
    """What is still missing: effective target - paid - saved (§8).

    MAY BE NEGATIVE and is returned as such — clamping to 0 would tell a user who
    over-saved that they have exactly enough. The three inputs stay three separate
    numbers on the wire: money that LEFT (paid) and money that is LYING THERE
    (saved) are different facts, and no field anywhere sums them (task.md).
    """
    return effective_target_minor - paid_minor - saved_minor


def ceiling_exceeded(
    *, own_goal_ccy_minor: int | None, children_sum_minor: int
) -> bool:
    """Whether a node's children outgrew its own price (§5) — a FLAG, not an error.

    Both numbers are in the GOAL's currency; a node with no own price (a grouping
    node) or one whose price could not be converted has nothing to exceed, so it is
    never flagged. A leaf's ``children_sum`` IS its own amount, so equality — not
    ">" — is what keeps leaves quiet under the one shared rule.
    """
    if own_goal_ccy_minor is None:
        return False
    return children_sum_minor > own_goal_ccy_minor
