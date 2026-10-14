"""Statement import — upload, preview, decide, apply (architecture §6).

An upload parses the file, fingerprints every row, matches it against what the
account already holds and stores the whole thing as a PROPOSAL. Nothing here
touches money until ``apply`` and its destructive twin ``replace`` — the two
routes of this module that write to ``transactions``, both of them once per
session and both through ``services/statement_import/apply.py``.

Routes:

* ``POST /statement-imports`` — ``multipart/form-data`` (file + account_id +
  format), 201 with the session and its counters. The API's first multipart body;
  the generated client sends it as ``FormData`` (verified against the contract
  before this router was written, PM §10).
* ``GET /statement-imports/formats`` — the format ids this server can parse, so
  the "bank" control is filled from the registry and a new bank needs no client
  release. Declared BEFORE ``/{id}``, or "formats" would be read as an import id.
* ``GET /statement-imports/{id}`` — the session and both counter cross-sections.
* ``GET /statement-imports/{id}/rows`` — the preview, paged, with the candidate
  transactions embedded (§10.5).
* ``PATCH /statement-imports/{id}/rows/{row_id}`` — one row's decision and
  category, answering with the UPDATED row (§10.3).
* ``POST /statement-imports/{id}/rows/bulk-decision`` — one decision for a whole
  match status, answering with the session's counters (§10.8).
* ``POST /statement-imports/{id}/apply`` — execute the decisions, once.
* ``GET /statement-imports/{id}/replace-preview?from=`` — what a replace would
  destroy, counted before anything is confirmed. Mutates nothing.
* ``POST /statement-imports/{id}/replace`` — wipe the account's ``[from;
  period_to]`` and re-file the statement over it, once, against a confirmed count.
* ``DELETE /statement-imports/{id}`` — cancel a ``parsed`` session, 204.
* ``POST /statement-imports/{id}/reconcile`` — run the reconcile agent over this
  session and the account's own transactions, answering the whole report. JWT
  only, provider-gated, claimed (pdf-reconcile §4).
* ``GET /statement-imports/{id}/reconciliation`` — the stored report, 200 with
  ``status='none'`` for a session nobody has reconciled.

The two authorization pillars of every data router (categories.py §3): reads
filter ``user_id = me``, writes force it. No-oracle: a foreign session id and a
missing one both resolve through ``_load_own`` to ONE ``404 IMPORT_NOT_FOUND``
with a byte-identical body.

MCP: NO, for every route here (architecture §6) — and by MECHANISM, not by prose.
Not one handler in this module carries an MCP marker (``mcp/decorator.py``), and
an unmarked route is not in the derived PAT allowlist, so a personal access token
is refused with 403 TOKEN_ENDPOINT_FORBIDDEN before the handler is ever reached.
Upload and preview are safe on their own, but they only mean anything as
preparation for an apply an AI agent deliberately does not have. One paragraph
for all nine routes rather than nine identical comments; anyone adding a tenth
route to this module is answering the same question, and the answer is still no.
"""

