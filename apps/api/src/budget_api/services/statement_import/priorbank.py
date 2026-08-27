"""Priorbank CSV parser (``priorbank_csv_v1``) — bytes → ``ParsedStatement``.

The file (task.md §Факты) is cp1251, ``;``-separated, decimal COMMA, thousands
separated by a space (ordinary or non-breaking), and it is NOT one table: a
header block, then one operations block per contract/card — each with its own
column header and its own totals line — and a trailing "Заблокированные суммы"
block on a DIFFERENT grid. That is why this is a line state machine and not a
``csv.DictReader``: a dict reader would happily turn a totals line into an
operation.

``csv.reader`` still does the SPLITTING (quoted cells with a ``;`` inside are a
CSV fact, not something to re-invent), and the state machine decides what each
resulting list of cells means.

Strictness follows the STRUCTURE, not the line: outside a section (the header
block, the totals and the value line under them, the blocked tail) an unrecognized
line is IGNORED, because a bank prints whatever it likes there. INSIDE an open
operations block there is nothing else a line can be — the block holds its column
header, its operations and the totals line that closes it — so an unrecognized one
is a hard :class:`StatementParseError`, exactly like a drifted column header.

That symmetry is the point: if the export ever switches to ``2026-06-02`` dates,
every operation line stops matching and the alternative would be a 201 session
with zero rows — the user told "nothing to import" about a file full of money.
A line of nothing but separators (``;;;;;;;;``) is blank, not unrecognized.
"""

import csv
import io
import re
from collections.abc import Sequence
from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation

from budget_api.domain.money import to_minor_units
from budget_api.enums import StatementSection, TransactionKind
from budget_api.services.statement_import.types import (
    ParsedRow,
    ParsedStatement,
    StatementParseError,
)

#: The format id under which this parser is registered and stored on the session.
FORMAT_ID = "priorbank_csv_v1"

_ENCODING = "cp1251"
_DELIMITER = ";"

# Column positions inside an operations block (verified against the real file):
# Дата транзакции; Операция; Сумма; Валюта; Дата операции по счету;
# Комиссия/Money-back; Обороты по счету; Цифровая карта; Категория операции.
_COL_TXN_DATE = 0
_COL_DESCRIPTION = 1
_COL_ORIGINAL_AMOUNT = 2
_COL_ORIGINAL_CURRENCY = 3
_COL_BOOKED_DATE = 4
_COL_FEE = 5
_COL_TURNOVER = 6
_COL_BANK_CATEGORY = 8

#: The first two column names of an operations block. The WHOLE drift guard: if a
#: future export renames or reorders columns, the positional reads above would
#: silently mean something else, so the block is refused instead.
_HEADER_PREFIX = ("Дата транзакции", "Операция")

_SECTION_OPENER = "Операции по"
_BLOCKED_OPENER = "Заблокированные суммы"
#: Both "Всего по контракту" and "Всего в данной валюте" — a totals line CLOSES
#: the block it ends, so its own numbers can never be read as an operation.
_TOTALS_PREFIX = "Всего"

#: Sections are named by ORDER, not by the masked number in their title: in the
#: real file the contract block is titled with the CARD's mask, so matching on the
#: number would mislabel every row. Only two blocks exist; a third is drift.
_SECTION_ORDER = (StatementSection.contract.value, StatementSection.card.value)

_DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")
_DATE_PREFIX_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}")
#: "......5817 Валюта контракта BYN". The uppercase group is NOT case-folded: the
#: currency of the money we are about to store is not a place to be forgiving.
_CURRENCY_RE = re.compile(r"Валюта\s+(?:контракта|сч[её]та)\s*:?\s*([A-Z]{3})")
_PERIOD_RE = re.compile(r"с\s+(\d{2}\.\d{2}\.\d{4})\s+по\s+(\d{2}\.\d{2}\.\d{4})")
_CURRENCY_CODE_RE = re.compile(r"^[A-Z]{3}$")

#: "Time unknown" as the bank spells it — NOT midnight.
_UNKNOWN_TIME = time(0, 0, 0)

#: The bank's own P2P wording (architecture §5). Compared case-insensitively: the
#: flag only decides whether a badge is drawn, so a spelling change must not
#: silently stop warning.
_TRANSFER_PREFIXES = ("CH DEBIT", "CH PAYMENT")

#: Every space the thousands separator can be: an ordinary one, NBSP (which is
#: what the real file carries) and the narrow NBSP some exports use.
_SPACES = (" ", " ", " ")


