"""Transaction request/response schemas.

Lean DTOs (architecture §5): the wire never carries raw ``user_id`` — ownership is
forced from the token. Since 3.2 the write DTOs DO carry an optional ``currency``
(D5): omitted/null still means "stamp ``profile.base_currency``" (decision d's
wire contract, unchanged), a non-null value records the money as actually spent.
``kind`` is required on create (the client defaults it from the picked category;
the server never derives it — 1.2 sign-authority ruling).

Currency validation is FORMAT-ONLY (``^[A-Z]{3}$``, D7): the picker restricts the
offered set, the API accepts any well-formed code so an exotic-currency receipt is
never silently mangled. ``base_amount_minor`` is the *user override* of the
converted snapshot, hence ``ge=1`` — an auto-computed snapshot may legally be 0
(the model's CHECK is ``>= 0``), a hand-typed one may not.

``note`` shares one trim-and-cap validator across create and update; it returns
``None`` untouched for a null so the router's ``model_fields_set`` handling owns
the omitted-vs-explicit-null distinction.
"""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from budget_api.enums import TransactionKind

_NOTE_MAX = 500
_MERCHANT_MAX = 255
_CURRENCY_PATTERN = r"^[A-Z]{3}$"

#: Upper bound on every user-supplied minor amount, app-wide (D14). 1e15-1 minor
#: ≈ 10 trillion major at exponent 2 — absurdly generous for a personal budget,
#: while sums of realistic row counts stay under JS ``Number.MAX_SAFE_INTEGER``
#: (~9.0e15), which is what ``packages/shared``'s ``assertSafeMinor`` throws on.
#: The bound lives at the SCHEMA layer, where ``ge=1`` already lives — no DB CHECK
#: change, no migration. Imported by ``schemas/goal.py`` (the ``clean_note`` edge).
MAX_MINOR_AMOUNT = 999_999_999_999_999


def clean_note(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v) > _NOTE_MAX:
        raise ValueError(f"note must be at most {_NOTE_MAX} characters")
    return v


def _clean_merchant(v: str | None) -> str | None:
    # Mirrors clean_note (trim; "" → None; cap length) so create and update share
    # one merchant-cleaning contract. A null/blank merchant is "no merchant" — the
    # learning upsert (router) skips it and an explicit null on update clears the row.
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v) > _MERCHANT_MAX:
        raise ValueError(f"merchant must be at most {_MERCHANT_MAX} characters")
    return v


class TransactionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    amount_minor: int
    kind: TransactionKind
    currency: str  # the money as spent (base currency when none was sent)
    # Converted snapshot in the base currency at write time (D5). Both null when no
    # rate existed OR when the row IS in the base currency — a consumer must never
    # decode base_amount_minor at a guessed currency's exponent (AM-5).
    base_amount_minor: int | None
    base_currency: str | None
    category_id: uuid.UUID | None
    occurred_at: date
    note: str | None
    receipt_id: uuid.UUID | None  # link to the source receipt (null for manual entries)
    merchant: str | None
    created_at: datetime  # tz-aware


class TransactionCreate(BaseModel):
    # No user_id field (forced from token).
    # decision h: reject zero/negative at contract; le: D14 upper bound.
    amount_minor: int = Field(ge=1, le=MAX_MINOR_AMOUNT)
    kind: TransactionKind  # REQUIRED (1.2 carry-forward)
    # Null/omitted → the server stamps profile.base_currency (the pre-3.2 contract,
    # byte-compatible). A foreign currency triggers the auto-snapshot (D5).
    currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    # User override of the converted snapshot; wins over any auto-computed value.
    # Sending it with a base-currency row is 422 BASE_AMOUNT_WITHOUT_CURRENCY.
    base_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    category_id: uuid.UUID | None = None
    occurred_at: date  # required; any date incl. future (decision g)
    note: str | None = None
    # Receipt link + merchant are additive/optional (D8): omitted for manual entries,
    # set when confirming a parsed receipt. receipt_id ownership is validated in the
    # router; merchant drives the learning upsert. Re-linking is never a flow, so
    # receipt_id is create-only (absent from TransactionUpdate).
    receipt_id: uuid.UUID | None = None
    merchant: str | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)

    @field_validator("merchant")
    @classmethod
    def _validate_merchant(cls, v: str | None) -> str | None:
        return _clean_merchant(v)


class TransactionUpdate(BaseModel):
    # All optional; omitted vs explicit-null distinguished by the router via
    # model_fields_set. NOT NULL fields (amount/kind/occurred_at) reject explicit
    # null with a *_REQUIRED 422; nullable fields (category_id/note) clear on null.
    amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    kind: TransactionKind | None = None
    # NOT NULL column → an explicit null is 422 CURRENCY_REQUIRED (the *_REQUIRED
    # house pattern). base_amount_minor is the one field where an explicit null is
    # neither "clear" nor rejected: it DISCARDS a user override and recomputes
    # (R1(1) — the snapshot is server-managed, so nullable-clears does not apply).
    currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    base_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    category_id: uuid.UUID | None = None
    occurred_at: date | None = None
    note: str | None = None
    # merchant only (NOT receipt_id — re-linking a tx to another receipt is not a
    # flow). An explicit null clears the stored merchant; PATCH never learns (D7).
    merchant: str | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)

    @field_validator("merchant")
    @classmethod
    def _validate_merchant(cls, v: str | None) -> str | None:
        return _clean_merchant(v)


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
    # D9: rows excluded from every total above because their currency has no rate to
    # the base currency. Required (never optional): a client that cannot see the
    # exclusion would render a silently understated month as a complete one.
    unconverted_count: int


class TransactionError(BaseModel):
    """404/422 error envelope — mirrors ``CategoryError`` / ``RateLimitedError``."""

    detail: str
