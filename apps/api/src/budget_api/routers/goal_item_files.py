"""Attachments of a plan node — presign, confirm, list, delete (goal-planner §7).

A separate router from ``goal_items.py`` on purpose: this is the receipts UPLOAD
machinery (presigned PUT + a server-side HEAD that proves the bytes landed), not
plan-tree CRUD, and the tree response deliberately carries only the two file
COUNTERS so a 500-node plan never mints thousands of presigned URLs (PM §8).

The lifecycle is the receipts one, minus OCR:

1. ``POST .../files`` inserts an UNCONFIRMED row and returns a presigned PUT. The
   row is the reservation; the object does not exist yet.
2. the client PUTs the bytes straight to storage — the API never proxies them;
3. ``POST .../files/{file_id}/confirm`` does the ONE HEAD probe this server ever
   makes: it is what turns ``uploaded`` true, and therefore the only thing that
   can ever make a ``view_url`` appear (``_view_url`` below).

GUARD ORDER, identical to ``goal_items.py`` and load-bearing for the same reason:
goal 404 → archived 422 → item 404 → file 404. Every step past the first is
reachable only for a resource the caller owns, so no refusal can confirm the
existence of someone else's goal, node or file.

Why the goal/item guards are spelled again here instead of imported: a router may
never import another router (the ``goal_item_access`` rule), and the shared half —
the user-scoped goal load — IS imported from there. What is duplicated is three
lines of HTTP shell, not a rule.

These routes carry no MCP marker by decision (§4): attachments are not part of the
token/MCP surface, and an unmarked route is not in the derived allowlist, so a
personal access token gets the fail-closed ``403 TOKEN_ENDPOINT_FORBIDDEN`` from
the shared dependency.
"""

import logging
import uuid

import httpx
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Request,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.goal_item_access import load_own_goal
from budget_api.models import Goal, GoalItem, GoalItemFile, User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.goal_item_file import (
    GoalItemFileCreated,
    GoalItemFileError,
    GoalItemFileRead,
)
from budget_api.schemas.receipt import PresignedUpload
from budget_api.services.object_cleanup import delete_objects
from budget_api.services.storage import Storage

logger = logging.getLogger(__name__)

router = APIRouter()

_HEAD_TIMEOUT_SECONDS = 10.0

_FILE_ERR: dict[str, object] = {"model": GoalItemFileError}
_NOT_FOUND: dict[int | str, dict[str, object]] = {status.HTTP_404_NOT_FOUND: _FILE_ERR}
_CONFLICT: dict[int | str, dict[str, object]] = {status.HTTP_409_CONFLICT: _FILE_ERR}
_UNAVAILABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_503_SERVICE_UNAVAILABLE: _FILE_ERR
}
#: The honest anyOf union (house 422 pattern): the business codes AND FastAPI's own
#: Pydantic array both occur at runtime — the uuid path params alone guarantee the
#: second — so declaring only the model would make the generated client lie.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/GoalItemFileError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}


async def _require_own_goal(
    session: AsyncSession, goal_id: uuid.UUID, user_id: uuid.UUID
) -> Goal:
    goal = await load_own_goal(session, goal_id, user_id)
    if goal is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_NOT_FOUND"
        )
    return goal


def _reject_archived(goal: Goal) -> None:
    """422 on any WRITE into an archived goal (§10d), confirm included.

    Confirm is a write: it flips ``uploaded``. A file uploaded and then left
    unconfirmed because the goal was archived in between is not lost — archiving
    deletes nothing, and unarchiving makes the same confirm succeed.
    """
    if goal.archived:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="GOAL_ARCHIVED"
        )


async def _require_item(
    session: AsyncSession, goal: Goal, item_id: uuid.UUID
) -> GoalItem:
    """The node, scoped by BOTH the (own-checked) goal and its id — no-oracle."""
    item = await session.scalar(
        select(GoalItem).where(GoalItem.id == item_id, GoalItem.goal_id == goal.id)
    )
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_ITEM_NOT_FOUND"
        )
    return item


