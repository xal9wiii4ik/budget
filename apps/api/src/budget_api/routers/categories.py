"""Category CRUD — list / create / update over the ``categories`` table.

Two structural authorization pillars (architecture §3):

* **Reads** filter ``user_id = me OR user_id IS NULL`` (own + shared system rows).
* **Writes** force ``user_id = me`` and never read ``user_id`` from the body.

Visibility policy (no-oracle): system rows are public, so mutating one is a
``403 SYSTEM_CATEGORY_READONLY``; another user's row and a nonexistent id are
both ``404 CATEGORY_NOT_FOUND`` with a byte-identical body
(``load_visible_category`` makes the two paths structurally identical). The
visible-categories query lives in ``category_access`` — 1.3 was its first
consumer; 1.4 (the second) extracted it there (1.2 §7 rule).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.auth import current_active_user
from budget_api.category_access import (
    load_visible_category,
    visible_categories_clause,
)
from budget_api.db import get_session
from budget_api.enums import CategoryKind
from budget_api.models import Category, User
from budget_api.schemas.category import (
    CategoryCreate,
    CategoryError,
    CategoryRead,
    CategoryUpdate,
)

router = APIRouter()

# Mirrors routers/auth.py's RateLimitedError declaration pattern: every
# HTTPException.detail below is a stable UPPER_SNAKE code carried in {"detail": ...}.
_NOT_FOUND_403: dict[int | str, dict[str, object]] = {
    status.HTTP_403_FORBIDDEN: {"model": CategoryError},
    status.HTTP_404_NOT_FOUND: {"model": CategoryError},
}
_CONFLICT: dict[int | str, dict[str, object]] = {
    status.HTTP_409_CONFLICT: {"model": CategoryError}
}


def _serialize(cat: Category) -> CategoryRead:
    return CategoryRead(
        id=cat.id,
        name=cat.name,
        icon=cat.icon,
        color=cat.color,
        kind=CategoryKind(cat.kind),
        archived=cat.archived,
        is_system=cat.user_id is None,
    )


async def _reject_duplicate(
    session: AsyncSession,
    user_id: uuid.UUID,
    name: str,
    kind: CategoryKind,
    *,
    exclude_id: uuid.UUID | None = None,
) -> None:
    """409 if the caller already owns a non-archived same-kind row with this name.

    Scope: own rows only (system ``user_id IS NULL`` rows are copyable), same
    kind (cross-kind allowed), non-archived, case-insensitive. ``exclude_id``
    drops the target row on update so a case-only self-rename is not a self-collision
    (AM-2). Racy under concurrent creates — accepted for a single-user app (AM-5).
    """
    stmt = select(Category.id).where(
        Category.user_id == user_id,
        func.lower(Category.name) == name.lower(),
        Category.kind == kind.value,
        Category.archived.is_(False),
    )
    if exclude_id is not None:
        stmt = stmt.where(Category.id != exclude_id)
    if await session.scalar(stmt) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="CATEGORY_NAME_CONFLICT"
        )


@router.get("", response_model=list[CategoryRead])
async def list_categories(
    include_archived: bool = False,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> list[CategoryRead]:
    stmt = select(Category).where(visible_categories_clause(user.id))
    if not include_archived:
        stmt = stmt.where(Category.archived.is_(False))
    stmt = stmt.order_by(Category.kind, Category.name)
    rows = (await session.scalars(stmt)).all()
    return [_serialize(cat) for cat in rows]


@router.post(
    "",
    response_model=CategoryRead,
    status_code=status.HTTP_201_CREATED,
    responses=_CONFLICT,
)
async def create_category(
    payload: CategoryCreate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> CategoryRead:
    await _reject_duplicate(session, user.id, payload.name, payload.kind)
    cat = Category(
        user_id=user.id,
        name=payload.name,
        kind=payload.kind.value,
        icon=payload.icon,
        color=payload.color,
    )
    session.add(cat)
    await session.commit()
    await session.refresh(cat)
    return _serialize(cat)


@router.patch(
    "/{category_id}",
    response_model=CategoryRead,
    responses={**_NOT_FOUND_403, **_CONFLICT},
)
async def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdate,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> CategoryRead:
    # Guard order: load-visible → 404, system → 403, then validate/dedup/apply.
    cat = await load_visible_category(session, category_id, user.id)
    if cat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="CATEGORY_NOT_FOUND"
        )
    if cat.user_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="SYSTEM_CATEGORY_READONLY"
        )

    fields = payload.model_fields_set
    # name/kind/archived are NOT NULL: an explicit null cannot clear them.
    if "name" in fields and payload.name is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CATEGORY_NAME_REQUIRED",
        )
    if "kind" in fields and payload.kind is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CATEGORY_KIND_REQUIRED",
        )
    if "archived" in fields and payload.archived is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CATEGORY_ARCHIVED_REQUIRED",
        )

    # AM-1: dedup runs whenever the effective (name, kind) pair changes — i.e.
    # name OR kind is in the update. Check the NEW pair against own non-archived
    # same-kind rows, excluding this row (AM-2).
    name_changing = "name" in fields
    kind_changing = "kind" in fields
    if name_changing or kind_changing:
        effective_name = payload.name if name_changing else cat.name
        effective_kind = payload.kind if kind_changing else CategoryKind(cat.kind)
        assert effective_name is not None  # 422-guarded above
        assert effective_kind is not None  # 422-guarded above
        await _reject_duplicate(
            session,
            user.id,
            effective_name,
            effective_kind,
            exclude_id=category_id,
        )

    if name_changing:
        assert payload.name is not None
        cat.name = payload.name
    if kind_changing:
        assert payload.kind is not None
        cat.kind = payload.kind.value
    # icon/color: explicit null clears (nullable columns); omitted preserves.
    if "icon" in fields:
        cat.icon = payload.icon
    if "color" in fields:
        cat.color = payload.color
    # archived is NOT NULL: explicit null was already rejected (422) above.
    if "archived" in fields:
        assert payload.archived is not None
        cat.archived = payload.archived

    await session.commit()
    await session.refresh(cat)
    return _serialize(cat)
