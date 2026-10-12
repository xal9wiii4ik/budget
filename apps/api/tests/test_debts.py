"""``/debts`` — the router's own surface: reads, refusals, access and idempotency.

The MONEY of a debt (balances, aggregates, remaining, overpayment, the currency
pair) lives in ``test_debts_money.py``; this file covers what the ROUTER decides:
the shape it answers with, the guard order it inherits from the transactions
guards, the one 404 it uses at both levels of the path, and the ``client_id``
replay.

Deliberately NOT here: a 401 per route (one dependency, one code path — the PAT
suite covers it), Pydantic bounds, the existence of columns (migration +
``alembic check``), and the nine CHECKs one by one — only the two no API path can
reach are pinned, in the money file.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from helpers import create_account
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import ExchangeRate

PASSWORD = "password123"


async def register_and_login(client: AsyncClient, email: str) -> dict[str, str]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def today() -> date:
    return datetime.now(UTC).date()


async def account(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    currency: str = "BYN",
    starting_balance_minor: int = 100_000,
    name: str | None = None,
) -> dict[str, Any]:
    return await create_account(
        client,
        headers,
        name=name or f"{currency} card",
        currency=currency,
        starting_balance_minor=starting_balance_minor,
    )


async def balance_of(
    client: AsyncClient, headers: dict[str, str], account_id: str
) -> int:
    listed = await client.get(
        "/accounts", params={"include_archived": True}, headers=headers
    )
    assert listed.status_code == 200, listed.text
    (row,) = [a for a in listed.json() if a["id"] == account_id]
    balance: int = row["balance_minor"]
    return balance


async def create_debt(
    client: AsyncClient, headers: dict[str, str], account_id: str, **overrides: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "direction": "lent",
        "counterparty": "Петя",
        "currency": "BYN",
        "amount_minor": 10_000,
        "account_id": account_id,
        "opened_on": today().isoformat(),
    }
    body.update(overrides)
    resp = await client.post("/debts", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def repay(
    client: AsyncClient,
    headers: dict[str, str],
    debt_id: str,
    account_id: str,
    amount_minor: int,
    **overrides: Any,
) -> Any:
    body: dict[str, Any] = {
        "amount_minor": amount_minor,
        "account_id": account_id,
        "occurred_at": today().isoformat(),
    }
    body.update(overrides)
    return await client.post(f"/debts/{debt_id}/repayments", json=body, headers=headers)


class TestCreateAndRead:
    async def test_create_answers_with_the_derived_shape_and_badges_the_movement(
        self, client: AsyncClient
    ) -> None:
        """The response is assembled from the ledger, not echoed from the body.

        ``opened_on``, the account trio and every ``*_minor`` figure are read back
        off the opening MOVEMENT and the grouped totals, so this is also the proof
        that the two rows were written as one debt. The movement itself shows up in
        ``GET /transactions`` carrying the ``debt_id`` badge and NO category or base
        snapshot — the columns the nine CHECKs forbid on it.
        """
        headers = await register_and_login(client, "debt-create@example.com")
        card = await account(client, headers)
        due = (today() + timedelta(days=5)).isoformat()

        debt = await create_debt(
            client, headers, str(card["id"]), due_on=due, note="  за билеты  "
        )

        assert debt["direction"] == "lent"
        assert debt["counterparty"] == "Петя"
        assert (debt["currency"], debt["principal_minor"]) == ("BYN", 10_000)
        assert (debt["repaid_minor"], debt["remaining_minor"]) == (0, 10_000)
        assert (debt["status"], debt["closed_on"]) == ("open", None)
        assert debt["opened_on"] == today().isoformat()
        assert debt["account_id"] == card["id"]
        assert (debt["account_currency"], debt["account_amount_minor"]) == (
            "BYN",
            10_000,
        )
        assert (debt["due_on"], debt["note"]) == (due, "за билеты")
        assert (debt["repayments_count"], debt["repayments"]) == (0, [])

        listed = await client.get("/transactions", headers=headers)
        assert listed.status_code == 200, listed.text
        (movement,) = listed.json()["items"]
        assert movement["debt_id"] == debt["id"]
        assert movement["kind"] == "expense"  # lending moves money OUT
        assert movement["amount_minor"] == 10_000
        assert movement["category_id"] is None
        assert movement["base_amount_minor"] is None

    async def test_a_due_date_before_the_opening_is_refused(
        self, client: AsyncClient
    ) -> None:
        headers = await register_and_login(client, "debt-due@example.com")
        card = await account(client, headers)

        resp = await client.post(
            "/debts",
            json={
                "direction": "lent",
                "counterparty": "Петя",
                "currency": "BYN",
                "amount_minor": 10_000,
                "account_id": card["id"],
                "opened_on": today().isoformat(),
                "due_on": (today() - timedelta(days=1)).isoformat(),
            },
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "DEBT_DUE_BEFORE_OPENING"

        # The PATCH judges the EFFECTIVE pair, so moving the OTHER date into the
        # same illegal order is the same refusal.
        debt = await create_debt(
            client,
            headers,
            str(card["id"]),
            due_on=(today() + timedelta(days=7)).isoformat(),
        )
        moved = await client.patch(
            f"/debts/{debt['id']}",
            json={"opened_on": (today() + timedelta(days=30)).isoformat()},
            headers=headers,
        )

        assert moved.status_code == 422, moved.text
        assert moved.json()["detail"] == "DEBT_DUE_BEFORE_OPENING"

    async def test_the_account_guard_trio_answers_in_its_load_bearing_order(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """A debt movement resolves its account through the EXISTING transactions
        guards, so all three refusals must reach it: a stranger's (or missing)
        account is 404 BEFORE any 422 can confirm it exists, an archived own
        account is ACCOUNT_ARCHIVED, and a deposit ledger takes transfers only."""
        headers = await register_and_login(client, "debt-guards@example.com")
        other = await register_and_login(client, "debt-guards-2@example.com")
        foreign = await account(client, other, name="theirs")
        archived = await account(client, headers, name="old")
        patched = await client.patch(
            f"/accounts/{archived['id']}", json={"archived": True}, headers=headers
        )
        assert patched.status_code == 200, patched.text
        deposit = await client.post(
            "/deposits",
            json={
                "name": "Вклад",
                "currency": "BYN",
                "rate_percent": "10.00",
                "capitalization": "none",
                "opened_on": today().isoformat(),
                "initial_balance_minor": 100_000,
            },
            headers=headers,
        )
        assert deposit.status_code == 201, deposit.text

        answers = [
            await client.post(
                "/debts",
                json={
                    "direction": "lent",
                    "counterparty": "Петя",
                    "currency": "BYN",
                    "amount_minor": 10_000,
                    "account_id": account_id,
                    "opened_on": today().isoformat(),
                },
                headers=headers,
            )
            for account_id in (
                str(foreign["id"]),
                str(uuid.uuid4()),
                str(archived["id"]),
                str(deposit.json()["account_id"]),
            )
        ]

        assert [(r.status_code, r.json()["detail"]) for r in answers] == [
            (404, "ACCOUNT_NOT_FOUND"),
            (404, "ACCOUNT_NOT_FOUND"),
            (422, "ACCOUNT_ARCHIVED"),
            (422, "DEPOSIT_ACCOUNT_TRANSFER_ONLY"),
        ]
        assert await balance_of(client, headers, str(archived["id"])) == 100_000


class TestAccess:
    async def test_a_foreign_and_a_missing_id_answer_one_404_at_both_levels(
        self, client: AsyncClient
    ) -> None:
        """No-oracle, byte-identical, on the debt AND on the repayment path.

        Four questions — someone else's debt, a debt that never existed, a
        repayment of someone else's debt and a repayment id that is not this
        debt's — have to produce the SAME bytes, or the 404 becomes a probe for
        which ids exist.
        """
        owner = await register_and_login(client, "debt-owner@example.com")
        stranger = await register_and_login(client, "debt-stranger@example.com")
        card = await account(client, owner)
        debt = await create_debt(client, owner, str(card["id"]))
        paid = await repay(client, owner, debt["id"], str(card["id"]), 1_000)
        assert paid.status_code == 201, paid.text
        repayment_id = paid.json()["repayments"][0]["id"]
        mine = await create_debt(
            client, stranger, str((await account(client, stranger))["id"])
        )

        answers = [
            await client.get(f"/debts/{debt['id']}", headers=stranger),
            await client.get(f"/debts/{uuid.uuid4()}", headers=stranger),
            await client.patch(
                f"/debts/{debt['id']}/repayments/{repayment_id}",
                json={"amount_minor": 500},
                headers=stranger,
            ),
            await client.delete(
                f"/debts/{mine['id']}/repayments/{repayment_id}", headers=stranger
            ),
        ]

        bodies = {(r.status_code, r.text) for r in answers}
        assert bodies == {(404, '{"detail":"DEBT_NOT_FOUND"}')}
        listed = await client.get("/debts", headers=stranger)
        assert [row["id"] for row in listed.json()["items"]] == [mine["id"]]


class TestUpdate:
    async def test_a_closed_debt_still_takes_its_metadata_edits(
        self, client: AsyncClient
    ) -> None:
        """ "Closed" is a filter state, not a lock (architecture §Remaining): the
        person's name, the due date and the note stay editable, and the status is
        still derived from the movements afterwards."""
        headers = await register_and_login(client, "debt-closed-edit@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))
        settled = await repay(client, headers, debt["id"], str(card["id"]), 10_000)
        assert settled.json()["status"] == "closed", settled.text

        resp = await client.patch(
            f"/debts/{debt['id']}",
            json={"counterparty": "Пётр", "note": "вернул", "due_on": None},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert (body["counterparty"], body["note"], body["due_on"]) == (
            "Пётр",
            "вернул",
            None,
        )
        assert body["status"] == "closed"

    async def test_an_explicit_null_on_a_required_fact_is_refused(
        self, client: AsyncClient
    ) -> None:
        """NOT NULL columns cannot be cleared: without these the apply would reach
        the database and come back as a 500 instead of a code a form can act on."""
        headers = await register_and_login(client, "debt-null@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))

        answers = [
            await client.patch(
                f"/debts/{debt['id']}", json={field: None}, headers=headers
            )
            for field in ("amount_minor", "counterparty", "opened_on", "account_id")
        ]

        assert [(r.status_code, r.json()["detail"]) for r in answers] == [
            (422, "DEBT_AMOUNT_REQUIRED"),
            (422, "DEBT_COUNTERPARTY_REQUIRED"),
            (422, "DEBT_OPENED_ON_REQUIRED"),
            (422, "DEBT_ACCOUNT_REQUIRED"),
        ]


class TestIdempotency:
    async def test_a_replayed_client_id_returns_the_stored_entity_on_both_posts(
        self, client: AsyncClient
    ) -> None:
        """The B-1 mechanism, reused: a retried tool call must not lend twice.

        Both POSTs answer 200 with the STORED debt (not 201, not a duplicate), and
        the replay never consults the body — the second create sends a different
        amount and the first one's figures come back unchanged.

        The two refusals of the shared key space are the contrast: a key already
        spent on an ORDINARY transaction, and a repayment key replayed against a
        DIFFERENT debt than the path's — a replay must never answer with another
        debt's detail.
        """
        headers = await register_and_login(client, "debt-replay@example.com")
        card = await account(client, headers)
        debt_key = str(uuid.uuid4())
        repay_key = str(uuid.uuid4())
        first = await create_debt(client, headers, str(card["id"]), client_id=debt_key)
        paid = await repay(
            client, headers, first["id"], str(card["id"]), 1_000, client_id=repay_key
        )
        assert paid.status_code == 201, paid.text

        again = await client.post(
            "/debts",
            json={
                "direction": "lent",
                "counterparty": "Кто-то другой",
                "currency": "BYN",
                "amount_minor": 99_999,
                "account_id": card["id"],
                "opened_on": today().isoformat(),
                "client_id": debt_key,
            },
            headers=headers,
        )
        repaid_again = await repay(
            client, headers, first["id"], str(card["id"]), 2_000, client_id=repay_key
        )

        assert again.status_code == 200, again.text
        assert again.json()["id"] == first["id"]
        assert again.json()["principal_minor"] == 10_000
        assert repaid_again.status_code == 200, repaid_again.text
        assert repaid_again.json()["repaid_minor"] == 1_000
        listed = await client.get("/debts", headers=headers)
        assert len(listed.json()["items"]) == 1
        assert listed.json()["items"][0]["repayments_count"] == 1

        other = await create_debt(client, headers, str(card["id"]))
        wrong_debt = await repay(
            client, headers, other["id"], str(card["id"]), 1_000, client_id=repay_key
        )

        assert wrong_debt.status_code == 422, wrong_debt.text
        assert wrong_debt.json()["detail"] == "CLIENT_ID_IN_USE"

        # The key space is shared with /transactions, so a key spent there is not
        # a debt replay either.
        tx_key = str(uuid.uuid4())
        spent = await client.post(
            "/transactions",
            json={
                "amount_minor": 1_000,
                "kind": "expense",
                "account_id": card["id"],
                "occurred_at": today().isoformat(),
                "client_id": tx_key,
            },
            headers=headers,
        )
        assert spent.status_code == 201, spent.text
        reused = await client.post(
            "/debts",
            json={
                "direction": "lent",
                "counterparty": "Петя",
                "currency": "BYN",
                "amount_minor": 10_000,
                "account_id": card["id"],
                "opened_on": today().isoformat(),
                "client_id": tx_key,
            },
            headers=headers,
        )

        assert reused.status_code == 422, reused.text
        assert reused.json()["detail"] == "CLIENT_ID_IN_USE"


class TestTransactionsRefusesDebtMovements:
    async def test_patch_and_delete_of_a_debt_movement_are_refused(
        self, client: AsyncClient
    ) -> None:
        """One guard, one code, right after the 404 (architecture §Editing).

        Every field of a debt movement is derived from its debt, so an edit here
        would have to re-derive the debt's rules in a router that must not know
        about debts — and deleting the opening movement would orphan the debt. The
        balance is asserted afterwards: a refusal that half-applied would show up
        as money moving.
        """
        headers = await register_and_login(client, "debt-tx-readonly@example.com")
        card = await account(client, headers)
        debt = await create_debt(client, headers, str(card["id"]))
        listed = await client.get("/transactions", headers=headers)
        movement_id = listed.json()["items"][0]["id"]

        patched = await client.patch(
            f"/transactions/{movement_id}",
            json={"amount_minor": 1},
            headers=headers,
        )
        deleted = await client.delete(f"/transactions/{movement_id}", headers=headers)

        assert (patched.status_code, patched.json()["detail"]) == (
            422,
            "DEBT_MOVEMENT_READONLY",
        )
        assert (deleted.status_code, deleted.json()["detail"]) == (
            422,
            "DEBT_MOVEMENT_READONLY",
        )
        assert await balance_of(client, headers, str(card["id"])) == 90_000
        assert (await client.get(f"/debts/{debt['id']}", headers=headers)).json()[
            "remaining_minor"
        ] == 10_000


class TestSummary:
    async def test_each_side_is_summed_in_the_base_currency_and_the_rateless_counted(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The headline pair: converted by the SERVER, per side, exclude-and-flag.

        Base RUB (the default): a RUB debt needs no rate, a USD one is converted at
        today's stored rate, and a KRW one has none — it must be LEFT OUT of its
        side's total and counted there, never summed as zero. A closed debt
        contributes nothing at all.
        """
        headers = await register_and_login(client, "debt-summary@example.com")
        db_session.add(
            ExchangeRate(
                base="USD",
                quote="RUB",
                as_of_date=today(),
                rate=Decimal("80"),
                provider="test",
            )
        )
        await db_session.commit()
        rub = await account(client, headers, currency="RUB", name="RUB card")
        usd = await account(client, headers, currency="USD", name="USD card")
        krw = await account(
            client, headers, currency="KRW", name="KRW cash", starting_balance_minor=0
        )
        await create_debt(client, headers, str(rub["id"]), currency="RUB")
        await create_debt(
            client,
            headers,
            str(usd["id"]),
            currency="USD",
            amount_minor=5_000,
            direction="borrowed",
        )
        await create_debt(
            client,
            headers,
            str(krw["id"]),
            currency="KRW",
            amount_minor=7_000,
            direction="borrowed",
        )
        closed = await create_debt(
            client, headers, str(rub["id"]), currency="RUB", amount_minor=2_000
        )
        assert (
            await repay(client, headers, closed["id"], str(rub["id"]), 2_000)
        ).status_code == 201

        listed = await client.get("/debts", headers=headers)

        assert listed.status_code == 200, listed.text
        assert listed.json()["summary"] == {
            "base_currency": "RUB",
            # The closed 2000 RUB debt is out; the open one is 1:1.
            "owed_to_me_minor": 10_000,
            # 50.00 USD at 80 RUB = 4000.00 RUB; the KRW debt has no rate.
            "i_owe_minor": 400_000,
            "owed_to_me_unconverted_count": 0,
            "i_owe_unconverted_count": 1,
        }
