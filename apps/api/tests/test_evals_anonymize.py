"""The anonymizer's rules, on SYNTHETIC rows only.

Never the owner's real export: this file is committed, his rows are not. The
inputs below are written to look like his (the same bookkeeping phrases, the same
relation words) without being his.

Why these two tests exist at all: the rules here are the only thing standing
between a private CSV and a committed dataset, and they are regexes — the class
of code that breaks silently when someone "simplifies" one of them.
"""

from evals.anonymize import DROP_REASONS, RawRow, build_text, convert


def _row(
    *,
    merchant: str = "",
    note: str = "",
    category: str = "Продукты",
    kind: str = "expense",
    amount_minor: str = "1234",
    currency: str = "BYN",
    country: str = "",
) -> RawRow:
    return RawRow(
        kind=kind,
        amount_minor=amount_minor,
        currency=currency,
        merchant=merchant,
        note=note,
        country=country,
        category=category,
    )


class TestText:
    def test_merchant_wins_and_a_note_is_cut_to_its_first_clean_clause(self) -> None:
        # A merchant is the production shape of `text` and is kept verbatim,
        # city suffix included.
        assert build_text("Żabka, Варшава", "Пиво, вторая покупка") == "Żabka, Варшава"
        # No merchant: the FIRST clause of the note, so the owner's prose after
        # the comma/dot/colon/parenthesis never reaches the dataset.
        assert build_text("", "Польский, 3 занятия по 50 BYN") == "Польский"
        assert build_text("", "Подоходный налог за июль (доход $5000)") == (
            "Подоходный налог за июль"
        )
        # Digit runs of 4+ (card tails, phones, terminal ids) are cut out
        # wherever they sit; the trailing id marker goes with them.
        assert build_text("Павильон N700114", "") == "Павильон"
        assert build_text("", "Оплата карты 5536913812345678") == "Оплата карты"
        # A number written WITH separators has no run of 4+ digits in it, and is
        # the shape a phone or an account is actually typed in.
        assert build_text("", "Возврат на телефон +375 29 123 45 67") == (
            "Возврат на телефон"
        )
        # Bookkeeping phrases are removed, and a text that was ONLY bookkeeping
        # comes back empty (the caller drops such a row).
        assert build_text("", "Сигареты. Дата — допущение") == "Сигареты"
        assert build_text("", "Коммуналка, платёж 2 из 3") == "Коммуналка"
        assert build_text("", "Сковородка. РАЗОВАЯ") == "Сковородка"
        assert build_text("", "Чек 110.63: Fanta, вода") == ""
        # A leftover price is not a merchant: no letters, no row.
        assert build_text("", "7.99 PLN. Польша") == ""


class TestDrops:
    def test_person_rows_and_unlabelled_rows_are_dropped_and_counted(self) -> None:
        """A relation word drops the WHOLE row, with its reason in the summary.

        Word-stripping is the tempting alternative and the wrong one: "Перевод
        девушке" minus the word is "Перевод", a label-free noun that teaches
        nothing and reads as if it had been checked.
        """
        outcome = convert(
            [
                _row(merchant="Biedronka", note="Продукты"),
                _row(note="Перевод девушке", category="Подарки"),
                _row(merchant="Пекарня Дражина", note="Торт девушке"),
                _row(merchant="Тестов Тест", note="", category="Прочее"),
                _row(note="Зачисление P2P", category="", kind="income"),
                _row(note="Чек 122.11: салатник", category="Дом и быт"),
            ]
        )

        # Kept: the clean merchant row, and the merchant row whose RELATION word
        # sits in a note the dataset never carries.
        assert [entry.text for entry in outcome.entries] == [
            "Biedronka",
            "Пекарня Дражина",
        ]
        assert [entry.id for entry in outcome.entries] == ["r1", "r2"]
        assert outcome.dropped == {
            "person_or_relation": 2,  # the note-sourced transfer, and the name
            "empty_label": 1,
            "empty_text": 1,
        }
        assert set(outcome.dropped) <= set(DROP_REASONS)
        # Every raw row is accounted for in the owner's review table.
        assert len(outcome.review) == 6
        assert [row.action for row in outcome.review].count("kept") == 2
