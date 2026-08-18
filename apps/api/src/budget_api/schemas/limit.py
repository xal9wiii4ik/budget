"""Category-limit request/response schemas (architecture D14/D15/D18, plan B3).

Lean DTOs: the wire never carries ``user_id`` (ownership is forced from the
token) and never carries ``created_at``/``updated_at`` — a limit is a threshold,
not a document, and no client renders when it was last written.

The two currency fields are deliberately BOTH present and deliberately different
names. ``LimitsRead.currency`` is the CURRENT profile base — the currency
``spent_minor`` is expressed in — while ``limit_currency`` is the stamp taken at
set time and never re-interpreted afterwards (D15/OQ-4). After a base switch the
two disagree, and that disagreement is the whole point: the server refuses to
guess whether 30 000 RUB was meant to become 30 000 USD, so it hands the client
both halves and the client prompts. Collapsing them into one field would be the
silent reinterpretation the stage-3 no-guess stance exists to prevent.

No ``status``/``exceeded``/``percent`` field (D18): over-limit is a client visual
state derived from two numbers that are already here, and a server-side verdict
would be a second, drift-prone definition of "over".
"""

import uuid

from pydantic import BaseModel, Field

from budget_api.schemas.transaction import MAX_MINOR_AMOUNT


class LimitUpsert(BaseModel):
    # decision h / D21: the shared app-wide magnitude bound on top of ge=1. A
    # zero limit is not "no limit" — DELETE is how a limit is removed.
    amount_minor: int = Field(ge=1, le=MAX_MINOR_AMOUNT)


class LimitRead(BaseModel):
    """PUT response — a write carries no period context, hence no ``spent``."""

    category_id: uuid.UUID
    limit_minor: int
    limit_currency: str  # the stamp taken at set time (D15)


class LimitItem(BaseModel):
    category_id: uuid.UUID
    limit_minor: int
    limit_currency: str
    #: Month expense total for this category in ``LimitsRead.currency``; 0 when
    #: the category has no rows in the month. Income rows in a limited category
    #: never offset it (D16) — a salary refund is not "unspending".
    spent_minor: int


class LimitsRead(BaseModel):
    month: str  # echoed "YYYY-MM" (the resolved month, defaulted or requested)
    currency: str  # CURRENT profile base — the currency spent_minor is in
    items: list[LimitItem]  # ordered by category_id
    #: Period-level honesty flag (D9/D16): rows in the month that had no usable
    #: rate, of ANY kind — this is the same period counter ``/stats`` reports for
    #: the month, so it also counts income and uncategorized rows that were never
    #: candidates for a ``spent_minor`` in the first place. Counted over the whole
    #: month, not per item: any unconvertible row means the numbers on this screen
    #: are incomplete, whether or not it belongs to a limited expense category.
    unconverted_count: int


class LimitError(BaseModel):
    """404/422 error envelope — mirrors ``GoalError`` / ``RecurringError``."""

    detail: str
