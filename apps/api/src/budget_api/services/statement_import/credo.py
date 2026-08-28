"""Credo Bank (Georgia) xlsx parser (``credo_xlsx_v1``) — bytes → ``ParsedStatement``.

The file is a two-sheet workbook, not a table: ``Account Details`` is nine
label/value pairs (holder, period, currency, opening and closing balance, the
month's income and expenses) and ``Transactions`` is ONE flat grid under a single
header row — ``Date | Operation | Turnover (DB) | Turnover (Cr) | Balance |
Description | Beneficiary Name | Beneficiary Account``. No sections, no totals
line, no blocked tail: everything Priorbank needed a state machine for is absent
here, so this parser is a header check plus a loop.

Three facts of the format decide the whole module (verified against a real
export before a line of it was written):

* **Money is TEXT.** ``"15,355.04"`` — a shared string with a thousands comma, not
  a number. It is read into ``Decimal`` from that string and never from a float; a
  numeric money cell is REFUSED rather than rounded through binary floating point,
  because a bank that switches its export to numbers must be looked at by a human
  before its money enters the ledger.
* **Dates are numeric Excel serials** (1900 epoch) carrying a date-only value.
  openpyxl hands them over already converted to ``datetime`` when the cell's
  number format says so, so both spellings are accepted; the clock is always
  midnight and this format has no transaction time at all (``txn_time`` is None,
  and ``booked_date`` is the same day — the sheet prints ONE date per row).
* **The sign lives in WHICH column is filled**, not in the number: ``Turnover
  (DB)`` is an expense, ``Turnover (Cr)`` an income. Both filled or neither is a
  grid drift, refused — a row whose direction is a guess would be money written
  backwards.

And one gate the other format could not have: the sheet carries a RUNNING BALANCE,
so the parse is self-checking. ``balance[i] == balance[i-1] - DB + Cr`` for every
row (the first from ``Opening Balance``), the last balance equals ``Closing
Balance`` and the two turnover columns sum to the declared ``Expenses``/``Income``.
A column read one cell to the side, a row silently dropped, a thousands comma
eaten — all of them break that identity, and every one of them would otherwise
produce a plausible-looking wrong number. The check is exact integer arithmetic in
minor units, so it cannot drift on rounding.

Unknown Georgian wording is DATA, deliberately unlike Priorbank's strict line
grammar: the operation string is stored verbatim as ``bank_category`` and
translated (or badged as untranslated) by the client. The bank prints its
vocabulary in a column, not in the grid, so a new phrase says nothing about
whether the file was read correctly — refusing a statement over it would be
refusing money we understood perfectly.
"""

import io
import re
import zipfile
from collections.abc import Callable, Iterator, Sequence
from datetime import date, datetime
from decimal import InvalidOperation

from openpyxl import load_workbook
from openpyxl.utils.datetime import (
    from_excel,  # pyright: ignore[reportUnknownVariableType]
)
from openpyxl.utils.exceptions import InvalidFileException
from openpyxl.workbook.workbook import Workbook

from budget_api.domain.money import to_major_string, to_minor_units
from budget_api.enums import StatementSection, TransactionKind
from budget_api.services.statement_import.types import (
    ParsedRow,
    ParsedStatement,
    StatementParseError,
)

#: The format id under which this parser is registered and stored on the session.
FORMAT_ID = "credo_xlsx_v1"

_DETAILS_SHEET = "Account Details"
_TRANSACTIONS_SHEET = "Transactions"

# Column positions inside the operations grid. Positional reads, guarded by the
# header check below: if the export ever reorders or renames a column, every read
# here would silently mean something else.
_COL_DATE = 0
_COL_OPERATION = 1
_COL_DEBIT = 2
_COL_CREDIT = 3
_COL_BALANCE = 4
_COL_DESCRIPTION = 5

#: The whole drift guard of the grid — compared cell by cell, stripped.
_HEADERS = (
    "Date",
    "Operation",
    "Turnover (DB)",
    "Turnover (Cr)",
    "Balance",
    "Description",
    "Beneficiary Name",
    "Beneficiary Account",
)

# Labels of the ``Account Details`` sheet. Looked up BY LABEL, never by row
# number: the sheet is a key/value list and a bank is free to insert a line.
_ACCOUNT_CURRENCY = "Account Currency"
_STATEMENT_PERIOD = "Statement Period"
_OPENING_BALANCE = "Opening Balance"
_CLOSING_BALANCE = "Closing Balance"
_INCOME = "Income"
_EXPENSES = "Expenses"

