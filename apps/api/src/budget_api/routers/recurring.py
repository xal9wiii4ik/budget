"""Recurring template CRUD — the standing orders the materializer books (D2/D10).

This router owns the template rows only; it NEVER books a transaction. A template
created on its own due day materializes at the next run of
``services/recurring_jobs.materialize_due`` (OQ-6), which is why every write here
is really a statement about the ``last_materialized_on`` watermark:

* **create** stamps ``start_date - 1 day`` when the payload names a first-charge
  date and ``today - 1 day`` when it does not (A1/A2), so a template created on
  its own due day still has that day ahead of the watermark and the next run
  books it (D2/D6), while a future-start one stays invisible to the job until
  its own start;
* **unpause** (a true→false TRANSITION only) raises the watermark to
  ``max(watermark, today - 1 day)`` (SL-A): the unpause DAY is live, everything
  strictly before it stays skipped forever, and a same-day pause/unpause cycle
  cannot rewind the watermark into re-materializing a date that was already
  booked. A PATCH that merely carries ``paused: false`` on a template that is not
  paused — which the web edit form sends on every save — touches the watermark
  not at all, so pending catch-up dates survive an edit;
* **pause** (false→true) never touches it;
* a **start_date PATCH** re-seeds it exactly (``start_date - 1``), but only
  forwards: a value at or below ``min(watermark, today)`` is refused with 422
  ``START_DATE_TOO_EARLY`` instead of being clamped, because a rewind into the
  already-booked region could only either re-book settled days or echo a date
  that had no effect (A3/A4). An explicit null clears the column and lands the
  watermark on ``min(watermark, today)``, releasing an un-booked future seed
  without reopening a day that was already booked;
* an **account move** (B3) is the one write that says nothing about the schedule:
  it restamps ``currency`` from the target account (§4 — the stamp follows the
  account) and leaves the watermark alone, so pending catch-up dates survive it.
  A move ACROSS currencies must carry ``amount_minor`` in the same PATCH (422
  ``AMOUNT_REQUIRED_ON_CURRENCY_CHANGE``): the stored amount is minor units OF
  the old stamp, so restamping alone would silently redefine the sum the job
  books every period.

``GET /upcoming`` is the one read here that is not about a template row: it lists
the CHARGES the live templates still owe inside a bounded window, over the same
floor+end-clamp definition ``next_due_on`` uses (``domain.recurrence.
upcoming_due_dates``, B4), so the date a template promises and the dates the
widget lists can never disagree. It is strictly read-only — the watermark is
read, never written, so polling the widget can neither book nor skip a charge.

No-oracle: the template path id resolves foreign and missing alike to 404
``RECURRING_TEMPLATE_NOT_FOUND`` (``_load_own``, one code path). A *body*
``category_id`` follows the transactions rule instead — 422 ``CATEGORY_NOT_FOUND``
/ ``CATEGORY_ARCHIVED`` — because the addressed resource is fine and the body is
what is wrong.

The unit/anchor pair is validated in two places for one reason: on create the
payload alone decides (a plain Pydantic 422 from ``schemas/recurring.py``), while
on PATCH the effective pair is half payload and half stored row, so it needs the
``ANCHOR_REQUIRED`` / ``ANCHOR_MISMATCH`` business codes here (R1(5)). The
start/end pair is checked HERE on both verbs instead (A7): create judges its own
payload, PATCH the effective pair, and the deliberate duplication buys one
response shape — ``START_DATE_AFTER_END_DATE`` as a string code — whichever verb
answered, so the web maps one code to one field.

DELETE is hard (D7/SL-C): the materialized transactions survive with
``recurring_template_id`` set to NULL by the FK, so the money history is intact
and only the attribution is gone. ``paused`` is the "stop but keep" affordance.
"""

import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.account_access import load_own_account
from budget_api.category_access import load_visible_category
from budget_api.db import get_session
from budget_api.domain.recurrence import upcoming_due_dates
from budget_api.enums import DEPOSIT_ACCOUNT_TYPE, RecurrenceUnit, TransactionKind
from budget_api.mcp import prose
from budget_api.mcp.decorator import mcp_tool
from budget_api.models import Account, RecurringTemplate, User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.recurring import (
    RecurringError,
    RecurringTemplateCreate,
    RecurringTemplateList,
    RecurringTemplateRead,
    RecurringTemplateUpdate,
    UpcomingChargeList,
    UpcomingChargeRead,
)
from budget_api.services.recurring_reads import read_upcoming_charges

