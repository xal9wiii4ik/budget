"""Generate the retrieval dataset the search eval is scored on (rag D-E1).

From ``apps/api``::

    uv run python evals/gen_retrieval.py --seed 20261019

writes ``dataset/retrieval-v1/corpus.jsonl`` (the operations that get embedded)
and ``dataset/retrieval-v1/queries.jsonl`` (what a person would type, in three
languages, each with the keys that MUST come back).

Everything here is invented. The merchants are the RU/PL/EN shapes of the
owner's real ledger — a Polish grocery chain, a Belarusian pharmacy, a German
hypermarket — but no merchant, note, amount or date comes from the owner's data:
committing the dataset is what makes a retrieval report reproducible by someone
who has none of it.

**Gold is a THEME, not a string match.** Each themed document belongs to exactly
one theme (car, pharmacy, groceries, gifts, coffee, transport) and each themed
query is the question a person asks about that theme in ru/pl/en — so a run
measures whether the model crosses the language gap (``apteka`` → ``Аптека``),
which is the entire reason a 118 MB multilingual model is in the image. The
country queries are the second half of the same claim: the English country name
in the passage (``services/tx_text.py``) is what makes "траты в Польше" find the
Polish rows (``evidence.md``, the four-document country probe).

``--derive-owner`` APPENDS the already-anonymised, already-owner-reviewed
``owner-categorize-v1.jsonl`` as extra documents (copying only ``text`` →
merchant, ``kind`` and ``country`` — never the label, which would make its own
query a string match) plus one query per label with at least
``MIN_OWNER_ROWS`` rows. It is **not** how the committed files were cut: a
themed grocery row is a perfectly good answer to the owner's "Продукты" query
without being in its gold set, so the two families in one corpus would report a
recall lower than the model earned. Use it locally to look at real merchant
strings; read the numbers as a floor, and do not commit the result.

Re-cutting either file invalidates ``replay/fake-fake-qa-v1.jsonl`` (the
documents travel inside the prompt, which is what the replay store is keyed by)
— re-record it in the SAME pass, exactly as ``gen_reconcile.py`` requires.
"""

import logging
import sys
from pathlib import Path

if __package__ in {None, ""}:
    # See ``run.py``: the documented command is the script path, and the module
    # is also imported as ``evals.gen_retrieval`` by the eval runners.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import argparse
import json
import random
from collections.abc import Sequence
from dataclasses import asdict, dataclass, replace
from datetime import date, timedelta
from typing import Any

from evals.common import (
    DATASET_DIR,
    EvalError,
    json_integer,
    json_object,
    json_optional_text,
    json_text,
)

logger = logging.getLogger("evals.gen_retrieval")

DATASET_PATH = DATASET_DIR / "retrieval-v1"
CORPUS_PATH = DATASET_PATH / "corpus.jsonl"
QUERIES_PATH = DATASET_PATH / "queries.jsonl"
OWNER_DATASET_PATH = DATASET_DIR / "owner-categorize-v1.jsonl"

#: The seed of the COMMITTED files. Changing it re-cuts both, which invalidates
#: the QA replay fixture and both committed retrieval reports.
DEFAULT_SEED = 20261019

#: A label needs this many owner rows before ``--derive-owner`` turns it into a
#: query: two rows make recall@5 a coin toss that reads like a measurement.
MIN_OWNER_ROWS = 3

#: The currency every figure of the QA eval's total is expressed in. Documents
#: in another currency are the eval's ``unconverted_count`` — the same arm the
#: server takes when it has no rate (``tx_totals.converted_total_for_rows``).
BASE_CURRENCY = "BYN"

#: Country → (account name, currency). One account per country: that is how the
#: owner's ledger actually looks, and the account name is part of the embedded
#: document (``services/tx_text.py``).
_ACCOUNTS: dict[str | None, tuple[str, str]] = {
    "BY": ("Карта BYN", "BYN"),
    "PL": ("Karta PLN", "PLN"),
    "DE": ("Karta EUR", "EUR"),
    None: ("Наличные BYN", "BYN"),
}


@dataclass(frozen=True)
class Doc:
    """One corpus document. ``theme`` is the gold link, never an embedded field.

    The six text fields are exactly what ``services/tx_text.TextFacts`` takes;
    ``amount_minor``/``currency``/``occurred_at`` are NOT embedded (amounts and
    dates are deliberately absent from the canonical text) and exist only so the
    QA eval can build the operations and the server-style total the prompt
    carries.
    """

    key: str
    merchant: str
    note: str | None
    category: str | None
    kind: str
    country: str | None
    account: str | None
    currency: str
    amount_minor: int
    occurred_at: str
    theme: str
    language: str
    source: str

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Query:
    """One question plus the keys a perfect retriever returns for it."""

    id: str
    text: str
    language: str
    theme: str
    gold: tuple[str, ...]
    source: str

    def to_json(self) -> dict[str, Any]:
        """``gold`` is a tuple in Python and an array on disk."""
        return {**asdict(self), "gold": list(self.gold)}


