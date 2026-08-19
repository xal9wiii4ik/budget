"""Cross-file test helpers (imported as ``from helpers import ...``).

Only ONE thing lives here: resolving the account a transaction must be booked to.
Since the accounts-and-transfers scope ``POST /transactions`` requires an
``account_id`` and stamps the row's currency from that account, every test file
that books money needs an account whose currency matches what the test is about.
Duplicating that get-or-create in nine files is exactly the copy-paste the
conftest rule exists to prevent — and it is a plain function rather than a fixture
because the per-file ``_create_tx`` helpers that need it are called from ~40 sites
that take no fixtures.
"""

import uuid
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Account

#: The default base currency a freshly registered user's profile carries, so a
#: transaction created without an explicit currency keeps its pre-accounts meaning
#: (stamped base currency, no snapshot).
DEFAULT_TEST_CURRENCY = "RUB"


async def create_account(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("name", f"Account {body.get('currency', DEFAULT_TEST_CURRENCY)}")
    body.setdefault("currency", DEFAULT_TEST_CURRENCY)
    body.setdefault("type", "card")
    resp = await client.post("/accounts", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def account_for_currency(
    client: AsyncClient, headers: dict[str, str], currency: str | None = None
) -> str:
    """The caller's account in ``currency``, created on first use.

    Reuses an existing one so a test that books five RUB rows still ends up with a
    single account (and therefore one balance to reason about). ``None`` means "the
    test does not care", which maps to the default-currency account.
    """
    wanted = currency or DEFAULT_TEST_CURRENCY
    listed = await client.get(
        "/accounts", params={"include_archived": True}, headers=headers
    )
    assert listed.status_code == 200, listed.text
    for account in listed.json():
        if account["currency"] == wanted and not account["archived"]:
            account_id: str = account["id"]
            return account_id
    return str((await create_account(client, headers, currency=wanted))["id"])


async def add_account(
    session: AsyncSession,
    user_id: uuid.UUID,
    currency: str = DEFAULT_TEST_CURRENCY,
    **kwargs: Any,
) -> Account:
    """Insert an account straight through the ORM, for tests that seed rows directly.

    Flushed, not committed: the caller owns the transaction, exactly as it does for
    the ``Transaction`` rows this account exists to make insertable.
    """
    account = Account(
        user_id=user_id,
        name=kwargs.pop("name", f"{currency} account"),
        currency=currency,
        type=kwargs.pop("type", "card"),
        **kwargs,
    )
    session.add(account)
    await session.flush()
    return account
