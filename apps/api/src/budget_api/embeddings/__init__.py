"""The embedding seam: one Protocol, one real embedder, one fake, one registry.

Imports numpy, onnxruntime, tokenizers, ``config`` and stdlib — and nothing else
of the application. That import list is the guarantee that ``apps/api/evals/``
can drive an embedder with no FastAPI app and no database, exactly as ``llm/``
is driven (architecture §Module structure, dependency direction).

Read ``types.py`` first for the contract, then ``manifest.py``: the artifact is
PINNED by ``model_manifest.json``, fetched at BUILD time by
``scripts/fetch_model.py`` and only ever VERIFIED at runtime.
"""

from budget_api.embeddings.fake import FakeEmbedder
from budget_api.embeddings.manifest import (
    Manifest,
    ManifestFile,
    load_manifest,
    model_stamp,
    verify,
)
from budget_api.embeddings.onnx import MAX_LENGTH, OnnxEmbedder
from budget_api.embeddings.registry import PROVIDERS, embedder_from_settings
from budget_api.embeddings.types import Embedder, EmbedderLoadError, TextKind

__all__ = [
    "MAX_LENGTH",
    "PROVIDERS",
    "Embedder",
    "EmbedderLoadError",
    "FakeEmbedder",
    "Manifest",
    "ManifestFile",
    "OnnxEmbedder",
    "TextKind",
    "embedder_from_settings",
    "load_manifest",
    "model_stamp",
    "verify",
]