router = APIRouter()

# Mirrors routers/goals.py: stable UPPER_SNAKE codes carried in {"detail": ...}.
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": RecurringError}
}
# The honest anyOf union (receipts V2/AM-5): business codes (RecurringError) AND
# FastAPI's auto Pydantic array (HTTPValidationError) both occur at runtime —
# create-side anchor rejections are the latter, PATCH-side ones the former. Since
# A7 both arms are live on both verbs: ``START_DATE_TOO_EARLY`` and
# ``START_DATE_AFTER_END_DATE`` are router codes on create AND PATCH, while the
# ``start_date`` ceiling rejects from the schema on both.
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
    ("account_id", "ACCOUNT_REQUIRED"),
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


def _reject_transfer_kind(kind: TransactionKind | None) -> None:
    """422 on ``kind=transfer`` (architecture §7 / plan C-2). Pure payload check.

    A standing transfer needs a second account and a second amount on the template
    plus a transfer branch in the materializer, and v1 ships neither — the template
    CHECK is still ``('expense','income')`` (C-1). The schema keeps typing this
    field as ``TransactionKind`` on purpose: a narrower enum would rename the
    contract component every client already generates against, so the value is
    representable on the wire and refused HERE, with a code, instead of reaching the
    DB CHECK as a 500.
    """
    if kind is TransactionKind.transfer:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="RECURRING_TRANSFER_UNSUPPORTED",
        )


def _next_due_on(template: RecurringTemplate, *, today: date) -> date | None:
    """The next date the job will book, or null when there is none (D10/OQ-1).

    The floor (``max(watermark, today - 1)``) and the inclusive ``end_date`` clamp
    live in ``upcoming_due_dates`` — the ONE definition of "still ahead" (B4), so
    this field and ``GET /upcoming`` cannot drift apart. Asking for a single
    unbounded date is exactly what the widget asks for over a window.

    ``paused`` stays HERE rather than in the domain helper: it is a fact about the
    template, not about date math.
    """
    if template.paused:
        return None
    upcoming = upcoming_due_dates(
        RecurrenceUnit(template.interval_unit),
        day_of_month=template.day_of_month,
        weekday=template.weekday,
        watermark=template.last_materialized_on,
        today=today,
        end_date=template.end_date,
        through=None,
        limit=1,
    )
    return upcoming[0] if upcoming else None


async def _require_own_account(
    session: AsyncSession, account_id: uuid.UUID, user_id: uuid.UUID
) -> Account:
    """Body account-ref policy, identical to the transactions router's.

    Foreign == missing == one 404 ACCOUNT_NOT_FOUND (no-oracle, one code path);
    a visible-but-archived account is 422 ACCOUNT_ARCHIVED, checked strictly
    after — a foreign archived account must never answer ARCHIVED.
    """
    account = await load_own_account(session, account_id, user_id)
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="ACCOUNT_NOT_FOUND"
        )
    if account.archived:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="ACCOUNT_ARCHIVED"
        )
    if account.type == DEPOSIT_ACCOUNT_TYPE:
        # Unconditional, unlike the transactions router's twin: a template's kind
        # is expense|income and never transfer (§7), so EVERY row this template
        # would ever materialize is one a deposit account refuses. Checked here
        # rather than at each call site, so create and the PATCH move are covered
        # by one rule.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="DEPOSIT_ACCOUNT_TRANSFER_ONLY",
        )
    return account


def _serialize(template: RecurringTemplate, *, today: date) -> RecurringTemplateRead:
    return RecurringTemplateRead(
        id=template.id,
        name=template.name,
        amount_minor=template.amount_minor,
        kind=TransactionKind(template.kind),
        account_id=template.account_id,
        currency=template.currency,
        category_id=template.category_id,
        merchant=template.merchant,
        note=template.note,
        interval_unit=RecurrenceUnit(template.interval_unit),
        day_of_month=template.day_of_month,
        weekday=template.weekday,
        start_date=template.start_date,
        end_date=template.end_date,
        paused=template.paused,
        next_due_on=_next_due_on(template, today=today),
        created_at=template.created_at,
    )


