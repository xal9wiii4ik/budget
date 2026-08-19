"""Recurring template CRUD — the standing orders the materializer books (D2/D10).

This router owns the template rows only; it NEVER books a transaction. A template
created on its own due day materializes at the next run of
``services/recurring_jobs.materialize_due`` (OQ-6), which is why every write here
is really a statement about the ``last_materialized_on`` watermark:

* **create** stamps ``today - 1 day``, so today's occurrence is still ahead of the
  watermark and the next run books it (D2/D6);
* **unpause** (a true→false TRANSITION only) raises the watermark to
  ``max(watermark, today - 1 day)`` (SL-A): the unpause DAY is live, everything
  strictly before it stays skipped forever, and a same-day pause/unpause cycle
  cannot rewind the watermark into re-materializing a date that was already
  booked. A PATCH that merely carries ``paused: false`` on a template that is not
  paused — which the web edit form sends on every save — touches the watermark
  not at all, so pending catch-up dates survive an edit;
* **pause** (false→true) never touches it.

No-oracle: the template path id resolves foreign and missing alike to 404
``RECURRING_TEMPLATE_NOT_FOUND`` (``_load_own``, one code path). A *body*
``category_id`` follows the transactions rule instead — 422 ``CATEGORY_NOT_FOUND``
/ ``CATEGORY_ARCHIVED`` — because the addressed resource is fine and the body is
what is wrong.

The unit/anchor pair is validated in two places for one reason: on create the
payload alone decides (a plain Pydantic 422 from ``schemas/recurring.py``), while
on PATCH the effective pair is half payload and half stored row, so it needs the
``ANCHOR_REQUIRED`` / ``ANCHOR_MISMATCH`` business codes here (R1(5)).

DELETE is hard (D7/SL-C): the materialized transactions survive with
``recurring_template_id`` set to NULL by the FK, so the money history is intact
and only the attribution is gone. ``paused`` is the "stop but keep" affordance.
"""

import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.category_access import load_visible_category
from budget_api.db import get_session
from budget_api.domain.recurrence import next_due
from budget_api.enums import RecurrenceUnit, TransactionKind
from budget_api.models import RecurringTemplate, User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.recurring import (
    RecurringError,
    RecurringTemplateCreate,
    RecurringTemplateList,
    RecurringTemplateRead,
    RecurringTemplateUpdate,
)
from budget_api.services.profile_reads import read_base_currency

router = APIRouter()

# Mirrors routers/goals.py: stable UPPER_SNAKE codes carried in {"detail": ...}.
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": RecurringError}
}
# The honest anyOf union (receipts V2/AM-5): business codes (RecurringError) AND
# FastAPI's auto Pydantic array (HTTPValidationError) both occur at runtime —
# create-side anchor rejections are the latter, PATCH-side ones the former.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/RecurringError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}

#: NOT NULL columns: an explicit null cannot clear them (a bare apply would 500 on
#: IntegrityError), so each gets its own *_REQUIRED 422 (the house PATCH pattern).
_REQUIRED_FIELDS: tuple[tuple[str, str], ...] = (
    ("name", "NAME_REQUIRED"),
    ("amount_minor", "AMOUNT_REQUIRED"),
    ("kind", "KIND_REQUIRED"),
    ("currency", "CURRENCY_REQUIRED"),
    ("interval_unit", "INTERVAL_UNIT_REQUIRED"),
    ("paused", "PAUSED_REQUIRED"),
)


def _today() -> date:
    return datetime.now(UTC).date()


async def _load_own(
    session: AsyncSession, template_id: uuid.UUID, user_id: uuid.UUID
) -> RecurringTemplate:
    """user_id-scoped load; foreign/missing → one 404 code path (no-oracle)."""
    template = await session.scalar(
        select(RecurringTemplate).where(
            RecurringTemplate.id == template_id,
            RecurringTemplate.user_id == user_id,
        )
    )
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="RECURRING_TEMPLATE_NOT_FOUND",
        )
    return template