@dataclass(frozen=True)
class _Theme:
    name: str
    #: ``(merchant, note, category, country, language)`` — the language is the
    #: merchant string's own, which is what the per-language recall splits on.
    docs: tuple[tuple[str, str, str, str, str], ...]
    #: ``(language, question)`` in ru/pl/en.
    queries: tuple[tuple[str, str], ...]


_THEMES: tuple[_Theme, ...] = (
    _Theme(
        name="car",
        docs=(
            ("Автосервис Мотор", "замена масла и фильтра", "Авто", "BY", "ru"),
            ("Shell Mińsk", "заправка 95-й", "Авто", "BY", "pl"),
            ("Orlen Warszawa", "tankowanie przed trasą", "Авто", "PL", "pl"),
            ("Автозапчасти АвтоМир", "тормозные колодки", "Авто", "BY", "ru"),
            ("Lotos Gdańsk", "paliwo i płyn do spryskiwaczy", "Авто", "PL", "pl"),
            ("CarWash Express", "car wash before the trip", "Авто", "DE", "en"),
        ),
        queries=(
            ("ru", "всё про машину: ремонт, бензин, запчасти"),
            ("pl", "wydatki na samochód, paliwo i serwis"),
            ("en", "everything about the car: fuel, repairs, parts"),
        ),
    ),
    _Theme(
        name="pharmacy",
        docs=(
            ("Apteka Gemini", "witaminy dla dziecka", "Здоровье", "PL", "pl"),
            ("Аптека 36.6", "лекарства от простуды", "Здоровье", "BY", "ru"),
            ("Apteka Ziko", "maść i bandaż", "Здоровье", "PL", "pl"),
            ("Аптека Планета Здоровья", "капли для глаз", "Здоровье", "BY", "ru"),
            (
                "Pharmacy am Hauptbahnhof",
                "painkillers and plasters",
                "Здоровье",
                "DE",
                "en",
            ),
        ),
        queries=(
            ("ru", "аптека и лекарства"),
            ("pl", "apteka i leki"),
            ("en", "pharmacy and medicines"),
        ),
    ),
    _Theme(
        name="groceries",
        docs=(
            ("Biedronka", "kawa i bułki", "Продукты", "PL", "pl"),
            ("Евроопт", "продукты на неделю", "Продукты", "BY", "ru"),
            ("Lidl Berlin", "weekly groceries", "Продукты", "DE", "en"),
            ("Kaufland", "warzywa i owoce", "Продукты", "PL", "pl"),
            ("ProStore", "молоко, хлеб, яйца", "Продукты", "BY", "ru"),
            ("Żabka", "woda i kanapka", "Продукты", "PL", "pl"),
        ),
        queries=(
            ("ru", "продукты и еда домой"),
            ("pl", "zakupy spożywcze do domu"),
            ("en", "groceries and food shopping"),
        ),
    ),
    _Theme(
        name="gifts",
        docs=(
            ("Allegro prezent", "prezent urodzinowy dla taty", "Подарки", "PL", "pl"),
            ("Подарок маме", "букет и открытка", "Подарки", "BY", "ru"),
            ("Empik karta podarunkowa", "prezent na święta", "Подарки", "PL", "pl"),
            ("Цветы Флорист", "цветы на день рождения", "Подарки", "BY", "ru"),
            ("Toy shop Smyk", "birthday present for a nephew", "Подарки", "PL", "en"),
        ),
        queries=(
            ("ru", "подарки на праздники"),
            ("pl", "prezenty na urodziny i święta"),
            ("en", "presents and gifts"),
        ),
    ),
    _Theme(
        name="coffee",
        docs=(
            ("Starbucks", "latte to go", "Кафе и рестораны", "PL", "en"),
            (
                "Bazyliszek restauracja",
                "obiad we dwoje",
                "Кафе и рестораны",
                "PL",
                "pl",
            ),
            ("Кофейня Зерно", "кофе с собой", "Кафе и рестораны", "BY", "ru"),
            ("Pizza Dominium", "pizza na wynos", "Кафе и рестораны", "PL", "pl"),
            ("Costa Coffee", "coffee and a croissant", "Кафе и рестораны", "DE", "en"),
        ),
        queries=(
            ("ru", "кофе и рестораны"),
            ("pl", "kawa i restauracje"),
            ("en", "coffee shops and restaurants"),
        ),
    ),
    _Theme(
        name="transport",
        docs=(
            ("Uber", "поездка в аэропорт", "Транспорт", "PL", "ru"),
            ("Bolt Warszawa", "przejazd na dworzec", "Транспорт", "PL", "pl"),
            ("Метро Минск", "проездной на месяц", "Транспорт", "BY", "ru"),
            ("PKP Intercity", "bilet do Krakowa", "Транспорт", "PL", "pl"),
            ("Deutsche Bahn", "train ticket to Munich", "Транспорт", "DE", "en"),
        ),
        queries=(
            ("ru", "транспорт: такси, метро, билеты"),
            ("pl", "transport: taksówka, metro, bilety"),
            ("en", "transport: taxi, metro, tickets"),
        ),
    ),
)

