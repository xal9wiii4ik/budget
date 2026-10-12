"""Debts — "who owes me" and "what I owe", over the ``debts`` table and the ledger.

The two authorization pillars of every data router here (categories.py, §3): reads
filter ``user_id = me``, writes force it and never read ownership from the body.
No-oracle at BOTH levels: a foreign debt id and a missing one resolve through
``load_own_debt`` to ONE ``404 DEBT_NOT_FOUND``, and a repayment id that belongs
to another debt, to another user, or to nothing resolves through
``load_own_repayment`` to the very same answer (the ``IMPORT_NOT_FOUND``
precedent).

**Where the money is.** A debt stores none. Its opening amount IS a transaction
(``debt_role='principal'``) and every partial repayment is another one, so the
account balance moves exactly as the bank statement says it did — while
``services/tx_totals.py`` keeps those rows out of every income/expense aggregate
by ``debt_id IS NULL``. Lending money is not spending it (task.md §3), and that
is the whole point of representing a movement this way instead of inventing a
fourth kind or a second ledger.

**What this router does NOT contain.** The money rules live in
``services/debt_writes.py`` — the row lock, the overpayment refusals, the
currency-pair rule and the kind stamping — because they must hold for every
writer, and a service has no status code to raise: it raises ``DebtWriteError``
and the single ``except`` of each write route turns the code into a 422. The
computed figures live in ``services/debt_reads.py``; the arithmetic itself in
``domain/debts.py``. What is left here is routing: dependencies, status codes and
the guard ORDER.

**Deleting a debt is a REAL delete** (architecture §"Delete a whole debt"):
``transactions.debt_id`` is ``ON DELETE CASCADE``, so the movements go and the
balances revert in the same statement. Accounts and deposits are archive-only
because they are LEDGERS other rows point at; a debt owns a handful of leaf rows,
nothing points at it, and "wrong person / wrong direction" is a mistype whose
honest fix is delete-and-redo — which is also why ``direction`` and ``currency``
are immutable.

Editing or deleting a debt movement through ``/transactions`` is refused there
with 422 ``DEBT_MOVEMENT_READONLY``: every field of such a row is derived from its
debt, so the only writer that may touch it is this one.
"""

import logging
import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.db import get_session
from budget_api.debt_access import load_own_debt, load_own_repayment
from budget_api.enums import DebtDirection, DebtRole
from budget_api.mcp.decorator import mcp_tool
from budget_api.models import Account, Debt, Transaction, User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.debt import (
    DebtCreate,
    DebtDetailRead,
    DebtError,
    DebtList,
    DebtRead,
    DebtRepaymentCreate,
    DebtRepaymentRead,
    DebtRepaymentUpdate,
    DebtSummaryRead,
    DebtUpdate,
)
from budget_api.services.debt_reads import (
    DebtView,
    debt_repayments,
    debt_summary,
    debt_views,
)
from budget_api.services.debt_writes import (
    DebtWriteError,
    add_repayment,
    check_due_on,
    create_debt,
    update_movement,
)
from budget_api.services.tx_idempotency import load_by_client_id
from budget_api.transaction_guards import (
    reject_archived,
    reject_deposit_spending,
    require_own_account,
)

router = APIRouter()

logger = logging.getLogger(__name__)

#: Shared by more than one tool of THIS router (architecture §2.5: prose common to
#: two handlers of one router is a module constant here, not a line in
#: mcp/prose.py). These four sentences carry the one thing a model must not get
#: wrong about debts — which of the two currencies each amount is in.
_DEBT_ID = "Debt id from list_debts — never guess or invent one."
_DEBT_AMOUNT = (
    "Amount in INTEGER MINOR UNITS of the DEBT's own `currency` (12.34 EUR is "
    "1234; JPY has no minor unit, so 500 JPY is 500) — the amount the person "
    "counts as lent or repaid. Never scale or convert it yourself and never do the "
    "remaining-balance arithmetic: the server returns `remaining_minor`."
)
_ACCOUNT_AMOUNT = (
    "What actually moved on the account, in INTEGER MINOR UNITS of THAT ACCOUNT's "
    "currency. Send it ONLY when the account is denominated in a different "
    "currency than the debt, and then it is REQUIRED: the real rate is the user's "
    "fact and the server never invents one (ask the user, or use convert_currency "
    "and say that is what you did). When the account and the debt share a "
    "currency, omit it — the server copies the amount, and a different value is "
    "rejected."
)
_MOVEMENT_ACCOUNT = (
    "Account id from list_accounts — never guess one. This is the account the "
    "money really moved on, so the balance changes; the operation is still left "
    "out of every income and expense total, because lending is not spending."
)

