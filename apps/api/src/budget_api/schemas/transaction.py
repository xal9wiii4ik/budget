"""Transaction request/response schemas.

Lean DTOs (architecture §5): the wire never carries raw ``user_id`` (ownership is
forced from the token) and ``TransactionCreate``/``TransactionUpdate`` carry no
``currency`` field — the server stamps ``profile.base_currency`` (decision d).
``kind`` is required on create (the client defaults it from the picked category;
the server never derives it — 1.2 sign-authority ruling).

``note`` shares one trim-and-cap validator across create and update; it returns
``None`` untouched for a null so the router's ``model_fields_set`` handling owns
the omitted-vs-explicit-null distinction.
"""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from budget_api.enums import TransactionKind

_NOTE_MAX = 500


def _clean_note(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v) > _NOTE_MAX:
        raise ValueError(f"note must be at most {_NOTE_MAX} characters")
    return v


class TransactionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    amount_minor: int
    kind: TransactionKind
    currency: str  # server-stamped base currency (read-only)
    category_id: uuid.UUID | None
    occurred_at: date
    note: str | None
    created_at: datetime  # tz-aware


class TransactionCreate(BaseModel):
    # No currency field (decision d); no user_id field (forced from token).
    amount_minor: int = Field(ge=1)  # decision h: reject zero/negative at contract
    kind: TransactionKind  # REQUIRED (1.2 carry-forward)
    category_id: uuid.UUID | None = None
    occurred_at: date  # required; any date incl. future (decision g)
    note: str | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return _clean_note(v)


class TransactionUpdate(BaseModel):
    # All optional; omitted vs explicit-null distinguished by the router via
    # model_fields_set. NOT NULL fields (amount/kind/occurred_at) reject explicit
    # null with a *_REQUIRED 422; nullable fields (category_id/note) clear on null.
    amount_minor: int | None = Field(default=None, ge=1)
    kind: TransactionKind | None = None
    category_id: uuid.UUID | None = None
    occurred_at: date | None = None
    note: str | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return _clean_note(v)


class TransactionList(BaseModel):
    # Pagination envelope (decision b): the client renders "showing N of total"
    # and drives paging without a second count call.
    items: list[TransactionRead]
    total: int


class CategorySummary(BaseModel):
    category_id: uuid.UUID | None  # null bucket = uncategorized
    kind: TransactionKind
    total_minor: int


class SummaryRead(BaseModel):
    month: str  # echoed "YYYY-MM"
    currency: str  # profile base currency
    income_minor: int
    expense_minor: int
    net_minor: int  # signed: income - expense
    by_category: list[CategorySummary]


class TransactionError(BaseModel):
    """404/422 error envelope — mirrors ``CategoryError`` / ``RateLimitedError``."""

    detail: str
