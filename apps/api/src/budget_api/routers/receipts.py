"""Receipt upload lifecycle — create, read, and the async parse pipeline (D1/D5/D9/D10).

Routes:

* ``POST /receipts`` — allocate a receipt row (status ``pending``), hand back a
  presigned PUT the client uploads its JPEG to. Per-user rate limited (D11).
* ``GET /receipts/{receipt_id}`` — user-scoped read; foreign/missing alike are
  ``404 RECEIPT_NOT_FOUND`` (no-oracle, one code path — the transactions precedent).
* ``POST /receipts/{receipt_id}/parse`` — kick off the async parse. Fails fast on an
  unconfigured key (503 AI_NOT_CONFIGURED), unreachable/misbehaving object storage
  (503 STORAGE_UNAVAILABLE), a not-yet-uploaded object (409 RECEIPT_NOT_UPLOADED), or
  an oversized image (422 IMAGE_TOO_LARGE); otherwise atomically CLAIMS the row and
  schedules the background pipeline, returning ``202 processing``.

STORAGE_UNAVAILABLE and AI_NOT_CONFIGURED are request-time-only codes: they fail the
request *before* the row is claimed and are NEVER written to ``receipts.error`` (only
the background pipeline's DOWNLOAD_FAILED/ANTHROPIC_ERROR/... taxonomy is persisted).

The claim/parse concurrency is a claim-token mechanism (senior-lead flag 2): the
claim UPDATE writes ``parse_started_at = now()`` and RETURNs the exact stored value;
that token guards every terminal UPDATE (``WHERE parse_started_at = :claim_token``),
so a stale-takeover overwrites the token and the loser's write matches 0 rows and is
silently dropped. A post-commit re-read is NOT a valid token (it could observe a
takeover's newer value) — RETURNING is the only correct source.
"""

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.ai_gate import require_ai_configured
from budget_api.auth import current_active_user
from budget_api.category_access import visible_categories_clause
from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.domain.merchant import normalize_merchant
from budget_api.domain.money import to_minor_units
from budget_api.enums import ReceiptStatus
from budget_api.models import Category, MerchantCategoryMap, Receipt, User
from budget_api.rate_limit import (
    limiter,
    rate_limit_exempt,
    receipt_create_limit_value,
    receipt_parse_limit_value,
    receipt_rl_key,
    stash_rl_user,
)
from budget_api.schemas.receipt import (
    ParsedReceipt,
    ParsedReceiptRead,
    PresignedUpload,
    ReceiptCreated,
    ReceiptError,
    ReceiptRead,
    SuggestionSource,
)
from budget_api.services.receipt_parser import (
    CategoryOption,
    ReceiptParseError,
    ReceiptParser,
)
from budget_api.services.storage import Storage

logger = logging.getLogger(__name__)

router = APIRouter()

_DOWNLOAD_TIMEOUT_SECONDS = 30.0
_HEAD_TIMEOUT_SECONDS = 10.0

_RECEIPT_ERR: dict[str, object] = {"model": ReceiptError}
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: _RECEIPT_ERR
}
_CONFLICT: dict[int | str, dict[str, object]] = {status.HTTP_409_CONFLICT: _RECEIPT_ERR}
# The 503 arm is shared by two request-time-only ReceiptError codes:
# AI_NOT_CONFIGURED (missing Anthropic key) and STORAGE_UNAVAILABLE (HEAD probe
# unreachable/misbehaving). Both fail before the claim; neither is ever stored in
# ``receipts.error``. Same ReceiptError model → no schema change from adding the code.
_NOT_CONFIGURED: dict[int | str, dict[str, object]] = {
    status.HTTP_503_SERVICE_UNAVAILABLE: _RECEIPT_ERR
}
_RATE_LIMITED: dict[int | str, dict[str, object]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: _RECEIPT_ERR
}
# AM-5 / senior-lead V2: the parse route's ``receipt_id`` uuid path param makes
# FastAPI auto-emit an HTTPValidationError arm at 422. Declaring ReceiptError alone
# would suppress it and make the generated type lie about one arm (the exact 1.4
# lie), so we declare the honest anyOf union as a raw content schema — identical to
# the transactions POST/PATCH precedent. IMAGE_TOO_LARGE is the business arm.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/ReceiptError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}

# slowapi's Limiter.limit is typed to return a bare Callable (Unknown), which trips
# pyright-strict reportUnknownMemberType; route the decorator through an Any alias so
# the partial type stays contained here (the auth router uses the same containment).
_limiter_any: Any = limiter


