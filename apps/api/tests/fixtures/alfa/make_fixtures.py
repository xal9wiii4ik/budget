"""One-off generator of the three committed Alfa-Bank PDF fixtures (amendment A2).

Run it BY HAND, never from the suite, and never from the project environment:

    cd apps/api
    uv run --with fpdf2 --isolated --no-project python -I \
        tests/fixtures/alfa/make_fixtures.py \
        --font "/System/Library/Fonts/Supplemental/Arial.ttf"

Why a script and not a dev dependency (A2): the suite and the evals drive TEXT
(D-E2) and exactly ONE pytest opens a PDF, so a PDF writer in `pyproject.toml`
would be a permanent dependency bought for three files that change once a year.
`--isolated --no-project python -I` keeps fpdf2 out of the project environment and
out of `uv.lock`; the committed PDFs are the artefact.

Everything in here is INVENTED. The real statement this layout was read from
(`.tasks/pdf-reconcile/real-alfa-local.pdf`) is the owner's own and is never
copied, quoted or committed: the holder, the account number, every merchant,
every amount and every date below are made up, and only the LABELS, the column
order and the number spelling are the real format's (`sample-structure.md`).

Three files, each a whole statement:

* `alfa_good.pdf` — two pages, 25 operations, a header whose "Баланс на начало"
  label WRAPS, one FX operation with a RUB original pair, one `Перевод` and one
  `Зачисление перевода` (both must read as `possible_transfer`), a salary
  `Зачисление` whose description carries two dates and a document number INSIDE
  it (the date trap), one description long enough that the PDF wraps it onto a
  second line (which the extractor must join back), one zero-turnover line, and a
  column header repeated on page 2. Its arithmetic closes: the printed anchors are
  computed from the operations, so the self-check PASSES.
* `alfa_mismatch.pdf` — the same statement with the printed closing balance moved
  by `MISMATCH_MINOR` minor units: the self-check must fail with `balance` and
  show both numbers.
* `alfa_llmfail.pdf` — the same statement with `LLMFAIL` in one description, the
  marker `llm/fake.py` turns into a provider outage.
"""

from __future__ import annotations

import argparse
from decimal import Decimal
from pathlib import Path

from fpdf import FPDF

#: The fake holder and account of the fixtures. Shaped like the real header's PII
#: block ON PURPOSE: that block is what the extractor must never pass on, and a
#: fixture without one could not prove it.
HOLDER = "ИВАНОВ ИВАН ИВАНОВИЧ"
PASSPORT = "паспорт AB1234567, выдан 01.01.2015"
ADDRESS = "г. Минск, ул. Придуманная, д. 1, кв. 2"
IBAN = "BY00ALFA00000000000000000000"
CARD = "Альфа-Смарт(5***********1234)"

CURRENCY = "BYN"
PERIOD_FROM = "01.09.2026"
PERIOD_TO = "30.09.2026"
OPENING = Decimal("1000.00")

#: How far `alfa_mismatch.pdf`'s printed closing balance is from the truth, in
#: minor units. A test asserts this exact difference, so it is part of the
#: fixture's contract.
MISMATCH_MINOR = 1250

