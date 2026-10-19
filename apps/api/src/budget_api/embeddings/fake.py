"""A deterministic, artifact-free embedder: hashed bag of words.

What it is for: every router test, the whole pytest suite and the CI evals need
RANKING that means something without downloading 135 MB. A query sharing a word
with a passage scores high here, so "the pharmacy query found the pharmacy row"
is a real assertion rather than noise.

What it is NOT: an oracle (the ``FakeProvider`` rule). It knows nothing about
synonyms, languages or morphology — ``аптека`` and ``apteka`` are different
words to it. A test that needs cross-lingual meaning needs the real artifact,
which is exactly why the live QA checklist has the multilingual probes and the
suite does not.

``sha1`` of the token, never Python's ``hash()``: ``PYTHONHASHSEED`` is
randomised per process, so ``hash()`` would make a recorded eval fixture replay
correctly once and fail in the next process — the worst kind of flake.
"""

import hashlib
import re
from collections.abc import Sequence

import numpy as np
from numpy.typing import NDArray

from budget_api.embeddings.types import TextKind

#: Runs of LETTERS in any script (so Cyrillic and Polish diacritics are one token
#: each). Digits are deliberately excluded: an amount or a card number must never
#: become a retrieval feature — ``services/tx_text.py`` keeps amounts out of the
#: document for the same reason.
_TOKEN_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


class FakeEmbedder:
    """``Embedder`` with no artifact, no I/O and no randomness."""

    name = "fake"
    model = "fake"
    dim = 384

    def load(self) -> None:
        """Nothing to verify and nothing to build."""

    def embed(self, texts: Sequence[str], *, kind: TextKind) -> NDArray[np.float32]:
        """One bucket per distinct word, L2-normalised. ``kind`` is ignored.

        ``kind`` is ignored ON PURPOSE: the query/passage asymmetry is a property
        of e5, and a fake that mimicked it would be inventing behaviour the tests
        would then be proving about the fake.

        A text with no letters at all stays all-zero and therefore scores 0
        against everything — honest ("nothing to match on"), not an exception.
        """
        matrix = np.zeros((len(texts), self.dim), dtype=np.float32)
        for row, text in enumerate(texts):
            for token in _TOKEN_RE.findall(text.casefold()):
                digest = hashlib.sha1(token.encode("utf-8")).digest()
                bucket = int.from_bytes(digest[:4], "big") % self.dim
                matrix[row, bucket] += 1.0
        norms = np.clip(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-12, None)
        return (matrix / norms).astype(np.float32)
