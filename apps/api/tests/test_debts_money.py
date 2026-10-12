"""The money of a debt: balances, aggregates, remaining, and every refusal.

This is the file the debts scope exists for. Three facts have to hold TOGETHER —
the account balance moves like real money, no income/expense aggregate sees the
movement, and ``remaining`` stays consistent through every edit — so each test
asserts the sources that must agree rather than one of them.

The router's own surface (shape, access, idempotency) is ``test_debts.py``; the
four-case kind table is pinned here as a pure test, next to the balances it
decides.
"""

import csv
import io
import uuid
from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from test_debts import (
    account,
    balance_of,
    create_debt,
    register_and_login,
    repay,
    today,
)

from budget_api.domain.debts import movement_kind
from budget_api.domain.periods import month_key
from budget_api.enums import DebtDirection, DebtRole, TransactionKind


async def _summaries(
    client: AsyncClient, headers: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """``/transactions/summary`` and ``/stats/summary`` for the current month."""
    month = month_key(today().replace(day=1))
    tx = await client.get(
        "/transactions/summary", params={"month": month}, headers=headers
    )
    stats = await client.get(
        "/stats/summary", params={"period": "month", "month": month}, headers=headers
    )
    assert tx.status_code == 200, tx.text
    assert stats.status_code == 200, stats.text
    tx_body: dict[str, Any] = tx.json()
    stats_body: dict[str, Any] = stats.json()
    return tx_body, stats_body


class TestMovementKind:
    def test_the_four_cases_of_direction_and_role(self) -> None:
        """The ONE place the sign of debt money is decided (``domain/debts``).

        No cross-table CHECK can hold this (the direction is on ``debts``, the kind
        on ``transactions``), so the guard is this pure table plus an immutable
        direction plus a single writer — and the table itself is pinned here. Get
        one cell wrong and a repayment subtracts from the account it should have
        credited.
        """
        kinds = {
            (direction.value, role.value): movement_kind(direction, role)
            for direction in DebtDirection
            for role in DebtRole
        }

        assert kinds == {
            ("lent", "principal"): TransactionKind.expense,
            ("lent", "repayment"): TransactionKind.income,
            ("borrowed", "principal"): TransactionKind.income,
            ("borrowed", "repayment"): TransactionKind.expense,
        }


class TestBalancesAndAggregates:
    async def test_lending_moves_the_balance_but_no_aggregate_sees_it(
        self, client: AsyncClient
    ) -> None:
        """The headline requirement (task.md §3), asserted across all three sources.

        The money really leaves the account — anything else would make the app
        disagree with the bank — while ``/transactions/summary`` and
        ``/stats/summary`` stay at the real spending, with no extra
        ``unconverted_count`` and no uncategorized bucket invented for the
        movement. One test for both aggregates on purpose: they read the SAME
        predicate, and the thing worth proving is that the predicate is applied at
        all.
        """
        headers = await register_and_login(client, "debt-aggregate@example.com")
        # RUB, the default base currency: the real expense below then needs no rate
        # and a leak would show up as a number rather than as an unconverted flag.
        card = await account(client, headers, currency="RUB")
        real_expense = await client.post(
            "/transactions",
            json={
                "account_id": card["id"],
                "amount_minor": 2_500,
                "kind": "expense",
                "occurred_at": today().isoformat(),
            },
            headers=headers,
        )
        assert real_expense.status_code == 201, real_expense.text

        await create_debt(client, headers, str(card["id"]), currency="RUB")

        assert await balance_of(client, headers, str(card["id"])) == 87_500
        tx_summary, stats_summary = await _summaries(client, headers)
        assert (tx_summary["expense_minor"], tx_summary["income_minor"]) == (2_500, 0)
        assert tx_summary["net_minor"] == -2_500
        assert tx_summary["unconverted_count"] == 0
        assert [b["total_minor"] for b in tx_summary["by_category"]] == [2_500]
        assert (stats_summary["expense_minor"], stats_summary["income_minor"]) == (
            2_500,
            0,
        )

    async def test_borrowing_credits_the_account_and_a_repayment_debits_it_back(
        self, client: AsyncClient
    ) -> None:
        """The other direction, both roles — the kind table seen through balances."""
        headers = await register_and_login(client, "debt-borrow@example.com")
        card = await account(client, headers)

        debt = await create_debt(
            client, headers, str(card["id"]), direction="borrowed", amount_minor=30_000
        )
        assert await balance_of(client, headers, str(card["id"])) == 130_000

        paid = await repay(client, headers, debt["id"], str(card["id"]), 12_000)

        assert paid.status_code == 201, paid.text
        assert paid.json()["remaining_minor"] == 18_000
        assert await balance_of(client, headers, str(card["id"])) == 118_000
        tx_summary, _ = await _summaries(client, headers)
        assert (tx_summary["expense_minor"], tx_summary["income_minor"]) == (0, 0)


class TestRemaining:
    async def test_partial_then_final_repayment_closes_the_debt_on_the_last_date(
        self, client: AsyncClient
    ) -> None:
        """``remaining``/``status``/``closed_on`` are arithmetic, not stored flags."""
        headers = await register_and_login(client, "debt-remaining@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))
        yesterday = (today() - timedelta(days=1)).isoformat()

        part = await repay(
            client, headers, debt["id"], str(card["id"]), 4_000, occurred_at=yesterday
        )
        rest = await repay(client, headers, debt["id"], str(card["id"]), 6_000)

        assert part.json()["remaining_minor"] == 6_000
        assert (part.json()["status"], part.json()["closed_on"]) == ("open", None)
        body = rest.json()
        assert (body["repaid_minor"], body["remaining_minor"]) == (10_000, 0)
        assert (body["status"], body["closed_on"]) == ("closed", today().isoformat())
        # Oldest first, and each repayment carries both currencies' amounts.
        assert [r["occurred_at"] for r in body["repayments"]] == [
            yesterday,
            today().isoformat(),
        ]
        assert await balance_of(client, headers, str(card["id"])) == 100_000

    async def test_deleting_the_closing_repayment_reopens_the_debt(
        self, client: AsyncClient
    ) -> None:
        """Nothing is recomputed on delete — which is the point of deriving status.

        The balance goes back with it, in the same request: the repayment row IS
        the money, so removing it is both facts at once.
        """
        headers = await register_and_login(client, "debt-reopen@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))
        closing = await repay(client, headers, debt["id"], str(card["id"]), 10_000)
        repayment_id = closing.json()["repayments"][0]["id"]

        deleted = await client.delete(
            f"/debts/{debt['id']}/repayments/{repayment_id}", headers=headers
        )

        assert deleted.status_code == 204, deleted.text
        reopened = (await client.get(f"/debts/{debt['id']}", headers=headers)).json()
        assert (reopened["status"], reopened["closed_on"]) == ("open", None)
        assert (reopened["remaining_minor"], reopened["repayments_count"]) == (
            10_000,
            0,
        )
        assert await balance_of(client, headers, str(card["id"])) == 90_000


class TestOverpayment:
    async def test_a_repayment_beyond_the_remainder_is_refused_open_or_closed(
        self, client: AsyncClient
    ) -> None:
        """One code for both, because "closed" IS "nothing left to repay".

        The refusal is total: no row is written, so the balance and the remainder
        are exactly what they were.
        """
        headers = await register_and_login(client, "debt-overpay@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))

        too_much = await repay(client, headers, debt["id"], str(card["id"]), 10_001)
        assert (
            await repay(client, headers, debt["id"], str(card["id"]), 10_000)
        ).status_code == 201
        on_closed = await repay(client, headers, debt["id"], str(card["id"]), 1)

        for resp in (too_much, on_closed):
            assert resp.status_code == 422, resp.text
            assert resp.json()["detail"] == "DEBT_REPAYMENT_EXCEEDS_REMAINING"
        assert await balance_of(client, headers, str(card["id"])) == 100_000
        detail = (await client.get(f"/debts/{debt['id']}", headers=headers)).json()
        assert (detail["repaid_minor"], detail["repayments_count"]) == (10_000, 1)

    async def test_shrinking_the_principal_below_what_was_repaid_is_refused(
        self, client: AsyncClient
    ) -> None:
        """The other half of the same invariant: ``remaining`` may never go below 0.

        A correction DOWN to exactly what was repaid is legal (it closes the debt)
        — the contrast is what makes the refusal meaningful rather than a blanket
        "no edits".
        """
        headers = await register_and_login(client, "debt-shrink@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))
        assert (
            await repay(client, headers, debt["id"], str(card["id"]), 4_000)
        ).status_code == 201

        refused = await client.patch(
            f"/debts/{debt['id']}", json={"amount_minor": 3_999}, headers=headers
        )
        exact = await client.patch(
            f"/debts/{debt['id']}", json={"amount_minor": 4_000}, headers=headers
        )

        assert refused.status_code == 422, refused.text
        assert refused.json()["detail"] == "DEBT_PRINCIPAL_BELOW_REPAID"
        assert exact.status_code == 200, exact.text
        assert (exact.json()["remaining_minor"], exact.json()["status"]) == (
            0,
            "closed",
        )
        # The opening movement followed the correction: 10000 out, 4000 back.
        assert await balance_of(client, headers, str(card["id"])) == 100_000


class TestCurrencyPair:
    async def test_the_account_amount_is_required_across_currencies_only(
        self, client: AsyncClient
    ) -> None:
        """The ONE rule for every movement (architecture §Currency), all three arms.

        A USD debt opened from a BYN card is the realistic case: the server stores
        both amounts and converts nothing, because the rate that applied is the
        user's fact. Within one currency the second amount is the SAME number, so
        the server copies it and refuses a value that disagrees instead of
        restating one of them.
        """
        headers = await register_and_login(client, "debt-currency@example.com")
        byn = await account(client, headers, currency="BYN")

        missing = await client.post(
            "/debts",
            json={
                "direction": "lent",
                "counterparty": "Петя",
                "currency": "USD",
                "amount_minor": 5_000,
                "account_id": byn["id"],
                "opened_on": today().isoformat(),
            },
            headers=headers,
        )
        across = await client.post(
            "/debts",
            json={
                "direction": "lent",
                "counterparty": "Петя",
                "currency": "USD",
                "amount_minor": 5_000,
                "account_id": byn["id"],
                "opened_on": today().isoformat(),
                "account_amount_minor": 16_800,
            },
            headers=headers,
        )
        disagreeing = await client.post(
            "/debts",
            json={
                "direction": "lent",
                "counterparty": "Петя",
                "currency": "BYN",
                "amount_minor": 5_000,
                "account_id": byn["id"],
                "opened_on": today().isoformat(),
                "account_amount_minor": 5_001,
            },
            headers=headers,
        )
        within = await create_debt(client, headers, str(byn["id"]), amount_minor=3_000)

        assert (missing.status_code, missing.json()["detail"]) == (
            422,
            "DEBT_ACCOUNT_AMOUNT_REQUIRED",
        )
        assert (disagreeing.status_code, disagreeing.json()["detail"]) == (
            422,
            "DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE",
        )
        assert across.status_code == 201, across.text
        body = across.json()
        # Both amounts stored verbatim, each in its own currency; nothing converted.
        assert body["currency"] == "USD"
        assert (body["principal_minor"], body["remaining_minor"]) == (5_000, 5_000)
        assert (body["account_currency"], body["account_amount_minor"]) == (
            "BYN",
            16_800,
        )
        assert (within["principal_minor"], within["account_amount_minor"]) == (
            3_000,
            3_000,
        )
        # 168.00 + 30.00 BYN left the card; the USD debt did not touch it twice.
        assert (
            await balance_of(client, headers, str(byn["id"]))
            == 100_000 - 16_800 - 3_000
        )

    async def test_moving_a_repayment_to_a_third_currency_needs_the_account_amount(
        self, client: AsyncClient
    ) -> None:
        """The stored integer is minor units of the OLD account's currency, so a
        restamp alone would redefine what came back: the move is refused whole and
        then accepted with the amount, and both balances follow.

        The contrast arm is the move to an account denominated in the DEBT's own
        currency — there the server copies the debt amount and asks for nothing,
        because the two numbers are then the same number.
        """
        headers = await register_and_login(client, "debt-move@example.com")
        byn = await account(client, headers, currency="BYN")
        rub = await account(
            client, headers, currency="RUB", name="RUB card", starting_balance_minor=0
        )
        usd = await account(
            client, headers, currency="USD", name="USD card", starting_balance_minor=0
        )
        debt = await create_debt(
            client,
            headers,
            str(byn["id"]),
            currency="USD",
            amount_minor=5_000,
            account_amount_minor=16_800,
        )
        paid = await repay(
            client,
            headers,
            debt["id"],
            str(byn["id"]),
            2_000,
            account_amount_minor=6_700,
        )
        repayment_id = paid.json()["repayments"][0]["id"]

        refused = await client.patch(
            f"/debts/{debt['id']}/repayments/{repayment_id}",
            json={"account_id": rub["id"]},
            headers=headers,
        )
        moved = await client.patch(
            f"/debts/{debt['id']}/repayments/{repayment_id}",
            json={"account_id": rub["id"], "account_amount_minor": 160_000},
            headers=headers,
        )
        onto_debt_currency = await client.patch(
            f"/debts/{debt['id']}/repayments/{repayment_id}",
            json={"account_id": usd["id"]},
            headers=headers,
        )

        assert (refused.status_code, refused.json()["detail"]) == (
            422,
            "AMOUNT_REQUIRED_ON_CURRENCY_CHANGE",
        )
        assert moved.status_code == 200, moved.text
        (repayment,) = moved.json()["repayments"]
        assert (repayment["account_currency"], repayment["account_amount_minor"]) == (
            "RUB",
            160_000,
        )
        # The debt-currency amount is untouched by a move, so is the remainder.
        assert (repayment["amount_minor"], moved.json()["remaining_minor"]) == (
            2_000,
            3_000,
        )
        assert onto_debt_currency.status_code == 200, onto_debt_currency.text
        (copied,) = onto_debt_currency.json()["repayments"]
        assert (copied["account_currency"], copied["account_amount_minor"]) == (
            "USD",
            2_000,
        )
        # The money followed the row: the BYN card kept only the opening movement,
        # the RUB card is empty again and the USD one holds the repayment.
        assert await balance_of(client, headers, str(byn["id"])) == 100_000 - 16_800
        assert await balance_of(client, headers, str(rub["id"])) == 0
        assert await balance_of(client, headers, str(usd["id"])) == 2_000


class TestEdits:
    async def test_editing_a_repayment_keeps_the_remainder_and_the_balance_in_step(
        self, client: AsyncClient
    ) -> None:
        """One write, two consequences — and they are the same row, so they cannot
        drift: the amount the account saw IS the amount the debt counts.

        Both arms of the edit ceiling run here: 4 000 → 7 000 passes under a
        principal of 10 000 only because the edited repayment's OWN stored amount
        is subtracted first (a naive ``repaid + new`` would refuse it), and the
        same edit to 10 001 is refused.
        """
        headers = await register_and_login(client, "debt-edit@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))
        paid = await repay(client, headers, debt["id"], str(card["id"]), 4_000)
        repayment_id = paid.json()["repayments"][0]["id"]

        edited = await client.patch(
            f"/debts/{debt['id']}/repayments/{repayment_id}",
            json={"amount_minor": 7_000, "note": "пересчитали"},
            headers=headers,
        )

        assert edited.status_code == 200, edited.text
        assert edited.json()["remaining_minor"] == 3_000
        (repayment,) = edited.json()["repayments"]
        assert (repayment["amount_minor"], repayment["note"]) == (7_000, "пересчитали")
        assert await balance_of(client, headers, str(card["id"])) == 97_000

        beyond = await client.patch(
            f"/debts/{debt['id']}/repayments/{repayment_id}",
            json={"amount_minor": 10_001},
            headers=headers,
        )

        assert beyond.status_code == 422, beyond.text
        assert beyond.json()["detail"] == "DEBT_REPAYMENT_EXCEEDS_REMAINING"

    async def test_the_debt_movements_carry_their_debt_id_into_the_csv_export(
        self, client: AsyncClient
    ) -> None:
        """The appended column, on the one row shape that fills it.

        The export is the file users reconcile by hand, and a debt movement that
        looked like an ordinary expense there would be the very confusion this
        scope removes.
        """
        headers = await register_and_login(client, "debt-csv@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))
        assert (
            await repay(client, headers, debt["id"], str(card["id"]), 1_000)
        ).status_code == 201

        resp = await client.get("/transactions/export", headers=headers)

        assert resp.status_code == 200, resp.text
        rows = list(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))))
        assert {row["debt_id"] for row in rows} == {debt["id"]}
        assert {row["kind"] for row in rows} == {"expense", "income"}
        assert {row["base_amount"] for row in rows} == {""}


class TestDelete:
    async def test_deleting_the_debt_takes_its_movements_and_the_balance_with_it(
        self, client: AsyncClient
    ) -> None:
        """Real DELETE with an FK cascade (architecture §"Delete a whole debt").

        The balance reverting is the assertion that matters: the movements are gone
        from the ledger, not merely hidden from ``/debts``.
        """
        headers = await register_and_login(client, "debt-delete@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))
        assert (
            await repay(client, headers, debt["id"], str(card["id"]), 3_000)
        ).status_code == 201
        assert await balance_of(client, headers, str(card["id"])) == 93_000

        deleted = await client.delete(f"/debts/{debt['id']}", headers=headers)

        assert deleted.status_code == 204, deleted.text
        assert (
            await client.get(f"/debts/{debt['id']}", headers=headers)
        ).status_code == 404
        assert (await client.get("/debts", headers=headers)).json()["items"] == []
        listed = await client.get("/transactions", headers=headers)
        assert listed.json()["items"] == []
        assert await balance_of(client, headers, str(card["id"])) == 100_000


class TestConstraintsNoApiPathCanReach:
    """The two table guards the API cannot violate — asserted straight against the
    DB: the partial UNIQUE INDEX that keeps a debt to one principal, and the CHECK
    that keeps a category off a debt movement.

    Written at the SQL level on purpose: every router path is already refused
    before the database sees it, so these pin what protects the table from a
    future writer (a job, a migration, psql).
    """

    async def test_a_second_principal_is_impossible(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers = await register_and_login(client, "debt-check-principal@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))

        with pytest.raises(IntegrityError):
            await db_session.execute(
                text(
                    "INSERT INTO transactions (id, user_id, account_id, amount_minor,"
                    " kind, currency, occurred_at, debt_id, debt_role,"
                    " debt_amount_minor) SELECT :id, user_id, account_id,"
                    " amount_minor, kind, currency, occurred_at, debt_id, debt_role,"
                    " debt_amount_minor FROM transactions WHERE debt_id = :debt_id"
                ),
                {"id": uuid.uuid4(), "debt_id": uuid.UUID(debt["id"])},
            )
        await db_session.rollback()

    async def test_a_debt_movement_cannot_carry_a_category(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers = await register_and_login(client, "debt-check-category@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))
        category = await client.get("/categories", headers=headers)
        category_id = category.json()[0]["id"]

        with pytest.raises(IntegrityError):
            await db_session.execute(
                text(
                    "UPDATE transactions SET category_id = :category_id"
                    " WHERE debt_id = :debt_id"
                ),
                {
                    "category_id": uuid.UUID(category_id),
                    "debt_id": uuid.UUID(debt["id"]),
                },
            )
        await db_session.rollback()
