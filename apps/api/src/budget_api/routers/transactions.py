"""Transaction CRUD + monthly summary over the ``transactions`` table.

Two structural authorization pillars (architecture §3), carried from categories.py:

* **Reads** filter ``user_id = me`` (transactions are never system rows). The
  *category reference* a transaction points at is still visible-scoped on write.
* **Writes** force ``user_id = me`` and never read ``user_id`` from the body.

No-oracle: the transaction's own path id uses ``404 TRANSACTION_NOT_FOUND`` for
cross-user and missing alike (``_load_own`` filters ``user_id = me``, one code
path). A *body* ``category_id`` that is foreign/missing is ``422
CATEGORY_NOT_FOUND`` (``load_visible_category`` returns ``None`` for both, one
code path); an archived visible target is ``422 CATEGORY_ARCHIVED``. The addressed
resource (the transaction) is fine, so the body — not the resource — is the 422.

The month-window aggregate moved OUT to ``services/tx_totals.py`` in 3.2 (D9): it
gained a second in-scope consumer (the goals free-balance window), which is exactly
the "the second consumer extracts" trigger. ``get_or_create_profile`` moved out to
``services/profile_reads.py`` in S1 for the same reason — ``PATCH /profile`` is
its second consumer.

``GET /export`` (D13) is the one route here that does NOT take a ``get_session``
dependency: FastAPI closes those before a streamed body runs, so its generator opens
its own session from ``app.state.sessionmaker`` (see ``export_transactions``). It is
also the one read ordered oldest-first, and the one place minor units are rendered as
major-unit strings — via ``domain/money.to_major_string``, never a hardcoded /100.

What is NOT in this file (and why): the module keeps the routes and what ties them
to HTTP — dependencies, status codes, the guard ORDER — and nothing else.
``services/tx_read_query.py`` turns the read query parameters into filters and an
ORDER BY (shared by the list and the export, so they cannot drift);
``services/tx_export_csv.py`` owns the export FILE FORMAT (columns, cells, bytes);
``transaction_guards.py`` owns every "resolve a referenced id or refuse" policy, so
the no-oracle orders live in one readable place; ``transaction_wire.py`` owns the
row → ``TransactionRead`` conversion. The idempotency helpers below stayed: they are
one mechanism with the create route's body, and moving them would add couplings
rather than remove them.

Two handler docstrings below still spell ``_read_filters`` and ``_ORDER_BY``: a
route handler's docstring IS its OpenAPI operation description, so that wording is
frozen — a rename there would edit the published contract for no behavioural reason.
Read them as ``read_filters``/``ORDER_BY`` in ``services/tx_read_query.py``.

Base-currency snapshot (D5): the ``base_amount_minor``/``base_currency`` pair is
server-managed. Every write of it goes through ``services/fx_lookup.auto_snapshot``
— the ONE snapshot-WRITE conversion site, shared with the recurring materialization
job (D8); read-side conversions (fx preview, goals, tx totals) pair
``lookup_rate``+``convert_minor`` directly. Rate resolution is ``lookup_rate``,
arithmetic is ``domain/fx.convert_minor``, and there is no Decimal math here at all.
"""

import logging
import uuid
from datetime import date

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.db import get_session
from budget_api.domain.fx import convert_minor
from budget_api.domain.merchant import normalize_merchant
from budget_api.domain.periods import MONTH_PATTERN
from budget_api.enums import TransactionKind, TransactionSort
from budget_api.mcp import prose
from budget_api.mcp.decorator import mcp_tool
from budget_api.models import (
    Account,
    MerchantCategoryMap,
    Transaction,
    User,
)
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.transaction import (
    COUNTRY_PATTERN,
    CategorySummary,
    SummaryRead,
    TransactionCreate,
    TransactionError,
    TransactionList,
    TransactionRead,
    TransactionUpdate,
)
from budget_api.services.fx_lookup import auto_snapshot, lookup_rate
from budget_api.services.profile_reads import (
    get_or_create_profile,
    read_base_currency,
)
from budget_api.services.tx_export_csv import csv_body
from budget_api.services.tx_read_query import ORDER_BY, read_filters
from budget_api.services.tx_totals import converted_totals
from budget_api.transaction_guards import (
    reject_archived,
    reject_deposit_spending,
    require_own_account,
    resolve_goal_item_subtree,
    validate_category,
    validate_goal_item,
    validate_receipt,
)
from budget_api.transaction_wire import serialize_transaction

router = APIRouter()

logger = logging.getLogger(__name__)

#: Shared by the create and update tool descriptions below (architecture §2.5: prose
#: common to two handlers of ONE router is a module constant here, not a line in
#: mcp/prose.py). The sentence opens the `amount_minor` text in both, and the two
#: must not drift: it is what stops the model from sending the amount the user's
#: bank statement shows in a FOREIGN currency as if the account were charged it.
_CHARGED_TO_ACCOUNT = "What was charged TO THE ACCOUNT, in the ACCOUNT's currency. "

#: PATCH fields that feed the conversion — touching any of them invalidates a
#: stored auto-snapshot (D5: no stale snapshot survives an edit unnoticed).
#: ``account_id`` is one of them since the accounts scope: moving a row to another
#: account restamps its currency (§4), which is a conversion input by definition.
#: ``original_*`` are deliberately NOT here: they are a DISPLAY leg, and clearing a
#: display field must never restate money (review-b MAJOR-1). The case they were
#: added for — the server DERIVING the settlement amount from a newly set pair — is
#: keyed on ``derived_amount`` at the snapshot block instead.
_CONVERSION_INPUTS = frozenset(
    {"amount_minor", "currency", "occurred_at", "account_id"}
)

# Mirrors routers/categories.py: every HTTPException.detail below is a stable
# UPPER_SNAKE code carried in {"detail": ...} (the TransactionError shape).
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {"model": TransactionError}
}
# AM-5: POST/PATCH 422 emits BOTH arms at runtime — our business codes
# ({"detail": CODE}, TransactionError) and FastAPI's Pydantic array
# (HTTPValidationError). Declaring only {"model": TransactionError} would suppress
# the auto HTTPValidationError and make the generated type lie about one arm, so we
# declare the honest union as a raw content schema. HTTPValidationError is NOT
# hand-declared (that would mangle the component name); it already exists in the
# schema (generated by parameterized routes) and the GET routes keep emitting it.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/TransactionError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}
#: A replay of a create that already landed (B-1 ``client_id``): the STORED row,
#: nothing created. Declared so the contract — and the generated client — carry
#: both success arms honestly (the health.py 503 precedent).
_IDEMPOTENT_REPLAY: dict[int | str, dict[str, object]] = {
    status.HTTP_200_OK: {
        "model": TransactionRead,
        "description": "Idempotent replay — the existing transaction, not created",
    }
}


