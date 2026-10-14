"""Raw export → the committed eval dataset, with the person data taken out.

Run it from ``apps/api`` (the raw file is gitignored and lives outside this
package)::

    uv run python evals/anonymize.py ../../.tasks/ai-layer/real-eval-local.csv

Input columns: ``date,kind,amount_minor,currency,merchant,note,country,category,
system_category``. Output: ``evals/dataset/owner-categorize-v1.jsonl`` (one row
per KEPT operation), ``evals/dataset/categories.json`` (the label set, with
stable ids), ``evals/dataset/_meta.json`` (counts + the pending-review flag) and
a review table at a gitignored path for the owner to read before the dataset is
committed.

What the committed dataset may carry: a merchant-like string, the kind, the
amount, the currency, the country and the gold label. What it must never carry:
a person's name, a card/account/phone number, or free text beyond that one
string. The rules below are therefore biased towards DROPPING a row:

* ``text`` is the merchant when there is one, else the note's FIRST clause — the
  clause that names what was bought, not the owner's bookkeeping prose.
* runs of 4+ digits (card tails, account and phone numbers, terminal ids) are
  cut out of the result, whatever its origin — and so are the same numbers
  written with separators ("+375 29 123 45 67"), whose individual groups are too
  short for that rule.
* the owner's bookkeeping phrases ("Дата — допущение", "платёж 1 из 3", …) are
  removed; a row that is nothing but bookkeeping ends up with an empty text and
  is dropped.
* a row whose RAW merchant or note mentions a relation ("девушке", "другу"), a
  transfer, or matches a person-name pattern is dropped whole and counted. Not
  word-stripped: "Перевод девушке" minus the word is "Перевод", a label-free
  noun that teaches the model nothing, and a half-scrubbed row is exactly the
  kind of thing that leaks. The raw columns are checked rather than the cleaned
  text, so a relation hiding in a later clause still drops the row.
* an empty label or an empty resulting text drops the row; every drop is counted
  by reason in the summary.

Company and merchant names are kept verbatim, city suffix included: they are the
production signal the model is supposed to read, and they are not person data.

The name pattern is a heuristic (initials, and a Russian surname followed by a
given name) and the first-clause rule can only move text it can see — the
OWNER REVIEW of the generated table, not this script, is what finally clears the
dataset for commit.
"""

import argparse
import csv
import json
import re
import sys
import uuid
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: ``apps/api/evals`` — the defaults below hang off it (and off the repo root)
#: rather than off the cwd: the review table MUST land under the repo's
#: ``.tasks/`` to be covered by the ``.tasks/**/real-*-local.*`` gitignore rule,
#: and a cwd-relative default would quietly write the owner's raw notes to an
#: unignored path.
EVALS_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVALS_DIR.parents[2]

DEFAULT_DATASET = EVALS_DIR / "dataset" / "owner-categorize-v1.jsonl"
DEFAULT_REVIEW = REPO_ROOT / ".tasks" / "ai-layer" / "real-anonymize-review-local.md"

#: Fixed namespace for ``uuid5(ns, label name)``: the dataset's category ids have
#: to be stable across regenerations (the replay fixtures and the reports are
#: keyed by the request, which contains the names, but a moving id would make two
#: runs of the same dataset incomparable). Unrelated to the frozen system-category
#: UUIDs of migration 0003 — these ids never reach the database.
LABEL_NAMESPACE = uuid.UUID("dc39472d-9072-4588-9d36-4142d8db1cec")

#: The note's first clause ends at the first of these. ``" — "`` and ``" - "``
#: come first: they are the owner's "value — comment" separator and must win over
#: the bare punctuation alternatives.
CLAUSE_BOUNDARY = re.compile(r" — | - |[.,:;(]")

#: Card tails, account and phone numbers, terminal ids. Four is the shortest run
#: worth hiding and still long enough to leave prices (``2.99``) alone.
DIGIT_RUN = re.compile(r"\d{4,}")

