"""Statement import — upload, preview, cancel (statement-import architecture §6).

S1 is the SAFE half of the scope: nothing here creates, edits or deletes a
transaction. An upload parses the file, fingerprints every row, matches it against
what the account already holds and stores the whole thing as a PROPOSAL; the
routes that act on that proposal (PATCH a row, apply, replace) land in S2/S3.

Routes:

* ``POST /statement-imports`` — ``multipart/form-data`` (file + account_id +
  format), 201 with the session and its counters. The API's first multipart body;
  the generated client sends it as ``FormData`` (verified against the contract
  before this router was written, PM §10).
* ``GET /statement-imports/{id}`` — the session and both counter cross-sections.
* ``GET /statement-imports/{id}/rows`` — the preview, paged, with the candidate
  transactions embedded (§10.5).
* ``DELETE /statement-imports/{id}`` — cancel a ``parsed`` session, 204.

The two authorization pillars of every data router (categories.py §3): reads
filter ``user_id = me``, writes force it. No-oracle: a foreign session id and a
missing one both resolve through ``_load_own`` to ONE ``404 IMPORT_NOT_FOUND``
with a byte-identical body.

MCP: NO, for every route (architecture §6) — and by MECHANISM, not by prose. None
of these (method, path) pairs is in ``pat_auth.PAT_ALLOWLIST``, which is
fail-closed, so a personal access token is refused with 403
TOKEN_ENDPOINT_FORBIDDEN before the handler is ever reached. Upload and preview
are safe on their own, but they only mean anything as preparation for an apply an
AI agent deliberately does not have.
"""

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import JSONResponse
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.account_access import load_own_account
from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.enums import (
    DEPOSIT_ACCOUNT_TYPE,
    StatementImportStatus,
    StatementRowDecision,
    StatementRowMatchStatus,
    StatementSection,
    TransactionKind,
)
from budget_api.models import (
    Account,
    StatementImport,
    StatementImportRow,
    Transaction,
    User,
)
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.rate_limit import (
    limiter,
    rate_limit_exempt,
    statement_import_limit_value,
    statement_import_rl_key,
)
from budget_api.schemas.statement_import import (
    DecisionCounts,
    MatchStatusCounts,
    StatementImportError,
    StatementImportRead,
    StatementRowCandidate,
    StatementRowList,
    StatementRowRead,
)
from budget_api.services.statement_import import PARSERS, StatementParseError
from budget_api.services.statement_import.fingerprint import client_ids
from budget_api.services.statement_import.matching import (
    SIMILAR_WINDOW,
    RowMatch,
    TxCandidate,
    match_rows,
)
from budget_api.services.statement_import.types import ParsedStatement

logger = logging.getLogger(__name__)

router = APIRouter()

#: Page size ceiling of the preview (architecture §6). A thousand-row statement is
#: five pages, which the existing TransactionList pattern already handles.
_ROWS_MAX_LIMIT = 200
_FILENAME_MAX = 255

_IMPORT_ERR: dict[str, object] = {"model": StatementImportError}
_NOT_FOUND: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: _IMPORT_ERR
}
_RATE_LIMITED: dict[int | str, dict[str, object]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: _IMPORT_ERR
}
# The honest anyOf union (AM-5, the deposits/receipts precedent): these routes emit
# BOTH our business codes and FastAPI's auto Pydantic array at runtime.
# HTTPValidationError is referenced, never hand-declared.
_UNPROCESSABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {
            "application/json": {
                "schema": {
                    "anyOf": [
                        {"$ref": "#/components/schemas/StatementImportError"},
                        {"$ref": "#/components/schemas/HTTPValidationError"},
                    ]
                }
            }
        },
    }
}

# slowapi's Limiter.limit is typed to return a bare Callable (Unknown), which trips
# pyright-strict reportUnknownMemberType; route the decorator through an Any alias
# so the partial type stays contained here (the receipts router's containment).
_limiter_any: Any = limiter


def _unprocessable(code: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=code)


