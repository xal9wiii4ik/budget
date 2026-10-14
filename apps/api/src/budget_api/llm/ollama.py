"""Ollama provider — ``POST /api/chat`` with the schema in ``format``.

The local-model arm: no key, no cost, no network beyond the host. Ollama's own
structured-output contract is ``format: <json schema>`` plus ``stream: false``,
and ``options.temperature = 0`` is set because here the knob exists and greedy
decoding is what a categorizer wants.

An unreachable base URL is a CALL-TIME fact, never a boot failure: the provider is
constructed from Settings without touching the network, and a dead daemon degrades
to ``LLMError("unavailable")`` — the import then reads ``ai_status`` honestly
instead of refusing the upload.

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
    TextBlock,
    TextPart,
    Usage,
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
        if request.tools:
            # v1 declares the tool shape (llm/types.py) but implements none of it.
            raise LLMError("unsupported")

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": _messages(request),
            "stream": False,
            "options": {"temperature": 0},
        }
        if request.output_schema is not None:
            payload["format"] = request.output_schema

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
        input_tokens = _int_field(answer, "prompt_eval_count")
        output_tokens = _int_field(answer, "eval_count")
        # The daemon reports its own nanosecond total; it is the number an owner
        # comparing local models wants. Measured wall time is the fallback.
        reported_ms = _int_field(answer, "total_duration") // 1_000_000
        return LLMResponse(
            blocks=(TextBlock(text=text),),
            stop_reason=_stop_reason(answer),
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


def _messages(request: LLMRequest) -> list[dict[str, str]]:
    """System prompt as a leading ``system`` turn — Ollama has no system field."""
    messages: list[dict[str, str]] = []
    if request.system is not None:
        messages.append({"role": "system", "content": request.system})
    for message in request.messages:
        messages.append({"role": message.role, "content": _flatten(message)})
    return messages


def _flatten(message: Message) -> str:
    return "\n".join(
        part.text if isinstance(part, TextPart) else part.content
        for part in message.content
    )


def _message_text(body: dict[str, Any]) -> str | None:
    message: Any = body.get("message")
    if not isinstance(message, dict):
        return None
    content: Any = cast(dict[str, Any], message).get("content")
    return content if isinstance(content, str) else None


def _stop_reason(body: dict[str, Any]) -> str:
    """``done_reason`` mapped onto our vocabulary so ``truncated`` works here too."""
    reason: Any = body.get("done_reason")
    if reason == "length":
        return "max_tokens"
    return reason if isinstance(reason, str) else "stop"


def _int_field(body: dict[str, Any], key: str) -> int:
    value: Any = body.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else 0