#: The same numbers when they are WRITTEN WITH SEPARATORS — "+375 29 123 45 67",
#: "(029) 123-45-67", an IBAN's four-digit groups: every single run is short
#: enough to pass :data:`DIGIT_RUN`, while the whole is exactly what must go.
#: Seven characters of digits/spaces/``-``/``()``/``+`` is the shortest such run
#: that is not a price, a date or a quantity. Applied BEFORE ``DIGIT_RUN``, so the
#: long match wins instead of the bare rule eating the digits and leaving the
#: separators behind as debris.
SEPARATED_DIGITS = re.compile(r"[\d(+][\d\s\-()+]{5,}\d")

#: The owner's bookkeeping prose: true about their spreadsheet, meaningless to a
#: categorizer, and the half of the note most likely to carry stray detail.
BOOKKEEPING = (
    re.compile(r"Дата\s*[—–-]\s*допущение[^.]*", re.IGNORECASE),
    re.compile(r"платёж\s*\d*\s*из\s*\d*", re.IGNORECASE),
    re.compile(r"(?:\d+-й|перв\w+|втор\w+|трет\w+)\s+за\s+цикл", re.IGNORECASE),
    re.compile(r"РАЗОВ\w+"),
    re.compile(r"Исправлено по выписке[^.]*", re.IGNORECASE),
    # The receipt number survives the clause split as "Чек 122" (the split eats
    # the decimal point first), so the fraction is optional here.
    re.compile(r"Чек\s*\d+(?:[.,]\d+)?", re.IGNORECASE),
    # "Сведены три платежа августа: …" — the same kind of ledger note as the
    # ones listed in the brief, and the only other one in the export.
    re.compile(r"Сведен\w+[^.]*", re.IGNORECASE),
)

#: Leftovers of a split price ("Энергетик 2" from "Энергетик 2.99, вода 1.90")
#: and of a stripped terminal id ("Павильон N" from "Павильон N700114").
#: Whitespace is required before the number so "АЗС М-1" keeps its highway.
TRAILING_NUMBER = re.compile(r"\s+\d+(?:[.,]\d+)?$")
TRAILING_ID_MARKER = re.compile(r"\s+[№N#]$")

#: Any letter in any script. A result without one carries no signal at all (it
#: is a leftover price or receipt number) and the row is dropped as empty.
LETTER = re.compile(r"[^\W\d_]")

#: Word-INITIAL stems, so "Заведение" is not read as a relation word while every
#: case form of the listed ones is ("девушке", "девушкой", "друга", "друзьями").
RELATION_STEMS = (
    "девуш",
    "друг",
    "друз",
    "мам",
    "пап",
    "жен",
    "брат",
    "сестр",
    "бабушк",
    "коллег",
    "перевод",
)
RELATION_WORDS = re.compile(r"\b(?:" + "|".join(RELATION_STEMS) + r")", re.IGNORECASE)

#: Person-name shapes. The second one is deliberately one-directional (surname
#: THEN given name): the mirror form would also match ordinary merchants like
#: "Пекарня Дражина", and dropping a bakery to catch a name that may not be in
#: the file is a bad trade. The owner review is the backstop.
PERSON_PATTERNS = (
    re.compile(r"\b[A-ZА-ЯЁ]\.\s*[A-ZА-ЯЁ]\."),
    re.compile(
        r"\b[А-ЯЁ][а-яё]+(?:ов|ев|ёв|ин|ын|ск(?:ий|ая)|ова|ева|ина)\s+[А-ЯЁ][а-яё]+"
    ),
)

#: Owner's ruling (2026-10-14): exact pay and income-tax amounts never leave the
#: machine — the whole row goes, whatever its label.
PRIVATE_INCOME = re.compile(r"зарплат|подоходн|salary|income tax", re.IGNORECASE)

#: Owner's ruling (2026-10-14): a label that names the owner's own paperwork is
#: generalised in the dataset. The app's category keeps its real name.
LABEL_RENAMES = {"Карта Поляка": "Документы"}

