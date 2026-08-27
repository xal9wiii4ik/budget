"""Deposit request/response schemas.

Lean DTOs (the ``schemas/account.py`` shape): the wire never carries ``user_id`` —
ownership is forced from the token — and it never carries ``account_id`` INWARD
either: the hidden ledger account is created by ``POST /deposits`` itself, so a
client that could name one could point two deposits at one pot of money.

Three read fields are COMPUTED per request and stored nowhere: ``balance_minor``
(the account's, ``services/account_balances.py``), ``accrued_minor``
(``domain/deposits.py``) and ``status``. ``currency`` is read-only for the same
reason it is not a column — the linked account owns it, and it is immutable there.

Decimals cross the wire as STRINGS on the way out (the ``transfer_rate``
precedent, ``schemas/transaction.py``): JSON numbers are floats, and a rate that
round-trips through a float is a rate that can print as 10.949999999999999.
Inbound they are ``Decimal`` fields, so a client may send either ``"10.95"`` or
``10.95`` and the server parses exactly once. Bounds mirror the DB columns
(``Numeric(8, 4)`` / ``Numeric(5, 2)``): an out-of-range rate must be a 422 at the
contract, never a DataError at the driver.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from budget_api.enums import DepositCapitalization, DepositStatus
from budget_api.schemas.transaction import MAX_MINOR_AMOUNT

_CURRENCY_PATTERN = r"^[A-Z]{3}$"
_NAME_MAX = 100
#: Numeric(8, 4) holds 9999.9999 — one more digit is a driver-level DataError, so
#: the contract refuses it first.
_RATE_MAX = Decimal("9999.9999")


def _clean_name(v: str) -> str:
    v = v.strip()
    if not (1 <= len(v) <= _NAME_MAX):
        raise ValueError(f"name must be 1..{_NAME_MAX} chars after trimming")
    return v


class DepositRead(BaseModel):
    id: uuid.UUID
    name: str
    #: The hidden ledger account. Exposed on purpose: it is the only handle a
    #: client has for the deposit's money — ``GET /transactions?account_id=…``
    #: is the deposit's history, and a transfer to it is a top-up.
    account_id: uuid.UUID
    #: From the ACCOUNT (single source, immutable there), never stored here.
    currency: str
    #: Annual rate in percent, decimal string ("10.95" = 10.95 % p.a.).
    rate_percent: str
    capitalization: DepositCapitalization
    opened_on: date
    #: ``null`` = open-ended (a savings account): nothing to mature into.
    term_end: date | None
    #: Withholding rate in percent as a decimal string; ``null`` = not taxed, which
    #: is why ``accrued_after_tax_minor`` below is null rather than the gross.
    tax_rate_percent: str | None
    #: The body: the account's computed balance in ITS OWN currency (opening body
    #: plus every transfer leg). Interest is NOT part of it — the two numbers are
    #: reported separately and never summed by a client.
    balance_minor: int
    #: Interest accrued as of TODAY (server clock), gross. Computed on read; the
    #: only stored figure is the manual anchor below, which this number continues
    #: from rather than freezing at.
    accrued_minor: int
    #: ``accrued_minor`` less withholding, or ``null`` when no tax rate is set.
    #: Computed server-side because the client never does money arithmetic.
    accrued_after_tax_minor: int | None
    #: The user's manual correction and the date the server stamped it on. Both
    #: null, or both set (a DB CHECK). They are on the wire so the client can badge
    #: the row as manually corrected and offer a reset — without them a client
    #: cannot tell a computed figure from an edited one.
    accrued_override_minor: int | None
    accrued_override_as_of: date | None
    #: Computed, never stored: ``matured`` once ``term_end`` has arrived (accrual
    #: is frozen on that date). An open-ended deposit is always ``active``.
    status: DepositStatus
    archived: bool
    created_at: datetime  # tz-aware


class DepositCreate(BaseModel):
    name: str
    # Format-only validation (the accounts/transactions rule): the picker restricts
    # the offered set, the API accepts any well-formed code.
    currency: str = Field(pattern=_CURRENCY_PATTERN)
    rate_percent: Decimal = Field(ge=0, le=_RATE_MAX, max_digits=8, decimal_places=4)
    capitalization: DepositCapitalization
    #: Routinely in the PAST — a deposit opened a year ago is the headline case
    #: (task.md §5). No upper bound: a deposit signed today for a start next Monday
    #: is a real thing, and the accrual simply has not begun.
    opened_on: date
    term_end: date | None = None
    tax_rate_percent: Decimal | None = Field(
        default=None, ge=0, le=100, max_digits=5, decimal_places=2
    )
    #: The body ON ``opened_on`` (AMENDMENT §1) — written to the hidden account's
    #: ``starting_balance_minor``, which is what seeds the interest timeline. NOT
    #: signed, unlike an account's opening balance: a deposit does not start
    #: overdrawn. Every later movement is a transfer, never an edit of this.
    initial_balance_minor: int = Field(default=0, ge=0, le=MAX_MINOR_AMOUNT)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _clean_name(v)


class DepositUpdate(BaseModel):
    # All optional; omitted vs explicit-null distinguished by the router via
    # model_fields_set. NOT NULL columns reject an explicit null with a *_REQUIRED
    # 422 (the house PATCH pattern); the nullable ones (term_end, tax_rate_percent,
    # accrued_override_minor) treat null as CLEAR.
    name: str | None = None
    rate_percent: Decimal | None = Field(
        default=None, ge=0, le=_RATE_MAX, max_digits=8, decimal_places=4
    )
    capitalization: DepositCapitalization | None = None
    opened_on: date | None = None
    #: null = make it open-ended.
    term_end: date | None = None
    #: null = not taxed (clears the rate).
    tax_rate_percent: Decimal | None = Field(
        default=None, ge=0, le=100, max_digits=5, decimal_places=2
    )
    #: The manual correction (task.md §4). A VALUE anchors the forecast at today —
    #: the server stamps ``accrued_override_as_of`` itself, so there is no such
    #: field on this model at all; null clears the pair and the figure goes back to
    #: being computed. ``ge=0``: an anchor is accrued interest, never a debt.
    accrued_override_minor: int | None = Field(default=None, ge=0, le=MAX_MINOR_AMOUNT)
    archived: bool | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        return None if v is None else _clean_name(v)


class DepositError(BaseModel):
    """404/422 error envelope — mirrors ``AccountError`` / ``TransactionError``."""

    detail: str
