"""``services/categorize_pool.load_example_pool`` — whose rows become examples.

Real Postgres, real HTTP writes, the ``FakeEmbedder`` (no 118 MB artifact) and
the real ``tx_index.refresh``, so the pool is read out of the same index the
server has. The ``test_tx_search`` precedent: nothing is mocked, because the one
thing worth proving here is a SQL predicate set.

Privacy is the point. A few-shot example is a line out of someone's bank
statement, so the question "could another user's row ever get into this prompt"
has to be answered by a test and not by reading the query.
"""

import uuid
from typing import Any

from helpers import create_account
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.embeddings import FakeEmbedder
from budget_api.services.categorize_pool import load_example_pool
from budget_api.services.tx_index import refresh

PASSWORD = "password123"


async def _register_and_login(
    client: AsyncClient, email: str
) -> tuple[dict[str, str], uuid.UUID]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return (
        {"Authorization": f"Bearer {login.json()['access_token']}"},
        uuid.UUID(reg.json()["id"]),
    )


async def _category(
    client: AsyncClient, headers: dict[str, str], name: str, **body: Any
) -> str:
    created = await client.post(
        "/categories", json={"name": name, "kind": "expense", **body}, headers=headers
    )
    assert created.status_code == 201, created.text
    return str(created.json()["id"])


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", "2026-03-15")
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


class TestExamplePool:
    async def test_only_the_callers_own_usable_rows_become_examples(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """One query, five chances to leak or to teach the model nothing.

        What each seeded row is for:

        * the OTHER user's categorized row — the privacy invariant: examples are
          one user's own history, and a pool query missing its ``user_id``
          predicate would put a stranger's merchant in this user's prompt;
        * the archived-category row — an archived category is not offered to the
          model, so an example filed under one can only push it towards a key the
          schema does not even contain;
        * the uncategorized row — there is no decision to copy;
        * the transfer — belt-and-braces, and doubly excluded (``tx_index`` never
          indexes one, and it cannot carry a category at all): fabricating an
          indexed transfer to isolate the predicate would be testing a state the
          app cannot produce;
        * the note-only row — the example TEXT rule: a row with no merchant is
          shown by its note's first clause, not dropped and not quoted whole.
        """
        headers, user_id = await _register_and_login(client, "pool-own@x.com")
        account = (await create_account(client, headers, name="Main"))["id"]
        spare = (await create_account(client, headers, name="Spare"))["id"]
        food = await _category(client, headers, "Продукты надо")
        gone = await _category(client, headers, "Старое")

        await _create_tx(
            client, headers, merchant="Biedronka", account_id=account, category_id=food
        )
        await _create_tx(
            client,
            headers,
            merchant=None,
            note="Кофе на вынос, по дороге домой",
            account_id=account,
            category_id=food,
        )
        await _create_tx(
            client,
            headers,
            merchant="Старый магазин",
            account_id=account,
            category_id=gone,
        )
        await _create_tx(client, headers, merchant="Без категории", account_id=account)
        await _create_tx(
            client,
            headers,
            merchant="Перевод",
            kind="transfer",
            account_id=account,
            counter_account_id=spare,
            counter_amount_minor=1000,
        )
        archived = await client.patch(
            f"/categories/{gone}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text

        other_headers, other_id = await _register_and_login(client, "pool-other@x.com")
        other_account = (await create_account(client, other_headers, name="Theirs"))[
            "id"
        ]
        other_category = await _category(client, other_headers, "Их категория")
        await _create_tx(
            client,
            other_headers,
            merchant="Чужой магазин",
            account_id=other_account,
            category_id=other_category,
        )

        embedder = FakeEmbedder()
        for owner in (user_id, other_id):
            await refresh(db_session, embedder, owner, batch_size=10, max_rows=100)

        pool = await load_example_pool(db_session, embedder, user_id, limit=100)

        assert set(pool.texts) == {"Biedronka", "Кофе на вынос"}
        assert set(pool.category_ids) == {uuid.UUID(food)}
        assert pool.matrix.shape == (2, embedder.dim)