#: Documents belonging to NO theme. They are what makes a recall number mean
#: something: without rows that must stay out of the top-k, every query could
#: return the whole corpus and score 100%.
_DISTRACTORS: tuple[tuple[str, str, str, str, str | None, str], ...] = (
    ("Зарплата", "аванс за месяц", "Зарплата", "income", "BY", "ru"),
    ("Аренда квартиры", "платёж за месяц", "Жильё", "expense", "BY", "ru"),
    ("Beltelecom", "интернет и телефон", "Связь", "expense", "BY", "ru"),
    ("Netflix", "subscription", "Развлечения", "expense", None, "en"),
    ("Фитнес-клуб Адреналин", "абонемент на полгода", "Спорт", "expense", "BY", "ru"),
    ("Ubezpieczenie mieszkania", "polisa roczna", "Страхование", "expense", "PL", "pl"),
    (
        "Комиссия банка",
        "за обслуживание счёта",
        "Налоги и комиссии",
        "expense",
        "BY",
        "ru",
    ),
    ("Парикмахерская Локон", "стрижка", "Красота", "expense", "BY", "ru"),
    ("Szkoła angielskiego", "kurs na kwartał", "Образование", "expense", "PL", "pl"),
    (
        "Freelance invoice",
        "side project payment",
        "Прочие доходы",
        "income",
        None,
        "en",
    ),
)

#: ``country → (language, question)`` — the second claim of the dataset: the
#: English country NAME inside the passage is what answers these (evidence.md).
_COUNTRY_QUERIES: tuple[tuple[str, tuple[tuple[str, str], ...]], ...] = (
    (
        "PL",
        (
            ("ru", "сколько ушло на Польшу"),
            ("pl", "wydatki w Polsce"),
            ("en", "spending in Poland"),
        ),
    ),
    (
        "BY",
        (
            ("ru", "расходы в Беларуси"),
            ("pl", "wydatki na Białorusi"),
            ("en", "spending in Belarus"),
        ),
    ),
    (
        "DE",
        (
            ("ru", "покупки в Германии"),
            ("pl", "zakupy w Niemczech"),
            ("en", "spending in Germany"),
        ),
    ),
)

#: The window every generated date falls in. One year, so the QA eval's dates
#: read like a ledger and never like a timestamp of the run.
_FIRST_DAY = date(2026, 1, 8)
_DAYS = 300


def generate(*, seed: int, derive_owner: bool = False) -> tuple[list[Doc], list[Query]]:
    """The whole dataset. Same seed and flag ⇒ byte-identical output."""
    rng = random.Random(seed)
    themed: list[tuple[str, Doc]] = []
    for theme in _THEMES:
        for merchant, note, category, country, language in theme.docs:
            themed.append(
                (
                    theme.name,
                    _doc(
                        rng,
                        merchant,
                        note,
                        category,
                        "expense",
                        country,
                        language,
                        theme.name,
                    ),
                )
            )
    for merchant, note, category, kind, country, language in _DISTRACTORS:
        themed.append(
            (
                "none",
                _doc(rng, merchant, note, category, kind, country, language, "none"),
            )
        )

    # Shuffled BEFORE the keys are handed out, so ``d01`` is not the first row
    # of the first theme: a reader skimming the file sees a ledger, and a bug
    # that returned "the documents in file order" cannot look like retrieval.
    rng.shuffle(themed)
    docs = [
        replace(doc, key=f"d{index:02d}") for index, (_, doc) in enumerate(themed, 1)
    ]
    if derive_owner:
        docs += _owner_docs(rng)

    by_theme: dict[str, list[str]] = {}
    by_country: dict[str, list[str]] = {}
    for doc in docs:
        by_theme.setdefault(doc.theme, []).append(doc.key)
        if doc.country:
            by_country.setdefault(doc.country, []).append(doc.key)

    queries: list[Query] = []
    for theme in _THEMES:
        for language, text in theme.queries:
            queries.append(
                _query(
                    len(queries) + 1,
                    text,
                    language,
                    theme.name,
                    by_theme[theme.name],
                    "themed",
                )
            )
    for country, asked in _COUNTRY_QUERIES:
        for language, text in asked:
            queries.append(
                _query(
                    len(queries) + 1,
                    text,
                    language,
                    f"country:{country}",
                    by_country.get(country, []),
                    "themed",
                )
            )
    if derive_owner:
        for theme, keys in sorted(by_theme.items()):
            if not theme.startswith("owner:") or len(keys) < MIN_OWNER_ROWS:
                continue
            queries.append(
                _query(
                    len(queries) + 1,
                    theme.removeprefix("owner:"),
                    "ru",
                    theme,
                    keys,
                    "owner",
                )
            )
    _check(docs, queries)
    return (docs, queries)


