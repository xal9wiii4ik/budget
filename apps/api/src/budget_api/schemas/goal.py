"""Goal + contribution request/response schemas (architecture D10/D12, plan S5).

Lean DTOs: the wire never carries ``user_id`` (ownership forced from the token)
and the list embeds computed money fields but NOT contribution rows (they are
unbounded and have their own paginated endpoint).

Two currencies coexist per item and both are labeled (AM-4 / plan D-List):
``monthly_needed_minor`` is in the GOAL's currency; ``allocated_monthly_minor``
is in the PROFILE BASE currency (it is a share of the base-currency free
balance), which ``base_currency`` discloses so no client ever guesses an
exponent (AM-5).

Degradation is two-level ([SL-3]): the per-item ``realism_unavailable`` means
"this goal's currency has no rate to the base" (its realism fields are null and
it takes no allocation); the top-level flag on the list means "the free-balance
window itself was degraded" (D9 unconverted rows). One exotic goal must never
null the whole screen.

Every amount carries the shared ``MAX_MINOR_AMOUNT`` upper bound (D14, landed at
4.1): ``target_minor``/``initial_saved_minor`` on top of their ``ge=1``, and
``amount_minor`` on BOTH signs — a withdrawal is a negative row, so a ``le=``
alone would leave ``-1e18`` legal and poison every client-side sum.
"""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

# clean_note went public in 3.4: contributions share the transactions' one
# trim-and-cap note contract (plan S5 — reuse, not reimplement).
from budget_api.schemas.transaction import MAX_MINOR_AMOUNT, clean_note

_NAME_MAX = 100
_CURRENCY_PATTERN = r"^[A-Z]{3}$"


def clean_name(v: str | None) -> str | None:
    """Trim and cap 1..100 (the ``clean_note`` shape, but blank is an ERROR).

    Public since 5.3: ``schemas/recurring.py`` is the second consumer (a template
    name is the same 1..100 trimmed string), and goal.py stays the definer
    exactly as transaction.py stayed ``clean_note``'s.

    Returns ``None`` untouched for a null so the router's ``model_fields_set``
    handling owns the omitted-vs-explicit-null distinction (NAME_REQUIRED).
    """
    if v is None:
        return None
    v = v.strip()
    if not v:
        raise ValueError("name must not be blank")
    if len(v) > _NAME_MAX:
        raise ValueError(f"name must be at most {_NAME_MAX} characters")
    return v


class GoalCreate(BaseModel):
    name: str
    target_minor: int = Field(ge=1, le=MAX_MINOR_AMOUNT)
    # Format-only (D7): the picker restricts the offered set, the API accepts any
    # well-formed code.
    currency: str = Field(pattern=_CURRENCY_PATTERN)
    deadline: date | None = None
    # None → appended last (user's max priority + 1). Lower = higher priority.
    priority: int | None = None
    # "Already saved" → the goal's FIRST contribution row, created atomically in
    # the same commit (D10/OQ-5 — there is no stored saved_minor column).
    initial_saved_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        cleaned = clean_name(v)
        assert cleaned is not None  # non-optional field: null never reaches here
        return cleaned


class GoalUpdate(BaseModel):
    # All optional; omitted vs explicit-null distinguished by the router via
    # model_fields_set. NOT NULL fields reject explicit null with *_REQUIRED 422;
    # deadline is nullable and an explicit null CLEARS it.
    name: str | None = None
    target_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    # Currency change relabels the ledger only (D12): contribution rows are never
    # rewritten — the web warns.
    currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    deadline: date | None = None
    priority: int | None = None
    archived: bool | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        return clean_name(v)


class GoalRead(BaseModel):
    """List-item AND single-GET shape (D12) — computed fields included.

    The single GET runs the same whole-portfolio assembler as the list, so
    ``allocated_monthly_minor`` is identical in both (AM-4 consistency).
    """

    id: uuid.UUID
    name: str
    target_minor: int
    currency: str
    deadline: date | None
    priority: int
    archived: bool
    created_at: datetime  # tz-aware
    # SUM(contributions) — computed, never stored (OQ-5).
    saved_minor: int
    completed: bool  # derived: saved >= target (D10)
    # In the GOAL currency (pure D11 math — always computable, no conversion).
    monthly_needed_minor: int
    # Null iff this goal's realism_unavailable is true (no goal→base rate).
    realistic: bool | None
    # Null: unreachable at the current pace OR realism unavailable.
    months_to_target: int | None
    suggested_deadline: date | None
    # Waterfall share of the free balance, in the PROFILE BASE currency (R1(2)).
    # 0 when the goal is archived, completed, or unconvertible.
    allocated_monthly_minor: int
    # PER-GOAL ([SL-3]): no goal→base rate today. Base-currency goals are never
    # unavailable (identity lookup).
    realism_unavailable: bool
    # AM-4: the base currency every allocated_monthly_minor above is expressed
    # in — disclosed so the client never borrows another query to learn it.
    base_currency: str


class GoalListRead(BaseModel):
    items: list[GoalRead]  # ordered (priority, created_at)
    # Base currency; average monthly surplus over the last 3 FULL months
    # (current partial month excluded), floor toward -inf. May be negative.
    free_balance_minor: int
    # TOP-LEVEL ([SL-3]): the free-balance window itself was degraded — some
    # window rows had no rate and were excluded from the sums (D9).
    realism_unavailable: bool
    base_currency: str  # AM-4


class ContributionCreate(BaseModel):
    # SIGNED: a withdrawal is a negative row (D10). Zero is meaningless. The D14
    # bound is a MAGNITUDE cap, hence both signs.
    amount_minor: int = Field(ge=-MAX_MINOR_AMOUNT, le=MAX_MINOR_AMOUNT)
    occurred_at: date | None = None  # None → today (server-side default)
    note: str | None = None

    @field_validator("amount_minor")
    @classmethod
    def _validate_amount(cls, v: int) -> int:
        if v == 0:
            raise ValueError("amount_minor must not be zero")
        return v

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)


class ContributionRead(BaseModel):
    id: uuid.UUID
    goal_id: uuid.UUID
    amount_minor: int
    occurred_at: date
    note: str | None
    created_at: datetime  # tz-aware


class ContributionList(BaseModel):
    # Pagination envelope (transactions precedent).
    items: list[ContributionRead]
    total: int


class ProgressPoint(BaseModel):
    month: str  # "YYYY-MM"
    contributed_minor: int  # signed net of the month's rows; empty month → 0
    # Cumulative balance at month end, INCLUDING contributions before the window
    # (chart-ready — the client renders, never computes).
    saved_end_minor: int


class GoalError(BaseModel):
    """404/422 error envelope — mirrors ``TransactionError``."""

    detail: str
