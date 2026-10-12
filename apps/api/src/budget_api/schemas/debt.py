"""Debt request/response schemas.

Lean DTOs (the ``schemas/deposit.py`` shape): the wire never carries ``user_id`` —
ownership is forced from the token — and it never carries ``debt_role`` either,
because the ROUTE says which movement is being written.

**Two currencies, two names.** Inside ``/debts`` the headline currency is the
DEBT's, so ``amount_minor`` is always the amount in ``currency`` (what the
counterparty counts as lent or repaid) and ``account_amount_minor`` is what moved
on the account, denominated in ``account_currency``. In the database that is
``transactions.debt_amount_minor`` and ``transactions.amount_minor``
respectively (debts architecture §Currency). Decode each at ITS OWN currency's
exponent — never the other one's (the AM-5 no-fallback rule).

Everything about how much is left is SERVER-computed and read-only:
``principal_minor``/``repaid_minor``/``remaining_minor``/``status``/``closed_on``
are arithmetic over the movements, so a client never adds or subtracts money.

``direction`` and ``currency`` are absent from :class:`DebtUpdate` — immutable by
schema rather than by a router check, which is also what keeps them out of the
``update_debt`` MCP tool.
"""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from budget_api.enums import DebtDirection, DebtStatus
from budget_api.schemas.transaction import (
    MAX_MINOR_AMOUNT,
    clean_note,
)

_CURRENCY_PATTERN = r"^[A-Z]{3}$"
_COUNTERPARTY_MAX = 100


def _clean_counterparty(v: str) -> str:
    """Trim and bound the person's name. NOT normalized and not unique: the
    counterparty is not a Budget user, and two debts with one person are two
    debts."""
    v = v.strip()
    if not (1 <= len(v) <= _COUNTERPARTY_MAX):
        raise ValueError(
            f"counterparty must be 1..{_COUNTERPARTY_MAX} chars after trimming"
        )
    return v


class DebtRepaymentRead(BaseModel):
    """One partial repayment — the movement row as the debt screen reads it."""

    #: The transaction id of the movement: the same row ``GET /transactions``
    #: returns with this ``debt_id``, so a client can cross-link the two screens.
    id: uuid.UUID
    occurred_at: date
    account_id: uuid.UUID
    #: The account's own currency (stamped from it), which may differ from the
    #: debt's — ``account_amount_minor`` is denominated in THIS one.
    account_currency: str
    account_amount_minor: int
    #: The repayment in the DEBT's currency — the number ``remaining_minor`` is
    #: computed from.
    amount_minor: int
    note: str | None
    created_at: datetime  # tz-aware


class DebtRead(BaseModel):
    """One debt, with every money figure computed by the server."""

    id: uuid.UUID
    #: IMMUTABLE: the direction decides the sign of every movement, so changing it
    #: would retro-flip money already booked. Fix a mistake by deleting the debt.
    direction: DebtDirection
    counterparty: str
    #: The debt's own currency. Every ``*_minor`` field below except
    #: ``account_amount_minor`` is denominated in it. IMMUTABLE.
    currency: str
    #: The opening amount — the principal movement's amount in ``currency``.
    principal_minor: int
    #: Σ of the repayments so far, same currency.
    repaid_minor: int
    #: ``principal_minor`` minus ``repaid_minor``. Never computed by a client.
    remaining_minor: int
    #: ``closed`` exactly when ``remaining_minor`` is 0 — derived, never stored, so
    #: deleting a repayment reopens the debt by arithmetic.
    status: DebtStatus
    #: The last repayment's date once closed, else null.
    closed_on: date | None
    #: The date of the opening movement (its ``occurred_at``).
    opened_on: date
    #: The account the opening movement was booked on, and that movement in the
    #: ACCOUNT's currency. They may be another currency entirely — lending USD off
    #: a BYN card is the case this pair exists for.
    account_id: uuid.UUID
    account_currency: str
    account_amount_minor: int
    #: "Give it back by" — nullable, and the one field the daily push reads a debt
    #: for (by name only, never by amount).
    due_on: date | None
    note: str | None
    repayments_count: int
    created_at: datetime  # tz-aware


class DebtDetailRead(DebtRead):
    """The debt plus its repayment history, embedded.

    One request per screen: a debt has a handful of repayments, so a separate
    route for them would be a second round trip for the same screen.
    """

    #: Oldest first (``occurred_at``, then ``created_at``, then id — a total order).
    repayments: list[DebtRepaymentRead]


class DebtSummaryRead(BaseModel):
    """The two headline figures, in the user's base currency.

    Converted by the SERVER at today's nearest-previous rate (never by the
    client, and never from the opening date's rate: this is what is outstanding
    now). A debt whose currency has no rate is left OUT of its side's sum and
    counted in that side's ``*_unconverted_count`` — the exclude-and-flag rule, so
    one rateless debt cannot make the pair look understated in silence.
    """

    base_currency: str
    owed_to_me_minor: int
    i_owe_minor: int
    owed_to_me_unconverted_count: int
    i_owe_unconverted_count: int


