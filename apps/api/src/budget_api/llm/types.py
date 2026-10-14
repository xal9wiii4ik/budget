"""The provider vocabulary: one request shape, one response shape, one usage record.

Frozen dataclasses and a ``Protocol`` — deliberately **not** pydantic and
deliberately free of every app concern (``models``, ``schemas``, ``db``,
``fastapi``). The evals CLI builds these objects with no application around it,
and ``services/categorize.py`` is importable the same way.

What this vocabulary implements: text messages plus an ``output_schema``
(structured outputs, driven through :func:`budget_api.llm.structured.structured`)
AND tool use — :attr:`LLMRequest.tools`, :attr:`LLMRequest.tool_choice`,
:class:`ToolUseBlock`, :class:`ToolResultPart` — in all three providers since
``pdf-reconcile`` (the reconcile loop: "call → read the tool-use blocks → append
the tool-result parts → call again").

``ToolUseBlock`` is BOTH a response block and a :data:`ContentPart`: the
assistant's tool_use turn that a loop echoes back on its next call is the same
JSON the model produced, so there is no second type for it. Without that a loop
could not reach a second step in any provider.

What is still only declared: ``ImagePart`` — it does not exist, and the receipts
pipeline keeps its own path until it moves onto this seam.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Protocol


@dataclass(frozen=True)
class TextPart:
    """Plain text inside a message — every prompt and every data document."""

    text: str


@dataclass(frozen=True)
class ToolResultPart:
    """The answer to a ``ToolUseBlock``, carried by the next user turn."""

    tool_use_id: str
    content: str
    is_error: bool = False


@dataclass(frozen=True)
class ToolUseBlock:
    """The model calling a tool — a response block AND an assistant content part.

    Defined before :data:`ContentPart` because it is a member of it: a loop's
    second call has to echo the assistant's tool_use turn back, and that turn is
    this very block (see the module docstring).
    """

    id: str
    name: str
    input: dict[str, Any] = field(default_factory=dict[str, Any])


#: Everything a message may carry. ``ImagePart`` joins it when the receipts
#: pipeline moves onto this seam (architecture §Trade-offs).
ContentPart = TextPart | ToolResultPart | ToolUseBlock


@dataclass(frozen=True)
class Message:
    """One turn. ``role`` is ``"user"`` or ``"assistant"``."""

    role: str
    content: tuple[ContentPart, ...]


@dataclass(frozen=True)
class ToolSpec:
    """A tool the model may call. ``input_schema`` is a JSON Schema object."""

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
    #: ``None``/``"auto"`` · ``"any"`` · ``"tool:<name>"`` — the whole grammar
    #: (architecture §5). Any other spelling is ``LLMError("unsupported")``, and
    #: it is IGNORED when ``tools`` is empty (Ollama ignores it always: the API
    #: has no such knob, so the instruction lives in the prompt).
    tool_choice: str | None = None


@dataclass(frozen=True)
class TextBlock:
    """Text the model produced. Under ``output_schema`` this holds the JSON."""

    text: str


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


def tool_uses(response: LLMResponse) -> tuple[ToolUseBlock, ...]:
    """Every ``ToolUseBlock`` of the answer, in order — the loop's step input."""
    return tuple(block for block in response.blocks if isinstance(block, ToolUseBlock))


def part_json(part: ContentPart) -> dict[str, Any]:
    """A content part as plain JSON — the wire shape AND the replay-key shape."""
    if isinstance(part, TextPart):
        return {"type": "text", "text": part.text}
    if isinstance(part, ToolUseBlock):
        return {
            "type": "tool_use",
            "id": part.id,
            "name": part.name,
            "input": part.input,
        }
    return {
        "type": "tool_result",
        "tool_use_id": part.tool_use_id,
        "content": part.content,
        "is_error": part.is_error,
    }


def tool_json(spec: ToolSpec) -> dict[str, Any]:
    """A tool as plain JSON — architecture §5's canonical shape.

    ONE function for the Anthropic wire AND for the replay key, so what a fixture
    was hashed under cannot drift from what the provider sends. Ollama re-wraps
    this dict into its own ``{"type": "function", "function": {...}}`` envelope.
    """
    return {
        "name": spec.name,
        "description": spec.description,
        "input_schema": dict(spec.input_schema),
    }
