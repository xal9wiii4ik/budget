"""Generate the synthetic Alfa-PDF statements the extraction eval is scored on.

From ``apps/api``::

    uv run python evals/gen_alfa.py --seed 20261014 --statements 12

writes ``dataset/synthetic-alfa-v1/statements.jsonl`` — one JSON object per
statement: the TEXT ``alfa_pdf.text_lines`` would hand over for a real file, plus
the gold row behind every operation line.

**Everything here is invented and nothing real is ever read.** The owner's own
statement (``.tasks/pdf-reconcile/real-alfa-local.pdf``) is gitignored and this
generator never opens it: only the LABELS, the column order, the number spelling
and the description shapes are the real format's (``sample-structure.md``), and
every merchant, person, amount and date below is made up. That is also why the
dataset is committed — a number in ``reports/extract-*`` must be reproducible by
anyone, with no file nobody else has.

**The anchors are consistent BY CONSTRUCTION.** The operations are generated
first; then ``Приход`` is Σ income, ``Расход`` is Σ expense and
``Баланс на конец периода`` is ``opening + income - expense``. No total is ever
written independently of the rows, so a generated statement CANNOT fail the
extractor's self-check unless the extraction itself is wrong — which is the one
thing the eval is trying to measure. ``--mismatch-share`` is the deliberate
exception: it DROPS one operation line from the text while leaving it in the
printed totals, so the statement must come out ``self_check.failed == "balance"``.

What this generator deliberately does NOT contain: the traps
``tests/helpers.build_alfa_statement_text`` holds (an unreadable anchor, a
zero-turnover line, a half FX pair, three decimals in a two-exponent currency).
Those are REFUSALS, pinned by the unit suite; a dataset is for measuring
accuracy on statements that are supposed to work.
"""

import logging
import sys
from pathlib import Path

if __package__ in {None, ""}:
    # See ``run.py``: the documented command is the script path, and the module
    # is also imported as ``evals.gen_alfa`` by the regression test.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import argparse
import calendar
import json
import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from budget_api.enums import TransactionKind
from evals.common import DATASET_DIR

logger = logging.getLogger("evals.gen_alfa")

DATASET_NAME = "synthetic-alfa-v1"
DATASET_PATH = DATASET_DIR / DATASET_NAME / "statements.jsonl"

#: The seed and the size of the COMMITTED set. Changing either re-cuts the
#: dataset, which invalidates ``replay/fake-fake-extract-alfa-v1.jsonl`` (the
#: lines are part of the replay key) — re-record it in the same pass.
DEFAULT_SEED = 20261014
DEFAULT_STATEMENTS = 12
#: Three of the twelve committed statements hide a line from the text while
#: keeping it in the totals, so the report measures the self-check too.
DEFAULT_MISMATCH_SHARE = 0.25

CURRENCY = "BYN"
_EXPONENT = 100

#: The fake holder and account: shaped like the real header's PII block ON
#: PURPOSE — that block is what the extractor must never pass on to the prompt,
#: the log or the database, and a statement without one could not prove it.
HOLDER = "ИВАНОВ ИВАН ИВАНОВИЧ"
PASSPORT = "паспорт AB1234567, выдан 01.01.2015"
ADDRESS = "г. Минск, ул. Придуманная, д. 1, кв. 2"
IBAN = "BY00ALFA00000000000000000000"
CARD = "Альфа-Смарт(5***********1234)"

