"""Which embedder this process uses — the only place that decision is made.

The ``llm/registry.py`` shape, down to its contract: "not available" is a
``None`` return, never an exception, and construction does NO I/O. A server
whose artifact is missing, or whose operator set ``EMBEDDINGS_PROVIDER=off`` to
reclaim 510 MB of RAM, must boot and serve everything else — search is the one
feature that answers 503.
"""

import logging
from pathlib import Path

from budget_api.config import Settings
from budget_api.embeddings.fake import FakeEmbedder
from budget_api.embeddings.onnx import OnnxEmbedder
from budget_api.embeddings.types import Embedder

logger = logging.getLogger(__name__)

#: Everything ``embeddings_provider`` may name. ``off`` is the explicit kill
#: switch (and the one-line retreat if the box runs short of memory).
PROVIDERS = frozenset({"onnx", "fake", "off"})


def embedder_from_settings(settings: Settings) -> Embedder | None:
    """The app's embedder, or ``None`` = search not available. Never raises, no I/O.

    ``OnnxEmbedder`` is CONSTRUCTED here and LOADED in the lifespan: a 0.3 s,
    510 MB step belongs where ``/health`` and the operator can see it, not inside
    ``create_app`` (which the whole pytest suite calls, and which has no running
    loop to offload it to).
    """
    provider = settings.embeddings_provider
    if provider == "onnx":
        return OnnxEmbedder(
            Path(settings.embeddings_model_dir),
            Path(settings.embeddings_manifest_path),
            threads=settings.embeddings_threads,
        )
    if provider == "fake":
        return FakeEmbedder()
    if provider != "off":
        logger.warning(
            "unknown EMBEDDINGS_PROVIDER %r — search stays off (expected one of %s)",
            provider,
            ", ".join(sorted(PROVIDERS)),
        )
    return None
