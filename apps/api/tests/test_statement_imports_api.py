"""/statement-imports — upload, preview, cancel, against real Postgres.

What only the router can prove (the parser and the matcher are covered by their
own pure tests): the multipart upload path, the assembly of the two counter
cross-sections, the supersede-and-fingerprint behaviour of a re-upload, the
refusals that must leave NOTHING behind, and the no-oracle 404 shared by both
routes that take an id.

Nothing here creates or touches a transaction — S1 stores a proposal and only a
proposal, which is exactly why this subtask can ship before apply exists.
"""

import uuid
from typing import Any

from helpers import create_account
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import StatementImport, StatementImportRow

PASSWORD = "password123"
FORMAT = "priorbank_csv_v1"


async def _register_and_login(client: AsyncClient, email: str) -> dict[str, str]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


async def _upload(
    client: AsyncClient,
    headers: dict[str, str],
    account_id: str,
    data: bytes,
    *,
    filename: str = "Vpsk_71466782.csv",
    statement_format: str = FORMAT,
) -> Response:
    return await client.post(
        "/statement-imports",
        files={"file": (filename, data, "text/csv")},
        data={"account_id": account_id, "format": statement_format},
        headers=headers,
    )


async def _byn_account(client: AsyncClient, headers: dict[str, str]) -> str:
    account = await create_account(client, headers, currency="BYN", name="Card BYN")
    return str(account["id"])