async def _load_own(
    session: AsyncSession, transaction_id: uuid.UUID, user_id: uuid.UUID
) -> Transaction | None:
    """user_id-scoped load; foreign/missing → None → 404 (no-oracle, one code path)."""
    return await session.scalar(
        select(Transaction).where(
            Transaction.id == transaction_id, Transaction.user_id == user_id
        )
    )


async def _load_by_client_id(
    session: AsyncSession, user_id: uuid.UUID, client_id: uuid.UUID
) -> Transaction | None:
    """user_id-scoped idempotency lookup — the ONE query both replay arms share.

    Mirrors ``_load_own``'s shape and its no-oracle property: the filter carries
    ``user_id``, so a hit can only ever be the caller's own row and a guessed
    foreign key is an ordinary miss.
    """
    return await session.scalar(
        select(Transaction).where(
            Transaction.user_id == user_id, Transaction.client_id == client_id
        )
    )


async def _recover_replay_race(
    session: AsyncSession, user_id: uuid.UUID, client_id: uuid.UUID | None
) -> Transaction | None:
    """Post-IntegrityError re-select; ``None`` means "not our conflict — re-raise".

    The window between the select-first below and the INSERT is real (two outbox
    runs firing the same queued item), and the partial unique index is what closes
    it. No savepoint is needed: the failure surfaces on ``commit()``, so a
    ``rollback()`` leaves the session fully usable and the next statement autobegins
    a new transaction. Nothing worth keeping is discarded — the profile self-heal
    and the merchant upsert were both already performed, identically, by the request
    that won.

    Under READ COMMITTED Postgres BLOCKS the conflicting INSERT on the index until
    the winner commits or aborts, so by the time we see the duplicate key the
    winner's row is committed and visible to this fresh read.

    A NULL ``client_id`` can never violate this index, so whatever failed is a
    different constraint and the caller must re-raise — deciding by re-select rather
    than by sniffing the driver's constraint name keeps us out of asyncpg plumbing.
    """
    await session.rollback()
    if client_id is None:
        return None
    return await _load_by_client_id(session, user_id, client_id)