#: Every reason a row can be dropped, in report order.
DROP_REASONS = (
    "empty_label",
    "person_or_relation",
    "private_income",
    "empty_text",
    "bad_amount",
)


@dataclass(frozen=True)
class RawRow:
    """One line of the owner's export, as strings. Never written anywhere."""

    kind: str
    amount_minor: str
    currency: str
    merchant: str
    note: str
    country: str
    category: str


@dataclass(frozen=True)
class Entry:
    """One KEPT dataset row — exactly what is committed."""

    id: str
    kind: str
    amount_minor: int
    currency: str
    country: str | None
    text: str
    label: str

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "amount_minor": self.amount_minor,
            "currency": self.currency,
            "country": self.country,
            "text": self.text,
            "label": self.label,
        }


@dataclass(frozen=True)
class Label:
    """One category the dataset labels rows with. ``id`` is stable across runs."""

    id: str
    name: str
    kind: str

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "kind": self.kind}


@dataclass(frozen=True)
class ReviewRow:
    """One line of the owner's review table (gitignored: it shows the raw text)."""

    number: int
    merchant: str
    note: str
    text: str
    kind: str
    amount: str
    label: str
    action: str


@dataclass(frozen=True)
class Outcome:
    """What one anonymizer run produced, including why rows were dropped."""

    entries: tuple[Entry, ...]
    review: tuple[ReviewRow, ...]
    dropped: Counter[str]
    labels: tuple[Label, ...]
    ambiguity_ceiling: float
    ambiguous_groups: dict[tuple[str, str], int]

    @property
    def kept(self) -> int:
        return len(self.entries)


def first_clause(note: str) -> str:
    """The part of the note before the first clause boundary."""
    return CLAUSE_BOUNDARY.split(note.strip(), maxsplit=1)[0]


def clean(text: str) -> str:
    """Digit runs out, bookkeeping phrases out, whitespace collapsed.

    Returns ``""`` for anything that ends up without a single letter — a row
    whose text is a leftover number teaches nothing and is dropped upstream.
    """
    result = DIGIT_RUN.sub(" ", SEPARATED_DIGITS.sub(" ", text))
    for pattern in BOOKKEEPING:
        result = pattern.sub(" ", result)
    result = " ".join(result.split())
    result = TRAILING_ID_MARKER.sub("", TRAILING_NUMBER.sub("", result))
    result = result.strip(" ,.;:-—")
    return result if LETTER.search(result) else ""


def build_text(merchant: str, note: str) -> str:
    """The dataset's ``text``: the merchant if there is one, else the note's head.

    Merchant-only is the honest production shape — the import pass feeds
    ``display_name(merchant, description)`` to the model — and it is also what
    keeps the owner's prose out of the committed file.
    """
    merchant = merchant.strip()
    return clean(merchant if merchant else first_clause(note))


def is_person_data(field: str) -> bool:
    """True when the field mentions a relation/transfer or looks like a name."""
    if RELATION_WORDS.search(field):
        return True
    return any(pattern.search(field) for pattern in PERSON_PATTERNS)


def drop_reason(row: RawRow, text: str) -> str | None:
    """Why this row is not in the dataset, or ``None`` when it is kept.

    The person check reads the WHOLE field the text was taken from — the
    merchant when there is one, else the entire note, clauses the first-clause
    rule would have cut included. A note-sourced row whose later clause names a
    person is about that person, so it goes; a merchant-sourced row is judged by
    its merchant alone, because its note never reaches the dataset.
    """
    if not row.category.strip():
        return "empty_label"
    if is_person_data(row.merchant.strip() or row.note):
        return "person_or_relation"
    if PRIVATE_INCOME.search(f"{row.merchant} {row.note} {row.category}"):
        return "private_income"
    if not text:
        return "empty_text"
    if not re.fullmatch(r"-?\d+", row.amount_minor.strip()):
        return "bad_amount"
    return None