class TestStatementUpload:
    async def test_upload_creates_a_session_with_both_counter_cross_sections(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """201 carries the session AND what the file cost: kept, dropped, decided.

        The two cross-sections are not the same number sliced twice: ``match_status``
        says what was FOUND, ``decision`` says what apply WILL DO — and the apply
        confirmation is built on the second. A GET must report exactly what the POST
        did, or a page reload would change the user's mind for them.
        """
        headers = await _register_and_login(client, "import-201@example.com")
        account_id = await _byn_account(client, headers)

        resp = await _upload(client, headers, account_id, statement_csv_bytes)

        assert resp.status_code == 201, resp.text
        body: dict[str, Any] = resp.json()
        assert body["status"] == "parsed"
        assert body["applied_at"] is None
        assert body["source_format"] == FORMAT
        assert body["filename"] == "Vpsk_71466782.csv"
        assert body["statement_currency"] == "BYN"
        assert (body["period_from"], body["period_to"]) == ("2026-06-01", "2026-06-30")
        assert (
            body["rows_total"],
            body["rows_blocked"],
            body["rows_zero_skipped"],
        ) == (
            7,
            2,
            1,
        )
        # An empty account: nothing to match against, so everything is new and
        # everything will be imported.
        assert body["by_match_status"] == {"exact": 0, "similar": 0, "new": 7}
        assert body["by_decision"] == {"import": 7, "skip": 0, "replace_own": 0}

        fetched = await client.get(f"/statement-imports/{body['id']}", headers=headers)
        assert fetched.status_code == 200, fetched.text
        assert fetched.json() == body

    async def test_rows_carry_transaction_shaped_money_and_their_candidates(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """A preview row reads like a transaction and brings its match with it.

        Both halves are contract (PM §10.1/§10.5): the web renders the
        "spent / debited" pair with the module it already has, and "show my record"
        must not cost one request per row on a thousand-row statement.
        """
        headers = await _register_and_login(client, "import-rows@example.com")
        account_id = await _byn_account(client, headers)
        recorded = await client.post(
            "/transactions",
            json={
                "account_id": account_id,
                "amount_minor": 2540,
                "kind": "expense",
                "occurred_at": "2026-06-02",
                "merchant": "Магазин",
            },
            headers=headers,
        )
        assert recorded.status_code == 201, recorded.text
        recorded_id = recorded.json()["id"]

        created = await _upload(client, headers, account_id, statement_csv_bytes)
        assert created.status_code == 201, created.text
        import_id = created.json()["id"]
        assert created.json()["by_match_status"] == {"exact": 1, "similar": 0, "new": 6}
        assert created.json()["by_decision"] == {
            "import": 6,
            "skip": 1,
            "replace_own": 0,
        }

        listed = await client.get(
            f"/statement-imports/{import_id}/rows", headers=headers
        )
        assert listed.status_code == 200, listed.text
        payload = listed.json()
        assert payload["total"] == 7
        rows = {row["description"]: row for row in payload["items"]}
        assert [row["row_index"] for row in payload["items"]] == list(range(7))

        matched = rows["МАГАЗИН ПРОДУКТЫ"]
        assert matched["match_status"] == "exact"
        assert matched["decision"] == "skip"
        assert matched["matched_tx_id"] == recorded_id
        # The candidate travels WITH the row, in mini form.
        assert [candidate["id"] for candidate in matched["candidates"]] == [recorded_id]
        assert matched["candidates"][0]["amount_minor"] == 2540
        assert matched["candidates"][0]["currency"] == "BYN"

        foreign = rows["SKLEP WARSZAWA"]
        # The settlement pair is the ACCOUNT's money; the original pair is what the
        # merchant charged. Both on the row, neither computed by a client.
        assert (foreign["amount_minor"], foreign["currency"]) == (143_963, "BYN")
        assert (foreign["original_amount_minor"], foreign["original_currency"]) == (
            180_000,
            "PLN",
        )
        assert foreign["candidates"] == []

        transfer_row = rows["CH Debit PETROV P."]
        assert transfer_row["possible_transfer"] is True
        assert transfer_row["fee_minor"] == -150
        assert transfer_row["txn_time"] == "09:00:00"
        assert rows["PAYBYCARD.BY"]["txn_time"] is None

        filtered = await client.get(
            f"/statement-imports/{import_id}/rows",
            params={"match_status": "exact"},
            headers=headers,
        )
        assert filtered.status_code == 200, filtered.text
        assert filtered.json()["total"] == 1
        assert [row["id"] for row in filtered.json()["items"]] == [matched["id"]]

    async def test_an_operation_dated_before_the_period_still_finds_its_record(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """The bank cuts the period by the POSTING date, and the matcher follows.

        A purchase made on 28 May and posted on 3 June is printed in the June
        statement with ``txn_date`` outside it, while the user's own record carries
        the day of the purchase. Loading candidates by the printed period alone
        never sees that transaction, so the row is reported ``new`` and defaults to
        ``import`` — a guaranteed duplicate of money already recorded.
        """
        headers = await _register_and_login(client, "import-lag@example.com")
        account_id = await _byn_account(client, headers)
        recorded = await client.post(
            "/transactions",
            json={
                "account_id": account_id,
                "amount_minor": 2540,
                "kind": "expense",
                "occurred_at": "2026-05-28",
                "merchant": "Магазин",
            },
            headers=headers,
        )
        assert recorded.status_code == 201, recorded.text
        # The same line as in the file, made on 28 May and posted on 3 June — five
        # days before ``period_from`` and outside any period±1 window.
        lagging = (
            statement_csv_bytes.decode("cp1251")
            .replace("02.06.2026 10:15:00", "28.05.2026 10:15:00", 1)
            .encode("cp1251")
        )

        created = await _upload(client, headers, account_id, lagging)

        assert created.status_code == 201, created.text
        assert created.json()["by_match_status"] == {"exact": 1, "similar": 0, "new": 6}
        listed = await client.get(
            f"/statement-imports/{created.json()['id']}/rows", headers=headers
        )
        matched = {row["description"]: row for row in listed.json()["items"]}[
            "МАГАЗИН ПРОДУКТЫ"
        ]
        assert matched["txn_date"] == "2026-05-28"
        assert matched["match_status"] == "exact"
        assert matched["matched_tx_id"] == recorded.json()["id"]
        assert matched["decision"] == "skip"

    async def test_reupload_supersedes_the_preview_and_keeps_the_fingerprints(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """The same file twice: one live preview, and the SAME row fingerprints.

        The fingerprints are what will become ``client_id`` on the created
        transactions, so their stability across uploads is the whole idempotency
        story (architecture §3) — and leaving two live previews of one account would
        let a user apply the stale one.
        """
        headers = await _register_and_login(client, "import-again@example.com")
        account_id = await _byn_account(client, headers)

        first = await _upload(client, headers, account_id, statement_csv_bytes)
        assert first.status_code == 201, first.text
        first_id = uuid.UUID(first.json()["id"])
        first_ids = list(
            (
                await db_session.scalars(
                    select(StatementImportRow.client_id)
                    .where(StatementImportRow.import_id == first_id)
                    .order_by(StatementImportRow.row_index)
                )
            ).all()
        )

        second = await _upload(client, headers, account_id, statement_csv_bytes)
        assert second.status_code == 201, second.text
        second_id = uuid.UUID(second.json()["id"])
        assert second_id != first_id
        second_ids = list(
            (
                await db_session.scalars(
                    select(StatementImportRow.client_id)
                    .where(StatementImportRow.import_id == second_id)
                    .order_by(StatementImportRow.row_index)
                )
            ).all()
        )

        assert second_ids == first_ids
        # Two identical payments in one file still differ by occurrence index.
        assert len(set(second_ids)) == 7
        stale = await client.get(f"/statement-imports/{first_id}", headers=headers)
        assert stale.status_code == 404, stale.text

    async def test_currency_mismatch_names_both_currencies(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """A BYN statement into a USD account is refused WITH both currencies.

        The code alone would leave a client unable to say what is wrong without two
        more requests; the pair is the whole content of the refusal (PM §10.7). And
        nothing is stored: the account's currency is what every created transaction
        would be stamped with.
        """
        headers = await _register_and_login(client, "import-currency@example.com")
        usd_account = await create_account(client, headers, currency="USD")

        resp = await _upload(
            client, headers, str(usd_account["id"]), statement_csv_bytes
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {
            "detail": "STATEMENT_CURRENCY_MISMATCH",
            "statement_currency": "BYN",
            "account_currency": "USD",
        }
        assert (
            await db_session.scalar(select(func.count()).select_from(StatementImport))
            == 0
        )

    async def test_a_refused_upload_stores_nothing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """Wrong encoding and unknown format: a 422 and not a row anywhere.

        A session created for a file we could not read would be a preview of
        nothing that the user has to find and cancel.
        """
        headers = await _register_and_login(client, "import-refused@example.com")
        account_id = await _byn_account(client, headers)

        utf8 = await _upload(
            client,
            headers,
            account_id,
            statement_csv_bytes.decode("cp1251").encode("utf-8"),
        )
        assert utf8.status_code == 422, utf8.text
        assert utf8.json()["detail"] == "STATEMENT_PARSE_FAILED"

        unknown = await _upload(
            client,
            headers,
            account_id,
            statement_csv_bytes,
            statement_format="sberbank_pdf_v1",
        )
        assert unknown.status_code == 422, unknown.text
        assert unknown.json()["detail"] == "STATEMENT_FORMAT_UNKNOWN"

        assert (
            await db_session.scalar(select(func.count()).select_from(StatementImport))
            == 0
        )

    async def test_upload_over_the_size_limit_is_refused_before_parsing(
        self, make_client: Any, statement_csv_bytes: bytes
    ) -> None:
        """The gate reads the BYTES, not the client's Content-Length claim."""
        client: AsyncClient = await make_client(statement_max_bytes=64)
        headers = await _register_and_login(client, "import-size@example.com")
        account_id = await _byn_account(client, headers)

        resp = await _upload(client, headers, account_id, statement_csv_bytes)

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "STATEMENT_TOO_LARGE"


class TestStatementSessionAccess:
    async def test_delete_cancels_the_preview_and_its_rows(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """Cancelling takes the rows with it (the FK cascade), and is not repeatable."""
        headers = await _register_and_login(client, "import-cancel@example.com")
        account_id = await _byn_account(client, headers)
        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = uuid.UUID(created.json()["id"])

        deleted = await client.delete(
            f"/statement-imports/{import_id}", headers=headers
        )

        assert deleted.status_code == 204, deleted.text
        assert (
            await db_session.scalar(
                select(func.count())
                .select_from(StatementImportRow)
                .where(StatementImportRow.import_id == import_id)
            )
            == 0
        )
        again = await client.delete(f"/statement-imports/{import_id}", headers=headers)
        assert again.status_code == 404, again.text

    async def test_someone_elses_session_is_indistinguishable_from_a_missing_one(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """No-oracle, on BOTH routes that take an id: same status, same bytes.

        A different answer for "exists but is not yours" would let anyone with an id
        confirm that it exists — and an import session id maps to an account and a
        period of someone's spending.
        """
        owner_headers = await _register_and_login(client, "import-owner@example.com")
        account_id = await _byn_account(client, owner_headers)
        created = await _upload(client, owner_headers, account_id, statement_csv_bytes)
        foreign_id = created.json()["id"]
        missing_id = str(uuid.uuid4())

        other_headers = await _register_and_login(client, "import-other@example.com")

        foreign_get = await client.get(
            f"/statement-imports/{foreign_id}", headers=other_headers
        )
        missing_get = await client.get(
            f"/statement-imports/{missing_id}", headers=other_headers
        )
        foreign_rows = await client.get(
            f"/statement-imports/{foreign_id}/rows", headers=other_headers
        )
        foreign_delete = await client.delete(
            f"/statement-imports/{foreign_id}", headers=other_headers
        )
        missing_delete = await client.delete(
            f"/statement-imports/{missing_id}", headers=other_headers
        )

        assert foreign_get.status_code == missing_get.status_code == 404
        assert foreign_get.content == missing_get.content
        assert foreign_rows.status_code == 404
        assert foreign_delete.status_code == missing_delete.status_code == 404
        assert foreign_delete.content == missing_delete.content
        # …and the owner's preview survived the stranger's DELETE.
        alive = await client.get(
            f"/statement-imports/{foreign_id}", headers=owner_headers
        )
        assert alive.status_code == 200, alive.text
