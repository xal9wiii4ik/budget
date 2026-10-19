"""The canonical text of a transaction — the document that actually gets embedded.

Pure (stdlib + ``domain`` only): no session, no models, no FastAPI, so the index
job, the evals and a test can all build the same string from the same facts.

Two things are deliberately ABSENT from the document:

* **amounts** — numbers match lexically, not semantically: a bare ``500`` in the
  text pulls every query containing a figure, and the figure the user actually
  needs is the SERVER's total under the result list, not a row that happened to
  mention it;
* **dates** — those are filters (``from``/``to``), and a date in the text would
  compete with them.

``TEXT_VERSION`` is inside the hash, which makes the hash the whole reindex
mechanism: edit the template, bump the version, and every stored row's
``text_hash`` stops matching, so the sweep re-embeds the world. There is no
reindex CLI and there is deliberately nothing else to remember.
"""

import hashlib
import re
from dataclasses import dataclass

from budget_api.domain.country_names import country_label

#: Bumped by hand whenever the template below changes in ANY way (order, joiner,
#: a new field, the note cap). A test pins that the version is inside the hash;
#: editing the template without bumping this silently redefines every stored
#: vector while leaving every hash matching.
TEXT_VERSION = "tx-text-v1"
#: Notes are free text and occasionally hold a pasted receipt. 300 characters is
#: well past the 128-token ceiling of the model (``embeddings/onnx.py``), so the
#: cut costs nothing a passage could have used and keeps the hash input bounded.
MAX_NOTE_CHARS = 300
_SEP = " | "
_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class TextFacts:
    """Everything the document is built from — one row's worth, already loaded.

    A dataclass rather than the ORM row: ``category_name``/``account_name`` come
    from JOINed tables, and the index scan reads them in ONE query rather than
    lazy-loading a relationship per row.
    """

    merchant: str | None
    note: str | None
    category_name: str | None
    #: ``expense`` / ``income`` — the enum value, in English. The model is
    #: multilingual and every probe in ``evidence.md`` ran RU/PL/EN queries
    #: against English field words successfully.
    kind: str
    #: ISO-3166-1 alpha-2, or None.
    country: str | None
    account_name: str | None


def tx_text(facts: TextFacts) -> str:
    """``"Biedronka | kawa i bułki | Продукты | expense | Poland (PL) | Карта BYN"``.

    Parts in a FIXED order, empty ones dropped, joined by ``" | "``. The order is
    by descending retrieval value: the merchant is what a person remembers, the
    note is what they wrote, and the three classification fields are context.
    """
    parts = (
        _clean(facts.merchant),
        _clean(facts.note, limit=MAX_NOTE_CHARS),
        _clean(facts.category_name),
        _clean(facts.kind),
        country_label(_clean(facts.country) or None),
        _clean(facts.account_name),
    )
    return _SEP.join(part for part in parts if part)


def text_hash(text: str) -> str:
    """``sha256(TEXT_VERSION + "\\n" + text)`` — what "this row is current" means.

    The version is INSIDE the hash rather than beside it in a second column: one
    comparison then answers both "did the row change" and "did the template
    change", and no code path can check one and forget the other.
    """
    return hashlib.sha256(f"{TEXT_VERSION}\n{text}".encode()).hexdigest()


def _clean(value: str | None, *, limit: int | None = None) -> str:
    """Collapse whitespace, strip, optionally cut. ``None``/blank → ``""``."""
    if not value:
        return ""
    collapsed = _WHITESPACE.sub(" ", value).strip()
    return collapsed[:limit] if limit is not None else collapsed