@router.post(
    "",
    response_model=TransactionRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_IDEMPOTENT_REPLAY, **_NOT_FOUND, **_UNPROCESSABLE},
)
@mcp_tool(
    name="create_transaction",
    description=(
        "Record ONE transaction on ONE account. `account_id` is REQUIRED and comes "
        "from list_accounts — the account also decides the currency, which the "
        "server stamps. Amounts are INTEGER MINOR UNITS: 12.34 EUR → amount_minor "
        "1234; JPY has no minor unit → 500 JPY is 500. Never do money math yourself "
        "— use convert_currency. MOVING MONEY BETWEEN THE USER'S OWN ACCOUNTS IS ONE "
        "CALL, NOT TWO: send kind `transfer` with account_id as the source and "
        "counter_account_id as the destination — recording a transfer as an expense "
        "plus an income double-counts it and corrupts every total. BEFORE creating, "
        "call list_transactions for the same date and amount: if it is there do NOT "
        "duplicate — fix it with update_transaction; the id is echoed back."
    ),
    params={
        "account_id": (
            prose.ACCOUNT_ID
            + " Required: the account the money left or arrived on, and for a transfer "
            "the SOURCE side."
        ),
        "amount_minor": (
            _CHARGED_TO_ACCOUNT
            + prose.MINOR_UNITS
            + " Always positive — `kind` says whether it is money in or out. For a "
            "transfer it is what LEAVES `account_id`, in that account's currency. It "
            "may be OMITTED only when you send the `original_amount_minor` + "
            "`original_currency` pair instead: the server then converts the original "
            "amount at its own stored daily rate for `occurred_at` (and refuses the "
            "call if it has no rate for that day — it never guesses one). Send it "
            "TOGETHER with that pair only when the user stated what the bank "
            "actually took: a sent amount is stored verbatim and beats any rate. "
            "With no original pair it is required — a call with neither is rejected."
        ),
        "currency": prose.CURRENCY_FROM_ACCOUNT,
        "kind": (
            "Whether this is an expense (money out), income (money in) or a "
            "`transfer` between two of the user's own accounts. A transfer is "
            "neither spending nor earning, so it is left out of every income/expense "
            "total."
        ),
        "counter_account_id": (
            "Transfers ONLY, and then required: the DESTINATION account, from "
            "list_accounts. It must be a different account than `account_id`. Never "
            "send it with an expense or income."
        ),
        "counter_amount_minor": (
            "Transfers ONLY, and then required: how much ARRIVES on the destination "
            "account, in INTEGER MINOR UNITS of THAT account's currency (so 100 EUR "
            "arriving as 10800 JPY is 10800). For a transfer between accounts of the "
            "same currency it equals `amount_minor`. Across currencies, send the "
            "exact received amount ONLY if the user stated it — otherwise get the "
            "figure from convert_currency; never invent a rate. The server derives "
            "the effective rate from the two amounts."
        ),
        "occurred_at": "The date the money moved, as YYYY-MM-DD.",
        "category_id": (
            prose.CATEGORY_ID
            + " Omit it if the user did not say which category, and NEVER send it for "
            "a transfer — moving money between own accounts has no category and the "
            "server rejects one."
        ),
        "merchant": "Who was paid or who paid, as the user named them.",
        "note": "Free-text note from the user.",
        "base_amount_minor": (
            "Only when the user states the exact converted amount they were charged "
            "in their base currency, in minor units. Omit it and the server converts "
            "at its own daily rate — that is the normal case. Never send it for a "
            "transfer: use `counter_amount_minor` instead."
        ),
        "original_amount_minor": prose.ORIGINAL_AMOUNT,
        "original_currency": prose.ORIGINAL_CURRENCY,
        "country": prose.COUNTRY,
        "goal_item_id": prose.GOAL_ITEM_LINK,
        "receipt_id": prose.RECEIPT_ID,
    },
    managed_body={"client_id": "uuid"},
)
async def create_transaction(
    payload: TransactionCreate,
    # Plain parameter, FastAPI mutates the real response object — the
    # routers/health.py precedent for a second declared status on one handler.
    response: Response,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> TransactionRead:
    """Create a transaction; a repeated ``client_id`` replays instead of duplicating.

    FIRST WRITE WINS: the replay arm never consults the body, so a second POST with
    the same key and a *different* payload returns the stored row untouched. Body
    mismatch is deliberately not detected — the client mints the key once per
    logical create and never mutates a queued item.
    """
    # Bound BEFORE any write: a failed flush (the replay race below) expires every
    # instance in the session, so a later ``user.id`` would try to lazy-refresh on a
    # dead transaction and raise PendingRollbackError instead of recovering.
    user_id = user.id
    # Idempotency hit — FIRST, ahead of every validation and every write. Placing it
    # after validate_category would let a category archived SINCE the original
    # create turn a replay into 422 CATEGORY_ARCHIVED, i.e. tell the client that a
    # transaction which IS in the ledger failed. A replay is also a pure read: the
    # profile self-heal below WRITES, and the snapshot lookup reads rates, and
    # neither has any business running for a request that creates nothing. Nothing
    # leaks either — the lookup is user-scoped, so the answer is identical whatever
    # the rest of the body points at.
    if payload.client_id is not None:
        existing = await _load_by_client_id(session, user_id, payload.client_id)
        if existing is not None:
            response.status_code = status.HTTP_200_OK
            return serialize_transaction(existing)
    # ---- account + transfer guards -------------------------------------------
    # The ORDER of the seven checks below is load-bearing (plan risk 1): NOT_FOUND
    # strictly before ARCHIVED on BOTH accounts, or a foreign archived account would
    # answer ACCOUNT_ARCHIVED and confirm its existence. Everything here runs AFTER
    # the replay arm above and BEFORE the first write.
    account = await require_own_account(session, payload.account_id, user_id)
    reject_archived(account)

    is_transfer = payload.kind is TransactionKind.transfer
    # After NOT_FOUND and ARCHIVED, before anything is written: an expense booked
    # on a deposit would be money leaving the deposit while every aggregate counted
    # it as spending.
    reject_deposit_spending(account, is_transfer=is_transfer)
    if is_transfer:
        if payload.counter_account_id is None or payload.counter_amount_minor is None:
            # Half a transfer is not a transfer (architecture §3) — and the DB CHECK
            # would reject it as a 500, so it is refused here as a 422.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="TRANSFER_FIELDS_REQUIRED",
            )
    elif (
        payload.counter_account_id is not None
        or payload.counter_amount_minor is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="COUNTER_FIELDS_WITHOUT_TRANSFER",
        )

    counter: Account | None = None
    if payload.counter_account_id is not None:
        counter = await require_own_account(
            session, payload.counter_account_id, user_id
        )
        if counter.id == account.id:
            # Before the archived check: "into itself" is true of an archived
            # account too, and it is the more specific answer.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="SAME_ACCOUNT_TRANSFER",
            )
        reject_archived(counter)

    if is_transfer and payload.category_id is not None:
        # A transfer is neither spending nor income (architecture §6): it carries no
        # category, and the DB CHECK agrees.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="TRANSFER_CATEGORY_FORBIDDEN",
        )
    if payload.category_id is not None:
        await validate_category(session, payload.category_id, user_id)
    if payload.receipt_id is not None:
        await validate_receipt(session, payload.receipt_id, user_id)
    if payload.goal_item_id is not None:
        # After the receipt ref and BEFORE the currency guards (plan §1.6): it is a
        # body reference like the two above, and it has nothing to do with money.
        await validate_goal_item(
            session, payload.goal_item_id, user_id, payload.kind.value
        )
    if payload.currency is not None and payload.currency != account.currency:
        # Architecture §4: the account decides. Rejected rather than restamped —
        # a client that thinks it booked USD must not get a 201 for a BYN row.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="ACCOUNT_CURRENCY_MISMATCH",
        )
    if is_transfer and payload.base_amount_minor is not None:
        # Architecture §5: a transfer never carries a base snapshot, so there is no
        # override to accept either.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="TRANSFER_BASE_AMOUNT_FORBIDDEN",
        )

    # ---- the original leg (S1 §3) ---------------------------------------------
    # `currency` is STAMPED from the account (§4) — which is what makes a balance
    # plain integer arithmetic instead of a multi-currency sum. Resolved here
    # because the guards below compare the original leg against it.
    currency = account.currency
    original_amount_minor = payload.original_amount_minor
    original_currency = payload.original_currency
    if (original_amount_minor is None) != (original_currency is None):
        # Half an original is not an original (the TRANSFER_FIELDS_REQUIRED
        # precedent): the DB CHECK would reject it as a 500, so it is refused here
        # as a 422 carrying a code the form can act on.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="ORIGINAL_FIELDS_REQUIRED",
        )
    if original_currency is not None:
        if is_transfer:
            # A transfer already carries its second leg in the counter trio; a third
            # amount on top of it would be unreconcilable (and the CHECK agrees).
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="TRANSFER_ORIGINAL_FORBIDDEN",
            )
        if original_currency == currency:
            # NULL already means "priced in the account's own currency"; a second
            # spelling of that fact would fork every reader of the pair.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="ORIGINAL_CURRENCY_MATCHES_ACCOUNT",
            )

    # What actually left the account. SENT wins, verbatim: the bank applied ITS rate
    # and the server has no business restating it. Omitted, with an original leg:
    # derived once, here, and then used by BOTH the snapshot below and the row
    # itself — a second read of ``payload.amount_minor`` past this point would
    # silently reintroduce the None (plan §7.2).
    if payload.amount_minor is not None:
        effective_amount = payload.amount_minor
    elif original_amount_minor is None or original_currency is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="AMOUNT_REQUIRED"
        )
    else:
        found = await lookup_rate(
            session, original_currency, currency, payload.occurred_at
        )
        if found is None:
            # An ORDINARY answer, not an incident: only the 6 canonical pairs are
            # stored, so an exotic original currency simply has no rate and the
            # client re-asks with the settlement amount typed in. Never a 500, and
            # never a silent 0 — ``amount_minor`` is NOT NULL and rides the balance.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="FX_RATE_UNAVAILABLE",
            )
        effective_amount = convert_minor(
            original_amount_minor, original_currency, currency, found.rate
        )

    profile = await get_or_create_profile(session, user_id)
    base = profile.base_currency
    # Create decision table (D5).
    if is_transfer:
        # Row 0 (architecture §5): both legs are the user's own money in their own
        # accounts' currencies, and the row is excluded from every converted
        # aggregate — a snapshot would be a number nobody reads.
        base_amount_minor, base_currency = None, None
    elif currency == base:
        if payload.base_amount_minor is not None:
            # A base-currency row's amount_minor IS its base amount; a second,
            # independently editable copy of it could only ever be a lie.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="BASE_AMOUNT_WITHOUT_CURRENCY",
            )
        base_amount_minor, base_currency = None, None
    elif payload.base_amount_minor is not None:
        # Override wins, stored exactly as sent — including when no rate exists.
        base_amount_minor, base_currency = payload.base_amount_minor, base
    else:
        # ``effective_amount``, NOT ``payload.amount_minor``: a row whose settlement
        # amount the server just derived must be snapshotted from THAT number (plan
        # §7.2). Reading the payload here would snapshot a None.
        base_amount_minor, base_currency = await auto_snapshot(
            session, effective_amount, currency, base, payload.occurred_at
        )
    tx = Transaction(
        user_id=user_id,
        account_id=account.id,
        amount_minor=effective_amount,
        kind=payload.kind.value,
        currency=currency,
        base_amount_minor=base_amount_minor,
        base_currency=base_currency,
        category_id=payload.category_id,
        occurred_at=payload.occurred_at,
        note=payload.note,
        receipt_id=payload.receipt_id,
        merchant=payload.merchant,
        counter_account_id=payload.counter_account_id,
        counter_amount_minor=payload.counter_amount_minor,
        # Stamped from the TARGET account exactly as `currency` is from the source
        # one — the amount that landed is denominated in the target's currency.
        counter_currency=None if counter is None else counter.currency,
        original_amount_minor=original_amount_minor,
        original_currency=original_currency,
        country=payload.country,
        goal_item_id=payload.goal_item_id,
        client_id=payload.client_id,
    )
    session.add(tx)
    # Learn merchant→category on confirm (D7): when a (cleaned) merchant AND a
    # category are both present, upsert the per-user map in the SAME session so the
    # learned pair commits atomically with the transaction. Always upsert — a manual
    # override of a suggested category wins for free. Normalization uses the exact
    # same key the S3 suggestion read looks up. PATCH never reaches here (no learning
    # on edit, D7).
    if payload.merchant is not None and payload.category_id is not None:
        norm = normalize_merchant(payload.merchant)
        if norm:
            await session.execute(
                pg_insert(MerchantCategoryMap)
                .values(
                    user_id=user_id,
                    merchant_norm=norm,
                    category_id=payload.category_id,
                )
                .on_conflict_do_update(
                    index_elements=["user_id", "merchant_norm"],
                    set_={
                        "category_id": payload.category_id,
                        "updated_at": func.now(),
                    },
                )
            )
    try:
        await session.commit()
    except IntegrityError:
        replayed = await _recover_replay_race(session, user_id, payload.client_id)
        if replayed is None:
            raise  # not our conflict — today's behaviour for any other constraint
        # No amount and no note in the log line: this is plumbing, not ledger data.
        logger.info("idempotent replay recovered from insert race user=%s", user_id)
        response.status_code = status.HTTP_200_OK
        return serialize_transaction(replayed)
    await session.refresh(tx)
    return serialize_transaction(tx)


