"""/accounts CRUD + the COMPUTED balance — real Postgres, real migrations, no mocks.

Covers only what is unique to this router: the balance formula (architecture §2 —
the one number here that is not stored anywhere and can silently disagree with the
ledger), the archive switch, the immutable currency, and the no-oracle 404. The
transfer legs that feed the balance are created through ``POST /transactions``,
because a balance computed from hand-inserted rows would prove nothing about the
path that actually books money.

Pure-Pydantic rejections (missing name, lowercase currency, unknown type, name >
100 chars) are QA-curl-owned per the grooming split.
"""

import uuid
from typing import Any

from helpers import account_for_currency, create_account
from httpx import AsyncClient

PASSWORD = "password123"


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


async def _list_accounts(
    client: AsyncClient, headers: dict[str, str], **params: Any
) -> list[dict[str, Any]]:
    resp = await client.get("/accounts", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    listed: list[dict[str, Any]] = resp.json()
    return listed


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("occurred_at", "2026-03-15")
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


class TestAccountCrud:
    async def test_create_reports_opening_balance_and_patch_keeps_omitted_fields(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "acc-crud@x.com")

        created = await create_account(
            client,
            headers,
            name="Карта USD",
            currency="USD",
            starting_balance_minor=100_000,
        )

        # A fresh account has no movements, so the computed balance IS the opening
        # one — the identity every later assertion in this file is measured against.
        assert created["balance_minor"] == created["starting_balance_minor"] == 100_000
        assert created["archived"] is False

        patched = await client.patch(
            f"/accounts/{created['id']}", json={"name": "Карта"}, headers=headers
        )

        assert patched.status_code == 200, patched.text
        # omit=keep: a name-only edit must not reset the money or the type.
        assert patched.json() == {**created, "name": "Карта"}

    async def test_list_hides_archived_until_asked_and_still_reports_its_balance(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "acc-archive@x.com")
        live = await create_account(client, headers, name="Live", currency="RUB")
        old = await create_account(
            client, headers, name="Old", currency="RUB", starting_balance_minor=7_000
        )
        archived = await client.patch(
            f"/accounts/{old['id']}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text

        default = await _list_accounts(client, headers)
        inclusive = await _list_accounts(client, headers, include_archived=True)

        assert [row["id"] for row in default] == [live["id"]]
        # An archived account still owns its money: it reappears with a real
        # balance, not a blanked one.
        assert [row["id"] for row in inclusive] == [live["id"], old["id"]]
        assert inclusive[1]["balance_minor"] == 7_000

    async def test_currency_is_immutable(self, client: AsyncClient) -> None:
        headers = await _register_and_login(client, "acc-cur@x.com")
        account = await create_account(client, headers, currency="USD")

        resp = await client.patch(
            f"/accounts/{account['id']}", json={"currency": "EUR"}, headers=headers
        )

        # Refused, not silently ignored: every transaction on the account is stamped
        # with this currency (§4), so "converting" it would restate history.
        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "ACCOUNT_CURRENCY_IMMUTABLE"}
        assert (await _list_accounts(client, headers))[0]["currency"] == "USD"

    async def test_requires_auth(self, client: AsyncClient) -> None:
        # Once per router, per conventions.
        resp = await client.get("/accounts")
        assert resp.status_code == 401


class TestBalance:
    async def test_balance_sums_every_leg_at_its_own_account(
        self, client: AsyncClient
    ) -> None:
        """The §2 formula, all four terms at once, with a negative opening balance.

        The transfer's target is a JPY (exponent 0) account on purpose: its leg is
        added VERBATIM in yen. Any conversion — or any x100 — on the counter leg
        would show up here as a 100x error rather than as a rounding difference.
        """
        headers = await _register_and_login(client, "acc-balance@x.com")
        card = await create_account(
            client,
            headers,
            name="Card",
            currency="USD",
            starting_balance_minor=-5_000,  # a card legitimately starts in the red
        )
        cash = await create_account(
            client, headers, name="Cash", currency="JPY", type="cash"
        )

        await _create_tx(
            client, headers, account_id=card["id"], amount_minor=50_000, kind="income"
        )
        await _create_tx(
            client, headers, account_id=card["id"], amount_minor=20_000, kind="expense"
        )
        await _create_tx(
            client,
            headers,
            account_id=card["id"],
            amount_minor=10_000,
            kind="transfer",
            counter_account_id=cash["id"],
            counter_amount_minor=15_000,
        )

        balances = {
            row["name"]: row["balance_minor"]
            for row in await _list_accounts(client, headers)
        }

        # -5000 + 50000 - 20000 - 10000 (the transfer leaves like an expense).
        assert balances["Card"] == 15_000
        # ...and lands as ¥15000 exactly, in the target's own currency.
        assert balances["Cash"] == 15_000

    async def test_patching_the_opening_balance_shifts_the_computed_one(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "acc-opening@x.com")
        account = await create_account(
            client, headers, currency="RUB", starting_balance_minor=10_000
        )
        await _create_tx(
            client,
            headers,
            account_id=account["id"],
            amount_minor=3_000,
            kind="expense",
        )

        patched = await client.patch(
            f"/accounts/{account['id']}",
            json={"starting_balance_minor": -5_000},
            headers=headers,
        )

        # 7000 before; the opening balance moved by -15000 and so did the balance —
        # the recorded movements are untouched (OQ-4: a setup fact, not history).
        assert patched.status_code == 200, patched.text
        assert patched.json()["balance_minor"] == -8_000

    async def test_transfer_between_two_of_my_accounts_is_one_row_two_legs(
        self, client: AsyncClient
    ) -> None:
        """A deleted transfer returns BOTH balances — the single-row model's payoff."""
        headers = await _register_and_login(client, "acc-onerow@x.com")
        src = await create_account(
            client, headers, name="Src", currency="USD", starting_balance_minor=100_000
        )
        dst = await create_account(client, headers, name="Dst", currency="BYN")
        transfer = await _create_tx(
            client,
            headers,
            account_id=src["id"],
            amount_minor=10_000,
            kind="transfer",
            counter_account_id=dst["id"],
            counter_amount_minor=33_000,
        )

        listed = await client.get("/transactions", headers=headers)
        deleted = await client.delete(
            f"/transactions/{transfer['id']}", headers=headers
        )
        after = {
            row["name"]: row["balance_minor"]
            for row in await _list_accounts(client, headers)
        }

        # ONE row in the list, carrying both sides (never two half-transfers).
        assert listed.json()["total"] == 1
        assert listed.json()["items"][0]["id"] == transfer["id"]
        assert deleted.status_code == 204, deleted.text
        assert after == {"Src": 100_000, "Dst": 0}


class TestNoOracle:
    async def test_foreign_and_missing_account_answer_identically(
        self, client: AsyncClient
    ) -> None:
        headers_a = await _register_and_login(client, "acc-owner@x.com")
        theirs = await create_account(client, headers_a, name="Theirs")
        # Archived on top of foreign: the guard order must still answer NOT_FOUND —
        # ACCOUNT_ARCHIVED would confirm the id exists (plan risk 1).
        assert (
            await client.patch(
                f"/accounts/{theirs['id']}", json={"archived": True}, headers=headers_a
            )
        ).status_code == 200

        headers_b = await _register_and_login(client, "acc-spy@x.com")
        foreign = await client.patch(
            f"/accounts/{theirs['id']}", json={"name": "mine now"}, headers=headers_b
        )
        missing = await client.patch(
            f"/accounts/{uuid.uuid4()}", json={"name": "mine now"}, headers=headers_b
        )

        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json() == {"detail": "ACCOUNT_NOT_FOUND"}

    async def test_writing_to_an_archived_own_account_is_rejected(
        self, client: AsyncClient
    ) -> None:
        """The contrast to the test above: MY archived account does say ARCHIVED."""
        headers = await _register_and_login(client, "acc-arch-write@x.com")
        account = await create_account(client, headers, currency="RUB")
        assert (
            await client.patch(
                f"/accounts/{account['id']}", json={"archived": True}, headers=headers
            )
        ).status_code == 200

        resp = await client.post(
            "/transactions",
            json={
                "amount_minor": 100,
                "kind": "expense",
                "account_id": account["id"],
                "occurred_at": "2026-03-15",
            },
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "ACCOUNT_ARCHIVED"}
        # ...and un-archiving makes it writable again, so "archived" is a switch and
        # not a one-way door.
        assert (
            await client.patch(
                f"/accounts/{account['id']}", json={"archived": False}, headers=headers
            )
        ).status_code == 200
        assert (
            await _create_tx(
                client,
                headers,
                account_id=account["id"],
                amount_minor=100,
                kind="expense",
            )
        )["account_id"] == account["id"]

    async def test_new_user_has_no_accounts(self, client: AsyncClient) -> None:
        headers = await _register_and_login(client, "acc-empty@x.com")

        # No implicit default account is created on register: the empty state is
        # real, and the clients are expected to render it.
        assert await _list_accounts(client, headers) == []
        assert await account_for_currency(client, headers) is not None
