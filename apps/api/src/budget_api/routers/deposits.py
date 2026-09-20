"""Deposits — list / create / detail / update over the ``deposits`` table.

The two authorization pillars of every data router here (categories.py, §3): reads
filter ``user_id = me``, writes force it and never read ownership from the body.
No-oracle: a foreign deposit id and a missing one both resolve through
``load_own_deposit`` to ONE ``404 DEPOSIT_NOT_FOUND`` with a byte-identical body.

There is NO DELETE (the accounts/categories shape): a deposit owns a ledger
account and its transfers, so the affordance is ``archived: true`` — which
cascades to the account in the SAME transaction, so the money door is then held by
the EXISTING ``ACCOUNT_ARCHIVED`` guard in the transactions router rather than by a
second rule invented here. Archiving with a non-zero balance is allowed
(AMENDMENT §3), exactly as for accounts: the money did not stop existing — and
for the same reason the archive is REVERSIBLE: ``PATCH {"archived": false}``,
that body and no other field beside it, is the one write an archived deposit
accepts, because otherwise the balance of a deposit archived by mistake would be
locked away for good (the transfer door is held by the account guard, and every
other PATCH by ``DEPOSIT_ARCHIVED``). Reopening and editing stay two requests:
a field sent alongside the flag is refused with ``DEPOSIT_UNARCHIVE_ONLY``.

``POST`` creates TWO rows in one transaction — the hidden ``type='deposit'``
account and the deposit itself — because a deposit without its ledger would be a
deposit whose money has nowhere to sit. ``initial_balance_minor`` lands on the
ACCOUNT's ``starting_balance_minor`` (AMENDMENT §1): a setup fact, not a
back-dated transfer that would restate some other account's balance.

Nothing about money is patchable here. The body moves only through
``POST /transactions`` transfers, and the interest is computed on read — the ONE
number a user may write is the manual anchor ``accrued_override_minor``, whose
``as_of`` date the SERVER stamps (a client-supplied date would let the forecast be
anchored in a past or future that never happened).
"""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.db import get_session
from budget_api.deposit_access import load_own_deposit
from budget_api.enums import (
    DEPOSIT_ACCOUNT_TYPE,
    DepositCapitalization,
    DepositStatus,
)
from budget_api.mcp.decorator import mcp_tool
from budget_api.models import Account, Deposit, User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.deposit import (
    DepositCreate,
    DepositError,
    DepositRead,
    DepositUpdate,
)
from budget_api.services.deposit_reads import DepositView, deposit_views

router = APIRouter()

