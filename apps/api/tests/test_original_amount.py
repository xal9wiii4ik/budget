"""The original leg of a transaction (S1) + the S3 receipt link — real Postgres.

What this file exists to catch, in one sentence each:

* the server DERIVING the settlement amount from the original pair — and, the part
  a plausible implementation gets wrong, snapshotting the DERIVED number rather
  than the one that was never sent (plan §7.2, on BOTH the create and the PATCH
  path);
* a sent ``amount_minor`` surviving untouched next to an original pair (the bank
  applied its own rate; the server has no business restating it);
* the pair being ATOMIC and its currency never equal to the account's — refused
  with the string codes the web form branches on, not a Pydantic array;
* the exponent crossings (JPY exponent 0, KWD exponent 3), which is where a
  hardcoded x100 would corrupt money by two orders of magnitude;
* ``receipt_id`` becoming editable (attach / detach / re-point) without turning a
  foreign receipt into an existence oracle.

NOT written here: that ``country`` round-trips through Read (a field copy),
"transfer_rate is unaffected", and "no MinIO call on detach" (there is no call to
make). Rates are seeded as ``exchange_rates`` rows, scheduler off, nothing mocked.
"""

import uuid
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from helpers import account_for_currency, create_account
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.enums import ReceiptStatus
from budget_api.models import ExchangeRate, Receipt

PASSWORD = "password123"

_DAY = date(2026, 3, 15)


async def _register_and_login(
    client: AsyncClient, email: str
) -> tuple[dict[str, str], uuid.UUID]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    user_id = uuid.UUID(reg.json()["id"])
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}, user_id


async def _seed_rate(
    session: AsyncSession, base: str, quote: str, rate: str, as_of: date = _DAY
) -> None:
    session.add(
        ExchangeRate(
            base=base,
            quote=quote,
            as_of_date=as_of,
            rate=Decimal(rate),
            provider="test",
        )
    )
    await session.commit()


async def _post(client: AsyncClient, headers: dict[str, str], **body: Any) -> Any:
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", _DAY.isoformat())
    return await client.post("/transactions", json=body, headers=headers)


async def _byn_account(client: AsyncClient, headers: dict[str, str]) -> str:
    return await account_for_currency(client, headers, "BYN")


