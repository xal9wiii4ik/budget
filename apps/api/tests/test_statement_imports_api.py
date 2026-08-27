"""/statement-imports — upload, preview, decide, cancel, against real Postgres.

What only the router can prove (the parser and the matcher are covered by their
own pure tests): the multipart upload path, the assembly of the two counter
cross-sections, the supersede-and-fingerprint behaviour of a re-upload, the
refusals that must leave NOTHING behind, the no-oracle 404 at both the session and
the row level, and the two ways a decision is made — one row at a time and one
match status at a time.

The apply itself, the only write of the scope that touches money, lives in
``test_statement_apply.py``; it appears here only where a route needs a session
that is no longer a proposal.
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


class TestStatementRowDecisions:
    """PATCH one row, or a whole match status at once (§10.3 / §10.8)."""

    async def _seeded_preview(
        self, client: AsyncClient, headers: dict[str, str], data: bytes
    ) -> tuple[str, str, dict[str, dict[str, Any]]]:
        """A preview holding all three verdicts at once.

        Two recorded transactions do it: 25.40 on the day of the purchase is an
        EXACT match, and 1.15 two days after the two identical card payments is
        close enough to be SIMILAR to both without being either of their dates.
        """
        account_id = await _byn_account(client, headers)
        for amount, occurred_at in ((2540, "2026-06-02"), (115, "2026-06-05")):
            recorded = await client.post(
                "/transactions",
                json={
                    "account_id": account_id,
                    "amount_minor": amount,
                    "kind": "expense",
                    "occurred_at": occurred_at,
                },
                headers=headers,
            )
            assert recorded.status_code == 201, recorded.text
        created = await _upload(client, headers, account_id, data)
        assert created.status_code == 201, created.text
        import_id = str(created.json()["id"])
        assert created.json()["by_match_status"] == {"exact": 1, "similar": 2, "new": 4}
        listed = await client.get(
            f"/statement-imports/{import_id}/rows", headers=headers
        )
        assert listed.status_code == 200, listed.text
        rows = {row["description"]: row for row in listed.json()["items"]}
        return account_id, import_id, rows

    async def test_patch_answers_with_the_row_and_only_a_sent_category_sets_the_flag(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """200 with the updated row, and the learning flag raised by the CATEGORY.

        The row travels back (§10.3) so a click updates one cached row instead of
        re-reading a thousand. And ``category_user_set`` is raised by sending a
        category and by nothing else: it is the gate that decides whether the maps
        get to learn from this row at apply, so a decision click must not be able
        to raise it — nor to lower it once the user has chosen.
        """
        headers = await _register_and_login(client, "row-patch@example.com")
        account_id = await _byn_account(client, headers)
        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = created.json()["id"]
        rows = await client.get(f"/statement-imports/{import_id}/rows", headers=headers)
        row = rows.json()["items"][0]
        assert row["decision"] == "import"
        category = await client.post(
            "/categories", json={"name": "Еда", "kind": "expense"}, headers=headers
        )
        assert category.status_code == 201, category.text

        decided = await client.patch(
            f"/statement-imports/{import_id}/rows/{row['id']}",
            json={"decision": "skip"},
            headers=headers,
        )

        assert decided.status_code == 200, decided.text
        assert decided.json()["decision"] == "skip"
        assert decided.json()["category_id"] is None
        assert decided.json()["category_user_set"] is False

        categorized = await client.patch(
            f"/statement-imports/{import_id}/rows/{row['id']}",
            json={"category_id": category.json()["id"]},
            headers=headers,
        )

        assert categorized.status_code == 200, categorized.text
        assert categorized.json()["category_id"] == category.json()["id"]
        assert categorized.json()["category_user_set"] is True
        # The decision the previous call set is untouched by a category click.
        assert categorized.json()["decision"] == "skip"
        fetched = await client.get(
            f"/statement-imports/{import_id}/rows", headers=headers
        )
        assert fetched.json()["items"][0] == categorized.json()

    async def test_a_category_that_is_not_the_caller_s_is_simply_not_found(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """Someone else's category answers exactly what a made-up id answers.

        A different refusal for "exists but is not yours" would turn this route
        into an oracle for other people's category ids.
        """
        stranger_headers = await _register_and_login(client, "row-cat-b@example.com")
        stranger = await client.post(
            "/categories",
            json={"name": "Чужая", "kind": "expense"},
            headers=stranger_headers,
        )
        assert stranger.status_code == 201, stranger.text

        headers = await _register_and_login(client, "row-cat-a@example.com")
        account_id = await _byn_account(client, headers)
        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = created.json()["id"]
        listed = await client.get(
            f"/statement-imports/{import_id}/rows", headers=headers
        )
        row_id = listed.json()["items"][0]["id"]

        foreign = await client.patch(
            f"/statement-imports/{import_id}/rows/{row_id}",
            json={"category_id": stranger.json()["id"]},
            headers=headers,
        )
        missing = await client.patch(
            f"/statement-imports/{import_id}/rows/{row_id}",
            json={"category_id": str(uuid.uuid4())},
            headers=headers,
        )

        assert foreign.status_code == missing.status_code == 422
        assert foreign.content == missing.content
        assert foreign.json()["detail"] == "CATEGORY_NOT_FOUND"

    async def test_a_row_of_another_session_is_not_found_either(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """No-oracle at BOTH levels: the id pair is one query, not two lookups.

        A row id belongs to a session; addressing it through the wrong session must
        answer like an id that does not exist, or the route would confirm which
        rows live in a session the caller is not looking at.
        """
        headers = await _register_and_login(client, "row-cross@example.com")
        first_account = await _byn_account(client, headers)
        second_account = str(
            (await create_account(client, headers, currency="BYN", name="Second"))["id"]
        )
        first = await _upload(client, headers, first_account, statement_csv_bytes)
        second = await _upload(client, headers, second_account, statement_csv_bytes)
        other_rows = await client.get(
            f"/statement-imports/{second.json()['id']}/rows", headers=headers
        )
        other_row_id = other_rows.json()["items"][0]["id"]

        crossed = await client.patch(
            f"/statement-imports/{first.json()['id']}/rows/{other_row_id}",
            json={"decision": "skip"},
            headers=headers,
        )
        invented = await client.patch(
            f"/statement-imports/{first.json()['id']}/rows/{uuid.uuid4()}",
            json={"decision": "skip"},
            headers=headers,
        )

        assert crossed.status_code == invented.status_code == 404
        assert crossed.content == invented.content

    async def test_replace_own_needs_a_transaction_to_replace(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """Refused on ONE row and refused for a whole status, with one code.

        ``replace_own`` on a row the matcher found nothing for would delete nothing
        and import as if the user had said ``import`` — a decision that quietly
        means something else is worse than a refusal. The bulk route gates it too:
        it is a second writer of ``decision``, and apply trusts what it wrote.
        """
        headers = await _register_and_login(client, "row-replace@example.com")
        account_id = await _byn_account(client, headers)
        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = created.json()["id"]
        listed = await client.get(
            f"/statement-imports/{import_id}/rows", headers=headers
        )
        row = listed.json()["items"][0]
        assert row["match_status"] == "new"

        single = await client.patch(
            f"/statement-imports/{import_id}/rows/{row['id']}",
            json={"decision": "replace_own"},
            headers=headers,
        )
        bulk = await client.post(
            f"/statement-imports/{import_id}/rows/bulk-decision",
            json={"match_status": "new", "decision": "replace_own"},
            headers=headers,
        )

        assert single.status_code == 422, single.text
        assert single.json()["detail"] == "DECISION_NEEDS_MATCH"
        assert bulk.status_code == 422, bulk.text
        assert bulk.json()["detail"] == "DECISION_NEEDS_MATCH"
        after = await client.get(f"/statement-imports/{import_id}", headers=headers)
        assert after.json()["by_decision"] == {"import": 7, "skip": 0, "replace_own": 0}

    async def test_an_applied_session_takes_no_more_decisions(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """Past apply, the session is a journal: editing it would rewrite history."""
        headers = await _register_and_login(client, "row-finished@example.com")
        account_id = await _byn_account(client, headers)
        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = created.json()["id"]
        listed = await client.get(
            f"/statement-imports/{import_id}/rows", headers=headers
        )
        row_id = listed.json()["items"][0]["id"]
        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )
        assert applied.status_code == 200, applied.text

        refused = await client.patch(
            f"/statement-imports/{import_id}/rows/{row_id}",
            json={"decision": "skip"},
            headers=headers,
        )

        assert refused.status_code == 422, refused.text
        assert refused.json()["detail"] == "IMPORT_FINISHED"

    async def test_bulk_decision_moves_one_status_and_touches_nothing_else(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """One status changes its mind; the other two, and every category, do not.

        A decision and a category are two independent choices on the same row, so
        "import all the look-alikes" must not discard the category the user picked
        on an exact row — nor move rows of a status the click did not name.

        The answer is the session's counters from the SAME ``_counts_of`` the GET
        uses: the apply confirmation is built on them, so a bulk click and a page
        reload must not be able to describe two different applies.
        """
        headers = await _register_and_login(client, "row-bulk@example.com")
        _, import_id, rows = await self._seeded_preview(
            client, headers, statement_csv_bytes
        )
        category = await client.post(
            "/categories", json={"name": "Продукты", "kind": "expense"}, headers=headers
        )
        assert category.status_code == 201, category.text
        exact_row = rows["МАГАЗИН ПРОДУКТЫ"]
        assert exact_row["match_status"] == "exact"
        similar_row = rows["PAYBYCARD.BY"]
        assert similar_row["match_status"] == "similar"
        # A category on a row the bulk WILL move, and one on a row it will not.
        for row_id in (exact_row["id"], similar_row["id"]):
            chosen = await client.patch(
                f"/statement-imports/{import_id}/rows/{row_id}",
                json={"category_id": category.json()["id"]},
                headers=headers,
            )
            assert chosen.status_code == 200, chosen.text

        bulk = await client.post(
            f"/statement-imports/{import_id}/rows/bulk-decision",
            json={"match_status": "similar", "decision": "import"},
            headers=headers,
        )

        assert bulk.status_code == 200, bulk.text
        assert bulk.json()["by_match_status"] == {"exact": 1, "similar": 2, "new": 4}
        assert bulk.json()["by_decision"] == {"import": 6, "skip": 1, "replace_own": 0}
        fetched = await client.get(f"/statement-imports/{import_id}", headers=headers)
        assert fetched.json() == bulk.json()

        after = {
            row["description"]: row
            for row in (
                await client.get(
                    f"/statement-imports/{import_id}/rows", headers=headers
                )
            ).json()["items"]
        }
        moved = after["PAYBYCARD.BY"]
        assert [moved["match_status"], moved["decision"]] == ["similar", "import"]
        # The bulk moved the DECISION of this row and nothing else: the category
        # the user picked on it — and the flag that lets it teach the maps at
        # apply — survived a click that was about something else entirely.
        assert moved["category_id"] == category.json()["id"]
        assert moved["category_user_set"] is True
        # The exact row kept its "keep mine" default AND the category the user
        # picked on it — the bulk moved decisions, not choices.
        assert after["МАГАЗИН ПРОДУКТЫ"]["decision"] == "skip"
        assert after["МАГАЗИН ПРОДУКТЫ"]["category_id"] == category.json()["id"]
        assert after["МАГАЗИН ПРОДУКТЫ"]["category_user_set"] is True
        assert after["ВОЗВРАТ ПОКУПКИ"]["decision"] == "import"