@router.post(
    "",
    response_model=RecurringTemplateRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
@mcp_tool(
    name="create_recurring",
    description=(
        "Create ONE recurring template — a schedule (rent, salary, a subscription), "
        "NOT a transaction: the server posts the actual transactions when they fall "
        "due, so do not also call create_transaction for them. A monthly template "
        "needs `day_of_month`, a weekly one needs `weekday`. Amounts are INTEGER "
        "MINOR UNITS — never do money math yourself."
    ),
    params={
        "name": 'What the user calls this payment, e.g. "Rent".',
        "amount_minor": prose.MINOR_UNITS,
        "currency": prose.CURRENCY_IN,
        "kind": "Whether each generated transaction is an expense or income.",
        "interval_unit": "How often it repeats: every month or every week.",
        "day_of_month": (
            "Day of the month (1-31), required for a monthly template. A month that "
            "is shorter uses its last day."
        ),
        "weekday": "Day of the week for a weekly template: 0 is Monday, 6 is Sunday.",
        "category_id": prose.CATEGORY_ID,
        "merchant": "Who is paid, as the user named them.",
        "note": "Free-text note carried onto each generated transaction.",
        "end_date": (
            "Last date the template may generate, as YYYY-MM-DD. Omit for open-ended."
        ),
        "paused": "true creates it paused — it generates nothing until resumed.",
    },
)
async def create_template(
    payload: RecurringTemplateCreate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> RecurringTemplateRead:
    # Before the account lookup: a payload the API cannot express at all is refused
    # without touching the DB, and the answer is the same whatever the ids point at
    # (so this can never become an account-existence oracle).
    _reject_transfer_kind(payload.kind)
    # Same reasoning, same place: the date pair is decided by the payload alone.
    today = _today()
    if payload.start_date is not None:
        if payload.start_date < today:
            # Refused, never clamped (A3): a clamp would echo a first-charge date
            # the template does not honour, and honouring it would book rows into
            # the past, silently moving balances, stats, limits and goals with no
            # preview and no undo. `== today` is valid — it books today on the
            # next run, exactly like an omitted start_date does.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="START_DATE_TOO_EARLY",
            )
        if payload.end_date is not None and payload.start_date > payload.end_date:
            # Strictly after, so start == end is fine: a template that starts and
            # ends on the same day is a one-off charge, not a mistake. Raised from
            # the router rather than a schema validator (A7) so that this verb and
            # PATCH answer with the same string code in the same shape.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="START_DATE_AFTER_END_DATE",
            )
    account = await _require_own_account(session, payload.account_id, user.id)
    if payload.category_id is not None:
        await _validate_category(session, payload.category_id, user.id)
    if payload.currency is not None and payload.currency != account.currency:
        # Architecture §4: the account decides the currency of every row this
        # template will book, so a template that disagreed with its own account
        # would materialize money into a balance it does not belong to.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="ACCOUNT_CURRENCY_MISMATCH",
        )
    template = RecurringTemplate(
        user_id=user.id,
        account_id=account.id,
        name=payload.name,
        amount_minor=payload.amount_minor,
        kind=payload.kind.value,
        currency=account.currency,
        category_id=payload.category_id,
        merchant=payload.merchant,
        note=payload.note,
        interval_unit=payload.interval_unit.value,
        day_of_month=payload.day_of_month,
        weekday=payload.weekday,
        start_date=payload.start_date,
        end_date=payload.end_date,
        paused=payload.paused,
        # A2/D2/D6: the day BEFORE the first date this template may book. With a
        # named start that is `start - 1`, so `_due_template_ids` skips the row
        # entirely until the start arrives; without one it is yesterday, so a
        # template created ON its own due day still has that day ahead of the
        # watermark and the next run books it. No max() is needed — the gate above
        # already refused anything below today.
        last_materialized_on=(
            (payload.start_date - timedelta(days=1))
            if payload.start_date is not None
            else today - timedelta(days=1)
        ),
    )
    session.add(template)
    await session.commit()
    await session.refresh(template)
    return _serialize(template, today=today)


@router.get("", response_model=RecurringTemplateList)
@mcp_tool(
    name="list_recurring",
    description=(
        "List recurring payment templates (rent, subscriptions) with their schedule, "
        "next due date and paused state. This is where every `template_id` comes "
        "from."
    ),
)
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


