"""Core data-model contracts — real Postgres, real migrations, no mocks.

Pins the load-bearing schema invariants of roadmap 1.2: the transaction magnitude/
kind/currency CHECKs (one per CHECK *class* — the profiles/categories twins are
structurally identical SQL and are proven live by QA, not re-asserted here), the
FK cascade graph (§6), the system-category seed (§4), and the register hook that
provisions a RUB profile (§2). The category-delete test is the §1 headline: when a
category is deleted the transaction survives uncategorized with its own ``kind``.
"""

import uuid
from datetime import date

import pytest
from helpers import add_account
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Category, Profile, Transaction

PRODUKTY_ID = uuid.UUID("ce814749-2554-40be-8952-3a63d505694f")


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


class TestConstraints:
    async def test_negative_amount_rejected(self, db_session: AsyncSession) -> None:
        user_id = await _create_user(db_session, "neg@x.com")
        account = await add_account(db_session, user_id)
        db_session.add(
            Transaction(
                user_id=user_id,
                account_id=account.id,
                amount_minor=-1,
                kind="expense",
                currency="RUB",
                occurred_at=date(2026, 7, 24),
            )
        )
        with pytest.raises(IntegrityError, match="ck_transactions_amount_minor"):
            await db_session.commit()

    async def test_invalid_kind_rejected(self, db_session: AsyncSession) -> None:
        user_id = await _create_user(db_session, "kind@x.com")
        account = await add_account(db_session, user_id)
        db_session.add(
            Transaction(
                user_id=user_id,
                account_id=account.id,
                amount_minor=100,
                # NOT "transfer": that became a legal third kind in the
                # accounts-and-transfers scope. This pins that the CHECK accepts
                # exactly the enum's three values and nothing else.
                kind="withdrawal",
                currency="RUB",
                occurred_at=date(2026, 7, 24),
            )
        )
        with pytest.raises(IntegrityError, match="ck_transactions_kind_valid"):
            await db_session.commit()

    async def test_bad_currency_format_rejected(self, db_session: AsyncSession) -> None:
        user_id = await _create_user(db_session, "cur@x.com")
        account = await add_account(db_session, user_id)
        db_session.add(
            Transaction(
                user_id=user_id,
                account_id=account.id,
                amount_minor=100,
                kind="expense",
                currency="usd",  # lowercase violates ^[A-Z]{3}$
                occurred_at=date(2026, 7, 24),
            )
        )
        with pytest.raises(IntegrityError, match="ck_transactions_currency_format"):
            await db_session.commit()


class TestOriginalLegConstraints:
    """S1 §2 — "half an original" is UNREPRESENTABLE, not merely router-refused.

    The router raises 422 for each of these, but the router is one of several
    writers (psql, a future importer, the materializer). These four insert straight
    through the ORM, which is the only way to prove the CHECK itself is what holds:
    the format twin is deliberately not re-asserted (identical SQL to
    ``currency_format`` above, proven live by QA).
    """

    @pytest.mark.parametrize(
        ("fields", "constraint"),
        [
            (
                {"original_amount_minor": 5000},
                "ck_transactions_original_pair",
            ),
            (
                {"original_currency": "EUR"},
                "ck_transactions_original_pair",
            ),
            (
                {"original_amount_minor": 0, "original_currency": "EUR"},
                "ck_transactions_original_amount_minor_positive",
            ),
            (
                # Same currency as the row: NULL already says that, and two
                # spellings of one fact would fork every reader of the pair.
                {"original_amount_minor": 5000, "original_currency": "RUB"},
                "ck_transactions_original_currency_differs",
            ),
        ],
    )
    async def test_illegal_original_rejected(
        self,
        db_session: AsyncSession,
        fields: dict[str, object],
        constraint: str,
    ) -> None:
        user_id = await _create_user(db_session, f"orig-{constraint}@x.com")
        account = await add_account(db_session, user_id)
        db_session.add(
            Transaction(
                user_id=user_id,
                account_id=account.id,
                amount_minor=100,
                kind="expense",
                currency="RUB",
                occurred_at=date(2026, 7, 24),
                **fields,
            )
        )
        with pytest.raises(IntegrityError, match=constraint):
            await db_session.commit()

    async def test_transfer_cannot_carry_an_original(
        self, db_session: AsyncSession
    ) -> None:
        # A transfer already carries its second leg in the counter trio; a third
        # amount on top of it would be unreconcilable against either.
        user_id = await _create_user(db_session, "orig-transfer@x.com")
        source = await add_account(db_session, user_id)
        target = await add_account(db_session, user_id, currency="USD", name="target")
        db_session.add(
            Transaction(
                user_id=user_id,
                account_id=source.id,
                amount_minor=10000,
                kind="transfer",
                currency="RUB",
                occurred_at=date(2026, 7, 24),
                counter_account_id=target.id,
                counter_amount_minor=125,
                counter_currency="USD",
                original_amount_minor=5000,
                original_currency="EUR",
            )
        )
        with pytest.raises(
            IntegrityError, match="ck_transactions_transfer_no_original"
        ):
            await db_session.commit()


