"""Transaction CRUD + summary contracts — real Postgres, real migrations, no mocks.

Covers only what is unique to this router: currency stamping + forced ownership,
the profile self-heal (POST) and read-only fallback (GET), the no-oracle
byte-identity for the tx 404 and the body-category 422, the archived-target and
model_fields_set null/omit mechanics, list envelope/ordering/isolation/pagination
and read-filter behavior (S3 added `q`/`country`/`sort`), and the summary
aggregate (refund + uncategorized + range). Since 3.2 also: the D5 base-snapshot
decision tables (create + PATCH) and the D9 three-bucket converted summary.
Pure-Pydantic rejections (note>500, bad kind/date/month/currency, limit/offset
bounds) are QA-curl-owned per the grooming split.

Rates are seeded as ``exchange_rates`` rows (no fetcher, scheduler off). Only the
canonical RUB→USD direction is ever stored, so every USD→RUB number below rides
the inversion path exactly as production does: stored 0.0125 ⇒ 80 RUB per USD.
"""

import csv
import io
import uuid
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from helpers import account_for_currency, add_account
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import ExchangeRate, Transaction
from budget_api.schemas.transaction import MAX_MINOR_AMOUNT

PASSWORD = "password123"

_RATE_DAY = date(2026, 3, 1)
#: Stored RUB→USD; its inverse (80.00 RUB per USD) is what the snapshot math uses.
_RUB_USD = "0.0125"


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
    if "account_id" not in body:
        # Every row needs an account, and the row's currency is stamped FROM it
        # (architecture §4) — so the account must match whatever currency the test
        # asked for.
        body["account_id"] = await account_for_currency(
            client, headers, body.get("currency")
        )
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _seed_rate(
    session: AsyncSession, base: str, quote: str, rate: str, as_of: date = _RATE_DAY
) -> None:
    session.add(
        ExchangeRate(
            base=base,
            quote=quote,
            as_of_date=as_of,
            rate=Decimal(rate),
            provider="test",
        )
    )
    await session.commit()


def _read_export(resp: Response) -> list[dict[str, str]]:
    """Parse a /transactions/export body the way a spreadsheet would.

    ``utf-8-sig`` consumes the BOM; ``csv.DictReader`` re-derives the field names
    from the header line, so a column renamed in the router shows up here as a
    KeyError rather than as a silently shifted assertion.
    """
    return list(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))))


async def _stored_snapshot(
    session: AsyncSession, transaction_id: str
) -> tuple[int | None, str | None, str]:
    """(base_amount_minor, base_currency, currency) straight from the row."""
    row = (
        await session.execute(
            text(
                "SELECT base_amount_minor, base_currency, currency "
                "FROM transactions WHERE id = :id"
            ),
            {"id": uuid.UUID(transaction_id)},
        )
    ).one()
    return row[0], row[1], row[2]


