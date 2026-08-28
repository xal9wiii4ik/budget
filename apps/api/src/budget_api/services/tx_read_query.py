"""Read query parameters → SQL for the transactions reads (list, export).

Extracted from ``routers/transactions.py`` at the second consumer (the
``tx_totals.py`` precedent): ``GET /transactions`` and ``GET /transactions/export``
must not drift into two different definitions of "the same filters", and the
mechanical way to guarantee that is one function both call.

Nothing here refuses: read filters never error (decision l) — a foreign
``category_id`` or ``from > to`` simply matches nothing, so there is no existence
oracle and no HTTPException in this module. The ONE read reference that DOES refuse
stays with the other refusals, in ``transaction_guards.resolve_goal_item_subtree``;
this module only receives the ids it resolved.
"""

import uuid
from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any

from sqlalchemy import ColumnElement, ColumnExpressionArgument, or_

from budget_api.enums import TransactionKind, TransactionSort
from budget_api.models import Transaction

#: LIKE metacharacters plus the escape character itself. Order matters: the escape
#: character has to be doubled FIRST, or the backslashes this function adds in front
#: of ``%``/``_`` would themselves get escaped a second time.
_LIKE_ESCAPE = "\\"


def _escape_like(value: str) -> str:
    """User text -> a LIKE pattern body that matches itself LITERALLY.

    ``q`` is a substring search, not a pattern language: a user typing ``50%`` or
    ``a_b`` means those characters, and leaving them raw would silently turn the
    box into a wildcard console (``%`` alone matching every row). Paired with
    ``escape=_LIKE_ESCAPE`` at the call site — an ``ESCAPE`` clause is what makes
    the added backslashes mean "the next character is data".
    """
    for char in (_LIKE_ESCAPE, "%", "_"):
        value = value.replace(char, _LIKE_ESCAPE + char)
    return value


def read_filters(
    user_id: uuid.UUID,
    from_: date | None,
    to: date | None,
    category_id: uuid.UUID | None,
    kind: TransactionKind | None,
    account_id: uuid.UUID | None,
    q: str | None = None,
    country: str | None = None,
    goal_item_ids: Sequence[uuid.UUID] | None = None,
) -> list[ColumnElement[bool]]:
    """The read filter set shared by ``GET /transactions`` and ``GET /export``.

    Read filters never error (decision l): a foreign ``category_id`` or ``from > to``
    simply matches nothing. No existence check, no oracle. Extracted at the second
    consumer (the tx_totals precedent) so the two endpoints cannot drift into two
    different definitions of "the same filters".

    ``account_id`` matches EITHER leg (architecture §6): the history of an account
    is the money that left it AND the money that arrived from a transfer, and a
    transfer is one row seen from two sides (addendum A3). Filtering the source leg
    alone would make an incoming transfer vanish from the very statement it lands on.

    ``q`` (S3) is a case-insensitive substring over ``merchant`` OR ``note`` — the
    two free-text columns a row actually owns. NOT the category name (``category_id``
    is the filter for that, and the client already has the names) and NOT amounts (a
    digit string would match note text and turn "find 500" into noise). A blank or
    whitespace-only ``q`` is treated as ABSENT rather than as "match rows containing
    nothing": every row contains the empty string, so the alternative is a filter
    that silently does nothing while claiming to be applied.
    """
    filters: list[ColumnElement[bool]] = [Transaction.user_id == user_id]
    if from_ is not None:
        filters.append(Transaction.occurred_at >= from_)
    if to is not None:
        filters.append(Transaction.occurred_at <= to)
    if category_id is not None:
        filters.append(Transaction.category_id == category_id)
    if kind is not None:
        filters.append(Transaction.kind == kind.value)
    if account_id is not None:
        filters.append(
            or_(
                Transaction.account_id == account_id,
                Transaction.counter_account_id == account_id,
            )
        )
    needle = (q or "").strip()
    if needle:
        pattern = f"%{_escape_like(needle)}%"
        # ILIKE, not lower()+LIKE: Postgres folds case per the database collation, so
        # a UTF-8 database matches "продукты" against "Продукты" exactly the way it
        # matches "coffee" against "Coffee" — no ASCII-only fold, no client-side
        # normalization, and nothing for a mixed ru/en dataset to fall through.
        # A NULL column simply never matches; the OR keeps the other one live.
        filters.append(
            or_(
                Transaction.merchant.ilike(pattern, escape=_LIKE_ESCAPE),
                Transaction.note.ilike(pattern, escape=_LIKE_ESCAPE),
            )
        )
    if country is not None:
        # Exact match, no normalization: the column is format-checked uppercase
        # (COUNTRY_PATTERN, mirrored by the route's Query pattern), so there is no
        # lowercase spelling in the table for a fold to rescue.
        filters.append(Transaction.country == country)
    if goal_item_ids is not None:
        # A SUBTREE, already resolved by the caller (PM Q4): a parent's "paid"
        # aggregates its whole subtree, so the list of payments behind that number
        # has to be the same population — otherwise two screens answer one question
        # differently. This filter is the ONE read filter that can 404 (the caller
        # resolves the id first): an unknown node returning an empty list would be
        # indistinguishable from a node with no payments.
        filters.append(Transaction.goal_item_id.in_(goal_item_ids))
    return filters


#: ``sort`` value -> ORDER BY, spelled once for the whole app.
#:
#: Every entry ends in ``id`` so the order is TOTAL: offset pagination that is not
#: total can show one row on two pages and skip another entirely. ``date_desc`` is
#: byte-identical to the pre-S3 hardcoded ordering — an omitted ``sort`` must not
#: reshuffle anybody's list — and ``date_asc`` is its exact mirror (the same key
#: sequence, flipped), which is also what ``GET /export`` has always used.
#:
#: The amount sorts order by ``amount_minor`` and fall back to the FULL ``date_desc``
#: key: equal amounts stay newest-first, which is the ordering the rest of the app
#: already means by "no further preference".
#:
#: They compare RAW minor units across currencies, and that is deliberate. Every
#: currency in ``SUPPORTED_CURRENCIES`` has exponent 2, so the integers being ordered
#: are all hundredths — like units, not apples and oranges. Sorting by the
#: base-currency snapshot instead would be WORSE: ``base_amount_minor`` is NULL on
#: every transfer (by CHECK) and on every row written while no rate existed, so a
#: converted sort would have to invent a position for rows that have no converted
#: amount at all, i.e. bury them at one end of the list. Ordering by what the row
#: actually says is the option that cannot lie.
ORDER_BY: Mapping[TransactionSort, tuple[ColumnExpressionArgument[Any], ...]] = {
    TransactionSort.date_desc: (
        Transaction.occurred_at.desc(),
        Transaction.created_at.desc(),
        Transaction.id,
    ),
    TransactionSort.date_asc: (
        Transaction.occurred_at.asc(),
        Transaction.created_at.asc(),
        Transaction.id,
    ),
    TransactionSort.amount_desc: (
        Transaction.amount_minor.desc(),
        Transaction.occurred_at.desc(),
        Transaction.created_at.desc(),
        Transaction.id,
    ),
    TransactionSort.amount_asc: (
        Transaction.amount_minor.asc(),
        Transaction.occurred_at.desc(),
        Transaction.created_at.desc(),
        Transaction.id,
    ),
}