#: Invented merchants. None of them ends in ``<number> <three capitals>``: that
#: shape at the END of a description would be read as the line's amount block.
MERCHANTS = (
    "GASTRONOM NA UGLU",
    "APTEKA ROMASHKA",
    "KAFE NA TESTOVOY ULICE",
    "SUPERMARKET VESNA",
    "ZAPRAVKA KOLESO",
    "CVETY U DOMA",
    "KNIGI I KANCELYARIYA",
    "MASTERSKAYA OBUVI",
    "STOLOVAYA NOMER PYAT",
    "VELOREMONT NA DVORE",
    "BILETY ONLINE",
    "HIMCHISTKA SVEZHEST",
    "PEKARNYA U PARKA",
    "SERVIS TELEFONOV",
    "ZOOMAGAZIN LAPKI",
    "OPTIKA YASNO",
    "STROYMARKET GVOZD",
    "PODPISKA PLUS",
)
#: The city token of a card purchase, spelled four ways in the real file.
CITIES = ("MINSK", "G. MINSK", "g MINSK", "ONLINE SERVICE", "ALMATY")
#: ERIP services — the payment system's own wording.
SERVICES = ("InSync", "Gorvodokanal", "Minskenergo", "Internet Dom")
EMPLOYERS = ("ПРИДУМАННЫЕ РЕШЕНИЯ", "ТЕСТОВЫЕ СИСТЕМЫ", "ВЫМЫШЛЕННЫЙ СОФТ")
PEOPLE = ("Мария Придуманная", "Пётр Вымышленный", "Анна Тестовая", "М ария Иванова")
#: The operation's own currency when the merchant charged abroad.
FX_CURRENCIES = ("RUB", "USD", "EUR")
#: Everything after this phrase is the merchant name (the fake reads it too).
MERCHANT_PHRASE = "Покупка товара / получение услуг"

MONTHS_RU = (
    "январь",
    "февраль",
    "март",
    "апрель",
    "май",
    "июнь",
    "июль",
    "август",
    "сентябрь",
    "октябрь",
    "ноябрь",
    "декабрь",
)

#: The operations table's titles, as ``pypdf`` reads them out of the real file:
#: the first two in one line, the two money columns wrapped into fragments.
TABLE_HEADER = (
    "Дата Примечание Сумма в",
    "валюте",
    "счета",
    "Сумма в",
    "валюте",
    "операции",
)


@dataclass(frozen=True)
class Operation:
    """One generated operation — the line to print and the gold behind it."""

    day: date
    description: str
    #: Signed, in the statement currency's minor units: negative = expense.
    signed_minor: int
    #: The operation's own currency, when it differs. Signed like the first.
    original_minor: int | None
    original_currency: str | None
    #: What the merchant column SHOULD say: a name, or ``""`` for a line that
    #: names none (the extractor's own spelling — never ``None``, see
    #: ``types.display_name``).
    merchant: str
    #: ``True`` for the one line printed as TWO physical lines: ``pypdf`` wrapped
    #: it, and the extractor must join it back (ruling FLAG-2).
    wrapped: bool = False
    #: ``True`` for a line that may be hidden from the text by
    #: ``--mismatch-share`` (a plain one: hiding the wrapped line would orphan
    #: its continuation, and hiding an anchor-shaped one is a different test).
    droppable: bool = True

    @property
    def kind(self) -> str:
        if self.signed_minor < 0:
            return TransactionKind.expense.value
        return TransactionKind.income.value


def money(minor: int) -> str:
    """The bank's number spelling: decimal point, trailing zeros dropped."""
    sign = "-" if minor < 0 else ""
    whole, fraction = divmod(abs(minor), _EXPONENT)
    tail = f"{fraction:02d}".rstrip("0")
    return f"{sign}{whole}.{tail}" if tail else f"{sign}{whole}"


def day_text(value: date) -> str:
    return value.strftime("%d.%m.%Y")


def line_of(operation: Operation) -> str:
    """One operation as the four-column table prints it, on ONE line."""
    second = (
        operation.signed_minor
        if operation.original_minor is None
        else operation.original_minor
    )
    code = operation.original_currency or CURRENCY
    return (
        f"{day_text(operation.day)} {operation.description}"
        f" {money(operation.signed_minor)} {CURRENCY} {money(second)} {code}"
    )


def physical_lines(operation: Operation) -> list[str]:
    """The line as the PDF text carries it: one line, or a wrapped pair.

    The split is on a single space of the description, so joining the pair with
    one space (what the extractor does) gives :func:`line_of` back byte for byte.
    """
    whole = line_of(operation)
    if not operation.wrapped:
        return [whole]
    words = whole.split(" ")
    cut = len(words) // 2
    return [" ".join(words[:cut]), " ".join(words[cut:])]


