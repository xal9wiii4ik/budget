"""The statement's own arithmetic: the apply/replace gate and the balance stamp.

Three things live or die here, all of them about money the user cannot re-check
by hand:

* a statement whose SELF-CHECK failed must never become transactions — its rows
  are shown so the user can find the misread line, and both writes refuse it;
* after a write, the balance the app holds for the account on the statement's
  ``period_to`` is compared with the closing balance the bank PRINTED, in the
  same transaction as the money. The comparison is informational, but a wrong one
  would accuse a correct import (or absolve a broken one), so its two edges are
  pinned: the date cutoff and the sign of the difference;
* the format decides whether there is anything to compare at all — Credo prints
  both anchors and proves them, Priorbank prints none and answers
  ``not_available`` rather than guessing.

The parser, the matcher, apply's own semantics and the preview routes have their
own files; nothing of theirs is re-asserted.
"""

import uuid
from datetime import date
from typing import Any

from helpers import create_account
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.services.account_balances import account_balance_as_of

PASSWORD = "password123"
CREDO_FORMAT = "credo_xlsx_v1"
PRIORBANK_FORMAT = "priorbank_csv_v1"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

#: What the synthetic Credo workbook says about itself (tests/helpers.py): the
#: period, both printed anchors, and therefore the net the ten rows must move.
PERIOD_FROM = date(2026, 8, 1)
PERIOD_TO = date(2026, 8, 31)
OPENING_MINOR = 100_000
CLOSING_MINOR = 179_637
STATEMENT_NET_MINOR = CLOSING_MINOR - OPENING_MINOR


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


async def _upload_credo(
    client: AsyncClient,
    headers: dict[str, str],
    account_id: str,
    credo_xlsx_bytes: bytes,
) -> dict[str, Any]:
    created = await client.post(
        "/statement-imports",
        files={"file": ("statement.xlsx", credo_xlsx_bytes, XLSX_MIME)},
        data={"account_id": account_id, "format": CREDO_FORMAT},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body: dict[str, Any] = created.json()
    return body


async def _credo_account(
    client: AsyncClient, headers: dict[str, str], starting_balance_minor: int
) -> str:
    """A USD account opened at ``starting_balance_minor`` — the statement's ledger."""
    account = await create_account(
        client,
        headers,
        currency="USD",
        name="Credo USD",
        starting_balance_minor=starting_balance_minor,
    )
    return str(account["id"])


async def _post_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def _session_of(
    client: AsyncClient, headers: dict[str, str], import_id: str
) -> dict[str, Any]:
    read = await client.get(f"/statement-imports/{import_id}", headers=headers)
    assert read.status_code == 200, read.text
    body: dict[str, Any] = read.json()
    return body


class TestSelfCheckGate:
    async def test_a_failed_self_check_refuses_both_writes_and_keeps_the_preview(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        credo_xlsx_bytes: bytes,
    ) -> None:
        """The statement does not add up: no money, but the preview stays usable.

        The gate lives in ``_load_target``, next to the write and inside the
        procedure the IntegrityError arm retries — so BOTH writes inherit it and no
        retry path can slip past it. What must NOT be refused is the editing: the
        user is the only one who can look at the rows and find the line the parser
        misread, so the row PATCH still answers 200 and the session stays
        ``parsed``.

        The failed columns are written straight to the stored session: the only
        producer of a ``failed`` self-check is the Alfa extractor (S3), and this
        gate is not about how the verdict was reached.
        """
        headers, _ = await _register_and_login(client, "selfcheck-gate@example.com")
        account_id = await _credo_account(client, headers, OPENING_MINOR)
        created = await _upload_credo(client, headers, account_id, credo_xlsx_bytes)
        import_id = created["id"]
        await db_session.execute(
            text(
                "UPDATE statement_imports SET self_check_status = 'failed', "
                "self_check_failed = 'balance', self_check_expected_minor = :expected,"
                " self_check_actual_minor = :actual WHERE id = :id"
            ),
            {
                "id": uuid.UUID(import_id),
                "expected": CLOSING_MINOR,
                "actual": CLOSING_MINOR - 1_979,
            },
        )
        await db_session.commit()

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )
        replaced = await client.post(
            f"/statement-imports/{import_id}/replace",
            json={"from_date": PERIOD_FROM.isoformat(), "confirm_deleted_total": 0},
            headers=headers,
        )

        assert applied.status_code == 422, applied.text
        assert applied.json() == {"detail": "STATEMENT_BALANCE_MISMATCH"}
        assert replaced.status_code == 422, replaced.text
        assert replaced.json() == {"detail": "STATEMENT_BALANCE_MISMATCH"}
        ledger = await client.get(
            "/transactions", params={"account_id": account_id}, headers=headers
        )
        assert ledger.status_code == 200, ledger.text
        assert ledger.json()["items"] == []
        session = await _session_of(client, headers, import_id)
        assert session["status"] == "parsed"
        # The numbers the refusal is about ride the session read, which is why the
        # 422 body stays a bare code.
        assert session["self_check_status"] == "failed"
        assert session["self_check_failed"] == "balance"
        assert session["self_check_expected_minor"] == CLOSING_MINOR
        assert session["self_check_actual_minor"] == CLOSING_MINOR - 1_979
        rows = await client.get(f"/statement-imports/{import_id}/rows", headers=headers)
        assert rows.status_code == 200, rows.text
        patched = await client.patch(
            f"/statement-imports/{import_id}/rows/{rows.json()['items'][0]['id']}",
            json={"decision": "skip"},
            headers=headers,
        )
        assert patched.status_code == 200, patched.text


