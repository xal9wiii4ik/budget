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


def display_name(merchant: str | None, description: str) -> str:
    """The ONE reading of "what is this line called": the parser's name, or the line.

    Written once and used by both readers of that pair — ``apply`` (the created
    transaction's ``merchant``) and ``categories`` (the key of the merchant map) —
    because the two must agree by construction: a transaction filed as "YANDEX.EDA"
    while the map learned the whole Georgian sentence would never suggest anything
    again, and the disagreement would be invisible until a user looked for it.

    Takes the two strings rather than a row so that a ``ParsedRow`` (suggestion
    time, before anything is stored) and a ``StatementImportRow`` (apply time) go
    through the same code without this module importing the ORM.

    ``merchant`` is THREE-VALUED and the empty string is not a missing value here:

    * a name → that name;
    * ``""`` → ``""``. The parser looked at this line and found no merchant in it
      (Credo's fees, exchanges and unknown Georgian phrases). The description is a
      SENTENCE in such a format, so falling back to it would file money under a
      merchant nobody named; downstream ``clean_merchant`` turns ``""`` into the
      NULL merchant of a nameless transaction and ``normalize_merchant`` into the
      empty key both map ends skip;
    * ``None`` → the description. The format isolates no names at all, so the
      description IS the name — every Priorbank row, byte for byte as before.

    Which of the last two a format answers is the PARSER's call, stated in its
    ``_merchant``; this function only refuses to guess on its behalf.
    """
    if merchant is not None:
        return merchant
    return description


class StatementParseError(Exception):
    """The bytes are not a statement of this format (→ 422 STATEMENT_PARSE_FAILED).

    Raised for a wrong encoding, a drifted column header, an unreadable number —
    anything that would otherwise put guesswork into the database. The session is
    never created, so there is nothing to clean up and nothing to show.
    """


@dataclass(frozen=True)
class SelfCheck:
    """Whether the file proved its own arithmetic (pdf-reconcile D-E7).

    DATA and not an exception for the formats that can be read tolerantly: a
    statement whose rows add up to the wrong closing balance is a COMPLETE,
    displayable statement with (most likely) one line misread, and the user is the
    only one who can point at which — so the session is created and only
    ``apply``/``replace`` refuse it. A format that reads its rows deterministically
    (Credo) keeps RAISING instead: there, a chain that does not close means
    mis-read COLUMNS, and nothing about the preview would be trustworthy.

    ``failed`` and ``failed=<which check>`` are one fact (the ``self_check_detail``
    CHECK of migration 0019): a failure nobody can name could not be shown.
    """

    #: ``StatementSelfCheckStatus`` value.
    status: str
    #: ``StatementSelfCheckFailure`` value — set if and only if ``status`` is
    #: ``failed``, and then it is the FIRST check that failed.
    failed: str | None = None
    #: The two sides of the arithmetic, in the statement currency's minor units.
    #: Both stay ``None`` for ``date_range``, which is not a difference.
    expected_minor: int | None = None
    actual_minor: int | None = None


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
    #: The shop name the parser could isolate inside ``description``, when the
    #: format's description is a SENTENCE rather than a name ("გადახდა - YANDEX.EDA
    #: 56.10 BYN 01.08.2026" → "YANDEX.EDA"). THREE-VALUED (``display_name``):
    #: a name, ``""`` = "this line has no merchant" (the answer of a
    #: sentence-shaped format that found none — it becomes a NULL merchant, never
    #: the sentence), ``None`` = "the description is the best name there is" —
    #: which is the Priorbank case and the default, so that format's behaviour is
    #: untouched.
    #:
    #: Stored in its own column (``statement_import_rows.merchant``, migration
    #: 0014) and served in the preview, because it DECIDES two things a user can
    #: see: what the created transaction is called and which key the merchant
    #: category map is read by.
    merchant: str | None = None

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
    #: The balance the file PRINTS for the start and the end of its period, in
    #: ``currency``'s minor units (pdf-reconcile architecture §2). ``None`` means
    #: "this format carries no such anchor", which is the Priorbank case and the
    #: DEFAULT — every field below is optional precisely so that adding them did
    #: not touch that parser at all. The closing anchor is what the post-import
    #: balance check holds our ledger against; without it the check is honestly
    #: ``not_available`` rather than silently skipped.
    opening_balance_minor: int | None = None
    closing_balance_minor: int | None = None
    #: What checking those anchors against the rows PROVED — ``None`` for a format
    #: with nothing to check, which the session stores as ``not_available``.
    self_check: SelfCheck | None = None
