"""Merchant-learning + receipt/merchant confirm fields (S4) — real Postgres, no mocks.

Covers only what S4 adds on top of the transactions router: the confirm-time
merchant→category learning upsert (fires / override-wins / guarded by category),
the receipt-ref ownership 422 (the key security assertion, no-oracle byte-identical),
the new read-echo fields, and the PATCH-does-not-learn contract (D7). The pure
``normalize_merchant`` normalizer is unit-tested in test_receipts_model.py (S1,
AM-3) — not re-tested here.
"""

import uuid
from typing import Any

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.merchant import normalize_merchant

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
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    return headers, user_id


async def _create_category(
    client: AsyncClient, headers: dict[str, str], name: str
) -> str:
    resp = await client.post(
        "/categories", json={"name": name, "kind": "expense"}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _post_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> tuple[int, dict[str, Any]]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", "2026-03-15")
    resp = await client.post("/transactions", json=body, headers=headers)
    return resp.status_code, resp.json()


async def _seed_receipt(db_session: AsyncSession, user_id: uuid.UUID) -> uuid.UUID:
    """Insert a receipt row owned by ``user_id`` (bypasses the storage-seam POST)."""
    receipt_id = uuid.uuid4()
    await db_session.execute(
        text(
            "INSERT INTO receipts (id, user_id, storage_path, status) "
            "VALUES (:id, :uid, :path, 'pending')"
        ),
        {"id": receipt_id, "uid": user_id, "path": f"{user_id}/{receipt_id}.jpg"},
    )
    await db_session.commit()
    return receipt_id


async def _map_row(
    db_session: AsyncSession, user_id: uuid.UUID, merchant: str
) -> tuple[uuid.UUID, Any] | None:
    row = (
        await db_session.execute(
            text(
                "SELECT category_id, updated_at FROM merchant_category_map "
                "WHERE user_id = :uid AND merchant_norm = :norm"
            ),
            {"uid": user_id, "norm": normalize_merchant(merchant)},
        )
    ).first()
    return (row[0], row[1]) if row is not None else None


class TestConfirmLearning:
    async def test_confirm_learns_merchant_category(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "learn@x.com")
        cat = await _create_category(client, headers, "Coffee")

        code, _ = await _post_tx(
            client, headers, merchant="Acme Coffee", category_id=cat
        )
        assert code == 201

        mapped = await _map_row(db_session, user_id, "Acme Coffee")
        assert mapped is not None
        assert mapped[0] == uuid.UUID(cat)  # (user, normalized merchant) -> category

    async def test_learning_override_wins(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "override@x.com")
        first = await _create_category(client, headers, "Coffee")
        second = await _create_category(client, headers, "Dining")

        code, _ = await _post_tx(
            client, headers, merchant="Acme Coffee", category_id=first
        )
        assert code == 201
        before = await _map_row(db_session, user_id, "Acme Coffee")
        assert before is not None and before[0] == uuid.UUID(first)

        # Same merchant, different category → the map holds the LATEST (override
        # wins), and updated_at advances to the second commit's transaction time.
        code, _ = await _post_tx(
            client, headers, merchant="acme  COFFEE", category_id=second
        )
        assert code == 201
        after = await _map_row(db_session, user_id, "Acme Coffee")
        assert after is not None
        assert after[0] == uuid.UUID(second)  # latest category wins
        assert after[1] > before[1]  # updated_at refreshed

    async def test_no_learning_without_category(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "nocat@x.com")

        code, _ = await _post_tx(
            client, headers, merchant="Acme Coffee", category_id=None
        )
        assert code == 201

        # Merchant present but no category → the learning guard skips the upsert.
        assert await _map_row(db_session, user_id, "Acme Coffee") is None

    async def test_patch_does_not_learn(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "patchlearn@x.com")
        cat = await _create_category(client, headers, "Coffee")

        # Create carrying a merchant but NO category → no learning on create.
        code, body = await _post_tx(client, headers, merchant="Acme Coffee")
        assert code == 201
        assert await _map_row(db_session, user_id, "Acme Coffee") is None

        # PATCH the category onto the tx-with-merchant → D7: PATCH never learns.
        patched = await client.patch(
            f"/transactions/{body['id']}",
            json={"category_id": cat},
            headers=headers,
        )
        assert patched.status_code == 200, patched.text
        assert await _map_row(db_session, user_id, "Acme Coffee") is None


class TestReceiptRef:
    async def test_receipt_id_cross_user_is_422(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        _, user_a = await _register_and_login(client, "recowner@x.com")
        receipt_id = await _seed_receipt(db_session, user_a)

        headers_b, _ = await _register_and_login(client, "recspy@x.com")
        foreign = await client.post(
            "/transactions",
            json={
                "amount_minor": 100,
                "kind": "expense",
                "occurred_at": "2026-03-15",
                "receipt_id": str(receipt_id),
            },
            headers=headers_b,
        )
        missing = await client.post(
            "/transactions",
            json={
                "amount_minor": 100,
                "kind": "expense",
                "occurred_at": "2026-03-15",
                "receipt_id": str(uuid.uuid4()),
            },
            headers=headers_b,
        )

        # No-oracle: a foreign receipt and a nonexistent one are byte-identical.
        assert foreign.status_code == 422
        assert missing.status_code == 422
        assert foreign.json() == missing.json() == {"detail": "RECEIPT_NOT_FOUND"}

    async def test_transaction_read_carries_merchant_and_receipt_id(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "echo@x.com")
        receipt_id = await _seed_receipt(db_session, user_id)
        cat = await _create_category(client, headers, "Coffee")

        code, body = await _post_tx(
            client,
            headers,
            merchant="Acme Coffee",
            category_id=cat,
            receipt_id=str(receipt_id),
        )
        assert code == 201
        assert body["receipt_id"] == str(receipt_id)
        assert body["merchant"] == "Acme Coffee"