@router.get("/upcoming", response_model=UpcomingChargeList)
@mcp_tool(
    name="list_upcoming_recurring",
    description=(
        "The charges the recurring templates still OWE — money that has not moved "
        "yet. Nothing here has happened: a charge that was already posted (even "
        "earlier today) is gone from this list and is a real transaction, so look "
        'for it with list_transactions instead. Use it to answer "what is about to '
        'hit my accounts", never to report spending. Amounts are INTEGER MINOR UNITS '
        "of each row's OWN currency (12.34 EUR is 1234; JPY has no minor unit, so "
        "500 JPY is 500) — do not add up rows of different currencies, and do not "
        "convert them yourself. Paused templates owe nothing and are absent."
    ),
    params={
        "days": (
            "How far ahead to look, in days from today (1-90, default 30) — this is "
            "the ONLY thing that decides how much of the future is listed, so a "
            "missing charge usually just falls outside the window."
        ),
    },
)
async def list_upcoming(
    user: User = Depends(current_user_jwt_or_pat),
    days: int = Query(default=30, ge=1, le=90),
    session: AsyncSession = Depends(get_session),
) -> UpcomingChargeList:
    """Every charge the live templates still owe in the next ``days`` days (B1-B5).

    Declared BEFORE the parameterized routes below (the /transactions/summary
    landmine): after them, "upcoming" would be parsed as a template id and 422.

    The set is exactly "not yet materialized AND due today or later" — the shared
    floor of ``upcoming_due_dates`` says so: a template already booked through
    today carries ``watermark == today`` and drops today's row on its own, while a
    template that is due today and has not run yet keeps it. A template in arrears
    contributes only its FUTURE dates, never the pending past ones (the same rule
    ``next_due_on`` renders). Future-start templates ride in for free — their
    watermark IS ``start - 1``.

    Strictly READ-ONLY: this route never writes the watermark, so polling it can
    neither book nor skip a charge. Paused templates are excluded (nothing is
    owed); a template whose ACCOUNT was archived after the fact is NOT — the
    materializer still books it (B2/MINOR-1), and hiding it would make the widget
    lie about money that is going to move.

    No business 422 of its own — ``days`` is a bounded Query, so the automatic
    ``HTTPValidationError`` is the only honest 422 arm (the ``stats_monthly``
    precedent) and no ``responses`` override is declared.
    """
    today = _today()
    charges = await read_upcoming_charges(
        session, user.id, today=today, through=today + timedelta(days=days)
    )
    return UpcomingChargeList(
        items=[
            UpcomingChargeRead(
                template_id=charge.template_id,
                name=charge.name,
                amount_minor=charge.amount_minor,
                currency=charge.currency,
                kind=charge.kind,
                due_on=charge.due_on,
                account_id=charge.account_id,
                category_id=charge.category_id,
            )
            for charge in charges
        ]
    )