#: The file's only section, a FIXED token: Credo prints one flat grid, so there is
#: nothing to distinguish. ``card`` because the statement is a card account's — and
#: because ``StatementSection`` is what migration 0013's CHECK allows.
_SECTION = StatementSection.card.value

_CURRENCY_CODE_RE = re.compile(r"^[A-Z]{3}$")
_PERIOD_RE = re.compile(r"^(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})$")

#: The tail of a card description: what the merchant actually charged, in the
#: merchant's own currency, on the day of the purchase — ``56.10 BYN 01.08.2026``.
#: Unlike the turnover columns these amounts carry NO thousands separator
#: (``1000.00 BYN`` in the real file), so a comma here would not be a group mark
#: and is deliberately not accepted.
_PAIR_RE = re.compile(r"(\d+(?:\.\d+)?)\s+([A-Z]{3})\s+(\d{2}\.\d{2}\.\d{4})\s*$")

#: Georgian openers of a card description: "payment" and "cash withdrawal". They
#: are what separates the merchant's Latin name from the bank's own wording — the
#: ONLY reason this parser knows any Georgian at all. An unknown opener simply
#: means "no merchant could be isolated", never a refusal.
_DESCRIPTION_PREFIXES = ("გადახდა", "განაღდება")

#: Stems of the two operations that MIGHT be the user's own money moving between
#: their accounts: "top-up" and "conversion" (the CH Debit/P2P precedent of
#: Priorbank). Substring, not equality: a variant wording must keep flagging, and
#: the flag only decides whether the preview draws a badge — v1 never converts a
#: row into a transfer on its own.
_TRANSFER_STEMS = ("ჩარიცხვა", "კონვერტაცია")

#: openpyxl ships no type information, so its serial→datetime converter reaches
#: pyright-strict as Unknown. Contained in ONE typed alias (the slowapi
#: containment of the receipts router) rather than re-implemented: Excel's
#: 1900 leap-year quirk is exactly the thing not to write a second time.
_from_excel: Callable[[object, datetime], object] = from_excel  # pyright: ignore[reportUnknownVariableType]


def _open(data: bytes) -> Workbook:
    """The bytes as a read-only workbook, or a refusal.

    ``read_only`` streams the sheet instead of building a cell object per cell (a
    statement is a long thin table), and ``data_only`` asks for values rather than
    formulas — a formula string would land in a money column.
    """
    try:
        return load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except (zipfile.BadZipFile, InvalidFileException, KeyError, ValueError) as exc:
        # Everything openpyxl throws at a file that is not a workbook: not a zip
        # at all, a zip without the xlsx parts, a corrupted part.
        raise StatementParseError("not an xlsx workbook") from exc


def _text(value: object) -> str:
    """One cell as the string the file shows — dates ISO, everything else str()."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _money(value: object, currency: str, *, where: str) -> int | None:
    """A money cell → minor units; an empty cell → ``None``.

    TEXT ONLY, on the cover sheet exactly as in the grid. A numeric cell is refused
    rather than read: openpyxl hands numbers over as ``float``, and this codebase's
    money never comes from binary floating point (conventions.md §Money). The
    refusal is also the signal that the bank changed its export — which is a thing
    to look at, not to round.

    The message SAYS what happened in words a person can act on, because it is the
    only place that ever will: the route answers a bare STATEMENT_PARSE_FAILED and
    logs this text, so "the bank exported the amounts as numbers instead of text"
    has to survive here or nobody ever learns why a good-looking file was refused.
    The cell's value is deliberately left out of it — the file is a bank statement
    and this string goes to the log.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise StatementParseError(
            f"{where}: money must be a text cell — the bank exported the amounts as "
            f"numbers, not as text ({type(value).__name__}), and this app never "
            f"reads money from a spreadsheet float"
        )
    text = value.strip().replace(",", "")
    if not text:
        return None
    try:
        return to_minor_units(text, currency)
    except InvalidOperation as exc:
        raise StatementParseError(f"{where}: not a number: {value!r}") from exc


