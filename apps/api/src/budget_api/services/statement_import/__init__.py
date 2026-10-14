"""Statement import services — the format registries (architecture §8).

A format id becomes a reader HERE and nowhere else. There are TWO registries,
because there are two kinds of reader and the difference is not a flag:

* ``PARSERS`` — a plain ``(bytes) -> ParsedStatement`` callable. Pure, sync, no
  provider, no budget: Priorbank's grid and Credo's workbook are read
  deterministically, and that is the whole contract.
* ``EXTRACTORS`` — ``async (bytes, provider, config, quota) -> ParsedStatement``.
  Membership IS "this format needs an LLM provider" (pdf-reconcile D-E10): the
  router reads the gate off the registry instead of keeping a boolean in sync,
  the two sync parser modules stayed byte-identical when the first extractor
  arrived, and no dataclass grew optional arms.

``FORMAT_IDS`` is their union in registry order — the ONE tuple ``GET /formats``
publishes, the upload validates ``format`` against, and ``FINGERPRINT_VERSIONS``
is pinned against. Adding a bank is a new module plus a line in one of the two
mappings; the router still knows nothing about any bank.

The keys are stored on every session (``source_format``), so they are contract:
rename one and old sessions stop saying which reader read them.
"""

from collections.abc import Callable, Mapping
from typing import Protocol

from budget_api.llm import LLMProvider
from budget_api.services.statement_import import alfa_pdf, credo, priorbank
from budget_api.services.statement_import.alfa_pdf import ExtractConfig
from budget_api.services.statement_import.types import (
    ParsedStatement,
    StatementParseError,
)

StatementParser = Callable[[bytes], ParsedStatement]


class AsyncExtractor(Protocol):
    """A format read by a model. ``quota`` is the caller's "may I spend n lines?".

    A ``Protocol`` rather than a ``Callable`` alias so the keyword-only
    ``user_id`` stays part of the type: it is what puts the owner on every
    ``log_call`` line.
    """

    async def __call__(
        self,
        data: bytes,
        provider: LLMProvider,
        config: ExtractConfig,
        quota: Callable[[int], bool],
        *,
        user_id: str | None = None,
    ) -> ParsedStatement: ...


#: Registry order is the order ``GET /formats`` publishes, and the web fills its
#: bank picker from that — so it is the order the user sees.
PARSERS: Mapping[str, StatementParser] = {
    priorbank.FORMAT_ID: priorbank.parse,
    credo.FORMAT_ID: credo.parse,
}

#: The formats that need ``app.state.llm``. Published separately as
#: ``ai_formats``, so the web can gate the picker on ``ai_available`` instead of
#: keeping its own copy of this set (grooming ruling 6).
EXTRACTORS: Mapping[str, AsyncExtractor] = {
    alfa_pdf.FORMAT_ID: alfa_pdf.extract,
}

#: Every format this server can read, in registry order.
FORMAT_IDS: tuple[str, ...] = (*PARSERS, *EXTRACTORS)

__all__ = [
    "EXTRACTORS",
    "FORMAT_IDS",
    "PARSERS",
    "AsyncExtractor",
    "ParsedStatement",
    "StatementParseError",
    "StatementParser",
]
