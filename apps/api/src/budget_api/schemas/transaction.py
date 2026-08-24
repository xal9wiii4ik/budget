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

#: ISO-3166-1 alpha-2, uppercase only — the ``_CURRENCY_PATTERN`` rule applied to
#: countries: FORMAT-only validation, and NO normalization. A lowercase ``"by"`` is
#: a 422, not a silent uppercase: the DB CHECK spells the same rule, so accepting it
#: here would turn a client bug into a 500 two layers down. Public because
#: ``schemas/profile.py`` is the second consumer (the ``MAX_MINOR_AMOUNT`` precedent).
COUNTRY_PATTERN = r"^[A-Z]{2}$"

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


def clean_merchant(v: str | None) -> str | None:
    # Public since 5.3 (the clean_note precedent): schemas/recurring.py is the
    # second consumer, so a recurring template's merchant is cleaned by exactly
    # the same contract the transactions it materializes are.
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
    #: The account the money left (expense/transfer) or landed on (income).
    account_id: uuid.UUID
    amount_minor: int
    kind: TransactionKind
    currency: str  # the money as spent — always the ACCOUNT's currency (§4)
    # Converted snapshot in the base currency at write time (D5). Both null when no
    # rate existed OR when the row IS in the base currency — a consumer must never
    # decode base_amount_minor at a guessed currency's exponent (AM-5).
    base_amount_minor: int | None
    base_currency: str | None
    category_id: uuid.UUID | None
    occurred_at: date
    note: str | None
    receipt_id: uuid.UUID | None  # link to the source receipt (null for manual entries)
    # The recurring template that booked this row (5.3 D7), null for a manually
    # created one. SERVER-MANAGED (SL-B): it is absent from TransactionCreate /
    # TransactionUpdate, so a client can neither forge nor re-point attribution —
    # a value sent on a write is ignored (the house extra="ignore" default). Null
    # also after the template is deleted (the FK is ON DELETE SET NULL, SL-C):
    # the money survives, the attribution does not.
    recurring_template_id: uuid.UUID | None
    merchant: str | None
    # The transfer's TARGET leg — all three null on every expense/income row, all
    # three set on a transfer (a DB CHECK, not a convention). ``counter_amount_minor``
    # is what actually LANDED, in ``counter_currency`` (the target account's own
    # currency), so it must be decoded at THAT currency's exponent — never at the
    # row's ``currency`` (the AM-5 no-fallback rule, applied to the second leg).
    counter_account_id: uuid.UUID | None
    counter_amount_minor: int | None
    counter_currency: str | None
    # The purchase as the MERCHANT priced it (S1) — both null when it was priced in
    # the account's own currency. DISPLAY ONLY: ``amount_minor``/``currency`` above
    # are what left the account and what every balance, snapshot and aggregate
    # counts. Decode ``original_amount_minor`` at ``original_currency``'s exponent,
    # never at the row's (the AM-5 no-fallback rule, applied to the third leg).
    original_amount_minor: int | None
    original_currency: str | None
    #: Where the money was spent (S2), ISO-3166-1 alpha-2; null when not recorded.
    country: str | None
    #: The rate the two legs imply — target major per one source major, 6
    #: significant digits (A2). A STRING because it is a Decimal, and JSON numbers
    #: are floats: 0.0000395 must survive the wire exactly as printed. Computed on
    #: every read, stored nowhere; null unless the row is a transfer. Clients
    #: DISPLAY it and never recompute it.
    transfer_rate: str | None
    #: The plan node this payment belongs to (goal-planner §3), null when the row
    #: is not part of a goal's plan. AT MOST ONE node per transaction — the column
    #: is a scalar, so "paid" can never be counted twice.
    goal_item_id: uuid.UUID | None
    #: The rate the original and settlement amounts imply — ACCOUNT currency major
    #: per one ``original_currency`` major, same string contract and same 6
    #: significant digits as ``transfer_rate`` above (whose helper computes it).
    #: Computed on every read, stored nowhere; null unless the original pair is set.
    #: Clients DISPLAY it and never recompute it.
    original_rate: str | None
    created_at: datetime  # tz-aware


