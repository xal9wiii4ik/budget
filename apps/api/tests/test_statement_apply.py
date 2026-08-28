"""POST /statement-imports/{id}/apply — the moment a preview becomes money.

Everything here is about the ONE write of this scope that cannot be taken back by
a DELETE: transactions are created, and for ``replace_own`` an existing one is
deleted first. What the tests pin down is what would cost the user real data if it
broke — the account's currency on the created rows, the bank's own foreign pair
copied rather than re-converted, the B-1 fingerprint that makes a re-import a
no-op, the transfer that must never be deleted, and the learning gate that decides
whether a category was the user's choice or the server's guess.

The parser, the matcher and the preview routes have their own files; nothing is
re-asserted here.
"""

import uuid
from typing import Any

from helpers import create_account
from httpx import AsyncClient, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import (
    BankCategoryMap,
    MerchantCategoryMap,
    StatementImport,
    StatementImportRow,
)
from budget_api.services.statement_import.apply import ApplyOutcome, apply_import

PASSWORD = "password123"
FORMAT = "priorbank_csv_v1"


async def _register_and_login(
    client: AsyncClient, email: str
) -> tuple[dict[str, str], uuid.UUID]:
    """Headers AND the new user's id — the learning maps are keyed by it."""
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


async def _byn_account(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> str:
    account = await create_account(client, headers, currency="BYN", **body)
    return str(account["id"])


async def _upload(
    client: AsyncClient, headers: dict[str, str], account_id: str, data: bytes
) -> Response:
    resp = await client.post(
        "/statement-imports",
        files={"file": ("Vpsk.csv", data, "text/csv")},
        data={"account_id": account_id, "format": FORMAT},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp


async def _rows(
    client: AsyncClient, headers: dict[str, str], import_id: str
) -> dict[str, dict[str, Any]]:
    listed = await client.get(f"/statement-imports/{import_id}/rows", headers=headers)
    assert listed.status_code == 200, listed.text
    return {row["description"]: row for row in listed.json()["items"]}


async def _transactions(
    client: AsyncClient, headers: dict[str, str], account_id: str
) -> list[dict[str, Any]]:
    listed = await client.get(
        "/transactions", params={"account_id": account_id}, headers=headers
    )
    assert listed.status_code == 200, listed.text
    items: list[dict[str, Any]] = listed.json()["items"]
    return items


async def _create_category(
    client: AsyncClient, headers: dict[str, str], name: str
) -> str:
    resp = await client.post(
        "/categories", json={"name": name, "kind": "expense"}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


class TestStatementApply:
    async def test_apply_files_the_bank_s_rows_in_the_account_s_money(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """The created rows are the account's money, with the bank's rate as a FACT.

        Three invariants of ``POST /transactions`` that apply repeats by hand and
        would silently corrupt if it got them wrong: the currency is STAMPED from
        the account, the foreign pair is copied exactly as printed (never
        re-converted at our own rate), and a day with no rate produces the honest
        NULL snapshot rather than a zero or a 500.
        """
        headers, _ = await _register_and_login(client, "apply-happy@example.com")
        account_id = await _byn_account(client, headers)
        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = created.json()["id"]

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        assert applied.json() == {
            "created": 7,
            "skipped": 0,
            "replaced": 0,
            "already_existed": 0,
        }
        session = await client.get(f"/statement-imports/{import_id}", headers=headers)
        assert session.json()["status"] == "applied"
        assert session.json()["applied_at"] is not None

        booked = await _transactions(client, headers, account_id)
        assert len(booked) == 7
        rows = {tx["merchant"]: tx for tx in booked}
        foreign = rows["SKLEP WARSZAWA"]
        assert (foreign["amount_minor"], foreign["currency"]) == (143_963, "BYN")
        assert (foreign["original_amount_minor"], foreign["original_currency"]) == (
            180_000,
            "PLN",
        )
        # Dated by the day of the PURCHASE, not of the posting (12.06 in the file).
        assert foreign["occurred_at"] == "2026-06-10"
        # The account is BYN, the profile's base is RUB, and no rate for June 2026
        # exists: the snapshot pair stays NULL instead of inventing a number.
        assert (foreign["base_amount_minor"], foreign["base_currency"]) == (None, None)
        assert rows["ЗАЧИСЛЕНИЕ ЗАРПЛАТЫ"]["kind"] == "income"

    async def test_re_importing_the_same_file_creates_nothing(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """The whole idempotency story, end to end, with the user PUSHING for it.

        A second upload of an overlapping period matches every row by fingerprint
        and defaults to ``skip`` — so the interesting case is the user overriding
        that and importing them anyway. The B-1 select-first is what stands between
        that click and a doubled June: nothing is written and every row is reported
        as already there.
        """
        headers, _ = await _register_and_login(client, "apply-again@example.com")
        account_id = await _byn_account(client, headers)
        first = await _upload(client, headers, account_id, statement_csv_bytes)
        first_apply = await client.post(
            f"/statement-imports/{first.json()['id']}/apply", headers=headers
        )
        assert first_apply.json()["created"] == 7

        second = await _upload(client, headers, account_id, statement_csv_bytes)
        second_id = second.json()["id"]
        assert second.json()["by_match_status"] == {"exact": 7, "similar": 0, "new": 0}
        forced = await client.post(
            f"/statement-imports/{second_id}/rows/bulk-decision",
            json={"match_status": "exact", "decision": "import"},
            headers=headers,
        )
        assert forced.status_code == 200, forced.text
        assert forced.json()["by_decision"] == {
            "import": 7,
            "skip": 0,
            "replace_own": 0,
        }

        applied = await client.post(
            f"/statement-imports/{second_id}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        assert applied.json() == {
            "created": 0,
            "skipped": 0,
            "replaced": 0,
            "already_existed": 7,
        }
        assert len(await _transactions(client, headers, account_id)) == 7

    async def test_replace_own_swaps_the_record_and_skip_leaves_one_out(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """One apply, three fates: replaced, imported, left alone.

        ``replace_own`` is a delete plus an insert in ONE transaction — a partial
        outcome would leave the user with neither their own row nor the bank's. And
        a ``skip`` must produce nothing at all, which is the difference between
        "the user decided" and "the server imported everything".
        """
        headers, _ = await _register_and_login(client, "apply-replace@example.com")
        account_id = await _byn_account(client, headers)
        mine = await client.post(
            "/transactions",
            json={
                "account_id": account_id,
                "amount_minor": 2540,
                "kind": "expense",
                "occurred_at": "2026-06-02",
                "merchant": "Магазин",
                "note": "мой ручной ввод",
            },
            headers=headers,
        )
        assert mine.status_code == 201, mine.text
        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = created.json()["id"]
        rows = await _rows(client, headers, import_id)

        replace = await client.patch(
            f"/statement-imports/{import_id}/rows/{rows['МАГАЗИН ПРОДУКТЫ']['id']}",
            json={"decision": "replace_own"},
            headers=headers,
        )
        assert replace.status_code == 200, replace.text
        skip = await client.patch(
            f"/statement-imports/{import_id}/rows/{rows['CH Debit PETROV P.']['id']}",
            json={"decision": "skip"},
            headers=headers,
        )
        assert skip.status_code == 200, skip.text

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        assert applied.json() == {
            "created": 5,
            "skipped": 1,
            "replaced": 1,
            "already_existed": 0,
        }
        booked = await _transactions(client, headers, account_id)
        assert mine.json()["id"] not in {tx["id"] for tx in booked}
        # Six rows for seven lines: one skipped, and the replacement is not an
        # addition — the hand-typed row it replaced is gone.
        assert len(booked) == 6
        merchants = {tx["merchant"] for tx in booked}
        assert "МАГАЗИН ПРОДУКТЫ" in merchants
        assert "CH Debit PETROV P." not in merchants
        assert "Магазин" not in merchants

    async def test_a_transfer_is_never_replaced(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """Both gates, because the deletion is what must not happen.

        A transfer is ONE row seen from two accounts: deleting it to make room for
        the bank's one-sided line would erase the other account's history for money
        this file cannot even see. The row PATCH refuses the choice where the user
        makes it, and apply refuses again over what it is about to delete — the
        second gate is the one that holds when the decision arrives from anywhere
        else, and it must leave the transfer and the whole statement untouched.
        """
        headers, _ = await _register_and_login(client, "apply-transfer@example.com")
        account_id = await _byn_account(client, headers, name="Card")
        savings = await _byn_account(client, headers, name="Cash", type="cash")
        transfer = await client.post(
            "/transactions",
            json={
                "account_id": account_id,
                "counter_account_id": savings,
                "amount_minor": 30_000,
                "counter_amount_minor": 30_000,
                "kind": "transfer",
                "occurred_at": "2026-06-11",
            },
            headers=headers,
        )
        assert transfer.status_code == 201, transfer.text
        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = created.json()["id"]
        row = (await _rows(client, headers, import_id))["CH Debit PETROV P."]
        assert row["match_status"] == "similar"
        assert row["matched_tx_id"] == transfer.json()["id"]

        refused = await client.patch(
            f"/statement-imports/{import_id}/rows/{row['id']}",
            json={"decision": "replace_own"},
            headers=headers,
        )
        assert refused.status_code == 422, refused.text
        assert refused.json()["detail"] == "TRANSFER_REPLACE_FORBIDDEN"

        # The decision forced past the route: apply is the last line of defence,
        # and it is the one standing where the DELETE would run.
        await db_session.execute(
            update(StatementImportRow)
            .where(StatementImportRow.id == uuid.UUID(row["id"]))
            .values(decision="replace_own")
        )
        await db_session.commit()

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )

        assert applied.status_code == 422, applied.text
        assert applied.json()["detail"] == "TRANSFER_REPLACE_FORBIDDEN"
        # The transfer is alive and nothing else was written: the whole statement
        # waits for a decision that can be honoured.
        survivors = await _transactions(client, headers, account_id)
        assert [tx["id"] for tx in survivors] == [transfer.json()["id"]]
        still_parsed = await db_session.scalar(
            select(StatementImport.status).where(
                StatementImport.id == uuid.UUID(import_id)
            )
        )
        assert still_parsed == "parsed"

    async def test_replace_own_takes_back_a_row_an_earlier_import_created(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """ "Drop my edited copy, take the bank's" — on an ``exact`` row (MAJOR-1).

        The only shape in which ``replace_own`` on an ``exact`` row is meaningful,
        and a whole real route: apply → edit the transaction → re-import an
        overlapping period → ask for the bank's version back. The row matches by
        FINGERPRINT, so its ``client_id`` is already in the ledger — the deletion is
        what frees it, and a pass that read the fingerprints first would report
        ``already_existed`` and silently keep the edit.

        The second half is the convergence: the retry arm of the route runs the very
        same procedure again, and with the match now nulled by the FK it must find
        nothing left to do rather than delete a second time.
        """
        headers, user_id = await _register_and_login(client, "apply-retake@example.com")
        account_id = await _byn_account(client, headers)
        first = await _upload(client, headers, account_id, statement_csv_bytes)
        first_apply = await client.post(
            f"/statement-imports/{first.json()['id']}/apply", headers=headers
        )
        assert first_apply.json()["created"] == 7
        imported = {
            tx["merchant"]: tx
            for tx in await _transactions(client, headers, account_id)
        }
        mine = imported["МАГАЗИН ПРОДУКТЫ"]
        edited = await client.patch(
            f"/transactions/{mine['id']}",
            json={"merchant": "мой отредактированный магазин"},
            headers=headers,
        )
        assert edited.status_code == 200, edited.text

        second = await _upload(client, headers, account_id, statement_csv_bytes)
        second_id = second.json()["id"]
        row = (await _rows(client, headers, second_id))["МАГАЗИН ПРОДУКТЫ"]
        assert row["match_status"] == "exact"
        assert row["matched_tx_id"] == mine["id"]
        chosen = await client.patch(
            f"/statement-imports/{second_id}/rows/{row['id']}",
            json={"decision": "replace_own"},
            headers=headers,
        )
        assert chosen.status_code == 200, chosen.text

        applied = await client.post(
            f"/statement-imports/{second_id}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        assert applied.json() == {
            "created": 0,
            "skipped": 6,
            "replaced": 1,
            "already_existed": 0,
        }
        booked = await _transactions(client, headers, account_id)
        merchants = [tx["merchant"] for tx in booked]
        # The edit is gone and the bank's line is back — once, under the same
        # fingerprint, so the ledger did not grow.
        assert len(booked) == 7
        assert "мой отредактированный магазин" not in merchants
        assert merchants.count("МАГАЗИН ПРОДУКТЫ") == 1
        assert mine["id"] not in {tx["id"] for tx in booked}

        # The retry the route would run after an insert race: the same procedure,
        # not a fallback path (the route's status gate is what keeps a USER from
        # getting here twice).
        again = await apply_import(db_session, uuid.UUID(second_id), user_id)

        assert again == ApplyOutcome(created=0, replaced=0, already_existed=1)
        assert len(await _transactions(client, headers, account_id)) == 7

    async def test_two_rows_matching_one_record_delete_it_once(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """The report counts DELETIONS, not the rows that asked for one (MINOR-2).

        ``similar`` does not consume a candidate, so the file's two identical
        payments both point at the one record the user typed. Both are imported and
        that record is deleted ONCE — the numbers of an irreversible operation are
        the user's only feedback about it, so they must be the numbers of what
        happened rather than of what was requested.
        """
        headers, _ = await _register_and_login(client, "apply-one-record@example.com")
        account_id = await _byn_account(client, headers)
        mine = await client.post(
            "/transactions",
            json={
                "account_id": account_id,
                "amount_minor": 115,
                "kind": "expense",
                # Inside the similar window of both rows (03.06 → 04.06), on neither
                # of their own dates, so neither can claim it as an exact match.
                "occurred_at": "2026-06-05",
                "merchant": "PAYBYCARD.BY",
            },
            headers=headers,
        )
        assert mine.status_code == 201, mine.text
        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = created.json()["id"]
        assert created.json()["by_match_status"] == {"exact": 0, "similar": 2, "new": 5}
        bulk = await client.post(
            f"/statement-imports/{import_id}/rows/bulk-decision",
            json={"match_status": "similar", "decision": "replace_own"},
            headers=headers,
        )
        assert bulk.status_code == 200, bulk.text

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        assert applied.json() == {
            "created": 6,
            "skipped": 0,
            "replaced": 1,
            "already_existed": 0,
        }
        booked = await _transactions(client, headers, account_id)
        # created + replaced is what was written; replaced is what disappeared.
        assert len(booked) == 7
        assert mine.json()["id"] not in {tx["id"] for tx in booked}

    async def test_a_line_without_a_description_gets_no_merchant(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """An empty description is NO merchant — the same answer typing it gives.

        The parser does not validate the operation text (an absent or empty cell is
        ``""``), and stored verbatim it would become a nameless merchant of its own:
        the top-merchants population excludes NULL merchants, not empty strings.
        """
        headers, _ = await _register_and_login(client, "apply-nameless@example.com")
        account_id = await _byn_account(client, headers)
        blanked = (
            statement_csv_bytes.decode("cp1251")
            .replace("МАГАЗИН ПРОДУКТЫ", "")
            .encode("cp1251")
        )
        created = await _upload(client, headers, account_id, blanked)

        applied = await client.post(
            f"/statement-imports/{created.json()['id']}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        merchants = [
            tx["merchant"] for tx in await _transactions(client, headers, account_id)
        ]
        assert len(merchants) == 7
        assert None in merchants
        assert "" not in merchants

    async def test_a_credo_row_files_the_shop_name_the_parser_isolated(
        self, client: AsyncClient, credo_xlsx_bytes: bytes
    ) -> None:
        """A format whose description is a SENTENCE files the name, or NO name.

        "გადახდა - YANDEX.EDA 56.10 BYN 01.08.2026" is an opener, a shop and the
        merchant's own price; written to ``merchant`` whole it would make every
        purchase at one shop a merchant of its own — no top-merchants row, no
        learned category, nothing the ``?q=`` filter can find. The line the parser
        could NOT isolate a name from is created WITHOUT a merchant: the bank never
        named one, and a Georgian sentence promoted to a shop name is our invention
        sitting in the user's top merchants. That contrast is the whole test — the
        fallback to the description belongs to Priorbank, whose format isolates no
        names at all (``test_only_the_rows_the_user_chose_are_created`` pins it).

        This is also the one test of the transport: the parser's answer reaches
        apply through the stored row, not through a value that lives only in memory
        — including the empty one, which the column must not have turned into NULL.
        """
        headers, _ = await _register_and_login(client, "apply-credo@example.com")
        account = await create_account(
            client, headers, currency="USD", name="Credo USD"
        )
        created = await client.post(
            "/statement-imports",
            files={
                "file": (
                    "statement.xlsx",
                    credo_xlsx_bytes,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
            data={"account_id": str(account["id"]), "format": "credo_xlsx_v1"},
            headers=headers,
        )
        assert created.status_code == 201, created.text

        applied = await client.post(
            f"/statement-imports/{created.json()['id']}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        transactions = await _transactions(client, headers, str(account["id"]))
        booked = {tx["merchant"]: tx for tx in transactions}
        purchase = booked["YANDEX.EDA"]
        assert (purchase["amount_minor"], purchase["currency"]) == (1_979, "USD")
        assert (purchase["original_amount_minor"], purchase["original_currency"]) == (
            5_610,
            "BYN",
        )
        # The four lines the bank was talking about itself in — a fee, a top-up,
        # "Currency Exchange", a loan payment — and nothing else: six of the ten
        # rows did yield a name, so a blanket NULL would fail here too.
        merchants = [tx["merchant"] for tx in transactions]
        assert merchants.count(None) == 4
        assert "სხვა და სხვა საკომისიო" not in merchants


class TestStatementLearning:
    async def test_only_a_category_the_user_sent_teaches_the_maps(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """The learning gate, with its contrast in the same apply.

        A category the user PICKED teaches both maps; a suggestion the server made
        and the user simply left alone teaches nothing — otherwise the map confirms
        its own guess and the first mistake becomes permanent. The contrast is the
        bank bucket of the suggested row: its merchant key was already known, its
        bucket was not, and it must still not be after the apply.

        The suggestion itself is checked here too, including its precedence: the
        merchant map beats the bank's category, because one merchant is more
        specific than one of the bank's 22 buckets.
        """
        headers, user_id = await _register_and_login(
            client, "apply-learning@example.com"
        )
        account_id = await _byn_account(client, headers)
        groceries = await _create_category(client, headers, "Продукты мои")
        small = await _create_category(client, headers, "Мелочи")
        bucket = await _create_category(client, headers, "Из корзины банка")

        # The merchant map, seeded the way it is really written: by confirming a
        # transaction with a merchant and a category. Its amount and date are far
        # outside the statement, so it can never become a match candidate.
        seed = await client.post(
            "/transactions",
            json={
                "account_id": account_id,
                "amount_minor": 999,
                "kind": "expense",
                "occurred_at": "2026-01-15",
                "merchant": "PAYBYCARD.BY",
                "category_id": small,
            },
            headers=headers,
        )
        assert seed.status_code == 201, seed.text
        # …and the bank map, holding a DIFFERENT category for the same row's bucket.
        db_session.add(
            BankCategoryMap(
                user_id=user_id,
                bank_category="Прочие расходы",
                category_id=uuid.UUID(bucket),
            )
        )
        await db_session.commit()

        created = await _upload(client, headers, account_id, statement_csv_bytes)
        import_id = created.json()["id"]
        rows = await _rows(client, headers, import_id)
        suggested = rows["PAYBYCARD.BY"]
        assert suggested["suggested_category_id"] == small
        assert suggested["suggestion_source"] == "merchant"
        assert suggested["category_id"] == small
        assert suggested["category_user_set"] is False

        chosen = await client.patch(
            f"/statement-imports/{import_id}/rows/{rows['МАГАЗИН ПРОДУКТЫ']['id']}",
            json={"category_id": groceries},
            headers=headers,
        )
        assert chosen.status_code == 200, chosen.text
        assert chosen.json()["category_user_set"] is True

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )
        assert applied.status_code == 200, applied.text

        learned_merchants = dict(
            (
                await db_session.execute(
                    select(
                        MerchantCategoryMap.merchant_norm,
                        MerchantCategoryMap.category_id,
                    )
                )
            )
            .tuples()
            .all()
        )
        learned_buckets = dict(
            (
                await db_session.execute(
                    select(BankCategoryMap.bank_category, BankCategoryMap.category_id)
                )
            )
            .tuples()
            .all()
        )
        assert learned_merchants["магазин продукты"] == uuid.UUID(groceries)
        assert learned_buckets["Магазины продуктовые"] == uuid.UUID(groceries)
        # The passively accepted suggestion taught NOTHING: its merchant key still
        # points where the seed put it, and its bucket is still the pre-seeded one.
        assert learned_merchants["paybycard.by"] == uuid.UUID(small)
        assert learned_buckets["Прочие расходы"] == uuid.UUID(bucket)

    async def test_the_merchant_map_is_keyed_by_the_shop_name_not_the_sentence(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        credo_xlsx_bytes: bytes,
    ) -> None:
        """Both ends of the map use the name the transaction is filed under.

        A Credo description carries the purchase's own amount and date, so keyed by
        it the map would mint one key per purchase: never a suggestion, and a table
        growing one useless row per line. Read and write are asserted in ONE test
        because they are one fact — a suggestion that arrives under a key the
        learning does not write back is worse than no suggestion at all.
        """
        headers, _ = await _register_and_login(client, "apply-credo-map@example.com")
        account = await create_account(
            client, headers, currency="USD", name="Credo map"
        )
        account_id = str(account["id"])
        delivery = await _create_category(client, headers, "Доставка еды")
        shops = await _create_category(client, headers, "Магазины")
        # The map as it is really seeded: a transaction the user categorized under
        # the shop's name. Far outside the statement, so it is never a candidate.
        seed = await client.post(
            "/transactions",
            json={
                "account_id": account_id,
                "amount_minor": 999,
                "kind": "expense",
                "occurred_at": "2026-01-15",
                "merchant": "YANDEX.EDA",
                "category_id": delivery,
            },
            headers=headers,
        )
        assert seed.status_code == 201, seed.text

        created = await client.post(
            "/statement-imports",
            files={
                "file": (
                    "statement.xlsx",
                    credo_xlsx_bytes,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
            data={"account_id": account_id, "format": "credo_xlsx_v1"},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        import_id = created.json()["id"]
        rows = await _rows(client, headers, import_id)

        suggested = rows["გადახდა - YANDEX.EDA 56.10 BYN 01.08.2026"]
        assert suggested["suggested_category_id"] == delivery
        assert suggested["suggestion_source"] == "merchant"

        santa = rows['გადახდა - SHOP "SANTA-362" BAPB 22.97 BYN 31.07.2026']
        chosen = await client.patch(
            f"/statement-imports/{import_id}/rows/{santa['id']}",
            json={"category_id": shops},
            headers=headers,
        )
        assert chosen.status_code == 200, chosen.text
        # A line with NO merchant, categorized by hand: it must teach the bank's
        # bucket and nothing else. Keyed by its description it would put a
        # once-in-a-lifetime sentence into the merchant map — the very thing the
        # empty string exists to prevent.
        fee = rows["სხვა და სხვა საკომისიო"]
        taught = await client.patch(
            f"/statement-imports/{import_id}/rows/{fee['id']}",
            json={"category_id": shops},
            headers=headers,
        )
        assert taught.status_code == 200, taught.text
        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )
        assert applied.status_code == 200, applied.text

        learned = dict(
            (
                await db_session.execute(
                    select(
                        MerchantCategoryMap.merchant_norm,
                        MerchantCategoryMap.category_id,
                    )
                )
            )
            .tuples()
            .all()
        )
        assert learned['shop "santa-362" bapb'] == uuid.UUID(shops)
        assert not [key for key in learned if "22.97" in key]
        # The nameless line taught the merchant map NOTHING — neither its sentence
        # nor an empty key — while the bank's own bucket did learn from it.
        assert "სხვა და სხვა საკომისიო" not in learned
        assert "" not in learned
        bank_learned = dict(
            (
                await db_session.execute(
                    select(
                        BankCategoryMap.bank_category,
                        BankCategoryMap.category_id,
                    )
                )
            )
            .tuples()
            .all()
        )
        assert bank_learned["სხვა და სხვა საკომისიო"] == uuid.UUID(shops)
