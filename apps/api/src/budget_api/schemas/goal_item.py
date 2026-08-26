"""Plan-node request/response schemas (goal-planner §1/§5/§8).

Lean DTOs, house rules: the wire never carries ``user_id`` or ``goal_id`` on a
write (both come from the path and the token), money is integer minor units, and
every money field's currency is stated rather than inferred — the node's own price
carries ``currency``, and ONE ``goal_currency`` echo on the list response labels
every rolled-up number in it (AM-5: a currency is never defaulted).

Two things the client deliberately CANNOT write:

* ``sort_order`` — reordering is ``{"move": "up"|"down"}`` and the server owns the
  numbers (PM Q3). Two round-trips ("read the neighbour's order, then write mine")
  leave the tree wrong if the second one never lands;
* ``converted_currency`` — the conversion target is the GOAL's currency by
  definition, so only the ``converted_minor`` override is sendable (the
  ``base_amount_minor`` precedent on transactions).

PATCH semantics are byte-identical to the transactions router's: omitted = keep,
value = override, explicit null = clear (and, for the converted pair, recompute).
``model_fields_set`` in the router is what tells the three apart.
"""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from budget_api.schemas.goal import clean_name
from budget_api.schemas.transaction import MAX_MINOR_AMOUNT

_CURRENCY_PATTERN = r"^[A-Z]{3}$"
#: Longer than a transaction's note: this field holds booking details, addresses
#: and confirmation numbers, which is the whole point of attaching it to a node.
_DESCRIPTION_MAX = 2000
#: Links are a short list of references, not a bookmark manager; 2048 is the
#: pragmatic URL length ceiling every browser agrees on.
_LINKS_MAX = 10
_LINK_MAX_LENGTH = 2048

#: Which neighbour to swap with. A relative instruction, not an absolute position:
#: the server resolves it against the CURRENT sibling order inside one transaction,
#: so two clients pressing "up" cannot interleave into a wrong order. At the top
#: (or bottom) it is an idempotent no-op — a 422 for "already first" would be an
#: error message for a button the user can see is disabled.
MoveDirection = Literal["up", "down"]


def clean_description(v: str | None) -> str | None:
    """Trim, blank → None, cap (the ``clean_note`` contract at a larger bound)."""
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v) > _DESCRIPTION_MAX:
        raise ValueError(f"description must be at most {_DESCRIPTION_MAX} characters")
    return v


def clean_links(v: list[str] | None) -> list[str] | None:
    """Trim each link, drop blanks, cap count and length.

    Format is NOT validated beyond length (the ``currency`` format-only rule): a
    user pasting an app deep-link or an intranet address is not making a mistake,
    and a rejected paste is a worse failure than a link that does not open.
    """
    if v is None:
        return None
    links = [link.strip() for link in v]
    links = [link for link in links if link]
    if len(links) > _LINKS_MAX:
        raise ValueError(f"at most {_LINKS_MAX} links are allowed")
    for link in links:
        if len(link) > _LINK_MAX_LENGTH:
            raise ValueError(f"a link must be at most {_LINK_MAX_LENGTH} characters")
    return links


class GoalItemCreate(BaseModel):
    name: str
    #: NULL = a root of the plan. A parent from ANOTHER goal is 422
    #: GOAL_ITEM_PARENT_NOT_FOUND (the composite FK forbids it at the DB level too).
    parent_id: uuid.UUID | None = None
    description: str | None = None
    links: list[str] | None = None
    #: The node's own price — OPTIONAL: a grouping node may have none, and its
    #: children are then the whole story.
    amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    #: Omitted → stamped from the GOAL (§1). Format-only validation.
    currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    #: User override of the goal-currency conversion; wins over the computed one.
    #: ge=1 because a hand-typed amount may not be zero (an auto-computed snapshot
    #: legally may — the model's CHECK is >= 0).
    converted_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    #: Omitted/null = INHERIT (from the nearest ancestor with a date, else the
    #: goal). Nothing is written into the column in that case — ever.
    deadline: date | None = None
    #: Reminder intent, at most ONE of the two (422 from the DB CHECK's twin in the
    #: router): a fixed date stands still, "N days before" rides the effective
    #: deadline.
    remind_on: date | None = None
    remind_days_before: int | None = Field(default=None, ge=0, le=365)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        cleaned = clean_name(v)
        assert cleaned is not None  # non-optional field: null never reaches here
        return cleaned

    @field_validator("description")
    @classmethod
    def _validate_description(cls, v: str | None) -> str | None:
        return clean_description(v)

    @field_validator("links")
    @classmethod
    def _validate_links(cls, v: list[str] | None) -> list[str] | None:
        return clean_links(v)


class GoalItemUpdate(BaseModel):
    # All optional; omitted vs explicit-null is distinguished by the router via
    # model_fields_set. NOT NULL columns reject an explicit null with the house
    # *_REQUIRED 422; every nullable one is cleared by it.
    name: str | None = None
    #: Re-parenting. Explicit null makes the node a root; a descendant of itself is
    #: 422 GOAL_ITEM_CYCLE, and a move that would push the subtree past the depth
    #: limit is 422 GOAL_ITEM_DEPTH_EXCEEDED.
    parent_id: uuid.UUID | None = None
    description: str | None = None
    links: list[str] | None = None
    amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    converted_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    deadline: date | None = None
    remind_on: date | None = None
    remind_days_before: int | None = Field(default=None, ge=0, le=365)
    #: Reordering among siblings — see :data:`MoveDirection`. Not a stored field:
    #: it is an instruction, and the response carries the resulting ``sort_order``.
    move: MoveDirection | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        return clean_name(v)

    @field_validator("description")
    @classmethod
    def _validate_description(cls, v: str | None) -> str | None:
        return clean_description(v)

    @field_validator("links")
    @classmethod
    def _validate_links(cls, v: list[str] | None) -> list[str] | None:
        return clean_links(v)