import logging
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Any, NamedTuple

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
from limits import parse_many
from sqlalchemy import ColumnElement, delete, func, null, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.account_access import load_own_account
from budget_api.ai_gate import require_llm_provider
from budget_api.auth import current_active_user
from budget_api.category_access import load_visible_category, visible_categories_clause
from budget_api.config import Settings
from budget_api.db import get_session
from budget_api.enums import (
    DEPOSIT_ACCOUNT_TYPE,
    CategoryKind,
    DiscrepancyKind,
    StatementAiStatus,
    StatementBalanceCheck,
    StatementImportStatus,
    StatementReconciliationStatus,
    StatementRowDecision,
    StatementRowMatchStatus,
    StatementSection,
    StatementSelfCheckFailure,
    StatementSelfCheckStatus,
    StatementSuggestionSource,
    TransactionKind,
)
from budget_api.llm import LLMProvider
from budget_api.models import (
    Account,
    Category,
    Profile,
    StatementImport,
    StatementImportRow,
    Transaction,
    User,
)
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.rate_limit import (
    limiter,
    rate_limit_exempt,
    reconcile_limit_value,
    reconcile_rl_key,
    statement_import_limit_value,
    statement_import_rl_key,
)
from budget_api.schemas.statement_import import (
    DecisionCounts,
    DiscrepancyCounts,
    DiscrepancyRowView,
    DiscrepancyTxView,
    MatchStatusCounts,
    StatementApplyReport,
    StatementBulkDecision,
    StatementDiscrepancy,
    StatementFormatsRead,
    StatementImportError,
    StatementImportRead,
    StatementReconciliationRead,
    StatementReplacePreview,
    StatementReplaceReport,
    StatementReplaceRequest,
    StatementRowCandidate,
    StatementRowList,
    StatementRowPatch,
    StatementRowRead,
)
from budget_api.services.categorize import (
    PROMPT_VERSION,
    CategorizeConfig,
    CategorizeResult,
    CategoryOption,
    Operation,
    categorize,
)
from budget_api.services.reconcile import (
    PROMPT_VERSION as RECONCILE_PROMPT_VERSION,
)
from budget_api.services.reconcile import (
    RECONCILE_PAIR_WINDOW,
    ReconcileConfig,
    Report,
    RowFact,
    TxFact,
    prematch,
    reconcile,
    report_from_json,
    stored_report,
)
from budget_api.services.statement_import import (
    EXTRACTORS,
    FORMAT_IDS,
    PARSERS,
    StatementParseError,
)
from budget_api.services.statement_import.alfa_pdf import (
    ExtractConfig,
    StatementExtractionError,
)
from budget_api.services.statement_import.apply import (
    DELETABLE_BY_REPLACE,
    ApplyOutcome,
    ReplaceOutcome,
    StatementApplyError,
    StatementReplaceMismatch,
    apply_import,
    replace_import,
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
from budget_api.services.statement_import.types import ParsedStatement, display_name

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

    A ``JSONResponse`` rather than an ``HTTPException`` because this refusal's body
    carries more than ``detail``: the handler's exception envelope is
    ``{"detail": ...}`` and nothing else, while a client that is told only
    "mismatch" has to fetch the account and re-read the file to say what went
    wrong. The extra fields are declared on ``StatementImportError``, so the
    contract advertises exactly this shape.

    ``exclude_none`` because that ONE model serves several refusals (the replace
    confirmation carries two numbers instead): every body then holds the facts of
    its own refusal and no null placeholders for somebody else's.
    """
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content=StatementImportError(
            detail="STATEMENT_CURRENCY_MISMATCH",
            statement_currency=statement_currency,
            account_currency=account_currency,
        ).model_dump(exclude_none=True),
    )


def _confirmation_mismatch(
    confirm_deleted_total: int, deleted_total: int
) -> JSONResponse:
    """422 REPLACE_CONFIRMATION_MISMATCH, naming BOTH numbers (S3 delta, §10.7).

    The ``_currency_mismatch`` sibling, and a ``JSONResponse`` for the same reason:
    ``HTTPException`` can only carry ``detail``, and a client told merely
    "mismatch" in front of an irreversible button has nothing to redraw. What it
    gets instead is the number it sent and the number the server would delete right
    now — which is exactly the preview's ``deleted_total``.
    """
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content=StatementImportError(
            detail="REPLACE_CONFIRMATION_MISMATCH",
            confirm_deleted_total=confirm_deleted_total,
            deleted_total=deleted_total,
        ).model_dump(exclude_none=True),
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


def _candidate_window(
    period_from: date,
    period_to: date,
    dates: Iterable[tuple[date, date]],
    *,
    widen: timedelta = SIMILAR_WINDOW,
) -> tuple[date, date]:
    """The date range a comparison can possibly reach, widened by its tolerance.

    NOT the printed period ±1: the bank selects the lines of a statement by their
    POSTING date, so a purchase made a few days before ``period_from`` and posted
    inside it arrives with ``txn_date < period_from`` (the 1-3 day lag is a fact of
    the format, task.md §Факты). The user, who dates a hand-typed row by the day of
    the purchase, has that transaction OUTSIDE the printed period — and a candidate
    that is not loaded is a row reported ``new``, i.e. a duplicate on apply.

    So the window is the printed period UNIONed with the rows' own two dates, and
    only then widened by ``widen`` — which is the matcher's own ``SIMILAR_WINDOW``
    for the upload and ``RECONCILE_PAIR_WINDOW`` for the reconcile route. ONE
    window function for both, parameterized by the tolerance it is widening for,
    so neither caller can drift from the comparison it feeds.

    ``dates`` is an iterable of ``(txn_date, booked_date)`` rather than rows: the
    upload has parsed rows and the reconcile route has stored ones, and this
    function has no business knowing the difference.
    """
    since = period_from
    until = period_to
    for txn_date, booked_date in dates:
        since = min(since, txn_date)
        until = max(until, booked_date)
    return since - widen, until + widen


class _AccountTxView(NamedTuple):
    """One transaction AS THIS ACCOUNT SEES IT — the leg already resolved.

    The ONE place the transfer leg is interpreted (``docs/backend.md`` calls that
    out): leaving this account a transfer is an expense of ``amount_minor``,
    arriving it is an income of ``counter_amount_minor`` in ``counter_currency``.
    Both the upload's matcher candidates and the reconcile agent's facts are
    built from this view, so the two can never read a transfer differently.
    """

    id: uuid.UUID
    client_id: uuid.UUID | None
    kind: str
    amount_minor: int
    currency: str
    occurred_at: date
    merchant: str | None
    note: str | None
    is_transfer: bool
    is_debt_movement: bool


async def _load_account_tx_views(
    session: AsyncSession,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    *where: ColumnElement[bool],
) -> list[_AccountTxView]:
    """Everything this account holds under ``where``, in ONE select.

    "This account" means EITHER leg (the ``tx_read_query.read_filters`` rule): an
    incoming transfer is money that landed here, and the statement shows it as an
    ordinary credit. The caller adds its own narrowing (a date window for the
    upload and the reconcile pre-match, an id list for the report's read) so that
    the user scoping and the leg resolution are written once.
    """
    rows = (
        await session.execute(
            select(
                Transaction.id,
                Transaction.client_id,
                Transaction.kind,
                Transaction.amount_minor,
                Transaction.currency,
                Transaction.counter_amount_minor,
                Transaction.counter_currency,
                Transaction.account_id,
                Transaction.occurred_at,
                Transaction.merchant,
                Transaction.note,
                Transaction.debt_id,
            ).where(
                Transaction.user_id == user_id,
                or_(
                    Transaction.account_id == account_id,
                    Transaction.counter_account_id == account_id,
                ),
                *where,
            )
        )
    ).all()

    views: list[_AccountTxView] = []
    for row in rows:
        is_transfer = row.kind == TransactionKind.transfer.value
        if not is_transfer:
            kind, amount_minor, currency = row.kind, row.amount_minor, row.currency
        elif row.account_id == account_id:
            kind, amount_minor, currency = (
                TransactionKind.expense.value,
                row.amount_minor,
                row.currency,
            )
        else:
            # The counter leg: what LANDED here, in this account's own currency.
            if (
                row.counter_amount_minor is None or row.counter_currency is None
            ):  # pragma: no cover - CHECK-enforced
                continue
            kind, amount_minor, currency = (
                TransactionKind.income.value,
                row.counter_amount_minor,
                row.counter_currency,
            )
        views.append(
            _AccountTxView(
                id=row.id,
                client_id=row.client_id,
                kind=kind,
                amount_minor=amount_minor,
                currency=currency,
                occurred_at=row.occurred_at,
                merchant=row.merchant,
                note=row.note,
                is_transfer=is_transfer,
                is_debt_movement=row.debt_id is not None,
            )
        )
    return views


def _candidate(view: _AccountTxView) -> TxCandidate:
    return TxCandidate(
        id=view.id,
        client_id=view.client_id,
        kind=view.kind,
        amount_minor=view.amount_minor,
        occurred_at=view.occurred_at,
        merchant=view.merchant,
        is_transfer=view.is_transfer,
    )


async def _load_candidates(
    session: AsyncSession,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    statement: ParsedStatement,
) -> list[TxCandidate]:
    """The upload's matcher input: the window above, through the view above."""
    since, until = _candidate_window(
        statement.period_from,
        statement.period_to,
        ((row.txn_date, row.booked_date) for row in statement.rows),
    )
    return [
        _candidate(view)
        for view in await _load_account_tx_views(
            session,
            user_id,
            account_id,
            Transaction.occurred_at >= since,
            Transaction.occurred_at <= until,
        )
    ]


#: Row kinds the LLM pass may ask about. The parser derives ``kind`` from the sign
#: of the turnover, so these are the only two it produces — the guard exists so a
#: future third kind cannot crash an upload inside ``CategoryKind(...)``.
_CATEGORIZABLE_KINDS = frozenset(kind.value for kind in CategoryKind)


def _row_quota(
    request: Request,
    settings: Settings,
    user_id: uuid.UUID,
    *,
    namespace: str,
    quota: str,
) -> Callable[[int], bool]:
    """The user's daily LLM budget as the callback the services ask for.

    Hit DIRECTLY on the shared limiter's storage with ``cost=n`` rather than a
    decorator (the ``pat_auth._enforce_rate_limit`` precedent): the unit being
    rationed is a ROW, not a request, and one upload may spend several hundred of
    them across several calls. ``rate_limit_scope`` keeps the counter isolated per
    app instance, exactly as the decorated routes do.

    ONE closure, TWO budgets (pdf-reconcile S3): ``namespace`` is the counter's
    own key segment and ``quota`` its window string, so the categorize pass
    (``categorize:<user>``, rows) and the Alfa extraction (``extract:<user>``,
    LINES) ration independently. Sharing one counter would let a PDF upload eat
    the categorization budget of every later statement — and an Alfa upload
    spends both, one after the other.

    A refused batch is NOT refunded, and a failed call is not either: the budget
    buys attempts, and refunding would mean a dead provider costs nothing while it
    burns the time budget of every upload.

    ``hit`` is synchronous — correct for the in-memory storage this app uses, and
    the same caveat as in ``pat_auth``: a move to Redis storage turns it into
    blocking I/O inside an async handler and MUST be revisited then.
    """
    if not settings.rate_limit_enabled:
        return lambda _rows: True
    scope_prefix: str = getattr(request.app.state, "rate_limit_scope", "default")
    key = f"{scope_prefix}:{namespace}:{user_id}"
    items = list(parse_many(quota))

    def spend(rows: int) -> bool:
        # One window in the default setting ("3000/day"). With several, the first
        # refusal stops the check and the windows already hit keep their cost —
        # the same "no refund" rule as above, one level down.
        return all(limiter.limiter.hit(item, key, cost=rows) for item in items)

    return spend


async def _categorize_rows(
    session: AsyncSession,
    request: Request,
    user_id: uuid.UUID,
    statement: ParsedStatement,
    matches: Sequence[RowMatch],
    suggestions: Sequence[CategorySuggestion | None],
    provider: LLMProvider | None,
    settings: Settings,
) -> tuple[dict[int, CategorizeResult], StatementAiStatus]:
    """The LLM pass of one upload: eligible rows → results keyed by ``row_index``.

    Runs AFTER the rules and only over what they left: a row the merchant or
    bank-category map already answered is not sent (the maps are the user's own
    learned truth and cost nothing), and neither is an ``exact`` match — that row
    is already in the app, so apply will skip it anyway, and neither is a row of a
    kind the user has no visible category for — there is nothing to offer.

    Everything it owns is here and nowhere else: the two reads the service may not
    do itself (the user's visible, non-archived categories in ONE query, and
    ``profile.country``), the translation between a statement row and an
    ``Operation``, the quota callback, and the mapping of coverage onto
    ``ai_status``. The service stays pure; this function never writes.

    It cannot fail the upload. ``categorize`` does not raise, and an uncovered row
    is simply absent from the mapping, which ``_build_rows`` reads as "leave this
    row exactly as the rules left it".
    """
    if provider is None:
        return {}, StatementAiStatus.not_configured

    candidates = [
        row
        for row, match, suggestion in zip(
            statement.rows, matches, suggestions, strict=True
        )
        if suggestion is None
        and match.match_status != StatementRowMatchStatus.exact.value
        and row.kind in _CATEGORIZABLE_KINDS
    ]
    if not candidates:
        return {}, StatementAiStatus.skipped

    options = [
        CategoryOption(
            id=category.id, name=category.name, kind=CategoryKind(category.kind)
        )
        for category in (
            await session.execute(
                select(Category.id, Category.name, Category.kind).where(
                    visible_categories_clause(user_id),
                    Category.archived.is_(False),
                )
            )
        ).all()
    ]
    # A row whose KIND has no visible category is never sent (``categorize._plan``
    # drops it, so an expense label can never be offered for an income row), and
    # therefore must not be counted when the coverage below becomes a status: a
    # user who archived every income category would otherwise read ``failed``
    # about a call nobody could have made. Nothing sendable at all = ``skipped``,
    # the same answer as "the rules already covered everything".
    offered_kinds = {option.kind.value for option in options}
    eligible = [row for row in candidates if row.kind in offered_kinds]
    if not eligible:
        return {}, StatementAiStatus.skipped
    # The COLUMN, never the Profile instance (the advisor's precedent), and nullable
    # all the way through: no profile row and an unset field are the same "we do not
    # know where the user lives", which the prompt is written to accept as null.
    country = await session.scalar(
        select(Profile.country).where(Profile.user_id == user_id)
    )
    operations = [
        Operation(
            # The ROW INDEX is the key, so the answer comes back addressed to the
            # row it was asked about — the service never learns what a statement is.
            key=str(row.row_index),
            # The same string the merchant map is keyed by (``display_name``): the
            # rules and the model see one name for one line, or a suggestion learned
            # under one spelling would never match the other.
            text=display_name(row.merchant, row.description),
            amount_minor=row.amount_minor,
            currency=statement.currency,
            country=country,
            kind=CategoryKind(row.kind),
        )
        for row in eligible
    ]
    outcome = await categorize(
        provider,
        operations,
        options,
        CategorizeConfig(
            threshold=settings.categorize_confidence_threshold,
            batch_size=settings.categorize_batch_size,
            concurrency=settings.categorize_concurrency,
            time_budget_seconds=settings.categorize_time_budget_seconds,
            max_rows=settings.categorize_max_rows_per_import,
        ),
        _row_quota(
            request,
            settings,
            user_id,
            namespace="categorize",
            quota=settings.categorize_daily_row_quota,
        ),
        user_id=str(user_id),
    )
    results = {int(key): result for key, result in outcome.results.items()}
    if outcome.aborted_reason is not None:
        # The CAUSE lives here and not on the session (architecture): one coarse
        # status on the wire, the reason in the log a server operator reads.
        logger.info(
            "categorize pass aborted (%s): %d of %d eligible rows covered",
            outcome.aborted_reason,
            len(results),
            len(operations),
        )
    if len(results) == len(operations):
        return results, StatementAiStatus.ok
    if results:
        return results, StatementAiStatus.partial
    return results, StatementAiStatus.failed


async def _store_preview(
    session: AsyncSession,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    statement: ParsedStatement,
    fingerprints: Sequence[uuid.UUID],
    matches: Sequence[RowMatch],
    suggestions: Sequence[CategorySuggestion | None],
    ai: dict[int, CategorizeResult],
    ai_status: StatementAiStatus,
    ai_provider: LLMProvider | None,
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
        ai_status=ai_status.value,
        # The provenance of the suggestions, stamped whenever a provider existed —
        # also for ``skipped`` and ``failed``, because "we asked THIS model and got
        # nothing" is the fact a later reader needs. All three NULL without one.
        ai_provider=None if ai_provider is None else ai_provider.name,
        ai_model=None if ai_provider is None else ai_provider.model,
        ai_prompt_version=None if ai_provider is None else PROMPT_VERSION,
        # What the file says about its own balances, and whether that added up
        # (pdf-reconcile §2). Stored verbatim from the parser: the closing anchor is
        # what apply holds our ledger against, so it must be the BANK's number and
        # not something recomputed later. A format with no anchors (Priorbank)
        # leaves all three alone and reads ``not_available``.
        opening_balance_minor=statement.opening_balance_minor,
        closing_balance_minor=statement.closing_balance_minor,
        self_check_status=(
            StatementSelfCheckStatus.not_available.value
            if statement.self_check is None
            else statement.self_check.status
        ),
        self_check_failed=(
            None if statement.self_check is None else statement.self_check.failed
        ),
        self_check_expected_minor=(
            None
            if statement.self_check is None
            else statement.self_check.expected_minor
        ),
        self_check_actual_minor=(
            None if statement.self_check is None else statement.self_check.actual_minor
        ),
    )
    session.add(session_row)
    # Flush, not commit: the rows need the session's id, and a session without its
    # rows must never survive a failure of the second insert.
    await session.flush()
    rows = _build_rows(
        session_row.id, statement, fingerprints, matches, suggestions, ai
    )
    session.add_all(rows)
    await session.commit()
    await session.refresh(session_row)
    return session_row, rows


class _CategorySeed(NamedTuple):
    """What one row's category columns start out as, from whichever source knew it."""

    suggested_category_id: uuid.UUID | None
    suggestion_source: str | None
    category_id: uuid.UUID | None
    ai_confidence: Decimal | None
    ai_reason: str | None
    needs_review: bool


def _seed(
    suggestion: CategorySuggestion | None, result: CategorizeResult | None
) -> _CategorySeed:
    """The three sources of a starting category, in priority order, in ONE place.

    1. A RULE (the merchant or bank-category map) — the user's own learned truth,
       which is why the LLM pass is never even asked about such a row.
    2. The MODEL, when it named a category: seeded exactly like a rule's
       suggestion (``suggested_category_id`` + ``category_id``, source ``llm``,
       ``category_user_set`` left false, so the learning gate is untouched) and
       flagged for review when it said so — a low-confidence answer is still the
       best guess available, and hiding it would make the user re-type what the
       model already got right most of the time (ruling R1).
    3. The MODEL, unsure: no category at all, ``needs_review`` set, confidence
       recorded, reason NULL — there is no category for a reason to be about.

    No source at all (no provider, a lost batch, the row cap, the time budget) is
    the UNTOUCHED row: every AI column stays NULL/false and the row reads exactly
    as it did before this scope existed.
    """
    if suggestion is not None:
        return _CategorySeed(
            suggested_category_id=suggestion.category_id,
            suggestion_source=suggestion.source,
            category_id=suggestion.category_id,
            ai_confidence=None,
            ai_reason=None,
            needs_review=False,
        )
    if result is None:
        return _CategorySeed(None, None, None, None, None, False)
    confidence = Decimal(str(result.confidence)).quantize(
        Decimal("0.001"), rounding=ROUND_HALF_UP
    )
    if result.category_id is None:
        return _CategorySeed(
            suggested_category_id=None,
            suggestion_source=None,
            category_id=None,
            ai_confidence=confidence,
            ai_reason=None,
            needs_review=True,
        )
    return _CategorySeed(
        suggested_category_id=result.category_id,
        suggestion_source=StatementSuggestionSource.llm.value,
        category_id=result.category_id,
        ai_confidence=confidence,
        ai_reason=result.reason,
        needs_review=result.needs_review,
    )


def _build_rows(
    import_id: uuid.UUID,
    statement: ParsedStatement,
    fingerprints: Sequence[uuid.UUID],
    matches: Sequence[RowMatch],
    suggestions: Sequence[CategorySuggestion | None],
    ai: dict[int, CategorizeResult],
) -> list[StatementImportRow]:
    """The stored rows of one upload — suggestions included.

    A suggestion is written to BOTH ``suggested_category_id`` (where it came from)
    and ``category_id`` (what apply will use), with ``category_user_set`` left
    false. That pair is the whole learning gate of §5: a preview nobody edits still
    files its rows where the user has been filing them, and yet teaches the maps
    nothing — a guess that confirmed itself would make the first mistake permanent.
    The gate holds for an LLM seed too: it teaches the maps only once a PATCH says
    the user accepted it.

    ``ai`` is keyed by ``row_index`` and is PLAIN DATA computed before the write
    (so the IntegrityError retry re-files the identical preview without spending a
    token); an absent key means the pass never covered that row.
    """
    seeds = [
        _seed(suggestion, ai.get(row.row_index))
        for row, suggestion in zip(statement.rows, suggestions, strict=True)
    ]
    return [
        StatementImportRow(
            import_id=import_id,
            row_index=row.row_index,
            section=row.section,
            txn_date=row.txn_date,
            txn_time=row.txn_time,
            booked_date=row.booked_date,
            description=row.description,
            # Verbatim, all three values (``types.display_name``): the isolated
            # name, ``""`` when the parser found this line has no merchant, NULL
            # when the format isolates no names and the description IS the name
            # (every Priorbank row). The empty string is NOT cleaned to NULL here —
            # apply reads this column back and the two would stop being different
            # answers. Its own column: apply files the transaction under it and the
            # preview shows it, so it must not hide in ``raw`` — which stays the
            # file's cells verbatim and nothing else.
            merchant=row.merchant,
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
            suggested_category_id=seed.suggested_category_id,
            suggestion_source=seed.suggestion_source,
            category_id=seed.category_id,
            ai_confidence=seed.ai_confidence,
            ai_reason=seed.ai_reason,
            needs_review=seed.needs_review,
            decision=match.decision,
        )
        for row, fingerprint, match, seed in zip(
            statement.rows, fingerprints, matches, seeds, strict=True
        )
    ]


class _AiCounts(NamedTuple):
    """The session's two AI numbers. NOT a wire model — they go out as flat fields.

    Counted, never stored: both move with every PATCH the user makes (a category
    clears ``needs_review``), so a stored counter would start disagreeing with the
    rows it describes on the first click — the same reason the two existing
    cross-sections are counted at read.
    """

    rows_suggested: int
    rows_flagged: int


def _counts(
    rows: Sequence[StatementImportRow],
) -> tuple[MatchStatusCounts, DecisionCounts, _AiCounts]:
    """All three cross-sections (§10.4), counted in memory over one session's rows."""
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
        _AiCounts(
            rows_suggested=sum(
                r.suggestion_source == StatementSuggestionSource.llm.value for r in rows
            ),
            rows_flagged=sum(r.needs_review for r in rows),
        ),
    )


async def _counts_of(
    session: AsyncSession, import_id: uuid.UUID
) -> tuple[MatchStatusCounts, DecisionCounts, _AiCounts]:
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
                # Two aggregates on the SAME grouped query rather than a second
                # round trip: they are summed across the groups below, which is
                # arithmetic, not another read of a thousand rows.
                func.count().filter(
                    StatementImportRow.suggestion_source
                    == StatementSuggestionSource.llm.value
                ),
                func.count().filter(StatementImportRow.needs_review.is_(True)),
            )
            .where(StatementImportRow.import_id == import_id)
            .group_by(StatementImportRow.match_status, StatementImportRow.decision)
        )
    ).all()
    by_match: dict[str, int] = {}
    by_decision: dict[str, int] = {}
    ai_suggested = 0
    ai_flagged = 0
    for match_status, decision, count, suggested, flagged in grouped:
        by_match[match_status] = by_match.get(match_status, 0) + count
        by_decision[decision] = by_decision.get(decision, 0) + count
        ai_suggested += suggested
        ai_flagged += flagged
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
        _AiCounts(rows_suggested=ai_suggested, rows_flagged=ai_flagged),
    )