def _decimal(cell: str) -> Decimal | None:
    """ "-1 439,63" → Decimal("-1439.63"); an empty cell → None."""
    text = cell.strip()
    for space in _SPACES:
        text = text.replace(space, "")
    if not text:
        return None
    try:
        return Decimal(text.replace(",", "."))
    except InvalidOperation as exc:
        raise StatementParseError(f"not a number: {cell!r}") from exc


def _minor(value: Decimal, currency: str) -> int:
    """Decimal → minor units at THIS currency's exponent (never a hardcoded x100)."""
    return to_minor_units(format(value, "f"), currency)


def _parse_date(cell: str) -> date:
    text = cell.strip().split()[0] if cell.strip() else ""
    if not _DATE_RE.match(text):
        raise StatementParseError(f"not a date: {cell!r}")
    return datetime.strptime(text, "%d.%m.%Y").date()


def _parse_datetime(cell: str) -> tuple[date, time | None]:
    """ "26.05.2026 12:34:56" → (date, time); a ``00:00:00`` clock → (date, None)."""
    parts = cell.strip().split()
    day = _parse_date(parts[0] if parts else "")
    if len(parts) < 2:
        return day, None
    try:
        clock = datetime.strptime(parts[1], "%H:%M:%S").time()
    except ValueError as exc:
        raise StatementParseError(f"not a time: {cell!r}") from exc
    return day, (None if clock == _UNKNOWN_TIME else clock)


def _cell(cells: Sequence[str], index: int) -> str:
    return cells[index].strip() if index < len(cells) else ""


def _original_pair(
    cells: Sequence[str], statement_currency: str
) -> tuple[int | None, str | None]:
    """The merchant-side amount, or (None, None) when the purchase was domestic.

    NULL/NULL is the app's spelling of "priced in the account's own currency" (the
    ``original_pair`` CHECK), so a foreign-currency cell equal to the statement's
    currency is deliberately dropped rather than stored as a second spelling of the
    same fact.
    """
    currency = _cell(cells, _COL_ORIGINAL_CURRENCY)
    if not currency or currency == statement_currency:
        return None, None
    if not _CURRENCY_CODE_RE.match(currency):
        raise StatementParseError(f"not a currency code: {currency!r}")
    amount = _decimal(_cell(cells, _COL_ORIGINAL_AMOUNT))
    if amount is None:
        raise StatementParseError(f"currency {currency} without an amount")
    minor = abs(_minor(amount, currency))
    # > 0 is what the transactions CHECK demands of the pair, and a zero foreign
    # amount says nothing anyway.
    return (minor, currency) if minor else (None, None)


def _parse_operation(
    cells: Sequence[str],
    headers: Sequence[str],
    *,
    row_index: int,
    section: str,
    statement_currency: str,
) -> ParsedRow | None:
    """One operation line → a row, or ``None`` when the turnover is zero."""
    turnover = _decimal(_cell(cells, _COL_TURNOVER))
    if turnover is None:
        raise StatementParseError("operation line without a turnover")
    turnover_minor = _minor(turnover, statement_currency)
    if turnover_minor == 0:
        return None

    txn_date, txn_time = _parse_datetime(_cell(cells, _COL_TXN_DATE))
    description = _cell(cells, _COL_DESCRIPTION)
    fee = _decimal(_cell(cells, _COL_FEE))
    original_amount_minor, original_currency = _original_pair(cells, statement_currency)
    return ParsedRow(
        row_index=row_index,
        section=section,
        txn_date=txn_date,
        txn_time=txn_time,
        booked_date=_parse_date(_cell(cells, _COL_BOOKED_DATE)),
        description=description,
        bank_category=_cell(cells, _COL_BANK_CATEGORY) or None,
        kind=(
            TransactionKind.expense.value
            if turnover_minor < 0
            else TransactionKind.income.value
        ),
        amount_minor=abs(turnover_minor),
        original_amount_minor=original_amount_minor,
        original_currency=original_currency,
        # Sign AS IN THE FILE (PM §10.2): a fee is negative, a money-back positive,
        # and an empty cell is 0 — "no fee" and "zero fee" are one fact.
        fee_minor=0 if fee is None else _minor(fee, statement_currency),
        raw={
            (headers[i] if i < len(headers) else f"col_{i}"): cells[i]
            for i in range(len(cells))
        },
        possible_transfer=description.upper().startswith(_TRANSFER_PREFIXES),
    )