class TransactionCreate(BaseModel):
    # No user_id field (forced from token).
    # decision h: reject zero/negative at contract; le: D14 upper bound.
    # OPTIONAL since S1: a client that sends the original pair alone lets the server
    # derive what the account was debited from the daily rate. Exactly one of
    # ``amount_minor`` / the original pair is enough, and neither being present is
    # 422 AMOUNT_REQUIRED at the ROUTER — a string code, not a Pydantic array,
    # because the web form has to tell the two refusals apart.
    amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    kind: TransactionKind  # REQUIRED (1.2 carry-forward)
    #: REQUIRED (architecture §1/§4): every row belongs to an account, and the
    #: account is what decides the row's currency.
    account_id: uuid.UUID
    # Null/omitted → the server stamps the ACCOUNT's currency (architecture §4).
    # A non-null value that disagrees with the account is 422
    # ACCOUNT_CURRENCY_MISMATCH — never a silent restamp: a client that believes it
    # booked USD must not be told "ok" for a row stored as BYN.
    currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    # User override of the converted snapshot; wins over any auto-computed value.
    # Sending it with a base-currency row is 422 BASE_AMOUNT_WITHOUT_CURRENCY.
    base_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    category_id: uuid.UUID | None = None
    occurred_at: date  # required; any date incl. future (decision g)
    note: str | None = None
    # Receipt link + merchant are additive/optional (D8): omitted for manual entries,
    # set when confirming a parsed receipt. receipt_id ownership is validated in the
    # router; merchant drives the learning upsert. Since S3 ``receipt_id`` is
    # editable too (it is in TransactionUpdate): attaching a photo to a row that was
    # typed by hand is the whole point of the redesigned form.
    receipt_id: uuid.UUID | None = None
    merchant: str | None = None
    # The purchase as the MERCHANT priced it (S1). An ATOMIC PAIR: the router
    # refuses half of it with 422 ORIGINAL_FIELDS_REQUIRED and a DB CHECK makes the
    # half-pair unrepresentable, so no code path can store one without the other.
    # Sending it WITH ``amount_minor`` records the bank's own rate verbatim (the
    # server never overwrites a sent settlement amount); sending it ALONE asks the
    # server to derive the settlement amount from the daily rate — 422
    # FX_RATE_UNAVAILABLE when there is none, never a guess and never a 500.
    # ``original_currency`` equal to the account's is 422
    # ORIGINAL_CURRENCY_MATCHES_ACCOUNT (NULL already means "same currency"), and a
    # transfer can carry no original leg at all (422 TRANSFER_ORIGINAL_FORBIDDEN).
    original_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    original_currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    #: Where the money was spent (S2). Format-only, never normalized (COUNTRY_PATTERN).
    country: str | None = Field(default=None, pattern=COUNTRY_PATTERN)
    # The transfer's target leg (architecture §3). Both REQUIRED when kind=transfer
    # (422 TRANSFER_FIELDS_REQUIRED) and both FORBIDDEN otherwise (422
    # COUNTER_FIELDS_WITHOUT_TRANSFER) — a transfer is one row carrying both sides,
    # so a half-filled pair has no meaning to fall back on. ``counter_currency`` is
    # NOT here: it is stamped from the target account, exactly as ``currency`` is
    # stamped from the source one.
    counter_account_id: uuid.UUID | None = None
    counter_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    #: Link this payment to a plan node of one of your goals (goal-planner §3).
    #: EXPENSE ONLY (422 GOAL_ITEM_EXPENSE_ONLY): "paid" is money that left, and a
    #: transfer or an income row would double-count or invert it. A foreign or
    #: missing node is 404 GOAL_ITEM_NOT_FOUND — one code path, byte-identical.
    goal_item_id: uuid.UUID | None = None
    # Client-generated idempotency key (B-1: mobile outbox replay, MCP retry).
    # Optional and additive: a caller that sends nothing keeps the pre-B-1 contract
    # byte-for-byte, including the 201. FIRST WRITE WINS — a replay carrying the
    # same key returns the STORED row unchanged, so a key must never be reused for
    # a different body. Absent from TransactionUpdate and TransactionRead: it is a
    # write-side dedup token, not a read-model fact.
    client_id: uuid.UUID | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)

    @field_validator("merchant")
    @classmethod
    def _validate_merchant(cls, v: str | None) -> str | None:
        return clean_merchant(v)