def _date_of(value: object, epoch: datetime, *, where: str) -> date:
    """A date cell → ``date``: an already-converted datetime or a 1900 serial.

    openpyxl converts a cell whose number format is a date one; a bank that ships
    the same serial with a general format hands over a bare number, and the two
    must not read as different days. ``from_excel`` is openpyxl's own converter, so
    the 1900 leap-year quirk is not re-implemented here.
    """
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, int | float) and not isinstance(value, bool):
        converted = _from_excel(value, epoch)
        if isinstance(converted, datetime):
            return converted.date()
        if isinstance(converted, date):
            return converted
    raise StatementParseError(f"{where}: not a date: {value!r}")


def _parse_day(text: str, *, where: str) -> date:
    try:
        return datetime.strptime(text, "%d.%m.%Y").date()
    except ValueError as exc:
        raise StatementParseError(f"{where}: not a date: {text!r}") from exc


def _details(workbook: Workbook) -> dict[str, object]:
    """The label/value sheet as a mapping — later duplicates never shadow earlier.

    Values are kept AS THE CELLS ARE, not stringified: three of them are money, and
    ``_money`` refuses a numeric money cell on this sheet for exactly the reason it
    refuses one in the grid. Stringifying here would launder a float past that gate.
    """
    sheet = workbook[_DETAILS_SHEET]
    details: dict[str, object] = {}
    for cells in sheet.iter_rows(values_only=True):
        if not cells:
            continue
        label = _text(cells[0]).strip()
        if label and label not in details:
            details[label] = cells[1] if len(cells) > 1 else None
    return details


def _required_text(details: dict[str, object], label: str) -> str:
    """A label the file MUST carry, as text.

    Without the currency the numbers below have no meaning, and without the opening
    balance the running-balance check has nothing to start from — those two and the
    grid header (checked in ``_row_cells``) are the difference between reading a
    statement and guessing one.
    """
    value = _text(details.get(label)).strip()
    if not value:
        raise StatementParseError(f"no {label!r} in {_DETAILS_SHEET}")
    return value


def _period(details: dict[str, object], rows: Sequence[ParsedRow]) -> tuple[date, date]:
    """``01.08.2026 - 28.08.2026``, or the span of the rows themselves.

    The fallback is the same one Priorbank uses and is safe in the same direction:
    every operation is inside the printed period by definition, so a derived window
    can only be NARROWER — which is what the S3 "replace from date X" range wants.
    """
    printed = _text(details.get(_STATEMENT_PERIOD)).strip()
    if printed:
        match = _PERIOD_RE.match(printed)
        if match is None:
            raise StatementParseError(f"unreadable {_STATEMENT_PERIOD}: {printed!r}")
        period_from = _parse_day(match.group(1), where=_STATEMENT_PERIOD)
        period_to = _parse_day(match.group(2), where=_STATEMENT_PERIOD)
    elif rows:
        period_from = min(row.txn_date for row in rows)
        period_to = max(row.txn_date for row in rows)
    else:
        raise StatementParseError("no statement period and no operations")
    if period_to < period_from:
        raise StatementParseError("statement period ends before it starts")
    return period_from, period_to


def _pair(
    description: str, statement_currency: str
) -> tuple[int | None, str | None, int]:
    """The merchant-side amount out of the description tail, plus where it starts.

    Returns NULL/NULL — the app's spelling of "priced in the account's own
    currency" (the ``original_pair`` CHECK) — when the tail names the statement's
    own currency, exactly as the Priorbank parser drops an equal currency instead
    of storing a second spelling of the same fact. The third element is the index
    the tail begins at, so the merchant name can be cut at the same place the
    money was found and the two can never disagree.
    """
    match = _PAIR_RE.search(description)
    if match is None:
        return None, None, len(description)
    currency = match.group(2)
    if currency == statement_currency:
        return None, None, match.start()
    minor = to_minor_units(match.group(1), currency)
    # > 0 is what the transactions CHECK demands of the pair, and a zero foreign
    # amount says nothing anyway.
    if minor <= 0:
        return None, None, match.start()
    return minor, currency, match.start()


