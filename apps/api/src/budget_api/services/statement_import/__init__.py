"""Statement import services — the parser registry (architecture §8).

A parser is a plain ``(bytes) -> ParsedStatement`` callable, and this mapping is
the ONE place a format id becomes one. Adding a second bank is a new module plus a
line here: the router validates the requested format against these keys and
otherwise knows nothing about any bank.

The keys are stored on every session (``source_format``), so they are contract:
rename one and old sessions stop saying which parser read them.
"""

from collections.abc import Callable, Mapping

from budget_api.services.statement_import import credo, priorbank
from budget_api.services.statement_import.types import (
    ParsedStatement,
    StatementParseError,
)

StatementParser = Callable[[bytes], ParsedStatement]

#: Registry order is the order ``GET /formats`` publishes, and the web fills its
#: bank picker from that — so it is the order the user sees.
PARSERS: Mapping[str, StatementParser] = {
    priorbank.FORMAT_ID: priorbank.parse,
    credo.FORMAT_ID: credo.parse,
}

__all__ = ["PARSERS", "ParsedStatement", "StatementParseError", "StatementParser"]
