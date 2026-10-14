"""The two real providers against recorded HTTP bodies, and the replay store.

Not one live call anywhere: both providers take an ``httpx.AsyncClient``
(``AsyncAnthropic`` supports it natively), so a ``MockTransport`` answers with the
bodies the APIs actually return and the request we SEND is captured and asserted.
The wire shape is the thing worth pinning — ``output_config``, the cached system
block and the absence of ``temperature`` are three details the newest model
families refuse or ignore if we get them wrong, and nothing in the suite would
notice.
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
    build_provider,
    structured,
)

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["ok"],
    "properties": {"ok": {"type": "boolean"}},
}

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


def _anthropic_body(text: str) -> dict[str, Any]:
    return {
        "id": "msg_01",
        "type": "message",
        "role": "assistant",
        "model": "claude-haiku-5-5",
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": 1431,
            "output_tokens": 388,
            "cache_read_input_tokens": 1200,
        },
    }


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
