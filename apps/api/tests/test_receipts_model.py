"""Receipts/merchant-map schema contracts — real Postgres, real migrations, no mocks.

Pins only the genuinely-breakable DDL of migration 0004 (architecture D1/D3): the
``receipts.status`` CHECK (its value set must match ``ReceiptStatus`` byte-for-byte),
the new FK cascade graph (the per-row ``DELETE FROM users`` isolation the whole
suite relies on must still clear both new tables), and the ``merchant_category_map``
composite PK as the ``ON CONFLICT (user_id, merchant_norm)`` upsert target S4 needs.
No column-existence smoke tests, no FK-name assertions (migration + ``alembic check``
own those). ``TestNormalizeMerchant`` unit-tests the pure D4 normalizer that both
S3 (read) and S4 (write) call (AM-3: moved into S1).
"""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.merchant import normalize_merchant
from budget_api.models import Category, MerchantCategoryMap, Receipt


async def _create_user(db_session: AsyncSession, email: str) -> uuid.UUID:
    """Insert a bare user via raw SQL (no register hook, so no profile side effect)."""
    user_id = uuid.uuid4()
    await db_session.execute(
        text(
            "INSERT INTO users (id, email, hashed_password) VALUES (:id, :email, :pw)"
        ),
        {"id": user_id, "email": email, "pw": "x"},
    )
    await db_session.commit()
    return user_id


class TestReceiptConstraints:
    async def test_status_check_rejects_unknown(self, db_session: AsyncSession) -> None:
        user_id = await _create_user(db_session, "status@x.com")
        db_session.add(
            Receipt(
                user_id=user_id,
                storage_path=f"{user_id}/{uuid.uuid4()}.jpg",
                status="bogus",  # not in ReceiptStatus -> CHECK must reject
            )
        )
        with pytest.raises(IntegrityError, match="ck_receipts_status_valid"):
            await db_session.commit()


class TestForeignKeys:
    async def test_user_delete_cascades_receipts_and_map(
        self, db_session: AsyncSession
    ) -> None:
        user_id = await _create_user(db_session, "cascade@x.com")
        category = Category(user_id=user_id, name="Custom", kind="expense")
        db_session.add(category)
        await db_session.flush()  # populate category.id before referencing it
        db_session.add(
            Receipt(
                user_id=user_id,
                storage_path=f"{user_id}/{uuid.uuid4()}.jpg",
                status="pending",
            )
        )
        db_session.add(
            MerchantCategoryMap(
                user_id=user_id, merchant_norm="acme", category_id=category.id
            )
        )
        await db_session.commit()

        await db_session.execute(
            text("DELETE FROM users WHERE id = :id"), {"id": user_id}
        )
        await db_session.commit()

        for table in ("receipts", "merchant_category_map"):
            count = await db_session.scalar(
                text(f"SELECT count(*) FROM {table} WHERE user_id = :id"),
                {"id": user_id},
            )
            assert count == 0, table


class TestMerchantMapUpsert:
    async def test_merchant_map_composite_pk_conflict(
        self, db_session: AsyncSession
    ) -> None:
        user_id = await _create_user(db_session, "upsert@x.com")
        cat_a = Category(user_id=user_id, name="Groceries", kind="expense")
        cat_b = Category(user_id=user_id, name="Dining", kind="expense")
        db_session.add_all([cat_a, cat_b])
        await db_session.commit()

        # The composite PK (user_id, merchant_norm) is the ON CONFLICT target S4
        # upserts against: a second insert for the same pair updates in place.
        upsert = text(
            "INSERT INTO merchant_category_map "
            "(user_id, merchant_norm, category_id) "
            "VALUES (:user_id, :merchant_norm, :category_id) "
            "ON CONFLICT (user_id, merchant_norm) DO UPDATE "
            "SET category_id = EXCLUDED.category_id, updated_at = now()"
        )
        await db_session.execute(
            upsert,
            {"user_id": user_id, "merchant_norm": "acme", "category_id": cat_a.id},
        )
        await db_session.execute(
            upsert,
            {"user_id": user_id, "merchant_norm": "acme", "category_id": cat_b.id},
        )
        await db_session.commit()

        rows = (
            await db_session.execute(
                text(
                    "SELECT category_id FROM merchant_category_map WHERE user_id = :id"
                ),
                {"id": user_id},
            )
        ).all()
        assert len(rows) == 1
        assert rows[0].category_id == cat_b.id


class TestNormalizeMerchant:
    def test_casefold_and_strip(self) -> None:
        assert normalize_merchant("  ACME Corp  ") == "acme corp"

    def test_collapse_internal_whitespace(self) -> None:
        assert normalize_merchant("Acme\t\n  Corp") == "acme corp"

    def test_nfc_normalizes_equivalent_forms(self) -> None:
        # Same visible "café" spelled two ways: precomposed U+00E9 vs base 'e' +
        # U+0301 COMBINING ACUTE ACCENT. NFC must fold both to one lookup key so
        # the two spellings share a merchant-map entry. Built from explicit code
        # points so the assertion cannot depend on this file's byte encoding.
        precomposed = "Caf\u00e9"
        decomposed = "Cafe\u0301"
        assert precomposed != decomposed  # genuinely different byte sequences
        assert normalize_merchant(decomposed) == normalize_merchant(precomposed)
        assert normalize_merchant(precomposed) == "café"

    def test_empty_after_strip_is_no_merchant(self) -> None:
        assert normalize_merchant("   ") == ""
        assert normalize_merchant("") == ""
