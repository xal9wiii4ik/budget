"""Anthropic provider — structured outputs over the Messages API.

Construction mirrors ``services/receipt_parser.py``: ``AsyncAnthropic`` built from
Settings values with ``max_retries=1`` (one automatic SDK retry on a retryable
error, then the failure surfaces as our own code), and the same specific-only
catch tuple. What differs is the request: this seam asks for ONE fixed JSON shape
via ``output_config`` (structured outputs, GA) instead of forcing a tool, because
a schema ``enum`` is a stronger guard than a tool description and because
``tool_choice: any`` is already refused by the newest model families.

Two details are deliberate and must not drift:

* **No ``temperature``.** The Haiku 5.5 family rejects it alongside structured
  outputs, and determinism here comes from the schema, not from sampling knobs.
* **``cache_control`` on the system block.** The instructions are identical across
  every batch of every import; marking them ephemeral is free when the text is
  under the cache minimum and starts paying the moment the prompt grows.

``http_client`` exists for tests only: ``AsyncAnthropic`` takes an
``httpx.AsyncClient`` natively, so a ``MockTransport`` can answer recorded bodies
and no test ever reaches the network.
"""

import logging
import time
from typing import Any

import anthropic
import httpx
from anthropic import AsyncAnthropic, Omit, omit
from anthropic.types import MessageParam, OutputConfigParam, TextBlockParam

from budget_api.llm.errors import LLMError
from budget_api.llm.types import (
    LLMRequest,
    LLMResponse,
    Message,
    ResponseBlock,
    TextBlock,
    TextPart,
    ToolUseBlock,
    Usage,
)
from budget_api.llm.usage import estimate_cost

logger = logging.getLogger(__name__)


class AnthropicProvider:
    """``LLMProvider`` over ``AsyncAnthropic``. Settings-only, no DB, no models."""

    name: str = "anthropic"

    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        timeout: float,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.model = model
        self._client = AsyncAnthropic(
            api_key=api_key,
            timeout=timeout,
            max_retries=1,
            http_client=http_client,
        )

    async def complete(self, request: LLMRequest) -> LLMResponse:
        if request.tools:
            # v1 declares the tool shape (llm/types.py) but implements none of it.
            raise LLMError("unsupported")

        system: list[TextBlockParam] | Omit = omit
        if request.system is not None:
            system = [
                {
                    "type": "text",
                    "text": request.system,
                    "cache_control": {"type": "ephemeral"},
                }
            ]
        output_config: OutputConfigParam | Omit = omit
        if request.output_schema is not None:
            output_config = {
                "format": {"type": "json_schema", "schema": request.output_schema}
            }

        started = time.perf_counter()
        try:
            message = await self._client.messages.create(
                model=self.model,
                max_tokens=request.max_tokens,
                system=system,
                messages=[_message_param(m) for m in request.messages],
                output_config=output_config,
            )
        except (TimeoutError, anthropic.APIError, httpx.HTTPError) as exc:
            # Specific-only catch, the receipt_parser tuple: SDK errors (incl.
            # APITimeoutError), transport errors, asyncio timeouts.
            raise self._classify(exc) from exc

        latency_ms = int((time.perf_counter() - started) * 1000)
        blocks: list[ResponseBlock] = []
        for block in message.content:
            if block.type == "text":
                blocks.append(TextBlock(text=block.text))
            elif block.type == "tool_use":
                blocks.append(
                    ToolUseBlock(id=block.id, name=block.name, input=dict(block.input))
                )
        cache_read = message.usage.cache_read_input_tokens or 0
        return LLMResponse(
            blocks=tuple(blocks),
            stop_reason=message.stop_reason or "",
            usage=Usage(
                provider=self.name,
                model=self.model,
                input_tokens=message.usage.input_tokens,
                output_tokens=message.usage.output_tokens,
                cache_read_tokens=cache_read,
                latency_ms=latency_ms,
                estimated_cost_usd=estimate_cost(
                    self.model,
                    input_tokens=message.usage.input_tokens,
                    output_tokens=message.usage.output_tokens,
                    cache_read_tokens=cache_read,
                ),
            ),
        )

    def _classify(self, exc: BaseException) -> LLMError:
        """Status → code. Everything transport-shaped degrades to ``unavailable``.

        A 4xx that is not 429 is a fact about the REQUEST (bad key, schema the API
        refuses): retrying it changes nothing, so it is the non-retryable arm and
        the only one that logs. The log carries the status and the exception CLASS
        and nothing else — the SDK's message can quote request fields, and no
        operation text may reach the log (usage.log_call has the same rule).
        """
        status = getattr(exc, "status_code", None)
        if isinstance(status, int) and 400 <= status < 500 and status != 429:
            logger.warning(
                "llm anthropic request rejected: status=%d error=%s",
                status,
                type(exc).__name__,
            )
            return LLMError("request_rejected")
        return LLMError("unavailable")


def _message_param(message: Message) -> MessageParam:
    content: list[Any] = []
    for part in message.content:
        if isinstance(part, TextPart):
            content.append({"type": "text", "text": part.text})
        else:
            content.append(
                {
                    "type": "tool_result",
                    "tool_use_id": part.tool_use_id,
                    "content": part.content,
                    "is_error": part.is_error,
                }
            )
    role = "assistant" if message.role == "assistant" else "user"
    return {"role": role, "content": content}