class TransactionUpdate(BaseModel):
    # All optional; omitted vs explicit-null distinguished by the router via
    # model_fields_set. NOT NULL fields (amount/kind/occurred_at) reject explicit
    # null with a *_REQUIRED 422; nullable fields (category_id/note) clear on null.
    amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    # A change to or from ``transfer`` is 422 KIND_CHANGE_UNSUPPORTED (delete +
    # create instead): the two shapes have disjoint required fields, so morphing one
    # into the other in place is three coupled rewrites masquerading as one edit.
    kind: TransactionKind | None = None
    # NOT NULL column → an explicit null is 422 CURRENCY_REQUIRED (the *_REQUIRED
    # house pattern). base_amount_minor is the one field where an explicit null is
    # neither "clear" nor rejected: it DISCARDS a user override and recomputes
    # (R1(1) — the snapshot is server-managed, so nullable-clears does not apply).
    # Since the accounts scope the value must EQUAL the effective account's currency
    # (422 ACCOUNT_CURRENCY_MISMATCH otherwise): moving a row to another account is
    # what restamps it.
    currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    # Moving a row between accounts (architecture §4): restamps ``currency`` from
    # the new account and recomputes the base snapshot. NOT NULL column → an
    # explicit null is 422 ACCOUNT_REQUIRED.
    account_id: uuid.UUID | None = None
    # Editable on a transfer only (422 COUNTER_FIELDS_WITHOUT_TRANSFER otherwise);
    # an explicit null on a transfer is 422 TRANSFER_FIELDS_REQUIRED — a transfer
    # cannot lose its target leg and stay a transfer. Both sides are edited
    # independently: the rate is derived from them, never the other way round.
    counter_account_id: uuid.UUID | None = None
    counter_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    base_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    category_id: uuid.UUID | None = None
    occurred_at: date | None = None
    note: str | None = None
    # An explicit null clears the stored merchant; PATCH never learns (D7).
    merchant: str | None = None
    # The photo link (S3). null→value attaches, value→null detaches, value→other
    # value re-points — all three are ordinary edits of the redesigned form. A
    # non-null value is ownership-checked exactly as on create (foreign == missing
    # == 422 RECEIPT_NOT_FOUND, no-oracle). Detaching does NOT delete the stored
    # object: reaping orphans in MinIO is a separate, explicitly-confirmed job.
    receipt_id: uuid.UUID | None = None
    # The original leg (S1) — same atomic pair as on create, with PATCH semantics:
    # omit keeps, BOTH null clears the pair (and leaves ``amount_minor`` alone — the
    # settlement amount is the source of truth, so clearing a display field must not
    # silently restate money), BOTH values override. Values WITHOUT ``amount_minor``
    # re-derive the settlement amount at the row's effective date; values WITH it
    # store both verbatim. Half a pair — one field sent, or one null and one value —
    # is 422 ORIGINAL_FIELDS_REQUIRED.
    original_amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)
    original_currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    #: Nullable-clears like ``note``: an explicit null forgets where it was spent.
    country: str | None = Field(default=None, pattern=COUNTRY_PATTERN)
    #: The plan link (goal-planner §3): null→value attaches, value→null unlinks,
    #: value→other value moves the payment to another node — and "paid" follows it
    #: on the next read, because nothing about it is stored. The expense-only rule
    #: is checked on the EFFECTIVE pair, so patching ``kind`` on a linked row is
    #: refused too.
    goal_item_id: uuid.UUID | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return clean_note(v)

    @field_validator("merchant")
    @classmethod
    def _validate_merchant(cls, v: str | None) -> str | None:
        return clean_merchant(v)


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
