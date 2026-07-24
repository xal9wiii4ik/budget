"""Transaction CRUD + summary contracts — real Postgres, real migrations, no mocks.

Covers only what is unique to this router: currency stamping + forced ownership,
the profile self-heal (POST) and read-only fallback (GET), the no-oracle
byte-identity for the tx 404 and the body-category 422, the archived-target and
model_fields_set null/omit mechanics, list envelope/ordering/isolation/pagination
and read-filter behavior, and the summary aggregate (refund + uncategorized +
range). Pure-Pydantic rejections (note>500, bad kind/date/month, limit/offset
bounds) are QA-curl-owned per the grooming split.
"""

import uuid
from typing import Any

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

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
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("kind", "expense")
    resp = await client.post("/categories", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _archive_category(
    client: AsyncClient, headers: dict[str, str], category_id: str
) -> None:
    resp = await client.patch(
        f"/categories/{category_id}", json={"archived": True}, headers=headers
    )
    assert resp.status_code == 200, resp.text


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", "2026-03-15")
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestCreateTransaction:
    async def test_create_stamps_currency_forces_owner_and_serializes(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "txcreate@x.com")
        cat = await _create_category(client, headers, name="Food")

        resp = await client.post(
            "/transactions",
            json={
                "amount_minor": 2500,
                "kind": "expense",
                "category_id": cat["id"],
                "occurred_at": "2026-03-15",
            },
            headers=headers,
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["currency"] == "RUB"  # base stamped, no wire input
        assert body["amount_minor"] == 2500
        assert body["kind"] == "expense"
        assert body["category_id"] == cat["id"]
        assert "user_id" not in body  # raw ownership never on the wire
        stored = await db_session.scalar(
            text("SELECT user_id FROM transactions WHERE id = :id"),
            {"id": uuid.UUID(body["id"])},
        )
        assert stored == user_id  # forced from token

    async def test_create_self_heals_missing_profile(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "selfheal@x.com")
        await db_session.execute(
            text("DELETE FROM profiles WHERE user_id = :uid"), {"uid": user_id}
        )
        await db_session.commit()

        body = await _create_tx(client, headers, amount_minor=500)

        assert body["currency"] == "RUB"
        recreated = await db_session.scalar(
            text("SELECT base_currency FROM profiles WHERE user_id = :uid"),
            {"uid": user_id},
        )
        assert recreated == "RUB"  # the get-or-create create-branch persisted

    async def test_create_rejects_foreign_and_missing_category_422_identical(
        self, client: AsyncClient
    ) -> None:
        headers_a, _ = await _register_and_login(client, "acat@x.com")
        cat_a = await _create_category(client, headers_a, name="Owned")

        headers_b, _ = await _register_and_login(client, "bcat@x.com")
        foreign = await client.post(
            "/transactions",
            json={
                "amount_minor": 100,
                "kind": "expense",
                "category_id": cat_a["id"],
                "occurred_at": "2026-03-15",
            },
            headers=headers_b,
        )
        missing = await client.post(
            "/transactions",
            json={
                "amount_minor": 100,
                "kind": "expense",
                "category_id": str(uuid.uuid4()),
                "occurred_at": "2026-03-15",
            },
            headers=headers_b,
        )

        # No-oracle: byte-identical status AND body for foreign vs nonexistent.
        assert foreign.status_code == 422
        assert missing.status_code == 422
        assert foreign.json() == missing.json() == {"detail": "CATEGORY_NOT_FOUND"}

    async def test_create_rejects_archived_category(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "archcat@x.com")
        cat = await _create_category(client, headers, name="Retired")
        await _archive_category(client, headers, cat["id"])

        resp = await client.post(
            "/transactions",
            json={
                "amount_minor": 100,
                "kind": "expense",
                "category_id": cat["id"],
                "occurred_at": "2026-03-15",
            },
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "CATEGORY_ARCHIVED"

    async def test_create_allows_null_category_uncategorized(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "uncat@x.com")
        body = await _create_tx(client, headers, category_id=None)
        assert body["category_id"] is None

    async def test_create_rejects_zero_amount(self, client: AsyncClient) -> None:
        # Deferred-policy pin (decision h): the zero-amount API bound was explicitly
        # deferred from 1.2 to this task; a loosened ge=1 goes red in CI here.
        headers, _ = await _register_and_login(client, "zero@x.com")
        resp = await client.post(
            "/transactions",
            json={"amount_minor": 0, "kind": "expense", "occurred_at": "2026-03-15"},
            headers=headers,
        )
        assert resp.status_code == 422, resp.text


class TestUpdateTransaction:
    async def test_patch_cross_user_and_missing_both_404(
        self, client: AsyncClient
    ) -> None:
        headers_a, _ = await _register_and_login(client, "atx@x.com")
        tx = await _create_tx(client, headers_a)

        headers_b, _ = await _register_and_login(client, "btx@x.com")
        cross_user = await client.patch(
            f"/transactions/{tx['id']}", json={"amount_minor": 9}, headers=headers_b
        )
        missing = await client.patch(
            f"/transactions/{uuid.uuid4()}", json={"amount_minor": 9}, headers=headers_b
        )

        # No-oracle: byte-identical status AND body for cross-user vs nonexistent.
        assert cross_user.status_code == 404
        assert missing.status_code == 404
        assert (
            cross_user.json() == missing.json() == {"detail": "TRANSACTION_NOT_FOUND"}
        )

    async def test_patch_null_clears_category_and_note_omitted_preserves(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "patchnull@x.com")
        cat = await _create_category(client, headers, name="Groceries")
        tx = await _create_tx(
            client, headers, amount_minor=700, category_id=cat["id"], note="lunch"
        )

        cleared_cat = await client.patch(
            f"/transactions/{tx['id']}", json={"category_id": None}, headers=headers
        )
        assert cleared_cat.status_code == 200, cleared_cat.text
        body = cleared_cat.json()
        assert body["category_id"] is None  # explicit null cleared it
        assert body["note"] == "lunch"  # omitted note preserved
        assert body["amount_minor"] == 700  # omitted amount preserved
        assert body["kind"] == "expense"  # omitted kind preserved

        cleared_note = await client.patch(
            f"/transactions/{tx['id']}", json={"note": None}, headers=headers
        )
        assert cleared_note.status_code == 200, cleared_note.text
        assert cleared_note.json()["note"] is None  # explicit null cleared note

    async def test_patch_null_on_not_null_fields_422(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "notnull@x.com")
        tx = await _create_tx(client, headers)

        amount_null = await client.patch(
            f"/transactions/{tx['id']}", json={"amount_minor": None}, headers=headers
        )
        assert amount_null.status_code == 422, amount_null.text
        assert amount_null.json()["detail"] == "AMOUNT_REQUIRED"

        kind_null = await client.patch(
            f"/transactions/{tx['id']}", json={"kind": None}, headers=headers
        )
        assert kind_null.status_code == 422, kind_null.text
        assert kind_null.json()["detail"] == "KIND_REQUIRED"

        occurred_null = await client.patch(
            f"/transactions/{tx['id']}", json={"occurred_at": None}, headers=headers
        )
        assert occurred_null.status_code == 422, occurred_null.text
        assert occurred_null.json()["detail"] == "OCCURRED_AT_REQUIRED"

    async def test_patch_category_validation(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "patchcat@x.com")
        cat = await _create_category(client, headers, name="WillArchive")
        tx = await _create_tx(client, headers, category_id=cat["id"])

        # (a) category archived AFTER the fact; amount-only edit must NOT revalidate
        # the category (decision e — category_id absent from the field set).
        await _archive_category(client, headers, cat["id"])
        amount_edit = await client.patch(
            f"/transactions/{tx['id']}", json={"amount_minor": 4242}, headers=headers
        )
        assert amount_edit.status_code == 200, amount_edit.text
        assert amount_edit.json()["amount_minor"] == 4242

        # (b) repointing category_id to a foreign uuid IS validated → 422.
        repoint = await client.patch(
            f"/transactions/{tx['id']}",
            json={"category_id": str(uuid.uuid4())},
            headers=headers,
        )
        assert repoint.status_code == 422, repoint.text
        assert repoint.json()["detail"] == "CATEGORY_NOT_FOUND"


class TestDeleteTransaction:
    async def test_delete_removes_row_and_no_oracle_404(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers_a, _ = await _register_and_login(client, "deltx@x.com")
        tx = await _create_tx(client, headers_a)

        deleted = await client.delete(f"/transactions/{tx['id']}", headers=headers_a)
        assert deleted.status_code == 204, deleted.text
        assert deleted.content == b""
        gone = await db_session.scalar(
            text("SELECT id FROM transactions WHERE id = :id"),
            {"id": uuid.UUID(tx["id"])},
        )
        assert gone is None  # real delete

        # Now-missing id and a cross-user delete both → identical 404 (no-oracle).
        again = await client.delete(f"/transactions/{tx['id']}", headers=headers_a)
        headers_b, _ = await _register_and_login(client, "delspy@x.com")
        other = await _create_tx(client, headers_b)
        cross_user = await client.delete(
            f"/transactions/{other['id']}", headers=headers_a
        )

        assert again.status_code == 404
        assert cross_user.status_code == 404
        assert again.json() == cross_user.json() == {"detail": "TRANSACTION_NOT_FOUND"}


class TestListTransactions:
    async def test_list_envelope_ordering_isolation_pagination(
        self, client: AsyncClient
    ) -> None:
        headers_a, _ = await _register_and_login(client, "lista@x.com")
        await _create_tx(client, headers_a, occurred_at="2026-01-10")
        await _create_tx(client, headers_a, occurred_at="2026-03-10")
        await _create_tx(client, headers_a, occurred_at="2026-02-10")

        headers_b, _ = await _register_and_login(client, "listb@x.com")
        await _create_tx(client, headers_b, occurred_at="2026-03-10")

        resp = await client.get("/transactions", headers=headers_a)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 3  # userB's row excluded (isolation)
        dates = [item["occurred_at"] for item in body["items"]]
        assert dates == ["2026-03-10", "2026-02-10", "2026-01-10"]  # occurred_at DESC

        page = await client.get(
            "/transactions", params={"limit": 1, "offset": 1}, headers=headers_a
        )
        assert page.status_code == 200, page.text
        page_body = page.json()
        assert page_body["total"] == 3  # total unaffected by paging
        assert len(page_body["items"]) == 1
        assert page_body["items"][0]["occurred_at"] == "2026-02-10"  # 2nd newest

    async def test_list_filters_period_category_kind(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "filter@x.com")
        cat = await _create_category(client, headers, name="Filtered")
        # Neighbors sit one day outside each inclusive bound; the in-range rows sit
        # exactly ON the edges, so a strict >/< regression would drop them and fail.
        await _create_tx(client, headers, occurred_at="2026-01-31")  # before "from"
        low_edge = await _create_tx(
            client, headers, occurred_at="2026-02-01", kind="income"
        )  # == "from"
        high_edge = await _create_tx(
            client, headers, occurred_at="2026-02-28", category_id=cat["id"]
        )  # == "to"
        await _create_tx(client, headers, occurred_at="2026-03-01")  # after "to"

        period = await client.get(
            "/transactions",
            params={"from": "2026-02-01", "to": "2026-02-28"},
            headers=headers,
        )
        assert period.status_code == 200, period.text
        period_body = period.json()
        assert period_body["total"] == 2  # inclusive bounds keep both edge rows
        assert [item["id"] for item in period_body["items"]] == [
            high_edge["id"],
            low_edge["id"],
        ]  # occurred_at DESC

        by_cat = await client.get(
            "/transactions", params={"category_id": cat["id"]}, headers=headers
        )
        assert by_cat.json()["total"] == 1
        assert by_cat.json()["items"][0]["id"] == high_edge["id"]

        by_kind = await client.get(
            "/transactions", params={"kind": "income"}, headers=headers
        )
        assert by_kind.json()["total"] == 1
        assert by_kind.json()["items"][0]["id"] == low_edge["id"]

        # Foreign category_id filter just filters → empty (READ filter, no oracle).
        foreign = await client.get(
            "/transactions", params={"category_id": str(uuid.uuid4())}, headers=headers
        )
        assert foreign.status_code == 200, foreign.text
        assert foreign.json() == {"items": [], "total": 0}


class TestSummary:
    async def test_summary_totals_uncategorized_and_refund(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "summary@x.com")
        cat = await _create_category(client, headers, name="Shopping")

        # In-month: an expense on the category, an income (refund) on the SAME
        # expense category, and an uncategorized expense.
        await _create_tx(
            client,
            headers,
            amount_minor=1000,
            kind="expense",
            category_id=cat["id"],
            occurred_at="2026-03-05",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=300,
            kind="income",
            category_id=cat["id"],
            occurred_at="2026-03-10",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=500,
            kind="expense",
            category_id=None,
            occurred_at="2026-03-20",
        )
        # Out-of-month: must be excluded from the March totals.
        await _create_tx(
            client, headers, amount_minor=9999, kind="expense", occurred_at="2026-04-01"
        )

        resp = await client.get(
            "/transactions/summary", params={"month": "2026-03"}, headers=headers
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["month"] == "2026-03"
        assert body["currency"] == "RUB"
        assert body["income_minor"] == 300  # refund counted as income, not netted
        assert body["expense_minor"] == 1500  # 1000 + 500, April tx excluded
        assert body["net_minor"] == -1200  # signed: 300 - 1500

        buckets = {
            (b["category_id"], b["kind"]): b["total_minor"] for b in body["by_category"]
        }
        assert buckets[(cat["id"], "expense")] == 1000
        assert buckets[(cat["id"], "income")] == 300  # refund bucket, same category
        assert buckets[(None, "expense")] == 500  # uncategorized bucket

    async def test_summary_empty_month_returns_zeros(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # AM-1: pins the read-only base-currency fallback for a profile-less user AND
        # that a GET does NOT create a profile (the write-on-GET asymmetry).
        headers, user_id = await _register_and_login(client, "emptymonth@x.com")
        await db_session.execute(
            text("DELETE FROM profiles WHERE user_id = :uid"), {"uid": user_id}
        )
        await db_session.commit()

        resp = await client.get(
            "/transactions/summary", params={"month": "2026-03"}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["income_minor"] == 0
        assert body["expense_minor"] == 0
        assert body["net_minor"] == 0
        assert body["by_category"] == []
        assert body["currency"] == "RUB"  # read-only DEFAULT_BASE_CURRENCY fallback

        still_absent = await db_session.scalar(
            text("SELECT user_id FROM profiles WHERE user_id = :uid"), {"uid": user_id}
        )
        assert still_absent is None  # the GET wrote nothing


class TestAuth:
    async def test_requires_auth(self, client: AsyncClient) -> None:
        # Once per router, per conventions.
        resp = await client.get("/transactions")
        assert resp.status_code == 401
