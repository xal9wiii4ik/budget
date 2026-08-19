"""Stats endpoints (4.1) — real Postgres, real migrations, no mocks.

Covers only what is NEW here: the period grammar (resolution, echo, previous
window, anchor rejection), the dense monthly series with per-point flags, the
top-merchants shape, and user scoping on three brand-new queries. The
three-bucket conversion itself is already pinned by
``test_transactions.py::TestSummaryConverted`` — these tests use base-currency
rows for "included" and rateless foreign rows for "excluded", which is all the
new shells need to plumb honestly.
"""

from datetime import UTC, date, datetime
from typing import Any

import pytest
from helpers import account_for_currency
from httpx import AsyncClient

from budget_api.domain.periods import month_key, shift_month

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


async def _create_category(
    client: AsyncClient, headers: dict[str, str], name: str
) -> str:
    resp = await client.post(
        "/categories", json={"name": name, "kind": "expense"}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", "2026-02-15")
    if "account_id" not in body:
        # Every row needs an account, and the row's currency is stamped FROM it
        # (architecture §4) — so the account must match whatever currency the test
        # asked for.
        body["account_id"] = await account_for_currency(
            client, headers, body.get("currency")
        )
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _today() -> date:
    return datetime.now(UTC).date()


class TestStatsSummary:
    async def test_summary_month_window_and_previous(self, client: AsyncClient) -> None:
        headers = await _register_and_login(client, "statsmonth@x.com")
        # January = the comparison window; February = the queried window (expense
        # ONLY, so its net is exactly negative); March must not leak into either.
        await _create_tx(
            client,
            headers,
            amount_minor=500000,
            kind="income",
            occurred_at="2026-01-10",
        )
        await _create_tx(client, headers, amount_minor=200000, occurred_at="2026-01-20")
        await _create_tx(client, headers, amount_minor=100000, occurred_at="2026-02-14")
        await _create_tx(client, headers, amount_minor=999999, occurred_at="2026-03-01")

        resp = await client.get(
            "/stats/summary",
            params={"period": "month", "month": "2026-02"},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["currency"] == "RUB"
        assert body["period"] == {"from": "2026-02-01", "to": "2026-02-28"}  # inclusive
        assert body["income_minor"] == 0
        assert body["expense_minor"] == 100000
        assert body["net_minor"] == -100000  # signed, negative — never abs()
        assert body["previous"] == {
            "from": "2026-01-01",
            "to": "2026-01-31",
            "income_minor": 500000,
            "expense_minor": 200000,
            "net_minor": 300000,
            "unconverted_count": 0,
        }

    @pytest.mark.parametrize(
        ("params", "expected_period", "expected_expense", "expected_previous"),
        [
            (
                {"period": "quarter", "quarter": "2026-Q1"},
                ("2026-01-01", "2026-03-31"),
                6000,
                ("2025-10-01", "2025-12-31", 1000),
            ),
            (
                {"period": "year", "year": 2026},
                ("2026-01-01", "2026-12-31"),
                30000,
                ("2025-01-01", "2025-12-31", 1000),
            ),
        ],
        ids=["quarter", "year"],
    )
    async def test_summary_quarter_and_year_windows(
        self,
        client: AsyncClient,
        params: dict[str, Any],
        expected_period: tuple[str, str],
        expected_expense: int,
        expected_previous: tuple[str, str, int],
    ) -> None:
        headers = await _register_and_login(client, "statsqy@x.com")
        # One row just inside and one just outside each boundary the two units
        # disagree on — the same fixture must produce different numbers per arm.
        for amount, day in (
            (1000, "2025-12-31"),  # previous quarter AND previous year
            (2000, "2026-01-01"),  # first day of both windows
            (4000, "2026-03-31"),  # last day of Q1
            (8000, "2026-04-01"),  # just outside Q1, inside the year
            (16000, "2026-12-31"),  # last day of the year
            (32000, "2027-01-01"),  # outside both
        ):
            await _create_tx(client, headers, amount_minor=amount, occurred_at=day)

        resp = await client.get("/stats/summary", params=params, headers=headers)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["period"] == {
            "from": expected_period[0],
            "to": expected_period[1],
        }
        assert body["expense_minor"] == expected_expense
        prev_from, prev_to, prev_expense = expected_previous
        assert body["previous"]["from"] == prev_from
        assert body["previous"]["to"] == prev_to
        assert body["previous"]["expense_minor"] == prev_expense

    async def test_summary_custom_window_inclusive_to_and_previous(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "statscustom@x.com")
        await _create_tx(client, headers, amount_minor=1000, occurred_at="2026-03-10")
        # Dated exactly `to` — the inclusive-end pin (a half-open wire would drop it).
        await _create_tx(client, headers, amount_minor=5000, occurred_at="2026-03-20")
        await _create_tx(client, headers, amount_minor=7000, occurred_at="2026-03-21")
        # The day before `from` is the last day of the comparison window...
        await _create_tx(client, headers, amount_minor=300, occurred_at="2026-03-09")
        # ...and this one is one day before that window starts (11-day span).
        await _create_tx(client, headers, amount_minor=900, occurred_at="2026-02-26")

        resp = await client.get(
            "/stats/summary",
            params={"period": "custom", "from": "2026-03-10", "to": "2026-03-20"},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["period"] == {"from": "2026-03-10", "to": "2026-03-20"}
        assert body["expense_minor"] == 6000  # 1000 + 5000; the 21st excluded
        assert body["previous"]["from"] == "2026-02-27"  # same 11-day length
        assert body["previous"]["to"] == "2026-03-09"
        assert body["previous"]["expense_minor"] == 300  # the Feb 26 row is outside

    async def test_summary_from_after_to_is_empty_zeros(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "statsinverted@x.com")
        await _create_tx(client, headers, amount_minor=1000, occurred_at="2026-03-15")

        resp = await client.get(
            "/stats/summary",
            params={"period": "custom", "from": "2026-03-20", "to": "2026-03-10"},
            headers=headers,
        )

        # Read filters never error (decision l): zeros, not a 4xx.
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["income_minor"] == 0
        assert body["expense_minor"] == 0
        assert body["net_minor"] == 0
        assert body["by_category"] == []
        assert body["previous"]["expense_minor"] == 0

    async def test_summary_ordering_and_unconverted_surface(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "statsorder@x.com")
        cat_a = await _create_category(client, headers, "A")
        cat_b = await _create_category(client, headers, "B")
        # Current window (February).
        await _create_tx(
            client,
            headers,
            amount_minor=100000,
            category_id=cat_a,
            occurred_at="2026-02-03",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=300000,
            category_id=cat_b,
            occurred_at="2026-02-04",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=50000,
            category_id=None,
            occurred_at="2026-02-05",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=200000,
            kind="income",
            category_id=cat_a,
            occurred_at="2026-02-06",
        )
        # ONE rateless row in the current window...
        await _create_tx(
            client, headers, amount_minor=5000, currency="JPY", occurred_at="2026-02-07"
        )
        # ...and TWO in the previous one, so a hardcoded 0 — or the current
        # window's count copied into the `previous` block — cannot pass.
        await _create_tx(
            client, headers, amount_minor=1000, currency="JPY", occurred_at="2026-01-07"
        )
        await _create_tx(
            client, headers, amount_minor=2000, currency="KRW", occurred_at="2026-01-08"
        )
        await _create_tx(
            client,
            headers,
            amount_minor=400000,
            kind="income",
            occurred_at="2026-01-09",
        )

        resp = await client.get(
            "/stats/summary",
            params={"period": "month", "month": "2026-02"},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Ordered (kind, total DESC) with the uncategorized bucket present.
        assert body["by_category"] == [
            {"category_id": cat_b, "kind": "expense", "total_minor": 300000},
            {"category_id": cat_a, "kind": "expense", "total_minor": 100000},
            {"category_id": None, "kind": "expense", "total_minor": 50000},
            {"category_id": cat_a, "kind": "income", "total_minor": 200000},
        ]
        assert body["expense_minor"] == 450000  # the JPY row is excluded, not summed
        assert body["unconverted_count"] == 1
        assert body["previous"]["income_minor"] == 400000
        assert body["previous"]["expense_minor"] == 0  # both JPY/KRW rows excluded
        assert body["previous"]["unconverted_count"] == 2


class TestPeriodGrammar:
    @pytest.mark.parametrize(
        "params",
        [
            {"period": "month"},
            {"period": "custom", "from": "2026-02-01"},
            {"period": "quarter", "month": "2026-02"},
        ],
        ids=["no-anchor", "custom-half-anchored", "chosen-unit-anchor-absent"],
    )
    async def test_summary_period_anchor_required_422(
        self, client: AsyncClient, params: dict[str, Any]
    ) -> None:
        headers = await _register_and_login(client, "statsanchor@x.com")

        bad = await client.get("/stats/summary", params=params, headers=headers)

        assert bad.status_code == 422, bad.text
        assert bad.json() == {"detail": "PERIOD_ANCHOR_REQUIRED"}
        # Contrast arm: the correctly-anchored request is a plain 200, so the
        # rejection above is about the anchor and not about the endpoint.
        ok = await client.get(
            "/stats/summary",
            params={"period": "month", "month": "2026-02"},
            headers=headers,
        )
        assert ok.status_code == 200, ok.text

    @pytest.mark.parametrize(
        "params",
        [
            {"period": "month", "month": "9999-12"},
            {"period": "quarter", "quarter": "9999-Q4"},
            {"period": "custom", "from": "2026-01-01", "to": "9999-12-31"},
            {"period": "custom", "from": "0001-01-01", "to": "2026-01-05"},
        ],
        ids=["month-max", "quarter-max", "custom-to-max", "custom-from-min"],
    )
    async def test_summary_anchor_outside_year_envelope_is_422_not_500(
        self, client: AsyncClient, params: dict[str, Any]
    ) -> None:
        # Each of these is syntactically valid yet lands on date arithmetic that
        # overflows `date` (10000-01-01 for the anchors, `to + 1 day` / the previous
        # window's echoed `to` for custom) — all four answered 500 before the year
        # envelope. The in-envelope 2026 requests in this class are the contrast arm.
        headers = await _register_and_login(client, "statsenvelope@x.com")

        resp = await client.get("/stats/summary", params=params, headers=headers)

        assert resp.status_code == 422, resp.text
        # The HTTPValidationError arm of the union, NOT the business-code arm: the
        # rejection comes from the boundary (AM-6), so `detail` is a list of errors.
        assert isinstance(resp.json()["detail"], list), resp.text

    async def test_summary_redundant_anchor_is_ignored(
        self, client: AsyncClient
    ) -> None:
        # A client switching tabs leaves a stale param behind; its intent is
        # unambiguous, so only the CHOSEN unit's anchor is read (grooming R3).
        headers = await _register_and_login(client, "statsstray@x.com")
        await _create_tx(client, headers, amount_minor=1000, occurred_at="2026-02-15")

        plain = await client.get(
            "/stats/summary",
            params={"period": "month", "month": "2026-02"},
            headers=headers,
        )
        stray = await client.get(
            "/stats/summary",
            params={"period": "month", "month": "2026-02", "quarter": "2026-Q1"},
            headers=headers,
        )

        assert stray.status_code == 200, stray.text
        assert stray.json() == plain.json()  # byte-identical, not merely "also 200"


class TestStatsMonthly:
    async def test_monthly_dense_series_and_per_point_flags(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "statsmonthly@x.com")
        current_first = _today().replace(day=1)
        first_point = shift_month(current_first, -2)
        before_window = shift_month(current_first, -3)

        await _create_tx(
            client,
            headers,
            amount_minor=100000,
            occurred_at=first_point.isoformat(),
        )
        # Rateless, in the FIRST point's month only — the per-point flag must not
        # smear across the other two points.
        await _create_tx(
            client,
            headers,
            amount_minor=5000,
            currency="JPY",
            occurred_at=first_point.isoformat(),
        )
        # Middle month: nothing at all — the point must still exist, as zeros.
        # Dated TODAY: lands in the LAST point (the current month is included).
        await _create_tx(
            client,
            headers,
            amount_minor=250000,
            kind="income",
            occurred_at=_today().isoformat(),
        )
        # One month before the window — must not appear anywhere.
        await _create_tx(
            client,
            headers,
            amount_minor=777000,
            occurred_at=before_window.isoformat(),
        )

        resp = await client.get("/stats/monthly", params={"months": 3}, headers=headers)

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["currency"] == "RUB"
        assert body["points"] == [
            {
                "month": month_key(first_point),
                "income_minor": 0,
                "expense_minor": 100000,  # the pre-window row is NOT folded in here
                "net_minor": -100000,
                "unconverted_count": 1,
            },
            {
                "month": month_key(shift_month(current_first, -1)),
                "income_minor": 0,
                "expense_minor": 0,
                "net_minor": 0,
                "unconverted_count": 0,  # a clean month stays clean
            },
            {
                "month": month_key(current_first),
                "income_minor": 250000,
                "expense_minor": 0,
                "net_minor": 250000,
                "unconverted_count": 0,
            },
        ]


class TestTopMerchants:
    async def test_top_merchants_order_limit_and_null_merchants(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "statsmerch@x.com")
        await _create_tx(
            client,
            headers,
            amount_minor=500000,
            merchant="ALFA",
            occurred_at="2026-02-03",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=300000,
            merchant="ALFA",
            occurred_at="2026-02-04",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=500000,
            merchant="BETA",
            occurred_at="2026-02-05",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=100000,
            merchant="GAMMA",
            occurred_at="2026-02-06",
        )
        # Merchantless rows are out of the population entirely — never an item.
        await _create_tx(client, headers, amount_minor=900000, occurred_at="2026-02-07")

        resp = await client.get(
            "/stats/top-merchants",
            params={"period": "month", "month": "2026-02", "limit": 2},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["period"] == {"from": "2026-02-01", "to": "2026-02-28"}
        # ALFA's two rows fold into one 800000 item, ahead of BETA; GAMMA is cut
        # by the limit and the 900000 merchantless row never enters the ranking.
        assert body["items"] == [
            {"merchant": "ALFA", "total_minor": 800000, "tx_count": 2},
            {"merchant": "BETA", "total_minor": 500000, "tx_count": 1},
        ]
        assert body["unconverted_count"] == 0

    async def test_top_merchants_are_expense_only(self, client: AsyncClient) -> None:
        headers = await _register_and_login(client, "statsmerchkind@x.com")
        await _create_tx(
            client,
            headers,
            amount_minor=800000,
            merchant="ALFA",
            occurred_at="2026-02-03",
        )
        # Bigger than every expense merchant: if kind were not filtered, it would
        # top the list instead of being absent.
        await _create_tx(
            client,
            headers,
            amount_minor=5000000,
            kind="income",
            merchant="SalaryCo",
            occurred_at="2026-02-04",
        )

        resp = await client.get(
            "/stats/top-merchants",
            params={"period": "month", "month": "2026-02"},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["items"] == [
            {"merchant": "ALFA", "total_minor": 800000, "tx_count": 1}
        ]

    async def test_top_merchants_unconverted_excluded_from_totals_and_counts(
        self, client: AsyncClient
    ) -> None:
        headers = await _register_and_login(client, "statsmerchflag@x.com")
        await _create_tx(
            client,
            headers,
            amount_minor=100000,
            merchant="ALFA",
            occurred_at="2026-02-03",
        )
        await _create_tx(
            client,
            headers,
            amount_minor=5000,
            currency="JPY",
            merchant="ALFA",
            occurred_at="2026-02-04",
        )
        # DELTA's ONLY row is unconvertible: it is omitted, not shown as a zero
        # ("spent nothing here" would be a lie; the flag is the honest signal).
        await _create_tx(
            client,
            headers,
            amount_minor=9000,
            currency="KRW",
            merchant="DELTA",
            occurred_at="2026-02-05",
        )

        resp = await client.get(
            "/stats/top-merchants",
            params={"period": "month", "month": "2026-02"},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        # ALFA's total AND its count describe the same (rated) row set.
        assert body["items"] == [
            {"merchant": "ALFA", "total_minor": 100000, "tx_count": 1}
        ]
        assert body["unconverted_count"] == 2  # ALFA's JPY row and DELTA's KRW row


class TestStatsScopeAndAuth:
    async def test_stats_scoped_to_user(self, client: AsyncClient) -> None:
        headers_a = await _register_and_login(client, "statsscopea@x.com")
        headers_b = await _register_and_login(client, "statsscopeb@x.com")
        today = _today().isoformat()
        await _create_tx(
            client, headers_a, amount_minor=1000, merchant="AMERCH", occurred_at=today
        )
        await _create_tx(
            client, headers_b, amount_minor=999999, merchant="BMERCH", occurred_at=today
        )
        this_month = {"period": "month", "month": month_key(_today())}

        summary = await client.get(
            "/stats/summary", params=this_month, headers=headers_a
        )
        monthly = await client.get(
            "/stats/monthly", params={"months": 1}, headers=headers_a
        )
        merchants = await client.get(
            "/stats/top-merchants", params=this_month, headers=headers_a
        )

        assert summary.status_code == 200, summary.text
        assert monthly.status_code == 200, monthly.text
        assert merchants.status_code == 200, merchants.text
        assert summary.json()["expense_minor"] == 1000
        assert monthly.json()["points"][0]["expense_minor"] == 1000
        assert merchants.json()["items"] == [
            {"merchant": "AMERCH", "total_minor": 1000, "tx_count": 1}
        ]

    @pytest.mark.parametrize(
        ("path", "params"),
        [
            ("/stats/summary", {"period": "month", "month": "2026-02"}),
            ("/stats/monthly", {}),
            ("/stats/top-merchants", {"period": "month", "month": "2026-02"}),
            # Anchorless but syntactically valid: `resolve_period` RAISES its own
            # 422 here, so this arm pins the handler parameter order (auth first).
            ("/stats/summary", {"period": "month"}),
        ],
        ids=["summary", "monthly", "top-merchants", "summary-anchorless"],
    )
    async def test_stats_requires_auth(
        self, client: AsyncClient, path: str, params: dict[str, Any]
    ) -> None:
        resp = await client.get(path, params=params)

        assert resp.status_code == 401, resp.text
