"""``services/categorize`` — the rules a model's answer is held to, and the budget.

No DB, no network, no app: the whole module is pure (architecture §"The categorize
service"), so these tests drive it directly with two providers —
``FakeProvider("fake")`` for the shape a real pass has, and a stub answering canned
payloads for the arms a substring matcher cannot produce (a valid LOW confidence, a
key nobody offered, a number that is not one).

Keys are deterministic by construction, which is what makes canned answers
possible: categories are ``c1..cN`` over the whole list sorted by (kind, name, id)
— here Food ``c1``, Taxi ``c2``, Salary ``c3`` — and operations are ``o1..oM``
within their batch.
"""

import asyncio
import json
import uuid
from decimal import Decimal
from typing import Any

from budget_api.enums import CategoryKind
from budget_api.llm import (
    FakeProvider,
    LLMError,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    TextBlock,
    Usage,
)
from budget_api.services.categorize import (
    PROMPT_FINGERPRINTS,
    PROMPT_VERSION,
    CategorizeConfig,
    CategorizeOutcome,
    CategoryOption,
    Operation,
    categorize,
    prompt_fingerprint,
)

FOOD = CategoryOption(uuid.uuid4(), "Food", CategoryKind.expense)
TAXI = CategoryOption(uuid.uuid4(), "Taxi", CategoryKind.expense)
SALARY = CategoryOption(uuid.uuid4(), "Salary", CategoryKind.income)
CATEGORIES = [FOOD, TAXI, SALARY]

USER_ID = "11111111-1111-1111-1111-111111111111"


class StubProvider:
    """Answers canned payloads in call order; the last one repeats if needed.

    An answer is a dict (serialized as the model's JSON), a raw string (for
    deliberately unparseable output) or an exception to raise — an ``LLMError``
    for a translated provider failure, anything else for one the seam did not
    translate.
    """

    name = "stub"
    model = "stub-1"

    def __init__(self, *answers: Any, delays: tuple[float, ...] = ()) -> None:
        self._answers = answers
        self._delays = delays
        self.requests: list[LLMRequest] = []

    async def complete(self, request: LLMRequest) -> LLMResponse:
        index = len(self.requests)
        self.requests.append(request)
        if index < len(self._delays):
            await asyncio.sleep(self._delays[index])
        answer = self._answers[min(index, len(self._answers) - 1)]
        if isinstance(answer, Exception):
            raise answer
        text = answer if isinstance(answer, str) else json.dumps(answer)
        return LLMResponse(
            blocks=(TextBlock(text=text),),
            stop_reason="end_turn",
            usage=Usage(
                provider=self.name,
                model=self.model,
                input_tokens=10,
                output_tokens=5,
                cache_read_tokens=0,
                latency_ms=1,
                estimated_cost_usd=Decimal("0.000001"),
            ),
        )


def _operation(key: str, text: str, **overrides: Any) -> Operation:
    body: dict[str, Any] = {
        "amount_minor": 1234,
        "currency": "BYN",
        "country": "BY",
        "kind": CategoryKind.expense,
    }
    body.update(overrides)
    return Operation(key=key, text=text, **body)


def _config(**overrides: Any) -> CategorizeConfig:
    body: dict[str, Any] = {
        "threshold": 0.7,
        "batch_size": 20,
        "concurrency": 4,
        "time_budget_seconds": 5.0,
        "max_rows": 400,
    }
    body.update(overrides)
    return CategorizeConfig(**body)


def _answer(*rows: tuple[str, str, Any, str]) -> dict[str, Any]:
    """One canned payload: ``(operation key, category key, confidence, reason)``."""
    return {
        "results": [
            {"key": key, "category": category, "confidence": confidence, "reason": why}
            for key, category, confidence, why in rows
        ]
    }


async def _run(
    provider: LLMProvider,
    operations: list[Operation],
    *,
    config: CategorizeConfig | None = None,
    quota: Any = None,
) -> CategorizeOutcome:
    return await categorize(
        provider,
        operations,
        CATEGORIES,
        config or _config(),
        quota or (lambda _n: True),
        user_id=USER_ID,
    )