class TestCreateOriginal:
    async def test_derived_settlement_amount_drives_the_base_snapshot(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The scope's headline: 50 EUR spent, 165 BYN debited, RUB books.

        The base snapshot MUST be 165 BYN converted to RUB. Computing it from the
        payload's ``amount_minor`` (which was never sent) or from the EUR original
        both produce something else — and no EUR→RUB rate exists here, so a
        snapshot taken off the original leg cannot even resolve.
        """
        headers, _ = await _register_and_login(client, "orig-derive@x.com")
        await _seed_rate(db_session, "EUR", "BYN", "3.30")
        await _seed_rate(db_session, "BYN", "RUB", "27.00")
        account_id = await _byn_account(client, headers)

        resp = await _post(
            client,
            headers,
            account_id=account_id,
            original_amount_minor=5000,  # 50.00 EUR
            original_currency="EUR",
            country="BY",
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["amount_minor"] == 16500  # 50.00 x 3.30 = 165.00 BYN
        assert body["currency"] == "BYN"
        assert body["original_amount_minor"] == 5000
        assert body["original_currency"] == "EUR"
        assert body["country"] == "BY"
        assert body["original_rate"] == "3.3"
        # 165.00 BYN x 27.00 = 4455.00 RUB — the DERIVED amount, converted once more.
        assert body["base_amount_minor"] == 445500
        assert body["base_currency"] == "RUB"

    async def test_sent_settlement_amount_beats_the_daily_rate(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The bank charged 170 BYN, our daily rate says 165. The bank wins."""
        headers, _ = await _register_and_login(client, "orig-sent@x.com")
        await _seed_rate(db_session, "EUR", "BYN", "3.30")
        await _seed_rate(db_session, "BYN", "RUB", "27.00")
        account_id = await _byn_account(client, headers)

        resp = await _post(
            client,
            headers,
            account_id=account_id,
            amount_minor=17000,
            original_amount_minor=5000,
            original_currency="EUR",
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["amount_minor"] == 17000  # NOT the 16500 the rate would give
        assert body["base_amount_minor"] == 459000  # 170.00 x 27.00, off the sent one
        assert body["original_rate"] == "3.4"  # the bank's rate, derived not stored

    @pytest.mark.parametrize(
        "half", [{"original_amount_minor": 5000}, {"original_currency": "EUR"}]
    )
    async def test_half_a_pair_is_refused_symmetrically(
        self, client: AsyncClient, half: dict[str, Any]
    ) -> None:
        headers, _ = await _register_and_login(client, "orig-half@x.com")
        account_id = await _byn_account(client, headers)

        resp = await _post(
            client, headers, account_id=account_id, amount_minor=100, **half
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "ORIGINAL_FIELDS_REQUIRED"

    async def test_original_currency_equal_to_the_account_is_refused(
        self, client: AsyncClient
    ) -> None:
        # NULL already means "priced in the account's own currency"; accepting a
        # second spelling would fork original_rate, the CSV row and every PATCH branch.
        headers, _ = await _register_and_login(client, "orig-same@x.com")
        account_id = await _byn_account(client, headers)

        resp = await _post(
            client,
            headers,
            account_id=account_id,
            amount_minor=100,
            original_amount_minor=100,
            original_currency="BYN",
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "ORIGINAL_CURRENCY_MATCHES_ACCOUNT"

    async def test_original_on_a_transfer_is_refused(self, client: AsyncClient) -> None:
        headers, _ = await _register_and_login(client, "orig-transfer@x.com")
        source = await _byn_account(client, headers)
        target = str((await create_account(client, headers, currency="RUB"))["id"])

        resp = await _post(
            client,
            headers,
            kind="transfer",
            account_id=source,
            amount_minor=10000,
            counter_account_id=target,
            counter_amount_minor=270000,
            original_amount_minor=5000,
            original_currency="EUR",
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "TRANSFER_ORIGINAL_FORBIDDEN"

    async def test_no_rate_refuses_with_a_code_and_writes_nothing(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Only 6 canonical pairs are stored, so this is an ORDINARY answer.

        422 with a code the form can act on ("type what the bank took"), never a
        500 and never a silently-zero settlement amount on a NOT NULL column that
        rides the account balance.
        """
        headers, user_id = await _register_and_login(client, "orig-norate@x.com")
        account_id = await _byn_account(client, headers)

        resp = await _post(
            client,
            headers,
            account_id=account_id,
            original_amount_minor=5000,
            original_currency="EUR",
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "FX_RATE_UNAVAILABLE"
        rows = await db_session.scalar(
            text("SELECT count(*) FROM transactions WHERE user_id = :id"),
            {"id": user_id},
        )
        assert rows == 0

    async def test_neither_amount_nor_original_is_amount_required(
        self, client: AsyncClient
    ) -> None:
        # ``amount_minor`` went optional for the original pair's sake; without the
        # pair it is still mandatory, and the refusal is the house string code so a
        # form can tell "no amount" apart from "no rate".
        headers, _ = await _register_and_login(client, "orig-noamount@x.com")
        account_id = await _byn_account(client, headers)

        resp = await _post(client, headers, account_id=account_id)

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "AMOUNT_REQUIRED"

    @pytest.mark.parametrize(
        ("currency", "rate", "original_minor", "expected_minor", "expected_rate"),
        [
            # JPY is exponent 0: 5000 minor IS 5000 yen. Treating it as exponent 2
            # would book 27.50 RUB instead of 2750.00 — the 100x corruption.
            ("JPY", "0.55", 5000, 275000, "0.55"),
            # KWD is exponent 3: 5000 minor is 5.000 dinar, not 50.00.
            ("KWD", "265", 5000, 132500, "265"),
        ],
    )
    async def test_exponents_of_both_legs_are_live(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        currency: str,
        rate: str,
        original_minor: int,
        expected_minor: int,
        expected_rate: str,
    ) -> None:
        headers, _ = await _register_and_login(client, f"orig-{currency}@x.com")
        await _seed_rate(db_session, currency, "RUB", rate)
        account_id = await account_for_currency(client, headers, "RUB")

        resp = await _post(
            client,
            headers,
            account_id=account_id,
            original_amount_minor=original_minor,
            original_currency=currency,
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["amount_minor"] == expected_minor
        assert body["original_rate"] == expected_rate

    async def test_balance_moves_by_the_settlement_amount_only(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # The original leg is display-only: it must not reach the balance sum, and a
        # row without one reports no rate at all.
        headers, _ = await _register_and_login(client, "orig-balance@x.com")
        await _seed_rate(db_session, "EUR", "BYN", "3.30")
        account_id = await _byn_account(client, headers)
        plain = await _post(client, headers, account_id=account_id, amount_minor=1000)
        assert plain.status_code == 201, plain.text
        assert plain.json()["original_rate"] is None
        await _post(
            client,
            headers,
            account_id=account_id,
            original_amount_minor=5000,
            original_currency="EUR",
        )

        listed = await client.get("/accounts", headers=headers)

        assert listed.status_code == 200, listed.text
        account = next(a for a in listed.json() if a["id"] == account_id)
        # 10.00 + 165.00 BYN out — the 50.00 EUR is nowhere in this number.
        assert account["balance_minor"] == -(1000 + 16500)

    async def test_replay_returns_the_stored_original_pair(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # FIRST WRITE WINS extends to the new fields: a replay carrying a DIFFERENT
        # original must still answer with what is in the ledger.
        headers, user_id = await _register_and_login(client, "orig-replay@x.com")
        await _seed_rate(db_session, "EUR", "BYN", "3.30")
        account_id = await _byn_account(client, headers)
        client_id = str(uuid.uuid4())
        first = await _post(
            client,
            headers,
            account_id=account_id,
            client_id=client_id,
            original_amount_minor=5000,
            original_currency="EUR",
        )
        assert first.status_code == 201, first.text

        replay = await _post(
            client,
            headers,
            account_id=account_id,
            client_id=client_id,
            original_amount_minor=9999,
            original_currency="USD",
        )

        assert replay.status_code == 200, replay.text
        assert replay.json() == first.json()
        count = await db_session.scalar(
            text("SELECT count(*) FROM transactions WHERE user_id = :id"),
            {"id": user_id},
        )
        assert count == 1

    @pytest.mark.parametrize(
        "body",
        [
            {"country": "by"},
            {"country": "BYN"},
            {"country": ""},
            {"original_amount_minor": 5000, "original_currency": "eur"},
        ],
    )
    async def test_malformed_country_and_currency_are_422_not_500(
        self, client: AsyncClient, body: dict[str, Any]
    ) -> None:
        # The DB CHECKs spell the same rules, so anything the schema lets through
        # here would surface as an IntegrityError 500 two layers down.
        headers, _ = await _register_and_login(client, "orig-format@x.com")
        account_id = await _byn_account(client, headers)

        resp = await _post(
            client, headers, account_id=account_id, amount_minor=100, **body
        )

        assert resp.status_code == 422, resp.text


class TestUpdateOriginal:
    async def test_setting_the_pair_rederives_amount_and_snapshot(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The PATCH half of plan §7.2.

        The derived ``amount_minor`` never enters ``model_fields_set``, so the
        base-snapshot rule has to key off the ORIGINAL fields; otherwise the row
        leaves with a new settlement amount and the previous amount's snapshot.
        """
        headers, _ = await _register_and_login(client, "orig-patch@x.com")
        await _seed_rate(db_session, "EUR", "BYN", "3.30")
        await _seed_rate(db_session, "BYN", "RUB", "27.00")
        account_id = await _byn_account(client, headers)
        created = await _post(client, headers, account_id=account_id, amount_minor=1000)
        assert created.status_code == 201, created.text
        assert created.json()["base_amount_minor"] == 27000  # 10.00 BYN x 27.00

        patched = await client.patch(
            f"/transactions/{created.json()['id']}",
            json={"original_amount_minor": 5000, "original_currency": "EUR"},
            headers=headers,
        )

        assert patched.status_code == 200, patched.text
        body = patched.json()
        assert body["amount_minor"] == 16500
        # The snapshot of the NEW settlement amount, not the stale 27000.
        assert body["base_amount_minor"] == 445500
        assert body["base_currency"] == "RUB"

    async def test_clearing_the_pair_keeps_the_money_and_omitting_keeps_the_pair(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Contrast with the base-snapshot rule: there an explicit null RECOMPUTES.

        Here it clears, and it must NOT restate ``amount_minor`` — the settlement
        amount is the source of truth, and forgetting what the merchant charged is
        not a reason to move money.
        """
        headers, _ = await _register_and_login(client, "orig-clear@x.com")
        await _seed_rate(db_session, "EUR", "BYN", "3.30")
        account_id = await _byn_account(client, headers)
        created = await _post(
            client,
            headers,
            account_id=account_id,
            original_amount_minor=5000,
            original_currency="EUR",
        )
        assert created.status_code == 201, created.text
        tx_id = created.json()["id"]

        untouched = await client.patch(
            f"/transactions/{tx_id}", json={"note": "лукум"}, headers=headers
        )
        assert untouched.status_code == 200, untouched.text
        assert untouched.json()["original_amount_minor"] == 5000

        cleared = await client.patch(
            f"/transactions/{tx_id}",
            json={"original_amount_minor": None, "original_currency": None},
            headers=headers,
        )

        assert cleared.status_code == 200, cleared.text
        body = cleared.json()
        assert body["original_amount_minor"] is None
        assert body["original_currency"] is None
        assert body["original_rate"] is None
        assert body["amount_minor"] == 16500  # unchanged by the clear

    async def test_clearing_the_pair_leaves_a_manual_base_override_standing(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Contrast with the test above: here a rate AND an override both exist.

        The clear-test above has neither, so the snapshot is None before and after
        and it cannot see the hole (review-b MAJOR-1): with ``original_*`` counted
        as conversion inputs, dropping the display leg re-runs the auto-conversion
        and silently overwrites the user's hand-entered base amount with 459000.
        Clearing a display field must not restate money.
        """
        headers, _ = await _register_and_login(client, "orig-clear-override@x.com")
        await _seed_rate(db_session, "BYN", "RUB", "27.00")
        account_id = await _byn_account(client, headers)
        created = await _post(
            client,
            headers,
            account_id=account_id,
            amount_minor=17000,  # 170.00 BYN — sent, so nothing is derived
            original_amount_minor=5000,
            original_currency="EUR",
            base_amount_minor=123456,  # the user overrode the day's rate by hand
        )
        assert created.status_code == 201, created.text
        assert created.json()["base_amount_minor"] == 123456
        tx_id = created.json()["id"]

        cleared = await client.patch(
            f"/transactions/{tx_id}",
            json={"original_amount_minor": None, "original_currency": None},
            headers=headers,
        )

        assert cleared.status_code == 200, cleared.text
        body = cleared.json()
        assert body["original_amount_minor"] is None
        assert body["original_currency"] is None
        assert body["amount_minor"] == 17000
        # 17000 x 27.00 = 459000 is what auto-conversion would write here.
        assert body["base_amount_minor"] == 123456
        assert body["base_currency"] == "RUB"

    @pytest.mark.parametrize(
        "patch",
        [
            {"original_amount_minor": 5000},
            {"original_currency": "EUR"},
            {"original_amount_minor": 5000, "original_currency": None},
        ],
    )
    async def test_half_a_pair_in_a_patch_is_refused(
        self, client: AsyncClient, patch: dict[str, Any]
    ) -> None:
        # Decided by the FIELD SET, so "one value + one explicit null" is refused
        # exactly like "one field alone" — a row can never hold half an original.
        headers, _ = await _register_and_login(client, "orig-patchhalf@x.com")
        account_id = await _byn_account(client, headers)
        created = await _post(client, headers, account_id=account_id, amount_minor=1000)

        resp = await client.patch(
            f"/transactions/{created.json()['id']}", json=patch, headers=headers
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "ORIGINAL_FIELDS_REQUIRED"

    async def test_original_on_a_transfer_patch_is_refused(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "orig-patchtx@x.com")
        source = await _byn_account(client, headers)
        target = str((await create_account(client, headers, currency="RUB"))["id"])
        created = await _post(
            client,
            headers,
            kind="transfer",
            account_id=source,
            amount_minor=10000,
            counter_account_id=target,
            counter_amount_minor=270000,
        )
        assert created.status_code == 201, created.text

        resp = await client.patch(
            f"/transactions/{created.json()['id']}",
            json={"original_amount_minor": 5000, "original_currency": "EUR"},
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "TRANSFER_ORIGINAL_FORBIDDEN"

    async def test_moving_onto_an_account_in_the_original_currency_is_refused_whole(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # Refuse-whole (the B3 recurring precedent): the row is not half-moved and
        # not silently stripped of its original leg — the user clears it themselves.
        headers, _ = await _register_and_login(client, "orig-move@x.com")
        await _seed_rate(db_session, "EUR", "BYN", "3.30")
        byn = await _byn_account(client, headers)
        eur = str((await create_account(client, headers, currency="EUR"))["id"])
        created = await _post(
            client,
            headers,
            account_id=byn,
            original_amount_minor=5000,
            original_currency="EUR",
        )
        assert created.status_code == 201, created.text
        tx_id = created.json()["id"]

        resp = await client.patch(
            f"/transactions/{tx_id}", json={"account_id": eur}, headers=headers
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "ORIGINAL_CURRENCY_MATCHES_ACCOUNT"
        after = await client.get("/transactions", headers=headers)
        stored = next(t for t in after.json()["items"] if t["id"] == tx_id)
        assert stored["account_id"] == byn
        assert stored["currency"] == "BYN"

    async def test_setting_the_pair_without_a_rate_refuses_the_whole_patch(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "orig-patchnorate@x.com")
        account_id = await _byn_account(client, headers)
        created = await _post(client, headers, account_id=account_id, amount_minor=1000)
        tx_id = created.json()["id"]

        resp = await client.patch(
            f"/transactions/{tx_id}",
            json={
                "original_amount_minor": 5000,
                "original_currency": "EUR",
                "note": "не должно примениться",
            },
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "FX_RATE_UNAVAILABLE"
        after = await client.get("/transactions", headers=headers)
        stored = next(t for t in after.json()["items"] if t["id"] == tx_id)
        assert stored["note"] is None  # nothing half-applied
        assert stored["original_amount_minor"] is None


class TestReceiptLink:
    """S3 — ``receipt_id`` became editable; ownership stays a single code path."""

    async def _receipt(self, session: AsyncSession, user_id: uuid.UUID) -> uuid.UUID:
        receipt = Receipt(
            user_id=user_id,
            storage_path=f"{user_id}/{uuid.uuid4()}.jpg",
            status=ReceiptStatus.pending.value,
        )
        session.add(receipt)
        await session.commit()
        return receipt.id

    async def test_attach_repoint_and_detach(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, user_id = await _register_and_login(client, "rcpt-edit@x.com")
        first = await self._receipt(db_session, user_id)
        second = await self._receipt(db_session, user_id)
        account_id = await _byn_account(client, headers)
        created = await _post(client, headers, account_id=account_id, amount_minor=1000)
        tx_id = created.json()["id"]
        assert created.json()["receipt_id"] is None

        for wanted in (first, second, None):
            resp = await client.patch(
                f"/transactions/{tx_id}",
                json={"receipt_id": None if wanted is None else str(wanted)},
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["receipt_id"] == (
                None if wanted is None else str(wanted)
            )
        # Detaching never touches storage: both receipt rows are still there, and so
        # are their objects (reaping orphans is a separate, confirmed job).
        remaining = await db_session.scalar(
            text("SELECT count(*) FROM receipts WHERE user_id = :id"), {"id": user_id}
        )
        assert remaining == 2

    async def test_foreign_and_missing_receipt_share_one_refusal(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "rcpt-mine@x.com")
        stranger, stranger_id = await _register_and_login(client, "rcpt-yours@x.com")
        assert stranger  # the token is unused; only the receipt's owner matters
        foreign = await self._receipt(db_session, stranger_id)
        account_id = await _byn_account(client, headers)
        created = await _post(client, headers, account_id=account_id, amount_minor=1000)
        url = f"/transactions/{created.json()['id']}"

        answers = [
            await client.patch(
                url, json={"receipt_id": str(candidate)}, headers=headers
            )
            for candidate in (foreign, uuid.uuid4())
        ]

        assert {(r.status_code, r.text) for r in answers} == {
            (422, '{"detail":"RECEIPT_NOT_FOUND"}')
        }

    async def test_linking_a_pending_receipt_needs_no_ai_configuration(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # The AI gate lives in POST /receipts/{id}/parse only. A create that merely
        # REFERENCES an unparsed receipt must not inherit a 503 from it.
        headers, user_id = await _register_and_login(client, "rcpt-noai@x.com")
        receipt = await self._receipt(db_session, user_id)
        account_id = await _byn_account(client, headers)

        resp = await _post(
            client,
            headers,
            account_id=account_id,
            amount_minor=1000,
            receipt_id=str(receipt),
        )

        assert resp.status_code == 201, resp.text
        assert resp.json()["receipt_id"] == str(receipt)
