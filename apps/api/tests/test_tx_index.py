"""The pull index: staleness, cascade, and the sweep's row bound.

Real Postgres, real HTTP writes, the ``FakeEmbedder`` (no artifact). These five
tests are the entire justification for pull-over-push indexing:

* an edited merchant, a renamed category and a renamed account all become stale
  WITHOUT one line of writer code knowing this table exists;
* a deleted transaction takes its vector with it by FK cascade alone;
* a row that vanishes between the scan and the upsert costs ONE batch, which is
  reported as pending and leaves the session usable;
* the sweep stops at its row cap and resumes on the next run;
* a server with no embedder has a harmless job.

Nothing here is mocked: ``refresh`` and ``sweep_embeddings`` run against the test
database exactly as the scheduler runs them.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from datetime import date, datetime
from typing import Any
from unittest.mock import patch

import pytest
from helpers import add_account, create_account
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.config import Settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.embeddings import FakeEmbedder
from budget_api.models import Transaction, TransactionEmbedding
from budget_api.services import tx_index
from budget_api.services.tx_index import SweepConfig, refresh, sweep_embeddings

PASSWORD = "password123"


@pytest.fixture
async def job_sessionmaker(
    test_database_url: str, test_jwt_secret: str
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """The sessionmaker the sweep job gets in production, built for a test.

    Its own engine, like ``db_session``'s: the job opens a session per user and
    must not borrow the one a test reads rows through.
    """
    engine = build_engine(
        Settings(database_url=test_database_url, jwt_secret=test_jwt_secret)
    )
    try:
        yield build_sessionmaker(engine)
    finally:
        await engine.dispose()


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


async def _index(
    session: AsyncSession, transaction_id: uuid.UUID
) -> tuple[str, bytes, datetime]:
    row = (
        await session.execute(
            select(
                TransactionEmbedding.text_hash,
                TransactionEmbedding.vector,
                TransactionEmbedding.embedded_at,
            ).where(TransactionEmbedding.transaction_id == transaction_id)
        )
    ).one()
    return row[0], row[1], row[2]


async def _count(session: AsyncSession) -> int:
    total = await session.scalar(select(func.count()).select_from(TransactionEmbedding))
    return int(total or 0)


async def _seed_user(session: AsyncSession, email: str, *, rows: int) -> uuid.UUID:
    """A user with one account and ``rows`` indexable expense rows, via the ORM."""
    user_id = uuid.uuid4()
    await session.execute(
        text(
            "INSERT INTO users (id, email, hashed_password) VALUES (:id, :email, :pw)"
        ),
        {"id": user_id, "email": email, "pw": "x"},
    )
    account = await add_account(session, user_id, name="Main")
    for index in range(rows):
        session.add(
            Transaction(
                user_id=user_id,
                account_id=account.id,
                amount_minor=1000 + index,
                kind="expense",
                currency="RUB",
                merchant=f"Магазин {index}",
                occurred_at=date(2026, 3, 1),
            )
        )
    await session.flush()
    return user_id


class TestStaleness:
    async def test_edits_and_renames_restale_exactly_their_rows(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Merchant PATCH, category rename, account rename → three rows re-embedded.

        The point of pull indexing: NO writer was changed for any of the three.
        The two renames are the half push hooks would have missed entirely (those
        names live in the embedded document, not on the transaction row), and the
        untouched row's ``embedded_at`` proves a run rewrites only what actually
        changed — otherwise every sweep would re-embed the whole ledger.
        """
        headers, user_id = await _register_and_login(client, "stale@x.com")
        main = (await create_account(client, headers, name="Main"))["id"]
        spare = (await create_account(client, headers, name="Spare"))["id"]
        created_category = await client.post(
            "/categories", json={"name": "Кафе", "kind": "expense"}, headers=headers
        )
        assert created_category.status_code == 201, created_category.text
        category_id = created_category.json()["id"]

        edited = await _create_tx(
            client, headers, merchant="Biedronka", account_id=main
        )
        categorized = await _create_tx(
            client,
            headers,
            merchant="Prezenty",
            account_id=main,
            category_id=category_id,
        )
        on_spare = await _create_tx(
            client, headers, merchant="Apteka", account_id=spare
        )
        untouched = await _create_tx(client, headers, merchant="Żabka", account_id=main)

        embedder = FakeEmbedder()
        first = await refresh(db_session, embedder, user_id, batch_size=2, max_rows=100)
        assert (first.embedded, first.pending) == (4, 0)
        before = {
            row["id"]: await _index(db_session, uuid.UUID(row["id"]))
            for row in (edited, categorized, on_spare, untouched)
        }

        # Three writes through the ordinary routes; not one of them knows this
        # table exists.
        patched = await client.patch(
            f"/transactions/{edited['id']}",
            json={"merchant": "Żabka Express"},
            headers=headers,
        )
        assert patched.status_code == 200, patched.text
        renamed_category = await client.patch(
            f"/categories/{category_id}", json={"name": "Рестораны"}, headers=headers
        )
        assert renamed_category.status_code == 200, renamed_category.text
        renamed_account = await client.patch(
            f"/accounts/{spare}", json={"name": "Карта PLN"}, headers=headers
        )
        assert renamed_account.status_code == 200, renamed_account.text

        second = await refresh(
            db_session, embedder, user_id, batch_size=2, max_rows=100
        )
        assert (second.embedded, second.pending) == (3, 0)

        for row in (edited, categorized, on_spare):
            hash_after, vector_after, _ = await _index(db_session, uuid.UUID(row["id"]))
            hash_before, vector_before, _ = before[row["id"]]
            assert hash_after != hash_before
            assert vector_after != vector_before
        # The fourth row was not rewritten at all: same hash, same vector, and the
        # same ``embedded_at`` the first run stamped.
        assert (
            await _index(db_session, uuid.UUID(untouched["id"]))
            == (before[untouched["id"]])
        )

    async def test_deleting_a_transaction_removes_its_vector(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """DELETE /transactions/{id} → no embedding row, with no index code involved.

        The FK cascade is the ONLY thing keeping deleted money out of search
        results. If it were ever dropped, a deleted row would stay searchable and
        the search path would have to start checking whether its own hits exist.
        """
        headers, user_id = await _register_and_login(client, "cascade@x.com")
        account = (await create_account(client, headers))["id"]
        doomed = await _create_tx(
            client, headers, merchant="Единоразовая покупка", account_id=account
        )
        await _create_tx(client, headers, merchant="Остаётся", account_id=account)

        await refresh(db_session, FakeEmbedder(), user_id, batch_size=8, max_rows=100)
        assert await _count(db_session) == 2

        deleted = await client.delete(f"/transactions/{doomed['id']}", headers=headers)
        assert deleted.status_code == 204

        # No refresh in between: the row is gone because the FK says so.
        assert await _count(db_session) == 1


class TestFkRace:
    async def test_a_vanished_row_costs_one_batch_and_is_reported_as_pending(
        self, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A transaction deleted between the scan and the upsert: one batch lost.

        The one branch of ``refresh`` that can genuinely break: a session left in
        "needs rollback" state would fail every LATER batch too, so the two real
        rows landing after the ghost's batch is the assertion that matters. The
        race is injected at the ``stale_rows`` seam (the ``recurring_jobs`` probe
        precedent) because deleting a row BEFORE the scan would never reach this
        arm — the scan simply would not return it.

        The logged KIND is the second half: the same ``IntegrityError`` also
        carries a CHECK violation, which is permanent rather than a race, and
        ``sqlstate``/``cause`` are the only parts of that exception that tell
        them apart AND are safe to log (its message quotes the offending row).
        Pinned as one exact line because the class name costs a hop through
        ``__cause__`` — the wrapper SQLAlchemy raises says "IntegrityError" for
        both kinds, so a regression here is invisible in the field.
        """
        user_id = await _seed_user(db_session, "fkrace@x.com", rows=2)
        await db_session.commit()
        real_scan = tx_index.stale_rows

        async def _scan_then_add_a_ghost(
            session: AsyncSession, model: str, scanned_user: uuid.UUID
        ) -> list[tx_index._Stale]:  # pyright: ignore[reportPrivateUsage]
            rows = await real_scan(session, model, scanned_user)
            # Ordered last, so the two real batches straddle it: batch 1 commits,
            # the ghost's rolls back, batch 3 must still commit.
            return [
                *rows[:1],
                tx_index._Stale(  # pyright: ignore[reportPrivateUsage]
                    transaction_id=uuid.uuid4(),
                    text="удалённая операция",
                    text_hash="0" * 64,
                ),
                *rows[1:],
            ]

        with (
            caplog.at_level(logging.WARNING, logger=tx_index.__name__),
            patch(
                "budget_api.services.tx_index.stale_rows",
                side_effect=_scan_then_add_a_ghost,
            ),
        ):
            stats = await refresh(
                db_session, FakeEmbedder(), user_id, batch_size=1, max_rows=100
            )

        assert (stats.embedded, stats.pending) == (2, 1)
        assert await _count(db_session) == 2
        assert [
            record.getMessage()
            for record in caplog.records
            if record.name == tx_index.__name__
        ] == [
            "embeddings batch rolled back rows=1 sqlstate=23503 "
            "cause=ForeignKeyViolationError"
        ]


class TestSweep:
    async def test_the_row_cap_bounds_one_run_and_the_next_run_finishes(
        self,
        db_session: AsyncSession,
        job_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        """90 stale rows over three users, cap 60: exactly 60, then the rest.

        The bound that keeps a background job off a 2-vCPU box's throat, and the
        resumability that makes the bound safe. Three users deep so the cap is
        tested against the per-user loop, not against one ``refresh`` call.
        """
        for index in range(3):
            await _seed_user(db_session, f"sweep{index}@x.com", rows=30)
        await db_session.commit()

        config = SweepConfig(batch_size=10, max_rows=60, time_budget_seconds=60)
        await sweep_embeddings(
            sessionmaker=job_sessionmaker, embedder=FakeEmbedder(), config=config
        )
        assert await _count(db_session) == 60

        await sweep_embeddings(
            sessionmaker=job_sessionmaker, embedder=FakeEmbedder(), config=config
        )
        assert await _count(db_session) == 90

    async def test_a_server_with_no_embedder_has_a_harmless_job(
        self,
        db_session: AsyncSession,
        job_sessionmaker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Gate on, no embedder: nothing written, nothing raised.

        The job is registered by its GATE, not by whether a model exists (the
        push-without-VAPID precedent), so this is the state of any box where the
        operator traded search for 510 MB of RAM — or where the artifact failed
        to verify at boot.
        """
        await _seed_user(db_session, "noembedder@x.com", rows=3)
        await db_session.commit()

        await sweep_embeddings(
            sessionmaker=job_sessionmaker,
            embedder=None,
            config=SweepConfig(batch_size=8, max_rows=100, time_budget_seconds=60),
        )

        assert await _count(db_session) == 0
