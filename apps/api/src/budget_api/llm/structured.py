"""One fixed JSON shape over text — the call both categorize and pdf-reconcile make.

Everything here is provider-agnostic: it stamps the schema onto the request, takes
the first text block and parses it. DOMAIN validation of the parsed dict (are
those keys ours? is that confidence a number in range?) belongs to the caller —
``services/categorize.py`` owns the meaning of its own answer, and a shared
validator would have to know every caller's schema.
"""

import json
from dataclasses import replace
from typing import Any, cast

from budget_api.llm.errors import LLMError
from budget_api.llm.types import (
    LLMProvider,
    LLMRequest,
    Usage,
    text_of,
)

__all__ = ["structured"]


async def structured(
    provider: LLMProvider, request: LLMRequest, schema: dict[str, Any]
) -> tuple[dict[str, Any], Usage]:
    """Call ``provider`` with ``schema`` enforced; return the parsed object + usage.

    Raises ``LLMError("truncated")`` when the model ran out of tokens (the answer
    may be syntactically valid JSON up to the cut, so this check comes FIRST) and
    ``LLMError("invalid_output")`` when the text is not a JSON object.
    """
    response = await provider.complete(replace(request, output_schema=schema))
    if response.stop_reason == "max_tokens":
        raise LLMError("truncated")

    text = text_of(response)
    if text is None:
        raise LLMError("invalid_output")
    try:
        parsed: Any = json.loads(text)
    except ValueError as exc:
        # json.JSONDecodeError is a ValueError; nothing else here is a model
        # failure, so nothing else is caught.
        raise LLMError("invalid_output") from exc
    if not isinstance(parsed, dict):
        raise LLMError("invalid_output")
    return cast(dict[str, Any], parsed), response.usage
