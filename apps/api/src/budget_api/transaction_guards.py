"""Reference guards for the transactions router: resolve an id, or refuse.

Top-level neutral module for the same reason ``account_access.py`` and
``goal_item_access.py`` are ones: it imports ``models`` and the access helpers and
is imported by a router, so there is no cycle and no router imports another router.
It sits ABOVE those helpers rather than beside them — they answer "whose row is
this?" with a ``None``, this module turns that ``None`` into the HTTP refusal the
transactions endpoints owe, which is why ``HTTPException`` lives here and never in
``services/`` (a scheduler job has no status code to raise).

Every function here is a policy statement, and the invariants worth protecting are
the ORDER properties spelled out in each docstring:

* foreign == missing == ONE code path, so the body is byte-identical (no-oracle);
* NOT_FOUND strictly before ARCHIVED, on accounts and on goals alike — answering
  ``ACCOUNT_ARCHIVED`` for a stranger's account would confirm that it exists.

A *body* reference that is foreign/missing is 422 for a category and a receipt
(shared vocabularies) but 404 for an account and a plan node (not shared, so "there
is no such thing of yours" is the honest answer to both a stranger's id and a typo).
That asymmetry is deliberate — see the individual docstrings.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.account_access import load_own_account
from budget_api.category_access import load_visible_category
from budget_api.enums import DEPOSIT_ACCOUNT_TYPE, TransactionKind
from budget_api.goal_item_access import load_own_goal_item
from budget_api.models import Account, Receipt
from budget_api.services.goal_plan_reads import subtree_item_ids


async def validate_category(
    session: AsyncSession, category_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """Body category-ref policy (decision e). Call only when category_id is non-null.

    load_visible → None ⇒ 422 CATEGORY_NOT_FOUND (foreign == missing, one code path,
    byte-identical); a visible-but-archived target ⇒ 422 CATEGORY_ARCHIVED. Order
    preserves the existence oracle: a foreign archived category is CATEGORY_NOT_FOUND,
    never CATEGORY_ARCHIVED.
    """
    cat = await load_visible_category(session, category_id, user_id)
    if cat is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CATEGORY_NOT_FOUND",
        )
    if cat.archived:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CATEGORY_ARCHIVED",
        )


async def require_own_account(
    session: AsyncSession, account_id: uuid.UUID, user_id: uuid.UUID
) -> Account:
    """Body account-ref policy (architecture §9): foreign == missing == 404.

    A 404, not the 422 a foreign ``category_id`` gets: an account is not a shared
    vocabulary the way system categories are, so "there is no such account of
    yours" is the honest answer for both a stranger's id and a typo. ONE code path,
    so the two produce byte-identical bodies (no-oracle) — used for BOTH
    ``account_id`` and ``counter_account_id``, which is what stops a transfer from
    becoming an account-existence probe.
    """
    account = await load_own_account(session, account_id, user_id)
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="ACCOUNT_NOT_FOUND"
        )
    return account


def reject_archived(account: Account) -> None:
    """422 on a write to an archived account. NEVER call it before the 404 above:
    answering ACCOUNT_ARCHIVED for someone else's account would confirm it exists."""
    if account.archived:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="ACCOUNT_ARCHIVED"
        )


def reject_deposit_spending(account: Account, *, is_transfer: bool) -> None:
    """422 unless the row is a transfer — money on a deposit is not spendable.

    A ``type='deposit'`` account is the hidden ledger of a deposit (deposits
    architecture §"Поведение счетов типа deposit"): money gets there and leaves
    there by TRANSFER and by nothing else. That is not a UI preference — it is what
    keeps deposit money out of every expense/income aggregate without a second
    filtering point, since ``services/tx_totals.py`` already cuts transfers out and
    only transfers.

    Only the row's OWN account is checked, never the counter leg: a transfer INTO a
    deposit is the top-up this whole scope exists for.
    """
    if not is_transfer and account.type == DEPOSIT_ACCOUNT_TYPE:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="DEPOSIT_ACCOUNT_TRANSFER_ONLY",
        )


async def validate_receipt(
    session: AsyncSession, receipt_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """Body receipt-ref policy (D8). Call only when receipt_id is non-null.

    Reuses the established user_id-scoped load pattern (the S2/S3 _load_own_receipt
    precedent): a foreign OR missing receipt both resolve to None → 422
    RECEIPT_NOT_FOUND, byte-identical (no-oracle, one code path — mirrors
    CATEGORY_NOT_FOUND). No status requirement: linking a pending/failed receipt is
    harmless (D8). The addressed resource (the transaction being created) is fine, so
    the body ref — not the resource — is the 422.
    """
    owned = await session.scalar(
        select(Receipt.id).where(Receipt.id == receipt_id, Receipt.user_id == user_id)
    )
    if owned is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="RECEIPT_NOT_FOUND",
        )


async def validate_goal_item(
    session: AsyncSession, goal_item_id: uuid.UUID, user_id: uuid.UUID, kind: str
) -> None:
    """Body plan-link policy (goal-planner §3). Call only when the id is non-null.

    Guard order is the account one: a foreign OR missing node is ONE code path to
    404 ``GOAL_ITEM_NOT_FOUND`` (byte-identical — a payment must never become a
    probe for other people's plans), and only THEN can an own archived goal answer
    422 ``GOAL_ARCHIVED``. A 404 rather than the 422 a foreign ``category_id``
    gets, for the same reason an account gets one: a plan node is not a shared
    vocabulary, so "there is no such node of yours" is the honest answer to both a
    stranger's id and a typo.

    ``kind`` is the EFFECTIVE kind — what the row will be after this write — so
    linking a non-expense and re-kinding a linked row are the same refusal.
    """
    found = await load_own_goal_item(session, goal_item_id, user_id)
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_ITEM_NOT_FOUND"
        )
    _, goal = found
    if goal.archived:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="GOAL_ARCHIVED"
        )
    if kind != TransactionKind.expense.value:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="GOAL_ITEM_EXPENSE_ONLY",
        )


async def resolve_goal_item_subtree(
    session: AsyncSession, goal_item_id: uuid.UUID, user_id: uuid.UUID
) -> list[uuid.UUID]:
    """The node's subtree ids for the ``?goal_item_id=`` filter, or a 404.

    THE ONE read filter that refuses (decision l says read filters merely match
    nothing), which is why it lives here with the write guards and not in
    ``services/tx_read_query.py``: an unknown or foreign node would otherwise answer
    with an empty list, which reads as "this node has no payments" — a wrong answer
    to a question about a node that does not exist. Foreign == missing == one 404,
    as everywhere else.
    """
    found = await load_own_goal_item(session, goal_item_id, user_id)
    if found is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="GOAL_ITEM_NOT_FOUND"
        )
    item, _ = found
    return await subtree_item_ids(session, item.goal_id, item.id)