async def _load_own_receipt(
    session: AsyncSession, receipt_id: uuid.UUID, user_id: uuid.UUID
) -> Receipt | None:
    """user_id-scoped load; foreign/missing → None → 404 (no-oracle, one path)."""
    return await session.scalar(
        select(Receipt).where(Receipt.id == receipt_id, Receipt.user_id == user_id)
    )


def _serialize_receipt(receipt: Receipt) -> ReceiptRead:
    """Read-time projection. On a parsed receipt this re-validates the stored model
    document through ``ParsedReceipt`` (a drifted document is a loud 500, never
    silently shipped — D12) and derives ``total_minor`` via the shared exponent rule.
    """
    parsed: ParsedReceiptRead | None = None
    suggested_category_id: uuid.UUID | None = None
    suggestion_source: SuggestionSource | None = None

    if receipt.status == ReceiptStatus.parsed.value and receipt.parsed_json is not None:
        doc = receipt.parsed_json
        # Re-validate the stored model payload: schema drift surfaces as a 500 here,
        # never a silently-wrong read. (AM-2 keeps dirty totals out of storage so this
        # only ever fires on genuine drift, not on predictably-messy model output.)
        model = ParsedReceipt.model_validate(doc["model"])
        parsed = ParsedReceiptRead(
            total=model.total,
            total_minor=to_minor_units(model.total, model.currency),
            currency=model.currency,
            merchant=model.merchant,
            date=model.date,
            items=model.items,
        )
        raw_cat = doc.get("suggested_category_id")
        if isinstance(raw_cat, str):
            suggested_category_id = uuid.UUID(raw_cat)
        raw_src = doc.get("suggestion_source")
        if isinstance(raw_src, str):
            suggestion_source = SuggestionSource(raw_src)

    return ReceiptRead(
        id=receipt.id,
        status=ReceiptStatus(receipt.status),
        parsed=parsed,
        suggested_category_id=suggested_category_id,
        suggestion_source=suggestion_source,
        error=receipt.error,
        created_at=receipt.created_at,
    )


