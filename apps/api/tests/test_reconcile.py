"""The reconcile agent without a database: the pre-match, the loop, the budgets.

What only this layer can prove: that the SERVER settles what it can prove before
a model sees anything, that an answer naming opaque keys comes back as the right
uuids, that a model cannot talk the server into an item it did not earn, and that
every budget ends the loop with a NAMED reason instead of an exception.

The router's own arms (the claim, the stored document, the two reads) are in
``test_statement_reconcile_api.py`` against real Postgres; the fake provider's
scripted script is pinned in ``test_llm_providers.py``. Neither is re-asserted
here.
"""

import asyncio
import uuid
from collections.abc import Sequence
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from budget_api.llm import LLMRequest, LLMResponse, ToolUseBlock, Usage
from budget_api.llm.fake import FakeProvider
from budget_api.services.reconcile import (
    LIST_ROWS_TOOL,
    MAX_EXPLANATION_CHARS,
    PROMPT_FINGERPRINTS,
    PROMPT_VERSION,
    REPORT_TOOL,
    ReconcileConfig,
    ReconcileOutcome,
    RowFact,
    TxFact,
    prematch,
    prompt_fingerprint,
    reconcile,
)

DAY = date(2026, 6, 10)
CURRENCY = "BYN"

CONFIG = ReconcileConfig(
    max_steps=8,
    max_total_tokens=60_000,
    time_budget_seconds=10,
    max_items_per_side=300,
)


def _row(
    *,
    amount_minor: int,
    txn_date: date = DAY,
    client_id: uuid.UUID | None = None,
    kind: str = "expense",
    description: str = "SHOP",
) -> RowFact:
    return RowFact(
        id=uuid.uuid4(),
        row_index=0,
        client_id=client_id or uuid.uuid4(),
        txn_date=txn_date,
        booked_date=txn_date,
        kind=kind,
        amount_minor=amount_minor,
        currency=CURRENCY,
        original_amount_minor=None,
        original_currency=None,
        description=description,
        merchant=None,
    )


def _tx(
    *,
    amount_minor: int,
    occurred_at: date = DAY,
    client_id: uuid.UUID | None = None,
    kind: str = "expense",
) -> TxFact:
    return TxFact(
        id=uuid.uuid4(),
        client_id=client_id,
        occurred_at=occurred_at,
        kind=kind,
        amount_minor=amount_minor,
        currency=CURRENCY,
        merchant=None,
        note=None,
        is_transfer=False,
        is_debt_movement=False,
    )


def _usage(input_tokens: int = 10, output_tokens: int = 10) -> Usage:
    return Usage(
        provider="stub",
        model="stub",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=0,
        latency_ms=1,
        estimated_cost_usd=Decimal(0),
    )


class StubProvider:
    """Answers with scripted blocks; the LAST answer repeats for every later step.

    A stub rather than the fake: these tests are about what the LOOP does with an
    answer (a tool call it must echo, a terminal call it must validate, a usage
    block that blows the token budget), and the fake deliberately answers only
    its own script.
    """

    name = "stub"
    model = "stub"

    def __init__(self, answers: Sequence[LLMResponse], *, sleep: float = 0.0) -> None:
        self._answers = list(answers)
        self._sleep = sleep
        self.calls = 0

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls += 1
        if self._sleep:
            await asyncio.sleep(self._sleep)
        index = min(self.calls, len(self._answers)) - 1
        return self._answers[index]


def _list_call(usage: Usage | None = None) -> LLMResponse:
    return LLMResponse(
        blocks=(ToolUseBlock(id=f"stub-{uuid.uuid4()}", name=LIST_ROWS_TOOL),),
        stop_reason="tool_use",
        usage=usage or _usage(),
    )


def _terminal(items: list[dict[str, Any]], summary: str = "done") -> LLMResponse:
    return LLMResponse(
        blocks=(
            ToolUseBlock(
                id="stub-terminal",
                name=REPORT_TOOL,
                input={"items": items, "summary": summary},
            ),
        ),
        stop_reason="tool_use",
        usage=_usage(),
    )


async def _run(
    provider: Any,
    rows: Sequence[RowFact],
    transactions: Sequence[TxFact],
    config: ReconcileConfig = CONFIG,
) -> ReconcileOutcome:
    return await reconcile(
        provider,
        prematch(rows, transactions),
        config,
        period_from=date(2026, 6, 1),
        period_to=date(2026, 6, 30),
        currency=CURRENCY,
    )