#: ``(date, description, signed amount, original amount, original currency)``.
#: The amounts are the account's own currency; the original pair is ``None`` for
#: every line the bank prints twice (which is every non-FX line).
OPERATIONS: tuple[tuple[str, str, str, str | None, str | None], ...] = (
    (
        "01.09.2026",
        "10000001 MINSK Покупка товара / получение услуг GASTRONOM NA UGLU",
        "-24.37",
        None,
        None,
    ),
    (
        "02.09.2026",
        "10000002 MINSK Покупка товара / получение услуг APTEKA 9 MINUT",
        "-13.9",
        None,
        None,
    ),
    (
        "02.09.2026",
        "10000003 ONLINE SERVICE InSync (ERIP)",
        "-9",
        None,
        None,
    ),
    (
        "03.09.2026",
        "Зачисление заработной платы за август 2026 согласно ведомости № 114 от "
        "31.08.2026, перечислено 03.09.2026 организацией ООО ПРИДУМАННЫЕ РЕШЕНИЯ",
        "1500",
        None,
        None,
    ),
    (
        "03.09.2026",
        "10000004 g MINSK Покупка товара / получение услуг KAFE NA TESTOVOY ULICE",
        "-32.5",
        None,
        None,
    ),
    (
        "04.09.2026",
        "10000005 ALMATY Покупка товара / получение услуг ONLINE SHOP KZ",
        "-35.5",
        "-4500",
        "RUB",
    ),
    (
        "05.09.2026",
        "Перевод средств на помощь ребенку М ария Придуманная",
        "-120",
        None,
        None,
    ),
    (
        "06.09.2026",
        "10000006 MINSK Покупка товара / получение услуг SUPERMARKET VESNA",
        "-56.12",
        None,
        None,
    ),
    (
        "07.09.2026",
        "Зачисление перевода Пётр Придуманный 07.09.2026",
        "80",
        None,
        None,
    ),
    (
        "08.09.2026",
        "10000007 MINSK Покупка товара / получение услуг ZAPRAVKA 24",
        "-70",
        None,
        None,
    ),
    (
        "09.09.2026",
        "10000008 ONLINE SERVICE Покупка товара / получение услуг PODPISKA PLUS",
        "-9.99",
        None,
        None,
    ),
    (
        "10.09.2026",
        "10000009 MINSK Покупка товара / получение услуг CVETY U DOMA",
        "-45",
        None,
        None,
    ),
    (
        "11.09.2026",
        "Зачисление бонусов (подарок) соглас но условиям программы лояльности "
        '"Альфа-Бонус"',
        "3.4",
        None,
        None,
    ),
    (
        "12.09.2026",
        "10000010 G. MINSK Покупка товара / получение услуг KNIGI I KANCELYARIYA",
        "-18.6",
        None,
        None,
    ),
    (
        "13.09.2026",
        "10000011 MINSK Покупка товара / получение услуг ZERO SHOP",
        "0",
        None,
        None,
    ),
    (
        "14.09.2026",
        "10000012 MINSK Покупка товара / получение услуг BOLSHOY GIPERMARKET "
        "NA PROSPEKTE PRIDUMANNOM DOM TRIDCAT SEM KORPUS DVA SEKCIYA PYAT",
        "-203.11",
        None,
        None,
    ),
    (
        "15.09.2026",
        "10000013 MINSK Покупка товара / получение услуг MASTERSKAYA OBUVI",
        "-27",
        None,
        None,
    ),
    (
        "16.09.2026",
        "10000014 MINSK Покупка товара / получение услуг STOLOVAYA NOMER PYAT",
        "-11.45",
        None,
        None,
    ),
    (
        "17.09.2026",
        "Вознаграждение за ведение счёта",
        "-2.5",
        None,
        None,
    ),
    (
        "18.09.2026",
        "10000015 MINSK Покупка товара / получение услуг VELOREMONT",
        "-64.8",
        None,
        None,
    ),
    (
        "19.09.2026",
        "10000016 ONLINE SERVICE Покупка товара / получение услуг BILETY ONLINE",
        "-150",
        None,
        None,
    ),
    (
        "20.09.2026",
        "Зачисление возврата от продавца по операции от 14.09.2026",
        "203.11",
        None,
        None,
    ),
    (
        "21.09.2026",
        "10000017 MINSK Покупка товара / получение услуг HIMCHISTKA SVEZHEST",
        "-33.33",
        None,
        None,
    ),
    (
        "22.09.2026",
        "10000018 MINSK Покупка товара / получение услуг PEKARNYA U PARKA",
        "-7.8",
        None,
        None,
    ),
    (
        "23.09.2026",
        "10000019 MINSK Покупка товара / получение услуг SERVIS TELEFONOV",
        "-89.9",
        None,
        None,
    ),
)

#: Where page 2 starts — the bank prints the column titles again there.
PAGE_BREAK_AFTER = 13

#: The operations table's titles, as `pypdf` reads them out of the real file:
#: the first two in one line, the two money columns wrapped into fragments.
TABLE_HEADER = (
    "Дата Примечание Сумма в",
    "валюте",
    "счета",
    "Сумма в",
    "валюте",
    "операции",
)

_FONT = "alfa"


def money(value: Decimal) -> str:
    """The bank's number spelling: decimal point, trailing zeros dropped."""
    text = format(value.normalize(), "f")
    return text


def line_of(operation: tuple[str, str, str, str | None, str | None]) -> str:
    """One operation as the four-column table prints it."""
    day, description, amount, original, original_currency = operation
    second = amount if original is None else original
    code = CURRENCY if original_currency is None else original_currency
    return f"{day} {description} {amount} {CURRENCY} {second} {code}"


def totals() -> tuple[Decimal, Decimal, Decimal]:
    """Income, expense (negative) and the closing balance the rows really give."""
    amounts = [Decimal(operation[2]) for operation in OPERATIONS]
    income = sum((value for value in amounts if value > 0), Decimal(0))
    expense = sum((value for value in amounts if value < 0), Decimal(0))
    return income, expense, OPENING + income + expense