def _not_found() -> HTTPException:
    """The ONE 404 of this router — foreign and missing share it (no-oracle)."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail="IMPORT_NOT_FOUND"
    )


def _currency_mismatch(statement_currency: str, account_currency: str) -> JSONResponse:
    """422 STATEMENT_CURRENCY_MISMATCH, naming BOTH currencies (§10.7).

    A ``JSONResponse`` rather than an ``HTTPException`` because this is the one
    refusal in the API whose body carries more than ``detail``: the handler's
    exception envelope is ``{"detail": ...}`` and nothing else, while a client that
    is told only "mismatch" has to fetch the account and re-read the file to say
    what went wrong. The extra fields are declared on ``StatementImportError``, so
    the contract advertises exactly this shape.
    """
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content=StatementImportError(
            detail="STATEMENT_CURRENCY_MISMATCH",
            statement_currency=statement_currency,
            account_currency=account_currency,
        ).model_dump(),
    )


async def _stash_rl_user(
    request: Request, user: User = Depends(current_user_jwt_or_pat)
) -> User:
    """``stash_rl_user`` for the upload's per-user key (the receipts precedent).

    Goes through the PAT-aware dependency on purpose: a personal access token must
    reach the allowlist gate and be refused there with 403
    TOKEN_ENDPOINT_FORBIDDEN (and be audited), rather than dying earlier as an
    unparseable JWT.
    """
    request.state.rl_user_id = str(user.id)
    return user


async def _load_own(
    session: AsyncSession, import_id: uuid.UUID, user_id: uuid.UUID
) -> StatementImport | None:
    """user_id-scoped load; foreign/missing → None → 404 (no-oracle, one path)."""
    return await session.scalar(
        select(StatementImport).where(
            StatementImport.id == import_id, StatementImport.user_id == user_id
        )
    )


async def _require_own_account(
    session: AsyncSession, account_id: uuid.UUID, user_id: uuid.UUID
) -> Account:
    """The upload target. Guard ORDER is load-bearing (account_access.py).

    Not-found BEFORE archived, so a foreign archived account answers 404 and never
    leaks ``ACCOUNT_ARCHIVED``. A ``type='deposit'`` account is treated as missing
    for the same reason ``PATCH /accounts/{id}`` treats it so: it is the hidden
    ledger of a deposit, it takes transfers and nothing else, so a statement could
    never be applied to it.
    """
    account = await load_own_account(session, account_id, user_id)
    if account is None or account.type == DEPOSIT_ACCOUNT_TYPE:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="ACCOUNT_NOT_FOUND"
        )
    if account.archived:
        raise _unprocessable("ACCOUNT_ARCHIVED")
    return account


async def _read_upload(file: UploadFile, settings: Settings) -> bytes:
    """The whole file, or 422 STATEMENT_TOO_LARGE.

    Reads ``limit + 1`` bytes and refuses on the overflow byte: the multipart
    ``Content-Length`` is a client claim, and this gate exists precisely for the
    case where the claim is wrong.
    """
    data = await file.read(settings.statement_max_bytes + 1)
    if len(data) > settings.statement_max_bytes:
        raise _unprocessable("STATEMENT_TOO_LARGE")
    return data


def _candidate_window(statement: ParsedStatement) -> tuple[date, date]:
    """The date range the matcher can possibly reach, widened by its own tolerance.

    NOT the printed period ±1: the bank selects the lines of a statement by their
    POSTING date, so a purchase made a few days before ``period_from`` and posted
    inside it arrives with ``txn_date < period_from`` (the 1-3 day lag is a fact of
    the format, task.md §Факты). The user, who dates a hand-typed row by the day of
    the purchase, has that transaction OUTSIDE the printed period — and a candidate
    that is not loaded is a row reported ``new``, i.e. a duplicate on apply.

    So the window is the printed period UNIONed with the rows' own dates, and only
    then widened by ``SIMILAR_WINDOW`` — the same constant the matcher compares
    against, so the two can never drift apart.
    """
    since = statement.period_from
    until = statement.period_to
    for row in statement.rows:
        since = min(since, row.txn_date)
        until = max(until, row.booked_date)
    return since - SIMILAR_WINDOW, until + SIMILAR_WINDOW


async def _load_candidates(
    session: AsyncSession,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    statement: ParsedStatement,
) -> list[TxCandidate]:
    """Everything this account could possibly match against, in ONE select.

    "This account" means EITHER leg (the ``_read_filters`` rule): an incoming
    transfer is money that landed here, and the statement shows it as an ordinary
    credit. The window is ``_candidate_window`` above, so the matcher never has to
    ask for more rows.

    A transfer is handed to the matcher AS THIS ACCOUNT SEES IT: leaving here it is
    an expense of ``amount_minor``, arriving here an income of
    ``counter_amount_minor`` (already denominated in this account's currency).
    """
    since, until = _candidate_window(statement)
    rows = (
        await session.execute(
            select(
                Transaction.id,
                Transaction.client_id,
                Transaction.kind,
                Transaction.amount_minor,
                Transaction.counter_amount_minor,
                Transaction.account_id,
                Transaction.occurred_at,
                Transaction.merchant,
            ).where(
                Transaction.user_id == user_id,
                or_(
                    Transaction.account_id == account_id,
                    Transaction.counter_account_id == account_id,
                ),
                Transaction.occurred_at >= since,
                Transaction.occurred_at <= until,
            )
        )
    ).all()

    candidates: list[TxCandidate] = []
    for row in rows:
        is_transfer = row.kind == TransactionKind.transfer.value
        if not is_transfer:
            kind, amount_minor = row.kind, row.amount_minor
        elif row.account_id == account_id:
            kind, amount_minor = TransactionKind.expense.value, row.amount_minor
        else:
            # The counter leg: what LANDED here, in this account's own currency.
            if row.counter_amount_minor is None:  # pragma: no cover - CHECK-enforced
                continue
            kind, amount_minor = (
                TransactionKind.income.value,
                row.counter_amount_minor,
            )
        candidates.append(
            TxCandidate(
                id=row.id,
                client_id=row.client_id,
                kind=kind,
                amount_minor=amount_minor,
                occurred_at=row.occurred_at,
                merchant=row.merchant,
                is_transfer=is_transfer,
            )
        )
    return candidates


async def _store_preview(
    session: AsyncSession,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    statement: ParsedStatement,
    fingerprints: Sequence[uuid.UUID],
    matches: Sequence[RowMatch],
    filename: str,
    settings: Settings,
) -> tuple[StatementImport, list[StatementImportRow]]:
    """The whole write of an upload, in ONE transaction — and retryable as a whole.

    The supersede, the TTL sweep and the new session are one state change: a user
    who re-uploads must never end up with two live previews of the same account,
    not even briefly. Every ORM object is built HERE rather than passed in, so the
    caller's retry after a rollback starts from clean instances instead of ones
    the failed flush already touched.

    It opens by taking the per-(user, account) advisory lock, which is what makes
    "delete what is live, then insert" correct under concurrency: two parallel
    uploads of the same account otherwise both DELETE a state in which the other
    has not committed, and the loser collides with
    ``uq_statement_imports_live_preview``. The lock serializes them into exactly
    the sequential outcome — the last upload wins — instead of a 500 for a
    double-submit. Transaction-scoped, so it is released by the commit below (or by
    the rollback of a failure), never held past the request. The precedent is the
    ``goal_items_no_cycle`` trigger (migration 0011), down to the
    ``hashtextextended`` key; the text prefix keeps this namespace apart from that
    one's goal ids.
    """
    await session.execute(
        select(
            func.pg_advisory_xact_lock(
                func.hashtextextended(f"statement-import:{user_id}:{account_id}", 0)
            )
        )
    )
    await session.execute(
        delete(StatementImport).where(
            StatementImport.user_id == user_id,
            StatementImport.account_id == account_id,
            StatementImport.status == StatementImportStatus.parsed.value,
        )
    )
    await session.execute(
        delete(StatementImport).where(
            StatementImport.user_id == user_id,
            StatementImport.status == StatementImportStatus.parsed.value,
            StatementImport.created_at
            < datetime.now(UTC) - timedelta(days=settings.statement_import_ttl_days),
        )
    )
    session_row = StatementImport(
        user_id=user_id,
        account_id=account_id,
        status=StatementImportStatus.parsed.value,
        source_format=statement.source_format,
        filename=filename,
        statement_currency=statement.currency,
        period_from=statement.period_from,
        period_to=statement.period_to,
        rows_total=len(statement.rows),
        rows_blocked=statement.rows_blocked,
        rows_zero_skipped=statement.rows_zero_skipped,
    )
    session.add(session_row)
    # Flush, not commit: the rows need the session's id, and a session without its
    # rows must never survive a failure of the second insert.
    await session.flush()
    rows = _build_rows(session_row.id, statement, fingerprints, matches)
    session.add_all(rows)
    await session.commit()
    await session.refresh(session_row)
    return session_row, rows


def _build_rows(
    import_id: uuid.UUID,
    statement: ParsedStatement,
    fingerprints: Sequence[uuid.UUID],
    matches: Sequence[RowMatch],
) -> list[StatementImportRow]:
    return [
        StatementImportRow(
            import_id=import_id,
            row_index=row.row_index,
            section=row.section,
            txn_date=row.txn_date,
            txn_time=row.txn_time,
            booked_date=row.booked_date,
            description=row.description,
            bank_category=row.bank_category,
            kind=row.kind,
            amount_minor=row.amount_minor,
            original_amount_minor=row.original_amount_minor,
            original_currency=row.original_currency,
            fee_minor=row.fee_minor,
            raw=row.raw,
            client_id=fingerprint,
            match_status=match.match_status,
            matched_tx_id=match.matched_tx_id,
            candidate_tx_ids=(
                [str(tx_id) for tx_id in match.candidate_tx_ids]
                if match.candidate_tx_ids
                else None
            ),
            possible_transfer=row.possible_transfer,
            decision=match.decision,
        )
        for row, fingerprint, match in zip(
            statement.rows, fingerprints, matches, strict=True
        )
    ]


def _counts(
    rows: Sequence[StatementImportRow],
) -> tuple[MatchStatusCounts, DecisionCounts]:
    """Both cross-sections (§10.4), counted in memory over one session's rows."""
    return (
        MatchStatusCounts(
            exact=sum(
                r.match_status == StatementRowMatchStatus.exact.value for r in rows
            ),
            similar=sum(
                r.match_status == StatementRowMatchStatus.similar.value for r in rows
            ),
            new=sum(r.match_status == StatementRowMatchStatus.new.value for r in rows),
        ),
        DecisionCounts(
            import_=sum(r.decision == StatementRowDecision.import_.value for r in rows),
            skip=sum(r.decision == StatementRowDecision.skip.value for r in rows),
            replace_own=sum(
                r.decision == StatementRowDecision.replace_own.value for r in rows
            ),
        ),
    )


async def _counts_of(
    session: AsyncSession, import_id: uuid.UUID
) -> tuple[MatchStatusCounts, DecisionCounts]:
    """The same two cross-sections, aggregated in SQL for a stored session.

    Computed per request rather than denormalized onto the session: the decisions
    are what S2 edits row by row, and a stored counter would be one more thing that
    can disagree with the rows it claims to describe.
    """
    grouped = (
        await session.execute(
            select(
                StatementImportRow.match_status,
                StatementImportRow.decision,
                func.count(),
            )
            .where(StatementImportRow.import_id == import_id)
            .group_by(StatementImportRow.match_status, StatementImportRow.decision)
        )
    ).all()
    by_match: dict[str, int] = {}
    by_decision: dict[str, int] = {}
    for match_status, decision, count in grouped:
        by_match[match_status] = by_match.get(match_status, 0) + count
        by_decision[decision] = by_decision.get(decision, 0) + count
    return (
        MatchStatusCounts(
            exact=by_match.get(StatementRowMatchStatus.exact.value, 0),
            similar=by_match.get(StatementRowMatchStatus.similar.value, 0),
            new=by_match.get(StatementRowMatchStatus.new.value, 0),
        ),
        DecisionCounts(
            import_=by_decision.get(StatementRowDecision.import_.value, 0),
            skip=by_decision.get(StatementRowDecision.skip.value, 0),
            replace_own=by_decision.get(StatementRowDecision.replace_own.value, 0),
        ),
    )


def _serialize(
    session_row: StatementImport,
    by_match_status: MatchStatusCounts,
    by_decision: DecisionCounts,
) -> StatementImportRead:
    return StatementImportRead(
        id=session_row.id,
        account_id=session_row.account_id,
        status=StatementImportStatus(session_row.status),
        source_format=session_row.source_format,
        filename=session_row.filename,
        statement_currency=session_row.statement_currency,
        period_from=session_row.period_from,
        period_to=session_row.period_to,
        rows_total=session_row.rows_total,
        rows_blocked=session_row.rows_blocked,
        rows_zero_skipped=session_row.rows_zero_skipped,
        by_match_status=by_match_status,
        by_decision=by_decision,
        created_at=session_row.created_at,
        applied_at=session_row.applied_at,
    )


def _row_candidate_ids(row: StatementImportRow) -> list[uuid.UUID]:
    """The row's related transactions, best first, matched one always first.

    ``candidate_tx_ids`` holds the ``similar`` alternatives; ``matched_tx_id`` is
    the pick — and on an ``exact`` row it is the ONLY related transaction there is.
    A screen that wants to show "my record" must not have to ask twice depending on
    which of the two verdicts it got.
    """
    ids: list[uuid.UUID] = []
    if row.matched_tx_id is not None:
        ids.append(row.matched_tx_id)
    for raw_id in row.candidate_tx_ids or []:
        candidate_id = uuid.UUID(raw_id)
        if candidate_id not in ids:
            ids.append(candidate_id)
    return ids


async def _candidate_views(
    session: AsyncSession, user_id: uuid.UUID, rows: Sequence[StatementImportRow]
) -> dict[uuid.UUID, StatementRowCandidate]:
    """One JOIN for the whole page (§10.5) — never one lookup per row."""
    wanted = {tx_id for row in rows for tx_id in _row_candidate_ids(row)}
    if not wanted:
        return {}
    found = (
        await session.execute(
            select(
                Transaction.id,
                Transaction.occurred_at,
                Transaction.amount_minor,
                Transaction.currency,
                Transaction.kind,
                Transaction.merchant,
                Transaction.note,
            ).where(
                # user-scoped like every read in this codebase, even though these
                # ids came out of the user's own session rows.
                Transaction.user_id == user_id,
                Transaction.id.in_(wanted),
            )
        )
    ).all()
    return {
        tx.id: StatementRowCandidate(
            id=tx.id,
            occurred_at=tx.occurred_at,
            amount_minor=tx.amount_minor,
            currency=tx.currency,
            kind=TransactionKind(tx.kind),
            merchant=tx.merchant,
            note=tx.note,
        )
        for tx in found
    }


def _serialize_row(
    row: StatementImportRow,
    currency: str,
    candidates: dict[uuid.UUID, StatementRowCandidate],
) -> StatementRowRead:
    return StatementRowRead(
        id=row.id,
        row_index=row.row_index,
        section=StatementSection(row.section),
        txn_date=row.txn_date,
        txn_time=row.txn_time,
        booked_date=row.booked_date,
        description=row.description,
        bank_category=row.bank_category,
        kind=TransactionKind(row.kind),
        amount_minor=row.amount_minor,
        # From the SESSION, always (§10.1): the statement's currency was verified
        # equal to the account's at upload, so this can never disagree with what a
        # created transaction would be stamped with.
        currency=currency,
        original_amount_minor=row.original_amount_minor,
        original_currency=row.original_currency,
        fee_minor=row.fee_minor,
        match_status=StatementRowMatchStatus(row.match_status),
        matched_tx_id=row.matched_tx_id,
        candidates=[
            candidates[tx_id]
            for tx_id in _row_candidate_ids(row)
            # A transaction deleted since the parse simply stops being reported.
            if tx_id in candidates
        ],
        possible_transfer=row.possible_transfer,
        decision=StatementRowDecision(row.decision),
    )


@router.post(
    "",
    response_model=StatementImportRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_NOT_FOUND, **_UNPROCESSABLE, **_RATE_LIMITED},
)
@_limiter_any.limit(
    statement_import_limit_value,
    key_func=statement_import_rl_key,
    exempt_when=rate_limit_exempt,
)
async def create_statement_import(
    request: Request,
    file: Annotated[UploadFile, File()],
    account_id: Annotated[uuid.UUID, Form()],
    format: Annotated[str, Form()],
    user: User = Depends(_stash_rl_user),
    session: AsyncSession = Depends(get_session),
) -> StatementImportRead | JSONResponse:
    """Parse a statement into a preview session for ``account_id``.

    Gate ORDER (architecture §6): account → size → format → parse → currency → DB.
    Everything that can refuse the request does so BEFORE a single row is written,
    so a failed upload leaves nothing behind to clean up or to show.
    """
    settings: Settings = request.app.state.settings
    account = await _require_own_account(session, account_id, user.id)
    data = await _read_upload(file, settings)

    parser = PARSERS.get(format)
    if parser is None:
        raise _unprocessable("STATEMENT_FORMAT_UNKNOWN")
    try:
        statement = parser(data)
    except StatementParseError as exc:
        # Logged at INFO with the reason (never the file's contents — it is a bank
        # statement) so a real format drift is diagnosable from the server side.
        logger.info("statement parse failed (account %s): %s", account_id, exc)
        raise _unprocessable("STATEMENT_PARSE_FAILED") from exc

    if statement.currency != account.currency:
        # The account's currency is what every created transaction would be
        # stamped with, so importing a statement in another currency would file
        # foreign money as if it were the account's own.
        return _currency_mismatch(statement.currency, account.currency)

    filename = (file.filename or "statement.csv")[:_FILENAME_MAX]
    fingerprints = client_ids(user.id, account_id, statement.rows)
    matches = match_rows(
        statement.rows,
        fingerprints,
        await _load_candidates(session, user.id, account_id, statement),
    )

    try:
        session_row, rows = await _store_preview(
            session,
            user.id,
            account_id,
            statement,
            fingerprints,
            matches,
            filename,
            settings,
        )
    except IntegrityError:
        # The recovery arm behind the advisory lock (the B-1 precedent): if a write
        # ever reaches ``uq_statement_imports_live_preview`` without holding the
        # lock, one retry — whose DELETE now sees the committed winner — still ends
        # where a sequential pair of uploads would, instead of answering 500 for a
        # double-submit. Anything else that can raise here (a concurrently deleted
        # account) fails the retry the same way and propagates, which is today's
        # behaviour for every other constraint.
        await session.rollback()
        logger.info(
            "statement preview raced a parallel upload (account %s)", account_id
        )
        session_row, rows = await _store_preview(
            session,
            user.id,
            account_id,
            statement,
            fingerprints,
            matches,
            filename,
            settings,
        )

    by_match_status, by_decision = _counts(rows)
    return _serialize(session_row, by_match_status, by_decision)


