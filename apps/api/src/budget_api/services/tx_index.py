"""The pull index: find stale rows, embed them, upsert — and the sweep job.

The ONE repair function is :func:`refresh`, and all three repair paths call it
(rag architecture D-I3):

1. the 5-minute scheduler sweep (:func:`sweep_embeddings`);
2. the boot run-now job — the same function, scheduled and never awaited
   (amendment A2): readiness must not wait on a backfill;
3. a ≤ ``search_max_refresh`` refresh at search time (S2), whose remainder is
   REPORTED as ``pending_count`` rather than silently missing.

Staleness is a HASH, not a timestamp: a row is current iff an embedding exists
with the live embedder's ``model`` stamp and ``text_hash(tx_text(row))`` as it
reads right now. That one comparison covers an edited merchant, a renamed
category, a renamed account and a ``TEXT_VERSION`` bump, with no writer touched
anywhere in the app. ``transactions`` has no ``updated_at`` to lean on, and
adding one would be a push-shaped change (D-I2).

Scanning is cheap and embedding is not, which is why the two halves are bounded
differently: the TIME budget bounds the scan (one SELECT + N sha256 per user),
the ROW cap bounds the model calls.

The job never raises. An APScheduler job that raises is swallowed into an error
event, and the next run re-derives everything anyway — so the contract here is
the ``materialize_due`` one: log and return.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from budget_api.config import Settings
from budget_api.embeddings import Embedder
from budget_api.models import (
    Account,
    Category,
    Transaction,
    TransactionEmbedding,
)
from budget_api.services.tx_text import TextFacts, text_hash, tx_text
from budget_api.services.tx_totals import NOT_TRANSFER_OR_DEBT

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RefreshStats:
    """``embedded`` rows were written; ``pending`` are still stale afterwards."""

    embedded: int
    pending: int


@dataclass(frozen=True)
class SweepConfig:
    batch_size: int
    max_rows: int
    time_budget_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "SweepConfig":
        return cls(
            batch_size=settings.embeddings_batch_size,
            max_rows=settings.embeddings_sweep_max_rows,
            time_budget_seconds=settings.embeddings_sweep_time_budget_seconds,
        )


@dataclass(frozen=True)
class _Stale:
    """A transaction that needs (re-)embedding, with its document already built."""

    transaction_id: uuid.UUID
    text: str
    text_hash: str


async def stale_rows(
    session: AsyncSession, model: str, user_id: uuid.UUID
) -> list[_Stale]:
    """Every row of ``user_id``'s indexed population whose vector is not current.

    ONE query per user, newest first: the indexed columns plus the two JOINed
    names the document carries, LEFT JOINed to whatever embedding exists. The
    account join is INNER because ``account_id`` is NOT NULL; the category join
    is LEFT because a row may be uncategorized.

    Hashing happens here, in Python: at 5 000 rows that is one SELECT plus 5 000
    sha256 — tens of milliseconds — and it is what makes a category rename
    visible without any column to watch.
    """
    rows = (
        await session.execute(
            select(
                Transaction.id,
                Transaction.merchant,
                Transaction.note,
                Category.name,
                Transaction.kind,
                Transaction.country,
                Account.name,
                TransactionEmbedding.model,
                TransactionEmbedding.text_hash,
            )
            .join(Account, Account.id == Transaction.account_id)
            .join(Category, Category.id == Transaction.category_id, isouter=True)
            .join(
                TransactionEmbedding,
                TransactionEmbedding.transaction_id == Transaction.id,
                isouter=True,
            )
            .where(Transaction.user_id == user_id, NOT_TRANSFER_OR_DEBT)
            .order_by(Transaction.occurred_at.desc(), Transaction.id)
        )
    ).all()

    stale: list[_Stale] = []
    for (
        transaction_id,
        merchant,
        note,
        category_name,
        kind,
        country,
        account_name,
        stored_model,
        stored_hash,
    ) in rows:
        text = tx_text(
            TextFacts(
                merchant=merchant,
                note=note,
                category_name=category_name,
                kind=kind,
                country=country,
                account_name=account_name,
            )
        )
        current = text_hash(text)
        if stored_model == model and stored_hash == current:
            continue
        stale.append(
            _Stale(transaction_id=transaction_id, text=text, text_hash=current)
        )
    return stale


def _cause_name(exc: IntegrityError) -> str:
    """The DRIVER exception's class name — ``ForeignKeyViolationError`` & co.

    ``type(exc.orig).__name__`` is NOT it: SQLAlchemy's asyncpg dialect does not
    hand asyncpg's exception through, it raises a DBAPI-shaped wrapper of its own
    (``AsyncAdapt_asyncpg_dbapi.IntegrityError``) ``from`` the real one, so the
    wrapper's name is the same word for every integrity failure. The ``__cause__``
    is the asyncpg class that names the kind; the fallback keeps this a log line
    rather than a second failure if a future driver stops chaining.
    """
    inner = exc.orig.__cause__ if exc.orig is not None else None
    return type(inner if inner is not None else exc.orig).__name__


async def refresh(
    session: AsyncSession,
    embedder: Embedder,
    user_id: uuid.UUID,
    *,
    batch_size: int,
    max_rows: int,
) -> RefreshStats:
    """Embed up to ``max_rows`` of ``user_id``'s stale rows; report the remainder.

    Commits per BATCH, not per call: a crash loses one batch of work, never the
    table, and a long backfill is visible in the DB as it progresses rather than
    appearing all at once at the end.
    """
    stale = await stale_rows(session, embedder.model, user_id)
    todo = stale[:max_rows]
    pending = len(stale) - len(todo)
    embedded = 0

    for start in range(0, len(todo), batch_size):
        batch = todo[start : start + batch_size]
        vectors = await asyncio.to_thread(
            embedder.embed, [item.text for item in batch], kind="passage"
        )
        values = [
            {
                "transaction_id": item.transaction_id,
                "user_id": user_id,
                "model": embedder.model,
                "text_hash": item.text_hash,
                # Byte order SPELLED, never inherited from the host: a vector
                # written on one architecture is read back with np.frombuffer on
                # another, and "<f4" is the only thing making that safe.
                "vector": vector.astype("<f4").tobytes(),
            }
            for item, vector in zip(batch, vectors, strict=True)
        ]
        statement = pg_insert(TransactionEmbedding).values(values)
        try:
            await session.execute(
                statement.on_conflict_do_update(
                    index_elements=[TransactionEmbedding.transaction_id],
                    set_={
                        "user_id": statement.excluded.user_id,
                        "model": statement.excluded.model,
                        "text_hash": statement.excluded.text_hash,
                        "vector": statement.excluded.vector,
                        "embedded_at": func.now(),
                    },
                )
            )
            await session.commit()
        except IntegrityError as exc:
            # Usually a transaction deleted between the scan and this upsert: its
            # FK is gone, so the whole batch rolls back and the next run simply
            # will not see that row. But the SAME exception also carries a CHECK
            # violation (a vector that is not 1536 bytes, an empty stamp), which
            # is a permanent, every-5-minutes failure — so the KIND is logged,
            # and only the kind: the exception's MESSAGE quotes the offending
            # row, i.e. this user's merchant names (the llm/usage.py rule).
            await session.rollback()
            logger.warning(
                "embeddings batch rolled back rows=%d sqlstate=%s cause=%s",
                len(batch),
                # Postgres' own class code ("23503" FK, "23514" CHECK): stable,
                # documented, and never text. SQLAlchemy's asyncpg dialect copies
                # it onto the DBAPI-shaped wrapper it raises.
                getattr(exc.orig, "sqlstate", None),
                _cause_name(exc),
            )
            # The batch is STILL STALE, so it belongs in ``pending``: that number
            # is "what this call left behind", and S2 shows the caller's own copy
            # of it. Counting only the untried tail would make a permanently
            # failing CHECK look like a fully indexed user.
            pending += len(batch)
            continue
        embedded += len(batch)

    return RefreshStats(embedded=embedded, pending=pending)


async def users_to_sweep(
    session: AsyncSession, model: str
) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
    """``(priority, rest)`` — who to repair first, then everyone else (FLAG-2).

    ``priority`` are users with a MISSING or model-mismatched row: the cheap SQL
    answer to "who is definitely behind", which covers a fresh deploy, an import
    and a model swap.

    ``rest`` is every other user with a population row, and it exists because
    hash-only staleness is INVISIBLE to that SQL: a user whose rows are all
    indexed but who renamed a category has no missing and no mismatched row, so
    a priority-only sweep would never repair him — only his own next search
    would, and this module's promise would hold nowhere else. Scanning the tail
    is one SELECT plus N sha256 per user, bounded by the run's time budget.

    (If user count ever starves the tail, the fix is a ``last_swept_at`` column —
    recorded as a follow-up, deliberately not built at low-thousands scale.)
    """
    priority = list(
        (
            await session.scalars(
                select(Transaction.user_id)
                .join(
                    TransactionEmbedding,
                    TransactionEmbedding.transaction_id == Transaction.id,
                    isouter=True,
                )
                .where(
                    NOT_TRANSFER_OR_DEBT,
                    (TransactionEmbedding.transaction_id.is_(None))
                    | (TransactionEmbedding.model != model),
                )
                .distinct()
            )
        ).all()
    )
    everyone = list(
        (
            await session.scalars(
                select(Transaction.user_id).where(NOT_TRANSFER_OR_DEBT).distinct()
            )
        ).all()
    )
    seen = set(priority)
    return priority, [user_id for user_id in everyone if user_id not in seen]


async def sweep_embeddings(
    *,
    sessionmaker: async_sessionmaker[AsyncSession],
    embedder: Embedder | None,
    config: SweepConfig,
) -> None:
    """The scheduled job: repair what is stale, within two budgets. NEVER raises.

    One session per user (the ``materialize_due`` discipline: no session is held
    across the model work of another user), priority users first, the whole loop
    under the time budget and the whole run under the row cap.

    ONE log line per run, and it carries no text and no ids — a search index is
    built from merchant names and notes, and those have no business in a log.
    Its ``pending`` is a FLOOR, not a total: once the row cap bites, the tail of
    the user list is not scanned at all, so what it reports is what this run
    saw. (The number a USER is shown is never this one — a search computes
    ``pending_count`` for that caller alone.)
    """
    if embedder is None:
        # EMBEDDINGS_PROVIDER=off, or an artifact that failed to load. The gate
        # may stay on and the job stays harmless (the push_jobs keyless server
        # precedent).
        logger.info("embeddings sweep skipped: no embedder on this server")
        return

    started = time.monotonic()
    users_seen = 0
    embedded = 0
    pending = 0
    try:
        async with asyncio.timeout(config.time_budget_seconds):
            async with sessionmaker() as session:
                priority, rest = await users_to_sweep(session, embedder.model)
            for user_id in [*priority, *rest]:
                if embedded >= config.max_rows:
                    break
                async with sessionmaker() as session:
                    stats = await refresh(
                        session,
                        embedder,
                        user_id,
                        batch_size=config.batch_size,
                        max_rows=config.max_rows - embedded,
                    )
                users_seen += 1
                embedded += stats.embedded
                pending += stats.pending
    except TimeoutError:
        # Expiry is an ordinary outcome on a big backfill, not a failure: what
        # was committed stays committed and the next run picks up the remainder.
        logger.info(
            "embeddings sweep hit its time budget after %ds", config.time_budget_seconds
        )
    except Exception as exc:
        # Broad on purpose, the ``materialize_due`` contract: "never raises" is
        # this function's promise, and a DB down at 00:05 must cost one warning,
        # not an APScheduler error event with a traceback.
        logger.warning("embeddings sweep failed: %r", exc)
        return

    logger.info(
        "embeddings sweep users=%d embedded=%d pending=%d ms=%d",
        users_seen,
        embedded,
        pending,
        int((time.monotonic() - started) * 1000),
    )