# Mirrors routers/accounts.py: every HTTPException.detail below is a stable
# UPPER_SNAKE code carried in {"detail": ...} (the DepositError shape).
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": DepositError}
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
                        {"$ref": "#/components/schemas/DepositError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}


def _today() -> date:
    return datetime.now(UTC).date()


def _unprocessable(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=code)


def _not_found() -> HTTPException:
    """The ONE 404 of this router — foreign and missing share it (no-oracle)."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="DEPOSIT_NOT_FOUND"
    )


def _decimal_str(value: Decimal) -> str:
    """Decimal → the wire STRING (the ``transfer_rate`` contract, transactions.py).

    ``normalize()`` first, so the rate a client sent as ``"10.95"`` does not come
    back as ``"10.9500"`` just because the column has four decimal places. The
    output is the SHORTEST spelling of the stored number, not an echo of the
    client's characters — ``"10.00"`` comes back as ``"10"`` — and every read of a
    given row prints that same spelling. ``format(…, "f")``
    rather than ``str``, because a normalized Decimal switches to scientific
    notation (``Decimal("10.0000").normalize()`` is ``1E+1``) and a client would
    have to parse that to render a rate.
    """
    return format(value.normalize(), "f")


def _status(deposit: Deposit, today: date) -> DepositStatus:
    """``matured`` once ``term_end`` has ARRIVED — accrual is frozen on that date,
    so a deposit whose term ends today has already earned everything it will."""
    if deposit.term_end is not None and deposit.term_end <= today:
        return DepositStatus.matured
    return DepositStatus.active


def _serialize(view: DepositView, today: date) -> DepositRead:
    deposit = view.deposit
    return DepositRead(
        id=deposit.id,
        name=deposit.name,
        account_id=deposit.account_id,
        # From the ACCOUNT, always: the deposits table has no currency column, so
        # the two can never disagree.
        currency=view.account.currency,
        rate_percent=_decimal_str(deposit.rate_percent),
        capitalization=DepositCapitalization(deposit.capitalization),
        opened_on=deposit.opened_on,
        term_end=deposit.term_end,
        tax_rate_percent=(
            None
            if deposit.tax_rate_percent is None
            else _decimal_str(deposit.tax_rate_percent)
        ),
        balance_minor=view.balance_minor,
        accrued_minor=view.accrued_minor,
        accrued_after_tax_minor=view.accrued_after_tax_minor,
        accrued_override_minor=deposit.accrued_override_minor,
        accrued_override_as_of=deposit.accrued_override_as_of,
        status=_status(deposit, today),
        archived=deposit.archived,
        created_at=deposit.created_at,
    )


async def _serialize_one(
    session: AsyncSession, user_id: uuid.UUID, deposit: Deposit, today: date
) -> DepositRead:
    """One deposit through the SAME assembler the list uses — so a detail read and
    a list row can never report different money for the same deposit."""
    views = await deposit_views(session, user_id, [deposit], today=today)
    return _serialize(views[0], today)


@router.get("", response_model=list[DepositRead])
@mcp_tool(
    name="list_deposits",
    description=(
        "The user's term deposits and savings deposits — money that is theirs but is "
        "NOT on any account from list_accounts and is NOT part of everyday spending. "
        "Each row carries the BODY (`balance_minor`) and the interest earned so far "
        "(`accrued_minor`) as two separate server-computed figures in INTEGER MINOR "
        "UNITS of that deposit's own `currency`: never add them together, never add "
        "different currencies together, and never work interest out yourself — the "
        "rate, the compounding and the day count are the server's. "
        "`accrued_after_tax_minor` is what is left after withholding and is null "
        'when no tax rate is recorded, which means "not known to be taxed", not '
        '"zero". `status` is `matured` once the term has ended, and interest then '
        "stops growing. `accrued_override_minor` (with `accrued_override_as_of`) "
        "means the user CORRECTED the figure by hand from their bank — when it is "
        "set, quote it and say it came from them. Archived deposits are included, so "
        "check `archived` before treating one as live. This is where every "
        "`deposit_id` comes from, and `account_id` is what to pass to "
        "list_transactions to see a deposit's history."
    ),
)
async def list_deposits(
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> list[DepositRead]:
    """The user's deposits, archived ones INCLUDED (no ``include_archived`` param).

    The one archive-inclusive cache entry the client dims itself: a closed deposit
    still holds a balance and a history, and a list that hid it would hide money.
    """
    today = _today()
    # Name, then id: names are not unique (the accounts precedent), so the id
    # tiebreak keeps the order total and stable.
    deposits = list(
        (
            await session.scalars(
                select(Deposit)
                .where(Deposit.user_id == user.id)
                .order_by(Deposit.name, Deposit.id)
            )
        ).all()
    )
    views = await deposit_views(session, user.id, deposits, today=today)
    return [_serialize(view, today) for view in views]


@router.post(
    "",
    response_model=DepositRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_UNPROCESSABLE},
)
# MCP: no — mints a money-holding entity together with its hidden ledger account
async def create_deposit(
    payload: DepositCreate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> DepositRead:
    """Create the deposit AND its hidden ledger account, in one transaction."""
    if payload.term_end is not None and payload.term_end <= payload.opened_on:
        # Refused here rather than by the CHECK: a constraint violation would
        # surface as a 500, and "the term ends before it starts" is a user error.
        raise _unprocessable("DEPOSIT_TERM_BEFORE_OPENING")

    account = Account(
        user_id=user.id,
        # The account carries the deposit's name so the ledger reads honestly
        # where the ACCOUNT is what gets printed — the transactions CSV export.
        # The deposit's own name stays the source of truth; PATCH renames both in
        # one transaction so the two can never drift apart.
        name=payload.name,
        currency=payload.currency,
        type=DEPOSIT_ACCOUNT_TYPE,
        starting_balance_minor=payload.initial_balance_minor,
    )
    session.add(account)
    # Flush, not commit: the account id is needed for the FK, and an account
    # without its deposit must never survive a failure of the second insert.
    await session.flush()
    deposit = Deposit(
        user_id=user.id,
        account_id=account.id,
        name=payload.name,
        rate_percent=payload.rate_percent,
        capitalization=payload.capitalization.value,
        opened_on=payload.opened_on,
        term_end=payload.term_end,
        tax_rate_percent=payload.tax_rate_percent,
    )
    session.add(deposit)
    await session.commit()
    await session.refresh(deposit)
    return await _serialize_one(session, user.id, deposit, _today())


@router.get("/{deposit_id}", response_model=DepositRead, responses={**_NOT_FOUND})
@mcp_tool(
    name="get_deposit",
    description=(
        "ONE deposit in detail, with the same server-computed body and interest as "
        "list_deposits. Take `deposit_id` from list_deposits, never guess it. There "
        "is no tool to create a deposit or to change one — not even the accrued "
        "figure: money entering, leaving or being restated on a deposit is done by "
        "the user in the app."
    ),
    params={
        "deposit_id": "Deposit id from list_deposits.",
    },
)
async def get_deposit(
    deposit_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> DepositRead:
    deposit = await load_own_deposit(session, deposit_id, user.id)
    if deposit is None:
        raise _not_found()
    return await _serialize_one(session, user.id, deposit, _today())


@router.patch(
    "/{deposit_id}",
    response_model=DepositRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
# MCP: no — `accrued_override_minor` overrides the server's own interest figure
async def update_deposit(
    deposit_id: uuid.UUID,
    payload: DepositUpdate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> DepositRead:
    # Guard order is load-bearing: load-own → 404 (foreign == missing), THEN
    # archived. A foreign archived deposit must answer NOT_FOUND, never
    # DEPOSIT_ARCHIVED — the second would confirm that the id exists.
    deposit = await load_own_deposit(session, deposit_id, user.id)
    if deposit is None:
        raise _not_found()
    fields = payload.model_fields_set
    if deposit.archived:
        # An archived deposit is closed to writes — its numbers are a record of
        # what happened — with ONE exception: the PATCH that reopens it. Without
        # that escape hatch the money on a deposit archived by mistake could never
        # be moved again: transfers are refused by ACCOUNT_ARCHIVED and every edit
        # here by this code.
        #
        # The exception is exactly ``{"archived": false}`` and nothing else. A
        # reopening PATCH carrying other fields is refused WHOLE with its own code
        # rather than silently dropping them or applying them: the user has to be
        # told that reopening and editing are two requests, not one.
        if payload.archived is not False:
            raise _unprocessable("DEPOSIT_ARCHIVED")
        if fields != {"archived"}:
            raise _unprocessable("DEPOSIT_UNARCHIVE_ONLY")

    for field, code in (
        ("name", "DEPOSIT_NAME_REQUIRED"),
        ("rate_percent", "DEPOSIT_RATE_REQUIRED"),
        ("capitalization", "DEPOSIT_CAPITALIZATION_REQUIRED"),
        ("opened_on", "DEPOSIT_OPENED_ON_REQUIRED"),
        ("archived", "DEPOSIT_ARCHIVED_REQUIRED"),
    ):
        if field in fields and getattr(payload, field) is None:
            raise _unprocessable(code)

    # The pair this PATCH will LEAVE BEHIND — moving EITHER date is the same
    # illegal row, so the comparison is on the effective pair (the transactions
    # router's rule for its counter pair).
    eff_opened_on = payload.opened_on if "opened_on" in fields else deposit.opened_on
    eff_term_end = payload.term_end if "term_end" in fields else deposit.term_end
    assert eff_opened_on is not None  # 422-guarded above
    if eff_term_end is not None and eff_term_end <= eff_opened_on:
        raise _unprocessable("DEPOSIT_TERM_BEFORE_OPENING")

    if "name" in fields:
        assert payload.name is not None  # 422-guarded above
        deposit.name = payload.name
    if "rate_percent" in fields:
        assert payload.rate_percent is not None  # 422-guarded above
        deposit.rate_percent = payload.rate_percent
    if "capitalization" in fields:
        assert payload.capitalization is not None  # 422-guarded above
        deposit.capitalization = payload.capitalization.value
    if "opened_on" in fields:
        deposit.opened_on = eff_opened_on
    if "term_end" in fields:
        # Nullable: an explicit null makes the deposit open-ended.
        deposit.term_end = payload.term_end
    if "tax_rate_percent" in fields:
        # Nullable: an explicit null means "not taxed", which is NOT zero — the
        # after-tax figure goes back to null rather than to the gross.
        deposit.tax_rate_percent = payload.tax_rate_percent
    if "accrued_override_minor" in fields:
        # The anchor is a PAIR and the SERVER owns its date: a value anchors the
        # forecast at TODAY (the figure the user just read off their bank), an
        # explicit null clears both halves and the number goes back to computed.
        deposit.accrued_override_minor = payload.accrued_override_minor
        deposit.accrued_override_as_of = (
            None if payload.accrued_override_minor is None else _today()
        )

    if "archived" in fields:
        assert payload.archived is not None  # 422-guarded above
        deposit.archived = payload.archived
    if "name" in fields or "archived" in fields:
        # ONE load for both cascades below, in the same transaction as the deposit
        # write: the ledger account must never end up renamed-but-not-archived.
        account = await session.scalar(
            select(Account).where(
                Account.id == deposit.account_id, Account.user_id == user.id
            )
        )
        if account is not None:
            if "name" in fields:
                assert payload.name is not None  # 422-guarded above
                account.name = payload.name
            if "archived" in fields:
                # The cascade is the whole point, and it runs BOTH ways: archiving
                # the ledger account is what makes the EXISTING ACCOUNT_ARCHIVED
                # guard refuse the next transfer (instead of a second archive rule
                # living in the transactions router), and unarchiving it is what
                # lets the money out again. The deposit and its ledger are never
                # in different archive states.
                assert payload.archived is not None  # 422-guarded above
                account.archived = payload.archived

    await session.commit()
    await session.refresh(deposit)
    return await _serialize_one(session, user.id, deposit, _today())
