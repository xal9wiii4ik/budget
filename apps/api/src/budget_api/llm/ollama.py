"""Ollama provider — ``POST /api/chat`` with the schema in ``format``.

The local-model arm: no key, no cost, no network beyond the host. Ollama's own
structured-output contract is ``format: <json schema>`` plus ``stream: false``,
and ``options.temperature = 0`` is set because here the knob exists and greedy
decoding is what a categorizer wants.

An unreachable base URL is a CALL-TIME fact, never a boot failure: the provider is
constructed from Settings without touching the network, and a dead daemon degrades
to ``LLMError("unavailable")`` — the import then reads ``ai_status`` honestly
instead of refusing the upload.

Tool use, three deliberate differences from Anthropic:

* ``tool_choice`` is SILENTLY IGNORED — the ``/api/chat`` API has no such field,
  so the "end with the terminal tool" instruction lives in the prompt. Refusing
  with ``unsupported`` would make the loop unrunnable here for no gain.
* Ollama's tool calls carry NO id. We synthesize ``ollama-<i>``, deterministic
  per response: what keys a replay fixture is the NEXT request's
  ``ToolResultPart``, so a random id would make every recorded loop unreplayable.
* A tool result goes out as its own ``{"role": "tool"}`` message (there is no
  ``tool_use_id`` to correlate), and an assistant turn carrying tool calls goes
  out as ``{"role": "assistant", "tool_calls": [...]}``.

No persistent ``httpx.AsyncClient`` is held: this provider has no lifecycle hook to
close one, and a per-call client against localhost costs nothing measurable. Tests
pass their own client (``http_client``) carrying a ``MockTransport``.
"""

import time
from decimal import Decimal
from typing import Any, cast

import httpx

from budget_api.llm.errors import LLMError
from budget_api.llm.types import (
    LLMRequest,
    LLMResponse,
    Message,
    ResponseBlock,
    TextBlock,
    TextPart,
    ToolResultPart,
    ToolSpec,
    ToolUseBlock,
    Usage,
    tool_json,
)


class OllamaProvider:
    """``LLMProvider`` over a local Ollama daemon. Settings-only, no DB, no models."""

    name: str = "ollama"

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        timeout: float,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.model = model
        self._url = f"{base_url.rstrip('/')}/api/chat"
        self._timeout = timeout
        self._http_client = http_client

    async def complete(self, request: LLMRequest) -> LLMResponse:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": _messages(request),
            "stream": False,
            "options": {"temperature": 0},
        }
        if request.output_schema is not None:
            payload["format"] = request.output_schema
        if request.tools:
            payload["tools"] = [_tool_payload(spec) for spec in request.tools]

        started = time.perf_counter()
        try:
            if self._http_client is not None:
                response = await self._http_client.post(self._url, json=payload)
            else:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    response = await client.post(self._url, json=payload)
            response.raise_for_status()
            body: Any = response.json()
        except (TimeoutError, httpx.HTTPError) as exc:
            # httpx.HTTPStatusError (>= 400 from raise_for_status), ConnectError and
            # the timeouts all land here: one degradation, never a boot failure.
            raise LLMError("unavailable") from exc
        except ValueError as exc:
            # A 200 whose body is not JSON — the daemon answered, just not with an
            # answer, so this is the caller's "lost that batch" arm.
            raise LLMError("invalid_output") from exc

        measured_ms = int((time.perf_counter() - started) * 1000)
        if not isinstance(body, dict):
            raise LLMError("invalid_output")
        answer = cast(dict[str, Any], body)
        text = _message_text(answer)
        if text is None:
            raise LLMError("invalid_output")
        uses = _tool_uses(answer)
        blocks: list[ResponseBlock] = []
        # An empty text block is kept when there is nothing else in the answer:
        # that is the old (structured-output) shape, where the caller's
        # ``invalid_output`` comes from parsing, not from here.
        if text or not uses:
            blocks.append(TextBlock(text=text))
        blocks.extend(uses)
        # A cut-off answer stays ``max_tokens`` even next to tool calls: the loop
        # has to see a truncation, and a half-written call is not a usable step.
        reported_stop = _stop_reason(answer)
        stop_reason = (
            "tool_use" if uses and reported_stop != "max_tokens" else reported_stop
        )
        input_tokens = _int_field(answer, "prompt_eval_count")
        output_tokens = _int_field(answer, "eval_count")
        # The daemon reports its own nanosecond total; it is the number an owner
        # comparing local models wants. Measured wall time is the fallback.
        reported_ms = _int_field(answer, "total_duration") // 1_000_000
        return LLMResponse(
            blocks=tuple(blocks),
            stop_reason=stop_reason,
            usage=Usage(
                provider=self.name,
                model=self.model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_read_tokens=0,
                latency_ms=reported_ms or measured_ms,
                # Local inference costs no USD. Zero here is a FACT, which is why
                # an unpriced hosted model reads None instead (usage.estimate_cost).
                estimated_cost_usd=Decimal(0),
            ),
        )


