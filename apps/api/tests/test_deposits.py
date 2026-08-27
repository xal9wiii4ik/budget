"""/deposits + the hermeticity of a deposit's hidden account — real Postgres.

Covers what is unique to this scope and nothing that another file already proves:

* the assembly a unit test cannot reach — ``initial_balance_minor`` becoming the
  account's opening body, the timeline seeded from it, and the accrued figure that
  falls out of a BACK-DATED create (the formulas themselves live in
  ``test_deposits_domain.py``);
* the four doors that keep a ``type='deposit'`` account out of the ordinary money
  surface — one test per door, because each is a different mechanism (a SQL
  filter, a router guard, the client-facing type vocabulary, a write refusal in
  two routers);
* the refusals and the no-oracle 404 of the new router;
* the two DB CHECKs that no API path can reach (the anchor pair, the rebuilt
  account-type CHECK of migration 0012).

The live QA checklist owns the end-to-end money path (transfer → summary → tax →
archive) on a real server; everything above is what pytest can prove better.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from helpers import create_account
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Account, Deposit

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


def _today() -> date:
    return datetime.now(UTC).date()


async def _create_deposit(
    client: AsyncClient, headers: dict[str, str], **overrides: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Вклад",
        "currency": "BYN",
        "rate_percent": "10.95",
        "capitalization": "none",
        "opened_on": (_today() - timedelta(days=100)).isoformat(),
        "initial_balance_minor": 100_000,
        **overrides,
    }
    resp = await client.post("/deposits", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


class TestDepositCreation:
    async def test_back_dated_create_reports_body_and_interest_immediately(
        self, client: AsyncClient
    ) -> None:
        # The headline case (task.md §5): a deposit opened 100 days ago must show
        # its interest on the FIRST read, which only works if the opening body
        # reached the account's starting balance and the timeline was seeded from
        # it. 100000 * 10.95 % * 100/365 = 3000 exactly.
        headers = await _register_and_login(client, "dep-create@x.com")

        created = await _create_deposit(client, headers)

        assert created["balance_minor"] == 100_000
        assert created["accrued_minor"] == 3_000
        assert created["accrued_after_tax_minor"] is None
        assert created["status"] == "active"
        assert created["currency"] == "BYN"
        assert created["rate_percent"] == "10.95"
        assert created["accrued_override_minor"] is None
        assert created["accrued_override_as_of"] is None

        detail = await client.get(f"/deposits/{created['id']}", headers=headers)
        listed = await client.get("/deposits", headers=headers)

        # One assembler behind all three responses: a list row that disagreed with
        # the detail would be two truths about one deposit.
        assert detail.status_code == 200, detail.text
        assert detail.json() == created
        assert listed.json() == [created]

    async def test_matured_deposit_freezes_its_interest_and_says_so(
        self, client: AsyncClient
    ) -> None:
        # The same 3000 as above, but earned 100 days BEFORE a term that has since
        # passed: the number is the term's, not the age's, and the row says
        # `matured` without disappearing from the list.
        headers = await _register_and_login(client, "dep-matured@x.com")

        created = await _create_deposit(
            client,
            headers,
            opened_on=(_today() - timedelta(days=200)).isoformat(),
            term_end=(_today() - timedelta(days=100)).isoformat(),
        )

        assert created["status"] == "matured"
        assert created["accrued_minor"] == 3_000

    async def test_requires_auth(self, client: AsyncClient) -> None:
        # Once per router, per conventions.
        resp = await client.get("/deposits")
        assert resp.status_code == 401


class TestDepositValidation:
    async def test_term_ending_before_it_starts_is_refused_on_create_and_patch(
        self, client: AsyncClient
    ) -> None:
        # A CHECK violation would surface as a 500; this is the user error it is.
        # The PATCH arm compares the EFFECTIVE pair, so moving `opened_on` past a
        # stored `term_end` is refused just like sending both at once.
        headers = await _register_and_login(client, "dep-term@x.com")
        opened = _today() - timedelta(days=100)

        created = await client.post(
            "/deposits",
            json={
                "name": "Плохой срок",
                "currency": "BYN",
                "rate_percent": "5",
                "capitalization": "none",
                "opened_on": opened.isoformat(),
                "term_end": opened.isoformat(),
            },
            headers=headers,
        )

        assert created.status_code == 422, created.text
        assert created.json() == {"detail": "DEPOSIT_TERM_BEFORE_OPENING"}

        deposit = await _create_deposit(
            client, headers, term_end=(_today() + timedelta(days=10)).isoformat()
        )
        patched = await client.patch(
            f"/deposits/{deposit['id']}",
            json={"opened_on": (_today() + timedelta(days=30)).isoformat()},
            headers=headers,
        )

        assert patched.status_code == 422, patched.text
        assert patched.json() == {"detail": "DEPOSIT_TERM_BEFORE_OPENING"}

    @pytest.mark.parametrize(
        "field,value",
        [
            # Bounds that mirror the DB columns: without them these reach the
            # driver as a DataError (a 500), not as a refusal.
            ("rate_percent", "-1"),
            ("rate_percent", "10000"),
            ("tax_rate_percent", "100.01"),
            ("initial_balance_minor", -1),
        ],
    )
    async def test_out_of_range_money_and_rates_are_refused_at_the_contract(
        self, client: AsyncClient, field: str, value: object
    ) -> None:
        headers = await _register_and_login(client, f"dep-range-{field}-{value}@x.com")

        resp = await client.post(
            "/deposits",
            json={
                "name": "Границы",
                "currency": "BYN",
                "rate_percent": "5",
                "capitalization": "none",
                "opened_on": _today().isoformat(),
                field: value,
            },
            headers=headers,
        )

        assert resp.status_code == 422, resp.text

    async def test_the_manual_anchor_cannot_be_half_stored(
        self, db_session: AsyncSession
    ) -> None:
        # Unreachable through the API (the router writes both halves or neither),
        # which is exactly why the invariant lives in the database: a number with
        # no date would anchor the forecast to nothing.
        user_id = uuid.uuid4()
        await db_session.execute(
            text("INSERT INTO users (id, email, hashed_password) VALUES (:i,:e,:p)"),
            {"i": user_id, "e": "anchor@x.com", "p": "x"},
        )
        account = Account(
            user_id=user_id, name="ledger", currency="BYN", type="deposit"
        )
        db_session.add(account)
        await db_session.flush()
        db_session.add(
            Deposit(
                user_id=user_id,
                account_id=account.id,
                name="Вклад",
                rate_percent=5,
                capitalization="none",
                opened_on=date(2026, 1, 1),
                accrued_override_minor=1_000,
            )
        )

        with pytest.raises(IntegrityError, match="ck_deposits_accrued_override_pair"):
            await db_session.commit()

    async def test_account_type_check_accepts_deposit_and_nothing_new(
        self, db_session: AsyncSession
    ) -> None:
        # Migration 0012 REBUILT ck_accounts_type_valid instead of dropping it: the
        # third value is accepted, a fourth one still is not. If AccountType had
        # grown its value anywhere but at the end, the model's rendered CHECK and
        # the migration's would have diverged and this pair would disagree.
        user_id = uuid.uuid4()
        await db_session.execute(
            text("INSERT INTO users (id, email, hashed_password) VALUES (:i,:e,:p)"),
            {"i": user_id, "e": "type-check@x.com", "p": "x"},
        )
        db_session.add(
            Account(user_id=user_id, name="ledger", currency="BYN", type="deposit")
        )
        await db_session.commit()

        db_session.add(
            Account(user_id=user_id, name="broker", currency="BYN", type="brokerage")
        )
        with pytest.raises(IntegrityError, match="ck_accounts_type_valid"):
            await db_session.commit()


class TestDepositScoping:
    async def test_foreign_and_missing_deposits_answer_one_byte_identical_404(
        self, client: AsyncClient
    ) -> None:
        # No-oracle, including the guard ORDER: the foreign deposit below is
        # ARCHIVED, so a router that checked archived-before-not-found would leak
        # DEPOSIT_ARCHIVED and confirm the id exists.
        owner = await _register_and_login(client, "dep-owner@x.com")
        stranger = await _register_and_login(client, "dep-stranger@x.com")
        deposit = await _create_deposit(client, owner)
        archived = await client.patch(
            f"/deposits/{deposit['id']}", json={"archived": True}, headers=owner
        )
        assert archived.status_code == 200, archived.text
        missing = uuid.uuid4()

        responses = [
            await client.get(f"/deposits/{deposit['id']}", headers=stranger),
            await client.get(f"/deposits/{missing}", headers=stranger),
            await client.patch(
                f"/deposits/{deposit['id']}", json={"name": "x"}, headers=stranger
            ),
            await client.patch(
                f"/deposits/{missing}", json={"name": "x"}, headers=stranger
            ),
        ]

        assert {r.status_code for r in responses} == {404}
        assert {r.text for r in responses} == {'{"detail":"DEPOSIT_NOT_FOUND"}'}
        # And the stranger's own list never shows it either.
        listed = await client.get("/deposits", headers=stranger)
        assert listed.json() == []


class TestDepositArchive:
    async def test_archiving_closes_the_deposit_and_its_account_together(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "dep-archive@x.com")
        card = await create_account(client, headers, name="Карта", currency="BYN")
        deposit = await _create_deposit(client, headers)

        archived = await client.patch(
            f"/deposits/{deposit['id']}", json={"archived": True}, headers=headers
        )

        assert archived.status_code == 200, archived.text
        # AMENDMENT §3: a non-zero balance does NOT block the archive, and the row
        # keeps reporting its money.
        assert archived.json()["archived"] is True
        assert archived.json()["balance_minor"] == 100_000

        transfer = await client.post(
            "/transactions",
            json={
                "kind": "transfer",
                "account_id": card["id"],
                "counter_account_id": deposit["account_id"],
                "amount_minor": 1_000,
                "counter_amount_minor": 1_000,
                "occurred_at": _today().isoformat(),
            },
            headers=headers,
        )

        # The cascade's whole purpose: the door is shut by the EXISTING account
        # guard, not by a new deposit-specific rule in the transactions router.
        assert transfer.status_code == 422, transfer.text
        assert transfer.json() == {"detail": "ACCOUNT_ARCHIVED"}

        # An archived deposit is a record, not a form: further edits are refused.
        renamed = await client.patch(
            f"/deposits/{deposit['id']}", json={"name": "Новое имя"}, headers=headers
        )
        assert renamed.status_code == 422, renamed.text
        assert renamed.json() == {"detail": "DEPOSIT_ARCHIVED"}

        # Archiving must not "reveal" the ledger account in the archive-inclusive
        # list — that list is where a leak would be easiest to miss.
        accounts = await client.get(
            "/accounts", params={"include_archived": True}, headers=headers
        )
        assert [row["id"] for row in accounts.json()] == [card["id"]]

    async def test_unarchiving_reopens_the_deposit_and_its_account(
        self, client: AsyncClient
    ) -> None:
        # The escape hatch. Archiving is allowed with money still on the deposit,
        # so without a way back the balance of a deposit archived by mistake would
        # be unreachable forever: every edit here is refused by DEPOSIT_ARCHIVED
        # and every transfer by ACCOUNT_ARCHIVED (the test above proves both).
        headers = await _register_and_login(client, "dep-unarchive@x.com")
        card = await create_account(client, headers, name="Карта", currency="BYN")
        deposit = await _create_deposit(client, headers)
        archived = await client.patch(
            f"/deposits/{deposit['id']}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text

        reopened = await client.patch(
            f"/deposits/{deposit['id']}", json={"archived": False}, headers=headers
        )

        assert reopened.status_code == 200, reopened.text
        assert reopened.json()["archived"] is False

        # The cascade runs both ways: the ledger account is open again, which is
        # the only thing that actually lets the money move.
        transfer = await client.post(
            "/transactions",
            json={
                "kind": "transfer",
                "account_id": card["id"],
                "counter_account_id": deposit["account_id"],
                "amount_minor": 1_000,
                "counter_amount_minor": 1_000,
                "occurred_at": _today().isoformat(),
            },
            headers=headers,
        )
        assert transfer.status_code == 201, transfer.text

    async def test_unarchiving_refuses_to_carry_other_edits(
        self, client: AsyncClient
    ) -> None:
        # Contrast with the test above: the escape hatch is exactly
        # {"archived": false} and nothing else. A field riding along is refused
        # WHOLE with its own code — neither silently dropped nor applied — so the
        # user learns that reopening and editing are two requests.
        headers = await _register_and_login(client, "dep-unarchive-only@x.com")
        deposit = await _create_deposit(client, headers)
        archived = await client.patch(
            f"/deposits/{deposit['id']}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text

        refused = await client.patch(
            f"/deposits/{deposit['id']}",
            json={"archived": False, "name": "Новое имя"},
            headers=headers,
        )

        assert refused.status_code == 422, refused.text
        assert refused.json() == {"detail": "DEPOSIT_UNARCHIVE_ONLY"}
        # Refused WHOLE: neither half of the body landed.
        still = await client.get(f"/deposits/{deposit['id']}", headers=headers)
        assert still.json()["archived"] is True
        assert still.json()["name"] == deposit["name"]


class TestDepositAccountHermeticity:
    async def test_the_ledger_account_is_invisible_in_the_accounts_list(
        self, client: AsyncClient
    ) -> None:
        # Door 1 — the SQL filter. Any leak here puts deposit money into every
        # picker and every "total across accounts" the clients render.
        headers = await _register_and_login(client, "dep-hidden@x.com")
        card = await create_account(client, headers, name="Карта", currency="BYN")
        deposit = await _create_deposit(client, headers)

        listed = await client.get("/accounts", headers=headers)

        assert [row["id"] for row in listed.json()] == [card["id"]]
        assert deposit["account_id"] not in [row["id"] for row in listed.json()]

    async def test_patching_the_ledger_account_answers_the_ordinary_404(
        self, client: AsyncClient
    ) -> None:
        # Door 2 — the router guard. A 404 rather than a 403: /accounts does not
        # admit that this account exists at all (there is no GET /accounts/{id} in
        # this codebase, so PATCH is the only reachable door).
        headers = await _register_and_login(client, "dep-patch-account@x.com")
        deposit = await _create_deposit(client, headers)

        resp = await client.patch(
            f"/accounts/{deposit['account_id']}",
            json={"name": "hack"},
            headers=headers,
        )

        assert resp.status_code == 404, resp.text
        assert resp.json() == {"detail": "ACCOUNT_NOT_FOUND"}

    async def test_no_client_can_create_or_patch_an_account_into_a_deposit(
        self, client: AsyncClient
    ) -> None:
        # Door 3 — the type vocabulary itself: ``deposit`` is not a member of
        # AccountType, so neither write model can carry it (enums.py). Without that
        # a card could be PATCHed into a deposit account: it would vanish from the
        # list still holding its money, and belong to no deposit.
        headers = await _register_and_login(client, "dep-type-pin@x.com")
        card = await create_account(client, headers, name="Карта", currency="BYN")

        created = await client.post(
            "/accounts",
            json={"name": "fake", "type": "deposit", "currency": "BYN"},
            headers=headers,
        )
        patched = await client.patch(
            f"/accounts/{card['id']}", json={"type": "deposit"}, headers=headers
        )

        assert created.status_code == 422, created.text
        assert patched.status_code == 422, patched.text
        assert (await client.get("/accounts", headers=headers)).json()[0][
            "type"
        ] == "card"

    async def test_only_transfers_may_touch_a_deposit_account(
        self, client: AsyncClient
    ) -> None:
        # Door 4 — the write refusal, at all three of its entrances: creating an
        # expense on the deposit, MOVING an existing expense onto it, and pointing
        # a recurring template at it. Miss one and deposit money starts appearing
        # in expense aggregates.
        headers = await _register_and_login(client, "dep-spend@x.com")
        card = await create_account(client, headers, name="Карта", currency="BYN")
        deposit = await _create_deposit(client, headers)
        expense_body = {
            "kind": "expense",
            "amount_minor": 1_000,
            "occurred_at": _today().isoformat(),
        }

        created = await client.post(
            "/transactions",
            json={**expense_body, "account_id": deposit["account_id"]},
            headers=headers,
        )
        existing = await client.post(
            "/transactions",
            json={**expense_body, "account_id": card["id"]},
            headers=headers,
        )
        assert existing.status_code == 201, existing.text
        moved = await client.patch(
            f"/transactions/{existing.json()['id']}",
            json={"account_id": deposit["account_id"]},
            headers=headers,
        )
        template = await client.post(
            "/recurring",
            json={
                "name": "Подписка",
                "amount_minor": 1_000,
                "kind": "expense",
                "account_id": deposit["account_id"],
                "interval_unit": "month",
                "day_of_month": 5,
            },
            headers=headers,
        )

        for resp in (created, moved, template):
            assert resp.status_code == 422, resp.text
            assert resp.json() == {"detail": "DEPOSIT_ACCOUNT_TRANSFER_ONLY"}

    async def test_a_transfer_into_the_deposit_moves_both_balances(
        self, client: AsyncClient
    ) -> None:
        # The other half of door 4: the ONE operation that must still work, and the
        # only way the body ever changes after creation.
        headers = await _register_and_login(client, "dep-transfer@x.com")
        card = await create_account(
            client, headers, name="Карта", currency="BYN", starting_balance_minor=80_000
        )
        deposit = await _create_deposit(client, headers)

        transfer = await client.post(
            "/transactions",
            json={
                "kind": "transfer",
                "account_id": card["id"],
                "counter_account_id": deposit["account_id"],
                "amount_minor": 50_000,
                "counter_amount_minor": 50_000,
                "occurred_at": _today().isoformat(),
            },
            headers=headers,
        )
        assert transfer.status_code == 201, transfer.text

        after = (await client.get(f"/deposits/{deposit['id']}", headers=headers)).json()
        accounts = (await client.get("/accounts", headers=headers)).json()

        assert after["balance_minor"] == 150_000
        assert accounts[0]["balance_minor"] == 30_000
        # Dated today, so it has earned nothing yet: the interest is unchanged by a
        # top-up that spent no time on the deposit.
        assert after["accrued_minor"] == 3_000


class TestManualOverride:
    async def test_the_server_stamps_the_anchor_date_and_null_clears_the_pair(
        self, client: AsyncClient
    ) -> None:
        # The glue no domain test can reach: PATCH stores the figure the user read
        # off their bank WITH today's date (never a client-supplied one), an
        # unrelated PATCH keeps it (omit = keep), and an explicit null hands the
        # number back to the calculation.
        headers = await _register_and_login(client, "dep-override@x.com")
        deposit = await _create_deposit(client, headers)

        anchored = await client.patch(
            f"/deposits/{deposit['id']}",
            json={"accrued_override_minor": 9_999},
            headers=headers,
        )

        assert anchored.status_code == 200, anchored.text
        assert anchored.json()["accrued_override_minor"] == 9_999
        assert anchored.json()["accrued_override_as_of"] == _today().isoformat()
        # Anchored today: today's forecast IS the anchor, nothing has accrued since.
        assert anchored.json()["accrued_minor"] == 9_999

        renamed = await client.patch(
            f"/deposits/{deposit['id']}", json={"name": "Тот же вклад"}, headers=headers
        )
        assert renamed.json()["accrued_override_minor"] == 9_999

        cleared = await client.patch(
            f"/deposits/{deposit['id']}",
            json={"accrued_override_minor": None},
            headers=headers,
        )

        assert cleared.json()["accrued_override_minor"] is None
        assert cleared.json()["accrued_override_as_of"] is None
        assert cleared.json()["accrued_minor"] == 3_000

    async def test_the_tax_rate_turns_the_net_figure_on_and_off(
        self, client: AsyncClient
    ) -> None:
        # Two money figures in one response have to agree: 3000 - 13 % = 2610, and
        # clearing the rate returns NULL rather than the gross or a zero.
        headers = await _register_and_login(client, "dep-tax@x.com")
        deposit = await _create_deposit(client, headers)

        taxed = await client.patch(
            f"/deposits/{deposit['id']}",
            json={"tax_rate_percent": "13.00"},
            headers=headers,
        )

        assert taxed.status_code == 200, taxed.text
        assert taxed.json()["accrued_minor"] == 3_000
        assert taxed.json()["accrued_after_tax_minor"] == 2_610

        cleared = await client.patch(
            f"/deposits/{deposit['id']}",
            json={"tax_rate_percent": None},
            headers=headers,
        )

        assert cleared.json()["accrued_after_tax_minor"] is None


class TestPatAccess:
    async def test_a_token_may_read_deposits_and_may_not_write_them(
        self, client: AsyncClient, pat_factory: Any
    ) -> None:
        # The allowlist is fail-closed, so the two GET pairs must be PRESENT and the
        # two write pairs must be ABSENT — and absent means the endpoint gate
        # (TOKEN_ENDPOINT_FORBIDDEN), refused before scope is even consulted, which
        # is why the token below is a `full` one.
        headers = await _register_and_login(client, "dep-pat@x.com")
        deposit = await _create_deposit(client, headers)
        token = await pat_factory(client, headers, scope="full")
        pat_headers = {"Authorization": f"Bearer {token['token']}"}

        listed = await client.get("/deposits", headers=pat_headers)
        detail = await client.get(f"/deposits/{deposit['id']}", headers=pat_headers)
        created = await client.post(
            "/deposits",
            json={
                "name": "pat",
                "currency": "BYN",
                "rate_percent": "5",
                "capitalization": "none",
                "opened_on": _today().isoformat(),
            },
            headers=pat_headers,
        )
        patched = await client.patch(
            f"/deposits/{deposit['id']}",
            json={"accrued_override_minor": 1},
            headers=pat_headers,
        )

        assert listed.status_code == 200
        assert detail.json() == deposit
        for resp in (created, patched):
            assert resp.status_code == 403, resp.text
            assert resp.json() == {"detail": "TOKEN_ENDPOINT_FORBIDDEN"}