def convert(rows: Iterable[RawRow]) -> Outcome:
    """Apply the rules to every raw row and assemble the dataset + the review."""
    entries: list[Entry] = []
    review: list[ReviewRow] = []
    dropped: Counter[str] = Counter()
    for number, row in enumerate(rows, start=1):
        text = build_text(row.merchant, row.note)
        reason = drop_reason(row, text)
        if reason is not None:
            dropped[reason] += 1
            review.append(_review_row(number, row, text, f"dropped: {reason}"))
            continue
        entries.append(
            Entry(
                id=f"r{len(entries) + 1}",
                kind=row.kind.strip(),
                amount_minor=abs(int(row.amount_minor.strip())),
                currency=row.currency.strip(),
                country=row.country.strip() or None,
                text=text,
                label=LABEL_RENAMES.get(row.category.strip(), row.category.strip()),
            )
        )
        review.append(_review_row(number, row, text, "kept"))
    groups, ceiling = _ambiguity(entries)
    return Outcome(
        entries=tuple(entries),
        review=tuple(review),
        dropped=dropped,
        labels=_labels(entries),
        ambiguity_ceiling=ceiling,
        ambiguous_groups=groups,
    )


def _review_row(number: int, row: RawRow, text: str, action: str) -> ReviewRow:
    return ReviewRow(
        number=number,
        merchant=row.merchant,
        note=row.note,
        text=text,
        kind=row.kind,
        amount=f"{row.amount_minor} {row.currency}".strip(),
        label=row.category,
        action=action,
    )


def _labels(entries: Sequence[Entry]) -> tuple[Label, ...]:
    """The label set, sorted and with stable ids, from the KEPT rows' pairs."""
    pairs = sorted({(entry.kind, entry.label) for entry in entries})
    return tuple(
        Label(id=str(uuid.uuid5(LABEL_NAMESPACE, label)), name=label, kind=kind)
        for kind, label in pairs
    )


def _ambiguity(entries: Sequence[Entry]) -> tuple[dict[tuple[str, str], int], float]:
    """The accuracy ceiling of a merchant-only dataset, and the groups behind it.

    Rows sharing ``(text.casefold(), kind)`` are ONE question as far as the model
    is concerned; when they disagree on the label, the best any model can do is
    answer each group's majority label. The sum of those majorities over the kept
    rows is therefore the ceiling the report prints next to accuracy — a grocery
    merchant that appears under six labels is not a model failure.
    """
    groups: dict[tuple[str, str], Counter[str]] = {}
    for entry in entries:
        key = (entry.text.casefold(), entry.kind)
        groups.setdefault(key, Counter())[entry.label] += 1
    if not entries:
        return {}, 0.0
    best = sum(max(counter.values()) for counter in groups.values())
    ambiguous = {
        key: sum(counter.values())
        for key, counter in groups.items()
        if len(counter) > 1
    }
    return ambiguous, best / len(entries)


def read_raw(path: Path) -> list[RawRow]:
    """Read the export. Unknown extra columns are ignored, missing ones empty."""
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return [
            RawRow(
                kind=_cell(record, "kind"),
                amount_minor=_cell(record, "amount_minor"),
                currency=_cell(record, "currency"),
                merchant=_cell(record, "merchant"),
                note=_cell(record, "note"),
                country=_cell(record, "country"),
                category=_cell(record, "category"),
            )
            for record in csv.DictReader(handle)
        ]


def _cell(record: dict[str, str | Any], column: str) -> str:
    value: Any = record.get(column)
    return value if isinstance(value, str) else ""