async def _require_file(
    session: AsyncSession, item: GoalItem, file_id: uuid.UUID
) -> GoalItemFile:
    """The attachment, scoped by the (already own-checked) node.

    Scoping on ``goal_item_id`` alone is deliberate and complete: reaching this
    function means the node's goal belongs to the caller. A file of ANOTHER node —
    even the caller's own — is as absent as a made-up id, so a client cannot use
    this route to discover which ids exist elsewhere.
    """
    file = await session.scalar(
        select(GoalItemFile).where(
            GoalItemFile.id == file_id, GoalItemFile.goal_item_id == item.id
        )
    )
    if file is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="FILE_NOT_FOUND"
        )
    return file


def _view_url(storage: Storage, file: GoalItemFile) -> str | None:
    """Presigned GET, or None while nothing proves the object exists.

    The receipts ``_UPLOAD_PROVEN_STATUSES`` rule in its smallest form: ``uploaded``
    is written at the ONE moment this server observed storage (the confirm HEAD),
    so a URL is minted only against bytes that were actually seen. Pure local
    SigV4 — no I/O — which is what makes it safe per row of a list.
    """
    if not file.uploaded:
        return None
    return storage.presign_get(file.storage_path)


def _serialize(storage: Storage, file: GoalItemFile) -> GoalItemFileRead:
    return GoalItemFileRead(
        id=file.id,
        uploaded=file.uploaded,
        view_url=_view_url(storage, file),
        created_at=file.created_at,
    )


async def _head_object(url: str) -> httpx.Response:
    async with httpx.AsyncClient() as http:
        return await http.head(url, timeout=_HEAD_TIMEOUT_SECONDS)