class TestPrematch:
    def test_the_server_settles_exact_pairs_and_hands_over_the_arithmetic(
        self,
    ) -> None:
        """Both proofs settle; resemblance does not — it becomes a pair with deltas.

        The fingerprint arm and the value arm are asserted together because they
        answer the same question from two sides, and the model must see NEITHER:
        an exact pair shown to it is a token spent on something already decided.
        The two deltas are signed "transaction minus row", so a test that only
        looked at one sign would pass with them swapped.
        """
        fingerprint = uuid.uuid4()
        by_client = _row(amount_minor=1_000, client_id=fingerprint)
        # Deliberately a different amount AND date: only the fingerprint can
        # match these two.
        its_tx = _tx(
            amount_minor=9_999,
            occurred_at=DAY + timedelta(days=2),
            client_id=fingerprint,
        )
        by_value = _row(amount_minor=5_000)
        value_tx = _tx(amount_minor=5_000)
        similar = _row(amount_minor=7_000)
        similar_tx = _tx(amount_minor=7_000, occurred_at=DAY + timedelta(days=1))
        lonely = _row(amount_minor=1_234)
        cheaper_tx = _tx(amount_minor=999)

        pre = prematch(
            [by_client, by_value, similar, lonely],
            [its_tx, value_tx, similar_tx, cheaper_tx],
        )

        assert set(pre.settled) == {
            (by_client.id, its_tx.id),
            (by_value.id, value_tx.id),
        }
        assert {row.id for row in pre.open_rows} == {similar.id, lonely.id}
        assert {tx.id for tx in pre.open_transactions} == {
            similar_tx.id,
            cheaper_tx.id,
        }
        deltas = {
            (pair.row_id, pair.transaction_id): (
                pair.amount_delta_minor,
                pair.date_delta_days,
            )
            for pair in pre.pairs
        }
        assert deltas[(similar.id, similar_tx.id)] == (0, 1)
        assert deltas[(lonely.id, cheaper_tx.id)] == (-235, 0)


class TestScriptedLoop:
    async def test_the_fake_loop_reports_every_open_item_with_real_uuids(
        self,
    ) -> None:
        """The deterministic path a QA stand runs — and the key→uuid round trip.

        The fake names ``r1``/``t1``; what comes back must be the ids the ROUTER
        passed in, because the stored report and the wire carry uuids and a
        mangled key is a dropped item. Every number besides the items is the
        server's own, so they are asserted against the pre-match and not against
        anything the model said.
        """
        settled_row = _row(amount_minor=100, client_id=uuid.uuid4())
        settled_tx = _tx(amount_minor=100, client_id=settled_row.client_id)
        first = _row(amount_minor=2_500)
        second = _row(amount_minor=3_100, txn_date=DAY + timedelta(days=1))
        extra = _tx(amount_minor=5_000, occurred_at=DAY + timedelta(days=20))

        outcome = await _run(
            FakeProvider("fake"),
            [settled_row, first, second],
            [settled_tx, extra],
        )

        assert outcome.aborted_reason is None
        report = outcome.report
        assert report is not None
        # rows-tool → transactions-tool → the terminal report.
        assert outcome.steps == 3
        assert (report.settled_exact, report.open_rows, report.open_transactions) == (
            1,
            2,
            1,
        )
        assert {
            (item.kind, item.row_id, item.transaction_id) for item in report.items
        } == {
            ("missing_in_app", first.id, None),
            ("missing_in_app", second.id, None),
            ("extra_in_app", None, extra.id),
        }
        assert report.counts_by_kind == {
            "missing_in_app": 2,
            "extra_in_app": 1,
            "amount_differs": 0,
            "date_differs": 0,
            "fx_difference": 0,
        }
        assert (report.unmentioned_rows, report.unmentioned_transactions) == (0, 0)
        assert report.summary