def _doc(
    rng: random.Random,
    merchant: str,
    note: str | None,
    category: str | None,
    kind: str,
    country: str | None,
    language: str,
    theme: str,
) -> Doc:
    account, currency = _ACCOUNTS[country if country in _ACCOUNTS else None]
    return Doc(
        key="",  # handed out after the shuffle below
        merchant=merchant,
        note=note,
        category=category,
        kind=kind,
        country=country,
        account=account,
        currency=currency,
        amount_minor=rng.randrange(350, 40_000),
        occurred_at=(_FIRST_DAY + timedelta(days=rng.randrange(_DAYS))).isoformat(),
        theme=theme,
        language=language,
        source="themed",
    )


def _query(
    number: int, text: str, language: str, theme: str, gold: Sequence[str], source: str
) -> Query:
    if not gold:
        raise EvalError(f"query {text!r} has an empty gold set")
    return Query(
        id=f"q{number:02d}",
        text=text,
        language=language,
        theme=theme,
        gold=tuple(sorted(gold)),
        source=source,
    )


def _owner_docs(rng: random.Random) -> list[Doc]:
    """The anonymised owner rows as documents — ``text``, ``kind``, ``country``.

    The LABEL is deliberately not copied into the category field: the derived
    query IS the label, and a document carrying it would be found by string
    overlap, which measures nothing about meaning.
    """
    docs: list[Doc] = []
    for number, line in enumerate(
        OWNER_DATASET_PATH.read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        where = f"{OWNER_DATASET_PATH}:{number}"
        body = json_object(line, where)
        country = json_optional_text(body, "country", where)
        docs.append(
            Doc(
                key=f"r{number:03d}",
                merchant=json_text(body, "text", where),
                note=None,
                category=None,
                kind=json_text(body, "kind", where),
                country=country,
                account=None,
                currency=json_text(body, "currency", where),
                amount_minor=json_integer(body, "amount_minor", where),
                occurred_at=(
                    _FIRST_DAY + timedelta(days=rng.randrange(_DAYS))
                ).isoformat(),
                theme=f"owner:{json_text(body, 'label', where)}",
                language="ru",
                source="owner",
            )
        )
    return docs


def _check(docs: Sequence[Doc], queries: Sequence[Query]) -> None:
    """Refuse to write a dataset no report could be read against."""
    keys = {doc.key for doc in docs}
    if len(keys) != len(docs):
        raise EvalError("duplicate document keys")
    for query in queries:
        missing = set(query.gold) - keys
        if missing:
            raise EvalError(f"query {query.id} cites unknown keys {sorted(missing)}")
    if len({query.id for query in queries}) != len(queries):
        raise EvalError("duplicate query ids")


def write(rows: Sequence[Doc] | Sequence[Query], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(
        json.dumps(row.to_json(), ensure_ascii=False, sort_keys=True) + "\n"
        for row in rows
    )
    path.write_text(body, encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate the retrieval dataset (retrieval + QA evals)."
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--derive-owner",
        action="store_true",
        help=(
            "append the anonymised owner rows and one query per label with"
            f" at least {MIN_OWNER_ROWS} rows — a LOCAL experiment, not how the"
            " committed files were cut (see the module docstring)"
        ),
    )
    parser.add_argument("--corpus", type=Path, default=CORPUS_PATH)
    parser.add_argument("--queries", type=Path, default=QUERIES_PATH)
    args = parser.parse_args(argv)
    docs, queries = generate(seed=args.seed, derive_owner=args.derive_owner)
    write(docs, args.corpus)
    write(queries, args.queries)
    # Program OUTPUT, not logging.
    print(
        f"written: {args.corpus} ({len(docs)} documents,"
        f" {len({doc.theme for doc in docs})} themes)\n"
        f"written: {args.queries} ({len(queries)} queries,"
        f" {sum(len(query.gold) for query in queries)} gold pairs)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
