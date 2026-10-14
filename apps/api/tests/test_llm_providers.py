"""The two real providers against recorded HTTP bodies, and the replay store.

Not one live call anywhere: both providers take an ``httpx.AsyncClient``
(``AsyncAnthropic`` supports it natively), so a ``MockTransport`` answers with the
bodies the APIs actually return and the request we SEND is captured and asserted.
The wire shape is the thing worth pinning — ``output_config``, the cached system
block and the absence of ``temperature`` are three details the newest model
families refuse or ignore if we get them wrong, and nothing in the suite would
notice.

Tool use (pdf-reconcile) is pinned the same way, plus the two halves no HTTP
assertion can see: the replay key of a tool-LESS call must not move (every
committed categorize fixture depends on it) and a recorded ``tool_use`` answer
must come back out of the store intact.
"""

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest

from budget_api.llm import (
    AnthropicProvider,
    FakeProvider,
    LLMError,
    LLMRequest,
    Message,
    OllamaProvider,
    TextBlock,
    TextPart,
    ToolResultPart,
    ToolSpec,
    ToolUseBlock,
    build_provider,
    request_key,
    structured,
    text_of,
    tool_uses,
)

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["ok"],
    "properties": {"ok": {"type": "boolean"}},
}

_NO_ARGS: dict[str, Any] = {
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}

#: The reconcile loop's first two tools, as ``services/reconcile.py`` declares
#: them (D-R2). Two of them, because one tool cannot show the ORDER of the array.
TOOLS = (
    ToolSpec(
        name="list_unmatched_statement_rows",
        description="The statement rows the matcher could not settle.",
        input_schema=_NO_ARGS,
    ),
    ToolSpec(
        name="list_unmatched_app_transactions",
        description="The app transactions no statement row claimed.",
        input_schema=_NO_ARGS,
    ),
)

#: The reconcile data document: METADATA only, the lists arrive through tools.
RECONCILE_DOCUMENT = json.dumps(
    {
        "reconcile": {
            "period": ["2026-09-01", "2026-09-30"],
            "currency": "BYN",
            "settled_exact": 2,
            "open_rows": 2,
            "open_transactions": 1,
        }
    }
)

#: The categorize data document, in miniature: the fake provider answers this
#: layout and nothing else.
DOCUMENT = json.dumps(
    {
        "categories": [{"key": "c1", "name": "Food", "kind": "expense"}],
        "operations": [
            {
                "key": "o1",
                "text": "FOOD MARKET",
                "amount": 1234,
                "currency": "BYN",
                "country": "BY",
                "kind": "expense",
            }
        ],
    }
)


def _request(text: str = DOCUMENT, max_tokens: int = 512) -> LLMRequest:
    return LLMRequest(
        system="be brief",
        messages=(Message(role="user", content=(TextPart(text),)),),
        max_tokens=max_tokens,
    )


def _anthropic_body(
    text: str,
    *,
    content: list[dict[str, Any]] | None = None,
    stop_reason: str = "end_turn",
) -> dict[str, Any]:
    return {
        "id": "msg_01",
        "type": "message",
        "role": "assistant",
        "model": "claude-haiku-5-5",
        "content": content or [{"type": "text", "text": text}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": 1431,
            "output_tokens": 388,
            "cache_read_input_tokens": 1200,
        },
    }


def _tool_request(*messages: Message, tool_choice: str | None = "auto") -> LLMRequest:
    return LLMRequest(
        system="be brief",
        messages=messages,
        max_tokens=512,
        tools=TOOLS,
        tool_choice=tool_choice,
    )


#: What the two list tools answer with — the shape the fake reads back (the first
#: list of objects in the payload, each identified by ``key``).
ROWS_RESULT = json.dumps(
    {"rows": [{"key": "r1", "description": "BOOKSTORE"}, {"key": "r2"}]}
)
TXS_RESULT = json.dumps({"transactions": [{"key": "t1", "merchant": "GYM"}]})


def _scripted_messages(results: int, *, rows: str = ROWS_RESULT) -> tuple[Message, ...]:
    """The conversation a reconcile loop holds after ``results`` tool results."""
    messages: list[Message] = [
        Message(role="user", content=(TextPart(RECONCILE_DOCUMENT),))
    ]
    answers = (rows, TXS_RESULT)
    for index in range(results):
        tool_use_id = f"fake-{index + 1}"
        messages.append(
            Message(
                role="assistant",
                content=(ToolUseBlock(id=tool_use_id, name=TOOLS[index].name),),
            )
        )
        messages.append(
            Message(
                role="user",
                content=(
                    ToolResultPart(tool_use_id=tool_use_id, content=answers[index]),
                ),
            )
        )
    return tuple(messages)


