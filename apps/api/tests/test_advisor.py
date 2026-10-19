"""Advisor ask contract — real Postgres, real aggregates, faked Anthropic seam.

The Anthropic boundary is mocked at ``app.state.advisor`` (the ``Advisor`` class
surface, the ``receipt_parser`` precedent): **no pytest makes a live Anthropic
call, ever** (binding). Everything before that boundary runs for real — auth, the
rate limiter, the 503 gate, the DB reads, the context builder — so what the fake
records in ``last_context`` is exactly what the real seam would have been handed.

Covers only what is new here: the SSE protocol (framing, the single terminal
frame, both failure positions), the guard ORDER around the stream (401 before 503,
503 before the quota, per-user and per-namespace keying), the request caps, and
what the assembled context does and does not contain. The three-bucket conversion
and the window math are already pinned by ``test_stats.py`` and
``test_advisor_context.py``; nothing here re-asserts them.
"""

import json
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import AsyncExitStack
from dataclasses import replace
from datetime import UTC, date, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from asgi_lifespan import LifespanManager
from helpers import account_for_currency
from httpx import ASGITransport, AsyncClient, Response
from starlette.requests import Request

from budget_api.app import create_app
from budget_api.config import Settings
from budget_api.domain.periods import month_key, shift_month
from budget_api.rate_limit import user_rl_key
from budget_api.services.advisor import (
    PLAIN_TEXT_INSTRUCTION,
    AdvisorContext,
    AdvisorError,
    CategorySpend,
    GoalSummary,
    MerchantSpend,
    MonthPoint,
    Turn,
    render_prompt,
)
from budget_api.services.advisor_context import ADVISOR_WINDOW_MONTHS, advisor_window

PASSWORD = "password123"
QUESTION = "Как мне сократить расходы?"


class _FakeAdvisor:
    """Stub at the ``app.state.advisor`` seam (the ``Advisor.stream_advice`` surface).

    Records what the router handed it — the context, the replayed history and the
    question — because those are otherwise invisible from the wire (the model's
    input never appears in the response).
    """

    def __init__(self, deltas: list[str], *, fail_after: int | None = None) -> None:
        self.deltas = deltas
        #: Raise after this many deltas: 0 = before the first one, len = after the
        #: last one but before the router's terminal frame.
        self.fail_after = fail_after
        self.calls = 0
        self.last_question: str | None = None
        self.last_history: tuple[Turn, ...] = ()
        self.last_context: AdvisorContext | None = None

    async def stream_advice(
        self, question: str, history: Sequence[Turn], context: AdvisorContext
    ) -> AsyncIterator[str]:
        self.calls += 1
        self.last_question = question
        self.last_history = tuple(history)
        self.last_context = context
        for index, delta in enumerate(self.deltas):
            if self.fail_after is not None and index == self.fail_after:
                raise AdvisorError()
            yield delta
        if self.fail_after == len(self.deltas):
            raise AdvisorError()


@pytest.fixture
async def make_advisor_client(
    test_database_url: str, test_jwt_secret: str
) -> AsyncIterator[Callable[..., Awaitable[AsyncClient]]]:
    """Factory: a lifespan-managed client whose app has a fake advisor seam.

    Not foldable into conftest's ``make_client`` (which returns only the client):
    these tests must reach the app object to assign ``app.state.advisor``. Same
    shape as ``test_receipts.py``'s ``make_receipts_client``, including the
    unconditional ``fx_scheduler_enabled=False`` — no pytest app may start the
    scheduler.
    """
    async with AsyncExitStack() as stack:

        async def _make(
            advisor: object | None = None, **overrides: object
        ) -> AsyncClient:
            overrides.setdefault("rate_limit_enabled", False)
            # Non-empty key by default so the ask route runs; the 503 tests override
            # it to "" to exercise the AI_NOT_CONFIGURED gate.
            overrides.setdefault("anthropic_api_key", "test-anthropic-key")
            overrides.setdefault("fx_scheduler_enabled", False)
            overrides.setdefault("recurring_scheduler_enabled", False)
            overrides.setdefault("push_scheduler_enabled", False)
            overrides.setdefault("embeddings_scheduler_enabled", False)
            overrides.setdefault("embeddings_provider", "fake")
            app = create_app(
                Settings(
                    database_url=test_database_url,
                    jwt_secret=test_jwt_secret,
                    **overrides,  # type: ignore[arg-type]
                )
            )
            if advisor is not None:
                app.state.advisor = advisor
            await stack.enter_async_context(LifespanManager(app))
            transport = ASGITransport(app=app)
            return await stack.enter_async_context(
                AsyncClient(transport=transport, base_url="http://test")
            )

        yield _make


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