def _reconciliation_headline(
    session_row: StatementImport,
) -> tuple[DiscrepancyCounts | None, str | None]:
    """The stored report's counts and summary, READ THROUGH the JSONB (A4).

    The headline the import screen shows without a second request; the items stay
    on ``GET /{id}/reconciliation``, because this shape is also the list screen's
    row. Read through rather than denormalized into columns: the report is written
    whole by one writer and overwritten whole by the next, so a pair of counter
    columns could only ever fall behind it.

    Both are null unless a report exists — which is exactly
    ``reconciliation_status == 'ok'`` (the ``reconciliation_present`` CHECK).
    ``.get`` and not indexing: a report recorded by an earlier prompt version must
    still read, and a missing key is "nothing to show", never a 500 on a GET.
    """
    report = session_row.reconciliation
    if report is None:
        return None, None
    summary: Any = report.get("summary")
    counts: dict[str, Any] | None = report.get("counts_by_kind")
    if not isinstance(counts, dict):
        return None, summary if isinstance(summary, str) else None

    def count_of(kind: DiscrepancyKind) -> int:
        value: Any = counts.get(kind.value, 0)
        return int(value) if isinstance(value, int) else 0

    return (
        DiscrepancyCounts(
            missing_in_app=count_of(DiscrepancyKind.missing_in_app),
            extra_in_app=count_of(DiscrepancyKind.extra_in_app),
            amount_differs=count_of(DiscrepancyKind.amount_differs),
            date_differs=count_of(DiscrepancyKind.date_differs),
            fx_difference=count_of(DiscrepancyKind.fx_difference),
        ),
        summary if isinstance(summary, str) else None,
    )


