"""Statement import — upload, preview, decide, apply (architecture §6).

An upload parses the file, fingerprints every row, matches it against what the
account already holds and stores the whole thing as a PROPOSAL. Nothing here
touches money until ``apply``, which is the one route of this module that writes
to ``transactions`` (``replace``, the destructive twin, lands in S3).

Routes:

* ``POST /statement-imports`` — ``multipart/form-data`` (file + account_id +
  format), 201 with the session and its counters. The API's first multipart body;
  the generated client sends it as ``FormData`` (verified against the contract
  before this router was written, PM §10).
* ``GET /statement-imports/{id}`` — the session and both counter cross-sections.
* ``GET /statement-imports/{id}/rows`` — the preview, paged, with the candidate
  transactions embedded (§10.5).
* ``PATCH /statement-imports/{id}/rows/{row_id}`` — one row's decision and
  category, answering with the UPDATED row (§10.3).
* ``POST /statement-imports/{id}/rows/bulk-decision`` — one decision for a whole
  match status, answering with the session's counters (§10.8).
* ``POST /statement-imports/{id}/apply`` — execute the decisions, once.
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
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.account_access import load_own_account
from budget_api.category_access import load_visible_category
from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.enums import (
    DEPOSIT_ACCOUNT_TYPE,
    StatementImportStatus,
    StatementRowDecision,
    StatementRowMatchStatus,
    StatementSection,
    StatementSuggestionSource,
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
    StatementApplyReport,
    StatementBulkDecision,
    StatementImportError,
    StatementImportRead,
    StatementRowCandidate,
    StatementRowList,
    StatementRowPatch,
    StatementRowRead,
)
from budget_api.services.statement_import import PARSERS, StatementParseError
from budget_api.services.statement_import.apply import (
    ApplyOutcome,
    StatementApplyError,
    apply_import,
)
from budget_api.services.statement_import.categories import (
    CategorySuggestion,
    suggest_categories,
)
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
    suggestions: Sequence[CategorySuggestion | None],
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
    rows = _build_rows(session_row.id, statement, fingerprints, matches, suggestions)
    session.add_all(rows)
    await session.commit()
    await session.refresh(session_row)
    return session_row, rows


def _build_rows(
    import_id: uuid.UUID,
    statement: ParsedStatement,
    fingerprints: Sequence[uuid.UUID],
    matches: Sequence[RowMatch],
    suggestions: Sequence[CategorySuggestion | None],
) -> list[StatementImportRow]:
    """The stored rows of one upload — suggestions included.

    A suggestion is written to BOTH ``suggested_category_id`` (where it came from)
    and ``category_id`` (what apply will use), with ``category_user_set`` left
    false. That pair is the whole learning gate of §5: a preview nobody edits still
    files its rows where the user has been filing them, and yet teaches the maps
    nothing — a guess that confirmed itself would make the first mistake permanent.
    """
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
            suggested_category_id=None
            if suggestion is None
            else suggestion.category_id,
            suggestion_source=None if suggestion is None else suggestion.source,
            category_id=None if suggestion is None else suggestion.category_id,
            decision=match.decision,
        )
        for row, fingerprint, match, suggestion in zip(
            statement.rows, fingerprints, matches, suggestions, strict=True
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
        suggested_category_id=row.suggested_category_id,
        suggestion_source=(
            None
            if row.suggestion_source is None
            else StatementSuggestionSource(row.suggestion_source)
        ),
        category_id=row.category_id,
        category_user_set=row.category_user_set,
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
    # Read BEFORE the write and reused by the retry below: the two learned maps
    # cannot change under us mid-upload, and re-reading them would be two more
    # queries for the same answer.
    suggestions = await suggest_categories(session, user.id, statement.rows)

    try:
        session_row, rows = await _store_preview(
            session,
            user.id,
            account_id,
            statement,
            fingerprints,
            matches,
            suggestions,
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
            suggestions,
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


async def _load_live(
    session: AsyncSession, import_id: uuid.UUID, user_id: uuid.UUID
) -> StatementImport:
    """The session a WRITE may still touch, or the refusal that says why.

    Gate ORDER is the router's no-oracle rule: existence first (foreign == missing
    == 404), only then the lifecycle. An applied or replaced session is a JOURNAL
    of what was done to the user's money — editing its decisions afterwards would
    describe an import that never happened that way.
    """
    session_row = await _load_own(session, import_id, user_id)
    if session_row is None:
        raise _not_found()
    if session_row.status != StatementImportStatus.parsed.value:
        raise _unprocessable("IMPORT_FINISHED")
    return session_row


async def _require_category(
    session: AsyncSession, category_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """Body category-ref policy, verbatim from the transactions router.

    ``load_visible_category`` is the SHARED single code path, so foreign and
    missing are one 422 CATEGORY_NOT_FOUND with a byte-identical body; not-found
    strictly BEFORE archived, or a foreign archived category would answer
    CATEGORY_ARCHIVED and thereby confirm it exists.
    """
    category = await load_visible_category(session, category_id, user_id)
    if category is None:
        raise _unprocessable("CATEGORY_NOT_FOUND")
    if category.archived:
        raise _unprocessable("CATEGORY_ARCHIVED")


async def _reject_unreplaceable(
    session: AsyncSession,
    user_id: uuid.UUID,
    matched_tx_ids: Sequence[uuid.UUID | None],
) -> None:
    """``replace_own`` needs something to replace — and it may not be a transfer.

    Two refusals, in the order the user can act on them: without a matched
    transaction the decision is meaningless (DECISION_NEEDS_MATCH), and a transfer
    is ONE row seen from two accounts, so deleting it would erase the second
    account's history for money this statement cannot see
    (TRANSFER_REPLACE_FORBIDDEN — PM, plan §"Дельта").

    Refused HERE, at the moment the choice is made, because that is where the
    answer names the row the user just clicked. Apply repeats the transfer check
    over what it is about to delete: this route is not the only writer of
    ``decision``, and the deletion must not depend on the writer having been honest.
    """
    if any(tx_id is None for tx_id in matched_tx_ids):
        raise _unprocessable("DECISION_NEEDS_MATCH")
    wanted = [tx_id for tx_id in matched_tx_ids if tx_id is not None]
    if not wanted:
        return
    transfer = await session.scalar(
        select(Transaction.id)
        .where(
            Transaction.user_id == user_id,
            Transaction.id.in_(wanted),
            Transaction.kind == TransactionKind.transfer.value,
        )
        .limit(1)
    )
    if transfer is not None:
        raise _unprocessable("TRANSFER_REPLACE_FORBIDDEN")


@router.patch(
    "/{import_id}/rows/{row_id}",
    response_model=StatementRowRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def patch_statement_import_row(
    import_id: uuid.UUID,
    row_id: uuid.UUID,
    payload: StatementRowPatch,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> StatementRowRead:
    """One row's decision and/or category. Answers with the UPDATED row (§10.3).

    200 with the row rather than 204: the preview holds up to a thousand rows in a
    paged infinite query, and a client that had to re-read them all to see the
    effect of one click would page through the whole statement per click.

    Gate order: session (404) → lifecycle (422) → row (404) → category (422) →
    decision (422). The row lookup filters ``import_id`` AND ``row_id`` in ONE
    query, so a row of somebody else's session — or of another session of one's
    own — is indistinguishable from a row that does not exist, at BOTH levels.
    """
    session_row = await _load_live(session, import_id, user.id)
    row = await session.scalar(
        select(StatementImportRow).where(
            StatementImportRow.id == row_id,
            StatementImportRow.import_id == import_id,
        )
    )
    if row is None:
        raise _not_found()

    if "category_id" in payload.model_fields_set:
        if payload.category_id is not None:
            await _require_category(session, payload.category_id, user.id)
        row.category_id = payload.category_id
        # The learning gate, and the ONE place it is ever raised: the user sent a
        # category, so this pair may teach the maps at apply. An explicit null is
        # the user UN-choosing — it clears the flag with the value, because a row
        # with no category has nothing to teach anyone.
        row.category_user_set = payload.category_id is not None

    if payload.decision is not None:
        if payload.decision is StatementRowDecision.replace_own:
            await _reject_unreplaceable(session, user.id, [row.matched_tx_id])
        row.decision = payload.decision.value

    await session.commit()
    candidates = await _candidate_views(session, user.id, [row])
    return _serialize_row(row, session_row.statement_currency, candidates)


@router.post(
    "/{import_id}/rows/bulk-decision",
    response_model=StatementImportRead,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def bulk_decide_statement_import_rows(
    import_id: uuid.UUID,
    payload: StatementBulkDecision,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> StatementImportRead:
    """One decision for every row of ONE match status (§10.8).

    Keyed by the match status rather than by a list of ids: "keep all my own
    records" is the actual gesture, and a client that had to enumerate ids would
    first have to page through a thousand rows to name them.

    It moves the DECISION and nothing else — the category a user picked on a row
    survives a bulk "skip these", because those are two independent choices and the
    second must not silently discard the first. Rows of the other statuses are
    outside the WHERE clause and are not touched at all.

    The answer is the session, whose counters come from the same ``_counts_of`` the
    GET uses: what the confirmation screen shows after a bulk click has to be
    exactly what apply will do, and a second counting implementation is exactly how
    those two drift apart.
    """
    session_row = await _load_live(session, import_id, user.id)
    if payload.decision is StatementRowDecision.replace_own:
        matched = list(
            (
                await session.scalars(
                    select(StatementImportRow.matched_tx_id).where(
                        StatementImportRow.import_id == import_id,
                        StatementImportRow.match_status == payload.match_status.value,
                    )
                )
            ).all()
        )
        await _reject_unreplaceable(session, user.id, matched)

    await session.execute(
        update(StatementImportRow)
        .where(
            StatementImportRow.import_id == import_id,
            StatementImportRow.match_status == payload.match_status.value,
        )
        .values(decision=payload.decision.value)
    )
    await session.commit()
    by_match_status, by_decision = await _counts_of(session, import_id)
    return _serialize(session_row, by_match_status, by_decision)


async def _apply_once_or_twice(
    session: AsyncSession, import_id: uuid.UUID, user_id: uuid.UUID
) -> ApplyOutcome:
    """The apply, plus ONE retry of the whole procedure after an insert race.

    Two tabs applying the same session collide on the transactions idempotency
    index; under READ COMMITTED the loser's INSERT blocks until the winner commits,
    so by the time the duplicate key surfaces the winner's rows are visible. The
    retry therefore re-reads them as ``already_existed`` and reports the honest "it
    is all already in the ledger" instead of a 500 for a double-click.

    The retry is the SAME procedure, not a fallback path: idempotency here has one
    mechanism (B-1), and a second one would be a second thing to keep true.
    """
    try:
        return await apply_import(session, import_id, user_id)
    except IntegrityError:
        await session.rollback()
        logger.info("statement apply raced a parallel apply (import %s)", import_id)
        return await apply_import(session, import_id, user_id)


@router.post(
    "/{import_id}/apply",
    response_model=StatementApplyReport,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def apply_statement_import(
    import_id: uuid.UUID,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> StatementApplyReport:
    """Execute the session's decisions — the "reconcile" path (architecture §7).

    ONE database transaction for the whole statement, in ``services/.../apply.py``:
    a thousand rows must land together or not at all, and the session's status has
    to move with them.

    The report is the response body and nothing else (§10.6). ``skipped`` is taken
    from ``_counts_of`` rather than counted again here, so the number the
    confirmation dialog showed and the number the report shows are one query.
    """
    await _load_live(session, import_id, user.id)
    try:
        outcome = await _apply_once_or_twice(session, import_id, user.id)
    except StatementApplyError as exc:
        # A session cancelled between the gate above and the write is this
        # router's ordinary 404 — the same body a stranger's id gets.
        if exc.code == "IMPORT_NOT_FOUND":
            raise _not_found() from exc
        raise _unprocessable(exc.code) from exc
    _, by_decision = await _counts_of(session, import_id)
    return StatementApplyReport(
        created=outcome.created,
        skipped=by_decision.skip,
        replaced=outcome.replaced,
        already_existed=outcome.already_existed,
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
    session_row = await _load_live(session, import_id, user.id)
    await session.delete(session_row)
    await session.commit()