@router.get("", response_model=TransactionList)
@mcp_tool(
    name="list_transactions",
    description=(
        "Search and filter the user's transactions by text, period, category, "
        "account, country and direction, in the order you choose. Returns individual "
        "rows with their ids — this is where every `transaction_id` comes from. For "
        "totals use get_transactions_summary instead of adding rows up yourself. "
        "Keep `limit` at 100 or less and page with `offset`."
    ),
    params={
        "from": "Start date (inclusive) as YYYY-MM-DD.",
        "to": "End date (inclusive) as YYYY-MM-DD.",
        "category_id": "Only this category; take the id from list_categories.",
        "kind": (
            "Only expenses, only income, or only `transfer` rows (money moved "
            "between the user's own accounts, which count as neither)."
        ),
        "account_id": (
            prose.ACCOUNT_ID
            + " Narrows the list to what happened on that ONE account. A transfer is a "
            "SINGLE operation with two sides, so the same row (same id) comes back "
            "both when you filter by the account the money left and when you filter "
            "by the account it arrived on — that is one transfer seen twice, not two "
            "transfers; never add the two lists together."
        ),
        "q": prose.TX_SEARCH,
        "country": prose.TX_COUNTRY_FILTER,
        "goal_item_id": prose.TX_GOAL_ITEM_FILTER,
        "sort": prose.TX_SORT,
        "limit": prose.LIMIT,
        "offset": prose.OFFSET,
    },
)
async def list_transactions(
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None, alias="to"),
    category_id: uuid.UUID | None = None,
    kind: TransactionKind | None = None,
    account_id: uuid.UUID | None = None,
    q: str | None = Query(default=None),
    # Format-validated at the edge (the COUNTRY_PATTERN the column and the write
    # DTOs already share): a malformed value is a 422 before a query is built,
    # unlike the other read filters, which merely match nothing. Nothing is
    # normalized here — see read_filters.
    country: str | None = Query(default=None, pattern=COUNTRY_PATTERN),
    #: A plan node — matches its whole SUBTREE (goal-planner §3 / PM Q4).
    goal_item_id: uuid.UUID | None = None,
    sort: TransactionSort = Query(default=TransactionSort.date_desc),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> TransactionList:
    """The user's transactions, filtered and sorted, with the unpaged ``total``.

    Every filter AND-composes (``_read_filters``, shared with ``GET /export``) and
    ``total`` counts the SAME filter set — the size of the result being paged
    through, never the size of the table. ``q`` is a case-insensitive substring over
    ``merchant`` and ``note`` and nothing else; ``country`` is an exact match on the
    row's ISO-3166-1 alpha-2 code.

    The amount sorts compare RAW ``amount_minor`` and convert nothing: each row is
    ordered by the number it actually carries, in its own currency. See ``_ORDER_BY``
    for why that is the honest option rather than a shortcut.
    """
    goal_item_ids = (
        None
        if goal_item_id is None
        else await resolve_goal_item_subtree(session, goal_item_id, user.id)
    )
    filters = read_filters(
        user.id,
        from_,
        to,
        category_id,
        kind,
        account_id,
        q=q,
        country=country,
        goal_item_ids=goal_item_ids,
    )

    total = await session.scalar(
        select(func.count()).select_from(Transaction).where(*filters)
    )
    rows = (
        await session.scalars(
            select(Transaction)
            .where(*filters)
            .order_by(*ORDER_BY[sort])
            .limit(limit)
            .offset(offset)
        )
    ).all()
    return TransactionList(
        items=[serialize_transaction(t) for t in rows], total=total or 0
    )