class GoalItemRead(BaseModel):
    """One node, with every number the server computed for it.

    The client assembles the TREE from ``parent_id``; it computes no money, no
    depth and no inherited date — those are answers, not raw data.
    """

    id: uuid.UUID
    goal_id: uuid.UUID
    parent_id: uuid.UUID | None
    #: 1 for a root. Server-sent so the client never re-derives it by walking (Q8).
    depth: int
    name: str
    description: str | None
    links: list[str]
    #: The node's OWN price (a guideline and a ceiling), in ``currency`` — never in
    #: the goal's, unless they happen to be the same code.
    amount_minor: int | None
    currency: str
    #: The same price in the GOAL's currency: a write-time snapshot or the user's
    #: override. Both null when no rate existed — the node is then counted in the
    #: goal's ``planned_unconverted_count`` rather than summed as zero.
    converted_minor: int | None
    converted_currency: str | None
    #: The node's OWN deadline — null when it inherits.
    deadline: date | None
    #: The date actually in force: own → nearest ancestor's → the goal's. Null when
    #: nothing up the chain has one. NEVER stored (task.md).
    effective_deadline: date | None
    #: True when ``effective_deadline`` came from above, which is what lets the UI
    #: label it "goal deadline" instead of showing a date the user never set.
    deadline_inherited: bool
    remind_on: date | None
    remind_days_before: int | None
    #: Σ of the subtree's leaf prices in the GOAL's currency (the list response's
    #: ``goal_currency`` names it). This — not ``amount_minor`` — is what rolls up
    #: to the parent; for a leaf the two are the same number.
    children_sum_minor: int
    #: Leaves under this node excluded from ``children_sum_minor`` for want of a
    #: rate — counted, never silently zeroed (the tx_totals rule). The goal-level
    #: counter says the plan is understated; this one says which branch.
    planned_unconverted_count: int
    #: children_sum > own price. A FIELD, not an error (§5): a plan may legitimately
    #: exceed its own guideline, and the user decides what to do about it.
    ceiling_exceeded: bool
    #: Linked transactions over the SUBTREE, in the goal's currency.
    paid_minor: int
    #: Payments excluded from ``paid_minor`` for want of a rate — counted, never
    #: silently zeroed (the tx_totals rule).
    paid_unconverted_count: int
    #: THIS node's own attachments. Two counters, because the row on screen and the
    #: "delete will remove N files" warning ask different questions (PM Q1).
    files_count: int
    #: Attachments over the subtree — the number the delete confirmation states.
    subtree_files_count: int
    #: Order among siblings. Read-only: the client sends ``move``, never this.
    sort_order: int
    created_at: datetime  # tz-aware


class GoalItemList(BaseModel):
    #: FLAT and ordered (depth, sort_order, id) — the client builds the tree.
    items: list[GoalItemRead]
    #: The currency of every rolled-up number in ``items`` (children_sum, paid).
    #: One echo per response instead of a repeated field per node.
    goal_currency: str


class UpcomingDeadlineRead(BaseModel):
    """One row of ``GET /goals/upcoming`` — a plan node whose date is coming up.

    The list crosses GOALS, so unlike :class:`GoalItemList` there is no single
    currency to name once per response: every money field carries its own
    currency ON THE ROW (AM-5). Rows of different currencies are never summed —
    not by the client, and not by a model reading this through MCP.

    There is no notification channel behind this: it feeds the in-app "coming up"
    block, which is why the row carries what that block renders (whose plan, which
    branch, how much, how much is already paid) and nothing else.
    """

    goal_id: uuid.UUID
    #: The goal's name — a row shown outside any one plan has to say whose it is.
    goal_name: str
    #: The currency of ``paid_minor``. A subtree rollup is always in the goal's
    #: currency, and it is often NOT the node's own ``currency`` below.
    goal_currency: str
    item_id: uuid.UUID
    item_name: str
    #: Ancestor names from the root down to the parent, THIS node excluded (empty
    #: for a root): "Japan trip → Tokyo → " is what makes "Hotel" mean something
    #: out of its tree.
    breadcrumb: list[str]
    #: The deadline in force — own, else the nearest ancestor's, else the goal's.
    #: Null is possible: a node with a fixed ``remind_on`` and no deadline anywhere
    #: up the chain is still due to be shown.
    effective_deadline: date | None
    deadline_inherited: bool
    #: The date the reminder actually falls on, computed on read from the stored
    #: intent (a fixed date, or "N days before" riding ``effective_deadline``).
    #: Null when the node carries no reminder — the row is then here because its
    #: DEADLINE is inside the window.
    reminder_date: date | None
    #: The node's OWN price, in ``currency`` — null for a grouping node. NOT the
    #: subtree total: this list is about dates, and the rollups live on the tree.
    amount_minor: int | None
    #: The currency of ``amount_minor`` only.
    currency: str
    #: Paid against this node AND its subtree, in ``goal_currency``.
    paid_minor: int
    #: Payments left out of ``paid_minor`` for want of a rate — counted, never
    #: silently zeroed (the tx_totals rule).
    paid_unconverted_count: int


class UpcomingDeadlineList(BaseModel):
    #: Unpaginated (the ``UpcomingChargeList`` precedent): the window is bounded
    #: by ``days`` <= 90 and only dated nodes appear in it.
    items: list[UpcomingDeadlineRead]


class GoalItemError(BaseModel):
    """404/422 error envelope — mirrors ``TransactionError``/``GoalError``."""

    detail: str