@router.get(
    "/{import_id}", response_model=StatementImportRead, responses={**_NOT_FOUND}
)
async def get_statement_import(
    import_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> StatementImportRead:
    session_row = await _load_own(session, import_id, user.id)
    if session_row is None:
        raise _not_found()
    by_match_status, by_decision = await _counts_of(session, import_id)
    return _serialize(session_row, by_match_status, by_decision)


@router.get(
    "/{import_id}/rows", response_model=StatementRowList, responses={**_NOT_FOUND}
)
async def list_statement_import_rows(
    import_id: uuid.UUID,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=_ROWS_MAX_LIMIT, ge=1, le=_ROWS_MAX_LIMIT),
    match_status: StatementRowMatchStatus | None = None,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> StatementRowList:
    """The preview, in FILE order, with each row's candidates embedded."""
    session_row = await _load_own(session, import_id, user.id)
    if session_row is None:
        raise _not_found()

    filters = [StatementImportRow.import_id == import_id]
    if match_status is not None:
        filters.append(StatementImportRow.match_status == match_status.value)
    total = await session.scalar(
        select(func.count()).select_from(StatementImportRow).where(*filters)
    )
    rows = list(
        (
            await session.scalars(
                select(StatementImportRow)
                .where(*filters)
                # row_index is unique within a session, so the order is TOTAL:
                # offset paging can neither repeat nor skip a row.
                .order_by(StatementImportRow.row_index)
                .offset(offset)
                .limit(limit)
            )
        ).all()
    )
    candidates = await _candidate_views(session, user.id, rows)
    return StatementRowList(
        items=[
            _serialize_row(row, session_row.statement_currency, candidates)
            for row in rows
        ],
        total=total or 0,
    )


@router.delete(
    "/{import_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def delete_statement_import(
    import_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Cancel a preview. The rows go with it (``ON DELETE CASCADE``).

    Only a ``parsed`` session can be cancelled: an applied or replaced one is a
    JOURNAL of what was done to the user's money, and deleting it would erase the
    record without undoing anything.
    """
    session_row = await _load_own(session, import_id, user.id)
    if session_row is None:
        raise _not_found()
    if session_row.status != StatementImportStatus.parsed.value:
        raise _unprocessable("IMPORT_FINISHED")
    await session.delete(session_row)
    await session.commit()