def _merchant(description: str, tail_at: int) -> str:
    """The Latin shop name, or ``""`` — this parser NEVER answers ``None``.

    ``გადახდა - YANDEX.EDA 56.10 BYN 01.08.2026`` → ``YANDEX.EDA``, and the quotes
    a shop puts in its own name survive (``SHOP "SANTA-362" BAPB``) — this cuts at
    two known ends and never tokenizes what is between them.

    Only a description that OPENS with a known Georgian word yields a name.
    Everything else — ``Currency Exchange``, a bare ``სხვა და სხვა საკომისიო`` (a
    fee), an unknown Georgian phrase, an opener with nothing behind it — is the
    bank talking about itself, and the answer is the EMPTY STRING: "this line has
    no merchant". That is a different statement from ``None``, which means "this
    format isolates no names at all, so the description IS the name" (the
    Priorbank case, ``types.display_name``). Credo must never fall back that way:
    its description is a sentence, and a sentence carrying a price and a date,
    filed as a merchant, is a shop WE invented — it would head the top-merchants
    list and key the category map with a string that can never repeat.

    The empty string survives to apply, where ``clean_merchant`` turns it into the
    NULL merchant of a nameless transaction (``schemas/transaction.py``).
    """
    head = description[:tail_at].strip()
    for prefix in _DESCRIPTION_PREFIXES:
        if head.startswith(prefix):
            return head[len(prefix) :].strip().removeprefix("-").strip()
    return ""


def _row_cells(workbook: Workbook) -> Iterator[tuple[int, tuple[object, ...]]]:
    """Every operation line of the grid with its SHEET row number, header checked.

    The row number is 1-based and is the one the user sees in Excel: it is what a
    refusal names, and "row 42 does not add up" is only actionable if it means the
    same 42 the spreadsheet shows.
    """
    sheet = workbook[_TRANSACTIONS_SHEET]
    rows = sheet.iter_rows(values_only=True)
    header = next(rows, None)
    if header is None:
        raise StatementParseError(f"{_TRANSACTIONS_SHEET} is empty")
    printed = tuple(_text(cell).strip() for cell in header[: len(_HEADERS)])
    if printed != _HEADERS:
        raise StatementParseError(f"unexpected column header: {printed!r}")
    for number, cells in enumerate(rows, start=2):
        if not any(_text(cell).strip() for cell in cells):
            # A trailing empty row is how a spreadsheet ends, not a dropped
            # operation: it carries no balance, so the self-check below is blind
            # to it either way.
            continue
        yield number, cells


def _raw(cells: Sequence[object]) -> dict[str, str]:
    """The line's cells as text, keyed by the grid's own column names."""
    raw = {
        header: _text(cells[index] if index < len(cells) else None)
        for index, header in enumerate(_HEADERS)
    }
    raw.update(
        {
            f"col_{index}": _text(cell)
            for index, cell in enumerate(cells)
            if index >= len(_HEADERS) and _text(cell).strip()
        }
    )
    return raw


def _turnover(cells: Sequence[object], currency: str, *, where: str) -> int:
    """Signed turnover from the column that is FILLED — the file's only sign.

    Both columns or neither is a drifted grid, not an ambiguous row: the balance
    column would then be the only thing saying which way the money went, and a
    parser that inferred the direction from it would happily import a whole
    statement backwards on the day the bank adds a third column.
    """
    debit = _money(cells[_COL_DEBIT], currency, where=f"{where} Turnover (DB)")
    credit = _money(cells[_COL_CREDIT], currency, where=f"{where} Turnover (Cr)")
    if (debit is None) == (credit is None):
        raise StatementParseError(
            f"{where}: exactly one of Turnover (DB)/Turnover (Cr) must be filled"
        )
    return -debit if debit is not None else (credit or 0)


def _operation(
    cells: Sequence[object],
    *,
    row_index: int,
    currency: str,
    epoch: datetime,
    where: str,
    turnover_minor: int,
) -> ParsedRow:
    day = _date_of(cells[_COL_DATE], epoch, where=f"{where} Date")
    operation = _text(cells[_COL_OPERATION]).strip()
    description = _text(cells[_COL_DESCRIPTION]).strip()
    original_amount_minor, original_currency, tail_at = _pair(description, currency)
    return ParsedRow(
        row_index=row_index,
        section=_SECTION,
        txn_date=day,
        # The grid prints ONE date and no clock: there is no posting date to be
        # later and no time to be unknown.
        txn_time=None,
        booked_date=day,
        description=description,
        bank_category=operation or None,
        kind=(
            TransactionKind.expense.value
            if turnover_minor < 0
            else TransactionKind.income.value
        ),
        amount_minor=abs(turnover_minor),
        original_amount_minor=original_amount_minor,
        original_currency=original_currency,
        # No fee column in this format: Credo bills its commissions as their own
        # operation lines ("სხვა და სხვა საკომისიო"), which import as ordinary
        # expenses. 0 is the honest "the file states none".
        fee_minor=0,
        raw=_raw(cells),
        possible_transfer=any(stem in operation for stem in _TRANSFER_STEMS),
        merchant=_merchant(description, tail_at),
    )