@router.get(
    "/{goal_id}/items/{item_id}/files",
    response_model=list[GoalItemFileRead],
    responses={**_NOT_FOUND},
    tags=["goal-item-files"],
)
async def list_goal_item_files(
    goal_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> list[GoalItemFileRead]:
    """The node's attachments, oldest first. Unpaginated — there are at most ten.

    Readable on an ARCHIVED goal (no ``_reject_archived``): archiving hides a plan
    from the active list, it does not take the user's own documents away.
    """
    goal = await _require_own_goal(session, goal_id, user.id)
    item = await _require_item(session, goal, item_id)
    storage: Storage = request.app.state.storage
    files = (
        await session.scalars(
            select(GoalItemFile)
            .where(GoalItemFile.goal_item_id == item.id)
            .order_by(GoalItemFile.created_at, GoalItemFile.id)
        )
    ).all()
    return [_serialize(storage, file) for file in files]


@router.post(
    "/{goal_id}/items/{item_id}/files",
    response_model=GoalItemFileCreated,
    status_code=status.HTTP_201_CREATED,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
    tags=["goal-item-files"],
)
async def create_goal_item_file(
    goal_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> GoalItemFileCreated:
    """Reserve an attachment row and hand back the presigned PUT for its bytes.

    The per-node cap is a plain COUNT with no lock — the same interface guard as
    the per-goal item cap (§8): an eleventh attachment costs a crowded screen, not
    money, and serializing uploads on a node-wide lock would be a real price for an
    imaginary problem.
    """
    settings: Settings = request.app.state.settings
    goal = await _require_own_goal(session, goal_id, user.id)
    _reject_archived(goal)
    item = await _require_item(session, goal, item_id)
    count = await session.scalar(
        select(func.count())
        .select_from(GoalItemFile)
        .where(GoalItemFile.goal_item_id == item.id)
    )
    if (count or 0) >= settings.goal_item_files_max_per_item:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="GOAL_ITEM_FILES_LIMIT_EXCEEDED",
        )

    storage: Storage = request.app.state.storage
    file_id = uuid.uuid4()
    file = GoalItemFile(
        id=file_id,
        goal_item_id=item.id,
        user_id=user.id,
        storage_path=storage.goal_item_file_path(user.id, file_id),
        uploaded=False,
    )
    session.add(file)
    await session.commit()
    # ``created_at`` is a server default, so the row is re-read once before it is
    # serialized (the accounts create precedent) rather than guessed at.
    await session.refresh(file)
    # Presign AFTER the row is durable (the receipts rule): pure-local SigV4, no
    # I/O, and it can never fail on a committed row.
    presigned = storage.presign_put(file.storage_path)
    return GoalItemFileCreated(
        id=file_id,
        uploaded=False,
        upload=PresignedUpload(
            url=presigned.url,
            headers=presigned.headers,
            expires_at=presigned.expires_at,
        ),
        created_at=file.created_at,
    )


@router.post(
    "/{goal_id}/items/{item_id}/files/{file_id}/confirm",
    response_model=GoalItemFileRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE, **_CONFLICT, **_UNAVAILABLE},
    tags=["goal-item-files"],
)
async def confirm_goal_item_file(
    goal_id: uuid.UUID,
    item_id: uuid.UUID,
    file_id: uuid.UUID,
    request: Request,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> GoalItemFileRead:
    """Prove the object exists and is within size, then mark the row uploaded.

    Taxonomy copied from the receipts parse gate, because it is the same probe:
    unreachable/misbehaving storage → 503 ``STORAGE_UNAVAILABLE`` (a service
    condition, never a 500 and never a client error), a missing object → 409
    ``FILE_NOT_UPLOADED`` with the row left UNCONFIRMED so the client can PUT and
    retry, an oversized object → 422 ``IMAGE_TOO_LARGE`` against the SAME
    ``receipt_max_bytes`` ceiling as a receipt photo.

    Confirming an already-confirmed file is a 200 no-op, and it short-circuits
    BEFORE the probe: retries are ordinary here (a client that lost the response
    will send it again), and re-probing could only ever demote a file the server
    has already seen — a transient storage blip must not un-prove bytes.
    """
    settings: Settings = request.app.state.settings
    storage: Storage = request.app.state.storage
    goal = await _require_own_goal(session, goal_id, user.id)
    _reject_archived(goal)
    item = await _require_item(session, goal, item_id)
    file = await _require_file(session, item, file_id)
    if file.uploaded:
        return _serialize(storage, file)

    try:
        head = await _head_object(storage.presign_head(file.storage_path))
    except httpx.HTTPError as exc:
        # Class name ONLY: httpx puts the failing request's URL in its message, and
        # that URL is a live presigned credential for this user's object. Signed
        # URLs never reach the logs.
        logger.warning(
            "goal item file %s HEAD probe failed: %s", file_id, type(exc).__name__
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="STORAGE_UNAVAILABLE",
        ) from exc
    if head.status_code == status.HTTP_404_NOT_FOUND:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="FILE_NOT_UPLOADED"
        )
    if head.status_code != status.HTTP_200_OK:
        # 403 on an edge-expired presign, 5xx, redirect junk: storage is
        # misbehaving and its content-length cannot be trusted, so nothing is
        # confirmed off it (the receipts precedent).
        logger.warning(
            "goal item file %s HEAD probe returned %s", file_id, head.status_code
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="STORAGE_UNAVAILABLE",
        )
    if int(head.headers.get("content-length", "0")) > settings.receipt_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="IMAGE_TOO_LARGE"
        )

    file.uploaded = True
    await session.commit()
    return _serialize(storage, file)


@router.delete(
    "/{goal_id}/items/{item_id}/files/{file_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
    tags=["goal-item-files"],
)
async def delete_goal_item_file(
    goal_id: uuid.UUID,
    item_id: uuid.UUID,
    file_id: uuid.UUID,
    request: Request,
    background: BackgroundTasks,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete the row, then the object — in that order, and never the reverse.

    The DB is the truth (§7): the row goes first and is COMMITTED, so a failure
    there is a failed request and is reported as one, never masked by a 204. Only
    after that does the best-effort cleanup run in the background — unreachable
    storage leaves an orphaned object (disk, not data: the key is only UUIDs) and
    still answers 204, because the attachment genuinely is gone.
    """
    goal = await _require_own_goal(session, goal_id, user.id)
    _reject_archived(goal)
    item = await _require_item(session, goal, item_id)
    file = await _require_file(session, item, file_id)
    storage_path = file.storage_path
    await session.delete(file)
    await session.commit()
    background.add_task(delete_objects, request.app.state.storage, [storage_path])
