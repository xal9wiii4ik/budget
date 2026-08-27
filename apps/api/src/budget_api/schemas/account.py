"""Account request/response schemas.

Lean DTOs (architecture §5): the wire never carries ``user_id`` — ownership is
forced from the token. ``balance_minor`` is READ-only and computed
(``services/account_balances.py``), never sent by a client and never stored.

``type`` is ``AccountType`` on all three models, and that enum is deliberately the
CLIENT-facing vocabulary rather than the full set of stored values: the third stored
type, ``deposit``, is the hidden ledger of a ``deposits`` row (``enums.py``
explains). So the enum IS the pin — a client can neither create an account of that
type nor PATCH a card into one (a plain Pydantic 422), and no client is handed a
case ``GET /accounts`` cannot produce.

``currency`` is create-only (architecture §4): every transaction on the account is
stamped with it, so changing it later would restate history. It nevertheless
appears on ``AccountUpdate`` — see the comment there — so that an attempt to change
it is an explicit ``422 ACCOUNT_CURRENCY_IMMUTABLE`` instead of a silently ignored
extra field.

Money is integer minor units at the ACCOUNT's currency exponent, so
``starting_balance_minor`` of ``10000`` is 100.00 USD but ¥10000. It is the one
signed amount in the app's write surface (a credit card starts in the red), hence
``ge=-MAX_MINOR_AMOUNT`` rather than the usual ``ge=1``.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from budget_api.enums import AccountType
from budget_api.schemas.transaction import MAX_MINOR_AMOUNT

_CURRENCY_PATTERN = r"^[A-Z]{3}$"
_NAME_MAX = 100


def _clean_name(v: str) -> str:
    v = v.strip()
    if not (1 <= len(v) <= _NAME_MAX):
        raise ValueError(f"name must be 1..{_NAME_MAX} chars after trimming")
    return v


class AccountRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    currency: str
    type: AccountType
    starting_balance_minor: int
    #: Computed on read (architecture §2), never stored: the starting balance plus
    #: income, minus expenses, minus transfers out, plus transfers in — every term
    #: already in THIS account's currency, so it is plain integer arithmetic.
    balance_minor: int
    archived: bool
    created_at: datetime  # tz-aware


class AccountCreate(BaseModel):
    # No user_id field: ownership is forced from the token; extras are ignored.
    name: str
    # Format-only validation (the transactions rule): the picker restricts the
    # offered set, the API accepts any well-formed code.
    currency: str = Field(pattern=_CURRENCY_PATTERN)
    type: AccountType
    # Signed and optional: an account opened at zero is the common case.
    starting_balance_minor: int = Field(
        default=0, ge=-MAX_MINOR_AMOUNT, le=MAX_MINOR_AMOUNT
    )

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _clean_name(v)


class AccountUpdate(BaseModel):
    # All optional; omitted vs explicit-null distinguished by the router via
    # model_fields_set. NOT NULL columns reject an explicit null with a *_REQUIRED
    # 422 (the house PATCH pattern).
    name: str | None = None
    type: AccountType | None = None
    starting_balance_minor: int | None = Field(
        default=None, ge=-MAX_MINOR_AMOUNT, le=MAX_MINOR_AMOUNT
    )
    archived: bool | None = None
    # Declared ONLY to be refused. The column is immutable (architecture §4), and
    # the house default (extra="ignore") would otherwise swallow a currency change
    # silently — the client would believe the account was converted while every
    # stored transaction kept the old currency. Deliberately UNPATTERNED: the answer
    # to "currency": "usd" must be the domain code ACCOUNT_CURRENCY_IMMUTABLE, not a
    # Pydantic format complaint that reads like "try again with USD".
    currency: str | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        return None if v is None else _clean_name(v)


class AccountError(BaseModel):
    """404/422 error envelope — mirrors ``CategoryError`` / ``TransactionError``."""

    detail: str
