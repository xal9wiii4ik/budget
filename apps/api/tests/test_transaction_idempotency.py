"""POST /transactions idempotency via ``client_id`` (B-1, landed inside 5.6 S1).

Real Postgres, no mocks except the one documented scheduling-window simulation in
``test_insert_race_recovers_and_returns_the_existing_row`` (the gap between the
select-first and the INSERT cannot be scheduled from a test).

Each test contrasts a behaviour a plausible implementation gets wrong. Not
written on purpose: that ``TransactionRead`` lacks ``client_id`` (a model shape,
vacuous), that the column and the partial index exist (migration + ``alembic
check`` own that), and today's create semantics (``test_transactions.py`` owns
them — the no-``client_id`` test below exists only to pin the new guard). A
malformed uuid is a plain Pydantic 422 and is QA-curl-owned.
"""

import asyncio
import uuid
from typing import Any
from unittest.mock import patch

from helpers import account_for_currency
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.merchant import normalize_merchant
from budget_api.routers.transactions import (
    _load_by_client_id,  # pyright: ignore[reportPrivateUsage]  # the real helper the patch below delegates to
)

PASSWORD = "password123"


async def _register_and_login(
    client: AsyncClient, email: str
) -> tuple[dict[str, str], uuid.UUID]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    user_id = uuid.UUID(reg.json()["id"])
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}, user_id


