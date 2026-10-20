"""The user's own history as a few-shot pool: the DB half of categorize-v2.

The pure selection is ``services/categorize_examples.py``; what lives here is the
part that needs a session and an embedder, kept OUT of that module for the reason
``tx_search`` is kept out of ``tx_text`` (grooming D1/D2).

The pool IS the RAG index (``transaction_embeddings``, migration 0020). Nothing
is embedded here: re-embedding a user's history inline would cost ~19 s of a 45 s
import budget (5 000 rows at 3.7 ms), while the stored passage vectors are free
and are the same vectors semantic search ranks. Only the batch's operation texts
are embedded, once per batch, query-side.

What a pool row must be (D1), all of it in ONE query:

* the SAME user's row — examples never cross users, which is the privacy
  invariant of this feature and the reason the ``user_id`` predicate is on the
  transactions side where every other read puts it;
* already categorized, into a NON-ARCHIVED category — an archived category is
  not offered to the model, so a row filed under one teaches nothing;
* money (``tx_totals.NOT_TRANSFER_OR_DEBT``, imported and never re-spelled) —
  the index holds no transfers and no debt movements anyway, so the predicate is
  belt-and-braces against a future population change;
* stamped with the LIVE embedder's model, or its vector is not comparable with
  the query the live embedder produces;
* newest first, bounded by ``categorize_examples_pool_max``: recent decisions are
  the ones a user still agrees with.

No text of any operation ever reaches a log line here — the caller logs counts
(``docs/conventions.md``).
"""

import asyncio
import re
import uuid
from collections.abc import Sequence

import numpy as np
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.embeddings import Embedder
from budget_api.models import Category, Transaction, TransactionEmbedding
from budget_api.services.categorize import CategoryOption, Operation
from budget_api.services.categorize_examples import (
    Example,
    ExamplePool,
    SelectionLimits,
)
from budget_api.services.categorize_examples import select as select_examples
from budget_api.services.tx_totals import NOT_TRANSFER_OR_DEBT

#: An example's text is the same SHAPE a statement row shows the model
#: (``display_name`` = a merchant or the raw line), so a longer note would be a
#: different kind of string than the thing being categorized. 80 characters is
#: well past any real merchant name and keeps 40 examples inside the character
#: budget of one batch.
MAX_EXAMPLE_CHARS = 80

#: Where the note's first clause ends — the part that names what was bought,
#: before the owner's own prose. A sibling of ``evals/anonymize.py``'s rule for
#: the committed dataset; that one additionally scrubs PII, which a production
#: read of the user's own note must not need.
_CLAUSE_BOUNDARY = re.compile(r" — | - |[.,:;(]")
_WHITESPACE = re.compile(r"\s+")


async def load_example_pool(
    session: AsyncSession,
    embedder: Embedder,
    user_id: uuid.UUID,
    *,
    limit: int,
) -> ExamplePool:
    """``user_id``'s newest categorized rows, with their STORED vectors.

    Returns an EMPTY pool (``size == 0``) for a user with no usable history —
    a new account, or one whose rows are not indexed yet. The caller then passes
    no selector and the pass degrades to the v1 request (D5), which is why
    nothing here raises on an empty result.
    """
    rows = (
        await session.execute(
            select(
                TransactionEmbedding.vector,
                Transaction.merchant,
                Transaction.note,
                Transaction.category_id,
            )
            .join(Transaction, Transaction.id == TransactionEmbedding.transaction_id)
            .join(Category, Category.id == Transaction.category_id)
            .where(
                Transaction.user_id == user_id,
                Transaction.category_id.is_not(None),
                Category.archived.is_(False),
                NOT_TRANSFER_OR_DEBT,
                TransactionEmbedding.model == embedder.model,
            )
            .order_by(Transaction.occurred_at.desc(), Transaction.id)
            .limit(max(0, limit))
        )
    ).all()

    vectors: list[bytes] = []
    texts: list[str] = []
    category_ids: list[uuid.UUID] = []
    for vector, merchant, note, category_id in rows:
        text = example_text(merchant, note)
        if not text or category_id is None:
            # Neither a merchant nor a usable note: there is nothing to show the
            # model, and a bare category name as an example teaches nothing.
            continue
        vectors.append(vector)
        texts.append(text)
        category_ids.append(category_id)
    if not texts:
        return ExamplePool(
            texts=(),
            category_ids=(),
            matrix=np.zeros((0, embedder.dim), dtype=np.float32),
        )
    # "<f4" is SPELLED, never inherited: ``tx_index`` wrote these bytes
    # little-endian (the same rule ``tx_search`` reads them under).
    matrix = np.frombuffer(b"".join(vectors), dtype="<f4").reshape(
        len(vectors), embedder.dim
    )
    return ExamplePool(
        texts=tuple(texts),
        category_ids=tuple(category_ids),
        matrix=matrix.astype(np.float32),
    )


def example_text(merchant: str | None, note: str | None) -> str:
    """The merchant, else the note's first clause: collapsed, cut, or ``""``."""
    name = _WHITESPACE.sub(" ", merchant or "").strip()
    if not name:
        clause = _CLAUSE_BOUNDARY.split((note or "").strip(), maxsplit=1)[0]
        name = _WHITESPACE.sub(" ", clause).strip()
    return name[:MAX_EXAMPLE_CHARS]


class PoolExampleSelector:
    """``ExampleSelector`` over a pool: embed the batch's texts, then select.

    Built once per categorize pass by the router (and by the evals runner), so the
    pool is read and the vectors are decoded ONCE however many batches follow.
    ``embed`` is sync and CPU-bound, hence ``asyncio.to_thread`` — the
    ``embeddings.types`` contract, and the same call shape ``tx_search`` uses.
    """

    def __init__(
        self, pool: ExamplePool, embedder: Embedder, limits: SelectionLimits
    ) -> None:
        self._pool = pool
        self._embedder = embedder
        self._limits = limits

    @property
    def pool_size(self) -> int:
        return self._pool.size

    async def select(
        self,
        operations: Sequence[Operation],
        options: Sequence[CategoryOption],
    ) -> tuple[Example, ...]:
        if self._pool.size == 0 or not operations or not options:
            return ()
        # Unique texts only, in order: two rows differing just by currency are one
        # question to the embedder, and the per-operation top-k is the same set
        # either way.
        texts = list(dict.fromkeys(operation.text for operation in operations))
        queries = await asyncio.to_thread(self._embedder.embed, texts, kind="query")
        return select_examples(
            self._pool,
            queries,
            category_ids=[option.id for option in options],
            limits=self._limits,
        )
