"""Receipt upload lifecycle — create (presigned PUT) + read (architecture D1/D9).

Two routes land in S2:

* ``POST /receipts`` — allocate a receipt row (status ``pending``), hand back a
  presigned PUT the client uploads its JPEG to. Rate limited **per user** (D11):
  the account, not the localhost IP, is the cost driver.
* ``GET /receipts/{receipt_id}`` — user-scoped read; foreign/missing alike are
  ``404 RECEIPT_NOT_FOUND`` (no-oracle, one code path — the transactions precedent).

``_serialize_receipt`` is introduced here in its final ``ReceiptRead`` shape so the
GET route compiles against the contract, but in S2 a receipt is always ``pending``
so it only ever ships the null-parsed shape. The S3 parse pipeline fills the
``parsed``/suggestion path by reading ``parsed_json``; only this function's body
changes then, not the contract.
"""

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.auth import current_active_user
from budget_api.db import get_session
from budget_api.enums import ReceiptStatus
from budget_api.models import Receipt, User
from budget_api.rate_limit import (
    limiter,
    rate_limit_exempt,
    receipt_create_limit_value,
    receipt_rl_key,
)
from budget_api.schemas.receipt import (
    PresignedUpload,
    ReceiptCreated,
    ReceiptError,
    ReceiptRead,
)
from budget_api.services.storage import Storage

router = APIRouter()

_RECEIPT_ERR: dict[str, object] = {"model": ReceiptError}
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: _RECEIPT_ERR
}
_RATE_LIMITED: dict[int | str, dict[str, object]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: _RECEIPT_ERR
}

# slowapi's Limiter.limit is typed to return a bare Callable (Unknown), which trips
# pyright-strict reportUnknownMemberType; route the decorator through an Any alias so
# the partial type stays contained here (the auth router uses the same containment).
_limiter_any: Any = limiter


async def _rl_stash_user(
    request: Request, user: User = Depends(current_active_user)
) -> User:
    """Stash the authenticated user id for the per-user rate key.

    Runs as an endpoint dependency (resolved before slowapi's wrapper), so
    ``receipt_rl_key`` reads ``request.state.rl_user_id`` on the limited routes.
    """
    request.state.rl_user_id = str(user.id)
    return user


async def _load_own_receipt(
    session: AsyncSession, receipt_id: uuid.UUID, user_id: uuid.UUID
) -> Receipt | None:
    """user_id-scoped load; foreign/missing → None → 404 (no-oracle, one path)."""
    return await session.scalar(
        select(Receipt).where(Receipt.id == receipt_id, Receipt.user_id == user_id)
    )


def _serialize_receipt(receipt: Receipt) -> ReceiptRead:
    # S2: a receipt is always pending, so parsed/suggestion are null. S3 replaces
    # this body to read parsed_json (parsed payload, resolved suggestion, error).
    return ReceiptRead(
        id=receipt.id,
        status=ReceiptStatus(receipt.status),
        parsed=None,
        suggested_category_id=None,
        suggestion_source=None,
        error=receipt.error,
        created_at=receipt.created_at,
    )


@router.post(
    "",
    response_model=ReceiptCreated,
    status_code=status.HTTP_201_CREATED,
    responses=_RATE_LIMITED,
)
@_limiter_any.limit(
    receipt_create_limit_value, key_func=receipt_rl_key, exempt_when=rate_limit_exempt
)
async def create_receipt(
    request: Request,
    user: User = Depends(_rl_stash_user),
    session: AsyncSession = Depends(get_session),
) -> ReceiptCreated:
    receipt_id = uuid.uuid4()
    storage: Storage = request.app.state.storage
    path = storage.object_path(user.id, receipt_id)
    receipt = Receipt(
        id=receipt_id,
        user_id=user.id,
        storage_path=path,
        status=ReceiptStatus.pending.value,
    )
    session.add(receipt)
    await session.commit()
    # Presign AFTER the row is durable: pure-local SigV4 computation, no I/O, safe
    # in an async handler (D9). A presign never fails on a committed row.
    presigned = storage.presign_put(path)
    return ReceiptCreated(
        id=receipt_id,
        status=ReceiptStatus.pending,
        upload=PresignedUpload(
            url=presigned.url,
            headers=presigned.headers,
            expires_at=presigned.expires_at,
        ),
    )


@router.get("/{receipt_id}", response_model=ReceiptRead, responses={**_NOT_FOUND})
async def get_receipt(
    receipt_id: uuid.UUID,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> ReceiptRead:
    receipt = await _load_own_receipt(session, receipt_id, user.id)
    if receipt is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="RECEIPT_NOT_FOUND"
        )
    return _serialize_receipt(receipt)
