"""The embedding seam's contract: one Protocol, one error, one text kind.

App-free on purpose (numpy + stdlib only — no fastapi, no models, no db), for
the same reason ``llm/types.py`` is: ``evals/retrieval.py`` has to drive an
embedder with no application and no database at all.

``embed`` is SYNC and CPU-bound. Every caller inside the app goes through
``asyncio.to_thread`` — a 32-row batch is ~150 ms of pure compute, and running
that on the event loop would stall every other request for its duration.
"""

from collections.abc import Sequence
from typing import Literal, Protocol

import numpy as np
from numpy.typing import NDArray

#: Which side of the asymmetric e5 pair a text is. The prefixes themselves are a
#: property of THAT MODEL and live in ``onnx.py``: the canonical text
#: (``services/tx_text.py``) never contains them, so a future symmetric model is
#: a change in one file.
TextKind = Literal["query", "passage"]


class EmbedderLoadError(RuntimeError):
    """The artifact is missing, tampered with, or unusable by this runtime.

    Raised by ``load()``, or by ``embed()`` on an embedder that was never
    loaded. The lifespan turns it into one warning and
    ``app.state.embedder = None`` ("search not available"), never a boot failure
    — the ``provider_from_settings`` rule: a server with no model must still
    serve every other route.
    """


class Embedder(Protocol):
    """What the index and the search path are allowed to assume.

    ``model`` is a STAMP stored on every indexed row (``transaction_embeddings.
    model``): a row is current only if its stamp equals the live embedder's, so
    swapping the artifact invalidates the index by construction rather than by
    anyone remembering to clear it.
    """

    #: Provider spelling — ``"onnx"`` / ``"fake"``. For logs and the registry.
    name: str
    #: The artifact identity written on every row (``<repo>@<rev7>/<file>``).
    model: str
    #: Rows of ``embed``'s output. 384 for e5-small, and the one number the DB
    #: CHECK ``octet_length(vector) = 1536`` encodes.
    dim: int

    def load(self) -> None:
        """Verify the artifact and build the session. May raise EmbedderLoadError."""
        ...

    def embed(self, texts: Sequence[str], *, kind: TextKind) -> NDArray[np.float32]:
        """``(len(texts), dim)`` L2-NORMALISED float32 rows, in input order.

        Normalised here and nowhere else, which is what makes a dot product a
        cosine everywhere downstream (``services/tx_search.py``).
        """
        ...