class TestOllama:
    async def test_a_chat_answer_becomes_one_text_block_with_usage(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(
                200,
                json={
                    "message": {"role": "assistant", "content": '{"ok": true}'},
                    "done_reason": "stop",
                    "prompt_eval_count": 31,
                    "eval_count": 12,
                    "total_duration": 1_500_000_000,
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = OllamaProvider(
                model="llama3.1",
                base_url="http://localhost:11434/",
                timeout=5,
                http_client=client,
            )
            payload, usage = await structured(provider, _request(), SCHEMA)

        assert payload == {"ok": True}
        assert (usage.input_tokens, usage.output_tokens) == (31, 12)
        assert usage.latency_ms == 1500
        # Local inference is free, and zero here is a FACT, not a missing price.
        assert usage.estimated_cost_usd == Decimal(0)

        sent: dict[str, Any] = json.loads(seen[0].content)
        assert str(seen[0].url) == "http://localhost:11434/api/chat"
        assert sent["format"] == SCHEMA
        assert sent["stream"] is False
        assert sent["options"] == {"temperature": 0}
        assert sent["messages"][0] == {"role": "system", "content": "be brief"}

    async def test_tool_calls_get_positional_ids_and_the_echo_splits_in_two(
        self,
    ) -> None:
        """Ollama's two differences from Anthropic, in one round trip.

        Out: an assistant turn with ``tool_calls`` and a SEPARATE
        ``{"role": "tool"}`` message per result (there is no ``tool_use_id`` to
        correlate). In: calls with no id of their own, so we synthesize
        ``ollama-<i>`` — deterministic, because the next request's tool results
        are what key a recorded loop in the replay store.
        """
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(
                200,
                json={
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "function": {
                                    "name": "list_unmatched_statement_rows",
                                    "arguments": {},
                                }
                            },
                            {
                                "function": {
                                    "name": "list_unmatched_app_transactions",
                                    "arguments": {"since": "2026-09-01"},
                                }
                            },
                        ],
                    },
                    "done_reason": "stop",
                    "prompt_eval_count": 31,
                    "eval_count": 12,
                },
            )

        call = ToolUseBlock(id="ollama-0", name="list_unmatched_statement_rows")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = OllamaProvider(
                model="llama3.1",
                base_url="http://localhost:11434",
                timeout=5,
                http_client=client,
            )
            response = await provider.complete(
                _tool_request(
                    Message(role="user", content=(TextPart(RECONCILE_DOCUMENT),)),
                    Message(role="assistant", content=(call,)),
                    Message(
                        role="user",
                        content=(
                            ToolResultPart(
                                tool_use_id="ollama-0", content='{"rows": []}'
                            ),
                        ),
                    ),
                )
            )

        assert response.stop_reason == "tool_use"
        assert tool_uses(response) == (
            ToolUseBlock(id="ollama-0", name="list_unmatched_statement_rows", input={}),
            ToolUseBlock(
                id="ollama-1",
                name="list_unmatched_app_transactions",
                input={"since": "2026-09-01"},
            ),
        )

        sent: dict[str, Any] = json.loads(seen[0].content)
        assert sent["tools"] == [
            {
                "type": "function",
                "function": {
                    "name": "list_unmatched_statement_rows",
                    "description": "The statement rows the matcher could not settle.",
                    "parameters": _NO_ARGS,
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "list_unmatched_app_transactions",
                    "description": "The app transactions no statement row claimed.",
                    "parameters": _NO_ARGS,
                },
            },
        ]
        assert sent["messages"][2] == {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"function": {"name": "list_unmatched_statement_rows", "arguments": {}}}
            ],
        }
        assert sent["messages"][3] == {"role": "tool", "content": '{"rows": []}'}

    async def test_an_unreachable_daemon_degrades_to_unavailable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = OllamaProvider(
                model="llama3.1",
                base_url="http://localhost:11434",
                timeout=5,
                http_client=client,
            )
            with pytest.raises(LLMError) as caught:
                await structured(provider, _request(), SCHEMA)

        assert caught.value.code == "unavailable"
        assert caught.value.retryable is True