class TestFakePass:
    async def test_a_name_match_is_seeded_and_an_unmatched_row_is_flagged(self) -> None:
        outcome = await _run(
            FakeProvider("fake"),
            [
                _operation("r0", "FOOD MARKET 12 MINSK"),
                _operation("r1", "QWERTY TERMINAL 88"),
            ],
        )

        seeded = outcome.results["r0"]
        assert seeded.category_id == FOOD.id
        assert seeded.needs_review is False
        assert seeded.reason == "name match"
        unsure = outcome.results["r1"]
        assert (unsure.category_id, unsure.reason, unsure.needs_review) == (
            None,
            None,
            True,
        )
        assert outcome.aborted_reason is None
        assert len(outcome.calls) == 1

    async def test_duplicates_ride_on_one_call_and_share_the_result(self) -> None:
        operations = [
            _operation("r0", "FOOD MARKET"),
            _operation("r1", "Taxi downtown"),
            _operation("r2", "food market"),  # same text up to case → a duplicate
            _operation("r3", "FOOD MARKET", currency="USD"),  # currency is in the key
            _operation("r4", "Salary october", kind=CategoryKind.income),
        ]

        outcome = await _run(
            FakeProvider("fake"), operations, config=_config(batch_size=2)
        )

        # Three unique expense rows in batches of two, plus one income batch.
        assert len(outcome.calls) == 3
        assert set(outcome.results) == {"r0", "r1", "r2", "r3", "r4"}
        assert outcome.results["r2"] == outcome.results["r0"]
        assert outcome.results["r4"].category_id == SALARY.id

    async def test_rows_past_the_cap_are_absent_with_their_duplicates(self) -> None:
        operations = [
            _operation("r0", "FOOD MARKET"),
            _operation("r1", "Taxi downtown"),
            _operation("r2", "FOOD MARKET"),
            _operation("r3", "Salary october", kind=CategoryKind.income),
            _operation("r4", "salary october", kind=CategoryKind.income),
        ]

        outcome = await _run(
            FakeProvider("fake"), operations, config=_config(max_rows=2)
        )

        # The cap counts UNIQUE rows: r0 and r1 are the two, r2 rides along as a
        # duplicate of r0, and the income pair never gets asked about at all.
        assert set(outcome.results) == {"r0", "r1", "r2"}
        assert outcome.aborted_reason is None


class TestValidation:
    async def test_a_valid_answer_below_the_threshold_is_seeded_and_flagged(
        self,
    ) -> None:
        provider = StubProvider(_answer(("o1", "c1", 0.42, "  looks like food  ")))

        outcome = await _run(provider, [_operation("r0", "anything")])

        result = outcome.results["r0"]
        assert result.category_id == FOOD.id
        assert result.confidence == 0.42
        assert result.needs_review is True
        assert result.reason == "looks like food"

    async def test_a_category_key_nobody_offered_is_unsure(self) -> None:
        provider = StubProvider(_answer(("o1", "c99", 0.95, "invented")))

        outcome = await _run(provider, [_operation("r0", "anything")])

        assert outcome.results["r0"].category_id is None
        assert outcome.results["r0"].needs_review is True

    async def test_a_category_of_the_wrong_kind_is_unsure(self) -> None:
        # c3 is Salary, an INCOME category, answered for an expense row: the
        # schema does not even offer it, so this is the server-side backstop.
        provider = StubProvider(_answer(("o1", "c3", 0.95, "wrong kind")))

        outcome = await _run(provider, [_operation("r0", "anything")])

        assert outcome.results["r0"].category_id is None
        assert outcome.results["r0"].needs_review is True

    async def test_a_confidence_that_is_not_a_number_in_range_is_unsure(self) -> None:
        for confidence in (1.5, float("nan"), -0.1, "0.9", True, None):
            provider = StubProvider(_answer(("o1", "c1", confidence, "sure")))

            outcome = await _run(provider, [_operation("r0", "anything")])

            result = outcome.results["r0"]
            assert result.category_id is None, confidence
            assert result.confidence == 0.0, confidence
            assert result.needs_review is True, confidence

    async def test_an_operation_the_answer_skips_is_unsure(self) -> None:
        provider = StubProvider(_answer(("o1", "c1", 0.9, "food")))

        outcome = await _run(
            provider, [_operation("r0", "first"), _operation("r1", "second")]
        )

        assert outcome.results["r0"].category_id == FOOD.id
        assert outcome.results["r1"].category_id is None
        assert outcome.results["r1"].needs_review is True