def _serialize(
    session_row: StatementImport,
    by_match_status: MatchStatusCounts,
    by_decision: DecisionCounts,
    ai: _AiCounts,
) -> StatementImportRead:
    reconciliation_counts, reconciliation_summary = _reconciliation_headline(
        session_row
    )
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
        ai_status=StatementAiStatus(session_row.ai_status),
        ai_provider=session_row.ai_provider,
        ai_model=session_row.ai_model,
        ai_prompt_version=session_row.ai_prompt_version,
        ai_rows_suggested=ai.rows_suggested,
        ai_rows_flagged=ai.rows_flagged,
        opening_balance_minor=session_row.opening_balance_minor,
        closing_balance_minor=session_row.closing_balance_minor,
        self_check_status=StatementSelfCheckStatus(session_row.self_check_status),
        self_check_failed=(
            None
            if session_row.self_check_failed is None
            else StatementSelfCheckFailure(session_row.self_check_failed)
        ),
        self_check_expected_minor=session_row.self_check_expected_minor,
        self_check_actual_minor=session_row.self_check_actual_minor,
        balance_check=StatementBalanceCheck(session_row.balance_check),
        app_balance_minor_at_end=session_row.app_balance_minor_at_end,
        balance_diff_minor=session_row.balance_diff_minor,
        reconciliation_status=StatementReconciliationStatus(
            session_row.reconciliation_status
        ),
        reconciled_at=session_row.reconciled_at,
        reconciliation_counts=reconciliation_counts,
        reconciliation_summary=reconciliation_summary,
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
        merchant=row.merchant,
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
        # ``float`` at the boundary, once: the column is Numeric only to bound it
        # to 0..1, and nothing downstream computes with it (it is not money).
        ai_confidence=(None if row.ai_confidence is None else float(row.ai_confidence)),
        ai_reason=row.ai_reason,
        needs_review=row.needs_review,
    )


# --- pdf-reconcile: extraction ---------------------------------------------


def _extraction_failed(exc: StatementExtractionError) -> HTTPException:
    """An extraction failure → its HTTP answer, in ONE table (D-C1).

    The split that matters is "fix your file" vs "try later": a provider outage
    gets 503 ``AI_UNAVAILABLE``, because answering 422 would tell the user the PDF
    is bad and send them looking for a better one. Everything that IS about the
    reading — unusable output, a lost chunk, a refused request, the time budget —
    is 422 ``STATEMENT_EXTRACTION_FAILED``: the file is the thing to try again.
    """
    if exc.code == "too_many_lines":
        # The 1 MB gate's sibling, reusing its code: both mean "this file is
        # bigger than we read in one request".
        return _unprocessable("STATEMENT_TOO_LARGE")
    if exc.code == "quota":
        # The daily line budget, refused BEFORE the first call — the same body
        # the decorated limiter answers with.
        return HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="RATE_LIMITED"
        )
    if exc.code == "unavailable":
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="AI_UNAVAILABLE"
        )
    return _unprocessable("STATEMENT_EXTRACTION_FAILED")


