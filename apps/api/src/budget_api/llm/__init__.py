"""The provider seam: one request shape, one error, three providers, one registry.

Imports ``config``, ``httpx``, ``anthropic`` and stdlib — and nothing else of the
application. That import list is the guarantee that ``apps/api/evals/`` and
``services/categorize.py`` can be driven with no FastAPI app and no database
(architecture §Module structure, dependency direction).

Read ``types.py`` first: it carries what v1 implements and what it only declares
for the later tool loop.
"""

from budget_api.llm.anthropic import AnthropicProvider
from budget_api.llm.errors import ERROR_CODES, RETRYABLE_CODES, LLMError
from budget_api.llm.fake import FAIL_MARKER, FakeProvider, request_key
from budget_api.llm.ollama import OllamaProvider
from budget_api.llm.registry import PROVIDERS, build_provider, provider_from_settings
from budget_api.llm.structured import structured
from budget_api.llm.types import (
    ContentPart,
    LLMProvider,
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
    part_json,
    text_of,
)
from budget_api.llm.usage import (
    CACHE_READ_FACTOR,
    PRICES_USD_PER_MTOK,
    estimate_cost,
    failed_usage,
    log_call,
)

__all__ = [
    "CACHE_READ_FACTOR",
    "ERROR_CODES",
    "FAIL_MARKER",
    "PRICES_USD_PER_MTOK",
    "PROVIDERS",
    "RETRYABLE_CODES",
    "AnthropicProvider",
    "ContentPart",
    "FakeProvider",
    "LLMError",
    "LLMProvider",
    "LLMRequest",
    "LLMResponse",
    "Message",
    "OllamaProvider",
    "ResponseBlock",
    "TextBlock",
    "TextPart",
    "ToolResultPart",
    "ToolSpec",
    "ToolUseBlock",
    "Usage",
    "build_provider",
    "estimate_cost",
    "failed_usage",
    "log_call",
    "part_json",
    "provider_from_settings",
    "request_key",
    "structured",
    "text_of",
]
