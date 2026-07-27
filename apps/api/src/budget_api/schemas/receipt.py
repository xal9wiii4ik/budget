"""Receipt request/response schemas.

Imports only Pydantic + the shared ``ReceiptStatus`` enum, never ``models``
(architecture §1). The read schemas (``ReceiptRead``/``ParsedReceiptRead``/
``ReceiptItem``/``SuggestionSource``) are defined here in their full shape so the
GET route compiles and the contract surfaces every component now; their *populated*
path (a real ``parsed`` payload) lands with the S3 parse pipeline. In S2 a receipt
is always ``pending``, so GET only ever ships the null-parsed shape.
"""

import re
import uuid

# Aliased so a field literally named ``date`` does not shadow the type in its own
# annotation (``date: date | None = None`` reads as a self-reference to pyright once
# a default is present); the receipt payload's field name is fixed by the contract.
from datetime import date as date_type
from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, field_validator

from budget_api.enums import ReceiptStatus

# A bare non-negative decimal: '.' as the ONLY separator, no signs/exponents/
# grouping. Aligns with the shared MONEY_INPUT_PATTERN intent (money.ts). "." alone
# is malformed. Used by ParsedReceipt.total (AM-2) to reject dirty model output at
# parse time so it never poisons a stored parsed_json.
_MONEY_INPUT_PATTERN = re.compile(r"^(?:\d+(?:\.\d*)?|\.\d+)$")
_CURRENCY_CODE_PATTERN = re.compile(r"^[A-Z]{3}$")


class PresignedUpload(BaseModel):
    """The presigned PUT the client uploads its JPEG to.

    ``headers`` is **advisory**: it carries ``{"Content-Type": "image/jpeg"}`` as a
    hint the client SHOULD send, but storage does not enforce it (minio-py signs the
    host only, never the content-type — see services/storage.py / senior-lead V1).
    The real size gate is the parse-time HEAD ``Content-Length`` check (S3).
    """

    url: str
    method: Literal["PUT"] = "PUT"
    headers: dict[str, str]
    expires_at: datetime  # tz-aware UTC; when the presigned URL stops working


class ReceiptCreated(BaseModel):
    """POST /receipts response: the new row's id + status + where to upload."""

    id: uuid.UUID
    status: ReceiptStatus  # always ``pending`` at create time
    upload: PresignedUpload


class SuggestionSource(StrEnum):
    # Which resolution branch produced ``suggested_category_id`` (D6): a learned
    # merchant->category map hit, or the model's own suggestion. Null when neither.
    merchant_map = "merchant_map"
    model = "model"


class ReceiptItem(BaseModel):
    name: str
    amount: str | None = None  # decimal string as printed, or null


class ParsedReceipt(BaseModel):
    """The model's ``record_receipt`` tool input, validated (D10).

    This is what the parser returns and what is stored verbatim under
    ``parsed_json["model"]``. Its validators are the last line of defense against
    dirty model output: a malformed ``total`` fails HERE (→ INVALID_MODEL_OUTPUT,
    transient/retryable) rather than being stored and turning every subsequent GET
    into a permanent 500 via ``_serialize_receipt``'s re-validate (AM-2).
    """

    total: str  # bare non-negative decimal string exactly as printed
    currency: str | None = None
    merchant: str | None = None
    date: date_type | None = None
    items: list[ReceiptItem] = []
    suggested_category_id: uuid.UUID | None = None

    @field_validator("total")
    @classmethod
    def _validate_total(cls, v: str) -> str:
        # AM-2: well-formed non-negative decimal only. Rejecting here keeps a dirty
        # model total out of storage entirely (never a poisoned row).
        if not _MONEY_INPUT_PATTERN.match(v):
            raise ValueError("total must be a bare non-negative decimal string")
        return v

    @field_validator("currency")
    @classmethod
    def _normalize_currency(cls, v: str | None) -> str | None:
        # Uppercase so the exponent-table lookup in to_minor_units is correct (a
        # lowercase "jpy" would miss the table and mis-scale by 100x). A present but
        # malformed code is coerced to None (display/exponent fallback = default 2),
        # never a hard parse failure — the total is the load-bearing field, not this.
        if v is None:
            return None
        code = v.strip().upper()
        return code if _CURRENCY_CODE_PATTERN.match(code) else None


class ParsedReceiptRead(BaseModel):
    total: str  # decimal string exactly as parsed
    total_minor: int  # derived at read time via the shared exponent rule (S3)
    currency: str | None
    merchant: str | None
    date: date_type | None
    items: list[ReceiptItem]


class ReceiptRead(BaseModel):
    id: uuid.UUID
    status: ReceiptStatus
    parsed: ParsedReceiptRead | None  # populated only once status == parsed (S3)
    suggested_category_id: uuid.UUID | None
    suggestion_source: SuggestionSource | None
    error: str | None
    created_at: datetime  # tz-aware


class ReceiptError(BaseModel):
    """404/429 error envelope — ``{"detail": CODE}``; mirrors ``TransactionError``."""

    detail: str
