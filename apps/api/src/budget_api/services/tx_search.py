"""Semantic retrieval over the pull index: one function, one definition of a hit.

``search`` is what BOTH surfaces call — ``GET /transactions/search`` and the
cited Q&A (``routers/advisor_qa.py``) — so "what was retrieved" has exactly one
meaning in this codebase. The Q&A's citations are verified against the hits this
function returned, and its total is the total of those same rows; splitting the
retrieval in two would make the verification a claim about a different set.

Six properties of the ordering and the bounds are load-bearing:

1. **The filters are ``read_filters``**, the same function ``GET /transactions``
   and the CSV export use. Filter semantics therefore cannot drift between the
   text list and the semantic list, and ``?kind=transfer`` answers an honest
   empty page rather than a different population (D-T4: the index holds no
   transfer).
2. **The candidate select JOINs ``Transaction``.** Those filters are expressed
   over the transactions table; filtering the embeddings table alone would
   compile and silently ignore every one of them.
3. **The stale refresh runs FIRST** (amendment A7) and only for the caller:
   "I just added it, then searched" has to work. What it could not reach is
   REPORTED as ``pending_count``, never hidden.
4. **``np.argsort(..., kind="stable")``** over a candidate list already ordered
   ``occurred_at DESC, id`` — that IS D-R2's tie rule. The default quicksort
   would make two equal-scoring rows swap places between calls.
5. **``min_score`` cuts AFTER the top-k**, so the parameter can only ever remove
   rows from the answer, never pull deeper ones in.
6. **Zero candidates means zero model calls.** An empty index or a filter that
   matches nothing must not pay for an embedding, and on the Q&A side it is what
   makes ``answer: null`` cost nothing at all.

Scores are RAW cosine (the vectors are L2-normalised by the embedder, so a dot
product IS the cosine). No relative cut-off in v1: real margins between a right
and a wrong row are 0.006..0.03 (evidence.md), so any default would drop true
hits — ``limit`` is the bound that does not lie.
"""

import asyncio
import logging
import uuid
from dataclasses import dataclass

import numpy as np
from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.embeddings import Embedder
from budget_api.models import Transaction, TransactionEmbedding
from budget_api.services.tx_index import refresh
from budget_api.services.tx_totals import RowsTotal, converted_total_for_rows

logger = logging.getLogger(__name__)

#: Cosine scores are reported at four decimals. Enough to order a list and to
#: read a 0.006 margin; short of pretending a float32 dot product is exact.
SCORE_DIGITS = 4


@dataclass(frozen=True)
class Hit:
    """One retrieved row and how close it was. The ORM row, not a projection."""

    transaction: Transaction
    score: float


@dataclass(frozen=True)
class SearchResult:
    """``hits`` in rank order, plus what the caller must be told about them.

    ``pending_count`` is the caller's USER-WIDE stale count AFTER the refresh
    above, deliberately independent of the request's filters (ruling ASK-6): the
    honest sentence is "N recent operations are still being indexed", and a
    filter-scoped number would read as "…in this month" while being neither.

    ``candidates`` is how many indexed rows the scan actually considered, so a
    user who hit ``search_max_candidates`` can be told the scan was bounded.
    """

    hits: list[Hit]
    total: RowsTotal
    pending_count: int
    candidates: int
    model: str


async def search(
    session: AsyncSession,
    embedder: Embedder,
    *,
    user_id: uuid.UUID,
    base: str,
    query: str,
    limit: int,
    filters: list[ColumnElement[bool]],
    min_score: float | None,
    max_candidates: int,
    max_refresh: int,
    batch_size: int,
) -> SearchResult:
    """Rank ``user_id``'s indexed rows against ``query``; total what came back.

    ``filters`` arrives already built by ``read_filters`` (the router owns the
    query parameters), which is also what keeps this module free of HTTP: it
    refuses nothing — a foreign ``account_id`` matches no row and the answer is
    the same empty body a filter matching nothing produces (no existence
    oracle).
    """
    stats = await refresh(
        session, embedder, user_id, batch_size=batch_size, max_rows=max_refresh
    )
    if stats.embedded:
        # Only when it actually did work: a log line per search would bury the
        # sweep's own line, and the common case is "nothing was stale".
        logger.info(
            "embeddings search refresh embedded=%d pending=%d",
            stats.embedded,
            stats.pending,
        )

    candidates = (
        await session.execute(
            select(TransactionEmbedding.transaction_id, TransactionEmbedding.vector)
            .join(Transaction, Transaction.id == TransactionEmbedding.transaction_id)
            .where(*filters, TransactionEmbedding.model == embedder.model)
            # Newest first, so a bounded scan keeps the recent ledger rather than
            # an arbitrary slice of it — and so the tie order below is a date
            # order (D-R2).
            .order_by(Transaction.occurred_at.desc(), Transaction.id)
            .limit(max_candidates)
        )
    ).all()

    if not candidates:
        # NO model call: an empty candidate set has nothing to be close to.
        return SearchResult(
            hits=[],
            total=RowsTotal(income_minor=0, expense_minor=0, unconverted_count=0),
            pending_count=stats.pending,
            candidates=0,
            model=embedder.model,
        )

    vector = (await asyncio.to_thread(embedder.embed, [query], kind="query"))[0]
    # ONE buffer for the whole matrix: 20 000 rows is a 30 MB transient and a
    # 0.56 ms dot product (evidence.md). "<f4" is SPELLED, never inherited — the
    # bytes were written little-endian by ``tx_index``.
    matrix = np.frombuffer(b"".join(row[1] for row in candidates), dtype="<f4").reshape(
        len(candidates), embedder.dim
    )
    scores = matrix @ vector

    order = np.argsort(-scores, kind="stable")[:limit]
    ranked = [
        (candidates[int(index)][0], round(float(scores[int(index)]), SCORE_DIGITS))
        for index in order
    ]
    if min_score is not None:
        # The cut is on the ROUNDED score above — the very number the client is
        # shown — so a 0.84996 row does pass ``min_score=0.85``. Deliberate: a
        # threshold must agree with the figure it is compared against, otherwise
        # a response can list a 0.85 row the same filter would have dropped.
        ranked = [pair for pair in ranked if pair[1] >= min_score]
    if not ranked:
        return SearchResult(
            hits=[],
            total=RowsTotal(income_minor=0, expense_minor=0, unconverted_count=0),
            pending_count=stats.pending,
            candidates=len(candidates),
            model=embedder.model,
        )

    rows = {
        row.id: row
        for row in (
            await session.scalars(
                select(Transaction).where(
                    # Scoped even though the ids came from the candidate select,
                    # whose ``filters`` open with this same predicate: every query
                    # in this codebase carries it (conventions.md), and a future
                    # caller handing over hand-built ``filters`` must not be able
                    # to turn this load into an unscoped read.
                    Transaction.user_id == user_id,
                    Transaction.id.in_(
                        [transaction_id for transaction_id, _ in ranked]
                    ),
                )
            )
        ).all()
    }
    # Re-ordered by RANK in Python: ``IN`` returns rows in whatever order the
    # plan produced, and the order is the whole answer here.
    hits = [
        Hit(transaction=rows[transaction_id], score=score)
        for transaction_id, score in ranked
        if transaction_id in rows
    ]
    total = await converted_total_for_rows(
        session, [hit.transaction for hit in hits], base
    )
    return SearchResult(
        hits=hits,
        total=total,
        pending_count=stats.pending,
        candidates=len(candidates),
        model=embedder.model,
    )