def _header_of(text: str) -> tuple[str, date | None, date | None]:
    """Currency and period as the file's own header block states them."""
    currency_match = _CURRENCY_RE.search(text)
    if currency_match is None:
        # Without it we do not know what the numbers below MEAN, and guessing the
        # account's currency would be the one guess that silently corrupts money.
        raise StatementParseError("no statement currency in the header")
    period_match = _PERIOD_RE.search(text)
    if period_match is None:
        return currency_match.group(1), None, None
    return (
        currency_match.group(1),
        _parse_date(period_match.group(1)),
        _parse_date(period_match.group(2)),
    )


def parse(data: bytes) -> ParsedStatement:
    """The parser entry point registered as ``priorbank_csv_v1``."""
    try:
        text = data.decode(_ENCODING)
    except UnicodeDecodeError as exc:
        raise StatementParseError("not cp1251") from exc

    statement_currency, period_from, period_to = _header_of(text)

    rows: list[ParsedRow] = []
    headers: list[str] = []
    section: str | None = None
    section_index = 0
    expect_header = False
    in_blocked = False
    rows_blocked = 0
    rows_zero_skipped = 0

    for cells in csv.reader(io.StringIO(text), delimiter=_DELIMITER):
        first = _cell(cells, 0)
        line = _DELIMITER.join(cells).strip()
        # Blank means "no content", not "no characters": the file separates its
        # blocks with a full row of empty cells (";;;;;;;;"), which is a blank line
        # written in CSV and must stay legal INSIDE a section too.
        if not any(cell.strip() for cell in cells):
            continue

        if line.startswith(_BLOCKED_OPENER):
            # A different grid entirely: from here on, dated lines are COUNTED and
            # nothing else. They are authorizations that have not posted yet, and
            # they arrive later as ordinary operations — importing them would
            # guarantee a duplicate (task.md §4).
            in_blocked = True
            section = None
            expect_header = False
            continue

        if first.startswith(_SECTION_OPENER):
            in_blocked = False
            if section_index >= len(_SECTION_ORDER):
                raise StatementParseError("more operation blocks than the format has")
            section = _SECTION_ORDER[section_index]
            section_index += 1
            expect_header = True
            continue

        if expect_header:
            if tuple(_cell(cells, i) for i in range(2)) != _HEADER_PREFIX:
                raise StatementParseError(f"unexpected column header: {line!r}")
            headers = [cell.strip() for cell in cells]
            expect_header = False
            continue

        if first.startswith(_TOTALS_PREFIX):
            # The totals line and the value line under it are both outside a
            # section, so neither can be read as an operation.
            section = None
            continue

        if not _DATE_PREFIX_RE.match(first):
            if section is not None:
                # Inside an OPEN block every line is an operation (the header and
                # the totals line were handled above), so a line that does not
                # start with a date means the grid drifted — a changed date format
                # first of all. Dropping it silently would turn a whole statement
                # into an empty preview.
                # The FIRST CELL only, never the line: this message is logged, and
                # the rest of an operation line is the user's merchant and money.
                # The drifted cell is the diagnosis anyway.
                raise StatementParseError(
                    f"unexpected line in a section, first cell {first[:40]!r}"
                )
            continue
        if in_blocked:
            rows_blocked += 1
            continue
        if section is None:
            # A dated line that belongs to no block (a header date, a footer): the
            # format's own structure says it is not an operation.
            continue

        row = _parse_operation(
            cells,
            headers,
            row_index=len(rows),
            section=section,
            statement_currency=statement_currency,
        )
        if row is None:
            rows_zero_skipped += 1
            continue
        rows.append(row)

    if period_from is None or period_to is None:
        # Fall back to what the rows themselves span. Not a guess: every operation
        # in the file is inside the statement's period by definition, so the derived
        # window can only ever be NARROWER than the printed one — which is the safe
        # direction for the S3 "replace from date X" range.
        if not rows:
            raise StatementParseError("no period in the header and no operations")
        period_from = min(row.txn_date for row in rows)
        period_to = max(row.booked_date for row in rows)
    if period_to < period_from:
        raise StatementParseError("statement period ends before it starts")

    return ParsedStatement(
        source_format=FORMAT_ID,
        currency=statement_currency,
        period_from=period_from,
        period_to=period_to,
        rows=tuple(rows),
        rows_blocked=rows_blocked,
        rows_zero_skipped=rows_zero_skipped,
    )