def _tool_payload(spec: ToolSpec) -> dict[str, Any]:
    """``tool_json``'s canonical dict re-wrapped into Ollama's function envelope."""
    canonical = tool_json(spec)
    return {
        "type": "function",
        "function": {
            "name": canonical["name"],
            "description": canonical["description"],
            "parameters": canonical["input_schema"],
        },
    }


def _messages(request: LLMRequest) -> list[dict[str, Any]]:
    """System prompt as a leading ``system`` turn — Ollama has no system field."""
    messages: list[dict[str, Any]] = []
    if request.system is not None:
        messages.append({"role": "system", "content": request.system})
    for message in request.messages:
        messages.extend(_message_payloads(message))
    return messages


def _message_payloads(message: Message) -> list[dict[str, Any]]:
    """One turn → one or more Ollama messages.

    A turn carrying tool RESULTS becomes one ``{"role": "tool"}`` message per
    result; a turn carrying tool CALLS becomes an assistant message with
    ``tool_calls``. A plain text turn is unchanged, which is what keeps every
    categorize call on the wire byte-identical.
    """
    uses = [part for part in message.content if isinstance(part, ToolUseBlock)]
    results = [part for part in message.content if isinstance(part, ToolResultPart)]
    text = "\n".join(
        part.text for part in message.content if isinstance(part, TextPart)
    )
    payloads: list[dict[str, Any]] = []
    if uses:
        payloads.append(
            {
                "role": "assistant",
                "content": text,
                "tool_calls": [
                    {"function": {"name": use.name, "arguments": use.input}}
                    for use in uses
                ],
            }
        )
    elif text or not results:
        payloads.append({"role": message.role, "content": text})
    payloads.extend({"role": "tool", "content": part.content} for part in results)
    return payloads


def _message_text(body: dict[str, Any]) -> str | None:
    message: Any = body.get("message")
    if not isinstance(message, dict):
        return None
    content: Any = cast(dict[str, Any], message).get("content")
    return content if isinstance(content, str) else None


def _tool_uses(body: dict[str, Any]) -> list[ToolUseBlock]:
    """``message.tool_calls`` → blocks with synthesized, positional ids.

    ``arguments`` that is not an object is a model failure we cannot repair:
    the loop would have to answer a call whose input it cannot read.
    """
    message: Any = body.get("message")
    if not isinstance(message, dict):
        return []
    calls: Any = cast(dict[str, Any], message).get("tool_calls")
    if not isinstance(calls, list):
        return []
    uses: list[ToolUseBlock] = []
    for index, call in enumerate(cast(list[Any], calls)):
        if not isinstance(call, dict):
            raise LLMError("invalid_output")
        function: Any = cast(dict[str, Any], call).get("function")
        if not isinstance(function, dict):
            raise LLMError("invalid_output")
        body_of = cast(dict[str, Any], function)
        name: Any = body_of.get("name")
        arguments: Any = body_of.get("arguments")
        if not isinstance(name, str) or not isinstance(arguments, dict):
            raise LLMError("invalid_output")
        uses.append(
            ToolUseBlock(
                id=f"ollama-{index}",
                name=name,
                input=cast(dict[str, Any], arguments),
            )
        )
    return uses


def _stop_reason(body: dict[str, Any]) -> str:
    """``done_reason`` mapped onto our vocabulary so ``truncated`` works here too."""
    reason: Any = body.get("done_reason")
    if reason == "length":
        return "max_tokens"
    return reason if isinstance(reason, str) else "stop"


def _int_field(body: dict[str, Any], key: str) -> int:
    value: Any = body.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else 0