# Mirrors routers/deposits.py: every HTTPException.detail below is a stable
# UPPER_SNAKE code carried in {"detail": ...} (the DebtError shape).
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": DebtError}
}
# The honest anyOf union (AM-5): these routes emit BOTH our business codes and
# FastAPI's auto Pydantic array at runtime. HTTPValidationError is referenced,
# never hand-declared — declaring it would mangle the generated component name.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/DebtError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}
#: A replay of a create that already landed (the B-1 ``client_id`` mechanism,
#: shared with ``POST /transactions``): the STORED debt, nothing created. Declared
#: so the contract — and the generated client — carry both success arms honestly.
_IDEMPOTENT_REPLAY: dict[int | str, dict[str, object]] = {
    status.HTTP_200_OK: {
        "model": DebtDetailRead,
        "description": "Idempotent replay — the existing debt, not created",
    }
}


def _today() -> date:
    return datetime.now(UTC).date()


def _unprocessable(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=code)


def _not_found() -> HTTPException:
    """The ONE 404 of this router — foreign and missing share it, at both levels."""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="DEBT_NOT_FOUND")


def _read(view: DebtView) -> DebtRead:
    debt = view.debt
    principal = view.principal
    assert principal.debt_amount_minor is not None  # a debt movement always has it
    return DebtRead(
        id=debt.id,
        direction=DebtDirection(debt.direction),
        counterparty=debt.counterparty,
        currency=debt.currency,
        principal_minor=view.totals.principal_minor,
        repaid_minor=view.totals.repaid_minor,
        remaining_minor=view.remaining_minor,
        status=view.status,
        closed_on=view.closed_on,
        # From the principal MOVEMENT, always: the debts table has no date and no
        # account of its own, so the two can never disagree with the ledger.
        opened_on=principal.occurred_at,
        account_id=principal.account_id,
        account_currency=principal.currency,
        account_amount_minor=principal.amount_minor,
        due_on=debt.due_on,
        note=debt.note,
        repayments_count=view.totals.repayments_count,
        created_at=debt.created_at,
    )


def _repayment(row: Transaction) -> DebtRepaymentRead:
    assert row.debt_amount_minor is not None  # a debt movement always has it
    return DebtRepaymentRead(
        id=row.id,
        occurred_at=row.occurred_at,
        account_id=row.account_id,
        account_currency=row.currency,
        account_amount_minor=row.amount_minor,
        amount_minor=row.debt_amount_minor,
        note=row.note,
        created_at=row.created_at,
    )


async def _detail(
    session: AsyncSession, user_id: uuid.UUID, debt_id: uuid.UUID
) -> DebtDetailRead:
    """One debt through the SAME assembler the list uses, plus its history.

    Re-read from the database rather than assembled from the objects a write just
    touched: ``remaining`` is a grouped query, so reading it back is what makes a
    write response and the next GET agree by construction.
    """
    views = await debt_views(session, user_id, debt_id=debt_id)
    if not views:
        # Only reachable if the debt lost its principal movement, which no code
        # path can do (the /transactions guards refuse it and the statement
        # replace spares it) — answered as the router's ordinary 404 rather than
        # crashing on an empty list.
        raise _not_found()
    rows = await debt_repayments(session, user_id, debt_id)
    return DebtDetailRead(
        **_read(views[0]).model_dump(),
        repayments=[_repayment(row) for row in rows],
    )