class TestBalanceStamp:
    async def test_apply_stamps_a_match_and_cuts_the_ledger_at_period_to(
        self,
        client: AsyncClient,
        credo_xlsx_bytes: bytes,
    ) -> None:
        """``match``, and the date cutoff that decides it (amendment A1).

        The account is opened so that the statement's own ten rows plus ONE
        transaction dated exactly ``period_to`` land on the printed closing
        balance. A second transaction dated ``period_to + 1 day`` must NOT count:
        it is money the account has, but not money the statement's period is about.
        Either edge read wrong (``< period_to``, or ``<=`` the next day) turns this
        into a ``mismatch``, which is exactly the accusation a correct import must
        never collect.

        Both extra rows are created AFTER the upload on purpose: the matcher looked
        at the ledger as it was at upload time, and this test is about the stamp,
        not about the verdicts.
        """
        headers, _ = await _register_and_login(client, "balance-match@example.com")
        last_day_minor = 1_000
        account_id = await _credo_account(
            client, headers, CLOSING_MINOR - STATEMENT_NET_MINOR - last_day_minor
        )
        import_id = (
            await _upload_credo(client, headers, account_id, credo_xlsx_bytes)
        )["id"]
        await _post_tx(
            client,
            headers,
            account_id=account_id,
            amount_minor=last_day_minor,
            kind="income",
            occurred_at=PERIOD_TO.isoformat(),
        )
        await _post_tx(
            client,
            headers,
            account_id=account_id,
            amount_minor=5_000,
            kind="income",
            occurred_at="2026-09-01",
        )

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        session = await _session_of(client, headers, import_id)
        assert session["balance_check"] == "match"
        assert session["app_balance_minor_at_end"] == CLOSING_MINOR
        assert session["balance_diff_minor"] == 0

    async def test_apply_stamps_a_mismatch_signed_app_minus_closing(
        self,
        client: AsyncClient,
        credo_xlsx_bytes: bytes,
    ) -> None:
        """One transaction the statement does not know about, inside the period.

        The SIGN is the content of this test: ``app - closing``, so a positive
        difference means our ledger holds more than the bank says. A flipped
        subtraction would read as plausibly as the right one on screen and send the
        user looking for the wrong kind of error.
        """
        headers, _ = await _register_and_login(client, "balance-mismatch@example.com")
        account_id = await _credo_account(client, headers, OPENING_MINOR)
        import_id = (
            await _upload_credo(client, headers, account_id, credo_xlsx_bytes)
        )["id"]
        extra_minor = 2_500
        await _post_tx(
            client,
            headers,
            account_id=account_id,
            amount_minor=extra_minor,
            kind="income",
            occurred_at="2026-08-15",
        )

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        session = await _session_of(client, headers, import_id)
        assert session["balance_check"] == "mismatch"
        assert session["app_balance_minor_at_end"] == CLOSING_MINOR + extra_minor
        assert session["balance_diff_minor"] == extra_minor

    async def test_replace_stamps_the_check_in_its_own_transaction(
        self,
        client: AsyncClient,
        credo_xlsx_bytes: bytes,
    ) -> None:
        """The destructive write owes the user the same number as the other one.

        ``replace`` re-files the whole range in its own transaction and ignores the
        per-row decisions, so it reaches the stamp through a different code path —
        and a stamp written only on the apply side would leave the one screen that
        just deleted data with no answer at all.
        """
        headers, _ = await _register_and_login(client, "balance-replace@example.com")
        account_id = await _credo_account(client, headers, OPENING_MINOR)
        import_id = (
            await _upload_credo(client, headers, account_id, credo_xlsx_bytes)
        )["id"]

        replaced = await client.post(
            f"/statement-imports/{import_id}/replace",
            json={"from_date": PERIOD_FROM.isoformat(), "confirm_deleted_total": 0},
            headers=headers,
        )

        assert replaced.status_code == 200, replaced.text
        session = await _session_of(client, headers, import_id)
        assert session["status"] == "replaced"
        assert session["balance_check"] == "match"
        assert session["app_balance_minor_at_end"] == CLOSING_MINOR
        assert session["balance_diff_minor"] == 0

    async def test_a_priorbank_apply_has_no_closing_balance_to_check_against(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """No anchors in the format → ``not_available``, not a zero and not a guess.

        The contrast to every assertion above, and the reason the three columns are
        nullable at all: the Priorbank export prints no balances, so there is
        nothing to compare and saying so is the only honest answer. A silent 0 here
        would read as "your ledger is empty".
        """
        headers, _ = await _register_and_login(client, "balance-priorbank@example.com")
        account = await create_account(client, headers, currency="BYN")
        created = await client.post(
            "/statement-imports",
            files={"file": ("Vpsk.csv", statement_csv_bytes, "text/csv")},
            data={"account_id": str(account["id"]), "format": PRIORBANK_FORMAT},
            headers=headers,
        )
        assert created.status_code == 201, created.text
        import_id = created.json()["id"]

        applied = await client.post(
            f"/statement-imports/{import_id}/apply", headers=headers
        )

        assert applied.status_code == 200, applied.text
        session = await _session_of(client, headers, import_id)
        assert session["opening_balance_minor"] is None
        assert session["closing_balance_minor"] is None
        assert session["self_check_status"] == "not_available"
        assert session["balance_check"] == "not_available"
        assert session["app_balance_minor_at_end"] is None
        assert session["balance_diff_minor"] is None

    async def test_a_credo_session_carries_the_anchors_it_already_proved(
        self, client: AsyncClient, credo_xlsx_bytes: bytes
    ) -> None:
        """The format proves its chain on every parse; the session now SAYS so.

        The anchors have to survive the parser → session → wire trip for the stamp
        above to have anything to compare against, and ``passed`` is the verdict of
        the running-balance chain that already ran (a Credo mismatch raises and
        never reaches a session at all). Before any write, ``balance_check`` is
        ``not_available``: nothing has been applied, so there is no app balance to
        report.
        """
        headers, _ = await _register_and_login(client, "balance-credo@example.com")
        account_id = await _credo_account(client, headers, OPENING_MINOR)

        created = await _upload_credo(client, headers, account_id, credo_xlsx_bytes)

        assert created["opening_balance_minor"] == OPENING_MINOR
        assert created["closing_balance_minor"] == CLOSING_MINOR
        assert created["self_check_status"] == "passed"
        assert created["self_check_failed"] is None
        assert created["self_check_expected_minor"] is None
        assert created["balance_check"] == "not_available"


class TestAccountBalanceAsOf:
    async def test_as_of_today_is_the_balance_the_accounts_list_publishes(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """ONE definition of "balance", proven on the rows that make it hard.

        The stamp above would be useless — worse, actively misleading — if "the
        app's balance" meant something slightly different from the number the
        accounts screen shows. The two readers share ``_legs``; this test is what
        would catch someone giving the date-cut one a rule of its own.

        The ledger holds exactly the shapes a second definition tends to get
        wrong: a starting balance (dated nowhere), a transfer OUT (leg 1, signed
        like an expense) and a transfer IN from another account (leg 2, in THIS
        account's own currency), plus a debt movement, which the money aggregates
        of ``tx_totals`` deliberately exclude and an account balance must not.
        """
        headers, user_id = await _register_and_login(client, "as-of@example.com")
        account = await create_account(
            client, headers, currency="BYN", starting_balance_minor=50_000
        )
        other = await create_account(client, headers, currency="BYN", name="Other BYN")
        account_id = str(account["id"])
        await _post_tx(
            client,
            headers,
            account_id=account_id,
            amount_minor=12_345,
            kind="expense",
            occurred_at="2026-08-10",
        )
        await _post_tx(
            client,
            headers,
            account_id=account_id,
            amount_minor=7_000,
            kind="transfer",
            counter_account_id=str(other["id"]),
            counter_amount_minor=7_000,
            occurred_at="2026-08-11",
        )
        await _post_tx(
            client,
            headers,
            account_id=str(other["id"]),
            amount_minor=3_000,
            kind="transfer",
            counter_account_id=account_id,
            counter_amount_minor=3_000,
            occurred_at="2026-08-12",
        )
        debt = await client.post(
            "/debts",
            json={
                "direction": "lent",
                "counterparty": "Петя",
                "currency": "BYN",
                "amount_minor": 10_000,
                "account_id": account_id,
                "opened_on": "2026-08-13",
            },
            headers=headers,
        )
        assert debt.status_code == 201, debt.text

        listed = await client.get("/accounts", headers=headers)
        assert listed.status_code == 200, listed.text
        (published,) = [a for a in listed.json() if a["id"] == account_id]
        as_of = await account_balance_as_of(
            db_session, user_id, uuid.UUID(account_id), date(2026, 12, 31)
        )

        assert as_of == published["balance_minor"]
        # Not a tautology over two empty sums: the four shapes above are really in
        # there, and the debt movement really did leave the account.
        assert as_of == 50_000 - 12_345 - 7_000 + 3_000 - 10_000
