"""Anthropic receipt-parse seam — forced tool-use over one image (architecture D10).

Stateless and Settings-only: imports **no** ``models`` and touches **no** database
(D13 layering — the services-layer precedent, same as storage.py). A ``ReceiptParser``
is constructed once per app onto ``app.state.receipt_parser`` and the pytest layer
swaps a fake at that seam, so no test ever makes a live Anthropic call.

The 503 ``AI_NOT_CONFIGURED`` gate lives in the HANDLER (empty key), never here, so
an unconfigured key fails fast in-request rather than as a background failure (D10).

Failure taxonomy (exactly these codes; ``DOWNLOAD_FAILED`` is written by the task,
not raised here):

* model calls ``reject_image`` → ``NOT_A_RECEIPT`` / ``UNREADABLE_IMAGE``
* ``record_receipt`` input fails ``ParsedReceipt`` validation → ``INVALID_MODEL_OUTPUT``
* SDK/network/timeout, or a response carrying no tool block → ``ANTHROPIC_ERROR``
"""

import base64
import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast

import anthropic
import httpx
from anthropic import AsyncAnthropic
from pydantic import ValidationError

from budget_api.config import Settings
from budget_api.schemas.receipt import ParsedReceipt

logger = logging.getLogger(__name__)

_MAX_TOKENS = 2048

# Forced tool-use JSON contract (D10). ``tool_choice={"type": "any"}`` makes the
# model pick exactly one of these two tools every time.
RECORD_RECEIPT: dict[str, Any] = {
    "name": "record_receipt",
    "description": "Record the parsed contents of a receipt image.",
    "input_schema": {
        "type": "object",
        "properties": {
            "total": {
                "type": "string",
                "description": "grand total exactly as printed, e.g. '1234.56'",
            },
            "currency": {
                "type": ["string", "null"],
                "description": "3-letter ISO code (uppercase) or null",
            },
            "merchant": {"type": ["string", "null"]},
            "date": {
                "type": ["string", "null"],
                "description": "YYYY-MM-DD or null",
            },
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "amount": {"type": ["string", "null"]},
                    },
                    "required": ["name"],
                },
            },
            "suggested_category_id": {
                "type": ["string", "null"],
                "description": "the id of ONE category from the provided list, or null",
            },
        },
        "required": ["total", "items"],
    },
}

REJECT_IMAGE: dict[str, Any] = {
    "name": "reject_image",
    "description": "Use when the image is not a readable receipt.",
    "input_schema": {
        "type": "object",
        "properties": {
            "reason": {"type": "string", "enum": ["not_a_receipt", "unreadable"]}
        },
        "required": ["reason"],
    },
}

# Hand-built tool dicts match the Messages API wire shape but not the SDK's strict
# ToolUnionParam TypedDicts (the type-array ``["string", "null"]`` fields), so the
# list is typed Any at the boundary rather than fought field-by-field.
_TOOLS: list[Any] = [RECORD_RECEIPT, REJECT_IMAGE]


@dataclass(frozen=True)
class CategoryOption:
    """A category the model may pick as ``suggested_category_id``.

    Built from the user's visible, non-archived categories (AM-4). The same list is
    both injected into the prompt and used as the ``visible_ids`` membership set for
    suggestion resolution, so an archived/foreign id can never round-trip.
    """

    id: uuid.UUID
    name: str
    kind: str


class ReceiptParseError(Exception):
    """Carries one of the failure-taxonomy codes (see module docstring)."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _build_prompt(categories: Sequence[CategoryOption]) -> str:
    lines = "\n".join(f"- {c.id} | {c.name} | {c.kind}" for c in categories)
    return (
        "Extract the contents of this receipt image using the record_receipt tool. "
        "If the image is not a readable receipt, use the reject_image tool instead.\n\n"
        "Available categories (id | name | kind):\n"
        f"{lines or '(none)'}\n\n"
        "For suggested_category_id, pick the single best-matching category id from "
        "the list above, or null if none fits."
    )


class ReceiptParser:
    """Presign-free Anthropic facade. Constructed from Settings, no DB, no models."""

    def __init__(self, settings: Settings) -> None:
        self._model = settings.anthropic_model
        # max_retries=1: one automatic SDK retry on a retryable error, then surface
        # as ANTHROPIC_ERROR (the task marks the receipt failed; the client re-parses).
        self._client = AsyncAnthropic(
            api_key=settings.anthropic_api_key,
            timeout=settings.receipt_parse_timeout_seconds,
            max_retries=1,
        )

    async def parse(
        self, image_jpeg: bytes, categories: Sequence[CategoryOption]
    ) -> ParsedReceipt:
        image_b64 = base64.standard_b64encode(image_jpeg).decode("ascii")
        try:
            message = await self._client.messages.create(
                model=self._model,
                max_tokens=_MAX_TOKENS,
                tools=_TOOLS,
                tool_choice={"type": "any"},
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/jpeg",
                                    "data": image_b64,
                                },
                            },
                            {"type": "text", "text": _build_prompt(categories)},
                        ],
                    }
                ],
            )
        except (TimeoutError, anthropic.APIError, httpx.HTTPError) as exc:
            # Specific-only catch (never bare): SDK errors (incl. APITimeoutError),
            # transport errors, and asyncio timeouts. receipt_id context is logged by
            # the task, which owns that identifier; here we log the class of failure.
            logger.warning("receipt parse Anthropic call failed: %r", exc)
            raise ReceiptParseError("ANTHROPIC_ERROR") from exc

        tool_use = next(
            (block for block in message.content if block.type == "tool_use"), None
        )
        if tool_use is None:
            # Forced tool-use should always yield a tool block; a text-only refusal
            # means the model declined the contract.
            raise ReceiptParseError("ANTHROPIC_ERROR")

        if tool_use.name == "reject_image":
            reason = cast(dict[str, Any], tool_use.input).get("reason")
            code = "NOT_A_RECEIPT" if reason == "not_a_receipt" else "UNREADABLE_IMAGE"
            raise ReceiptParseError(code)

        try:
            return ParsedReceipt.model_validate(tool_use.input)
        except ValidationError as exc:
            raise ReceiptParseError("INVALID_MODEL_OUTPUT") from exc