@router.post(
    "",
    response_model=ReceiptCreated,
    status_code=status.HTTP_201_CREATED,
    responses={**_RATE_LIMITED},
)
@_limiter_any.limit(
    receipt_create_limit_value, key_func=receipt_rl_key, exempt_when=rate_limit_exempt
)
async def create_receipt(
    request: Request,
    user: User = Depends(stash_rl_user),
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


async def _head_object(url: str) -> httpx.Response:
    async with httpx.AsyncClient() as http:
        return await http.head(url, timeout=_HEAD_TIMEOUT_SECONDS)


async def _download(url: str) -> bytes:
    async with httpx.AsyncClient() as http:
        response = await http.get(url, timeout=_DOWNLOAD_TIMEOUT_SECONDS)
        response.raise_for_status()
        return response.content


@router.post(
    "/{receipt_id}/parse",
    response_model=ReceiptRead,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        **_NOT_FOUND,
        **_UNPROCESSABLE,
        **_CONFLICT,
        **_NOT_CONFIGURED,
        **_RATE_LIMITED,
    },
)
@_limiter_any.limit(
    receipt_parse_limit_value, key_func=receipt_rl_key, exempt_when=rate_limit_exempt
)
async def parse_receipt(
    request: Request,
    receipt_id: uuid.UUID,
    background: BackgroundTasks,
    user: User = Depends(stash_rl_user),
    session: AsyncSession = Depends(get_session),
) -> ReceiptRead:
    settings: Settings = request.app.state.settings
    # Called INLINE, at exactly the position the former inline block occupied —
    # not as ``Depends`` (see ``ai_gate``): a route dependency resolves before the
    # endpoint's own parameters, which would answer 503 instead of 401 on an
    # unauthenticated request and would take this 503 out of the parse quota.
    await require_ai_configured(request)
    # Capture the user id as a plain value: the loser path below rolls back (which
    # expires ORM instances), so ``user.id`` must not be re-accessed afterward.
    user_id = user.id
    receipt = await _load_own_receipt(session, receipt_id, user_id)
    if receipt is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="RECEIPT_NOT_FOUND"
        )
    if receipt.status == ReceiptStatus.parsed.value:
        # Terminal: skip the HEAD probe and the claim entirely.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="RECEIPT_ALREADY_PARSED"
        )

    storage: Storage = request.app.state.storage
    created_at = receipt.created_at
    storage_path = receipt.storage_path
    # Object existence + size gate BEFORE the claim (D5): async httpx HEAD.
    try:
        head = await _head_object(storage.presign_head(storage_path))
    except httpx.HTTPError as exc:
        # Storage unreachable (MinIO down, timeout, connection reset) is a service
        # condition, not a client error: fail honestly with an untouched receipt so
        # the client retries. Never a raw 500 on the money endpoint.
        logger.warning("receipt %s HEAD probe failed: %r", receipt_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="STORAGE_UNAVAILABLE",
        ) from exc
    if head.status_code == status.HTTP_404_NOT_FOUND:
        # Stays pending/failed; the client uploads then retries.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="RECEIPT_NOT_UPLOADED"
        )
    if head.status_code != status.HTTP_200_OK:
        # Any other status (403 on an expired/edge presign, 5xx, redirect junk) means
        # storage is misbehaving and content-length can't be trusted. Fail before the
        # claim rather than falling through the size gate and dying later as
        # DOWNLOAD_FAILED (review finding 6).
        logger.warning(
            "receipt %s HEAD probe returned %s", receipt_id, head.status_code
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="STORAGE_UNAVAILABLE",
        )
    if int(head.headers.get("content-length", "0")) > settings.receipt_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="IMAGE_TOO_LARGE"
        )

    # Atomic claim with RETURNING: claimable if pending/failed, or processing but
    # stale. The returned parse_started_at is the exact claim token (flag 2).
    stale_before = func.now() - timedelta(seconds=settings.receipt_parse_stale_seconds)
    claim = await session.execute(
        update(Receipt)
        .where(
            Receipt.id == receipt_id,
            Receipt.user_id == user_id,
            or_(
                Receipt.status.in_(
                    (ReceiptStatus.pending.value, ReceiptStatus.failed.value)
                ),
                and_(
                    Receipt.status == ReceiptStatus.processing.value,
                    Receipt.parse_started_at < stale_before,
                ),
            ),
        )
        .values(
            status=ReceiptStatus.processing.value,
            parse_started_at=func.now(),
            error=None,
        )
        .returning(Receipt.parse_started_at)
    )
    row = claim.first()
    if row is None:
        # Lost the claim → classify off a fresh read (a concurrent claimer won). Read
        # the status COLUMN (a plain scalar), never a fresh ORM object: rollback()
        # expires instances, and touching an expired attribute would lazy-load IO in a
        # sync context — a greenlet crash on the async engine.
        await session.rollback()
        fresh_status = await session.scalar(
            select(Receipt.status).where(
                Receipt.id == receipt_id, Receipt.user_id == user_id
            )
        )
        if fresh_status is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="RECEIPT_NOT_FOUND"
            )
        if fresh_status == ReceiptStatus.parsed.value:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="RECEIPT_ALREADY_PARSED"
            )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="RECEIPT_PROCESSING"
        )
    claim_token: datetime = row[0]
    await session.commit()

    background.add_task(
        _run_parse,
        receipt_id=receipt_id,
        user_id=user_id,
        storage_path=storage_path,
        claim_token=claim_token,
        sessionmaker=request.app.state.sessionmaker,
        storage=storage,
        parser=request.app.state.receipt_parser,
    )
    return ReceiptRead(
        id=receipt_id,
        status=ReceiptStatus.processing,
        parsed=None,
        suggested_category_id=None,
        suggestion_source=None,
        error=None,
        created_at=created_at,
    )


async def _load_visible_options(
    session: AsyncSession, user_id: uuid.UUID
) -> list[CategoryOption]:
    """Own + system categories, EXCLUDING archived (AM-4).

    ``visible_categories_clause`` alone is own-or-system with NO archived filter, so
    the ``Category.archived.is_(False)`` predicate here is what keeps archived
    categories out of both the Claude prompt AND the ``visible_ids`` membership set —
    without it D6's archived-skip would be dead code.
    """
    rows = await session.execute(
        select(Category.id, Category.name, Category.kind).where(
            visible_categories_clause(user_id),
            Category.archived.is_(False),
        )
    )
    return [
        CategoryOption(id=row.id, name=row.name, kind=row.kind) for row in rows.all()
    ]