def _check_balance(
    *, expected_minor: int, stated_minor: int | None, currency: str, where: str
) -> int:
    """One link of the running-balance chain — the parser's self-check.

    Returns the balance the next row must continue from. A missing balance cell is
    refused for the same reason a wrong one is: the chain is what proves the
    columns were read where they actually are.
    """
    if stated_minor is None:
        raise StatementParseError(f"{where}: no Balance")
    if stated_minor != expected_minor:
        raise StatementParseError(
            f"{where}: balance does not add up — the file says "
            f"{to_major_string(stated_minor, currency)}, the turnovers give "
            f"{to_major_string(expected_minor, currency)}"
        )
    return stated_minor


def _check_total(
    details: dict[str, object], label: str, actual_minor: int, currency: str
) -> None:
    """A declared total against what the rows add up to, when the file prints it.

    Checked only if present: the three balance anchors are structural, but a bank
    dropping a summary line from its own cover sheet must not refuse a statement
    whose every row already proved itself against the running balance.
    """
    declared = _money(details.get(label), currency, where=f"{_DETAILS_SHEET} {label}")
    if declared is None or declared == actual_minor:
        return
    raise StatementParseError(
        f"{label} disagrees with the rows — the file says "
        f"{to_major_string(declared, currency)}, the rows give "
        f"{to_major_string(actual_minor, currency)}"
    )


def parse(data: bytes) -> ParsedStatement:
    """The parser entry point registered as ``credo_xlsx_v1``."""
    workbook = _open(data)
    try:
        for sheet in (_DETAILS_SHEET, _TRANSACTIONS_SHEET):
            if sheet not in workbook.sheetnames:
                raise StatementParseError(f"no {sheet!r} sheet")
        details = _details(workbook)
        currency = _required_text(details, _ACCOUNT_CURRENCY)
        if not _CURRENCY_CODE_RE.match(currency):
            raise StatementParseError(f"not a currency code: {currency!r}")

        # Read for its presence first, then as money: "the sheet does not say" and
        # "the sheet says something unreadable" are different refusals.
        _required_text(details, _OPENING_BALANCE)
        balance_minor = _money(
            details.get(_OPENING_BALANCE),
            currency,
            where=f"{_DETAILS_SHEET} {_OPENING_BALANCE}",
        )
        if balance_minor is None:  # pragma: no cover - the line above rejects empty
            raise StatementParseError(f"no {_OPENING_BALANCE!r} in {_DETAILS_SHEET}")

        rows: list[ParsedRow] = []
        rows_zero_skipped = 0
        debit_minor = 0
        credit_minor = 0
        epoch = workbook.epoch
        for number, cells in _row_cells(workbook):
            where = f"{_TRANSACTIONS_SHEET} row {number}"
            turnover_minor = _turnover(cells, currency, where=where)
            balance_minor = _check_balance(
                expected_minor=balance_minor + turnover_minor,
                stated_minor=_money(
                    cells[_COL_BALANCE], currency, where=f"{where} Balance"
                ),
                currency=currency,
                where=where,
            )
            if turnover_minor < 0:
                debit_minor -= turnover_minor
            else:
                credit_minor += turnover_minor
            if turnover_minor == 0:
                # Nothing moved, so there is nothing to import — and the chain
                # above already proved the line was read correctly.
                rows_zero_skipped += 1
                continue
            rows.append(
                _operation(
                    cells,
                    row_index=len(rows),
                    currency=currency,
                    epoch=epoch,
                    where=where,
                    turnover_minor=turnover_minor,
                )
            )

        _check_total(details, _CLOSING_BALANCE, balance_minor, currency)
        _check_total(details, _EXPENSES, debit_minor, currency)
        _check_total(details, _INCOME, credit_minor, currency)
        period_from, period_to = _period(details, rows)
    finally:
        workbook.close()

    return ParsedStatement(
        source_format=FORMAT_ID,
        currency=currency,
        period_from=period_from,
        period_to=period_to,
        rows=tuple(rows),
        # Credo prints no authorization block and no separate grid: every line of
        # the sheet is a posted operation.
        rows_blocked=0,
        rows_zero_skipped=rows_zero_skipped,
    )