class DebtList(BaseModel):
    """ALL the user's debts plus the summary — one screen, one round trip.

    No ``?status=`` and no paging: closed debts are part of the answer (the client
    shows them in their own group), and the volumes are a handful per person.
    """

    items: list[DebtRead]
    summary: DebtSummaryRead


class DebtCreate(BaseModel):
    direction: DebtDirection
    counterparty: str
    #: The debt's currency, EXPLICIT (not stamped from the account): the opening
    #: account may be denominated in something else, and this is what every
    #: ``amount_minor`` of the debt means. Format-only validation, like everywhere.
    currency: str = Field(pattern=_CURRENCY_PATTERN)
    #: The opening amount in ``currency``. ge=1: a debt of nothing is not a debt.
    amount_minor: int = Field(ge=1, le=MAX_MINOR_AMOUNT)
    #: The account the money left (``lent``) or landed on (``borrowed``). Required:
    #: the movement is a real transaction and every transaction has an account.
    account_id: uuid.UUID
    opened_on: date
    #: What moved on the ACCOUNT, in the account's own currency. REQUIRED when the
    #: account's currency differs from ``currency`` (422
    #: ``DEBT_ACCOUNT_AMOUNT_REQUIRED``) — the rate that actually applied is the
    #: user's fact, not ours, so nothing is converted and no rate is stored. When
    #: the two currencies are equal the server copies ``amount_minor``, and a sent
    #: value that disagrees is 422 ``DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE``.
    account_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    #: Earlier than ``opened_on`` is 422 ``DEBT_DUE_BEFORE_OPENING``.
    due_on: date | None = None
    note: str | None = None
    #: Client-generated idempotency key (B-1), stored on the opening movement: a
    #: replay with the same key returns the STORED debt with 200, never a second
    #: one. FIRST WRITE WINS — the replay arm never consults the body.
    client_id: uuid.UUID | None = None

    @field_validator("counterparty")
    @classmethod
    def _validate_counterparty(cls, v: str) -> str:
        return _clean_counterparty(v)

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)


class DebtUpdate(BaseModel):
    """All optional; omitted vs explicit null is distinguished by the router.

    NOT NULL facts (``counterparty``, ``amount_minor``, ``account_id``,
    ``opened_on``) reject an explicit null with a ``DEBT_*_REQUIRED`` 422 (the
    house pattern); ``due_on`` and ``note`` clear on null. On
    ``account_amount_minor`` null is simply the absent value — the server
    recomputes it (copies across equal currencies, keeps the stored integer when
    the account did not move). ``direction`` and ``currency`` are absent entirely
    — see the module doc.
    """

    counterparty: str | None = None
    #: The opening amount. Shrinking it below what has already been repaid is 422
    #: ``DEBT_PRINCIPAL_BELOW_REPAID``, checked under the debt's row lock.
    amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    #: Moves the OPENING movement to another account and restamps its currency. A
    #: move across currencies must carry ``account_amount_minor`` in the same
    #: request (422 ``AMOUNT_REQUIRED_ON_CURRENCY_CHANGE``): the stored integer is
    #: minor units of the OLD currency, so restamping alone would redefine it.
    account_id: uuid.UUID | None = None
    account_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    opened_on: date | None = None
    due_on: date | None = None
    note: str | None = None

    @field_validator("counterparty")
    @classmethod
    def _validate_counterparty(cls, v: str | None) -> str | None:
        return None if v is None else _clean_counterparty(v)

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)


class DebtRepaymentCreate(BaseModel):
    #: The repayment in the DEBT's currency. More than what is left is 422
    #: ``DEBT_REPAYMENT_EXCEEDS_REMAINING``, checked under the debt's row lock —
    #: which is also the answer for a repayment of an already closed debt.
    amount_minor: int = Field(ge=1, le=MAX_MINOR_AMOUNT)
    #: The account the money landed on (``lent``) or left (``borrowed``). It need
    #: not be the account the debt was opened from.
    account_id: uuid.UUID
    occurred_at: date
    #: Same rule as on create: required across currencies, copied when they match.
    account_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    note: str | None = None
    client_id: uuid.UUID | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)


class DebtRepaymentUpdate(BaseModel):
    """Correct one recorded repayment. Omitted keeps; the NOT NULL facts
    (``amount_minor``, ``account_id``, ``occurred_at``) refuse an explicit null
    with their ``DEBT_*_REQUIRED`` code, ``note`` clears, and on
    ``account_amount_minor`` null ≡ omitted (the server recomputes it)."""

    amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    account_id: uuid.UUID | None = None
    occurred_at: date | None = None
    account_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    note: str | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)


class DebtError(BaseModel):
    """404/422 error envelope — mirrors ``DepositError`` / ``TransactionError``."""

    detail: str