async def _movement_account(
    session: AsyncSession, account_id: uuid.UUID, user_id: uuid.UUID
) -> Account:
    """The account a debt movement will be booked on, or the refusal it earns.

    The EXISTING transactions trio, in the order that is load-bearing everywhere
    else: NOT_FOUND strictly before ARCHIVED (a foreign archived account must
    never answer ACCOUNT_ARCHIVED and confirm that it exists), then the deposit
    door — a deposit ledger takes transfers and nothing else, and a debt movement
    is an ordinary expense/income row.
    """
    account = await require_own_account(session, account_id, user_id)
    reject_archived(account)
    reject_deposit_spending(account, is_transfer=False)
    return account


async def _replayed_debt_id(
    session: AsyncSession,
    user_id: uuid.UUID,
    client_id: uuid.UUID | None,
    *,
    expected_debt_id: uuid.UUID | None = None,
) -> uuid.UUID | None:
    """The debt a stored ``client_id`` already belongs to, or None.

    The lookup is the one ``POST /transactions`` uses (one key space, one partial
    unique index). A hit that is NOT a debt movement means the caller reused a key
    it had already spent on an ordinary transaction: the INSERT below could only
    fail on the index, so it is refused up front with a code the client can act on
    rather than surfacing as a 500.

    ``expected_debt_id`` pins the replay to the debt the request ADDRESSES: a key
    already spent on another debt is the same client bug, and answering 200 with
    that other debt's detail would read as "your repayment landed" about money
    that never moved. Same ``CLIENT_ID_IN_USE``. ``POST /debts`` addresses no
    debt, so it passes nothing.
    """
    if client_id is None:
        return None
    existing = await load_by_client_id(session, user_id, client_id)
    if existing is None:
        return None
    if existing.debt_id is None:
        raise _unprocessable("CLIENT_ID_IN_USE")
    if expected_debt_id is not None and existing.debt_id != expected_debt_id:
        raise _unprocessable("CLIENT_ID_IN_USE")
    return existing.debt_id