@router.get("/summary", response_model=SummaryRead)  # BEFORE any /{id} (Risks)
@mcp_tool(
    name="get_transactions_summary",
    description=(
        "Totals per category for ONE month, computed by the server in the base "
        "currency. Prefer it over summing list_transactions yourself — amounts in "
        "different currencies are converted server-side with the stored daily rate."
    ),
    params={
        "month": "Month to summarise, as YYYY-MM.",
    },
)
async def summary(
    month: str = Query(pattern=MONTH_PATTERN),
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> SummaryRead:
    # AM-6: the Query pattern is the ONLY month validator — a malformed month is a
    # Pydantic 422 before we get here, so date() below can never receive month 0/13,
    # nor (since the pattern carries the shared year envelope) a year that makes
    # `year + (mon == 12)` walk past `date.max`.
    year, mon = int(month[:4]), int(month[5:7])
    month_start = date(year, mon, 1)
    next_month_start = date(year + (mon == 12), (mon % 12) + 1, 1)

    # Read-only base-currency fallback: no profile write on a GET (POST self-heals).
    # Read FIRST — every total below is expressed in this currency.
    currency = await read_base_currency(session, user.id)

    # Totals + breakdown — one snapshot-aware aggregate (D9), see services/tx_totals.
    totals = await converted_totals(
        session, user.id, currency, month_start, next_month_start
    )
    # Ordering preserved from the pre-3.2 SQL (`ORDER BY kind, total DESC`); the
    # fold-in has no SQL ordering of its own, so it is applied here.
    by_category = [
        CategorySummary(
            category_id=category_id, kind=TransactionKind(kind), total_minor=total
        )
        for (category_id, kind), total in sorted(
            totals.by_bucket.items(), key=lambda item: (item[0][1], -item[1])
        )
    ]

    return SummaryRead(
        month=month,
        currency=currency,
        income_minor=totals.income_minor,
        expense_minor=totals.expense_minor,
        net_minor=totals.income_minor - totals.expense_minor,  # signed
        by_category=by_category,
        unconverted_count=totals.unconverted_count,
    )


@router.get(
    "/export",  # BEFORE any /{id} (Risks) — declared right after /summary
    # The handler returns a StreamingResponse of CSV bytes; there is no response model
    # to declare, and response_class keeps FastAPI from advertising an application/json
    # 200 arm this route can never emit (O-8, the /advisor/ask precedent). Without it
    # the default JSONResponse media type lands in the schema next to text/csv and the
    # generated client would type the body as JSON.
    response_model=None,
    response_class=StreamingResponse,
    responses={
        status.HTTP_200_OK: {
            "description": "CSV, UTF-8 with BOM, RFC-4180",
            "content": {"text/csv": {"schema": {"type": "string"}}},
        }
    },
)
# MCP: no — streaming CSV, nothing to curate
async def export_transactions(
    request: Request,
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None),
    category_id: uuid.UUID | None = None,
    kind: TransactionKind | None = None,
    account_id: uuid.UUID | None = None,
    q: str | None = Query(default=None),
    country: str | None = Query(default=None, pattern=COUNTRY_PATTERN),
    #: Same subtree semantics as the list — filter parity is the point (plan §5
    #: D-3). No new CSV column comes with it: the column set is a contract users
    #: write formulas against, and nobody asked for a plan column.
    goal_item_id: uuid.UUID | None = None,
    # Authorization header only — no token-in-query arm (D13): a URL carrying a
    # bearer token would end up in browser history, proxy logs and the download
    # manager. The export is fetched with headers and saved as a Blob.
    user: User = Depends(current_user_jwt_or_pat),
) -> StreamingResponse:
    """Stream the user's transactions as CSV — the list's filters, no paging.

    Filter parity with ``GET /transactions`` is mechanical, not copied — both call
    ``_read_filters``, so you export exactly what you are looking at. ``sort`` is the
    one list parameter this route does NOT declare: FastAPI ignores query parameters a
    route never declared, so sending it is a no-op rather than a 422, and the file
    stays oldest-first (see the ORDER BY below for why that is a contract, D13).

    The body is UTF-8 with a BOM and RFC-4180 quoting. Rows are ordered OLDEST-FIRST,
    unlike ``GET /transactions``; ``amount``/``base_amount``/``counter_amount`` are
    major-unit decimal strings, each at ITS OWN currency's exponent, and the base
    pair is the row's STORED snapshot — empty (never zero) when it has none.
    Transfers are included (OQ-3), with both account names and the arriving amount.
    """
    # This handler deliberately takes NO ``get_session``: FastAPI (>=0.106) closes a
    # yield dependency BEFORE the response body is streamed, so every query has to run
    # on the session ``csv_body`` opens itself (the ``_run_parse`` precedent). Getting
    # this wrong does not fail loudly — a closed AsyncSession silently checks out a
    # FRESH connection on its next use, so the whole scan would run on a connection
    # nothing in the request lifecycle owns or returns, racing engine disposal at
    # shutdown.
    sessionmaker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    goal_item_ids: list[uuid.UUID] | None = None
    if goal_item_id is not None:
        # Its own short session rather than a get_session dependency: adding one to
        # this route would contradict the reason it has none (see below), while the
        # resolution itself has to happen HERE — a 404 must be the response, not an
        # exception raised inside an already-streaming body.
        async with sessionmaker() as session:
            goal_item_ids = await resolve_goal_item_subtree(
                session, goal_item_id, user.id
            )
    stmt = (
        select(Transaction)
        .where(
            *read_filters(
                user.id,
                from_,
                to,
                category_id,
                kind,
                account_id,
                q=q,
                country=country,
                goal_item_ids=goal_item_ids,
            )
        )
        # Chronological ASC — a deliberate deviation from the list endpoint's DESC:
        # a spreadsheet is read top-down as a ledger, and every running-total formula
        # a user writes over this file assumes oldest-first. Same tiebreakers as the
        # list (created_at, then id) so the order is total and stable.
        .order_by(
            Transaction.occurred_at.asc(),
            Transaction.created_at.asc(),
            Transaction.id,
        )
    )
    return StreamingResponse(
        csv_body(sessionmaker, user.id, stmt),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="transactions.csv"'},
    )