def render_review(outcome: Outcome) -> str:
    """The owner's review table: raw columns beside the anonymized result."""
    lines = [
        "# Anonymize review — owner's eval export",
        "",
        "Gitignored on purpose: the two raw columns are the owner's own text.",
        "Read every `kept` line and confirm the `→ text` column carries no person",
        "name, no number and no private detail; then the dataset may be committed.",
        "",
        "`ambiguity group` is how many kept rows share this `(text, kind)` under a",
        "DIFFERENT label — the merchant-only ceiling the report prints.",
        "",
        "| # | raw merchant | raw note | → text | kind | amount | label | action |"
        " ambiguity group |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in outcome.review:
        group = outcome.ambiguous_groups.get((row.text.casefold(), row.kind.strip()))
        lines.append(
            "| "
            + " | ".join(
                (
                    str(row.number),
                    _cell_md(row.merchant),
                    _cell_md(row.note),
                    _cell_md(row.text),
                    _cell_md(row.kind),
                    _cell_md(row.amount),
                    _cell_md(row.label),
                    row.action,
                    str(group) if group and row.action == "kept" else "-",
                )
            )
            + " |"
        )
    lines += ["", "## Summary", "", f"- kept: {outcome.kept}"]
    for reason in DROP_REASONS:
        lines.append(f"- dropped ({reason}): {outcome.dropped.get(reason, 0)}")
    lines += [
        f"- labels: {len(outcome.labels)}",
        f"- ambiguous (text, kind) groups: {len(outcome.ambiguous_groups)}",
        f"- ambiguity ceiling: {outcome.ambiguity_ceiling:.3f}",
        "",
    ]
    return "\n".join(lines)


def _cell_md(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ").strip() or "—"


def write_outputs(outcome: Outcome, dataset: Path, review: Path) -> None:
    dataset.parent.mkdir(parents=True, exist_ok=True)
    dataset.write_text(
        "".join(
            json.dumps(entry.to_json(), ensure_ascii=False) + "\n"
            for entry in outcome.entries
        ),
        encoding="utf-8",
    )
    categories = dataset.parent / "categories.json"
    categories.write_text(
        json.dumps(
            {
                "version": 1,
                "labels": [label.to_json() for label in outcome.labels],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    meta = dataset.parent / "_meta.json"
    meta.write_text(
        json.dumps(
            {
                "dataset": dataset.name,
                "version": 1,
                "owner_reviewed": "2026-10-14",
                "source": (
                    "the owner's real statement export (gitignored, never"
                    " committed); produced by evals/anonymize.py"
                ),
                "privacy": (
                    "person names, relation mentions, transfers and 4+ digit runs"
                    " drop or are stripped; merchant/company names are kept"
                ),
                "rows": outcome.kept,
                "dropped": {
                    reason: outcome.dropped.get(reason, 0) for reason in DROP_REASONS
                },
                "labels": len(outcome.labels),
                "ambiguous_groups": len(outcome.ambiguous_groups),
                "ambiguity_ceiling": round(outcome.ambiguity_ceiling, 4),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    review.parent.mkdir(parents=True, exist_ok=True)
    review.write_text(render_review(outcome), encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Anonymize the owner's raw export into the committed eval dataset."
        )
    )
    parser.add_argument("raw", type=Path, help="the raw CSV export (gitignored)")
    parser.add_argument(
        "--out", type=Path, default=DEFAULT_DATASET, help="dataset JSONL to write"
    )
    parser.add_argument(
        "--review",
        type=Path,
        default=DEFAULT_REVIEW,
        help="review table to write (must stay on a gitignored path)",
    )
    args = parser.parse_args(argv)
    raw_path: Path = args.raw
    if not raw_path.exists():
        print(f"no such file: {raw_path}", file=sys.stderr)
        return 2
    outcome = convert(read_raw(raw_path))
    write_outputs(outcome, args.out, args.review)
    # Program OUTPUT, not logging: the numbers are the point of running this.
    print(f"kept {outcome.kept} rows, {len(outcome.labels)} labels")
    for reason in DROP_REASONS:
        print(f"dropped {reason}: {outcome.dropped.get(reason, 0)}")
    print(f"ambiguity ceiling: {outcome.ambiguity_ceiling:.3f}")
    print(f"dataset: {args.out}")
    print(f"review table (gitignored, for the owner): {args.review}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