async def _read_statement(
    request: Request,
    data: bytes,
    format: str,
    *,
    account_id: uuid.UUID,
    user_id: uuid.UUID,
    settings: Settings,
) -> ParsedStatement:
    """The uploaded bytes → a statement, by whichever registry names ``format``.

    The two registries are the whole branch (D-E10): a sync parser is called as it
    always was, and a format in ``EXTRACTORS`` needs ``app.state.llm`` first. The
    provider gate is INLINE at this exact position rather than a route dependency,
    for the receipts-parse reason: a dependency resolves before the handler's own
    parameters, so an unauthenticated upload to an unconfigured server would
    answer 503 instead of 401 — and an unknown format would answer 503 instead of
    ``STATEMENT_FORMAT_UNKNOWN``.
    """
    extractor = EXTRACTORS.get(format)
    if extractor is None:
        return PARSERS[format](data)
    await require_llm_provider(request)
    provider: LLMProvider = request.app.state.llm
    try:
        return await extractor(
            data,
            provider,
            ExtractConfig(
                lines_per_call=settings.extract_lines_per_call,
                concurrency=settings.extract_concurrency,
                time_budget_seconds=settings.extract_time_budget_seconds,
                max_lines=settings.extract_max_lines,
            ),
            # Its OWN counter, not the categorize one: an Alfa upload spends both
            # budgets, one pass after the other (``_row_quota``).
            _row_quota(
                request,
                settings,
                user_id,
                namespace="extract",
                quota=settings.extract_daily_line_quota,
            ),
            user_id=str(user_id),
        )
    except StatementExtractionError as exc:
        # The CODE only (never the file, never a line): the reason is already one
        # ``log_call`` line per call inside the extractor.
        logger.info(
            "statement extraction failed (account %s): %s", account_id, exc.code
        )
        raise _extraction_failed(exc) from exc


