"""Which of the user's past decisions go into the prompt — the pure half of v2.

Pure by construction (numpy + ``embeddings.types`` + stdlib): no session, no
models, no FastAPI, so the router, the evals and a test all run the SAME
selection. The DB-aware half — the pool query and the embedder call — is
``services/categorize_pool.py``, exactly as ``tx_search`` owns the SQL that
``tx_text`` must not (grooming D2).

What it is for: a small zero-shot model does not know one person's taxonomy
("Напитки" vs "Продукты" vs "Вкусняшки" are the owner's own three categories).
The strongest available signal is how that same user filed the same or a similar
merchant before, so each batch carries up to :attr:`SelectionLimits.max_examples`
of their own ``text → category`` pairs.

Three properties are load-bearing:

1. **Similarity first, coverage second.** The union of the top-k neighbours per
   operation answers "how did I file THIS shop"; the coverage pass then adds, for
   every eligible category still unrepresented, its single best-scoring row — a
   model that never sees "Вкусняшки" used cannot pick it, however close the
   neighbours of the batch happen to be.
2. **Determinism.** ``np.argsort(..., kind="stable")`` over a pool ordered
   newest-first, then a total order by ``(-score, pool position)``. The replay key
   hashes the document the examples land in (``llm/fake.py``), so a
   non-deterministic order would unreplay every fixture at random.
3. **Bounded.** Two hard caps — a count and a CHARACTER budget as the token proxy
   — because the examples ride in every batch of every import, and an unbounded
   prompt is the one cost a time budget cannot recover.

``SELECTION_VERSION`` is bumped on ANY change to :func:`select`'s behaviour: the
evals' recorded examples sidecar carries it and a replay refuses a sidecar cut by
a different algorithm, which is how a selection change stays loud without the
118 MB embedding artifact being present in CI (D7).
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

#: Bumped by hand whenever :func:`select` would answer differently for the same
#: inputs. The evals sidecar is refused on a mismatch (``evals/run.py``).
SELECTION_VERSION = "examples-v1"


@dataclass(frozen=True)
class Example:
    """One past decision as the prompt shows it: a short text and its category.

    ``category_id`` rather than a name: the document names categories by the
    batch's own ``c``-keys, and the mapping from id to key lives in
    ``services/categorize.py`` where every other key is assigned.
    """

    text: str
    category_id: uuid.UUID


@dataclass(frozen=True)
class ExamplePool:
    """The user's categorized history, already embedded. Three parallel arrays.

    ``matrix`` is ``(n, dim)`` L2-NORMALISED passage vectors in the same row
    order as ``texts``/``category_ids`` — in production literally the stored
    ``transaction_embeddings`` vectors (nothing is re-embedded), newest first.
    """

    texts: tuple[str, ...]
    category_ids: tuple[uuid.UUID, ...]
    matrix: NDArray[np.float32]

    @property
    def size(self) -> int:
        return len(self.texts)


@dataclass(frozen=True)
class SelectionLimits:
    """The three knobs, all from Settings at the router's end (D6)."""

    #: Nearest neighbours taken per operation before the coverage pass.
    per_operation: int
    #: Hard cap on examples in ONE batch's document.
    max_examples: int
    #: Hard cap on the summed length of their texts — the token proxy.
    max_chars: int


def select(
    pool: ExamplePool,
    queries: NDArray[np.float32],
    *,
    category_ids: Sequence[uuid.UUID],
    limits: SelectionLimits,
) -> tuple[Example, ...]:
    """The batch's examples: neighbours, then coverage, then dedupe, then caps.

    ``queries`` is ``(m, dim)`` query-side vectors of the batch's operation texts
    (the caller embeds them — see ``categorize_pool.PoolExampleSelector``), and
    ``category_ids`` is the batch's ELIGIBLE categories. A pool row whose category
    is not among them is dropped here rather than filtered in SQL: eligibility is
    per batch (one kind, visible, non-archived) while the pool is per user, and a
    dropped-at-selection row is one the model could not have answered anyway (D1).

    Returns ``()`` for an empty pool, an empty query set or no eligible row —
    which the caller must read as "send the v1 request" (D5), never as "send an
    empty examples array".
    """
    if pool.size == 0 or queries.shape[0] == 0 or not category_ids:
        return ()
    allowed = set(category_ids)
    eligible = [
        index
        for index, category_id in enumerate(pool.category_ids)
        if category_id in allowed
    ]
    if not eligible:
        return ()

    # Both sides are L2-normalised by the Embedder contract, so the dot product
    # IS the cosine — the identity ``services/tx_search.py`` relies on too.
    scores = pool.matrix[eligible] @ queries.T
    # The best any operation of this batch scored a given pool row: the number
    # the document order and the coverage pass are both read against.
    best = scores.max(axis=1)

    picked: set[int] = set()
    for column in range(scores.shape[1]):
        order = np.argsort(-scores[:, column], kind="stable")[
            : max(0, limits.per_operation)
        ]
        picked.update(int(row) for row in order)
    picked.update(_coverage(pool, eligible, best, allowed, picked))

    # ONE total order for similarity picks and coverage picks alike: score
    # descending, ties broken by pool position (newest first). The caps below cut
    # the tail, so the weakest coverage row is the first thing to go — the
    # deliberate reading of D2's "then the hard caps".
    ordered = sorted(picked, key=lambda row: (-float(best[row]), eligible[row]))
    chosen: list[Example] = []
    seen: set[tuple[str, uuid.UUID]] = set()
    chars = 0
    for row in ordered:
        index = eligible[row]
        text = pool.texts[index]
        category_id = pool.category_ids[index]
        key = (text.casefold(), category_id)
        if key in seen:
            continue
        if len(chosen) >= limits.max_examples:
            break
        if chars + len(text) > limits.max_chars:
            # STOP, not skip: the next row down is no cheaper in tokens than this
            # one, and a prompt whose contents depend on how a scan skipped around
            # is harder to reason about than a shorter one.
            break
        seen.add(key)
        chars += len(text)
        chosen.append(Example(text=text, category_id=category_id))
    return tuple(chosen)


def _coverage(
    pool: ExamplePool,
    eligible: Sequence[int],
    best: NDArray[np.float32],
    allowed: set[uuid.UUID],
    picked: set[int],
) -> list[int]:
    """For every eligible category not yet represented: its best-scoring row.

    Rows are addressed by position in ``eligible`` (the ``best``/``scores``
    index), like everything else in :func:`select`.
    """
    covered = {pool.category_ids[eligible[row]] for row in picked}
    missing = allowed - covered
    if not missing:
        return []
    champion: dict[uuid.UUID, int] = {}
    for row, index in enumerate(eligible):
        category_id = pool.category_ids[index]
        if category_id not in missing:
            continue
        current = champion.get(category_id)
        # Strictly greater keeps the FIRST (newest) row on a tie.
        if current is None or float(best[row]) > float(best[current]):
            champion[category_id] = row
    return sorted(champion.values())
