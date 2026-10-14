"""The provider vocabulary: one request shape, one response shape, one usage record.

Frozen dataclasses and a ``Protocol`` — deliberately **not** pydantic and
deliberately free of every app concern (``models``, ``schemas``, ``db``,
``fastapi``). The evals CLI builds these objects with no application around it,
and ``services/categorize.py`` is importable the same way.

What v1 implements: text messages plus an ``output_schema`` (structured outputs),
driven through :func:`budget_api.llm.structured.structured`.

What v1 only DECLARES: :attr:`LLMRequest.tools`, :attr:`LLMRequest.tool_choice`,
:class:`ToolUseBlock` and :class:`ToolResultPart`. They are the shape the later
``pdf-reconcile`` tool loop needs ("call → read the tool-use blocks → append the
tool-result parts → call again"), so declaring them now is what keeps that loop
from needing a second provider method. A v1 provider handed a non-empty ``tools``
raises ``LLMError("unsupported")`` rather than silently dropping it.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Protocol


@dataclass(frozen=True)
class TextPart:
    """Plain text inside a message — the only content part v1 ever builds."""

    text: str


@dataclass(frozen=True)
class ToolResultPart:
    """RESERVED (declared, never built in v1): the answer to a ``ToolUseBlock``."""

    tool_use_id: str
    content: str
    is_error: bool = False


#: Everything a message may carry. ``ImagePart`` joins it when the receipts
#: pipeline moves onto this seam (architecture §Trade-offs).
ContentPart = TextPart | ToolResultPart


@dataclass(frozen=True)
class Message:
    """One turn. ``role`` is ``"user"`` or ``"assistant"``."""

    role: str
    content: tuple[ContentPart, ...]


@dataclass(frozen=True)
class ToolSpec:
    """RESERVED (declared, never built in v1): a tool the model may call."""

    name: str
    description: str
    input_schema: Mapping[str, Any]


@dataclass(frozen=True)
class LLMRequest:
    """One provider call. ``output_schema`` is a JSON Schema the answer must match.

    ``max_tokens`` is part of the request rather than provider state because the
    caller sizes it from its own batch, and because the replay key hashes it: two
    differently sized batches must not collide.
    """

    system: str | None
    messages: tuple[Message, ...]
    output_schema: dict[str, Any] | None = None
    max_tokens: int = 1024
    tools: tuple[ToolSpec, ...] = ()
    tool_choice: str | None = None


@dataclass(frozen=True)
class TextBlock:
    """Text the model produced. Under ``output_schema`` this holds the JSON."""

    text: str


@dataclass(frozen=True)
class ToolUseBlock:
    """RESERVED (declared, never produced in v1): the model calling a tool."""

    id: str
    name: str
    input: dict[str, Any] = field(default_factory=dict[str, Any])


ResponseBlock = TextBlock | ToolUseBlock


@dataclass(frozen=True)
class Usage:
    """What one call cost. NOT ledger money — ``Decimal`` only to keep logs clean.

    ``estimated_cost_usd`` is ``None`` for a model with no published price in
    ``usage.PRICES_USD_PER_MTOK`` (never ``0``: zero is Ollama's honest number).
    """

    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    latency_ms: int
    estimated_cost_usd: Decimal | None


@dataclass(frozen=True)
class LLMResponse:
    """``stop_reason`` is the provider's own string; ``"max_tokens"`` means cut off."""

    blocks: tuple[ResponseBlock, ...]
    stop_reason: str
    usage: Usage


class LLMProvider(Protocol):
    """Every provider, real or fake, is exactly this.

    ``name`` and ``model`` are attributes rather than methods because they are
    stamped onto the import session, into the log line and into the replay key —
    all three read them without making a call.
    """

    name: str
    model: str

    async def complete(self, request: LLMRequest) -> LLMResponse: ...


def text_of(response: LLMResponse) -> str | None:
    """The first ``TextBlock``'s text, or ``None`` if the answer carries none."""
    return next(
        (block.text for block in response.blocks if isinstance(block, TextBlock)), None
    )


def part_json(part: ContentPart) -> dict[str, Any]:
    """A content part as plain JSON — the wire shape AND the replay-key shape."""
    if isinstance(part, TextPart):
        return {"type": "text", "text": part.text}
    return {
        "type": "tool_result",
        "tool_use_id": part.tool_use_id,
        "content": part.content,
        "is_error": part.is_error,
    }