@router.post(
    "",
    response_model=StatementImportRead,
    status_code=status.HTTP_201_CREATED,
    responses={
        **_NOT_FOUND,
        **_UNPROCESSABLE,
        **_RATE_LIMITED,
        # Only an ``EXTRACTORS`` format can answer this: AI_NOT_CONFIGURED when
        # the server has no provider, AI_UNAVAILABLE for an outage mid-read.
        status.HTTP_503_SERVICE_UNAVAILABLE: _IMPORT_ERR,
    },
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

    Gate ORDER (architecture §6, D-E10): account → size → format → provider →
    extraction quota → parse/extract → currency → DB. Everything that can refuse
    the request does so BEFORE a single row is written, so a failed upload leaves
    nothing behind to clean up or to show — and before the first provider call, so
    a refusal costs no token.
    """
    settings: Settings = request.app.state.settings
    account = await _require_own_account(session, account_id, user.id)
    data = await _read_upload(file, settings)

    if format not in FORMAT_IDS:
        raise _unprocessable("STATEMENT_FORMAT_UNKNOWN")
    try:
        statement = await _read_statement(
            request,
            data,
            format,
            account_id=account_id,
            user_id=user.id,
            settings=settings,
        )
    except StatementParseError as exc:
        # Logged at INFO with the reason (never the file's contents — it is a bank
        # statement) so a real format drift is diagnosable from the server side.
        # BOTH registries raise it: for a PDF it means pypdf could not read the
        # file or its header anchors are not there (before any provider call).
        logger.info("statement parse failed (account %s): %s", account_id, exc)
        raise _unprocessable("STATEMENT_PARSE_FAILED") from exc

    if statement.currency != account.currency:
        # The account's currency is what every created transaction would be
        # stamped with, so importing a statement in another currency would file
        # foreign money as if it were the account's own.
        return _currency_mismatch(statement.currency, account.currency)

    filename = (file.filename or "statement.csv")[:_FILENAME_MAX]
    fingerprints = client_ids(
        user.id, account_id, statement.rows, statement.source_format
    )
    matches = match_rows(
        statement.rows,
        fingerprints,
        await _load_candidates(session, user.id, account_id, statement),
    )
    # Read BEFORE the write and reused by the retry below: the two learned maps
    # cannot change under us mid-upload, and re-reading them would be two more
    # queries for the same answer.
    suggestions = await suggest_categories(session, user.id, statement.rows)
    # The LLM pass runs BEFORE the write and produces PLAIN DATA, exactly like the
    # suggestions above: the retry below then re-files the identical preview
    # without spending a second token, a second quota row or a second 45 seconds —
    # and cannot answer with a different categorization than the first attempt did.
    provider: LLMProvider | None = request.app.state.llm
    ai, ai_status = await _categorize_rows(
        session,
        request,
        user.id,
        statement,
        matches,
        suggestions,
        provider,
        settings,
    )

    try:
        session_row, rows = await _store_preview(
            session,
            user.id,
            account_id,
            statement,
            fingerprints,
            matches,
            suggestions,
            ai,
            ai_status,
            provider,
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
            ai,
            ai_status,
            provider,
            filename,
            settings,
        )

    by_match_status, by_decision, ai_counts = _counts(rows)
    return _serialize(session_row, by_match_status, by_decision, ai_counts)


@router.get("/formats", response_model=StatementFormatsRead)
async def list_statement_formats(
    request: Request,
    user: User = Depends(current_user_jwt_or_pat),
) -> StatementFormatsRead:
    """The formats the upload accepts, in registry order — plus the AI gate.

    The registry is the single source of truth (services/statement_import/__init__),
    so this route CANNOT drift from what ``POST`` validates against: adding a bank
    is one line there and the control fills itself. ``ai_formats`` and
    ``ai_available`` extend that to the AI side (grooming ruling 6): which formats
    need a provider is the ``EXTRACTORS`` registry, and whether THIS server has one
    is ``app.state.llm`` — both read here, so the client needs no copy of either
    and the picker can refuse a PDF before the upload does.

    Authenticated like every other route here — the list is not a secret, but an
    unauthenticated route in this router would be the one place where forgetting
    the dependency has no other symptom. A PAT still gets 403 from the fail-closed
    allowlist: import is out of MCP as a whole, and a route that only tells an
    agent which parsers exist is of no use without the ones that follow it.
    """
    return StatementFormatsRead(
        formats=list(FORMAT_IDS),
        ai_formats=list(EXTRACTORS),
        ai_available=request.app.state.llm is not None,
    )


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
    by_match_status, by_decision, ai_counts = await _counts_of(session, import_id)
    return _serialize(session_row, by_match_status, by_decision, ai_counts)


@router.get(
    "/{import_id}/rows", response_model=StatementRowList, responses={**_NOT_FOUND}
)
async def list_statement_import_rows(
    import_id: uuid.UUID,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=_ROWS_MAX_LIMIT, ge=1, le=_ROWS_MAX_LIMIT),
    match_status: StatementRowMatchStatus | None = None,
    needs_review: bool | None = None,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> StatementRowList:
    """The preview, in FILE order, with each row's candidates embedded.

    Two independent filters, ANDed (amendment A2): "new AND needs a look" is a
    reachable view of its own. ``needs_review`` is a query member rather than a new
    endpoint — the screen's "check category (N)" chip is the same page of the same
    rows, and its N is the session's ``ai_rows_flagged``. ABSENT means "all rows":
    ``false`` is a real request for the rows nobody has to look at, not the default.
    """
    session_row = await _load_own(session, import_id, user.id)
    if session_row is None:
        raise _not_found()

    filters = [StatementImportRow.import_id == import_id]
    if match_status is not None:
        filters.append(StatementImportRow.match_status == match_status.value)
    if needs_review is not None:
        filters.append(StatementImportRow.needs_review.is_(needs_review))
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

    Three refusals, in the order the user can act on them: without a matched
    transaction the decision is meaningless (DECISION_NEEDS_MATCH); a transfer is
    ONE row seen from two accounts, so deleting it would erase the second account's
    history for money this statement cannot see (TRANSFER_REPLACE_FORBIDDEN — PM,
    plan §"Дельта"); and a debt movement carries a debt's remaining balance, so the
    bank's unlinked copy must never take its place (DEBT_MOVEMENT_READONLY, the
    debts scope — the same code ``PATCH /transactions`` answers with).

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
    debt_movement = await session.scalar(
        select(Transaction.id)
        .where(
            Transaction.user_id == user_id,
            Transaction.id.in_(wanted),
            Transaction.debt_id.is_not(None),
        )
        .limit(1)
    )
    if debt_movement is not None:
        raise _unprocessable("DEBT_MOVEMENT_READONLY")


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
        # The user LOOKED at this row's category — which is the whole content of
        # ``needs_review`` — so the flag goes, for a value and for an explicit null
        # alike. A ``decision``-only PATCH (and bulk-decision) leaves it alone:
        # "skip this row" is not an answer to "is this the right category?".
        # ``ai_confidence``/``ai_reason`` are never cleared: they record what the
        # model said, and that does not stop being true.
        row.needs_review = False

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
    by_match_status, by_decision, ai_counts = await _counts_of(session, import_id)
    return _serialize(session_row, by_match_status, by_decision, ai_counts)


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

    Refuses a statement whose self-check FAILED with 422
    STATEMENT_BALANCE_MISMATCH: such a file has a line misread or missing, so the
    rows are still shown and editable but must not become money. After the write
    the app's balance on ``period_to`` is compared with the file's closing balance
    and stamped on the session (``balance_check``) — informational, in the same
    transaction as the money.
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
    _, by_decision, _ = await _counts_of(session, import_id)
    return StatementApplyReport(
        created=outcome.created,
        skipped=by_decision.skip,
        replaced=outcome.replaced,
        already_existed=outcome.already_existed,
    )


def _require_replaceable_range(session_row: StatementImport, from_date: date) -> None:
    """``from`` must land inside the statement's own period (architecture §7).

    Below ``period_from`` the replace would delete days the file has nothing to put
    back — data loss dressed as an import. Above ``period_to`` the range is empty,
    which is a mistyped date rather than a no-op worth executing: "replace nothing
    with nothing" is never what the user meant, and answering 200 to it would teach
    them the date field does not matter (plan §"Дельта S3", point 2).
    """
    if from_date < session_row.period_from or from_date > session_row.period_to:
        raise _unprocessable("REPLACE_FROM_OUT_OF_RANGE")


@router.get(
    "/{import_id}/replace-preview",
    response_model=StatementReplacePreview,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def preview_statement_replace(
    import_id: uuid.UUID,
    from_date: Annotated[date, Query(alias="from")],
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> StatementReplacePreview:
    """What ``POST /replace`` would destroy, counted BEFORE it is confirmed.

    A read, and repeatable: it writes nothing, so a user may move the date around
    until the numbers look right. The numbers are the SERVER's own selection — the
    same predicate the delete runs — because a client that counted for itself would
    be warning the user about a set nobody is going to delete.

    Gate order: 404 (foreign == missing) → 422 IMPORT_FINISHED → 422
    REPLACE_FROM_OUT_OF_RANGE. The lifecycle gate is a deliberate addition to the
    architecture's table (plan §"Дельта S3", point 3): on an applied or replaced
    session this would count the transactions THAT VERY SESSION just created as
    "will be deleted", which is a misleading number printed over an operation
    nobody can undo.

    ONE grouped query answers all six transaction counters. Its base predicate is
    "either leg of this account, in range", which splits exactly in three: a row
    that is neither a transfer nor a debt movement can only be seen through its own
    ``account_id`` (the counter trio is NULL on it, by CHECK), so that half IS the
    delete's own selection, while the transfers and the debt movements are what
    survives (a debt movement is never a transfer — also by CHECK — so the two
    survivor counters cannot double-count a row). The three therefore add up to
    every row the account shows in the range — nothing is left unannounced, and the
    delete predicate and the warning cannot drift apart.
    """
    session_row = await _load_live(session, import_id, user.id)
    _require_replaceable_range(session_row, from_date)

    counters = (
        await session.execute(
            select(
                func.count().filter(DELETABLE_BY_REPLACE),
                func.count(Transaction.receipt_id).filter(DELETABLE_BY_REPLACE),
                func.count(Transaction.goal_item_id).filter(DELETABLE_BY_REPLACE),
                func.count(Transaction.recurring_template_id).filter(
                    DELETABLE_BY_REPLACE
                ),
                func.count().filter(Transaction.kind == TransactionKind.transfer.value),
                func.count().filter(Transaction.debt_id.is_not(None)),
            ).where(
                Transaction.user_id == user.id,
                or_(
                    Transaction.account_id == session_row.account_id,
                    Transaction.counter_account_id == session_row.account_id,
                ),
                Transaction.occurred_at >= from_date,
                Transaction.occurred_at <= session_row.period_to,
            )
        )
    ).one()
    will_create = await session.scalar(
        select(func.count())
        .select_from(StatementImportRow)
        .where(
            StatementImportRow.import_id == import_id,
            StatementImportRow.txn_date >= from_date,
        )
    )
    return StatementReplacePreview(
        deleted_total=counters[0],
        deleted_with_receipt=counters[1],
        deleted_with_goal_item=counters[2],
        deleted_with_recurring_template=counters[3],
        transfers_kept=counters[4],
        debt_movements_kept=counters[5],
        will_create=will_create or 0,
    )


async def _replace_once_or_twice(
    session: AsyncSession,
    import_id: uuid.UUID,
    user_id: uuid.UUID,
    payload: StatementReplaceRequest,
) -> ReplaceOutcome:
    """The replace, plus ONE retry after an insert race — the apply arm's twin in
    shape, not in outcome.

    Two tabs replacing the same session serialize on the DELETE: the loser waits
    for the winner's commit, then re-evaluates its own WHERE, finds the rows gone
    and refuses with REPLACE_CONFIRMATION_MISMATCH before it inserts anything. The
    only race that reaches an INSERT at all is a confirmed total of ZERO on both
    sides, where nothing is deleted and both write the same fingerprints.

    Its retry converges on a REFUSAL rather than on the apply arm's "it is all
    already there" (review-s3 MINOR-1): the winner has moved the session out of
    ``parsed`` by then and ``replace_import`` re-checks that status, so the retry
    answers 422 IMPORT_FINISHED without deleting or writing a row — and the next
    preview tells the user the same thing. A duplicate key from anywhere else runs
    the same procedure again and refuses on the confirmation instead. Either way
    the arm exists to turn a 500 for a double-click into an answer.
    """
    try:
        return await replace_import(
            session,
            import_id,
            user_id,
            payload.from_date,
            payload.confirm_deleted_total,
        )
    except IntegrityError:
        await session.rollback()
        logger.info("statement replace raced a parallel write (import %s)", import_id)
        return await replace_import(
            session,
            import_id,
            user_id,
            payload.from_date,
            payload.confirm_deleted_total,
        )


@router.post(
    "/{import_id}/replace",
    response_model=StatementReplaceReport,
    responses={**_NOT_FOUND, **_UNPROCESSABLE},
)
async def replace_statement_import(
    import_id: uuid.UUID,
    payload: StatementReplaceRequest,
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> StatementReplaceReport | JSONResponse:
    """The "replace from date X" path (architecture §7) — the scope's only deletion.

    ONE database transaction in ``services/.../apply.py`` does all of it: the
    delete, the re-filing of the statement over the emptied range and the session's
    move to ``replaced``. A range half-wiped and half-refilled is the one outcome a
    user could never repair by hand.

    ``confirm_deleted_total`` is checked against the DELETE's own ``RETURNING``, so
    what is compared is the set that actually disappeared rather than a count taken
    a moment earlier. A disagreement rolls everything back untouched and answers 422
    with both numbers, and the client redraws the preview.

    Per-row decisions are ignored here — see ``replace_import``.

    Like apply, it refuses a failed self-check with 422
    STATEMENT_BALANCE_MISMATCH and stamps ``balance_check`` after the write.
    """
    session_row = await _load_live(session, import_id, user.id)
    _require_replaceable_range(session_row, payload.from_date)
    try:
        outcome = await _replace_once_or_twice(session, import_id, user.id, payload)
    except StatementReplaceMismatch as exc:
        return _confirmation_mismatch(exc.confirm_deleted_total, exc.deleted_total)
    except StatementApplyError as exc:
        # A session cancelled between the gate above and the write is this
        # router's ordinary 404 — the same body a stranger's id gets.
        if exc.code == "IMPORT_NOT_FOUND":
            raise _not_found() from exc
        raise _unprocessable(exc.code) from exc
    return StatementReplaceReport(
        deleted=outcome.deleted,
        created=outcome.created,
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


# --- pdf-reconcile: the reconcile agent (architecture §4, D-R1…D-R5) ---------

_CONFLICT: dict[int | str, dict[str, object]] = {status.HTTP_409_CONFLICT: _IMPORT_ERR}
_UNAVAILABLE: dict[int | str, dict[str, object]] = {
    status.HTTP_503_SERVICE_UNAVAILABLE: _IMPORT_ERR
}

#: The language the agent writes its prose in when the profile names none.
_DEFAULT_LANGUAGE = "ru"

_NO_COUNTS = DiscrepancyCounts(
    missing_in_app=0,
    extra_in_app=0,
    amount_differs=0,
    date_differs=0,
    fx_difference=0,
)


async def _stash_rl_user_jwt(
    request: Request, user: User = Depends(current_active_user)
) -> User:
    """``stash_rl_user`` for the reconcile key — JWT ONLY (the ``/push`` precedent).

    ``current_active_user`` straight from ``auth.py`` rather than this router's
    PAT-aware dependency: the import family is off-token by construction, and
    this route SPENDS the user's model budget, so it must stay unreachable by a
    token even if the allowlist derivation ever changed. The pair is pinned in
    ``tests/test_pat_auth.py::NEVER_PAT``.
    """
    request.state.rl_user_id = str(user.id)
    return user


def _row_fact(row: StatementImportRow, currency: str) -> RowFact:
    """A stored row as the agent sees it. ``currency`` is the SESSION's (§10.1)."""
    return RowFact(
        id=row.id,
        row_index=row.row_index,
        client_id=row.client_id,
        txn_date=row.txn_date,
        booked_date=row.booked_date,
        kind=row.kind,
        amount_minor=row.amount_minor,
        currency=currency,
        original_amount_minor=row.original_amount_minor,
        original_currency=row.original_currency,
        description=row.description,
        merchant=row.merchant,
    )


def _tx_fact(view: _AccountTxView) -> TxFact:
    return TxFact(
        id=view.id,
        client_id=view.client_id,
        occurred_at=view.occurred_at,
        kind=view.kind,
        amount_minor=view.amount_minor,
        currency=view.currency,
        merchant=view.merchant,
        note=view.note,
        is_transfer=view.is_transfer,
        is_debt_movement=view.is_debt_movement,
    )


def _row_view(fact: RowFact) -> DiscrepancyRowView:
    return DiscrepancyRowView(
        id=fact.id,
        txn_date=fact.txn_date,
        description=fact.description,
        merchant=fact.merchant,
        amount_minor=fact.amount_minor,
        currency=fact.currency,
        kind=TransactionKind(fact.kind),
    )


def _tx_view(fact: TxFact) -> DiscrepancyTxView:
    return DiscrepancyTxView(
        id=fact.id,
        occurred_at=fact.occurred_at,
        merchant=fact.merchant,
        note=fact.note,
        amount_minor=fact.amount_minor,
        currency=fact.currency,
        kind=TransactionKind(fact.kind),
    )


def _reconciliation_read(
    import_id: uuid.UUID,
    *,
    reconciliation_status: str,
    reconciled_at: datetime | None,
    provider: str | None,
    model: str | None,
    prompt_version: str | None,
    report: Report | None,
    rows: Mapping[uuid.UUID, RowFact],
    transactions: Mapping[uuid.UUID, TxFact],
) -> StatementReconciliationRead:
    """The ONE answer shape of both reconcile routes (D-R5).

    Written once so the POST cannot answer a different document than the GET: the
    POST fills ``rows``/``transactions`` from the facts it already loaded for the
    pre-match, the GET joins them by id list — and an id that resolves to nothing
    (a transaction the user deleted after the report was taken) becomes a ``null``
    view rather than a 500.
    """
    counts = (
        _NO_COUNTS
        if report is None
        else DiscrepancyCounts(
            missing_in_app=report.counts_by_kind.get(
                DiscrepancyKind.missing_in_app.value, 0
            ),
            extra_in_app=report.counts_by_kind.get(
                DiscrepancyKind.extra_in_app.value, 0
            ),
            amount_differs=report.counts_by_kind.get(
                DiscrepancyKind.amount_differs.value, 0
            ),
            date_differs=report.counts_by_kind.get(
                DiscrepancyKind.date_differs.value, 0
            ),
            fx_difference=report.counts_by_kind.get(
                DiscrepancyKind.fx_difference.value, 0
            ),
        )
    )
    return StatementReconciliationRead(
        import_id=import_id,
        status=StatementReconciliationStatus(reconciliation_status),
        reconciled_at=reconciled_at,
        provider=provider,
        model=model,
        prompt_version=prompt_version,
        settled_exact=0 if report is None else report.settled_exact,
        open_rows=0 if report is None else report.open_rows,
        open_transactions=0 if report is None else report.open_transactions,
        counts=counts,
        unmentioned_rows=0 if report is None else report.unmentioned_rows,
        unmentioned_transactions=(
            0 if report is None else report.unmentioned_transactions
        ),
        items=[
            StatementDiscrepancy(
                kind=DiscrepancyKind(item.kind),
                row_id=item.row_id,
                transaction_id=item.transaction_id,
                explanation=item.explanation,
                row=(
                    None
                    if item.row_id is None or item.row_id not in rows
                    else _row_view(rows[item.row_id])
                ),
                transaction=(
                    None
                    if item.transaction_id is None
                    or item.transaction_id not in transactions
                    else _tx_view(transactions[item.transaction_id])
                ),
            )
            for item in (() if report is None else report.items)
        ],
        summary=None if report is None else report.summary,
    )


@router.post(
    "/{import_id}/reconcile",
    response_model=StatementReconciliationRead,
    responses={
        **_NOT_FOUND,
        **_CONFLICT,
        **_UNPROCESSABLE,
        **_RATE_LIMITED,
        **_UNAVAILABLE,
    },
)
@_limiter_any.limit(
    reconcile_limit_value,
    key_func=reconcile_rl_key,
    exempt_when=rate_limit_exempt,
)
async def reconcile_statement_import(
    request: Request,
    import_id: uuid.UUID,
    user: User = Depends(_stash_rl_user_jwt),
    _provider: None = Depends(require_llm_provider),
    session: AsyncSession = Depends(get_session),
) -> StatementReconciliationRead:
    """Compare this session's rows with what the account already holds (§4).

    Readable on ANY status: on a ``parsed`` session it answers "what does this
    file say that my app does not", on an ``applied`` one "did the import land
    the way I expected" — the same question from two sides, so there is no
    lifecycle gate here.

    Order (D-R5), and all of it matters:

    1. the session (404, foreign == missing), its rows and the account's
       transactions in ``[period_from-3d; period_to+3d]`` on EITHER leg;
    2. the PRE-MATCH — the upload's own matcher settles every provable pair, so
       the model is only ever shown what resemblance cannot decide;
    3. the size refusal (422 RECONCILIATION_TOO_LARGE) BEFORE any provider call:
       an unbounded list in a prompt is the one thing a token budget cannot fix;
    4. the CLAIM — one ``UPDATE … RETURNING`` committed before the loop, so a
       double click burns one loop and the second POST answers 409
       RECONCILIATION_RUNNING. A claim older than twice the time budget is
       re-taken: a crashed run must not lock the session forever;
    5. the loop, which never raises;
    6. one more short transaction, whatever happened: ``ok`` + the report, or
       ``failed`` + a NULL document — and the provenance trio either way,
       because "we asked this model and got nothing" is the diagnosable fact.

    A failure answers 503 AI_UNAVAILABLE for a provider outage (the file is
    fine, retrying later is the right advice) and 422 RECONCILIATION_FAILED for
    everything else.
    """
    settings: Settings = request.app.state.settings
    provider: LLMProvider | None = request.app.state.llm
    if provider is None:  # pragma: no cover - the dependency already refused
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI_NOT_CONFIGURED",
        )
    session_row = await _load_own(session, import_id, user.id)
    if session_row is None:
        raise _not_found()
    # Read off the instance BEFORE the claim's commit: a commit expires every
    # loaded attribute, and touching an expired one would lazy-load IO in a sync
    # context — a greenlet crash on the async engine (the receipts precedent).
    account_id = session_row.account_id
    period_from = session_row.period_from
    period_to = session_row.period_to
    currency = session_row.statement_currency

    stored_rows = list(
        (
            await session.scalars(
                select(StatementImportRow)
                .where(StatementImportRow.import_id == import_id)
                .order_by(StatementImportRow.row_index)
            )
        ).all()
    )
    facts = [_row_fact(row, currency) for row in stored_rows]
    since, until = _candidate_window(
        period_from,
        period_to,
        ((fact.txn_date, fact.booked_date) for fact in facts),
        widen=RECONCILE_PAIR_WINDOW,
    )
    views = await _load_account_tx_views(
        session,
        user.id,
        account_id,
        Transaction.occurred_at >= since,
        Transaction.occurred_at <= until,
    )
    pre = prematch(facts, [_tx_fact(view) for view in views])
    if (
        max(len(pre.open_rows), len(pre.open_transactions))
        > settings.reconcile_max_items_per_side
    ):
        raise _unprocessable("RECONCILIATION_TOO_LARGE")
    # The COLUMN, never the Profile instance (the categorize precedent): the
    # model writes its prose in the user's own language, and "no profile row" is
    # the same answer as "unset".
    language = await session.scalar(
        select(Profile.language).where(Profile.user_id == user.id)
    )

    claim = await session.execute(
        update(StatementImport)
        .where(
            StatementImport.id == import_id,
            StatementImport.user_id == user.id,
            or_(
                StatementImport.reconciliation_status
                != StatementReconciliationStatus.running.value,
                # ``reconciliation_started_at`` is NULL while the status is
                # ``none``, and ``NULL < x`` is NULL — which is why the status
                # arm comes first and the two are OR'd: that row is covered by
                # "not running", never by the staleness comparison.
                StatementImport.reconciliation_started_at
                < func.now()
                - timedelta(seconds=2 * settings.reconcile_time_budget_seconds),
            ),
        )
        .values(
            reconciliation_status=StatementReconciliationStatus.running.value,
            reconciliation_started_at=func.now(),
            # The previous report goes NOW, and that is not housekeeping: the
            # ``reconciliation_present`` CHECK reads "``ok`` ⇔ there is a
            # document", so leaving the old JSONB behind would make the claim
            # itself (``running`` + NOT NULL) an IntegrityError — a re-run of a
            # session that already holds a report would answer 500 and never be
            # re-claimable. "While a run is in flight there is no report" is the
            # consistent reading, the same one the failure arm below writes, and
            # the one the GET's ``running`` arm already renders.
            reconciliation=null(),
            reconciled_at=None,
            reconcile_provider=None,
            reconcile_model=None,
            reconcile_prompt_version=None,
        )
        .returning(StatementImport.id)
        .execution_options(synchronize_session=False)
    )
    claimed = claim.first()
    # COMMITTED before the loop (the receipts claim): a parallel POST must see
    # the claim, and a 60-second loop inside an open write transaction would hold
    # a row lock for a minute.
    await session.commit()
    if claimed is None:
        # The existence gate above already answered a missing or foreign id, so
        # zero rows updated can only mean "a run is already in flight".
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="RECONCILIATION_RUNNING"
        )

    outcome = await reconcile(
        provider,
        pre,
        ReconcileConfig(
            max_steps=settings.reconcile_max_steps,
            max_total_tokens=settings.reconcile_max_total_tokens,
            time_budget_seconds=settings.reconcile_time_budget_seconds,
            max_items_per_side=settings.reconcile_max_items_per_side,
        ),
        period_from=period_from,
        period_to=period_to,
        currency=currency,
        language=language or _DEFAULT_LANGUAGE,
        user_id=str(user.id),
    )
    document = stored_report(outcome)
    await session.execute(
        update(StatementImport)
        .where(StatementImport.id == import_id, StatementImport.user_id == user.id)
        .values(
            reconciliation_status=(
                StatementReconciliationStatus.failed.value
                if document is None
                else StatementReconciliationStatus.ok.value
            ),
            # NULL on failure, and that is load-bearing: the
            # ``reconciliation_present`` CHECK makes ``ok`` mean "there is a
            # document", so a failed re-run must clear the previous one rather
            # than leave a report the status denies.
            #
            # ``null()`` and NOT a bare ``None``: SQLAlchemy's JSON types send
            # Python ``None`` as the JSON VALUE ``null`` (``none_as_null`` is
            # off by default), which is a non-NULL column the CHECK refuses.
            reconciliation=document if document is not None else null(),
            # Stamped on the ``ok`` arm ONLY (D-R5): it dates the REPORT, not the
            # attempt, which is what ``StatementImportRead.reconciled_at``
            # promises ("null unless one is stored") and what the web renders. A
            # failure leaves the NULL the claim already wrote.
            reconciled_at=func.now() if document is not None else None,
            reconcile_provider=provider.name,
            reconcile_model=provider.model,
            reconcile_prompt_version=RECONCILE_PROMPT_VERSION,
        )
        .execution_options(synchronize_session=False)
    )
    await session.commit()

    if outcome.report is None:
        # The CAUSE goes to the log, not to a field: one coarse status on the
        # wire (the ``ai_status`` rule), the reason where an operator reads it.
        logger.info(
            "reconciliation failed (import %s): %s",
            import_id,
            outcome.aborted_reason,
        )
        if outcome.aborted_reason == "unavailable":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="AI_UNAVAILABLE",
            )
        raise _unprocessable("RECONCILIATION_FAILED")

    # One scalar re-read of the timestamp the DATABASE wrote: the write above
    # stamps ``now()`` server-side (one clock for the claim and the stamp), so
    # this is the only way the POST can answer the same ``reconciled_at`` the
    # GET will — and a client that polls must not see two different values.
    stamped = await session.scalar(
        select(StatementImport.reconciled_at).where(StatementImport.id == import_id)
    )
    return _reconciliation_read(
        import_id,
        reconciliation_status=StatementReconciliationStatus.ok.value,
        reconciled_at=stamped,
        provider=provider.name,
        model=provider.model,
        prompt_version=RECONCILE_PROMPT_VERSION,
        report=outcome.report,
        rows={fact.id: fact for fact in pre.open_rows},
        transactions={fact.id: fact for fact in pre.open_transactions},
    )


