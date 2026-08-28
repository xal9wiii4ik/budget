"""The two learned category maps: the suggestion READ and the learning WRITE (§5).

One module for both ends on purpose. A map is only ever as good as the agreement
between the key it was stored under and the key it is looked up by, and the two
maps spell their keys differently:

* ``merchant_category_map`` is keyed by ``normalize_merchant`` of the row's
  DISPLAY NAME (``types.display_name``: the parser's isolated shop name, or the
  description when the FORMAT isolates none) — the same normalization the receipts
  suggestion and the transactions learning use, so one merchant is one key across
  the whole app. It is deliberately the same text apply files the transaction
  under: keyed by the raw description, a format whose line reads "გადახდა -
  YANDEX.EDA 56.10 BYN 01.08.2026" would mint a new key per purchase and the map
  would never suggest anything. A row that names no merchant (``merchant == ""``)
  normalizes to the EMPTY key, which both ends below skip: it is not looked up and
  it teaches nothing, so a nameless fee line can never learn a category under a
  sentence — the same silence a transaction without a merchant gets;
* ``bank_category_map`` is keyed by the bank's own string, STRIPPED AND NO MORE.
  It is a lookup key inside ONE parser's output (the file spells "Поставщик
  услуг" with two spaces every time), so normalizing it would only invent a second
  key for the same bucket.

Split across two files, those two sentences would be free to drift apart; here a
change to either key is a change to both ends of it.

Precedence (§5): the merchant map WINS. One merchant is more specific than one of
the bank's 22 buckets, and the bank's buckets are what the user is re-categorizing
in the first place.

The learning gate is ``category_user_set``: only a category the user explicitly
sent through PATCH teaches. A suggestion left untouched must never confirm itself,
or the first wrong guess becomes permanent.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from budget_api.category_access import visible_categories_clause
from budget_api.domain.merchant import normalize_merchant
from budget_api.enums import StatementSuggestionSource
from budget_api.models import (
    BankCategoryMap,
    Category,
    MerchantCategoryMap,
    StatementImportRow,
)
from budget_api.services.statement_import.types import ParsedRow, display_name

#: Both map keys are ``String(255)``. A statement ``description`` is TEXT, so a
#: pathologically long one would blow the learning INSERT — and take the whole
#: apply down with it. Such a row simply teaches nothing: learning is a
#: convenience, the money is not.
_KEY_MAX = 255


@dataclass(frozen=True)
class CategorySuggestion:
    """What the server guessed for one row, and which map it came from."""

    category_id: uuid.UUID
    source: str


def _merchant_key(merchant: str | None, description: str) -> str:
    key = normalize_merchant(display_name(merchant, description))
    return key if len(key) <= _KEY_MAX else ""


async def _lookup(
    session: AsyncSession,
    user_id: uuid.UUID,
    key_column: InstrumentedAttribute[str],
    table: type[MerchantCategoryMap] | type[BankCategoryMap],
    keys: set[str],
) -> dict[str, uuid.UUID]:
    """One batch select per map — never one query per row.

    JOINed to ``categories`` rather than trusted: a map entry outlives the
    category's ARCHIVING (the FK only cascades a delete), and suggesting a category
    the user could not pick by hand — PATCH refuses an archived one with
    CATEGORY_ARCHIVED — would seed rows with a choice they cannot reproduce. The
    visibility clause is the ordinary user-scoping every read in this codebase
    carries.
    """
    if not keys:
        return {}
    found = (
        await session.execute(
            select(key_column, table.category_id)
            .join(Category, Category.id == table.category_id)
            .where(
                table.user_id == user_id,
                key_column.in_(keys),
                visible_categories_clause(user_id),
                Category.archived.is_(False),
            )
        )
    ).tuples()
    # ``.all()`` first: a Result carries ``keys()``, so handing it to ``dict``
    # directly makes it look like a mapping and subscript itself to death.
    return dict(found.all())


async def suggest_categories(
    session: AsyncSession, user_id: uuid.UUID, rows: Sequence[ParsedRow]
) -> list[CategorySuggestion | None]:
    """A suggestion (or ``None``) per parsed row, positionally aligned with ``rows``.

    TWO queries for the whole file, whatever its size: the keys of every row are
    collected first and each map is read once. Per-row lookups would be a thousand
    round trips inside one upload.
    """
    # Normalized ONCE per row and carried to the loop below: the keys the maps are
    # read by and the keys the rows are matched by must be the same strings, and
    # computing them twice is both a second chance to disagree and 2N normalizations
    # per file.
    keys = [_merchant_key(row.merchant, row.description) for row in rows]
    merchant_keys = set(keys) - {""}
    bank_keys = {row.bank_category for row in rows if row.bank_category}
    by_merchant = await _lookup(
        session,
        user_id,
        MerchantCategoryMap.merchant_norm,
        MerchantCategoryMap,
        merchant_keys,
    )
    by_bank = await _lookup(
        session,
        user_id,
        BankCategoryMap.bank_category,
        BankCategoryMap,
        bank_keys,
    )

    suggestions: list[CategorySuggestion | None] = []
    for row, merchant_key in zip(rows, keys, strict=True):
        merchant_hit = by_merchant.get(merchant_key)
        if merchant_hit is not None:
            suggestions.append(
                CategorySuggestion(
                    merchant_hit, StatementSuggestionSource.merchant.value
                )
            )
            continue
        bank_hit = by_bank.get(row.bank_category or "")
        if bank_hit is not None:
            suggestions.append(
                CategorySuggestion(
                    bank_hit, StatementSuggestionSource.bank_category.value
                )
            )
            continue
        suggestions.append(None)
    return suggestions


async def learn_categories(
    session: AsyncSession, user_id: uuid.UUID, rows: Sequence[StatementImportRow]
) -> None:
    """Teach both maps from the rows the user CATEGORIZED HIMSELF.

    Called inside the apply transaction, so what was learned commits with the
    transactions it was learned from — or with nothing at all.

    ``category_user_set`` is the whole gate (§5), and the row's ``decision`` is
    deliberately NOT one: "this merchant is groceries" is true whether or not the
    user also chose to import that particular line.

    Two upserts, one per map, over the DISTINCT pairs — the same
    ``ON CONFLICT DO UPDATE`` the transactions router uses. Rows arrive in file
    order, so when one merchant was filed under two categories the LAST choice
    wins, deterministically.
    """
    merchant_pairs: dict[str, uuid.UUID] = {}
    bank_pairs: dict[str, uuid.UUID] = {}
    for row in rows:
        if not row.category_user_set or row.category_id is None:
            continue
        merchant_key = _merchant_key(row.merchant, row.description)
        if merchant_key:
            merchant_pairs[merchant_key] = row.category_id
        if row.bank_category:
            bank_pairs[row.bank_category] = row.category_id

    if merchant_pairs:
        merchant_insert = pg_insert(MerchantCategoryMap).values(
            [
                {
                    "user_id": user_id,
                    "merchant_norm": key,
                    "category_id": category_id,
                }
                for key, category_id in merchant_pairs.items()
            ]
        )
        await session.execute(
            merchant_insert.on_conflict_do_update(
                index_elements=["user_id", "merchant_norm"],
                set_={
                    "category_id": merchant_insert.excluded.category_id,
                    "updated_at": func.now(),
                },
            )
        )
    if bank_pairs:
        bank_insert = pg_insert(BankCategoryMap).values(
            [
                {
                    "user_id": user_id,
                    "bank_category": key,
                    "category_id": category_id,
                }
                for key, category_id in bank_pairs.items()
            ]
        )
        await session.execute(
            bank_insert.on_conflict_do_update(
                index_elements=["user_id", "bank_category"],
                set_={
                    "category_id": bank_insert.excluded.category_id,
                    "updated_at": func.now(),
                },
            )
        )
