"""The ``client_id`` lookup behind every idempotent create (B-1).

One function, extracted from ``routers/transactions.py`` at its SECOND consumer
(the ``tx_totals`` rule): ``POST /debts`` and ``POST /debts/{id}/repayments``
store the key on the movement row they insert, so they replay through the very
same query and the very same partial unique index
(``uq_transactions_user_id_client_id``).

What deliberately did NOT move here: each router's post-``IntegrityError``
recovery arm. Recovering a race means deciding what to RETURN — a transaction in
one router, the whole debt in the other — and that is the router's answer, not a
shared helper's.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Transaction


async def load_by_client_id(
    session: AsyncSession, user_id: uuid.UUID, client_id: uuid.UUID
) -> Transaction | None:
    """user_id-scoped idempotency lookup — the ONE query every replay arm shares.

    Mirrors the shape and the no-oracle property of the ``_load_own`` loads: the
    filter carries ``user_id``, so a hit can only ever be the caller's own row and
    a guessed foreign key is an ordinary miss.
    """
    return await session.scalar(
        select(Transaction).where(
            Transaction.user_id == user_id, Transaction.client_id == client_id
        )
    )