async def _validate_category(
    session: AsyncSession, category_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """Body category-ref policy, identical to the transactions router's.

    load_visible → None ⇒ 422 CATEGORY_NOT_FOUND (foreign == missing, one code
    path); a visible-but-archived target ⇒ 422 CATEGORY_ARCHIVED. Order preserves
    the existence oracle: a foreign archived category is CATEGORY_NOT_FOUND.
    """
    category = await load_visible_category(session, category_id, user_id)
    if category is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CATEGORY_NOT_FOUND",
        )
    if category.archived:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CATEGORY_ARCHIVED",
        )


def _next_due_on(template: RecurringTemplate, *, today: date) -> date | None:
    """The next date the job will book, or null when there is none (D10/OQ-1).

    Floored at today: the watermark may lag (the server was down, or the template
    was created before its own due date passed), and rendering that arrears date
    as "next" would be a claim about the past. ``max(watermark, today - 1)`` makes
    the answer exactly "the first due date on or after today".
    """
    if template.paused:
        return None
    floor = max(template.last_materialized_on, today - timedelta(days=1))
    upcoming = next_due(
        RecurrenceUnit(template.interval_unit),
        day_of_month=template.day_of_month,
        weekday=template.weekday,
        after=floor,
    )
    if template.end_date is not None and upcoming > template.end_date:
        return None
    return upcoming


def _serialize(template: RecurringTemplate, *, today: date) -> RecurringTemplateRead:
    return RecurringTemplateRead(
        id=template.id,
        name=template.name,
        amount_minor=template.amount_minor,
        kind=TransactionKind(template.kind),
        currency=template.currency,
        category_id=template.category_id,
        merchant=template.merchant,
        note=template.note,
        interval_unit=RecurrenceUnit(template.interval_unit),
        day_of_month=template.day_of_month,
        weekday=template.weekday,
        end_date=template.end_date,
        paused=template.paused,
        next_due_on=_next_due_on(template, today=today),
        created_at=template.created_at,
    )