async def _create_category(
    client: AsyncClient, headers: dict[str, str], name: str
) -> str:
    resp = await client.post(
        "/categories", json={"name": name, "kind": "expense"}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def _body(
    client: AsyncClient, headers: dict[str, str], **overrides: Any
) -> dict[str, Any]:
    """A valid create payload, with the caller's default account filled in."""
    body: dict[str, Any] = {
        "amount_minor": 1000,
        "kind": "expense",
        "account_id": await account_for_currency(client, headers),
        "occurred_at": "2026-03-15",
    }
    body.update(overrides)
    return body


async def _tx_count(db_session: AsyncSession, user_id: uuid.UUID) -> int:
    count = await db_session.scalar(
        text("SELECT count(*) FROM transactions WHERE user_id = :uid"),
        {"uid": user_id},
    )
    await db_session.rollback()
    return int(count or 0)


class TestReplay:
    async def test_replay_returns_200_with_the_stored_row(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "idem-1@example.com")
        key = str(uuid.uuid4())

        first = await client.post(
            "/transactions",
            json=await _body(client, headers, client_id=key),
            headers=headers,
        )
        second = await client.post(
            "/transactions",
            json=await _body(client, headers, client_id=key),
            headers=headers,
        )

        assert first.status_code == 201, first.text
        assert second.status_code == 200, second.text
        assert second.json() == first.json()  # same id, same created_at
        assert await _tx_count(db_session, user_id) == 1

    async def test_replay_ignores_a_changed_body(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """FIRST WRITE WINS — a replay is never an upsert."""
        headers, user_id = await _register_and_login(client, "idem-2@example.com")
        key = str(uuid.uuid4())
        first = await client.post(
            "/transactions",
            json=await _body(client, headers, client_id=key),
            headers=headers,
        )

        second = await client.post(
            "/transactions",
            json=await _body(
                client, headers, client_id=key, amount_minor=99_999, note="rewritten"
            ),
            headers=headers,
        )

        assert second.status_code == 200, second.text
        assert second.json()["amount_minor"] == 1000
        assert second.json()["note"] is None
        assert second.json()["id"] == first.json()["id"]
        assert await _tx_count(db_session, user_id) == 1

    async def test_same_client_id_for_two_users_creates_two_rows(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The index is per-USER: one user's key can never resolve another's row."""
        alice, alice_id = await _register_and_login(client, "idem-3a@example.com")
        bob, bob_id = await _register_and_login(client, "idem-3b@example.com")
        key = str(uuid.uuid4())

        mine = await client.post(
            "/transactions",
            json=await _body(client, alice, client_id=key),
            headers=alice,
        )
        theirs = await client.post(
            "/transactions", json=await _body(client, bob, client_id=key), headers=bob
        )

        assert (mine.status_code, theirs.status_code) == (201, 201)
        assert mine.json()["id"] != theirs.json()["id"]
        assert await _tx_count(db_session, alice_id) == 1
        assert await _tx_count(db_session, bob_id) == 1

    async def test_creates_without_client_id_are_never_deduplicated(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The ``is not None`` guard: web sends no key and must keep getting 201s."""
        headers, user_id = await _register_and_login(client, "idem-4@example.com")

        first = await client.post(
            "/transactions", json=await _body(client, headers), headers=headers
        )
        second = await client.post(
            "/transactions", json=await _body(client, headers), headers=headers
        )

        assert (first.status_code, second.status_code) == (201, 201)
        assert first.json()["id"] != second.json()["id"]
        assert await _tx_count(db_session, user_id) == 2

    async def test_replay_does_not_relearn_the_merchant_map(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The one skipped side effect with a user-visible consequence (D7)."""
        headers, user_id = await _register_and_login(client, "idem-5@example.com")
        cat_a = await _create_category(client, headers, "A")
        cat_b = await _create_category(client, headers, "B")
        key = str(uuid.uuid4())
        first = await client.post(
            "/transactions",
            json=await _body(
                client, headers, client_id=key, merchant="Пятёрочка", category_id=cat_a
            ),
            headers=headers,
        )
        assert first.status_code == 201, first.text
        override = await client.post(
            "/transactions",
            json=await _body(
                client,
                headers,
                client_id=str(uuid.uuid4()),
                merchant="Пятёрочка",
                category_id=cat_b,
            ),
            headers=headers,
        )
        assert override.status_code == 201, override.text

        async def _mapped() -> tuple[Any, Any]:
            row = (
                await db_session.execute(
                    text(
                        "SELECT category_id, updated_at FROM merchant_category_map "
                        "WHERE user_id = :uid AND merchant_norm = :norm"
                    ),
                    {"uid": user_id, "norm": normalize_merchant("Пятёрочка")},
                )
            ).one()
            await db_session.rollback()
            return row[0], row[1]

        before = await _mapped()
        replay = await client.post(
            "/transactions",
            json=await _body(
                client, headers, client_id=key, merchant="Пятёрочка", category_id=cat_a
            ),
            headers=headers,
        )
        after = await _mapped()

        assert replay.status_code == 200, replay.text
        # Still B, with an untouched updated_at: the replay ran no upsert at all.
        assert str(after[0]) == cat_b
        assert after == before

    async def test_replay_after_the_category_was_archived_still_returns_200(
        self, client: AsyncClient
    ) -> None:
        """Pins the ruling that the hit short-circuits BEFORE _validate_category."""
        headers, _ = await _register_and_login(client, "idem-6@example.com")
        category_id = await _create_category(client, headers, "Временная")
        key = str(uuid.uuid4())
        first = await client.post(
            "/transactions",
            json=await _body(client, headers, client_id=key, category_id=category_id),
            headers=headers,
        )
        assert first.status_code == 201, first.text
        archived = await client.patch(
            f"/categories/{category_id}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text

        replay = await client.post(
            "/transactions",
            json=await _body(client, headers, client_id=key, category_id=category_id),
            headers=headers,
        )

        assert replay.status_code == 200, replay.text  # NOT 422 CATEGORY_ARCHIVED
        assert replay.json() == first.json()


class TestRace:
    async def test_concurrent_replays_create_exactly_one_row(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Genuine DB concurrency: each request gets its own session and connection.

        Proves the invariant end to end. It does NOT deterministically exercise the
        IntegrityError arm — the loser may simply observe the committed row in its
        select-first; the test below is the arm-specific one.
        """
        headers, user_id = await _register_and_login(client, "idem-7@example.com")
        key = str(uuid.uuid4())
        body = await _body(client, headers, client_id=key)

        first, second = await asyncio.gather(
            client.post("/transactions", json=body, headers=headers),
            client.post("/transactions", json=body, headers=headers),
        )

        assert sorted([first.status_code, second.status_code]) == [200, 201]
        assert first.json()["id"] == second.json()["id"]
        assert await _tx_count(db_session, user_id) == 1

    @patch("budget_api.routers.transactions._load_by_client_id")
    async def test_insert_race_recovers_and_returns_the_existing_row(
        self, mock_lookup: Any, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Mocking an internal on purpose: the window between the select-first and
        # the INSERT cannot be scheduled from a test, so the first lookup is forced
        # to miss while the row already exists. Everything else — the index, the
        # IntegrityError, the rollback, the re-select — runs for real.
        real = _load_by_client_id
        headers, user_id = await _register_and_login(client, "idem-8@example.com")
        key = str(uuid.uuid4())
        calls = {"n": 0}

        async def _miss_once(*args: Any, **kwargs: Any) -> Any:
            calls["n"] += 1
            if calls["n"] == 2:  # the replay's select-first, forced to miss
                return None
            return await real(*args, **kwargs)

        mock_lookup.side_effect = _miss_once
        first = await client.post(
            "/transactions",
            json=await _body(client, headers, client_id=key),
            headers=headers,
        )
        assert first.status_code == 201, first.text

        replay = await client.post(
            "/transactions",
            json=await _body(client, headers, client_id=key),
            headers=headers,
        )

        assert replay.status_code == 200, replay.text
        assert replay.json()["id"] == first.json()["id"]
        assert await _tx_count(db_session, user_id) == 1