@router.patch(
    "/{transaction_id}",
    response_model=TransactionRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
@mcp_tool(
    name="update_transaction",
    description=(
        "Correct ONE existing transaction. Send only the fields that change; omitted "
        "fields keep their value. PREFER this tool over delete_transaction for "
        "fixing mistakes. Take transaction_id from list_transactions, never guess it."
    ),
    params={
        "transaction_id": "Transaction id from list_transactions.",
        "account_id": (
            prose.ACCOUNT_ID
            + " Moves the transaction to another account: the server restamps the row "
            "with that account's currency and recomputes any conversion, so do NOT "
            "also send `currency` or converted amounts."
        ),
        "amount_minor": (
            _CHARGED_TO_ACCOUNT
            + prose.MINOR_UNITS
            + " Send it only when that charged amount is what is wrong. If you send a "
            "new `original_amount_minor` + `original_currency` pair WITHOUT it, the "
            "server recomputes the charged amount itself, at its stored daily rate "
            "for the transaction's date (and refuses the whole edit if it has no "
            "rate for that day). Send both when the user tells you the real bank "
            "charge as well — a sent amount is stored verbatim and beats any rate."
        ),
        "currency": prose.CURRENCY_FROM_ACCOUNT,
        "kind": (
            "Change between expense and income. An existing transaction can NOT "
            "become a transfer, and a transfer can not become an expense or income — "
            "the server rejects it. Converting one means re-creating it: show the "
            "user the row and get their explicit go-ahead before any "
            "delete_transaction."
        ),
        "counter_account_id": (
            "Transfers ONLY: move the DESTINATION side to another account, from "
            "list_accounts. It must differ from the source account."
        ),
        "counter_amount_minor": (
            "Transfers ONLY: correct how much ARRIVED, in INTEGER MINOR UNITS of the "
            "destination account's currency."
        ),
        "occurred_at": "New date of the transaction, as YYYY-MM-DD.",
        "category_id": (prose.CATEGORY_ID + " A transfer can never take one."),
        "merchant": "New merchant name.",
        "note": ("New note. " + prose.KEEP),
        "base_amount_minor": (
            "Only when the user states the exact converted amount in their base "
            "currency, in minor units; otherwise omit it and let the server keep or "
            "recompute its own conversion."
        ),
        "original_amount_minor": (
            prose.ORIGINAL_AMOUNT
            + " On a correction the pair is still atomic: both fields in the SAME "
            "call, or neither. "
            + prose.KEEP
            + " So an original leg recorded by mistake can be CHANGED here but never "
            "removed — if the user wants it gone, say so and let them do it in the "
            "app."
        ),
        "original_currency": (
            prose.ORIGINAL_CURRENCY
            + " It must differ from the currency the row ends up in, so moving the row "
            "to an account denominated in it is refused — change or keep them "
            "consistently in one call."
        ),
        "country": (prose.COUNTRY + " " + prose.KEEP),
        "goal_item_id": (
            prose.GOAL_ITEM_LINK
            + " Sending a DIFFERENT node moves the payment there, and the plan's "
            '"paid" figures follow on the next read. '
            + prose.KEEP
            + " So a link put on the wrong node is corrected here, but never removed — "
            "if the user wants the payment off the plan entirely, say so and let "
            "them do it in the app."
        ),
        "receipt_id": prose.RECEIPT_ID,
    },
)
async def update_transaction(
    transaction_id: uuid.UUID,
    payload: TransactionUpdate,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> TransactionRead:
    tx = await _load_own(session, transaction_id, user.id)
    if tx is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="TRANSACTION_NOT_FOUND"
        )

    fields = payload.model_fields_set
    # NOT NULL columns: an explicit null cannot clear them (else a bare apply 500s
    # on IntegrityError) — reject with a custom *_REQUIRED 422.
    if "amount_minor" in fields and payload.amount_minor is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="AMOUNT_REQUIRED"
        )
    if "kind" in fields and payload.kind is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="KIND_REQUIRED"
        )
    if "occurred_at" in fields and payload.occurred_at is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="OCCURRED_AT_REQUIRED",
        )
    if "currency" in fields and payload.currency is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="CURRENCY_REQUIRED",
        )
    if "account_id" in fields and payload.account_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="ACCOUNT_REQUIRED",
        )

    # ---- transfer-shape guards ------------------------------------------------
    # What the row IS decides which fields are legal; what the payload asks for can
    # never change that (a transfer stays a transfer, plan risk 4).
    is_transfer = tx.kind == TransactionKind.transfer.value
    if is_transfer:
        if ("counter_account_id" in fields and payload.counter_account_id is None) or (
            "counter_amount_minor" in fields and payload.counter_amount_minor is None
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="TRANSFER_FIELDS_REQUIRED",
            )
    elif "counter_account_id" in fields or "counter_amount_minor" in fields:
        # Decided by the FIELD SET, not the values: a counter field that a
        # non-transfer can never carry is unusable however it is spelled, so an
        # explicit ``null`` is refused exactly like a value (sent-and-unusable →
        # 422). It is also what keeps the ``counter_amount_minor`` assert at the
        # write site honest — a null used to slip past here and 500 down there.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="COUNTER_FIELDS_WITHOUT_TRANSFER",
        )
    if "kind" in fields and (payload.kind is TransactionKind.transfer) != is_transfer:
        # Morphing expense↔transfer in place would have to invent or drop a whole
        # target leg AND flip the snapshot rule; delete + create says the same thing
        # without a half-applied row in the middle.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="KIND_CHANGE_UNSUPPORTED",
        )

    # ---- the original leg (S1 §3) ---------------------------------------------
    # Decided by the FIELD SET, exactly like the counter fields above: the pair is
    # atomic, so one half alone — or one half as a value and the other as an
    # explicit null — is refused whole. On a transfer the fields are unusable
    # however they are spelled, so their mere presence is the 422.
    original_fields = fields & {"original_amount_minor", "original_currency"}
    if original_fields:
        if is_transfer:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="TRANSFER_ORIGINAL_FORBIDDEN",
            )
        if len(original_fields) != 2 or (
            (payload.original_amount_minor is None)
            != (payload.original_currency is None)
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="ORIGINAL_FIELDS_REQUIRED",
            )

    # ---- account moves --------------------------------------------------------
    # Same load-bearing order as create (risk 1): account NOT_FOUND → account
    # ARCHIVED → counter NOT_FOUND → SAME_ACCOUNT → counter ARCHIVED. An account
    # that is merely STORED on the row is not re-validated: archiving an account
    # must not freeze the note of every transaction already on it.
    account: Account | None = None
    counter: Account | None = None
    if "account_id" in fields:
        assert payload.account_id is not None  # 422-guarded above
        account = await require_own_account(session, payload.account_id, user.id)
        reject_archived(account)
        # The MOVE is the second door into the same room: ``kind`` is immutable
        # here, so an expense re-pointed at a deposit account would land exactly
        # where create refuses to put one.
        reject_deposit_spending(account, is_transfer=is_transfer)
    if is_transfer:
        if "counter_account_id" in fields:
            assert payload.counter_account_id is not None  # 422-guarded above
            counter = await require_own_account(
                session, payload.counter_account_id, user.id
            )
        # The pair this PATCH will LEAVE BEHIND — moving EITHER side onto the other
        # is the same illegal row, so the comparison is on the effective pair.
        eff_account_id = account.id if account is not None else tx.account_id
        eff_counter_id = counter.id if counter is not None else tx.counter_account_id
        if eff_account_id == eff_counter_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="SAME_ACCOUNT_TRANSFER",
            )
        if counter is not None:
            reject_archived(counter)

    # Snapshot decision table (D5). `eff_cur` is the currency the row will HAVE after
    # this PATCH, so "change currency to base + send an override" in one payload is
    # rejected whole (row 3) rather than half-applied. Since the accounts scope the
    # currency follows the ACCOUNT (§4): a moved row is restamped, and a sent
    # currency is only ever an echo of the effective account's.
    eff_cur = account.currency if account is not None else tx.currency
    if "currency" in fields and payload.currency != eff_cur:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="ACCOUNT_CURRENCY_MISMATCH",
        )
    # The original currency this PATCH will LEAVE BEHIND — moving the row onto an
    # account denominated in it is the same illegal row as sending the two equal,
    # so the comparison is on the effective pair and the PATCH is refused WHOLE (the
    # B3 recurring precedent: the user clears the original leg in the same edit).
    eff_original_currency = (
        payload.original_currency
        if "original_currency" in fields
        else tx.original_currency
    )
    if eff_original_currency is not None and eff_original_currency == eff_cur:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="ORIGINAL_CURRENCY_MATCHES_ACCOUNT",
        )
    # Settlement amount re-derived from a NEWLY SET original pair. Resolved BEFORE
    # any field write, so a rate miss refuses the whole PATCH rather than leaving a
    # row whose original leg and settlement amount disagree. A sent ``amount_minor``
    # wins (the bank's own rate) and CLEARING the pair never restates money — both
    # leave this None, which is what the write below keys off.
    derived_amount: int | None = None
    if (
        "original_amount_minor" in fields
        and payload.original_amount_minor is not None
        and "amount_minor" not in fields
    ):
        assert payload.original_currency is not None  # pair-guarded above
        eff_occurred_at = (
            payload.occurred_at if "occurred_at" in fields else tx.occurred_at
        )
        assert eff_occurred_at is not None  # 422-guarded above
        found = await lookup_rate(
            session, payload.original_currency, eff_cur, eff_occurred_at
        )
        if found is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="FX_RATE_UNAVAILABLE",
            )
        derived_amount = convert_minor(
            payload.original_amount_minor,
            payload.original_currency,
            eff_cur,
            found.rate,
        )
    if (
        is_transfer
        and "base_amount_minor" in fields
        and (payload.base_amount_minor is not None)
    ):
        raise HTTPException(  # architecture §5 — no snapshot to override
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="TRANSFER_BASE_AMOUNT_FORBIDDEN",
        )
    profile = await get_or_create_profile(session, user.id)
    base = profile.base_currency
    if (
        not is_transfer
        and eff_cur == base
        and "base_amount_minor" in fields
        and payload.base_amount_minor is not None
    ):
        raise HTTPException(  # row 3 — same rule as create, checked against eff_cur
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="BASE_AMOUNT_WITHOUT_CURRENCY",
        )

    # Category validated ONLY when in the field set AND non-null (decision e): an
    # amount-only edit of a tx whose category was archived after the fact must still
    # succeed; an explicit null clears to uncategorized with no validation.
    if "category_id" in fields and payload.category_id is not None:
        if is_transfer:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="TRANSFER_CATEGORY_FORBIDDEN",
            )
        await validate_category(session, payload.category_id, user.id)

    # Same rule as create, same helper, same no-oracle 422 (S3): a foreign or
    # missing receipt is one answer. An explicit null needs no check — detaching is
    # not a reference.
    if "receipt_id" in fields and payload.receipt_id is not None:
        await validate_receipt(session, payload.receipt_id, user.id)

    # ---- the plan link (goal-planner §3) --------------------------------------
    # Judged on the EFFECTIVE pair — the kind and the link this PATCH will LEAVE
    # BEHIND — so both directions of the expense-only rule are one check: linking a
    # non-expense, and re-kinding a row that is already linked. An explicit null
    # unlinks and needs no check at all.
    eff_kind = payload.kind.value if "kind" in fields and payload.kind else tx.kind
    eff_goal_item_id = (
        payload.goal_item_id if "goal_item_id" in fields else tx.goal_item_id
    )
    if "goal_item_id" in fields and payload.goal_item_id is not None:
        await validate_goal_item(session, payload.goal_item_id, user.id, eff_kind)
    elif eff_goal_item_id is not None and eff_kind != TransactionKind.expense.value:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="GOAL_ITEM_EXPENSE_ONLY",
        )

    if "amount_minor" in fields:
        assert payload.amount_minor is not None  # 422-guarded above
        tx.amount_minor = payload.amount_minor
    elif derived_amount is not None:
        # The server-derived settlement amount (plan §7.2). It reaches the row here
        # and the snapshot block below re-reads ``tx.amount_minor``, so the two can
        # never disagree — the snapshot block keys on ``derived_amount`` itself to
        # know that the settlement amount moved without ``amount_minor`` being sent.
        tx.amount_minor = derived_amount
    if "kind" in fields:
        assert payload.kind is not None  # 422-guarded above
        tx.kind = payload.kind.value
    if "occurred_at" in fields:
        assert payload.occurred_at is not None  # 422-guarded above
        tx.occurred_at = payload.occurred_at
    # `currency` is NOT written from the payload: it is a stamp of the account (§4),
    # and a value that disagreed was already refused above.
    if account is not None:
        tx.account_id = account.id
        tx.currency = account.currency  # restamp — the D5 block below recomputes
    if counter is not None:
        tx.counter_account_id = counter.id
        tx.counter_currency = counter.currency  # restamp, same rule as the source leg
    if "counter_amount_minor" in fields:
        assert payload.counter_amount_minor is not None  # 422-guarded above
        # Independent of amount_minor: the two legs ARE the facts, and the reported
        # rate is recomputed from them on the next read.
        tx.counter_amount_minor = payload.counter_amount_minor
    if "category_id" in fields:
        tx.category_id = payload.category_id  # explicit null clears
    if "note" in fields:
        tx.note = payload.note  # null/"" clears (validator normalized "" → None)
    if "merchant" in fields:
        # Explicit null/"" clears the stored merchant (validator normalized "" → None).
        # PATCH does NOT learn (D7): editing a merchant here never touches the map.
        tx.merchant = payload.merchant
    if "original_amount_minor" in fields:
        # Written as ONE pair (both keys present, both null or both set — guarded
        # above), so the CHECK that forbids half an original can never be reached.
        tx.original_amount_minor = payload.original_amount_minor
        tx.original_currency = payload.original_currency
    if "country" in fields:
        tx.country = payload.country  # explicit null clears
    if "goal_item_id" in fields:
        # Attach, MOVE to another node, or unlink on an explicit null. Nothing is
        # recomputed: "paid" is read from this column, never stored, so the number
        # on every affected node follows on the next read by construction.
        tx.goal_item_id = payload.goal_item_id
    if "receipt_id" in fields:
        # Attach, re-point or DETACH on an explicit null. The stored object in MinIO
        # is deliberately left alone: reaping orphans is a separate, explicitly
        # confirmed job, and deleting a file on an edit is unrecoverable.
        tx.receipt_id = payload.receipt_id

    # Snapshot rows 2/4/5/6/7 — applied AFTER the field writes above, so tx now holds
    # the effective amount/currency/date and no separate `eff_*` locals can drift.
    if is_transfer:
        # Architecture §5: the pair stays (None, None), full stop. This arm exists so
        # a transfer NEVER enters the branches below — one of them would write a
        # snapshot and the DB CHECK would turn the PATCH into a 500 (plan risk 4).
        pass
    elif eff_cur == base:
        # Row 2: cleared, never recomputed into a redundant self-copy — a copy would
        # go silently stale the day the profile's base currency changes.
        tx.base_amount_minor, tx.base_currency = None, None
    elif "base_amount_minor" in fields and payload.base_amount_minor is not None:
        # Row 4: the explicit override wins, even when conversion inputs also moved.
        tx.base_amount_minor, tx.base_currency = payload.base_amount_minor, base
    elif (
        "base_amount_minor" in fields
        or fields & _CONVERSION_INPUTS
        or derived_amount is not None
    ):
        # Row 5 (explicit null discards the override) and row 6 (a conversion input
        # moved) share one outcome: recompute, or NULL/NULL when the new date/pair
        # has no rate. Row 5 deliberately deviates from nullable-clears (R1(1)): a
        # bare clear would claim "no rate existed", which is a different fact.
        # ``derived_amount is not None`` is the third trigger and the only one not
        # readable off the field set: there the SERVER moved the settlement amount
        # from a newly set original pair, so the stored snapshot describes the OLD
        # amount. It is a separate condition rather than ``original_*`` in
        # _CONVERSION_INPUTS on purpose — CLEARING the pair leaves it None, and a
        # display-only edit must leave a manual base override standing (MAJOR-1).
        tx.base_amount_minor, tx.base_currency = await auto_snapshot(
            session, tx.amount_minor, tx.currency, base, tx.occurred_at
        )
    # Row 7 (no conversion input, no base_amount_minor): the stored snapshot stands.

    await session.commit()
    await session.refresh(tx)
    return serialize_transaction(tx)


@router.delete(
    "/{transaction_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=_NOT_FOUND,
)
@mcp_tool(
    name="delete_transaction",
    description=(
        "PERMANENTLY delete ONE transaction — the ONLY irreversible tool. Use it "
        "ONLY when the user has EXPLICITLY asked to delete this specific "
        "transaction. If in ANY doubt, first show the transaction you found "
        "(list_transactions) and ask the user to confirm. To fix mistakes prefer "
        "update_transaction. One entity per call — there is no bulk delete, no "
        "deletion by filter or by list of ids. Take transaction_id from "
        "list_transactions, never guess it."
    ),
    params={
        "transaction_id": (
            "Transaction id from list_transactions, confirmed with the user."
        ),
    },
)
async def delete_transaction(
    transaction_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> None:
    # Real DELETE (decision a): transactions are leaf rows, nothing references them.
    tx = await _load_own(session, transaction_id, user.id)
    if tx is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="TRANSACTION_NOT_FOUND"
        )
    await session.delete(tx)
    await session.commit()