class TestCreateTransaction:
    async def test_create_stamps_currency_forces_owner_and_serializes(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "txcreate@x.com")
        cat = await _create_category(client, headers, name="Food")

        account_id = await account_for_currency(client, headers)

        resp = await client.post(
            "/transactions",
            json={
                "amount_minor": 2500,
                "kind": "expense",
                "account_id": account_id,
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
        account_b = await account_for_currency(client, headers_b)
        foreign = await client.post(
            "/transactions",
            json={
                "amount_minor": 100,
                "kind": "expense",
                "account_id": account_b,
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
                "account_id": account_b,
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
                "account_id": await account_for_currency(client, headers),
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
            json={
                "amount_minor": 0,
                "kind": "expense",
                "account_id": await account_for_currency(client, headers),
                "occurred_at": "2026-03-15",
            },
            headers=headers,
        )
        assert resp.status_code == 422, resp.text


class TestCreateSnapshot:
    """D5 create decision table — the base-currency snapshot pair."""

    async def test_create_foreign_currency_auto_snapshot(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "snapauto@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)

        body = await _create_tx(
            client, headers, amount_minor=1000, currency="USD", occurred_at="2026-03-15"
        )

        assert body["currency"] == "USD"  # stored as spent, not overwritten by base
        assert body["base_currency"] == "RUB"
        # 10.00 USD x (1 / 0.0125 = 80 RUB per USD) = 800.00 RUB.
        assert body["base_amount_minor"] == 80000

    async def test_create_override_wins(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "snapoverride@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)

        body = await _create_tx(
            client,
            headers,
            amount_minor=1000,
            currency="USD",
            base_amount_minor=79000,
            occurred_at="2026-03-15",
        )

        # Byte-for-byte as sent — the auto value for this exact input is 80000
        # (previous test), so the override demonstrably beat a computable rate.
        assert body["base_amount_minor"] == 79000
        assert body["base_currency"] == "RUB"

    async def test_create_no_rate_null_snapshot(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "snapnorate@x.com")

        auto = await _create_tx(client, headers, amount_minor=1000, currency="JPY")

        # D7 degradation: 201 with the NULL/NULL pair, never a guessed rate or a 500.
        assert auto["base_amount_minor"] is None
        assert auto["base_currency"] is None

        overridden = await _create_tx(
            client, headers, amount_minor=1000, currency="JPY", base_amount_minor=5000
        )

        # Contrast: a user override needs no rate at all — it IS the fact.
        assert overridden["base_amount_minor"] == 5000
        assert overridden["base_currency"] == "RUB"

    async def test_create_base_amount_without_currency_422(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "snapbase422@x.com")
        payload: dict[str, Any] = {
            "amount_minor": 1000,
            "kind": "expense",
            "account_id": await account_for_currency(client, headers),
            "occurred_at": "2026-03-15",
            "base_amount_minor": 500,
        }

        explicit = await client.post(
            "/transactions", json={**payload, "currency": "RUB"}, headers=headers
        )
        omitted = await client.post("/transactions", json=payload, headers=headers)

        # Explicit base currency and omitted currency are the same case (the row ends
        # up in the base currency), so both are rejected by the same rule.
        assert explicit.status_code == 422, explicit.text
        assert omitted.status_code == 422, omitted.text
        assert (
            explicit.json()
            == omitted.json()
            == {"detail": "BASE_AMOUNT_WITHOUT_CURRENCY"}
        )

    async def test_create_null_currency_backward_compatible(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "snapcompat@x.com")
        # A usable rate EXISTS — the pre-3.2 wire must still produce no snapshot,
        # not a redundant self-copy of the amount.
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)

        body = await _create_tx(client, headers, amount_minor=2500)

        assert body["currency"] == "RUB"
        assert body["base_amount_minor"] is None
        assert body["base_currency"] is None


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


class TestUpdateSnapshot:
    """D5 PATCH decision table — one test per row (rows 5/6 share an outcome)."""

    async def test_patch_account_to_base_currency_clears_snapshot(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Row 2 — reached by MOVING the row to a base-currency account, which is the
        # only way a currency changes since the accounts scope (architecture §4).
        headers, _ = await _register_and_login(client, "patchtobase@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)
        tx = await _create_tx(client, headers, amount_minor=1000, currency="USD")
        assert tx["base_amount_minor"] == 80000
        rub_account = await account_for_currency(client, headers, "RUB")

        resp = await client.patch(
            f"/transactions/{tx['id']}",
            json={"account_id": rub_account},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["account_id"] == rub_account
        assert body["currency"] == "RUB"  # restamped from the new account
        assert body["amount_minor"] == 1000  # the native amount is untouched
        # Cleared, NOT recomputed into 1000/RUB: a base-currency row's amount_minor
        # already is its base amount, and a copy would go stale on a base change.
        assert body["base_amount_minor"] is None
        assert body["base_currency"] is None

    async def test_patch_conversion_input_recomputes(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Row 6, three arms: amount change, date change across a rate boundary, and
        # (AM-3a) a date change to before any stored rate.
        headers, _ = await _register_and_login(client, "patchrecompute@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)  # 2026-03-01 → 80/USD
        await _seed_rate(db_session, "RUB", "USD", "0.01", date(2026, 3, 10))  # → 100
        tx = await _create_tx(
            client, headers, amount_minor=1000, currency="USD", occurred_at="2026-03-05"
        )
        assert tx["base_amount_minor"] == 80000

        amount_edit = await client.patch(
            f"/transactions/{tx['id']}", json={"amount_minor": 2000}, headers=headers
        )
        assert amount_edit.status_code == 200, amount_edit.text
        # 20.00 USD at the 03-05-effective rate (80) — the stale 80000 is gone.
        assert amount_edit.json()["base_amount_minor"] == 160000

        date_edit = await client.patch(
            f"/transactions/{tx['id']}",
            json={"occurred_at": "2026-03-15"},
            headers=headers,
        )
        assert date_edit.status_code == 200, date_edit.text
        # Recomputed at the NEW date's rate (100), proving eff_occurred_at is used.
        assert date_edit.json()["base_amount_minor"] == 200000

        before_any_rate = await client.patch(
            f"/transactions/{tx['id']}",
            json={"occurred_at": "2026-02-01"},
            headers=headers,
        )
        assert before_any_rate.status_code == 200, before_any_rate.text
        # AM-3a: no rate existed yet on that date → the snapshot is cleared rather
        # than left holding a value the new date cannot justify.
        assert before_any_rate.json()["base_amount_minor"] is None
        assert before_any_rate.json()["base_currency"] is None

    async def test_patch_override_survives_and_wins(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Row 4 beats row 6: an override sent together with a conversion input.
        headers, _ = await _register_and_login(client, "patchoverride@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)
        tx = await _create_tx(client, headers, amount_minor=1000, currency="USD")

        resp = await client.patch(
            f"/transactions/{tx['id']}",
            json={"amount_minor": 2000, "base_amount_minor": 12345},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["amount_minor"] == 2000
        assert body["base_amount_minor"] == 12345  # not the recomputed 160000
        assert body["base_currency"] == "RUB"

    async def test_patch_explicit_null_discards_override(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Row 5 — the un-override affordance (R1(1)).
        headers, _ = await _register_and_login(client, "patchunoverride@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)
        tx = await _create_tx(
            client,
            headers,
            amount_minor=1000,
            currency="USD",
            base_amount_minor=79000,
        )

        resp = await client.patch(
            f"/transactions/{tx['id']}",
            json={"base_amount_minor": None},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        # An explicit null recomputes — it does NOT clear the pair (which would
        # claim "no rate existed", a different fact).
        assert resp.json()["base_amount_minor"] == 80000
        assert resp.json()["base_currency"] == "RUB"

    async def test_patch_untouched_keeps_snapshot(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Row 7 — the contrast to row 5 above: omitted, not null.
        headers, _ = await _register_and_login(client, "patchkeep@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)
        tx = await _create_tx(
            client,
            headers,
            amount_minor=1000,
            currency="USD",
            base_amount_minor=79000,
        )

        resp = await client.patch(
            f"/transactions/{tx['id']}", json={"note": "receipt filed"}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["note"] == "receipt filed"
        assert resp.json()["base_amount_minor"] == 79000  # untouched, not 80000
        assert resp.json()["base_currency"] == "RUB"

    async def test_patch_account_to_foreign_currency_populates(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Row 6's populate arm: a NULL/NULL base-currency row moves to a foreign
        # account and gains a snapshot.
        headers, _ = await _register_and_login(client, "patchpopulate@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)
        tx = await _create_tx(client, headers, amount_minor=1000)
        assert tx["base_amount_minor"] is None

        resp = await client.patch(
            f"/transactions/{tx['id']}",
            json={"account_id": await account_for_currency(client, headers, "USD")},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["currency"] == "USD"
        assert resp.json()["base_amount_minor"] == 80000
        assert resp.json()["base_currency"] == "RUB"

    async def test_patch_currency_explicit_null_422(self, client: AsyncClient) -> None:
        # Row 1 — NOT NULL column, the *_REQUIRED house pattern.
        headers, _ = await _register_and_login(client, "patchcurnull@x.com")
        tx = await _create_tx(client, headers)

        resp = await client.patch(
            f"/transactions/{tx['id']}", json={"currency": None}, headers=headers
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "CURRENCY_REQUIRED"

    async def test_patch_to_base_account_with_override_422(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Row 3's eff_cur subtlety: the override is checked against the currency the
        # row WOULD have AFTER the account move, so the payload is rejected whole.
        headers, _ = await _register_and_login(client, "patchbase422@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)
        tx = await _create_tx(client, headers, amount_minor=1000, currency="USD")

        resp = await client.patch(
            f"/transactions/{tx['id']}",
            json={
                "account_id": await account_for_currency(client, headers, "RUB"),
                "base_amount_minor": 500,
            },
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "BASE_AMOUNT_WITHOUT_CURRENCY"
        # Nothing was half-applied: the currency change did not land either.
        assert await _stored_snapshot(db_session, tx["id"]) == (80000, "RUB", "USD")


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


class TestListSearch:
    """S3 ``?q=`` — substring over merchant OR note, case-insensitive, LITERAL."""

    async def test_q_matches_merchant_or_note_case_insensitively_in_cyrillic(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "search@x.com")
        by_merchant = await _create_tx(client, headers, merchant="Продукты рядом")
        # The needle sits INSIDE the note and in a different case than the query, so
        # a prefix-only or an ASCII-only case fold fails on this row alone. Cyrillic
        # is the interesting alphabet here: str.lower() in Python is not what runs —
        # Postgres folds per the database collation.
        by_note = await _create_tx(client, headers, note="Купил ПРОДУКТЫ на неделю")
        await _create_tx(client, headers, merchant="Coffee", note="latte")

        resp = await client.get(
            "/transactions", params={"q": "продукты"}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 2
        assert {item["id"] for item in body["items"]} == {
            by_merchant["id"],
            by_note["id"],
        }

    async def test_q_treats_like_wildcards_as_literal_text(
        self, client: AsyncClient
    ) -> None:
        """``%`` and ``_`` are DATA, not a pattern language the search box exposes."""
        headers, _ = await _register_and_login(client, "wildcard@x.com")
        literal_percent = await _create_tx(client, headers, merchant="Скидка 100%")
        await _create_tx(client, headers, merchant="Скидка 1000")
        literal_underscore = await _create_tx(client, headers, merchant="a_b")
        # Unescaped, `a_b` matches this row too — `_` is LIKE's single-character
        # wildcard. It is the contrast that proves the escaping, not the row count.
        await _create_tx(client, headers, merchant="axb")

        percent = await client.get(
            "/transactions", params={"q": "100%"}, headers=headers
        )
        underscore = await client.get(
            "/transactions", params={"q": "a_b"}, headers=headers
        )

        assert [item["id"] for item in percent.json()["items"]] == [
            literal_percent["id"]
        ]
        assert [item["id"] for item in underscore.json()["items"]] == [
            literal_underscore["id"]
        ]

    async def test_q_never_reaches_another_users_matching_row(
        self, client: AsyncClient
    ) -> None:
        """A new WHERE arm is exactly where a user_id scope gets lost."""
        headers_a, _ = await _register_and_login(client, "searchmine@x.com")
        mine = await _create_tx(client, headers_a, merchant="Кофейня Ромашка")
        headers_b, _ = await _register_and_login(client, "searchyours@x.com")
        await _create_tx(client, headers_b, merchant="Кофейня Ромашка")

        resp = await client.get(
            "/transactions", params={"q": "кофейня"}, headers=headers_a
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["total"] == 1  # not 2 — the count shares the filter set
        assert [item["id"] for item in resp.json()["items"]] == [mine["id"]]

    async def test_q_combines_with_category_and_period_including_total(
        self, client: AsyncClient
    ) -> None:
        """AND-composition, and ``total`` counts the SAME set the items come from."""
        headers, _ = await _register_and_login(client, "searchcombo@x.com")
        cat = await _create_category(client, headers, name="Groceries")
        wanted = await _create_tx(
            client,
            headers,
            merchant="Кофейня Ромашка",
            category_id=cat["id"],
            occurred_at="2026-02-10",
        )
        # One row fails exactly one of the three conditions each — a filter dropped
        # from the WHERE (or from the count) shows up as one of these coming back.
        await _create_tx(
            client,
            headers,
            merchant="Аптека",
            category_id=cat["id"],
            occurred_at="2026-02-11",
        )
        await _create_tx(
            client, headers, merchant="Кофейня Ромашка", occurred_at="2026-02-12"
        )
        await _create_tx(
            client,
            headers,
            merchant="Кофейня Ромашка",
            category_id=cat["id"],
            occurred_at="2026-03-01",
        )

        resp = await client.get(
            "/transactions",
            params={
                "q": "кофейня",
                "category_id": cat["id"],
                "from": "2026-02-01",
                "to": "2026-02-28",
            },
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["total"] == 1
        assert [item["id"] for item in resp.json()["items"]] == [wanted["id"]]


class TestListCountryFilter:
    async def test_country_filters_exactly_and_rejects_malformed_input(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "country@x.com")
        polish = await _create_tx(client, headers, country="PL")
        await _create_tx(client, headers, country="DE")
        await _create_tx(client, headers)  # no country at all

        resp = await client.get(
            "/transactions", params={"country": "PL"}, headers=headers
        )
        # Format-only validation, no normalization (COUNTRY_PATTERN): a lowercase or
        # alpha-3 code is a 422 at the edge, NOT a silent uppercase and NOT an empty
        # 200 — the stored column can only ever hold the uppercase alpha-2 spelling.
        lowercase = await client.get(
            "/transactions", params={"country": "pl"}, headers=headers
        )
        alpha3 = await client.get(
            "/transactions", params={"country": "POL"}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        assert [item["id"] for item in resp.json()["items"]] == [polish["id"]]
        assert lowercase.status_code == 422
        assert alpha3.status_code == 422


class TestListSort:
    async def test_sort_by_amount_falls_back_to_newest_first_on_ties(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "sortamount@x.com")
        big = await _create_tx(
            client, headers, amount_minor=5000, occurred_at="2026-01-05"
        )
        # Two rows share an amount and differ only in date: this pair is what pins
        # the secondary key, without which offset paging can repeat or skip a row.
        tie_old = await _create_tx(
            client, headers, amount_minor=2000, occurred_at="2026-01-01"
        )
        tie_new = await _create_tx(
            client, headers, amount_minor=2000, occurred_at="2026-01-09"
        )
        small = await _create_tx(
            client, headers, amount_minor=100, occurred_at="2026-01-07"
        )

        desc = await client.get(
            "/transactions", params={"sort": "amount_desc"}, headers=headers
        )
        asc = await client.get(
            "/transactions", params={"sort": "amount_asc"}, headers=headers
        )

        assert desc.status_code == 200, desc.text
        assert [item["id"] for item in desc.json()["items"]] == [
            big["id"],
            tie_new["id"],
            tie_old["id"],
            small["id"],
        ]
        # The tie pair keeps its newest-first order in BOTH directions: the fallback
        # is the date_desc key, not "the whole ORDER BY reversed".
        assert [item["id"] for item in asc.json()["items"]] == [
            small["id"],
            tie_new["id"],
            tie_old["id"],
            big["id"],
        ]

    async def test_date_asc_mirrors_the_default_and_omitting_sort_changes_nothing(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "sortdate@x.com")
        old = await _create_tx(client, headers, occurred_at="2026-01-01")
        # Same day, created second: the created_at tiebreak (not the id) is what
        # decides these two, in both directions.
        same_day_first = await _create_tx(client, headers, occurred_at="2026-02-01")
        same_day_second = await _create_tx(client, headers, occurred_at="2026-02-01")

        default = await client.get("/transactions", headers=headers)
        explicit = await client.get(
            "/transactions", params={"sort": "date_desc"}, headers=headers
        )
        ascending = await client.get(
            "/transactions", params={"sort": "date_asc"}, headers=headers
        )

        # An omitted `sort` must reproduce the pre-S3 ordering exactly — nobody's
        # list is allowed to reshuffle because a parameter was added.
        assert [item["id"] for item in default.json()["items"]] == [
            same_day_second["id"],
            same_day_first["id"],
            old["id"],
        ]
        assert explicit.json() == default.json()
        assert [item["id"] for item in ascending.json()["items"]] == [
            old["id"],
            same_day_first["id"],
            same_day_second["id"],
        ]


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

        # All-base month: identical to the pre-3.2 semantics, nothing excluded.
        assert body["unconverted_count"] == 0

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

    async def test_summary_month_outside_year_envelope_is_422_not_500(
        self, client: AsyncClient
    ) -> None:
        # Pre-existing bug pin: `month=9999-12` made `date(year + (mon == 12), ...)`
        # overflow `date` and answered 500. MONTH_PATTERN now carries the shared
        # 1970..2999 envelope, so the boundary rejects it (AM-6). The 2026-03
        # requests above are the contrast arm — the endpoint itself still answers.
        headers, _ = await _register_and_login(client, "summaryenvelope@x.com")

        resp = await client.get(
            "/transactions/summary", params={"month": "9999-12"}, headers=headers
        )

        assert resp.status_code == 422, resp.text


class TestSummaryConverted:
    """D9 — the three aggregation buckets and the exclude-and-flag rule."""

    async def test_summary_buckets_and_flag(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "sumbuckets@x.com")
        cat_a = await _create_category(client, headers, name="A")
        cat_b = await _create_category(client, headers, name="B")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)  # USD→RUB = 80

        # (a) bucket 1 — native base currency.
        await _create_tx(
            client,
            headers,
            amount_minor=1000,
            category_id=cat_a["id"],
            occurred_at="2026-03-05",
        )
        # (b) bucket 2 — foreign row whose stored snapshot is a USER OVERRIDE; the
        # override (12345), not a recompute (700 x 80 = 56000), must be summed.
        await _create_tx(
            client,
            headers,
            amount_minor=700,
            currency="USD",
            base_amount_minor=12345,
            category_id=cat_b["id"],
            occurred_at="2026-03-06",
        )
        # (c) bucket 3 — created while EUR had no rate (so the row carries no
        # snapshot); the rate appears afterwards and the fold-in converts at read
        # time: 10.00 EUR x (1 / 0.02 = 50) = 500.00 RUB.
        await _create_tx(
            client,
            headers,
            amount_minor=1000,
            kind="income",
            currency="EUR",
            category_id=cat_a["id"],
            occurred_at="2026-03-07",
        )
        await _seed_rate(db_session, "RUB", "EUR", "0.02")
        # (d) bucket 3 with no rate at all — excluded from every sum, counted once.
        await _create_tx(
            client,
            headers,
            amount_minor=500,
            currency="JPY",
            category_id=cat_b["id"],
            occurred_at="2026-03-08",
        )
        # (e) bucket 1 SHARING (c)'s (cat_a, income) bucket: the SQL pass puts 2000
        # there and (c)'s fold-in must ACCUMULATE onto it (2000 + 50000), not
        # overwrite it (which would silently yield 50000).
        await _create_tx(
            client,
            headers,
            amount_minor=2000,
            kind="income",
            category_id=cat_a["id"],
            occurred_at="2026-03-09",
        )
        # (f) a SECOND rateless row — pins that unconverted_count accumulates
        # (2), not that it is assigned 1 per rateless row found.
        await _create_tx(
            client,
            headers,
            amount_minor=300,
            currency="KRW",
            category_id=cat_b["id"],
            occurred_at="2026-03-10",
        )

        resp = await client.get(
            "/transactions/summary", params={"month": "2026-03"}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["currency"] == "RUB"
        assert body["income_minor"] == 52000  # (e) 2000 + (c) 50000 folded onto it
        assert body["expense_minor"] == 13345  # (a) 1000 + (b) 12345; (d)+(f) excluded
        assert body["net_minor"] == 38655  # 52000 - 13345

        assert body["unconverted_count"] == 2  # (d) and (f)

        buckets = {
            (b["category_id"], b["kind"]): b["total_minor"] for b in body["by_category"]
        }
        assert buckets == {
            (cat_a["id"], "expense"): 1000,
            (cat_b["id"], "expense"): 12345,  # (b) alone — (d)/(f) leak nothing in
            (cat_a["id"], "income"): 52000,  # merged: 2000 (SQL) + 50000 (fold-in)
        }  # exact dict: the rateless rows add no bucket of their own, not even a zero

    async def test_summary_stale_base_snapshot_falls_back(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Snapshots written before a base-currency change (base_currency != the
        # current profile base) are unusable — seeded directly, since no API path
        # produces them today.
        headers, user_id = await _register_and_login(client, "sumstale@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)
        usd = await add_account(db_session, user_id, "USD")
        jpy = await add_account(db_session, user_id, "JPY")
        db_session.add_all(
            [
                Transaction(
                    user_id=user_id,
                    account_id=usd.id,
                    amount_minor=1000,
                    kind="expense",
                    currency="USD",
                    occurred_at=date(2026, 3, 5),
                    base_amount_minor=999999,  # EUR-era value, must never be summed
                    base_currency="EUR",
                ),
                Transaction(
                    user_id=user_id,
                    account_id=jpy.id,
                    amount_minor=500,
                    kind="expense",
                    currency="JPY",  # AM-3b: stale AND rateless
                    occurred_at=date(2026, 3, 6),
                    base_amount_minor=777,
                    base_currency="EUR",
                ),
            ]
        )
        await db_session.commit()

        resp = await client.get(
            "/transactions/summary", params={"month": "2026-03"}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        # The NATIVE amount converted at display time (10.00 USD x 80), never the
        # stale 999999 and never 999999 + 777.
        assert body["expense_minor"] == 80000
        assert body["net_minor"] == -80000
        # AM-3b: the rateless stale row is excluded and flagged — its stale 777 is
        # not quietly reused as a base-currency value either.
        assert body["unconverted_count"] == 1
        assert body["by_category"] == [
            {"category_id": None, "kind": "expense", "total_minor": 80000}
        ]


class TestExport:
    """B3/D13 — GET /transactions/export: CSV, own session, chronological ASC."""

    async def test_export_rows_and_columns(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "export@x.com")
        await _seed_rate(db_session, "RUB", "USD", _RUB_USD)  # USD→RUB = 80
        cat = await _create_category(client, headers, name="Food")
        gone = await _create_category(client, headers, name="Retired")

        # (a) base-currency row: RUB is exponent 2, so 1250 minor is "12.50"; a
        # base-currency row carries NO snapshot by design (D5), hence empty base cells.
        base_row = await _create_tx(
            client,
            headers,
            amount_minor=1250,
            currency="RUB",
            category_id=cat["id"],
            merchant="Пятёрочка",
            note="хлеб",
            occurred_at="2026-03-01",
        )
        # (b) foreign row WITH a snapshot: 10.00 USD x 80 = 800.00 RUB, and the base
        # cell renders at RUB's exponent while `amount` renders at USD's.
        snap_row = await _create_tx(
            client,
            headers,
            amount_minor=1000,
            currency="USD",
            category_id=cat["id"],
            occurred_at="2026-03-02",
        )
        # (c) foreign row with NO rate → NULL snapshot → both base cells EMPTY (never
        # a 0, and never a re-conversion at read time).
        null_row = await _create_tx(
            client,
            headers,
            amount_minor=1000,
            currency="EUR",
            category_id=cat["id"],
            occurred_at="2026-03-03",
        )
        # (d) archived category: still owns its history, so its NAME must survive.
        archived_row = await _create_tx(
            client, headers, category_id=gone["id"], occurred_at="2026-03-04"
        )
        await _archive_category(client, headers, gone["id"])
        # (e) uncategorized, no merchant, no note → three empty cells.
        bare_row = await _create_tx(client, headers, occurred_at="2026-03-05")
        # (f) JPY is exponent 0: the SAME 1250 minor units are "1250", not "12.50" —
        # the 100x cross-currency contrast against (a), in one fixture.
        jpy_row = await _create_tx(
            client, headers, amount_minor=1250, currency="JPY", occurred_at="2026-03-06"
        )
        # (g) the original leg (S1) + country (S2): the settlement amount renders at
        # the ROW's exponent and the original at ITS OWN, in the same line — 5000
        # minor JPY is "5000" while the same 5000 minor RUB above is "50.00".
        original_row = await _create_tx(
            client,
            headers,
            amount_minor=5000,
            currency="RUB",
            original_amount_minor=5000,
            original_currency="JPY",
            country="JP",
            occurred_at="2026-03-07",
        )

        resp = await client.get("/transactions/export", headers=headers)

        assert resp.status_code == 200, resp.text
        text_body = resp.content.decode("utf-8-sig")
        assert text_body.split("\r\n")[0] == (
            "id,occurred_at,kind,amount,currency,"
            "base_amount,base_currency,category,merchant,note,"
            "account,counter_account,counter_amount,"
            "original_amount,original_currency,country"
        )
        rows = {row["id"]: row for row in _read_export(resp)}

        assert rows[base_row["id"]] == {
            "id": base_row["id"],
            "occurred_at": "2026-03-01",
            "kind": "expense",
            "amount": "12.50",
            "currency": "RUB",
            "base_amount": "",
            "base_currency": "",
            "category": "Food",
            "merchant": "Пятёрочка",
            "note": "хлеб",
            "account": "Account RUB",
            # A non-transfer has no second leg: two empty cells, never a zero
            # (tests/test_transfers.py owns the populated contrast).
            "counter_account": "",
            "counter_amount": "",
            # No original leg either — empty, never a zero and never a repeat of
            # the settlement amount.
            "original_amount": "",
            "original_currency": "",
            "country": "",
        }
        assert rows[snap_row["id"]]["amount"] == "10.00"
        assert rows[snap_row["id"]]["base_amount"] == "800.00"
        assert rows[snap_row["id"]]["base_currency"] == "RUB"
        assert rows[null_row["id"]]["amount"] == "10.00"
        assert rows[null_row["id"]]["base_amount"] == ""
        assert rows[null_row["id"]]["base_currency"] == ""
        assert rows[archived_row["id"]]["category"] == "Retired"
        assert rows[bare_row["id"]]["category"] == ""
        assert rows[bare_row["id"]]["merchant"] == ""
        assert rows[bare_row["id"]]["note"] == ""
        assert rows[jpy_row["id"]]["amount"] == "1250"  # vs "12.50" for the same minor
        assert rows[original_row["id"]]["amount"] == "50.00"  # RUB, exponent 2
        assert rows[original_row["id"]]["original_amount"] == "5000"  # JPY, exponent 0
        assert rows[original_row["id"]]["original_currency"] == "JPY"
        assert rows[original_row["id"]]["country"] == "JP"

    async def test_export_is_bom_prefixed_and_rfc4180(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "exportcsv@x.com")
        nasty = 'lunch, "big" one\nsecond line'
        await _create_tx(client, headers, note=nasty)

        resp = await client.get("/transactions/export", headers=headers)

        assert resp.status_code == 200, resp.text
        # AM-6: the two headers a browser download depends on.
        assert resp.headers["content-type"] == "text/csv; charset=utf-8"
        assert resp.headers["content-disposition"] == (
            'attachment; filename="transactions.csv"'
        )
        # Excel reads a BOM-less UTF-8 CSV as cp1251 and mangles every Cyrillic cell.
        assert resp.content.startswith(b"\xef\xbb\xbf")
        # The embedded comma/quote/newline survive the round-trip verbatim — the
        # quoting arm, which a hand-rolled ",".join would get wrong.
        rows = _read_export(resp)
        assert len(rows) == 1
        assert rows[0]["note"] == nasty
        # RFC-4180 terminators: header + one record, both CRLF-terminated. The note's
        # own bare \n sits INSIDE the quoted field and is not a third terminator.
        decoded = resp.content.decode("utf-8-sig")
        assert decoded.endswith("\r\n")
        assert decoded.count("\r\n") == 2

    async def test_export_order_is_chronological_asc(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "exportorder@x.com")
        for day in ("2026-01-10", "2026-03-10", "2026-02-10"):
            await _create_tx(client, headers, occurred_at=day)

        export = await client.get("/transactions/export", headers=headers)
        listed = await client.get("/transactions", headers=headers)

        assert export.status_code == 200, export.text
        # The deliberate deviation, pinned as such: a ledger reads oldest-first...
        assert [row["occurred_at"] for row in _read_export(export)] == [
            "2026-01-10",
            "2026-02-10",
            "2026-03-10",
        ]
        # ...while the list screen stays newest-first.
        assert [item["occurred_at"] for item in listed.json()["items"]] == [
            "2026-03-10",
            "2026-02-10",
            "2026-01-10",
        ]

    async def test_export_filters(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "exportfilter@x.com")
        cat = await _create_category(client, headers, name="Filtered")
        await _create_tx(client, headers, occurred_at="2026-01-31")
        income = await _create_tx(
            client, headers, occurred_at="2026-02-01", kind="income"
        )
        categorized = await _create_tx(
            client, headers, occurred_at="2026-02-28", category_id=cat["id"]
        )
        await _create_tx(client, headers, occurred_at="2026-03-01")

        period = await client.get(
            "/transactions/export",
            params={"from": "2026-02-01", "to": "2026-02-28"},
            headers=headers,
        )
        by_kind = await client.get(
            "/transactions/export", params={"kind": "income"}, headers=headers
        )
        by_cat = await client.get(
            "/transactions/export",
            params={"category_id": cat["id"]},
            headers=headers,
        )
        foreign_cat = await client.get(
            "/transactions/export",
            params={"category_id": str(uuid.uuid4())},
            headers=headers,
        )
        inverted = await client.get(
            "/transactions/export",
            params={"from": "2026-03-01", "to": "2026-01-01"},
            headers=headers,
        )

        # Inclusive bounds keep both edge rows; the neighbours one day out are gone.
        assert [row["id"] for row in _read_export(period)] == [
            income["id"],
            categorized["id"],
        ]
        assert [row["id"] for row in _read_export(by_kind)] == [income["id"]]
        assert [row["id"] for row in _read_export(by_cat)] == [categorized["id"]]
        # Read filters never error (decision l): a foreign category and an inverted
        # period each yield a header-only CSV with a 200 — contrasted against the
        # matching filters above, which returned rows.
        assert foreign_cat.status_code == 200, foreign_cat.text
        assert _read_export(foreign_cat) == []
        # Header line and nothing else — the last column is the last thing in the body.
        assert foreign_cat.content.decode("utf-8-sig").endswith("country\r\n")
        assert inverted.status_code == 200, inverted.text
        assert _read_export(inverted) == []

    async def test_export_search_and_country_filters(self, client: AsyncClient) -> None:
        """S3 filter parity: the file carries what the list showed, still
        oldest-first."""
        headers, _ = await _register_and_login(client, "exportsearch@x.com")
        # The amounts are ordered AGAINST the dates on purpose: if `sort` leaked in,
        # the amount_desc request below would return the two rows the other way round.
        older = await _create_tx(
            client,
            headers,
            merchant="Кофейня Ромашка",
            country="PL",
            occurred_at="2026-02-01",
            amount_minor=100,
        )
        newer = await _create_tx(
            client,
            headers,
            note="снова КОФЕЙНЯ",
            country="PL",
            occurred_at="2026-02-20",
            amount_minor=5000,
        )
        await _create_tx(client, headers, merchant="Аптека", country="PL")
        await _create_tx(client, headers, merchant="Кофейня Ромашка", country="DE")

        matched = await client.get(
            "/transactions/export",
            params={"q": "кофейня", "country": "PL"},
            headers=headers,
        )
        # `sort` is not a parameter of this route; FastAPI ignores what a route never
        # declared, so the file is oldest-first regardless of what the screen shows.
        sorted_attempt = await client.get(
            "/transactions/export",
            params={"q": "кофейня", "country": "PL", "sort": "amount_desc"},
            headers=headers,
        )

        assert matched.status_code == 200, matched.text
        assert [row["id"] for row in _read_export(matched)] == [
            older["id"],
            newer["id"],
        ]
        assert sorted_attempt.status_code == 200, sorted_attempt.text
        assert _read_export(sorted_attempt) == _read_export(matched)

    async def test_export_scoped_to_user_and_requires_auth(
        self, client: AsyncClient
    ) -> None:
        headers_a, _ = await _register_and_login(client, "exportmine@x.com")
        mine = await _create_tx(client, headers_a, occurred_at="2026-03-01")
        headers_b, _ = await _register_and_login(client, "exportyours@x.com")
        await _create_tx(client, headers_b, occurred_at="2026-03-02")

        resp = await client.get("/transactions/export", headers=headers_a)
        anonymous = await client.get("/transactions/export")

        assert resp.status_code == 200, resp.text
        assert [row["id"] for row in _read_export(resp)] == [mine["id"]]
        # No token-in-query arm exists (D13), so an unauthenticated export is a 401
        # even though the body would otherwise stream a 200.
        assert anonymous.status_code == 401


class TestAmountUpperBound:
    """D14 — the shared MAX_MINOR_AMOUNT cap on both user-supplied amounts."""

    @pytest.mark.parametrize("field", ["amount_minor", "base_amount_minor"])
    async def test_amount_upper_bound(self, client: AsyncClient, field: str) -> None:
        headers, _ = await _register_and_login(client, f"maxamount{field}@x.com")
        # A foreign currency so base_amount_minor is a legal override on both arms
        # (a base-currency row rejects it with BASE_AMOUNT_WITHOUT_CURRENCY).
        body: dict[str, Any] = {
            "amount_minor": 1000,
            "kind": "expense",
            "account_id": await account_for_currency(client, headers, "USD"),
            "currency": "USD",
            "occurred_at": "2026-03-15",
        }

        over = await client.post(
            "/transactions", json={**body, field: MAX_MINOR_AMOUNT + 1}, headers=headers
        )
        assert over.status_code == 422, over.text
        # Accept-at-max contrast: without it the rejection above would also pass
        # against a bound of 1.
        at_max = await client.post(
            "/transactions", json={**body, field: MAX_MINOR_AMOUNT}, headers=headers
        )
        assert at_max.status_code == 201, at_max.text


class TestAuth:
    async def test_requires_auth(self, client: AsyncClient) -> None:
        # Once per router, per conventions.
        resp = await client.get("/transactions")
        assert resp.status_code == 401
