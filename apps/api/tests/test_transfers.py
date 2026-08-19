"""Transfers — the third transaction kind (architecture §3/§5, addendum A1/A2).

Covers only what is unique to a transfer: the ONE row carrying both legs (and the
CHECKs that make half a transfer unrepresentable at the DB level), the two
server-side stamps (each leg's currency from its own account), the NULL base
snapshot, the derived ``transfer_rate``, the guard ORDER that keeps a foreign
account from becoming an existence oracle, and the two edit refusals
(``KIND_CHANGE_UNSUPPORTED``, counter fields on a non-transfer).

The rate ARITHMETIC is not re-pinned here — ``tests/test_fx_domain.py`` owns the
exponent and rounding table; the assertions below only prove that the router feeds
it the right two legs and prints the result as a string.

B2 adds the read side of the same fact: a transfer is invisible to every money
aggregate (one test per surface a user reads), visible from BOTH accounts in the
``account_id`` filter, and present in the CSV export with both account names.
"""

import csv
import io
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from helpers import account_for_currency, add_account, create_account
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.periods import month_key, shift_month
from budget_api.models import ExchangeRate, Transaction

PASSWORD = "password123"


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


async def _two_accounts(
    client: AsyncClient, headers: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """A USD source and a BYN target — the scope's worked example."""
    source = await create_account(
        client, headers, name="USD card", currency="USD", starting_balance_minor=100_000
    )
    target = await create_account(client, headers, name="BYN card", currency="BYN")
    return source, target


def _transfer_body(
    source: dict[str, Any], target: dict[str, Any], **overrides: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "amount_minor": 10_000,
        "kind": "transfer",
        "account_id": source["id"],
        "counter_account_id": target["id"],
        "counter_amount_minor": 33_000,
        "occurred_at": "2026-03-15",
    }
    body.update(overrides)
    return body


async def _balances(client: AsyncClient, headers: dict[str, str]) -> dict[str, int]:
    resp = await client.get(
        "/accounts", params={"include_archived": True}, headers=headers
    )
    assert resp.status_code == 200, resp.text
    return {row["name"]: row["balance_minor"] for row in resp.json()}


class TestCreateTransfer:
    async def test_transfer_stamps_both_legs_and_carries_no_snapshot(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _ = await _register_and_login(client, "tr-create@x.com")
        source, target = await _two_accounts(client, headers)

        resp = await client.post(
            "/transactions", json=_transfer_body(source, target), headers=headers
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        # Each leg is denominated by ITS OWN account, both stamped server-side.
        assert body["currency"] == "USD"
        assert body["counter_currency"] == "BYN"
        assert body["counter_amount_minor"] == 33_000
        # 330.00 BYN per 100.00 USD — derived from the two legs, never stored.
        assert body["transfer_rate"] == "3.3"
        # §5/§6: a transfer is not spending, so it carries neither a category nor a
        # base-currency snapshot that an aggregate could pick up.
        assert body["category_id"] is None
        assert body["base_amount_minor"] is None
        assert body["base_currency"] is None
        stored = (
            await db_session.execute(
                text(
                    "SELECT base_amount_minor, base_currency, counter_currency "
                    "FROM transactions WHERE id = :id"
                ),
                {"id": uuid.UUID(body["id"])},
            )
        ).one()
        assert stored == (None, None, "BYN")

    @pytest.mark.parametrize(
        ("overrides", "expected_detail"),
        [
            ({"counter_amount_minor": None}, "TRANSFER_FIELDS_REQUIRED"),
            ({"counter_account_id": None}, "TRANSFER_FIELDS_REQUIRED"),
            ({"category_id": "__own_category__"}, "TRANSFER_CATEGORY_FORBIDDEN"),
            ({"currency": "EUR"}, "ACCOUNT_CURRENCY_MISMATCH"),
            ({"base_amount_minor": 500}, "TRANSFER_BASE_AMOUNT_FORBIDDEN"),
            ({"counter_account_id": "__source__"}, "SAME_ACCOUNT_TRANSFER"),
        ],
        ids=[
            "no-counter-amount",
            "no-counter-account",
            "with-category",
            "currency-not-the-accounts",
            "with-base-snapshot",
            "into-itself",
        ],
    )
    async def test_malformed_transfers_are_422_not_500(
        self,
        client: AsyncClient,
        overrides: dict[str, Any],
        expected_detail: str,
    ) -> None:
        """Every shape the DB CHECKs forbid is refused ABOVE them, with a code.

        Reaching Postgres with any of these would surface as a 500 IntegrityError,
        which is the failure mode the router-level guards exist to prevent.
        """
        headers, _ = await _register_and_login(
            client, f"tr-invalid-{expected_detail.lower()}-{len(overrides)}@x.com"
        )
        source, target = await _two_accounts(client, headers)
        if overrides.get("category_id") == "__own_category__":
            category = await client.post(
                "/categories", json={"name": "Food", "kind": "expense"}, headers=headers
            )
            overrides = {"category_id": category.json()["id"]}
        if overrides.get("counter_account_id") == "__source__":
            overrides = {"counter_account_id": source["id"]}

        resp = await client.post(
            "/transactions",
            json=_transfer_body(source, target, **overrides),
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": expected_detail}

    async def test_counter_fields_on_a_non_transfer_are_rejected(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "tr-counter-expense@x.com")
        source, target = await _two_accounts(client, headers)

        resp = await client.post(
            "/transactions",
            json=_transfer_body(source, target, kind="expense"),
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "COUNTER_FIELDS_WITHOUT_TRANSFER"}

    async def test_replaying_a_transfer_moves_the_money_once(
        self, client: AsyncClient
    ) -> None:
        """B-1 idempotency over the new shape: the replay arm needs no account read.

        The second POST carries DIFFERENT amounts on purpose (first write wins), so
        a replay that re-validated or re-stamped would be visible in the balances.
        """
        headers, _ = await _register_and_login(client, "tr-replay@x.com")
        source, target = await _two_accounts(client, headers)
        key = str(uuid.uuid4())

        first = await client.post(
            "/transactions",
            json=_transfer_body(source, target, client_id=key),
            headers=headers,
        )
        replay = await client.post(
            "/transactions",
            json=_transfer_body(
                source, target, client_id=key, amount_minor=99, counter_amount_minor=1
            ),
            headers=headers,
        )

        assert first.status_code == 201, first.text
        assert replay.status_code == 200, replay.text
        assert replay.json() == first.json()
        assert await _balances(client, headers) == {
            "USD card": 90_000,
            "BYN card": 33_000,
        }


class TestTransferGuardOrder:
    @pytest.mark.parametrize("field", ["account_id", "counter_account_id"])
    async def test_foreign_and_missing_accounts_answer_identically(
        self, client: AsyncClient, field: str
    ) -> None:
        """No-oracle on BOTH legs — and a FOREIGN ARCHIVED account still says 404.

        The archived flag is the trap: if ``ACCOUNT_ARCHIVED`` were checked before
        ownership, a stranger's id would be distinguishable from a random one (plan
        risk 1).
        """
        headers_a, _ = await _register_and_login(client, f"tr-owner-{field}@x.com")
        theirs = await create_account(client, headers_a, name="Theirs", currency="USD")
        assert (
            await client.patch(
                f"/accounts/{theirs['id']}", json={"archived": True}, headers=headers_a
            )
        ).status_code == 200

        headers_b, _ = await _register_and_login(client, f"tr-spy-{field}@x.com")
        source, target = await _two_accounts(client, headers_b)

        foreign = await client.post(
            "/transactions",
            json=_transfer_body(source, target, **{field: theirs["id"]}),
            headers=headers_b,
        )
        missing = await client.post(
            "/transactions",
            json=_transfer_body(source, target, **{field: str(uuid.uuid4())}),
            headers=headers_b,
        )

        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json() == {"detail": "ACCOUNT_NOT_FOUND"}

    async def test_own_archived_target_is_rejected_as_archived(
        self, client: AsyncClient
    ) -> None:
        """The contrast: my own archived account DOES say ARCHIVED, on either leg."""
        headers, _ = await _register_and_login(client, "tr-archived-target@x.com")
        source, target = await _two_accounts(client, headers)
        assert (
            await client.patch(
                f"/accounts/{target['id']}", json={"archived": True}, headers=headers
            )
        ).status_code == 200

        resp = await client.post(
            "/transactions", json=_transfer_body(source, target), headers=headers
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "ACCOUNT_ARCHIVED"}


class TestPatchTransfer:
    async def test_editing_either_leg_recomputes_the_rate_and_both_balances(
        self, client: AsyncClient
    ) -> None:
        headers, _ = await _register_and_login(client, "tr-patch@x.com")
        source, target = await _two_accounts(client, headers)
        created = await client.post(
            "/transactions", json=_transfer_body(source, target), headers=headers
        )
        assert created.status_code == 201, created.text

        collapsed = await client.patch(
            f"/transactions/{created.json()['id']}",
            json={"account_id": target["id"]},
            headers=headers,
        )
        patched = await client.patch(
            f"/transactions/{created.json()['id']}",
            json={"amount_minor": 20_000, "counter_amount_minor": 60_000},
            headers=headers,
        )

        # Moving the SOURCE onto the target is the same illegal row as moving the
        # target onto the source, and the check is on the pair this PATCH would
        # leave behind — reaching the DB CHECK instead would be a 500.
        assert collapsed.status_code == 422, collapsed.text
        assert collapsed.json() == {"detail": "SAME_ACCOUNT_TRANSFER"}
        assert patched.status_code == 200, patched.text
        # The two amounts are the facts; the rate is recomputed from them, and the
        # snapshot block stayed skipped (a written snapshot would be a 500 here).
        assert patched.json()["transfer_rate"] == "3"
        assert patched.json()["base_amount_minor"] is None
        assert await _balances(client, headers) == {
            "USD card": 80_000,
            "BYN card": 60_000,
        }

    @pytest.mark.parametrize(
        ("start_kind", "patch_kind"),
        [("transfer", "expense"), ("expense", "transfer")],
        ids=["transfer-to-expense", "expense-to-transfer"],
    )
    async def test_changing_the_kind_across_transfer_is_refused(
        self, client: AsyncClient, start_kind: str, patch_kind: str
    ) -> None:
        headers, _ = await _register_and_login(client, f"tr-kind-{start_kind}@x.com")
        source, target = await _two_accounts(client, headers)
        body = (
            _transfer_body(source, target)
            if start_kind == "transfer"
            else {
                "amount_minor": 10_000,
                "kind": "expense",
                "account_id": source["id"],
                "occurred_at": "2026-03-15",
            }
        )
        created = await client.post("/transactions", json=body, headers=headers)
        assert created.status_code == 201, created.text

        resp = await client.patch(
            f"/transactions/{created.json()['id']}",
            json={"kind": patch_kind},
            headers=headers,
        )

        # Delete + create instead: the two shapes have disjoint required fields, and
        # a half-morphed row is exactly what the CHECKs forbid.
        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "KIND_CHANGE_UNSUPPORTED"}

    @pytest.mark.parametrize("field", ["counter_amount_minor", "counter_account_id"])
    async def test_explicit_null_counter_fields_on_a_non_transfer_are_422(
        self, client: AsyncClient, field: str
    ) -> None:
        """``{"counter_amount_minor": null}`` is a 422, not a 500 (review MAJOR-1).

        The non-transfer arm decides by the FIELD SET: a value-based check let an
        explicit null through to the write site, where the non-null assert blew up
        as an AssertionError on a schema-valid payload. Both counter fields answer
        the same code — the null spelling is not a quiet no-op either.
        """
        headers, _ = await _register_and_login(client, f"tr-null-{field}@x.com")
        source, _ = await _two_accounts(client, headers)
        created = await client.post(
            "/transactions",
            json={
                "amount_minor": 10_000,
                "kind": "expense",
                "account_id": source["id"],
                "occurred_at": "2026-03-15",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text

        resp = await client.patch(
            f"/transactions/{created.json()['id']}",
            json={field: None},
            headers=headers,
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "COUNTER_FIELDS_WITHOUT_TRANSFER"}

    async def test_moving_a_row_to_a_foreign_currency_account_restamps_it(
        self, client: AsyncClient
    ) -> None:
        """PATCH account_id on a NON-transfer: restamp + snapshot, and a sent
        currency that disagrees with the destination is refused."""
        headers, _ = await _register_and_login(client, "tr-move@x.com")
        source, target = await _two_accounts(client, headers)
        created = await client.post(
            "/transactions",
            json={
                "amount_minor": 10_000,
                "kind": "expense",
                "account_id": source["id"],
                "occurred_at": "2026-03-15",
            },
            headers=headers,
        )
        assert created.status_code == 201, created.text

        mismatched = await client.patch(
            f"/transactions/{created.json()['id']}",
            json={"account_id": target["id"], "currency": "USD"},
            headers=headers,
        )
        moved = await client.patch(
            f"/transactions/{created.json()['id']}",
            json={"account_id": target["id"]},
            headers=headers,
        )

        assert mismatched.status_code == 422, mismatched.text
        assert mismatched.json() == {"detail": "ACCOUNT_CURRENCY_MISMATCH"}
        assert moved.status_code == 200, moved.text
        assert moved.json()["currency"] == "BYN"  # restamped from the new account
        assert await _balances(client, headers) == {
            "USD card": 100_000,
            "BYN card": -10_000,
        }


class TestDatabaseInvariants:
    """The §3 CHECKs, reached by bypassing the router entirely.

    The router refuses each of these with a 422 (TestCreateTransfer above); these
    assertions are about the OTHER paths — a future materializer, a migration, a
    psql session — for which "half a transfer" must be impossible to write at all.
    """

    @pytest.mark.parametrize(
        ("overrides", "constraint"),
        [
            (
                {"counter_amount_minor": None, "counter_currency": None},
                "ck_transactions_counter_pair",
            ),
            ({"kind": "expense"}, "ck_transactions_transfer_has_counter_account"),
            ({"counter_amount_minor": 0}, "ck_transactions_counter_amount_minor"),
            (
                {"counter_account_id": "__self__"},
                "ck_transactions_counter_account_differs",
            ),
            (
                {"base_amount_minor": 100, "base_currency": "RUB"},
                "ck_transactions_transfer_no_base_snapshot",
            ),
        ],
        ids=[
            "counter-trio-half-set",
            "counter-leg-without-transfer-kind",
            "non-positive-counter-amount",
            "into-itself",
            "transfer-with-base-snapshot",
        ],
    )
    async def test_half_transfers_are_unrepresentable(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        overrides: dict[str, Any],
        constraint: str,
    ) -> None:
        _, user_id = await _register_and_login(
            client, f"tr-check-{constraint[-12:]}@x.com"
        )
        source = await add_account(db_session, user_id, "USD")
        target = await add_account(db_session, user_id, "BYN")
        await db_session.commit()
        if overrides.get("counter_account_id") == "__self__":
            overrides = {"counter_account_id": source.id}

        row: dict[str, Any] = {
            "user_id": user_id,
            "account_id": source.id,
            "amount_minor": 10_000,
            "kind": "transfer",
            "currency": "USD",
            "occurred_at": date(2026, 3, 15),
            "counter_account_id": target.id,
            "counter_amount_minor": 33_000,
            "counter_currency": "BYN",
            **overrides,
        }
        db_session.add(Transaction(**row))

        with pytest.raises(IntegrityError, match=constraint):
            await db_session.commit()

    async def test_a_well_formed_transfer_row_is_accepted(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        # The accept contrast: without it every rejection above would also pass
        # against a CHECK of `false`.
        _, user_id = await _register_and_login(client, "tr-check-ok@x.com")
        source = await add_account(db_session, user_id, "USD")
        target = await add_account(db_session, user_id, "BYN")

        db_session.add(
            Transaction(
                user_id=user_id,
                account_id=source.id,
                amount_minor=10_000,
                kind="transfer",
                currency="USD",
                occurred_at=date(2026, 3, 15),
                counter_account_id=target.id,
                counter_amount_minor=33_000,
                counter_currency="BYN",
            )
        )
        await db_session.commit()

        assert (
            await db_session.scalar(
                text("SELECT count(*) FROM transactions WHERE user_id = :uid"),
                {"uid": user_id},
            )
            == 1
        )


# --- B2: a transfer is not money moving IN or OUT of the user's world --------

#: The only real spending in the fixture window (2500.00 RUB).
_REAL_EXPENSE_MINOR = 250_000
#: The only real income in the fixture window (9000.00 RUB).
_REAL_INCOME_MINOR = 900_000


async def _seed_rate(
    session: AsyncSession, base: str, quote: str, rate: str, as_of: date
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


async def _post_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def _window_with_two_transfers(
    client: AsyncClient, db_session: AsyncSession, email: str
) -> tuple[dict[str, str], date, str]:
    """A PREVIOUS-month window holding real money plus two transfers.

    Returns ``(headers, first-of-that-month, category_id)``. The previous FULL
    month is the one window every surface under test can see: /stats/monthly's
    trailing series, the goals free-balance window (3 full months, the current
    partial one excluded) and the month-anchored summaries and limits.

    Both transfers leave a FOREIGN account on purpose. A transfer carries a NULL
    base snapshot by DB CHECK (§5), so its source leg can only ever land in
    tx_totals' bucket 3 — and that bucket fails two different ways (plan risk 5):
    USD has a seeded rate, so a leaked USD leg would be CONVERTED at read time
    and booked as 8000.00 RUB of expense; KRW has none, so a leaked KRW leg would
    instead be COUNTED in ``unconverted_count``. One fixture, both failure modes.
    """
    headers, _ = await _register_and_login(client, email)
    month_first = shift_month(datetime.now(UTC).date().replace(day=1), -1)
    day = month_first.replace(day=15).isoformat()
    await _seed_rate(db_session, "RUB", "USD", "0.0125", month_first)  # USD→RUB = 80

    cat = await client.post(
        "/categories", json={"name": "Groceries", "kind": "expense"}, headers=headers
    )
    assert cat.status_code == 201, cat.text
    category: str = cat.json()["id"]

    rub = await account_for_currency(client, headers, "RUB")
    await _post_tx(
        client,
        headers,
        amount_minor=_REAL_EXPENSE_MINOR,
        kind="expense",
        account_id=rub,
        category_id=category,
        occurred_at=day,
    )
    await _post_tx(
        client,
        headers,
        amount_minor=_REAL_INCOME_MINOR,
        kind="income",
        account_id=rub,
        occurred_at=day,
    )

    jpy = await account_for_currency(client, headers, "JPY")
    await _post_tx(
        client,
        headers,
        amount_minor=10_000,  # 100.00 USD → 8000.00 RUB if it ever leaked
        kind="transfer",
        account_id=await account_for_currency(client, headers, "USD"),
        counter_account_id=jpy,
        counter_amount_minor=15_000,
        occurred_at=day,
    )
    await _post_tx(
        client,
        headers,
        amount_minor=1_000_000,  # KRW has no rate: a leak shows up as a FLAG
        kind="transfer",
        account_id=await account_for_currency(client, headers, "KRW"),
        counter_account_id=jpy,
        counter_amount_minor=8_000,
        occurred_at=day,
    )
    return headers, month_first, category


class TestTransfersAreInvisibleToAggregates:
    """Architecture §6 — one test per surface a user actually reads.

    The exclusion itself is ONE predicate in ``services/tx_totals``, but these are
    four different endpoints with four different shapes, and the day one of them
    grows a query of its own is exactly the day a single shared test would keep
    passing while the screen started counting transfers as spending.
    """

    async def test_transactions_summary_ignores_transfers(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, month_first, category = await _window_with_two_transfers(
            client, db_session, "tr-agg-summary@x.com"
        )

        resp = await client.get(
            "/transactions/summary",
            params={"month": month_key(month_first)},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["income_minor"] == _REAL_INCOME_MINOR
        assert body["expense_minor"] == _REAL_EXPENSE_MINOR
        assert body["net_minor"] == _REAL_INCOME_MINOR - _REAL_EXPENSE_MINOR
        assert body["unconverted_count"] == 0  # the rateless KRW leg is not a gap
        buckets = {
            (b["category_id"], b["kind"]): b["total_minor"] for b in body["by_category"]
        }
        # Exact dict: a transfer has no category, so a leak would materialize an
        # (uncategorized, expense) bucket the user never spent.
        assert buckets == {
            (category, "expense"): _REAL_EXPENSE_MINOR,
            (None, "income"): _REAL_INCOME_MINOR,
        }

    async def test_stats_summary_ignores_transfers(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, month_first, _ = await _window_with_two_transfers(
            client, db_session, "tr-agg-stats@x.com"
        )

        resp = await client.get(
            "/stats/summary",
            params={"period": "month", "month": month_key(month_first)},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["income_minor"] == _REAL_INCOME_MINOR
        assert body["expense_minor"] == _REAL_EXPENSE_MINOR
        assert body["unconverted_count"] == 0

    async def test_stats_monthly_ignores_transfers(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, month_first, _ = await _window_with_two_transfers(
            client, db_session, "tr-agg-monthly@x.com"
        )

        resp = await client.get("/stats/monthly", params={"months": 3}, headers=headers)

        assert resp.status_code == 200, resp.text
        points = {p["month"]: p for p in resp.json()["points"]}
        # The fold-in books a bucket-3 row as `income if kind == income else
        # expense`, so a leaked transfer lands here as spending (plan risk 5).
        assert points[month_key(month_first)] == {
            "month": month_key(month_first),
            "income_minor": _REAL_INCOME_MINOR,
            "expense_minor": _REAL_EXPENSE_MINOR,
            "net_minor": _REAL_INCOME_MINOR - _REAL_EXPENSE_MINOR,
            "unconverted_count": 0,
        }

    async def test_limits_ignore_transfers(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, month_first, category = await _window_with_two_transfers(
            client, db_session, "tr-agg-limits@x.com"
        )
        limit = await client.put(
            f"/limits/{category}", json={"amount_minor": 500_000}, headers=headers
        )
        assert limit.status_code == 200, limit.text

        resp = await client.get(
            "/limits", params={"month": month_key(month_first)}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["items"][0]["spent_minor"] == _REAL_EXPENSE_MINOR
        # The screen's honesty flag: a leaked rateless transfer would tell the user
        # their limit is computed over rows the server could not convert.
        assert body["unconverted_count"] == 0

    async def test_goals_free_balance_ignores_transfers(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        headers, _, _ = await _window_with_two_transfers(
            client, db_session, "tr-agg-goals@x.com"
        )

        resp = await client.get("/goals", headers=headers)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        # (income - expense) // 3 full months — the transfers move neither side.
        assert (
            body["free_balance_minor"]
            == (_REAL_INCOME_MINOR - _REAL_EXPENSE_MINOR) // 3
        )
        assert body["realism_unavailable"] is False


class TestAccountFilter:
    async def test_account_filter_matches_either_leg(self, client: AsyncClient) -> None:
        """The history of an account includes what ARRIVED on it (A3)."""
        headers, _ = await _register_and_login(client, "tr-filter@x.com")
        source, target = await _two_accounts(client, headers)
        transfer = await _post_tx(client, headers, **_transfer_body(source, target))
        elsewhere = await create_account(
            client, headers, name="RUB card", currency="RUB"
        )
        unrelated = await _post_tx(
            client,
            headers,
            amount_minor=5_000,
            kind="expense",
            account_id=elsewhere["id"],
            occurred_at="2026-03-15",
        )

        async def _ids(account: str) -> list[str]:
            resp = await client.get(
                "/transactions", params={"account_id": account}, headers=headers
            )
            assert resp.status_code == 200, resp.text
            return [item["id"] for item in resp.json()["items"]]

        # Same single row from both sides — it is ONE operation, not two halves.
        assert await _ids(source["id"]) == [transfer["id"]]
        assert await _ids(target["id"]) == [transfer["id"]]
        # And a third account sees only its own row: the OR must not widen the
        # filter into "every transfer".
        assert await _ids(elsewhere["id"]) == [unrelated["id"]]


class TestTransferExport:
    async def test_export_carries_both_accounts_and_the_arriving_amount(
        self, client: AsyncClient
    ) -> None:
        """OQ-3: transfers ARE exported — the file is the full history."""
        headers, _ = await _register_and_login(client, "tr-export@x.com")
        source = await create_account(client, headers, name="USD card", currency="USD")
        # JPY is exponent 0: the arriving leg must be rendered at the TARGET's
        # exponent, so 15000 minor is "15000" here and would be "150.00" if the
        # source's exponent were used by mistake.
        target = await create_account(
            client, headers, name="JPY кошелёк", currency="JPY"
        )
        transfer = await _post_tx(
            client,
            headers,
            amount_minor=10_000,
            kind="transfer",
            account_id=source["id"],
            counter_account_id=target["id"],
            counter_amount_minor=15_000,
            occurred_at="2026-03-15",
        )

        resp = await client.get("/transactions/export", headers=headers)

        assert resp.status_code == 200, resp.text
        rows = list(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))))
        assert [row["id"] for row in rows] == [transfer["id"]]
        assert rows[0] == {
            "id": transfer["id"],
            "occurred_at": "2026-03-15",
            "kind": "transfer",
            "amount": "100.00",
            "currency": "USD",
            # §5: no snapshot exists, so the base cells stay empty rather than
            # restating the row at today's rate.
            "base_amount": "",
            "base_currency": "",
            "category": "",
            "merchant": "",
            "note": "",
            "account": "USD card",
            "counter_account": "JPY кошелёк",
            "counter_amount": "15000",
        }
