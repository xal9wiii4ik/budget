"""The Credo parser against the synthetic xlsx workbook.

Pure and DB-free, like its Priorbank twin: this is the second place in the app
where a file's bytes become money, and what is pinned here is every trap that
could produce a WRONG number instead of an obvious crash — the two spellings of a
date, the two columns that carry the sign, the merchant-side pair hidden in the
description, and the running-balance self-check that is this format's whole
defence against a column read one cell to the side.

What is deliberately NOT here: that a refused file leaves no session behind (the
router's job, already proved for the other format) and the shape of the created
transactions (test_statement_apply.py).
"""

from datetime import date
from typing import Any

import pytest
from helpers import CREDO_HEADERS, CREDO_ROWS, CredoRow, build_credo_xlsx

from budget_api.enums import StatementSection, TransactionKind
from budget_api.services.statement_import.credo import parse
from budget_api.services.statement_import.types import ParsedRow, StatementParseError


def _rows_with(index: int, **cells: Any) -> tuple[CredoRow, ...]:
    """The fixture's operations with ONE cell of ONE line replaced."""
    columns = {
        "date": 0,
        "operation": 1,
        "debit": 2,
        "credit": 3,
        "balance": 4,
        "description": 5,
    }
    row = list(CREDO_ROWS[index])
    for name, value in cells.items():
        row[columns[name]] = value
    return (*CREDO_ROWS[:index], tuple(row), *CREDO_ROWS[index + 1 :])


def _by_merchant(rows: tuple[ParsedRow, ...]) -> dict[str | None, ParsedRow]:
    return {row.merchant: row for row in rows}


