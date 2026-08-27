"""The Priorbank parser against the synthetic cp1251 export.

Pure and DB-free: the parser is the one place in this scope where a file's bytes
become money, so every trap of the format that could silently produce a WRONG
number (rather than an obvious crash) is pinned here — the section boundaries,
the two thousands separators, the currency pair, the unknown-time convention and
the fee sign. What the parser does with a file it cannot read is proved at the
router level, where "no session in the database" is the half that matters.
"""

from datetime import date, time

import pytest

from budget_api.enums import StatementSection, TransactionKind
from budget_api.services.statement_import.priorbank import parse
from budget_api.services.statement_import.types import StatementParseError


class TestPriorbankParser:
    async def test_section_boundaries_and_counters(
        self, statement_csv_bytes: bytes
    ) -> None:
        """Totals and blocked lines are NOT operations, and the drops are counted.

        The whole reason this is a state machine: a dict reader would turn
        "Всего по контракту;;;;;;-27,70" into a 27.70 expense, and the blocked tail
        into two duplicates of rows that have not posted yet.
        """
        statement = parse(statement_csv_bytes)

        assert statement.currency == "BYN"
        assert (statement.period_from, statement.period_to) == (
            date(2026, 6, 1),
            date(2026, 6, 30),
        )
        assert len(statement.rows) == 7
        assert statement.rows_blocked == 2
        assert statement.rows_zero_skipped == 1
        # Named by ORDER (the contract block is titled with the CARD's mask in the
        # real file), and the file's own row order is preserved.
        assert [row.section for row in statement.rows] == (
            [StatementSection.contract.value] * 4 + [StatementSection.card.value] * 3
        )
        assert [row.row_index for row in statement.rows] == list(range(7))
        # No totals number leaked in as money.
        assert 2770 not in [row.amount_minor for row in statement.rows]

    async def test_thousands_separators_and_currency_pair(
        self, statement_csv_bytes: bytes
    ) -> None:
        """NBSP and plain space both parse; the original pair only on the PLN row.

        ``1 500,00`` (NBSP) and ``2 000,00`` (space) are the same number written
        two ways — reading either as 1.00 would understate a month by three orders
        of magnitude. The foreign row keeps BOTH sides: what the merchant charged
        (PLN) and what the account was debited (BYN), which is the bank's own rate
        arriving as a fact.
        """
        rows = parse(statement_csv_bytes).rows
        by_description = {row.description: row for row in rows}

        assert by_description["ЗАЧИСЛЕНИЕ ЗАРПЛАТЫ"].amount_minor == 150_000
        assert by_description["ВОЗВРАТ ПОКУПКИ"].amount_minor == 200_000
        assert (
            by_description["ЗАЧИСЛЕНИЕ ЗАРПЛАТЫ"].kind == TransactionKind.income.value
        )

        foreign = by_description["SKLEP WARSZAWA"]
        assert (foreign.amount_minor, foreign.kind) == (
            143_963,
            TransactionKind.expense.value,
        )
        assert (foreign.original_amount_minor, foreign.original_currency) == (
            180_000,
            "PLN",
        )
        # Every domestic row keeps the pair NULL/NULL — "priced in the account's
        # own currency" has exactly one spelling.
        assert [
            row.original_currency for row in rows if row.description != "SKLEP WARSZAWA"
        ] == [None] * 6

    async def test_unknown_time_fee_and_transfer_flag(
        self, statement_csv_bytes: bytes
    ) -> None:
        """``00:00:00`` is "unknown", the fee keeps its sign, P2P wording flags."""
        rows = parse(statement_csv_bytes).rows
        by_description = {row.description: row for row in rows}

        assert by_description["МАГАЗИН ПРОДУКТЫ"].txn_time == time(10, 15)
        # Not midnight: the bank prints 00:00:00 when it does not know the clock,
        # and storing that as a time would invent a fact.
        assert [row.txn_time for row in rows if row.description == "PAYBYCARD.BY"] == [
            None,
            None,
        ]

        transfer_row = by_description["CH Debit PETROV P."]
        # Sign as in the FILE: a fee is money out, a money-back money in.
        assert transfer_row.fee_minor == -150
        assert transfer_row.possible_transfer is True
        assert [row.fee_minor for row in rows if row.fee_minor] == [-150]
        assert [row.description for row in rows if row.possible_transfer] == [
            "CH Debit PETROV P."
        ]

    async def test_not_cp1251_is_refused(self, statement_csv_bytes: bytes) -> None:
        """The same content as UTF-8 is not this format — and never half-parsed.

        cp1251 is a single-byte codec, so a UTF-8 file does not necessarily fail to
        DECODE; it decodes to mojibake in which none of the format's landmarks
        exist. Either way the answer is a refusal, never a session full of garbage.
        """
        utf8_bytes = statement_csv_bytes.decode("cp1251").encode("utf-8")

        with pytest.raises(StatementParseError):
            parse(utf8_bytes)

    async def test_a_drifted_date_format_inside_a_section_is_refused(
        self, statement_csv_bytes: bytes
    ) -> None:
        """An ISO date where the format prints ``dd.mm.yyyy`` stops the import.

        Different branch from the header check above: the grid is intact, the LINE
        is the one that drifted. Skipping it (which is what "ignore what you do not
        recognize" would do, and what the format needs OUTSIDE a section) would
        answer 201 with a preview of fewer rows than the file has — or, once the
        whole export switches over, of none at all.
        """
        drifted = statement_csv_bytes.decode("cp1251").replace(
            "02.06.2026 10:15:00", "2026-06-02 10:15:00", 1
        )

        with pytest.raises(StatementParseError):
            parse(drifted.encode("cp1251"))

    async def test_drifted_column_header_is_refused(
        self, statement_csv_bytes: bytes
    ) -> None:
        """A renamed column stops the import instead of shifting every value.

        The parser reads cells POSITIONALLY, so a reordered export would keep
        parsing happily and store the fee as the turnover. The header check is the
        only thing standing between that and the user's money.
        """
        drifted = statement_csv_bytes.decode("cp1251").replace(
            "Дата транзакции;Операция;", "Дата операции;Описание;", 1
        )

        with pytest.raises(StatementParseError):
            parse(drifted.encode("cp1251"))