def _frames(lines: list[str]) -> list[tuple[str, dict[str, Any]]]:
    """SSE lines → ``[(event, data), ...]``; a data line must follow its event line."""
    parsed: list[tuple[str, dict[str, Any]]] = []
    event: str | None = None
    for line in lines:
        if line.startswith("event: "):
            event = line.removeprefix("event: ")
        elif line.startswith("data: "):
            assert event is not None, f"data line without an event line: {line!r}"
            parsed.append((event, json.loads(line.removeprefix("data: "))))
            event = None
    return parsed


async def _ask_stream(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> tuple[Response, list[tuple[str, dict[str, Any]]]]:
    """POST /advisor/ask consuming the whole stream; frames are empty on a non-200."""
    body.setdefault("question", QUESTION)
    async with client.stream(
        "POST", "/advisor/ask", json=body, headers=headers
    ) as resp:
        if resp.status_code != 200:
            await resp.aread()
            return resp, []
        lines = [line async for line in resp.aiter_lines()]
    return resp, _frames(lines)


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 100000)
    body.setdefault("kind", "expense")
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


def _in_window() -> date:
    """A date inside the advisor's window (the 15th of its first full month)."""
    return advisor_window(_today())[0].replace(day=15)


class TestAskStream:
    async def test_ask_streams_deltas_then_done(
        self, make_advisor_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        # One delta deliberately carries a newline and a quote: with raw-text
        # framing that chunk would split into two frames and break the protocol.
        deltas = ['Первое.\nВторое "в кавычках"', " Хвост."]
        fake = _FakeAdvisor(deltas)
        client = await make_advisor_client(advisor=fake)
        headers = await _register_and_login(client, "askok@x.com")

        resp, frames = await _ask_stream(client, headers)

        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers["cache-control"] == "no-store"
        assert [event for event, _ in frames] == ["delta", "delta", "done"]
        assert "".join(str(data["text"]) for _, data in frames[:-1]) == "".join(deltas)
        assert fake.last_question == QUESTION

    @pytest.mark.parametrize(
        "fail_after", [0, 2], ids=["pre-first-delta", "mid-stream"]
    )
    async def test_ask_stream_failure_emits_error_event_on_200(
        self,
        make_advisor_client: Callable[..., Awaitable[AsyncClient]],
        fail_after: int,
    ) -> None:
        # The two arms are D9's two failure positions on ONE protocol: a failure
        # before the first delta is NOT a JSON status, it is the same error frame.
        fake = _FakeAdvisor(["a", "b", "c"], fail_after=fail_after)
        client = await make_advisor_client(advisor=fake)
        headers = await _register_and_login(client, f"askfail{fail_after}@x.com")

        resp, frames = await _ask_stream(client, headers)

        assert resp.status_code == 200, resp.text
        assert [event for event, _ in frames] == ["delta"] * fail_after + ["error"]
        assert frames[-1][1] == {"detail": "ANTHROPIC_ERROR"}


class TestAskGuards:
    async def test_ask_ai_not_configured_503(
        self, make_advisor_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        fake = _FakeAdvisor(["never"])
        client = await make_advisor_client(advisor=fake, anthropic_api_key="")
        headers = await _register_and_login(client, "asknokey@x.com")

        resp = await client.post(
            "/advisor/ask", json={"question": QUESTION}, headers=headers
        )

        assert resp.status_code == 503, resp.text
        assert resp.json() == {"detail": "AI_NOT_CONFIGURED"}
        # A JSON body, not a stream that immediately errors...
        assert resp.headers["content-type"].startswith("application/json")
        # ...and the gate is pre-seam: the model was never reached.
        assert fake.calls == 0

    async def test_ask_503_does_not_consume_rate_limit(
        self, make_advisor_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        # Disagreement 1 (upheld at R1): the gate is a dependency, so it resolves
        # BEFORE slowapi's wrapper. An unkeyed server must keep answering "ключ не
        # настроен" instead of flipping to RATE_LIMITED on the second click.
        client = await make_advisor_client(
            anthropic_api_key="",
            rate_limit_enabled=True,
            advisor_ask_rate_limit="1/minute",
        )
        headers = await _register_and_login(client, "asknokeyrl@x.com")

        first = await client.post(
            "/advisor/ask", json={"question": QUESTION}, headers=headers
        )
        second = await client.post(
            "/advisor/ask", json={"question": QUESTION}, headers=headers
        )

        assert first.status_code == 503, first.text
        assert second.status_code == 503, second.text
        assert second.json() == {"detail": "AI_NOT_CONFIGURED"}

    async def test_ask_rate_limited_per_user(
        self, make_advisor_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        # One app instance (one rate_limit_scope) so the per-USER key is the only
        # thing separating the two counters — both users share the localhost IP.
        client = await make_advisor_client(
            advisor=_FakeAdvisor(["ok"]),
            rate_limit_enabled=True,
            advisor_ask_rate_limit="1/minute",
        )
        headers_a = await _register_and_login(client, "askrlA@x.com")
        headers_b = await _register_and_login(client, "askrlB@x.com")

        first_a, first_frames = await _ask_stream(client, headers_a)
        second_a, _ = await _ask_stream(client, headers_a)
        first_b, b_frames = await _ask_stream(client, headers_b)

        assert first_a.status_code == 200, first_a.text
        assert [event for event, _ in first_frames] == ["delta", "done"]
        assert second_a.status_code == 429, second_a.text
        assert second_a.json() == {"detail": "RATE_LIMITED"}
        assert first_b.status_code == 200, first_b.text
        assert [event for event, _ in b_frames] == ["delta", "done"]

    async def test_rl_namespaces_are_isolated(
        self, make_advisor_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        # End-to-end sanity, NOT a proof of the namespace segment: slowapi scopes
        # its counters per decorated endpoint anyway, so this would pass on
        # identical key strings too (the segment itself is pinned by
        # TestUserRlKey below). What it does check is that the whole wiring holds
        # on a live app — an exhausted advisor budget leaves /receipts answering.
        client = await make_advisor_client(
            advisor=_FakeAdvisor(["ok"]),
            rate_limit_enabled=True,
            advisor_ask_rate_limit="1/minute",
        )
        headers = await _register_and_login(client, "asknamespace@x.com")

        first, _ = await _ask_stream(client, headers)
        second, _ = await _ask_stream(client, headers)
        # Presign is pure local SigV4 (no I/O), so this needs no MinIO.
        receipt = await client.post("/receipts", headers=headers)

        assert first.status_code == 200, first.text
        assert second.status_code == 429, second.text
        assert receipt.status_code == 201, receipt.text

    async def test_ask_requires_auth(
        self, make_advisor_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        client = await make_advisor_client(advisor=_FakeAdvisor(["never"]))
        unkeyed = await make_advisor_client(
            advisor=_FakeAdvisor(["never"]), anthropic_api_key=""
        )

        resp = await client.post("/advisor/ask", json={"question": QUESTION})
        # The parameter-order pin (B1 carry-forward): with the gate declared before
        # auth, THIS request would answer 503 and leak the server's key state to an
        # anonymous caller.
        on_unkeyed = await unkeyed.post("/advisor/ask", json={"question": QUESTION})
        # A blank question is a 422 for an authenticated caller (pinned in
        # TestAskValidation), so this arm pins that the auth wall fires BEFORE body
        # validation — the same pre-auth-grammar landmine B1 fixed on /stats.
        invalid_body = await client.post("/advisor/ask", json={"question": "   "})

        assert resp.status_code == 401, resp.text
        assert on_unkeyed.status_code == 401, on_unkeyed.text
        assert invalid_body.status_code == 401, invalid_body.text


class TestUserRlKey:
    def test_namespaces_key_the_same_user_apart(self) -> None:
        # Pure unit on the factory the wire test above cannot reach: for ONE stashed
        # user id the two namespaces must produce different keys, each still carrying
        # that user id — a factory that dropped `namespace` (or keyed on the IP)
        # fails here while every e2e arm stays green.
        uid = "11111111-1111-1111-1111-111111111111"
        request = Request(
            {
                "type": "http",
                "app": SimpleNamespace(state=SimpleNamespace(rate_limit_scope="app-1")),
                "state": {"rl_user_id": uid},
            }
        )

        receipt = user_rl_key("receipt")(request)
        advisor = user_rl_key("advisor")(request)

        assert receipt != advisor
        assert receipt.split(":") == ["app-1", "receipt", uid]
        assert advisor.split(":") == ["app-1", "advisor", uid]


class TestAskValidation:
    async def test_ask_history_caps_and_reaches_the_seam(
        self, make_advisor_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        fake = _FakeAdvisor(["ok"])
        client = await make_advisor_client(advisor=fake)
        headers = await _register_and_login(client, "askhistory@x.com")
        turns = [
            {"role": "user" if index % 2 == 0 else "assistant", "content": f"т{index}"}
            for index in range(10)
        ]

        too_many = await client.post(
            "/advisor/ask",
            json={"question": QUESTION, "history": [*turns, turns[0]]},
            headers=headers,
        )
        too_long = await client.post(
            "/advisor/ask",
            json={
                "question": QUESTION,
                "history": [{"role": "user", "content": "x" * 801} for _ in range(10)],
            },
            headers=headers,
        )
        accepted, frames = await _ask_stream(client, headers, history=turns)

        assert too_many.status_code == 422, too_many.text
        assert too_long.status_code == 422, too_long.text
        # The accept arm: without it both rejections would pass against a cap of 0.
        assert accepted.status_code == 200, accepted.text
        assert [event for event, _ in frames] == ["delta", "done"]
        # AM-4: the carried conversation must actually REACH the seam, in order and
        # with roles intact — a router that dropped `history` passes every other
        # assertion in this file while chat memory is silently dead.
        assert [(turn.role, turn.content) for turn in fake.last_history] == [
            (str(turn["role"]), str(turn["content"])) for turn in turns
        ]

    @pytest.mark.parametrize(
        ("question", "expected"),
        [("", 422), ("   ", 422), ("?" * 2001, 422), ("?" * 2000, 200)],
        ids=["empty", "blank", "over-cap", "at-cap"],
    )
    async def test_ask_question_validation(
        self,
        make_advisor_client: Callable[..., Awaitable[AsyncClient]],
        question: str,
        expected: int,
    ) -> None:
        # AM-5: the strip/blank/cap validator is custom logic; the at-cap arm is what
        # keeps the three rejections from passing against a cap of 0.
        client = await make_advisor_client(advisor=_FakeAdvisor(["ok"]))
        headers = await _register_and_login(client, "askquestion@x.com")

        resp, _ = await _ask_stream(client, headers, question=question)

        assert resp.status_code == expected, resp.text


class TestAskContext:
    async def test_prompt_carries_no_raw_transactions(
        self, make_advisor_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        fake = _FakeAdvisor(["ok"])
        client = await make_advisor_client(advisor=fake)
        headers = await _register_and_login(client, "askprompt@x.com")
        category = await client.post(
            "/categories", json={"name": "Кафе", "kind": "expense"}, headers=headers
        )
        assert category.status_code == 201, category.text
        occurred_at = _in_window()
        tx = await _create_tx(
            client,
            headers,
            amount_minor=250000,
            category_id=category.json()["id"],
            merchant="КОФЕЙНЯ",
            note="SECRET-NOTE-XYZ",
            occurred_at=occurred_at.isoformat(),
        )
        # AM-7: one rateless foreign row, so `unconverted_count` cannot be a
        # hardcoded 0 and the prompt has something honest to disclose.
        await _create_tx(
            client,
            headers,
            amount_minor=5000,
            currency="JPY",
            occurred_at=occurred_at.isoformat(),
        )

        resp, _ = await _ask_stream(client, headers)

        assert resp.status_code == 200, resp.text
        assert fake.last_context is not None
        prompt = render_prompt(fake.last_context)
        # The §Безопасность pin: aggregates only. Nothing per-row reaches the model.
        assert "SECRET-NOTE-XYZ" not in prompt
        assert str(tx["id"]) not in prompt
        assert occurred_at.isoformat() not in prompt
        # ...and it is not vacuous: the aggregates the row belongs to ARE there.
        assert "Кафе" in prompt
        assert "КОФЕЙНЯ" in prompt
        assert fake.last_context.unconverted_count == 1
        assert "их количество: 1" in prompt

    async def test_context_window_excludes_current_partial_month(
        self, make_advisor_client: Callable[..., Awaitable[AsyncClient]]
    ) -> None:
        fake = _FakeAdvisor(["ok"])
        client = await make_advisor_client(advisor=fake)
        headers = await _register_and_login(client, "askwindow@x.com")
        last_full_month = shift_month(_today().replace(day=1), -1)
        await _create_tx(
            client,
            headers,
            amount_minor=9_000_000,
            kind="income",
            occurred_at=_today().isoformat(),
        )

        resp, _ = await _ask_stream(client, headers)

        assert resp.status_code == 200, resp.text
        assert fake.last_context is not None
        # The current (partial) month is not a point at all, and its rows are in no
        # total: a window that merely counted back 3 months would show them.
        months = fake.last_context.months
        assert [point.month for point in months][-1] == month_key(last_full_month)
        assert [point.income_minor for point in months] == [0, 0, 0]

        # The SAME amount one month earlier does land — the contrast that makes the
        # exclusion above about the window and not about the seeding.
        await _create_tx(
            client,
            headers,
            amount_minor=9_000_000,
            kind="income",
            occurred_at=last_full_month.isoformat(),
        )
        resp, _ = await _ask_stream(client, headers)

        assert resp.status_code == 200, resp.text
        assert fake.last_context is not None
        assert fake.last_context.months[-1].income_minor == 9_000_000


class TestRenderPrompt:
    def _context(self, currency: str, minor: int) -> AdvisorContext:
        return AdvisorContext(
            base_currency=currency,
            monthly_income_minor=minor,
            window_from=date(2026, 5, 1),
            window_to=date(2026, 7, 31),
            # A DEFICIT month: the signed net has to survive the render, since a
            # dropped sign turns "проели больше, чем заработали" into a surplus.
            months=(MonthPoint("2026-05", minor, minor * 2, -minor),),
            by_category=(CategorySpend("Еда", "expense", minor),),
            top_merchants=(MerchantSpend("ALFA", minor, 2),),
            goals=(
                GoalSummary(
                    name="Отпуск",
                    currency="JPY",
                    target_minor=minor,
                    saved_minor=0,
                    deadline=None,
                    monthly_needed_minor=0,
                    realistic=None,
                    allocated_monthly_minor=minor,
                ),
            ),
            unconverted_count=0,
        )

    def test_render_prompt_scales_money_by_exponent(self) -> None:
        # A hardcoded /100 passes the RUB arm and fails the JPY one — which is the
        # whole point of carrying the currency down to the render layer (AM-5).
        rub = render_prompt(self._context("RUB", 125000))
        jpy = render_prompt(self._context("JPY", 125000))

        assert "1250.00 RUB" in rub
        assert "125000 JPY" in jpy
        assert "баланс -1250.00 RUB" in rub
        assert "баланс -125000 JPY" in jpy
        # The goal is in JPY in BOTH contexts while the allocation is in the base
        # currency: one prompt, two exponents, each with its own code.
        assert "цель 125000 JPY" in rub
        assert "выделяется 1250.00 RUB" in rub

    def test_render_prompt_states_window_income_and_plain_text_rule(self) -> None:
        context = self._context("RUB", 125000)
        with_income = render_prompt(context)
        without_income = render_prompt(replace(context, monthly_income_minor=None))

        # AM-8 / CA-2: the web renders plain text, so this instruction must survive
        # every future prompt edit.
        assert PLAIN_TEXT_INSTRUCTION in with_income
        assert "текущий неполный месяц не включён" in with_income
        assert "1 мая 2026" in with_income and "31 июля 2026" in with_income
        # The window sentence above spells the month count in Russian WORDS ("три
        # полных календарных месяца"), so no format string ties it to the constant:
        # widening the window without re-wording the prompt fails here.
        assert ADVISOR_WINDOW_MONTHS == 3
        # A missing income is STATED as missing rather than rendered as a 0 figure
        # the model would reason about as if it were real.
        assert "доход: не указан" in without_income