class TestTerminalValidation:
    async def test_unusable_items_are_dropped_and_the_rest_survives(self) -> None:
        """Six ways to lose an item, and the two that earn their place.

        Dropping rather than refusing is the decision under test: a model that
        got two items right and six wrong has still produced two findings. Each
        bad entry is a different failure — an unknown kind, a key the open sets
        do not contain, an id the kind may not carry, a repeated pair, an empty
        explanation — and all of them are the SAME outcome.
        """
        first = _row(amount_minor=2_500)
        second = _row(amount_minor=3_100)
        tx = _tx(amount_minor=2_600)
        provider = StubProvider(
            [
                _terminal(
                    [
                        {"kind": "invented", "row_id": "r1", "explanation": "x"},
                        {
                            "kind": "missing_in_app",
                            "row_id": "r99",
                            "explanation": "a row nobody opened",
                        },
                        {
                            "kind": "missing_in_app",
                            "row_id": "r1",
                            "transaction_id": "t1",
                            "explanation": "two ids for a one-sided kind",
                        },
                        {
                            "kind": "amount_differs",
                            "row_id": "r1",
                            "transaction_id": "t1",
                            "explanation": "100 kopecks apart, same day",
                        },
                        {
                            "kind": "date_differs",
                            "row_id": "r1",
                            "transaction_id": "t1",
                            "explanation": "the same pair again",
                        },
                        {
                            "kind": "extra_in_app",
                            "transaction_id": "t1",
                            "explanation": "   ",
                        },
                        {
                            "kind": "missing_in_app",
                            "row_id": "r2",
                            "explanation": "z" * (MAX_EXPLANATION_CHARS + 100),
                        },
                    ]
                )
            ]
        )

        outcome = await _run(provider, [first, second], [tx])

        report = outcome.report
        assert report is not None
        assert [
            (item.kind, item.row_id, item.transaction_id) for item in report.items
        ] == [
            ("amount_differs", first.id, tx.id),
            ("missing_in_app", second.id, None),
        ]
        assert len(report.items[1].explanation) == MAX_EXPLANATION_CHARS
        assert report.counts_by_kind["amount_differs"] == 1
        assert report.counts_by_kind["date_differs"] == 0
        # Both open rows were mentioned; the transaction only through the pair.
        assert (report.unmentioned_rows, report.unmentioned_transactions) == (0, 0)


class TestBudgets:
    async def test_a_loop_that_never_reports_is_stopped_by_max_steps(self) -> None:
        """A model that keeps asking for lists burns its steps and nothing else.

        ``report is None`` with a NAMED reason is the contract the route depends
        on: it stores ``failed`` and answers 422, which it could not do if the
        loop raised or returned an empty report that looked successful.
        """
        provider = StubProvider([_list_call()])
        config = ReconcileConfig(
            max_steps=3,
            max_total_tokens=60_000,
            time_budget_seconds=10,
            max_items_per_side=300,
        )

        outcome = await _run(provider, [_row(amount_minor=100)], [], config)

        assert (outcome.report, outcome.aborted_reason) == (None, "steps")
        assert (provider.calls, outcome.steps, len(outcome.calls)) == (3, 3, 3)

    async def test_the_token_budget_stops_the_loop_after_the_call_that_blew_it(
        self,
    ) -> None:
        """Σ in+out over the conversation, checked after each step.

        The call that overspent is still PAID for (it happened) and still logged;
        what the budget buys is that there is no second one.
        """
        provider = StubProvider(
            [_list_call(_usage(input_tokens=50_000, output_tokens=20_000))]
        )

        outcome = await _run(provider, [_row(amount_minor=100)], [])

        assert (outcome.report, outcome.aborted_reason) == (None, "tokens")
        assert provider.calls == 1

    async def test_the_time_budget_aborts_instead_of_raising(self) -> None:
        """A provider that hangs must end as a reason, never as an exception.

        The whole route depends on this: the claim is already committed when the
        loop starts, so an exception out of ``reconcile`` would leave the session
        ``running`` forever.
        """
        provider = StubProvider([_list_call()], sleep=5)
        config = ReconcileConfig(
            max_steps=8,
            max_total_tokens=60_000,
            time_budget_seconds=0.05,
            max_items_per_side=300,
        )

        outcome = await _run(provider, [_row(amount_minor=100)], [], config)

        assert (outcome.report, outcome.aborted_reason) == (None, "time_budget")


class TestPromptFingerprint:
    def test_the_prompt_and_the_tools_are_pinned_to_their_version(self) -> None:
        """Editing the prompt or a tool schema without bumping the version fails.

        The evals numbers and every replay fixture are keyed by the prompt; a
        silent edit would invalidate both with nothing to notice it.
        """
        assert PROMPT_FINGERPRINTS[PROMPT_VERSION] == prompt_fingerprint()