class TestForeignKeys:
    async def test_user_delete_cascades(self, db_session: AsyncSession) -> None:
        user_id = await _create_user(db_session, "cascade@x.com")
        category = Category(user_id=user_id, name="Custom", kind="expense")
        db_session.add(Profile(user_id=user_id, base_currency="RUB"))
        db_session.add(category)
        account = await add_account(db_session, user_id)
        await db_session.flush()  # populate category.id before referencing it
        db_session.add(
            Transaction(
                user_id=user_id,
                account_id=account.id,
                amount_minor=500,
                kind="expense",
                currency="RUB",
                category_id=category.id,
                occurred_at=date(2026, 7, 24),
            )
        )
        await db_session.commit()

        await db_session.execute(
            text("DELETE FROM users WHERE id = :id"), {"id": user_id}
        )
        await db_session.commit()

        for table in ("profiles", "categories", "accounts", "transactions"):
            count = await db_session.scalar(
                text(f"SELECT count(*) FROM {table} WHERE user_id = :id"),
                {"id": user_id},
            )
            assert count == 0, table

    async def test_category_delete_sets_null_and_kind_survives(
        self, db_session: AsyncSession
    ) -> None:
        user_id = await _create_user(db_session, "setnull@x.com")
        category = Category(user_id=user_id, name="Groceries", kind="expense")
        db_session.add(category)
        account = await add_account(db_session, user_id)
        await db_session.flush()
        tx = Transaction(
            user_id=user_id,
            account_id=account.id,
            amount_minor=500,
            kind="expense",
            currency="RUB",
            category_id=category.id,
            occurred_at=date(2026, 7, 24),
        )
        db_session.add(tx)
        await db_session.commit()
        tx_id = tx.id

        await db_session.execute(
            text("DELETE FROM categories WHERE id = :id"), {"id": category.id}
        )
        await db_session.commit()

        row = (
            await db_session.execute(
                text("SELECT category_id, kind FROM transactions WHERE id = :id"),
                {"id": tx_id},
            )
        ).one()
        # Category gone -> category_id NULL, but kind (the §1 aggregation source of
        # truth) survives on the transaction: the transaction is now uncategorized.
        assert row.category_id is None
        assert row.kind == "expense"


class TestSystemCategories:
    async def test_seed_present_and_stable(self, db_session: AsyncSession) -> None:
        # Autouse _clean_tables ran before this test; a passing count==18 therefore
        # also proves the seed survives per-test cleanup (no user rows exist here).
        rows = (
            await db_session.execute(
                text("SELECT id, name, kind, user_id FROM categories")
            )
        ).all()

        assert len(rows) == 18
        assert all(row.user_id is None for row in rows)
        produkty = next(row for row in rows if row.id == PRODUKTY_ID)
        assert produkty.name == "Продукты"
        assert produkty.kind == "expense"


class TestStatementAiConstraints:
    """Migration 0018's two CHECKs, at the only level that can refuse a row.

    The rebuilt ``suggestion_source_valid`` is the risky one of the pair: 0018
    DROPPED it and recreated it under the SAME NAME with a third value, so the
    definition order of ``StatementSuggestionSource`` is all that keeps the SQL the
    model renders and the string the migration writes by hand identical — and
    alembic cannot diff a CHECK on an existing table, so nothing else would notice.
    The ``ai_status`` twin is asserted because it is a NEW constraint whose five
    values the enum must stay in step with.
    """

    async def test_llm_is_an_accepted_suggestion_source_and_a_fourth_value_is_not(
        self, db_session: AsyncSession
    ) -> None:
        import_id = await _add_statement_import(db_session, "import-check@x.com")

        await db_session.execute(
            text(_INSERT_STATEMENT_ROW),
            {"import_id": import_id, "row_index": 0, "source": "llm"},
        )
        await db_session.commit()

        with pytest.raises(
            IntegrityError, match="ck_statement_import_rows_suggestion_source_valid"
        ):
            # Raw SQL goes to the server on execute, so the refusal lands here
            # rather than at the commit the ORM-level constraint tests above wait on.
            await db_session.execute(
                text(_INSERT_STATEMENT_ROW),
                {"import_id": import_id, "row_index": 1, "source": "guess"},
            )

    async def test_an_unknown_ai_status_is_rejected(
        self, db_session: AsyncSession
    ) -> None:
        with pytest.raises(
            IntegrityError, match="ck_statement_imports_ai_status_valid"
        ):
            await _add_statement_import(
                db_session, "import-status@x.com", ai_status="running"
            )


_INSERT_STATEMENT_ROW = (
    "INSERT INTO statement_import_rows (id, import_id, row_index, section, "
    "txn_date, booked_date, description, kind, amount_minor, raw, client_id, "
    "match_status, suggestion_source, decision) VALUES "
    "(gen_random_uuid(), :import_id, :row_index, 'card', '2026-06-01', "
    "'2026-06-01', 'x', 'expense', 100, '{}'::jsonb, gen_random_uuid(), 'new', "
    ":source, 'import')"
)


async def _add_statement_import(
    db_session: AsyncSession, email: str, *, ai_status: str = "ok"
) -> uuid.UUID:
    """A user, an account and one import session, written straight to the tables."""
    user_id = await _create_user(db_session, email)
    account = await add_account(db_session, user_id, currency="BYN")
    import_id = uuid.uuid4()
    await db_session.execute(
        text(
            "INSERT INTO statement_imports (id, user_id, account_id, status, "
            "source_format, filename, statement_currency, period_from, period_to, "
            "rows_total, rows_blocked, rows_zero_skipped, ai_status) VALUES "
            "(:id, :user_id, :account_id, 'parsed', 'priorbank_csv_v1', 'f.csv', "
            "'BYN', '2026-06-01', '2026-06-30', 0, 0, 0, :ai_status)"
        ),
        {
            "id": import_id,
            "user_id": user_id,
            "account_id": account.id,
            "ai_status": ai_status,
        },
    )
    await db_session.commit()
    return import_id


class TestProfileCreation:
    async def test_register_creates_rub_profile(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        response = await client.post(
            "/auth/register",
            json={"email": "profile@x.com", "password": "password123"},
        )
        assert response.status_code == 201, response.text
        user_id = uuid.UUID(response.json()["id"])

        base_currency = await db_session.scalar(
            text("SELECT base_currency FROM profiles WHERE user_id = :id"),
            {"id": user_id},
        )
        assert base_currency == "RUB"
