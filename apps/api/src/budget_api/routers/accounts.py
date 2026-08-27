"""Account CRUD — list / create / update over the ``accounts`` table.

Two structural authorization pillars (architecture §3), carried from categories.py:

* **Reads** filter ``user_id = me`` (there are no shared system accounts, so unlike
  categories there is no ``OR user_id IS NULL`` arm).
* **Writes** force ``user_id = me`` and never read ``user_id`` from the body.

No-oracle: a foreign account id and a missing one both resolve through
``load_own_account`` to ONE ``404 ACCOUNT_NOT_FOUND`` with a byte-identical body.

There is NO DELETE (architecture §9): an account owns history, so the affordance is
``archived: true``. A hard delete would cascade the transactions away with it.

``currency`` is immutable (§4): every transaction is stamped from the account, so a
change would restate history without touching a single stored row. The flow is
archive + create a new account; an attempt is ``422 ACCOUNT_CURRENCY_IMMUTABLE``.

Balances are computed, never stored (§2) — the list runs ONE grouped query for all
of them (``services/account_balances.py``) rather than one query per account.

Since the deposits scope this router serves only ``card``/``cash``: a
``type='deposit'`` account is the hidden 1:1 ledger of a ``deposits`` row, so it is
filtered out of the list, answers 404 to PATCH, and cannot be created or patched
INTO existence (the write schemas pin the ``card|cash`` Literal). Those three
refusals plus the transactions router's ``DEPOSIT_ACCOUNT_TRANSFER_ONLY`` are the
whole hermeticity of a deposit account.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.account_access import load_own_account
from budget_api.db import get_session
from budget_api.enums import DEPOSIT_ACCOUNT_TYPE, AccountType
from budget_api.models import Account, User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.account import (
    AccountCreate,
    AccountError,
    AccountRead,
    AccountUpdate,
)
from budget_api.services.account_balances import account_balances

router = APIRouter()

# Mirrors routers/categories.py: every HTTPException.detail below is a stable
# UPPER_SNAKE code carried in {"detail": ...} (the AccountError shape).
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": AccountError}
}
# The honest anyOf union (AM-5): PATCH emits BOTH our business codes and FastAPI's
# auto Pydantic array at runtime. HTTPValidationError is referenced, never
# hand-declared — declaring it would mangle the generated component name.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/AccountError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}


def _serialize(account: Account, balance_minor: int) -> AccountRead:
    return AccountRead(
        id=account.id,
        name=account.name,
        currency=account.currency,
        type=AccountType(account.type),
        starting_balance_minor=account.starting_balance_minor,
        balance_minor=balance_minor,
        archived=account.archived,
        created_at=account.created_at,
    )


@router.get("", response_model=list[AccountRead])
async def list_accounts(
    include_archived: bool = False,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> list[AccountRead]:
    """The user's accounts, each with its computed balance (the categories shape).

    ``include_archived`` mirrors ``GET /categories`` exactly, and an archived
    account still reports a real balance: the money on it did not stop existing
    when the user stopped using it.
    """
    # Deposit accounts are the hidden ledgers of ``deposits`` rows and are NOT
    # accounts as far as this API is concerned (deposits architecture §"Поведение
    # счетов типа deposit"): filtering them here, in the SQL, is what keeps every
    # picker, every "total across accounts" and every client that lists accounts
    # clean BY CONSTRUCTION — no client-side flag, no second filtering point. They
    # are read through GET /deposits, which reports body and interest separately.
    stmt = select(Account).where(
        Account.user_id == user.id, Account.type != DEPOSIT_ACCOUNT_TYPE
    )
    if not include_archived:
        stmt = stmt.where(Account.archived.is_(False))
    # Name, then id: names are not unique (no unique constraint, the categories
    # precedent), so the id tiebreak keeps the order total and stable.
    stmt = stmt.order_by(Account.name, Account.id)
    rows = (await session.scalars(stmt)).all()
    # ONE grouped query for every account's movements, before the loop.
    balances = await account_balances(session, user.id)
    return [
        _serialize(row, row.starting_balance_minor + balances.get(row.id, 0))
        for row in rows
    ]


@router.post("", response_model=AccountRead, status_code=status.HTTP_201_CREATED)
async def create_account(
    payload: AccountCreate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> AccountRead:
    """Create an account. No name-uniqueness check — categories has none either."""
    account = Account(
        user_id=user.id,
        name=payload.name,
        currency=payload.currency,
        type=payload.type.value,
        starting_balance_minor=payload.starting_balance_minor,
    )
    session.add(account)
    await session.commit()
    await session.refresh(account)
    # A brand-new account has no transactions, so its balance IS its opening
    # balance — asserted rather than queried.
    return _serialize(account, account.starting_balance_minor)


@router.patch(
    "/{account_id}",
    response_model=AccountRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def update_account(
    account_id: uuid.UUID,
    payload: AccountUpdate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> AccountRead:
    # Guard order: load-own → 404 (foreign == missing), then the immutable-field
    # refusal, then the NOT NULL null-clears, then apply.
    account = await load_own_account(session, account_id, user.id)
    if account is None or account.type == DEPOSIT_ACCOUNT_TYPE:
        # A deposit's ledger account is not managed here — it is managed through
        # /deposits, which owns its name, its archive state and its whole reason to
        # exist. The refusal is the SAME 404 a stranger's id gets, not a 403: this
        # router does not admit that the account exists at all (it is invisible in
        # the list above for the same reason).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="ACCOUNT_NOT_FOUND"
        )

    fields = payload.model_fields_set
    if "currency" in fields:
        # Refused whether or not the value differs from the stored one: "change the
        # currency" is not a supported operation, and answering 200 to a no-op form
        # of it would teach clients that the field is patchable.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="ACCOUNT_CURRENCY_IMMUTABLE",
        )
    for field, code in (
        ("name", "ACCOUNT_NAME_REQUIRED"),
        ("type", "ACCOUNT_TYPE_REQUIRED"),
        ("starting_balance_minor", "STARTING_BALANCE_REQUIRED"),
        ("archived", "ACCOUNT_ARCHIVED_REQUIRED"),
    ):
        if field in fields and getattr(payload, field) is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=code
            )

    if "name" in fields:
        assert payload.name is not None  # 422-guarded above
        account.name = payload.name
    if "type" in fields:
        assert payload.type is not None  # 422-guarded above
        account.type = payload.type.value
    if "starting_balance_minor" in fields:
        assert payload.starting_balance_minor is not None  # 422-guarded above
        # OQ-4: a setup fact, not history — editing it shifts the computed balance
        # by exactly the delta and touches no transaction.
        account.starting_balance_minor = payload.starting_balance_minor
    if "archived" in fields:
        assert payload.archived is not None  # 422-guarded above
        account.archived = payload.archived

    await session.commit()
    await session.refresh(account)
    balances = await account_balances(session, user.id)
    return _serialize(
        account, account.starting_balance_minor + balances.get(account.id, 0)
    )