class TestBudgetAndFailures:
    async def test_the_time_budget_cancels_the_unfinished_batches(self) -> None:
        provider = StubProvider(
            _answer(("o1", "c1", 0.9, "food")),
            _answer(("o1", "c2", 0.9, "taxi")),
            delays=(0.0, 5.0),
        )

        outcome = await _run(
            provider,
            [_operation("r0", "first"), _operation("r1", "second")],
            config=_config(batch_size=1, concurrency=1, time_budget_seconds=0.2),
        )

        assert set(outcome.results) == {"r0"}
        assert outcome.aborted_reason == "time_budget"
        assert len(outcome.calls) == 1

    async def test_a_quota_refusal_aborts_the_remaining_batches(self) -> None:
        provider = StubProvider(_answer(("o1", "c1", 0.9, "food")))
        granted: list[int] = []

        def quota(rows: int) -> bool:
            granted.append(rows)
            return len(granted) == 1

        outcome = await _run(
            provider,
            [_operation(f"r{i}", f"row {i}") for i in range(3)],
            config=_config(batch_size=1, concurrency=1),
            quota=quota,
        )

        assert set(outcome.results) == {"r0"}
        assert outcome.aborted_reason == "quota"
        # Asked once per batch and never again after the refusal: the second call
        # is what refuses, the third batch is not even priced.
        assert granted == [1, 1]
        assert len(provider.requests) == 1

    async def test_only_an_aborting_code_stops_the_remaining_batches(self) -> None:
        operations = [_operation(f"r{i}", f"row {i}") for i in range(3)]
        config = _config(batch_size=1, concurrency=1)

        lost_one = await _run(
            StubProvider("not json at all", _answer(("o1", "c1", 0.9, "food"))),
            operations,
            config=config,
        )
        dead = await _run(
            StubProvider(LLMError("unavailable"), _answer(("o1", "c1", 0.9, "food"))),
            operations,
            config=config,
        )

        # An unparseable answer costs its own batch only...
        assert set(lost_one.results) == {"r1", "r2"}
        assert lost_one.aborted_reason is None
        # ...while a dead provider is not asked nineteen more times.
        assert dead.results == {}
        assert dead.aborted_reason == "unavailable"

    async def test_an_exception_the_seam_did_not_translate_never_escapes(self) -> None:
        """The degradation invariant for a failure that is NOT an ``LLMError``.

        An SDK refusing a parameter, a bug in a future provider: it arrives as an
        ordinary exception, and if it escaped it would travel out of the import
        handler and answer 500 — the one thing the AI pass may never do to an
        upload. It is treated as a dead provider: the pass stops, nothing raises.
        """
        outcome = await _run(
            StubProvider(RuntimeError("boom")),
            [_operation(f"r{i}", f"row {i}") for i in range(2)],
            config=_config(batch_size=1, concurrency=1),
        )

        assert outcome.results == {}
        assert outcome.aborted_reason == "error"


class TestPromptPin:
    def test_the_prompt_fingerprint_is_pinned_to_the_version(self) -> None:
        """A prompt or schema edit without a ``PROMPT_VERSION`` bump fails here.

        The session stamp, the evals report and the replay fixtures are all keyed
        by the version, so a silent edit would leave recorded answers and accuracy
        numbers claiming to describe a prompt that no longer exists.
        """
        assert PROMPT_FINGERPRINTS[PROMPT_VERSION] == prompt_fingerprint()