def header_lines(
    *,
    period_from: date,
    period_to: date,
    opening_minor: int,
    closing_minor: int,
    income_minor: int,
    expense_minor: int,
) -> list[str]:
    """The header block: label order and wrapping of the real file."""
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
        f"Период {day_text(period_from)} - {day_text(period_to)}",
        f"Дата и время формирования выписки {day_text(period_to)}, 09:15",
        f"Доступный остаток {money(closing_minor)} {CURRENCY}",
        f"Кредитный лимит 0 {CURRENCY}",
        f"Неснижаемый остаток 0 {CURRENCY}",
        # The label WRAPS in the real file, which is why every anchor is searched
        # over the JOINED header text and not per line.
        "Баланс на начало",
        f"периода {money(opening_minor)} {CURRENCY}",
        f"Баланс на конец периода {money(closing_minor)} {CURRENCY}",
        f"Приход {money(income_minor)} {CURRENCY}",
        f"Расход {money(expense_minor)} {CURRENCY}",
        f"Привязанные карты {CARD}",
        f"Выписка за период {day_text(period_from)} - {day_text(period_to)}",
    ]


def _amount(rng: random.Random, low: int, high: int) -> int:
    """A plausible amount in minor units, with the real file's decimal shapes.

    One in three is a whole number of units and one in three has a single
    decimal — the spellings ``9`` and ``-13.9``, which are what the bank prints
    (and what a naive ``\\d+\\.\\d\\d`` reader would miss).

    NEVER zero, whatever ``low`` is: the extractor DROPS a zero-turnover line
    (nothing moved — the Priorbank/Credo rule), so a rounded-down zero here
    would make a gold row claim a row that cannot exist.
    """
    minor = rng.randrange(low, high)
    shape = rng.randrange(3)
    if shape == 0 and minor >= _EXPONENT:
        return minor - minor % _EXPONENT
    if shape == 1 and minor >= 10:
        return minor - minor % 10
    return minor


def _card_purchase(rng: random.Random, day: date, *, long: bool = False) -> Operation:
    merchant = rng.choice(MERCHANTS)
    if long:
        merchant = (
            f"{merchant} NA PROSPEKTE PRIDUMANNOM DOM TRIDCAT SEM KORPUS DVA"
            " SEKCIYA PYAT"
        )
    return Operation(
        day=day,
        description=(
            f"{rng.randrange(10_000_000, 99_999_999)} {rng.choice(CITIES)}"
            f" {MERCHANT_PHRASE} {merchant}"
        ),
        signed_minor=-_amount(rng, 150, 25_000),
        original_minor=None,
        original_currency=None,
        merchant=merchant,
        wrapped=long,
        droppable=not long,
    )


def _long_card_purchase(rng: random.Random, day: date) -> Operation:
    """The one operation printed as TWO physical lines (see :class:`Operation`)."""
    return _card_purchase(rng, day, long=True)