def header_lines(closing: Decimal, income: Decimal, expense: Decimal) -> list[str]:
    """The header block, label order and wrapping of the real file."""
    return [
        'ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "АЛЬФА-БАНК"',
        "220000, г. Минск, ул. Придуманная, 1, тел. 000 000 00 00",
        "Выписка по операциям, совершенным по банковскому счету Текущий счёт, "
        f"{HOLDER}",
        f"Клиент {HOLDER}",
        f"Документ, удостоверяющий личность {PASSPORT}",
        f"Адрес регистрации {ADDRESS}",
        f"Счёт {IBAN}",
        f"Валюта счёта {CURRENCY}",
        "Тип счёта Текущий счёт",
        "Дата открытия 01.02.2020",
        "Процентная ставка, текущая 0.001%",
        f"Период {PERIOD_FROM} - {PERIOD_TO}",
        "Дата и время формирования выписки 01.10.2026, 09:15",
        f"Доступный остаток {money(closing)} {CURRENCY}",
        f"Кредитный лимит 0 {CURRENCY}",
        f"Неснижаемый остаток 0 {CURRENCY}",
        # The label WRAPS in the real file, which is why every anchor is searched
        # over the joined header text and not per line.
        "Баланс на начало",
        f"периода {money(OPENING)} {CURRENCY}",
        f"Баланс на конец периода {money(closing)} {CURRENCY}",
        f"Приход {money(income)} {CURRENCY}",
        f"Расход {money(expense)} {CURRENCY}",
        f"Привязанные карты {CARD}",
        f"Выписка за период {PERIOD_FROM} - {PERIOD_TO}",
    ]


class Statement(FPDF):
    """A2's PDF writer: one text line per header line and per operation.

    `multi_cell` is what makes the long description WRAP visually, which is the
    case the extractor's continuation rule exists for (ruling FLAG-2): the real
    file's producer joins such a line back together, this one does not, and the
    parser must handle both.
    """

    def __init__(self, font_path: Path, pages: int) -> None:
        super().__init__(format="A4")
        self.pages_total = pages
        self.set_auto_page_break(auto=False)
        self.add_font(_FONT, "", str(font_path))
        self.set_font(_FONT, size=8)
        self.set_margins(10, 10, 10)

    def footer(self) -> None:
        self.set_font(_FONT, size=8)
        self.set_y(-12)
        self.cell(
            0,
            4,
            f"{self.page_no()} / {self.pages_total}",
            align="C",
            new_x="LMARGIN",
            new_y="NEXT",
        )

    def write_lines(self, lines: list[str]) -> None:
        for line in lines:
            self.multi_cell(0, 4.2, line, new_x="LMARGIN", new_y="NEXT")


def build(
    path: Path, font_path: Path, *, closing_shift_minor: int = 0, fail: bool = False
) -> None:
    income, expense, closing = totals()
    printed_closing = closing + Decimal(closing_shift_minor) / Decimal(100)
    operations = list(OPERATIONS)
    if fail:
        day, description, amount, original, code = operations[2]
        operations[2] = (day, f"{description} LLMFAIL", amount, original, code)

    pdf = Statement(font_path, pages=2)
    pdf.add_page()
    pdf.write_lines(header_lines(printed_closing, income, expense))
    pdf.write_lines(list(TABLE_HEADER))
    pdf.write_lines([line_of(operation) for operation in operations[:PAGE_BREAK_AFTER]])
    pdf.add_page()
    pdf.write_lines(list(TABLE_HEADER))
    pdf.write_lines([line_of(operation) for operation in operations[PAGE_BREAK_AFTER:]])
    pdf.output(str(path))
    print(f"{path.name}: {path.stat().st_size} bytes, closing {money(printed_closing)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--font",
        required=True,
        help="path to a TTF that covers Cyrillic (e.g. "
        "/System/Library/Fonts/Supplemental/Arial.ttf)",
    )
    parser.add_argument(
        "--out",
        default=str(Path(__file__).parent),
        help="directory the three PDFs are written to (default: next to this script)",
    )
    args = parser.parse_args()
    font_path = Path(args.font)
    out = Path(args.out)
    build(out / "alfa_good.pdf", font_path)
    build(out / "alfa_mismatch.pdf", font_path, closing_shift_minor=MISMATCH_MINOR)
    build(out / "alfa_llmfail.pdf", font_path, fail=True)


if __name__ == "__main__":
    main()
