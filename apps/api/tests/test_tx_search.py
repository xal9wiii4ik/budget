"""``GET /transactions/search``: ranking, the money, the refusals.

Real Postgres, real HTTP, the ``FakeEmbedder`` (hashed bag of words — no 135 MB
artifact). Nothing here asserts that the model understands anything: it asserts
that the rows come back in score order, that the total over them is the one
``tx_totals`` would have produced, that a bounded repair is REPORTED rather than
hidden, and that each refusal arm answers its own code in its own order.
"""

import uuid
from collections.abc import Awaitable, Callable
from datetime import date
from decimal import Decimal
from typing import Any

from helpers import add_account, create_account
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import ExchangeRate, Transaction

PASSWORD = "password123"

MakeClient = Callable[..., Awaitable[AsyncClient]]


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


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", "2026-03-15")
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def _search(
    client: AsyncClient, headers: dict[str, str], **params: Any
) -> dict[str, Any]:
    resp = await client.get("/transactions/search", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


class TestRanking:
    async def test_the_word_sharing_row_wins_and_scores_descend(
        self, client: AsyncClient
    ) -> None:
        """The whole path end to end: index on demand, embed, rank, stamp.

        With the hashed-bag-of-words embedder "apteka" shares a token with
        exactly one row, so the ranking is a real assertion and not noise. What
        it guards is the chain — the search-time refresh, the candidate join,
        the dot product and the stable argsort — any break in which would make
        every other test in this file pass over an empty or arbitrary list.
        """
        headers, _ = await _register_and_login(client, "search-rank@x.com")
        account = (await create_account(client, headers))["id"]
        pharmacy = await _create_tx(
            client, headers, merchant="Apteka Gemini", account_id=account
        )
        await _create_tx(client, headers, merchant="Biedronka", account_id=account)
        await _create_tx(client, headers, merchant="Uber", account_id=account)

        body = await _search(client, headers, q="apteka")

        scores = [item["score"] for item in body["items"]]
        assert body["items"][0]["transaction"]["id"] == pharmacy["id"]
        assert scores[0] > scores[1]
        assert scores == sorted(scores, reverse=True)
        # The two unrelated rows are RETURNED at score 0, not filtered out:
        # there is no default cut-off (D-R3), only `limit`.
        assert scores[1] == 0.0
        assert (body["model"], body["candidates"]) == ("fake", 3)
        assert body["pending_count"] == 0

    async def test_a_foreign_account_filter_is_indistinguishable_from_no_match(
        self, client: AsyncClient
    ) -> None:
        """No-oracle on a read: the body for somebody else's account id is the
        body for an id that does not exist at all. A 404, or an empty list with
        a different ``candidates``, would both answer "that account is real"."""
        headers, _ = await _register_and_login(client, "search-oracle@x.com")
        account = (await create_account(client, headers))["id"]
        await _create_tx(client, headers, merchant="Apteka", account_id=account)
        stranger_headers, _ = await _register_and_login(
            client, "search-oracle-other@x.com"
        )
        stranger_account = (await create_account(client, stranger_headers))["id"]

        foreign = await _search(
            client, headers, q="apteka", account_id=stranger_account
        )
        missing = await _search(client, headers, q="apteka", account_id=uuid.uuid4())

        assert foreign == missing
        assert foreign["items"] == []

    async def test_transfers_are_not_searchable_and_not_totalled(
        self, client: AsyncClient
    ) -> None:
        """``kind=transfer`` answers an honest empty page (D-T4).

        Searchable ⇔ totalable: transfers are out of BOTH populations, so the
        index holds none and there is no third "excluded from the total"
        counter for the UI to explain. The filter is accepted rather than
        rejected — it is a legal value of the same enum the list route takes.
        """
        headers, _ = await _register_and_login(client, "search-transfer@x.com")
        source = (await create_account(client, headers, name="Карта"))["id"]
        target = (await create_account(client, headers, name="Наличные"))["id"]
        await _create_tx(
            client,
            headers,
            kind="transfer",
            account_id=source,
            counter_account_id=target,
            counter_amount_minor=1000,
            note="перевод на наличные",
        )
        await _create_tx(client, headers, merchant="Apteka", account_id=source)

        body = await _search(client, headers, q="перевод", kind="transfer")

        assert body["items"] == []
        assert body["candidates"] == 0
        assert body["total"]["income_minor"] == 0
        assert body["total"]["expense_minor"] == 0


class TestTotal:
    async def test_the_three_buckets_over_the_returned_rows(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """One base-currency row, one snapshot row, one row with no rate.

        The only money math this scope adds, and it has to agree with the month
        summary's: the base-currency row is taken at face value, the foreign one
        through the snapshot written at create time, and the one whose currency
        has no rate at all LEAVES every sum and is counted instead of being
        summed as zero (D9's exclude-and-flag).

        The USD row's snapshot is set to 3 990.00 RUB while the rate in the table
        would convert it to 4 000.00 — so the asserted number can only come from
        the snapshot arm, and the ARM ORDER (the user's own figure beats a rate
        lookup, ``conventions.md`` §snapshot) is what is actually pinned here. A
        ``converted_total_for_rows`` that skipped bucket 2 would now fail.
        """
        headers, _ = await _register_and_login(client, "search-total@x.com")
        db_session.add(
            ExchangeRate(
                base="USD",
                quote="RUB",
                as_of_date=date(2026, 3, 1),
                rate=Decimal("80"),
                provider="test",
            )
        )
        await db_session.commit()
        rub = (await create_account(client, headers, currency="RUB"))["id"]
        usd = (await create_account(client, headers, currency="USD"))["id"]
        krw = (await create_account(client, headers, currency="KRW"))["id"]

        await _create_tx(
            client,
            headers,
            merchant="Apteka Jeden",
            account_id=rub,
            amount_minor=10_000,
        )
        await _create_tx(
            client,
            headers,
            merchant="Apteka Dwa",
            account_id=usd,
            amount_minor=5_000,
            kind="income",
            # The user's own RUB figure for this row, DIFFERENT from what the
            # 80.00 rate gives (400 000): the snapshot arm has to win.
            base_amount_minor=399_000,
        )
        await _create_tx(
            client, headers, merchant="Apteka Trzy", account_id=krw, amount_minor=1_000
        )

        body = await _search(client, headers, q="apteka")

        assert len(body["items"]) == 3
        assert body["total"] == {
            "currency": "RUB",
            # The STORED snapshot (3 990.00 RUB), not the 4 000.00 the rate in
            # the table would have produced.
            "income_minor": 399_000,
            "expense_minor": 10_000,
            "net_minor": 389_000,
            # The KRW row: no rate on any day, so it is in `items` and in
            # neither sum.
            "unconverted_count": 1,
        }


class TestPending:
    async def test_the_refresh_is_bounded_and_the_remainder_is_reported(
        self, make_client: MakeClient, db_session: AsyncSession
    ) -> None:
        """100 unindexed rows, a 64-row repair budget: 36 pending, then 0.

        The honesty guarantee behind "I imported a statement, then searched":
        the rows the bounded repair could not reach are NAMED in the response
        instead of being silently absent from the answer. The second call
        finishes them, which is what makes the bound safe to have.
        """
        client = await make_client(search_max_refresh=64)
        headers, user_id = await _register_and_login(client, "search-pending@x.com")
        account = await add_account(db_session, user_id, name="Main")
        for index in range(100):
            db_session.add(
                Transaction(
                    user_id=user_id,
                    account_id=account.id,
                    amount_minor=1_000 + index,
                    kind="expense",
                    currency="RUB",
                    merchant=f"Apteka {index}",
                    occurred_at=date(2026, 3, 1),
                )
            )
        await db_session.commit()

        first = await _search(client, headers, q="apteka")
        second = await _search(client, headers, q="apteka")

        assert first["pending_count"] == 36
        assert first["candidates"] == 64
        assert second["pending_count"] == 0
        assert second["candidates"] == 100


class TestRefusals:
    async def test_a_server_without_a_model_answers_503_after_401(
        self, make_client: MakeClient
    ) -> None:
        """``EMBEDDINGS_PROVIDER=off`` → 503 for a caller, 401 for a stranger.

        Both arms on ONE server, because the ordering is the claim: the gate is
        declared AFTER the user dependency, so an anonymous request is still
        401 and the 503 never becomes a way to probe the API without a token.
        """
        client = await make_client(embeddings_provider="off")
        headers, _ = await _register_and_login(client, "search-off@x.com")

        gated = await client.get(
            "/transactions/search", params={"q": "apteka"}, headers=headers
        )
        anonymous = await client.get("/transactions/search", params={"q": "apteka"})

        assert gated.status_code == 503, gated.text
        assert gated.json() == {"detail": "EMBEDDINGS_NOT_AVAILABLE"}
        assert anonymous.status_code == 401, anonymous.text

    async def test_a_blank_query_is_refused_instead_of_matching_everything(
        self, client: AsyncClient
    ) -> None:
        """``q="   "`` → 422 SEARCH_QUERY_BLANK, the one read param that refuses.

        Every row "contains" the empty string, so the ``read_filters`` answer to
        a blank (treat it as absent) would here mean "rank the whole ledger
        against nothing" — a full page of score-0 rows presented as results.
        """
        headers, _ = await _register_and_login(client, "search-blank@x.com")

        resp = await client.get(
            "/transactions/search", params={"q": "   "}, headers=headers
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "SEARCH_QUERY_BLANK"}

    async def test_a_read_token_can_search(
        self, client: AsyncClient, pat_factory: Callable[..., Awaitable[dict[str, Any]]]
    ) -> None:
        """A read-scope PAT reaches the route — the allowlist is DERIVED.

        The pair is in the allowlist only because the ``@mcp_tool`` marker sits
        immediately above ``async def``; a limiter wrapper slipped between them
        would hide it, and this route would 403 a token while still looking
        correct in review.
        """
        headers, _ = await _register_and_login(client, "search-pat@x.com")
        account = (await create_account(client, headers))["id"]
        await _create_tx(client, headers, merchant="Apteka", account_id=account)
        token = (await pat_factory(client, headers, "read"))["token"]

        resp = await client.get(
            "/transactions/search",
            params={"q": "apteka"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert resp.status_code == 200, resp.text
        assert len(resp.json()["items"]) == 1

    async def test_the_second_search_of_the_minute_is_refused(
        self, make_client: MakeClient
    ) -> None:
        """429 RATE_LIMITED on the second call — which also proves the mount.

        The route is the first one under ``/transactions`` to call
        ``limiter.limit``, and an unprimed limiter check answers 500, not 429:
        this is the test that would catch the mount losing its
        ``Depends(prime_rate_limit)``.
        """
        client = await make_client(
            rate_limit_enabled=True, search_rate_limit="1/minute"
        )
        headers, _ = await _register_and_login(client, "search-rl@x.com")

        first = await client.get(
            "/transactions/search", params={"q": "apteka"}, headers=headers
        )
        second = await client.get(
            "/transactions/search", params={"q": "apteka"}, headers=headers
        )

        assert first.status_code == 200, first.text
        assert second.status_code == 429, second.text
        assert second.json() == {"detail": "RATE_LIMITED"}