@router.get(
    "/{import_id}/reconciliation",
    response_model=StatementReconciliationRead,
    responses={**_NOT_FOUND},
)
async def get_statement_reconciliation(
    import_id: uuid.UUID,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> StatementReconciliationRead:
    """The stored report, items included — 200 even when there is none (D-R5).

    A session nobody reconciled answers ``status='none'`` with empty counts and
    an empty list: its only 404 is IMPORT_NOT_FOUND (foreign == missing), and a
    second 404 for "no report yet" would be a second code path for one resource.

    The two mini views are joined HERE rather than stored: the document keeps ids
    only, so a transaction deleted since the run yields ``transaction: null``
    instead of a dangling id — two queries for the whole list, never one per
    item.
    """
    session_row = await _load_own(session, import_id, user.id)
    if session_row is None:
        raise _not_found()
    document = session_row.reconciliation
    report = None if document is None else report_from_json(document)
    if document is not None and report is None:
        # A document this code cannot read (written by another version of the
        # report shape) is an empty report plus a warning, never a 500 on a GET.
        logger.warning("stored reconciliation of import %s is unreadable", import_id)

    rows: dict[uuid.UUID, RowFact] = {}
    transactions: dict[uuid.UUID, TxFact] = {}
    if report is not None:
        row_ids = {item.row_id for item in report.items if item.row_id is not None}
        tx_ids = {
            item.transaction_id
            for item in report.items
            if item.transaction_id is not None
        }
        if row_ids:
            rows = {
                row.id: _row_fact(row, session_row.statement_currency)
                for row in (
                    await session.scalars(
                        select(StatementImportRow).where(
                            StatementImportRow.import_id == import_id,
                            StatementImportRow.id.in_(row_ids),
                        )
                    )
                ).all()
            }
        if tx_ids:
            transactions = {
                view.id: _tx_fact(view)
                for view in await _load_account_tx_views(
                    session,
                    user.id,
                    session_row.account_id,
                    Transaction.id.in_(tx_ids),
                )
            }
    return _reconciliation_read(
        import_id,
        reconciliation_status=session_row.reconciliation_status,
        reconciled_at=session_row.reconciled_at,
        provider=session_row.reconcile_provider,
        model=session_row.reconcile_model,
        prompt_version=session_row.reconcile_prompt_version,
        report=report,
        rows=rows,
        transactions=transactions,
    )
