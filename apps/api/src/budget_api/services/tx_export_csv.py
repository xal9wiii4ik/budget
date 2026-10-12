"""The CSV file behind ``GET /transactions/export`` (D13): columns, cells, bytes.

Extracted from ``routers/transactions.py`` because this is a FILE FORMAT, not
routing: the column order is a contract users write spreadsheet formulas against,
and it has nothing to say about status codes, dependencies or query parameters.
The router keeps the decisions that ARE HTTP — the filters, the ORDER BY, the
``Content-Disposition`` — and hands this module a ready ``Select``.

Only ``csv_body`` is public. The column tuple, the row builder and the encoder are
private on purpose: the header line and every row are built from the SAME tuple, so
the two cannot drift, and nothing outside this module gets to build "almost the
export".

The session is opened HERE rather than injected — see ``export_transactions`` in
``routers/transactions.py``: FastAPI closes a yield dependency BEFORE a streamed
body runs.
"""

import csv
import io
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.category_access import visible_categories_clause
from budget_api.domain.money import to_major_string
from budget_api.models import Account, Category, Transaction

#: The export's column order — the header line and every row are built from it, so
#: the two cannot drift. ``amount``/``base_amount`` are MAJOR-unit decimal strings
#: (a spreadsheet reader has no idea what a minor unit is).
#: The accounts columns are APPENDED, never interleaved: a user's saved formula or
#: pivot over an older export addresses columns by position, and inserting
#: ``account`` next to ``currency`` would silently reinterpret every one of them.
_EXPORT_COLUMNS = (
    "id",
    "occurred_at",
    "kind",
    "amount",
    "currency",
    "base_amount",
    "base_currency",
    "category",
    "merchant",
    "note",
    "account",
    "counter_account",
    "counter_amount",
    # S1/S2, APPENDED for the same reason the accounts columns were: a saved
    # formula over an older export addresses columns by position.
    "original_amount",
    "original_currency",
    "country",
    # debts scope, APPENDED for the same reason every column above was: a saved
    # formula over an older export addresses columns by position. Empty on every
    # ordinary row; on a debt movement it is the id ``GET /debts`` answers to, so
    # a spreadsheet can group a person's loan without the app.
    "debt_id",
)
#: Rows fetched (and encoded) per server-side-cursor partition: memory stays flat
#: no matter how long the user's history is.
_EXPORT_BATCH = 500
#: Excel opens a UTF-8 CSV as cp1251 unless the file starts with this.
_UTF8_BOM = b"\xef\xbb\xbf"


def _encode_csv(rows: Sequence[Sequence[str]]) -> bytes:
    """One batch of rows → RFC-4180 bytes (CRLF terminated, quoted as needed).

    ``csv.writer`` owns the quoting: a note containing a comma, a quote or a newline
    round-trips through ``csv.reader`` unchanged, which hand-rolled ``",".join`` never
    manages.
    """
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\r\n").writerows(rows)
    return buffer.getvalue().encode("utf-8")


def _export_row(
    tx: Transaction,
    category_names: Mapping[uuid.UUID, str],
    account_names: Mapping[uuid.UUID, str],
) -> list[str]:
    """One transaction → its CSV cells, in ``_EXPORT_COLUMNS`` order.

    The base pair is the STORED snapshot, never a fresh conversion: an export is a
    record of what was booked, and re-converting at today's rate would silently
    restate history. The original leg (S1) is exported raw — amount at ITS OWN
    currency's exponent, currency and country — and never the derived rate: a
    spreadsheet can divide two columns, and a rounded rate in a ledger invites
    someone to multiply it back into a number that does not reconcile. No snapshot
    (D7's rate miss) ⇒ both cells empty rather than a zero that reads like a real
    amount.

    Transfers ARE exported (OQ-3): this file is the full history, and a statement
    that hid the moves between the user's own accounts could not be reconciled
    against a bank's. Their base cells stay honestly empty — architecture §5 gives a
    transfer no snapshot, and inventing one here would put money into an export that
    no aggregate in the app counts.
    """
    if tx.base_amount_minor is not None and tx.base_currency is not None:
        base_amount = to_major_string(tx.base_amount_minor, tx.base_currency)
        base_currency = tx.base_currency
    else:
        base_amount, base_currency = "", ""
    if tx.counter_amount_minor is not None and tx.counter_currency is not None:
        # At the TARGET's exponent, not the row's: the arriving leg is denominated
        # by the counter account (§4), so 15000 minor is "15000" landing on a JPY
        # account and "150.00" landing on a EUR one.
        counter_amount = to_major_string(tx.counter_amount_minor, tx.counter_currency)
    else:
        counter_amount = ""
    if tx.original_amount_minor is not None and tx.original_currency is not None:
        # At the ORIGINAL currency's exponent, never the row's: 5000 minor is
        # "50.00" priced in EUR and "5000" priced in JPY (the counter_amount rule,
        # applied to the third leg).
        original_amount = to_major_string(
            tx.original_amount_minor, tx.original_currency
        )
    else:
        original_amount = ""
    return [
        str(tx.id),
        tx.occurred_at.isoformat(),
        tx.kind,
        # At the ROW's own currency exponent: 1250 minor is 12.50 RUB but 1250 JPY.
        to_major_string(tx.amount_minor, tx.currency),
        tx.currency,
        base_amount,
        base_currency,
        "" if tx.category_id is None else category_names.get(tx.category_id, ""),
        tx.merchant or "",
        tx.note or "",
        account_names.get(tx.account_id, ""),
        ""
        if tx.counter_account_id is None
        else account_names.get(tx.counter_account_id, ""),
        counter_amount,
        original_amount,
        tx.original_currency or "",
        tx.country or "",
        "" if tx.debt_id is None else str(tx.debt_id),
    ]


async def csv_body(
    sessionmaker: async_sessionmaker[AsyncSession],
    user_id: uuid.UUID,
    stmt: Select[tuple[Transaction]],
) -> AsyncIterator[bytes]:
    """The export body: BOM, header, then batched rows. Owns its session.

    See ``export_transactions`` for why the session is opened here and not injected.
    """
    async with sessionmaker() as session:
        # ONE query for the names, before the row loop — and include-archived
        # (``visible_categories_clause`` has no archived filter): an archived category
        # still owns its history, and an export that blanked those cells would lose
        # information the app still shows on screen.
        rows = await session.execute(
            select(Category.id, Category.name).where(visible_categories_clause(user_id))
        )
        category_names = {row.id: row.name for row in rows.all()}
        # Same shape, same reason, one more query: an archived account still owns
        # every row ever booked on it, so the map is include-archived and
        # user_id-scoped (an account name is never a system row).
        account_rows = await session.execute(
            select(Account.id, Account.name).where(Account.user_id == user_id)
        )
        account_names = {row.id: row.name for row in account_rows.all()}

        yield _UTF8_BOM + _encode_csv([_EXPORT_COLUMNS])
        result = await session.stream_scalars(stmt)
        async for batch in result.partitions(_EXPORT_BATCH):
            yield _encode_csv(
                [_export_row(tx, category_names, account_names) for tx in batch]
            )