class TestCredoParser:
    async def test_dates_money_and_the_sign_of_two_turnover_columns(
        self, credo_xlsx_bytes: bytes
    ) -> None:
        """The three readings that decide every number: date, amount, direction.

        A bare 1900 serial and an already-typed datetime are the SAME day (a bank
        may ship either, and openpyxl only converts the cell whose number format
        says it is a date); "1,500.00" is 1500 and not 1, so the thousands comma
        cannot swallow three orders of magnitude; and the direction comes from
        WHICH column is filled — read from the number alone, every line of this
        file would be an expense, including the top-ups.
        """
        statement = parse(credo_xlsx_bytes)

        assert statement.currency == "USD"
        assert (statement.period_from, statement.period_to) == (
            date(2026, 8, 1),
            date(2026, 8, 31),
        )
        # Eleven lines in the sheet, one of them a zero turnover: nothing moved, so
        # there is nothing to import — and the counter is what makes the drop
        # visible instead of silent.
        assert len(statement.rows) == 10
        assert (statement.rows_zero_skipped, statement.rows_blocked) == (1, 0)
        assert [row.row_index for row in statement.rows] == list(range(10))

        serial_dated, typed_dated = statement.rows[0], statement.rows[1]
        assert serial_dated.txn_date == typed_dated.txn_date == date(2026, 8, 1)
        # One date per row and no clock: this format has neither a posting date of
        # its own nor a transaction time.
        assert serial_dated.booked_date == serial_dated.txn_date
        assert serial_dated.txn_time is None
        assert serial_dated.section == StatementSection.card.value

        top_up = next(
            row
            for row in statement.rows
            if row.bank_category == "ბარათზე თანხის ჩარიცხვა"
        )
        assert (top_up.kind, top_up.amount_minor) == (
            TransactionKind.income.value,
            150_000,
        )
        assert [row.kind for row in statement.rows].count(
            TransactionKind.income.value
        ) == 1

    async def test_a_row_with_both_or_neither_turnover_is_refused(self) -> None:
        """The sign has exactly one source, and an ambiguous row is a drifted grid.

        With both columns filled the balance column would be the only thing saying
        which way the money went; with neither there is no amount at all. Guessing
        either way is how a whole statement gets imported backwards.
        """
        for cells in ({"credit": "19.79"}, {"debit": "", "credit": ""}):
            with pytest.raises(StatementParseError, match="exactly one"):
                parse(build_credo_xlsx(rows=_rows_with(0, **cells)))

    async def test_the_balance_self_check_names_the_line_that_broke(self) -> None:
        """The file's own running balance is what proves the columns were read right.

        A shifted or mis-scaled amount still looks like money; only the balance
        chain notices. The refusal names the SHEET row (the number Excel shows) and
        both numbers, because "your statement is unreadable" without a line to open
        is not something a user can act on.
        """
        broken = _rows_with(2, debit="13.48")  # digits swapped: 13.84 -> 13.48

        with pytest.raises(StatementParseError) as refusal:
            parse(build_credo_xlsx(rows=broken))

        message = str(refusal.value)
        # Sheet row 4 = the header plus the two lines above the broken one.
        assert "row 4" in message
        assert "958.29" in message and "958.65" in message

    async def test_a_declared_total_that_disagrees_with_the_rows_is_refused(
        self,
    ) -> None:
        """The cover sheet is checked too, so a TRUNCATED export cannot pass.

        Every row can chain correctly and the file still be half a statement: the
        declared closing balance is the only thing that knows how many lines there
        should have been.
        """
        with pytest.raises(StatementParseError, match="Closing Balance"):
            parse(build_credo_xlsx(rows=CREDO_ROWS[:-2]))

    async def test_the_merchant_and_the_bank_s_pair_come_out_of_the_description(
        self, credo_xlsx_bytes: bytes
    ) -> None:
        """The description is a SENTENCE: the shop name and the merchant's own price.

        ``გადახდა - YANDEX.EDA 56.10 BYN 01.08.2026`` carries three facts at once,
        and each has a different fate: the name becomes the transaction's merchant,
        the foreign amount becomes the ``original_*`` pair (the bank's own rate,
        never re-converted), and the purchase date stays in the text — the ledger
        is dated by the sheet's own column.
        """
        rows = _by_merchant(parse(credo_xlsx_bytes).rows)

        assert rows["YANDEX.EDA"].original_amount_minor == 5_610
        assert rows["YANDEX.EDA"].original_currency == "BYN"
        # A shop's own quotes are part of its name: the cut happens at two known
        # ends, never by tokenizing what is between them.
        assert 'SHOP "SANTA-362" BAPB' in rows
        # CHF is outside SUPPORTED_CURRENCIES — which gates the BASE currency only.
        # What a merchant charged is a fact of the file, not a currency we must
        # have rates for.
        assert rows["Coop Pronto 5241"].original_currency == "CHF"
        assert rows["Coop Pronto 5241"].original_amount_minor == 1_095
        # The pair in the ACCOUNT's own currency is dropped (NULL/NULL is the app's
        # one spelling of "priced in the account's currency") — but the name in
        # front of it is still a name.
        simpleway = rows["WWW.SIMPLEWAY.BY"]
        assert (simpleway.original_amount_minor, simpleway.original_currency) == (
            None,
            None,
        )
        assert simpleway.amount_minor == 14_542
        # No Georgian opener, no merchant — and the answer is the EMPTY STRING,
        # never None: a fee, a top-up, "Currency Exchange" and an unknown phrase
        # are the bank talking about itself, and None is this app's word for "the
        # description IS the name", which would file all four under a sentence
        # nobody named. The contrast is the point of pinning the exact value.
        assert {
            row.description: row.merchant
            for row in parse(credo_xlsx_bytes).rows
            if not row.merchant
        } == {
            "სხვა და სხვა საკომისიო": "",
            "ბარათზე თანხის ჩარიცხვა": "",
            "Currency Exchange": "",
            "სესხის დაფარვა": "",
        }
        # An opener with nothing behind it is that same "no merchant" and not a
        # name made of whitespace: the cut happens, and what is left is nothing.
        opener_only = parse(
            build_credo_xlsx(rows=_rows_with(0, description="გადახდა -"))
        )
        assert opener_only.rows[0].merchant == ""

    async def test_an_unknown_georgian_phrase_is_data_and_transfers_are_flagged(
        self, credo_xlsx_bytes: bytes
    ) -> None:
        """A phrase this app has never seen is a CATEGORY, not a parse failure.

        The opposite of the Priorbank rule, deliberately: Credo prints its
        vocabulary in a column, so a new word says nothing about whether the grid
        was read correctly. Refusing the file would refuse money we understood
        perfectly — the client badges the untranslated string instead.
        """
        rows = parse(credo_xlsx_bytes).rows
        by_category = {row.bank_category: row for row in rows}

        unknown = by_category["ბანკის ახალი ოპერაცია"]
        assert unknown.amount_minor == 1_250
        assert unknown.possible_transfer is False
        # Top-up and conversion MIGHT be the user's own money moving between their
        # accounts; the flag draws a badge and never converts a row by itself.
        assert by_category["ბარათზე თანხის ჩარიცხვა"].possible_transfer is True
        assert by_category["უნაღდო კონვერტაცია"].possible_transfer is True
        assert by_category["საბარათე ოპერაცია"].possible_transfer is False

    async def test_money_in_a_numeric_cell_is_refused_and_says_why(self) -> None:
        """Money is read from TEXT or not at all (conventions.md §Money).

        The export prints "19.79" as a string today. If it ever prints the number
        19.79 instead, that is a float, and a float is not where this codebase's
        money comes from — the change must be looked at, not silently rounded.

        The REASON is pinned with the refusal: the route answers a bare
        STATEMENT_PARSE_FAILED and only logs this text, so if it stops naming the
        cause the cause stops being knowable at all — and "your file is bad" over a
        file that opens fine in Excel is the one refusal nobody can act on.
        """
        with pytest.raises(StatementParseError) as refusal:
            parse(build_credo_xlsx(rows=_rows_with(0, debit=19.79)))

        message = str(refusal.value)
        assert "the bank exported the amounts as numbers, not as text" in message
        # The cell itself never reaches the log: this is a bank statement.
        assert "19.79" not in message

    async def test_a_drifted_grid_or_a_missing_sheet_is_refused(self) -> None:
        """Every read below the header is POSITIONAL, so the header is the guard.

        A renamed or reordered column would keep parsing and mean something else in
        every cell; a workbook without the sheets is not this format at all.
        """
        renamed = ("Date", "Operation", "Debit", "Credit", *CREDO_HEADERS[4:])

        with pytest.raises(StatementParseError, match="column header"):
            parse(build_credo_xlsx(headers=renamed))
        with pytest.raises(StatementParseError, match="sheet"):
            parse(build_credo_xlsx(transactions_sheet="Movements"))
        with pytest.raises(StatementParseError, match="not an xlsx"):
            parse(b"Date;Operation;Turnover\n01.08.2026;;\n")
