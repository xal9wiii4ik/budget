"""Recurring template request/response schemas (architecture D2/D10, plan B2).

Lean DTOs: the wire never carries ``user_id`` (ownership forced from the token)
and never carries ``last_materialized_on`` — the watermark is the job's
idempotency mechanism (D6), not a client-editable field. What a client needs
instead is ``next_due_on``, which the router computes from the watermark, the
clock and ``end_date`` (D10).

Text cleaning is REUSED, not reimplemented: ``clean_name`` (goal.py) for the
template name, ``clean_merchant``/``clean_note`` (transaction.py) for the two
fields that are copied verbatim onto every materialized transaction — a template
whose merchant cleaned differently from the rows it books would be a second
contract for the same string.

The unit/anchor pair is validated HERE on create (a ``model_validator`` that
mirrors the DB CHECK ``anchor_matches_unit``): the payload alone decides, so the
rejection is an ordinary Pydantic 422. On PATCH the same rule needs the STORED
row, so it lives in the router as the ``ANCHOR_REQUIRED`` / ``ANCHOR_MISMATCH``
business codes.
"""

import uuid
from datetime import date, datetime
from typing import Self

from pydantic import BaseModel, Field, field_validator, model_validator

from budget_api.enums import RecurrenceUnit, TransactionKind
from budget_api.schemas.goal import clean_name
from budget_api.schemas.transaction import (
    MAX_MINOR_AMOUNT,
    clean_merchant,
    clean_note,
)

_CURRENCY_PATTERN = r"^[A-Z]{3}$"


def _check_anchor(
    unit: RecurrenceUnit, day_of_month: int | None, weekday: int | None
) -> None:
    """Exactly the anchor of ``unit``, the other one null — the DB CHECK, at the wire.

    Raises ``ValueError`` (→ Pydantic 422) so an inconsistent pair can never reach
    the model layer, where it would surface as an IntegrityError 500.
    """
    if unit is RecurrenceUnit.month:
        if day_of_month is None:
            raise ValueError("day_of_month is required for a monthly template")
        if weekday is not None:
            raise ValueError("weekday must be null for a monthly template")
    else:
        if weekday is None:
            raise ValueError("weekday is required for a weekly template")
        if day_of_month is not None:
            raise ValueError("day_of_month must be null for a weekly template")


class RecurringTemplateCreate(BaseModel):
    name: str
    # decision h / D21: the shared app-wide magnitude bound on top of ge=1.
    amount_minor: int = Field(ge=1, le=MAX_MINOR_AMOUNT)
    kind: TransactionKind  # REQUIRED (1.2 sign-authority: the server never derives it)
    #: REQUIRED (architecture §7): the materializer books a transaction, and a
    #: transaction belongs to an account. Create-only — a template's account is
    #: what its currency is stamped from.
    account_id: uuid.UUID
    # Null/omitted → the server stamps the ACCOUNT's currency, exactly as
    # POST /transactions does (architecture §4); a value that disagrees with the
    # account is 422 ACCOUNT_CURRENCY_MISMATCH. Format-only validation (D7).
    currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    category_id: uuid.UUID | None = None
    merchant: str | None = None
    note: str | None = None
    interval_unit: RecurrenceUnit
    day_of_month: int | None = Field(default=None, ge=1, le=31)
    weekday: int | None = Field(default=None, ge=0, le=6)  # 0 = Monday (D3)
    end_date: date | None = None
    paused: bool = False

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        cleaned = clean_name(v)
        assert cleaned is not None  # non-optional field: null never reaches here
        return cleaned

    @field_validator("merchant")
    @classmethod
    def _validate_merchant(cls, v: str | None) -> str | None:
        return clean_merchant(v)

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)

    @model_validator(mode="after")
    def _validate_anchor(self) -> Self:
        _check_anchor(self.interval_unit, self.day_of_month, self.weekday)
        return self


class RecurringTemplateUpdate(BaseModel):
    # All optional; omitted vs explicit-null is distinguished by the router via
    # model_fields_set. NOT NULL columns reject an explicit null with a
    # *_REQUIRED 422; the nullable ones (category_id, merchant, note, end_date)
    # clear on null. The unit/anchor rule cannot live here — it needs the stored
    # row — so the router owns ANCHOR_REQUIRED / ANCHOR_MISMATCH.
    name: str | None = None
    amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    kind: TransactionKind | None = None
    # Locked to the template's account currency (architecture §4): a value that
    # differs from the stored stamp is 422 ACCOUNT_CURRENCY_MISMATCH. There is no
    # ``account_id`` here — moving a standing order between accounts is a separate
    # decision nobody has asked for, and delete + create already expresses it.
    currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    category_id: uuid.UUID | None = None
    merchant: str | None = None
    note: str | None = None
    interval_unit: RecurrenceUnit | None = None
    day_of_month: int | None = Field(default=None, ge=1, le=31)
    weekday: int | None = Field(default=None, ge=0, le=6)
    end_date: date | None = None
    paused: bool | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        return clean_name(v)

    @field_validator("merchant")
    @classmethod
    def _validate_merchant(cls, v: str | None) -> str | None:
        return clean_merchant(v)

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)


class RecurringTemplateRead(BaseModel):
    id: uuid.UUID
    name: str
    amount_minor: int
    kind: TransactionKind
    account_id: uuid.UUID  # every materialized row is booked here
    currency: str  # the stored stamp — always the account's currency (§4)
    category_id: uuid.UUID | None
    merchant: str | None
    note: str | None
    interval_unit: RecurrenceUnit
    day_of_month: int | None
    weekday: int | None  # 0 = Monday
    end_date: date | None
    paused: bool
    # Server-computed (D10): the next date the job will book, on or after today.
    # Null when the template is paused or when the next date would fall past
    # end_date. Never a past date — a pending catch-up is floored at today
    # (OQ-1), so this is a promise about the future, not a report of arrears.
    next_due_on: date | None
    created_at: datetime  # tz-aware


class RecurringTemplateList(BaseModel):
    # List envelope (the goals precedent). Unpaginated by design: this is the
    # management screen and a user has tens of templates, not thousands.
    items: list[RecurringTemplateRead]


class RecurringError(BaseModel):
    """404/422 error envelope — mirrors ``TransactionError`` / ``GoalError``."""

    detail: str