class TestAnthropic:
    async def test_the_request_carries_the_schema_and_no_temperature(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=_anthropic_body('{"ok": true}'))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = AnthropicProvider(
                model="claude-haiku-5-5",
                api_key="test-key",
                timeout=5,
                http_client=client,
            )
            payload, usage = await structured(provider, _request(), SCHEMA)

        assert payload == {"ok": True}
        assert usage.cache_read_tokens == 1200
        # Priced model: 1431 in + 1200 cache-read at 0.1x + 388 out, Haiku 5.5.
        assert usage.estimated_cost_usd == Decimal("0.000349")

        sent: dict[str, Any] = json.loads(seen[0].content)
        assert sent["output_config"] == {
            "format": {"type": "json_schema", "schema": SCHEMA}
        }
        assert sent["system"] == [
            {
                "type": "text",
                "text": "be brief",
                "cache_control": {"type": "ephemeral"},
            }
        ]
        assert "temperature" not in sent
        assert sent["max_tokens"] == 512
        # A tool-LESS call must carry neither key: an empty ``tools`` array is
        # refused by the newest families, and a stray ``tool_choice`` would move
        # every committed replay key (D-L1).
        assert "tools" not in sent
        assert "tool_choice" not in sent

    async def test_tools_go_out_canonically_and_a_tool_use_block_comes_back(
        self,
    ) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(
                200,
                json=_anthropic_body(
                    "",
                    content=[
                        {"type": "text", "text": "let me look at the rows"},
                        {
                            "type": "tool_use",
                            "id": "toolu_01",
                            "name": "list_unmatched_statement_rows",
                            "input": {},
                        },
                    ],
                    stop_reason="tool_use",
                ),
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = AnthropicProvider(
                model="claude-haiku-5-5",
                api_key="test-key",
                timeout=5,
                http_client=client,
            )
            response = await provider.complete(
                _tool_request(
                    Message(role="user", content=(TextPart(RECONCILE_DOCUMENT),))
                )
            )

        sent: dict[str, Any] = json.loads(seen[0].content)
        assert sent["tools"] == [
            {
                "name": "list_unmatched_statement_rows",
                "description": "The statement rows the matcher could not settle.",
                "input_schema": _NO_ARGS,
            },
            {
                "name": "list_unmatched_app_transactions",
                "description": "The app transactions no statement row claimed.",
                "input_schema": _NO_ARGS,
            },
        ]
        # The OBJECT form, not the string we take from the caller.
        assert sent["tool_choice"] == {"type": "auto"}
        assert response.stop_reason == "tool_use"
        assert tool_uses(response) == (
            ToolUseBlock(id="toolu_01", name="list_unmatched_statement_rows", input={}),
        )
        assert text_of(response) == "let me look at the rows"

    async def test_the_second_step_echoes_the_tool_use_turn_and_its_result(
        self,
    ) -> None:
        """The FLAG-3 guard: without a ``tool_use`` content arm no loop continues.

        An assistant turn carrying a tool call and the user turn carrying its
        result are what every step after the first sends; a provider that can
        only serialize text silently truncates the conversation to step one.
        """
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=_anthropic_body('{"ok": true}'))

        call = ToolUseBlock(
            id="toolu_01", name="list_unmatched_statement_rows", input={"page": 1}
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = AnthropicProvider(
                model="claude-haiku-5-5",
                api_key="test-key",
                timeout=5,
                http_client=client,
            )
            await provider.complete(
                _tool_request(
                    Message(role="user", content=(TextPart(RECONCILE_DOCUMENT),)),
                    Message(role="assistant", content=(call,)),
                    Message(
                        role="user",
                        content=(
                            ToolResultPart(
                                tool_use_id="toolu_01", content='{"rows": []}'
                            ),
                        ),
                    ),
                )
            )

        sent: dict[str, Any] = json.loads(seen[0].content)
        assert sent["messages"][1] == {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_01",
                    "name": "list_unmatched_statement_rows",
                    "input": {"page": 1},
                }
            ],
        }
        assert sent["messages"][2] == {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_01",
                    "content": '{"rows": []}',
                    "is_error": False,
                }
            ],
        }

    async def test_a_rate_limit_degrades_to_unavailable_after_one_sdk_retry(
        self,
    ) -> None:
        attempts: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(request)
            return httpx.Response(429, json={"type": "error", "error": {}})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = AnthropicProvider(
                model="claude-haiku-5-5",
                api_key="test-key",
                timeout=5,
                http_client=client,
            )
            with pytest.raises(LLMError) as caught:
                await structured(provider, _request(), SCHEMA)

        assert caught.value.code == "unavailable"
        # max_retries=1 (the receipt_parser contract): one retry, then degrade.
        assert len(attempts) == 2

    async def test_a_refused_request_is_not_retried_and_not_retryable(self) -> None:
        attempts: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(request)
            return httpx.Response(
                400, json={"type": "error", "error": {"message": "bad schema"}}
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = AnthropicProvider(
                model="claude-haiku-5-5",
                api_key="test-key",
                timeout=5,
                http_client=client,
            )
            with pytest.raises(LLMError) as caught:
                await structured(provider, _request(), SCHEMA)

        assert caught.value.code == "request_rejected"
        assert caught.value.retryable is False
        assert len(attempts) == 1


class TestReplayStore:
    async def test_a_recorded_answer_replays_byte_for_byte(
        self, tmp_path: Path
    ) -> None:
        store = tmp_path / "fake-fake-categorize-v1.jsonl"
        recorder = FakeProvider("record", store_path=store, inner=FakeProvider("fake"))
        request = _request()

        recorded = await recorder.complete(request)
        replayed = await FakeProvider("replay", store_path=store).complete(request)

        assert isinstance(recorded.blocks[0], TextBlock)
        assert replayed.blocks == recorded.blocks
        assert replayed.stop_reason == recorded.stop_reason
        assert replayed.usage.estimated_cost_usd == recorded.usage.estimated_cost_usd

    async def test_a_real_providers_fixture_replays_under_its_own_name(
        self, tmp_path: Path
    ) -> None:
        """The round trip the evals CI actually promises: record real, replay free.

        The replay key carries the provider and the model, so the lookup has to
        be told the pair the recorder wrote under. A replay provider that calls
        itself ``fake`` finds nothing an ``anthropic`` run recorded — which only
        a round trip through ``build_provider`` with a differently named inner
        can show (a fake recording a fake agrees with itself either way).
        """
        store = tmp_path / "anthropic-claude-haiku-5-5-categorize-v1.jsonl"
        inner = FakeProvider("fake", name="anthropic", model="claude-haiku-5-5")
        recorder = FakeProvider("record", store_path=store, inner=inner)
        request = _request()
        recorded = await recorder.complete(request)

        replay = build_provider(
            "anthropic",
            "claude-haiku-5-5",
            ollama_base_url="http://localhost:11434",
            timeout=1.0,
            replay_path=str(store),
            mode="replay",
        )

        assert replay is not None
        replayed = await replay.complete(request)
        assert replayed.blocks == recorded.blocks
        assert replayed.usage.model == "claude-haiku-5-5"

    def test_a_tool_less_request_still_hashes_to_its_pre_tool_use_key(self) -> None:
        """D-L1: the key of a tool-less call is FROZEN, tools only add to it.

        The literal is the hash this exact request had before ``tools`` and
        ``tool_choice`` could join the canonical document. Every committed
        fixture — ``evals/replay/fake-fake-categorize-v1.jsonl`` above all —
        is keyed that way, so a canonical-shape change would invalidate the lot
        at once; this literal fails first and says why.
        """
        tool_less = _request()

        assert (
            request_key("fake", "fake", tool_less)
            == "8bc9bf1f502e775ffcea9a1a895245272a0a782723ed63b97da1e39e010e866b"
        )
        # …and a call that DOES carry tools must not collide with it: the loop's
        # steps differ from each other only by their tools and their results.
        with_tools = _tool_request(*tool_less.messages)
        assert request_key("fake", "fake", with_tools) != request_key(
            "fake", "fake", tool_less
        )

    async def test_a_recorded_tool_call_replays_with_its_input_intact(
        self, tmp_path: Path
    ) -> None:
        """The latent bug: ``_response_json`` used to keep TEXT blocks only.

        A loop's first recorded step carries nothing BUT a ``tool_use`` block, so
        the old store replayed it as an empty answer — a recorded reconciliation
        could never be replayed, and the evals would have scored the silence.
        """
        store = tmp_path / "fake-fake-reconcile-v1.jsonl"
        # The step whose answer carries a non-empty input: the terminal call.
        request = _tool_request(*_scripted_messages(2))
        recorder = FakeProvider("record", store_path=store, inner=FakeProvider("fake"))

        recorded = await recorder.complete(request)
        replayed = await FakeProvider("replay", store_path=store).complete(request)

        assert replayed.blocks == recorded.blocks
        assert replayed.stop_reason == recorded.stop_reason == "tool_use"
        call = tool_uses(replayed)[0]
        assert call.name == "report_discrepancies"
        assert call.input == tool_uses(recorded)[0].input
        assert call.input["items"][0]["row_id"] == "r1"

    async def test_a_request_the_store_never_saw_fails_loudly(
        self, tmp_path: Path
    ) -> None:
        store = tmp_path / "fake-fake-categorize-v1.jsonl"
        recorder = FakeProvider("record", store_path=store, inner=FakeProvider("fake"))
        await recorder.complete(_request())

        # Same document, a different token budget: the key covers the WHOLE call,
        # so an edit to the prompt or the schema must miss rather than pass.
        with pytest.raises(LLMError) as caught:
            await FakeProvider("replay", store_path=store).complete(
                _request(max_tokens=1024)
            )

        assert caught.value.code == "replay_miss"


class TestFakeScriptedArms:
    """The fake's two new prompt layouts — the whole flow on a QA stand.

    Neither arm is an oracle (grooming ruling R3): the reconcile script reports
    EVERY open item, and the extract arm is a regex over a known layout. What
    they buy is a deterministic provider the import and the reconcile loop can be
    driven against with no key and no network.
    """

    async def test_the_reconcile_script_lists_both_sides_then_reports(self) -> None:
        provider = FakeProvider("fake")
        messages: list[Message] = [
            Message(role="user", content=(TextPart(RECONCILE_DOCUMENT),))
        ]
        answers = (ROWS_RESULT, TXS_RESULT)
        called: list[ToolUseBlock] = []

        for step in range(3):
            response = await provider.complete(
                LLMRequest(
                    system="reconcile",
                    messages=tuple(messages),
                    tools=TOOLS,
                    tool_choice="auto",
                )
            )
            assert response.stop_reason == "tool_use"
            call = tool_uses(response)[0]
            called.append(call)
            if step == 2:
                break
            messages.append(Message(role="assistant", content=(call,)))
            messages.append(
                Message(
                    role="user",
                    content=(
                        ToolResultPart(tool_use_id=call.id, content=answers[step]),
                    ),
                )
            )

        assert [call.name for call in called] == [
            "list_unmatched_statement_rows",
            "list_unmatched_app_transactions",
            "report_discrepancies",
        ]
        terminal = called[-1].input
        assert [
            (item["kind"], item["row_id"], item["transaction_id"])
            for item in terminal["items"]
        ] == [
            ("missing_in_app", "r1", None),
            ("missing_in_app", "r2", None),
            ("extra_in_app", None, "t1"),
        ]
        # Every item must carry an explanation: the server drops an empty one.
        assert all(item["explanation"] for item in terminal["items"])
        assert terminal["summary"]

    async def test_the_fail_marker_is_found_in_a_tool_result_too(self) -> None:
        """A QA row described ``LLMFAIL`` must fail the step that CARRIES it.

        In a loop the row descriptions arrive in a tool result, never in the
        prompt the first call sends — a prompt-only scan would never fire.
        """
        poisoned = json.dumps({"rows": [{"key": "r1", "description": "LLMFAIL cafe"}]})

        with pytest.raises(LLMError) as caught:
            await FakeProvider("fake").complete(
                _tool_request(*_scripted_messages(1, rows=poisoned))
            )

        assert caught.value.code == "unavailable"

    async def test_the_extract_arm_answers_the_alfa_line_layout(self) -> None:
        document = json.dumps(
            {
                "currency": "BYN",
                "lines": [
                    {
                        "key": "l1",
                        "text": (
                            "03.09.2026 12345678 MINSK Покупка товара / получение "
                            "услуг OZ.by -39.9 BYN -1200 RUB"
                        ),
                    },
                    {
                        "key": "l2",
                        "text": "04.09.2026 Зачисление зарплаты 1500 BYN 1500 BYN",
                    },
                    {
                        "key": "l3",
                        "text": "05.09.2026 a line the layout does not cover",
                    },
                ],
            }
        )

        response = await FakeProvider("fake").complete(
            LLMRequest(
                system="extract",
                messages=(Message(role="user", content=(TextPart(document),)),),
            )
        )

        payload: Any = json.loads(text_of(response) or "")
        # ``l3`` is UNANSWERED on purpose: the extractor refuses a statement with
        # a hole, and a fake that invented a row would hide that refusal.
        assert payload["rows"] == [
            {
                "key": "l1",
                "date": "03.09.2026",
                "amount": "-39.9",
                "currency": "BYN",
                "original_amount": "-1200",
                "original_currency": "RUB",
                "merchant": "OZ.by",
            },
            {
                "key": "l2",
                "date": "04.09.2026",
                "amount": "1500",
                "currency": "BYN",
                "original_amount": "1500",
                "original_currency": "BYN",
                "merchant": None,
            },
        ]
