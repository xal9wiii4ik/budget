"""The parser's output shape — pure data, no IO, no ORM (architecture §8).

One vocabulary for every bank format: a parser's whole contract is
``parse(data: bytes) -> ParsedStatement``, so adding a second bank is a new module
plus one line in the registry, never a change to the router or the matcher.

Frozen dataclasses rather than Pydantic models: nothing here crosses the wire —
the ROW model and the response schema do that — and freezing is what lets the
fingerprint treat a parsed row as an immutable fact.
"""

from dataclasses import dataclass
from datetime import date, time
from typing import Any

from budget_api.enums import TransactionKind


class StatementParseError(Exception):
    """The bytes are not a statement of this format (→ 422 STATEMENT_PARSE_FAILED).

    Raised for a wrong encoding, a drifted column header, an unreadable number —
    anything that would otherwise put guesswork into the database. The session is
    never created, so there is nothing to clean up and nothing to show.
    """


@dataclass(frozen=True)
class ParsedRow:
    """One operation line of the file, already in the app's money vocabulary."""

    #: Position in the FILE across both sections, 0-based.
    row_index: int
    #: ``StatementSection`` value — display only (both sections import into the
    #: ONE chosen account).
    section: str
    txn_date: date
    #: ``None`` when the file said ``00:00:00`` ("time unknown", not midnight).
    txn_time: time | None
    booked_date: date
    description: str
    bank_category: str | None
    #: ``TransactionKind`` value, derived from the SIGN of the turnover column.
    kind: str
    #: |turnover| in the statement's currency — magnitude plus kind, exactly like
    #: ``transactions``.
    amount_minor: int
    #: What the merchant charged, when that currency differs from the statement's.
    #: The bank's own rate arrives as a fact in this pair; we never convert.
    original_amount_minor: int | None
    original_currency: str | None
    #: "Комиссия/Money-back" in statement-currency minor units, SIGN AS IN THE FILE.
    fee_minor: int
    #: The source cells verbatim, keyed by the section's column header.
    raw: dict[str, Any]
    #: The bank's P2P wording — a FLAG for the user, never an auto-transfer.
    possible_transfer: bool

    @property
    def signed_amount_minor(self) -> int:
        """The turnover as the FILE spells it: negative for an expense.

        The fingerprint canonical uses this (architecture §3) rather than the
        magnitude, so a refund can never fingerprint like the purchase it reverses.
        """
        if self.kind == TransactionKind.expense.value:
            return -self.amount_minor
        return self.amount_minor


@dataclass(frozen=True)
class ParsedStatement:
    """A whole file: what it says about itself, plus the rows worth importing."""

    source_format: str
    #: From the file's header. Checked against the target account BEFORE anything
    #: is stored — the money in ``rows`` is denominated in it.
    currency: str
    period_from: date
    period_to: date
    rows: tuple[ParsedRow, ...]
    #: "Заблокированные суммы" lines: counted, never stored (architecture §1).
    rows_blocked: int
    #: Lines whose turnover is zero: nothing moved, nothing to import.
    rows_zero_skipped: int