async def _resolve_suggestion(
    session: AsyncSession,
    user_id: uuid.UUID,
    parsed: ParsedReceipt,
    options: list[CategoryOption],
) -> tuple[uuid.UUID | None, str | None]:
    """D6 precedence: learned merchant map > model suggestion > null.

    An archived/foreign map target is skipped (absent from ``visible_ids``); an
    unknown/archived model id is silently dropped. Until S4 lands the map is empty,
    so the merchant lookup simply misses — correct behavior, not a bug.
    """
    visible_ids = {option.id for option in options}
    norm = normalize_merchant(parsed.merchant or "")
    if norm:
        mapped = await session.scalar(
            select(MerchantCategoryMap.category_id).where(
                MerchantCategoryMap.user_id == user_id,
                MerchantCategoryMap.merchant_norm == norm,
            )
        )
        if mapped is not None and mapped in visible_ids:
            return mapped, SuggestionSource.merchant_map.value
    if parsed.suggested_category_id in visible_ids:
        return parsed.suggested_category_id, SuggestionSource.model.value
    return None, None


async def _finish_parsed(
    session: AsyncSession,
    receipt_id: uuid.UUID,
    claim_token: datetime,
    parsed_json: dict[str, object],
) -> None:
    """Guarded terminal UPDATE → parsed. rowcount 0 ⇒ a takeover won; drop silently."""
    await session.execute(
        update(Receipt)
        .where(
            Receipt.id == receipt_id,
            Receipt.status == ReceiptStatus.processing.value,
            Receipt.parse_started_at == claim_token,
        )
        .values(status=ReceiptStatus.parsed.value, parsed_json=parsed_json, error=None)
    )
    await session.commit()


async def _finish_failed(
    session: AsyncSession,
    receipt_id: uuid.UUID,
    claim_token: datetime,
    error_code: str,
) -> None:
    """Guarded terminal UPDATE → failed. rowcount 0 ⇒ a takeover won; drop silently."""
    await session.execute(
        update(Receipt)
        .where(
            Receipt.id == receipt_id,
            Receipt.status == ReceiptStatus.processing.value,
            Receipt.parse_started_at == claim_token,
        )
        .values(status=ReceiptStatus.failed.value, error=error_code)
    )
    await session.commit()


async def _run_parse(
    *,
    receipt_id: uuid.UUID,
    user_id: uuid.UUID,
    storage_path: str,
    claim_token: datetime,
    sessionmaker: async_sessionmaker[AsyncSession],
    storage: Storage,
    parser: ReceiptParser,
) -> None:
    """Background pipeline (D11 steps 1-5). Owns its session; never raises.

    Every terminal write is guarded by ``claim_token`` so a stale-takeover's worker
    silently drops its result (rowcount 0). Any unexpected error is caught, logged
    with ``receipt_id`` context, and written as ANTHROPIC_ERROR.
    """
    async with sessionmaker() as session:
        try:
            # 1. Download the uploaded JPEG (30s cap).
            try:
                image = await _download(storage.presign_get(storage_path))
            except (httpx.HTTPError, TimeoutError) as exc:
                logger.warning("receipt %s download failed: %r", receipt_id, exc)
                await _finish_failed(
                    session, receipt_id, claim_token, "DOWNLOAD_FAILED"
                )
                return

            # 2. Visible, non-archived categories → prompt list + membership set.
            options = await _load_visible_options(session, user_id)

            # 3. Parse.
            try:
                parsed = await parser.parse(image, options)
            except ReceiptParseError as exc:
                await _finish_failed(session, receipt_id, claim_token, exc.code)
                return

            # 4. Resolve the suggestion (map > model > null, D6).
            category_id, source = await _resolve_suggestion(
                session, user_id, parsed, options
            )

            # 5. Guarded terminal write.
            await _finish_parsed(
                session,
                receipt_id,
                claim_token,
                {
                    "model": parsed.model_dump(mode="json"),
                    "suggested_category_id": (
                        str(category_id) if category_id is not None else None
                    ),
                    "suggestion_source": source,
                },
            )
        except Exception as exc:
            # Guard of last resort: an unexpected error is logged with context and
            # recorded as a failure so the receipt never sticks in ``processing``.
            logger.exception("receipt %s parse pipeline crashed: %r", receipt_id, exc)
            try:
                # The originating error may have left the session in a failed
                # transaction (a DB error in _load_visible_options/_resolve_suggestion,
                # or a crash inside _finish_parsed). Writing on a dirty session raises
                # PendingRollbackError, which the inner except would swallow, leaving
                # the row stuck in ``processing`` for the whole stale window. Roll back
                # first (itself guarded) so the guarded _finish_failed can land.
                try:
                    await session.rollback()
                except Exception:
                    logger.exception(
                        "receipt %s rollback before failed-state write crashed",
                        receipt_id,
                    )
                await _finish_failed(
                    session, receipt_id, claim_token, "ANTHROPIC_ERROR"
                )
            except Exception:
                logger.exception(
                    "receipt %s failed-state write also crashed", receipt_id
                )
