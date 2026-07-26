"""Receipt request/response schemas.

Imports only Pydantic + the shared ``ReceiptStatus`` enum, never ``models``
(architecture §1). The read schemas (``ReceiptRead``/``ParsedReceiptRead``/
``ReceiptItem``/``SuggestionSource``) are defined here in their full shape so the
GET route compiles and the contract surfaces every component now; their *populated*
path (a real ``parsed`` payload) lands with the S3 parse pipeline. In S2 a receipt
is always ``pending``, so GET only ever ships the null-parsed shape.
"""

import uuid
from datetime import date, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel

from budget_api.enums import ReceiptStatus


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


class ParsedReceiptRead(BaseModel):
    total: str  # decimal string exactly as parsed
    total_minor: int  # derived at read time via the shared exponent rule (S3)
    currency: str | None
    merchant: str | None
    date: date | None
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