@router.get("", response_model=DebtList)
@mcp_tool(
    name="list_debts",
    description=(
        "Money the user lent to people and money they borrowed from people — who "
        "owes whom, how much is left and when it is due. `direction` is `lent` "
        "(they owe the user) or `borrowed` (the user owes them), and "
        "`counterparty` is the person as the user named them, not a Budget user. "
        "Every figure is computed by the server in INTEGER MINOR UNITS of that "
        "debt's own `currency`: `principal_minor` is what was originally lent or "
        "borrowed, `repaid_minor` what has been given back so far and "
        "`remaining_minor` what is still owed — never add, subtract or convert "
        "them yourself. `status` is `closed` once nothing is left, with "
        "`closed_on` the date of the last repayment; closed debts ARE included, so "
        "check it before saying someone still owes something. `summary` adds both "
        "sides up in the user's base currency; the two `*_unconverted_count` "
        "fields say how many debts had no exchange rate and were therefore LEFT "
        "OUT of that sum — mention them instead of presenting the total as "
        "complete. This is where every `debt_id` comes from."
    ),
)
async def list_debts(
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> DebtList:
    """The user's debts, newest first, with the base-currency summary.

    CLOSED debts are included and there is no ``status`` filter: a settled debt is
    history the user explicitly asked to be able to look at (task.md §4), and the
    client groups the three states itself. The ``summary`` rides the list rather
    than a second route, so one screen is one round trip and ``list_debts``
    answers "how much am I owed" in a single call.
    """
    views = await debt_views(session, user.id)
    summary = await debt_summary(session, user.id, views, today=_today())
    return DebtList(
        items=[_read(view) for view in views],
        summary=DebtSummaryRead(
            base_currency=summary.base_currency,
            owed_to_me_minor=summary.owed_to_me_minor,
            i_owe_minor=summary.i_owe_minor,
            owed_to_me_unconverted_count=summary.owed_to_me_unconverted_count,
            i_owe_unconverted_count=summary.i_owe_unconverted_count,
        ),
    )


@router.post(
    "",
    response_model=DebtDetailRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_IDEMPOTENT_REPLAY, **_NOT_FOUND, **_UNPROCESSABLE},
)
@mcp_tool(
    name="create_debt",
    description=(
        "Record that the user LENT money to a person (`direction` `lent`) or "
        "BORROWED money from one (`borrowed`). This moves real money on the "
        "account you name — lending debits it, borrowing credits it — but it is "
        "NOT an expense or an income and never appears in any total, which is "
        "exactly why it must be recorded here and NOT with create_transaction. "
        "The debt keeps its own `currency`, and `amount_minor` is always in THAT "
        "currency. BEFORE creating, call list_debts: if the same person and amount "
        "is already there do NOT duplicate it — a partial payback is "
        "record_debt_repayment, a correction is update_debt. One debt per call."
    ),
    params={
        "direction": (
            "`lent` = the user gave the money away and is owed it back; "
            "`borrowed` = the user received money and owes it back. It can NEVER "
            "be changed afterwards — ask the user which way round it is if their "
            "wording is ambiguous."
        ),
        "counterparty": (
            "The person, as the user names them (free text — they are not a Budget "
            "user). Two debts with the same person stay two separate debts."
        ),
        "currency": (
            "The debt's own currency, ISO 4217 uppercase (e.g. USD) — what the two "
            "of them agreed the debt is in. It is IMMUTABLE and may differ from "
            "the account's currency. Take it from what the user said, not from the "
            "account."
        ),
        "amount_minor": _DEBT_AMOUNT,
        "account_id": _MOVEMENT_ACCOUNT,
        "opened_on": "The date the money changed hands, as YYYY-MM-DD.",
        "account_amount_minor": _ACCOUNT_AMOUNT,
        "due_on": (
            "Optional date the money is to be given back by, as YYYY-MM-DD. It "
            "cannot be earlier than `opened_on`. Send it only when the user named "
            "a date; it is what puts the debt in their daily reminder."
        ),
        "note": "Free-text note about this debt, from the user.",
    },
    managed_body={"client_id": "uuid"},
)
async def create_debt_route(
    payload: DebtCreate,
    # Plain parameter, FastAPI mutates the real response object — the
    # routers/health.py precedent for a second declared status on one handler.
    response: Response,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> DebtDetailRead:
    """Record a debt; a repeated ``client_id`` replays instead of duplicating.

    The debt row and its opening movement are written in ONE transaction: a debt
    whose amount is nowhere would be unreadable, and a movement without its debt
    is forbidden by the link CHECKs.
    """
    user_id = user.id
    # Idempotency hit FIRST, ahead of every validation and every write (the
    # POST /transactions rule): a replay must not become a 422 because the account
    # it once used has been archived since, and it creates nothing, so none of the
    # guards below have any business running for it.
    replayed = await _replayed_debt_id(session, user_id, payload.client_id)
    if replayed is not None:
        response.status_code = status.HTTP_200_OK
        return await _detail(session, user_id, replayed)

    account = await _movement_account(session, payload.account_id, user_id)
    try:
        debt, _ = await create_debt(
            session,
            user_id,
            direction=payload.direction,
            counterparty=payload.counterparty,
            currency=payload.currency,
            amount_minor=payload.amount_minor,
            account=account,
            opened_on=payload.opened_on,
            account_amount_minor=payload.account_amount_minor,
            due_on=payload.due_on,
            note=payload.note,
            client_id=payload.client_id,
        )
    except DebtWriteError as exc:
        raise _unprocessable(exc.code) from exc
    debt_id = debt.id
    try:
        await session.commit()
    except IntegrityError:
        # The window between the select-first above and the INSERT is real (a
        # retried tool call, a mobile outbox), and the partial unique index is what
        # closes it. Same shape as POST /transactions: rollback, re-select, and
        # re-raise when the conflict was a different constraint.
        await session.rollback()
        if payload.client_id is None:
            raise
        raced = await _replayed_debt_id(session, user_id, payload.client_id)
        if raced is None:
            raise
        # No amount and no counterparty in the log line: this is plumbing, not
        # ledger data.
        logger.info(
            "idempotent debt replay recovered from insert race user=%s", user_id
        )
        response.status_code = status.HTTP_200_OK
        return await _detail(session, user_id, raced)
    return await _detail(session, user_id, debt_id)


@router.get("/{debt_id}", response_model=DebtDetailRead, responses={**_NOT_FOUND})
@mcp_tool(
    name="get_debt",
    description=(
        "ONE debt in detail, with the same server-computed figures as list_debts "
        "plus every repayment recorded against it, oldest first. Each repayment's "
        "`amount_minor` is in the DEBT's currency and `account_amount_minor` is "
        "what moved on that account — do not add the two together. Take `debt_id` "
        "from list_debts, never guess it."
    ),
    params={"debt_id": _DEBT_ID},
)
async def get_debt(
    debt_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> DebtDetailRead:
    debt = await load_own_debt(session, debt_id, user.id)
    if debt is None:
        raise _not_found()
    return await _detail(session, user.id, debt.id)


@router.patch(
    "/{debt_id}",
    response_model=DebtDetailRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
@mcp_tool(
    name="update_debt",
    description=(
        "Correct ONE existing debt: the person's name, the amount originally lent "
        "or borrowed, the account it moved on, the dates or the note. Send only "
        "what changes; omitted fields keep their value. `direction` and `currency` "
        "are NOT editable — a debt recorded the wrong way round or in the wrong "
        "currency has to be deleted and re-created by the user in the app. "
        "Recording a payback is record_debt_repayment, NOT a smaller amount here: "
        "shrinking the original amount below what has already been repaid is "
        "rejected. Take debt_id from list_debts, never guess it."
    ),
    params={
        "debt_id": _DEBT_ID,
        "counterparty": "The person's name, as the user wants it recorded.",
        "amount_minor": (
            "A CORRECTION of what was originally lent or borrowed — not a payback. "
            + _DEBT_AMOUNT
        ),
        "account_id": (
            "Moves the OPENING movement to another account. "
            + _MOVEMENT_ACCOUNT
            + " Moving it to an account in a different currency requires "
            "`account_amount_minor` in the SAME call."
        ),
        "account_amount_minor": _ACCOUNT_AMOUNT,
        "opened_on": "New date the money changed hands, as YYYY-MM-DD.",
        "due_on": (
            "New date the money is to be given back by, as YYYY-MM-DD. It cannot "
            "be earlier than `opened_on`. There is no way to clear it here."
        ),
        "note": "New note about this debt.",
    },
)
async def update_debt(
    debt_id: uuid.UUID,
    payload: DebtUpdate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> DebtDetailRead:
    """Correct a debt. A CLOSED debt is editable — closed is a state, not a lock.

    Guard order is the house one: load-own → 404 (foreign == missing) before any
    rule, so a stranger's debt can never earn a 422 that confirms it exists.
    """
    debt = await load_own_debt(session, debt_id, user.id)
    if debt is None:
        raise _not_found()
    fields = payload.model_fields_set
    # NOT NULL facts: an explicit null cannot clear them (a bare apply would 500 on
    # IntegrityError or on a CHECK) — refused with the house *_REQUIRED code.
    # ``account_amount_minor`` is NOT one of them: it is optional on the wire and
    # null ≡ omitted, which ``update_movement`` already reads as "recompute"
    # (equal currencies → the server copies, cross-currency with the account
    # unchanged → the stored integer stays).
    for field, code in (
        ("counterparty", "DEBT_COUNTERPARTY_REQUIRED"),
        ("amount_minor", "DEBT_AMOUNT_REQUIRED"),
        ("account_id", "DEBT_ACCOUNT_REQUIRED"),
        ("opened_on", "DEBT_OPENED_ON_REQUIRED"),
    ):
        if field in fields and getattr(payload, field) is None:
            raise _unprocessable(code)

    views = await debt_views(session, user.id, debt_id=debt.id)
    if not views:
        raise _not_found()
    principal = views[0].principal
    account = (
        None
        if payload.account_id is None
        else await _movement_account(session, payload.account_id, user.id)
    )
    # The pair this PATCH will LEAVE BEHIND — moving EITHER date is the same
    # illegal row, so the comparison is on the effective pair (the deposits rule).
    eff_opened_on = (
        payload.opened_on if payload.opened_on is not None else principal.occurred_at
    )
    eff_due_on = payload.due_on if "due_on" in fields else debt.due_on
    try:
        check_due_on(eff_opened_on, eff_due_on)
        if fields & {"amount_minor", "account_id", "account_amount_minor", "opened_on"}:
            await update_movement(
                session,
                user.id,
                debt,
                principal,
                role=DebtRole.principal,
                amount_minor=payload.amount_minor,
                account=account,
                occurred_at=payload.opened_on,
                account_amount_minor=payload.account_amount_minor,
                # The note belongs to the DEBT, not to its opening movement, so
                # the movement's own note is never written from here.
                note=None,
                note_sent=False,
            )
    except DebtWriteError as exc:
        raise _unprocessable(exc.code) from exc

    if payload.counterparty is not None:
        debt.counterparty = payload.counterparty
    if "due_on" in fields:
        debt.due_on = payload.due_on  # explicit null clears the reminder date
    if "note" in fields:
        debt.note = payload.note  # null/"" clears (validator normalized "" → None)

    await session.commit()
    return await _detail(session, user.id, debt_id)


@router.delete(
    "/{debt_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses={**_NOT_FOUND},
)
# MCP: no — cascades the movements and reverts the balances; delete_transaction
# stays the only irreversible tool
async def delete_debt(
    debt_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete the debt AND its movements; the account balances revert with them.

    The cascade is the FK's (``transactions.debt_id ON DELETE CASCADE``), so the
    rows and the balances they imply disappear in the same statement — there is no
    window in which a debt is gone but its money is still booked.
    """
    debt = await load_own_debt(session, debt_id, user.id)
    if debt is None:
        raise _not_found()
    await session.delete(debt)
    await session.commit()


@router.post(
    "/{debt_id}/repayments",
    response_model=DebtDetailRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_IDEMPOTENT_REPLAY, **_NOT_FOUND, **_UNPROCESSABLE},
)
@mcp_tool(
    name="record_debt_repayment",
    description=(
        "Record that part (or all) of a debt was given back. Money moves on the "
        "account you name — a repayment of a `lent` debt credits it, of a "
        "`borrowed` debt debits it — and, like the debt itself, it counts as "
        "neither income nor expense. `amount_minor` is in the DEBT's currency and "
        "may NOT exceed `remaining_minor` from get_debt: when the user says the "
        "debt is settled, send exactly what is remaining, and the server closes it "
        "on its own. Several paybacks are several calls, each with its own date. "
        "Correcting or deleting a repayment already recorded is not possible here "
        "— the user does that in the app."
    ),
    params={
        "debt_id": _DEBT_ID,
        "amount_minor": _DEBT_AMOUNT,
        "account_id": _MOVEMENT_ACCOUNT,
        "occurred_at": "The date the money changed hands, as YYYY-MM-DD.",
        "account_amount_minor": _ACCOUNT_AMOUNT,
        "note": "Free-text note about this repayment, from the user.",
    },
    managed_body={"client_id": "uuid"},
)
async def record_debt_repayment(
    debt_id: uuid.UUID,
    payload: DebtRepaymentCreate,
    response: Response,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> DebtDetailRead:
    """One partial repayment. More than what is left is refused under a row lock.

    The addressed resource is checked FIRST (404 before anything else), and the
    replay arm right after it: a replay answers with THIS debt, never another one
    — a key already spent elsewhere is refused ``CLIENT_ID_IN_USE``.
    """
    debt = await load_own_debt(session, debt_id, user.id)
    if debt is None:
        raise _not_found()
    replayed = await _replayed_debt_id(
        session, user.id, payload.client_id, expected_debt_id=debt_id
    )
    if replayed is not None:
        response.status_code = status.HTTP_200_OK
        return await _detail(session, user.id, replayed)

    account = await _movement_account(session, payload.account_id, user.id)
    try:
        await add_repayment(
            session,
            user.id,
            debt,
            amount_minor=payload.amount_minor,
            account=account,
            occurred_at=payload.occurred_at,
            account_amount_minor=payload.account_amount_minor,
            note=payload.note,
            client_id=payload.client_id,
        )
    except DebtWriteError as exc:
        raise _unprocessable(exc.code) from exc
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        if payload.client_id is None:
            raise
        raced = await _replayed_debt_id(
            session, user.id, payload.client_id, expected_debt_id=debt_id
        )
        if raced is None:
            raise
        logger.info(
            "idempotent repayment replay recovered from insert race user=%s", user.id
        )
        response.status_code = status.HTTP_200_OK
        return await _detail(session, user.id, raced)
    return await _detail(session, user.id, debt_id)


@router.patch(
    "/{debt_id}/repayments/{repayment_id}",
    response_model=DebtDetailRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
# MCP: no — correcting a recorded money movement stays on the screen where the
# remaining balance and the account balance are both visible; agents record,
# humans correct
async def update_debt_repayment(
    debt_id: uuid.UUID,
    repayment_id: uuid.UUID,
    payload: DebtRepaymentUpdate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> DebtDetailRead:
    """Correct one recorded repayment — amount, account, date or note.

    Both levels answer the SAME 404: a repayment of a debt that is not the
    caller's, of another debt, or of nothing at all is one code path.
    """
    debt, row = await _own_repayment(session, debt_id, repayment_id, user.id)
    fields = payload.model_fields_set
    # Same list as the debt PATCH, minus ``account_amount_minor``: null there is
    # the absent value, not a cleared fact (see update_debt).
    for field, code in (
        ("amount_minor", "DEBT_AMOUNT_REQUIRED"),
        ("account_id", "DEBT_ACCOUNT_REQUIRED"),
        ("occurred_at", "DEBT_OCCURRED_AT_REQUIRED"),
    ):
        if field in fields and getattr(payload, field) is None:
            raise _unprocessable(code)
    account = (
        None
        if payload.account_id is None
        else await _movement_account(session, payload.account_id, user.id)
    )
    try:
        await update_movement(
            session,
            user.id,
            debt,
            row,
            role=DebtRole.repayment,
            amount_minor=payload.amount_minor,
            account=account,
            occurred_at=payload.occurred_at,
            account_amount_minor=payload.account_amount_minor,
            note=payload.note,
            note_sent="note" in fields,
        )
    except DebtWriteError as exc:
        raise _unprocessable(exc.code) from exc
    await session.commit()
    return await _detail(session, user.id, debt_id)


@router.delete(
    "/{debt_id}/repayments/{repayment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses={**_NOT_FOUND},
)
# MCP: no — irreversible
async def delete_debt_repayment(
    debt_id: uuid.UUID,
    repayment_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Delete one repayment: the balance reverts and the debt reopens by arithmetic.

    Nothing is recomputed — ``remaining`` and ``status`` are read from the
    movements, so a debt that was closed by this very repayment is simply open
    again on the next read.
    """
    _, row = await _own_repayment(session, debt_id, repayment_id, user.id)
    await session.delete(row)
    await session.commit()


async def _own_repayment(
    session: AsyncSession,
    debt_id: uuid.UUID,
    repayment_id: uuid.UUID,
    user_id: uuid.UUID,
) -> tuple[Debt, Transaction]:
    """Both levels of the path, or the ONE 404 they share (no-oracle)."""
    debt = await load_own_debt(session, debt_id, user_id)
    if debt is None:
        raise _not_found()
    row = await load_own_repayment(session, debt_id, repayment_id, user_id)
    if row is None:
        raise _not_found()
    return debt, row