def _fx_purchase(rng: random.Random, day: date) -> Operation:
    merchant = rng.choice(MERCHANTS)
    code = rng.choice(FX_CURRENCIES)
    signed = -_amount(rng, 500, 15_000)
    # The bank's own rate, as a FACT on the line: we never convert, so any
    # plausible pair is a valid statement.
    factor = {"RUB": 30, "USD": 1, "EUR": 1}[code]
    original = -max(1, abs(signed) * factor // 3)
    return Operation(
        day=day,
        description=(
            f"{rng.randrange(10_000_000, 99_999_999)} {rng.choice(CITIES)}"
            f" {MERCHANT_PHRASE} {merchant}"
        ),
        signed_minor=signed,
        original_minor=original,
        original_currency=code,
        merchant=merchant,
    )


def _erip(rng: random.Random, day: date) -> Operation:
    service = rng.choice(SERVICES)
    return Operation(
        day=day,
        description=(
            f"{rng.randrange(10_000_000, 99_999_999)} ONLINE SERVICE {service} (ERIP)"
        ),
        signed_minor=-_amount(rng, 500, 12_000),
        original_minor=None,
        original_currency=None,
        # The service IS the counterparty here, so a correct reading names it.
        # The fake's regex does not (it only knows the card-purchase phrase),
        # which is exactly why merchant accuracy is reported on its own.
        merchant=f"{service} (ERIP)",
    )


def _salary(rng: random.Random, day: date) -> Operation:
    # Three dates and a document number INSIDE the description: the date trap
    # the prompt is explicit about ("never a date quoted inside the description").
    statement_day = day.replace(day=1)
    return Operation(
        day=day,
        description=(
            f"Зачисление заработной платы за {MONTHS_RU[statement_day.month - 1]}"
            f" 2026 согласно ведомости № {rng.randrange(100, 999)}"
            f" от {day_text(statement_day)}, перечислено {day_text(day)}"
            f" организацией ООО {rng.choice(EMPLOYERS)}"
        ),
        signed_minor=_amount(rng, 90_000, 250_000),
        original_minor=None,
        original_currency=None,
        # A payroll credit names an employer, not a merchant.
        merchant="",
        droppable=False,
    )


def _bonus(rng: random.Random, day: date) -> Operation:
    return Operation(
        day=day,
        description=(
            "Зачисление бонусов (подарок) соглас но условиям программы"
            ' лояльности "Альфа-Бонус"'
        ),
        signed_minor=_amount(rng, 50, 900),
        original_minor=None,
        original_currency=None,
        merchant="",
    )


def _transfer_out(rng: random.Random, day: date) -> Operation:
    person = rng.choice(PEOPLE)
    return Operation(
        day=day,
        description=f"Перевод средств на помощь ребенку {person}",
        signed_minor=-_amount(rng, 2_000, 30_000),
        original_minor=None,
        original_currency=None,
        merchant=person,
    )


def _transfer_in(rng: random.Random, day: date) -> Operation:
    person = rng.choice(PEOPLE)
    return Operation(
        day=day,
        description=f"Зачисление перевода {person} {day_text(day)}",
        signed_minor=_amount(rng, 2_000, 40_000),
        original_minor=None,
        original_currency=None,
        merchant=person,
    )


def _fee(rng: random.Random, day: date) -> Operation:
    return Operation(
        day=day,
        description="Вознаграждение за ведение счёта",
        signed_minor=-_amount(rng, 100, 500),
        original_minor=None,
        original_currency=None,
        merchant="",
    )


_Builder = Callable[[random.Random, date], Operation]


def operations(
    rng: random.Random, period_from: date, period_to: date
) -> list[Operation]:
    """Every shape ``sample-structure.md`` records, on distinct days, in order."""
    days = sorted(
        rng.sample(range(1, (period_to - period_from).days + 2), rng.randrange(14, 21))
    )
    dates = [period_from.replace(day=offset) for offset in days]
    builders: list[_Builder] = [
        _salary,
        _erip,
        _transfer_out,
        _transfer_in,
        _bonus,
        _fee,
        _fx_purchase,
        _long_card_purchase,
    ]
    # The fixed shapes land on the first days; the rest are card purchases. Their
    # ORDER in the file is the date order the bank prints, which is what the
    # extractor's ``row_index`` and the gold rows are aligned by.
    picked = rng.sample(range(len(dates)), len(builders))
    built: dict[int, Operation] = {
        index: builders[position](rng, dates[index])
        for position, index in enumerate(picked)
    }
    return [
        built.get(index) or _card_purchase(rng, day) for index, day in enumerate(dates)
    ]


def statement_text(
    ops: Sequence[Operation],
    *,
    period_from: date,
    period_to: date,
    opening_minor: int,
    closing_minor: int,
    income_minor: int,
    expense_minor: int,
) -> list[str]:
    """The whole file as ``text_lines`` would return it, page furniture included."""
    lines = header_lines(
        period_from=period_from,
        period_to=period_to,
        opening_minor=opening_minor,
        closing_minor=closing_minor,
        income_minor=income_minor,
        expense_minor=expense_minor,
    )
    lines += TABLE_HEADER
    half = len(ops) // 2
    for operation in ops[:half]:
        lines += physical_lines(operation)
    # Page 2: the footer of page 1, then the column titles AGAIN (the real file
    # repeats them), then the rest.
    lines.append("1 / 2")
    lines += TABLE_HEADER
    for operation in ops[half:]:
        lines += physical_lines(operation)
    lines.append("2 / 2")
    return lines


def gold_row(key: str, operation: Operation) -> dict[str, Any]:
    original = operation.original_minor
    return {
        "key": key,
        "date": operation.day.isoformat(),
        "kind": operation.kind,
        "amount_minor": abs(operation.signed_minor),
        "original_amount_minor": None if original is None else abs(original),
        "original_currency": operation.original_currency,
        "merchant": operation.merchant,
    }


def statement(index: int, rng: random.Random, *, mismatch: bool) -> dict[str, Any]:
    """One generated statement: text + anchors + gold, consistent by construction."""
    month = index % 12 + 1
    year = 2026 - index // 12
    period_from = date(year, month, 1)
    period_to = date(year, month, calendar.monthrange(year, month)[1])
    ops = operations(rng, period_from, period_to)
    income_minor = sum(op.signed_minor for op in ops if op.signed_minor > 0)
    expense_minor = sum(op.signed_minor for op in ops if op.signed_minor < 0)
    opening_minor = _amount(rng, 20_000, 300_000)
    # NEVER drawn independently: this is what makes a generated statement
    # unable to fail the self-check by accident.
    closing_minor = opening_minor + income_minor + expense_minor

    printed = list(ops)
    if mismatch:
        hidden = next(
            position
            for position, operation in reversed(list(enumerate(ops)))
            if operation.droppable
        )
        # The line disappears from the TEXT and stays in the totals, so the
        # extractor's rows cannot add up: self_check.failed == "balance".
        printed = [op for position, op in enumerate(ops) if position != hidden]

    lines = statement_text(
        printed,
        period_from=period_from,
        period_to=period_to,
        opening_minor=opening_minor,
        closing_minor=closing_minor,
        income_minor=income_minor,
        expense_minor=expense_minor,
    )
    return {
        "id": f"s{index + 1:02d}",
        "currency": CURRENCY,
        "period": [period_from.isoformat(), period_to.isoformat()],
        "opening_minor": opening_minor,
        "closing_minor": closing_minor,
        "income_minor": income_minor,
        "expense_minor": expense_minor,
        "lines": lines,
        "gold_rows": [
            gold_row(f"l{position}", operation)
            for position, operation in enumerate(printed)
        ],
        "expect_self_check": "failed" if mismatch else "passed",
    }


def generate(
    *, seed: int, statements: int, mismatch_share: float
) -> list[dict[str, Any]]:
    """The whole dataset. Same seed and size ⇒ byte-identical output."""
    if statements < 1:
        raise ValueError("--statements must be at least 1")
    if not 0.0 <= mismatch_share < 1.0:
        raise ValueError("--mismatch-share must be in [0, 1)")
    rng = random.Random(seed)
    broken = round(statements * mismatch_share)
    # The LAST n statements carry the defect, so growing the set does not move
    # which of the earlier ones is broken.
    return [
        statement(index, rng, mismatch=index >= statements - broken)
        for index in range(statements)
    ]


def write(rows: Sequence[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows
    )
    path.write_text(body, encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate the synthetic Alfa statement dataset (extraction eval)."
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--statements", type=int, default=DEFAULT_STATEMENTS)
    parser.add_argument(
        "--mismatch-share",
        type=float,
        default=DEFAULT_MISMATCH_SHARE,
        help="share of statements that hide one line from the text (self-check)",
    )
    parser.add_argument("--out", type=Path, default=DATASET_PATH)
    args = parser.parse_args(argv)
    rows = generate(
        seed=args.seed,
        statements=args.statements,
        mismatch_share=args.mismatch_share,
    )
    write(rows, args.out)
    # Program OUTPUT, not logging.
    print(
        f"written: {args.out} ({len(rows)} statements,"
        f" {sum(len(row['gold_rows']) for row in rows)} gold rows,"
        f" {sum(row['expect_self_check'] == 'failed' for row in rows)} with a"
        " hidden line)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