@router.patch(
    "/{template_id}",
    response_model=RecurringTemplateRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
@mcp_tool(
    name="update_recurring",
    description=(
        "Change ONE recurring template. Send only the fields that change; omitted "
        "fields keep their value. Set `paused` to true to stop a subscription "
        "without losing its history — that is the intended way to end one, there is "
        "no delete tool here. Take template_id from list_recurring, never guess it. "
        "Amounts are INTEGER MINOR UNITS."
    ),
    params={
        "template_id": "Template id from list_recurring.",
        "name": "New name.",
        "amount_minor": prose.MINOR_UNITS,
        "currency": prose.CURRENCY_IN,
        "kind": "Change between expense and income.",
        "interval_unit": (
            "Switch between monthly and weekly; send the matching `day_of_month` or "
            "`weekday` in the same call."
        ),
        "day_of_month": "New day of the month (1-31) for a monthly template.",
        "weekday": (
            "New day of the week for a weekly template: 0 is Monday, 6 is Sunday."
        ),
        "category_id": prose.CATEGORY_ID,
        "merchant": "New merchant name.",
        "note": ("New note. " + prose.KEEP),
        "end_date": "New end date as YYYY-MM-DD.",
        "paused": "true pauses generation, false resumes it.",
    },
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

    # PATCH can rewrite `kind`, so the create-side refusal has to exist here too —
    # otherwise an expense template could be morphed into the transfer the CHECK
    # forbids and the commit would 500.
    _reject_transfer_kind(payload.kind)

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

    # The start/end pair this PATCH will LEAVE BEHIND — the same eff_* reading as
    # the anchor pair above, and for the same reason: a start-only payload is
    # judged against the STORED end_date, which a payload-only validator waves
    # through. Placed with the other payload+stored gates, before the account
    # load, so it can never become an account-existence oracle.
    eff_start = payload.start_date if "start_date" in fields else template.start_date
    eff_end = payload.end_date if "end_date" in fields else template.end_date
    if eff_start is not None and eff_end is not None and eff_start > eff_end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="START_DATE_AFTER_END_DATE",
        )

    # The account move (B3), by the transactions-PATCH precedent. Deliberately
    # after every gate that the payload alone decides: a payload the API cannot
    # express is refused identically whatever `account_id` points at, so this can
    # never become an account-existence oracle. `_require_own_account` owns both
    # refusals — foreign == missing == 404 ACCOUNT_NOT_FOUND, archived == 422
    # ACCOUNT_ARCHIVED. An account that is merely STORED on the template is NOT
    # re-validated: archiving an account must not freeze the name of every
    # template already booking onto it (B2/MINOR-1 — the materializer keeps going).
    account: Account | None = None
    if "account_id" in fields:
        assert payload.account_id is not None  # 422-guarded above (ACCOUNT_REQUIRED)
        account = await _require_own_account(session, payload.account_id, user.id)

    # A move ACROSS currencies must restate the amount (scope-QA amendment to B3).
    # ``amount_minor`` is an integer in the minor units of the template's stamp, and
    # the move restamps that from the target account: 25_000 on a USD template would
    # silently become ¥25 000 — a different sum, which the materializer then books
    # every period. The server cannot convert it for the client (that would mean
    # inventing an FX date and a rounding policy for a FUTURE booking), so it
    # refuses instead of assuming. Deliberately BEFORE the ``currency``-echo gate
    # below: this refusal reads only the move itself (stored stamp vs target
    # account), so "moved across currencies without an amount" answers with ONE
    # code whether or not the payload also carried a stale ``currency`` echo — the
    # client has to restate the amount either way, and learning that first is
    # strictly more useful than being told about the echo. An explicit
    # ``amount_minor: null`` never gets here (AMOUNT_REQUIRED above), so membership
    # in ``fields`` means a real value.
    if (
        account is not None
        and account.currency != template.currency
        and "amount_minor" not in fields
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="AMOUNT_REQUIRED_ON_CURRENCY_CHANGE",
        )

    # The currency this PATCH will LEAVE BEHIND (the eff_cur pattern from the tx
    # PATCH): the stamp follows the ACCOUNT (§4), so on a move the only acceptable
    # `currency` echo is the TARGET account's. "New account + the old currency" is
    # therefore refused whole, instead of moving the template and half-applying a
    # currency that no longer matches its account.
    eff_cur = account.currency if account is not None else template.currency
    if "currency" in fields and payload.currency != eff_cur:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="ACCOUNT_CURRENCY_MISMATCH",
        )

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
    # `currency` is never written FROM THE PAYLOAD: it is a stamp of the template's
    # account (§4), so it changes only when the account does, and a sent value that
    # disagreed with the effective account was already refused above.
    if account is not None:
        template.account_id = account.id
        # Restamp (§4/OQ-1). Safe to do unconditionally: a restamp that changes the
        # currency was only allowed through with an `amount_minor` in the same
        # PATCH, already written above.
        template.currency = account.currency
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
    if "start_date" in fields:
        # The booked region is always at or below `min(watermark, today)`: the job
        # books only dates <= its run date and advances the watermark exactly to
        # the last date it booked. So that floor is the line the watermark may not
        # be moved back across.
        floor = min(template.last_materialized_on, today)
        if payload.start_date is None:
            # Clearing releases an un-booked FUTURE seed (a mistyped start date is
            # cancellable) without reopening a day already booked: `min` takes
            # today in the first case and the watermark in the second.
            template.start_date = None
            template.last_materialized_on = floor
        elif payload.start_date <= floor:
            # A3/A4: refused, not clamped. Below the floor the only two outcomes
            # are re-booking settled days or echoing a date with no effect.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="START_DATE_TOO_EARLY",
            )
        else:
            # An EXACT assignment is safe only because of the guard above:
            # `start_date > floor` ⇒ `start_date - 1 >= floor`, so the watermark
            # never crosses back over an already-booked day. Moving forward on a
            # lagging template only SKIPS pending arrears — dates the API never
            # rendered as upcoming anyway — and can never create a new booking.
            template.start_date = payload.start_date
            template.last_materialized_on = payload.start_date - timedelta(days=1)

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