@router.post(
    "",
    response_model=RecurringTemplateRead,
    status_code=status.HTTP_201_CREATED,
    responses=_UNPROCESSABLE,
)
async def create_template(
    payload: RecurringTemplateCreate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> RecurringTemplateRead:
    if payload.category_id is not None:
        await _validate_category(session, payload.category_id, user.id)
    # Read-only base read (never self-heals a profiles row): the currency is a
    # stamp taken once, and a template is machinery — it is not the place to
    # start writing profile rows nobody asked for.
    base = await read_base_currency(session, user.id)
    today = _today()
    template = RecurringTemplate(
        user_id=user.id,
        name=payload.name,
        amount_minor=payload.amount_minor,
        kind=payload.kind.value,
        currency=payload.currency or base,
        category_id=payload.category_id,
        merchant=payload.merchant,
        note=payload.note,
        interval_unit=payload.interval_unit.value,
        day_of_month=payload.day_of_month,
        weekday=payload.weekday,
        end_date=payload.end_date,
        paused=payload.paused,
        # D2/D6: yesterday, so a template created ON its own due day still has
        # that day ahead of the watermark and the next run books it.
        last_materialized_on=today - timedelta(days=1),
    )
    session.add(template)
    await session.commit()
    await session.refresh(template)
    return _serialize(template, today=today)


@router.get("", response_model=RecurringTemplateList)
async def list_templates(
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> RecurringTemplateList:
    """Every template the user owns — paused and ended ones included.

    This list IS the management screen: a paused template is exactly what the
    user came to resume, and an ended one is what they came to delete. Filtering
    either out would hide the row from the only place it can be acted on.
    """
    today = _today()
    rows = (
        await session.scalars(
            select(RecurringTemplate)
            .where(RecurringTemplate.user_id == user.id)
            .order_by(RecurringTemplate.created_at, RecurringTemplate.id)
        )
    ).all()
    return RecurringTemplateList(items=[_serialize(row, today=today) for row in rows])


@router.patch(
    "/{template_id}",
    response_model=RecurringTemplateRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def update_template(
    template_id: uuid.UUID,
    payload: RecurringTemplateUpdate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> RecurringTemplateRead:
    template = await _load_own(session, template_id, user.id)
    fields = payload.model_fields_set

    for field, code in _REQUIRED_FIELDS:
        if field in fields and getattr(payload, field) is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=code
            )

    # The pair this PATCH will LEAVE BEHIND (the eff_cur pattern from the tx
    # PATCH): half payload, half stored row, so a unit switch and its new anchor
    # are judged together instead of half-applied.
    eff_unit = (
        payload.interval_unit
        if "interval_unit" in fields
        else RecurrenceUnit(template.interval_unit)
    )
    assert eff_unit is not None  # 422-guarded above (INTERVAL_UNIT_REQUIRED)
    eff_dom = (
        payload.day_of_month if "day_of_month" in fields else template.day_of_month
    )
    eff_weekday = payload.weekday if "weekday" in fields else template.weekday
    if eff_unit is RecurrenceUnit.month:
        if eff_dom is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="ANCHOR_REQUIRED",
            )
        if "weekday" in fields and payload.weekday is not None:
            # Explicitly sent and unusable: silently discarding it is what the
            # model_fields_set discipline exists to avoid (R1(5)).
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="ANCHOR_MISMATCH",
            )
        # A merely STORED stale weekday (left over from a week→month switch) is
        # cleared server-side — nothing the client sent is being thrown away, and
        # the DB CHECK would reject the pair anyway.
        eff_weekday = None
    else:
        if eff_weekday is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="ANCHOR_REQUIRED",
            )
        if "day_of_month" in fields and payload.day_of_month is not None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="ANCHOR_MISMATCH",
            )
        eff_dom = None

    # Validated only when in the field set AND non-null (the transactions rule):
    # an amount-only edit of a template whose category was archived after the
    # fact must still succeed; an explicit null clears to uncategorized.
    if "category_id" in fields and payload.category_id is not None:
        await _validate_category(session, payload.category_id, user.id)

    if "name" in fields:
        assert payload.name is not None  # 422-guarded above
        template.name = payload.name
    if "amount_minor" in fields:
        assert payload.amount_minor is not None  # 422-guarded above
        template.amount_minor = payload.amount_minor
    if "kind" in fields:
        assert payload.kind is not None  # 422-guarded above
        template.kind = payload.kind.value
    if "currency" in fields:
        assert payload.currency is not None  # 422-guarded above
        template.currency = payload.currency
    if "category_id" in fields:
        template.category_id = payload.category_id  # explicit null clears
    if "merchant" in fields:
        template.merchant = payload.merchant  # null/"" clears (validator normalized)
    if "note" in fields:
        template.note = payload.note  # null/"" clears (validator normalized)
    if "end_date" in fields:
        template.end_date = payload.end_date  # explicit null clears
    template.interval_unit = eff_unit.value
    template.day_of_month = eff_dom
    template.weekday = eff_weekday

    today = _today()
    if "paused" in fields:
        assert payload.paused is not None  # 422-guarded above
        # SL-A: a TRANSITION, not the mere presence of `paused: false`. The web
        # edit form sends the current value on every save, and treating that as
        # an unpause would silently swallow every pending catch-up date.
        if template.paused and not payload.paused:
            template.last_materialized_on = max(
                template.last_materialized_on, today - timedelta(days=1)
            )
        template.paused = payload.paused

    await session.commit()
    await session.refresh(template)
    return _serialize(template, today=today)


@router.delete(
    "/{template_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=_NOT_FOUND,
)
async def delete_template(
    template_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> None:
    # Hard delete (D7/SL-C): already-materialized transactions keep every money
    # field and lose only their attribution, via the FK's ON DELETE SET NULL.
    template = await _load_own(session, template_id, user.id)
    await session.delete(template)
    await session.commit()
