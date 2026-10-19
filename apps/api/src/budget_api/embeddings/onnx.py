"""The real embedder: int8 multilingual-e5-small on ONNX Runtime, in-process.

No HTTP, no daemon, no torch: ``load()`` verifies the pinned artifact
(``manifest.py``) and builds ONE ``InferenceSession`` that lives as long as the
process. 118 MB of int8 weights at ~510 MB RSS and 3.7 ms per single text
(``evidence.md``) — cheap enough to re-embed the whole ledger in a background
sweep, which is what makes the pull index affordable.

Two decisions worth knowing before editing:

* **Construction does no I/O.** ``__init__`` only stores paths, exactly like
  every other ``app.state`` seam, so ``create_app`` cannot fail on a bad path
  and the lifespan owns the one slow step (``await asyncio.to_thread(load)``).
* **One lock around the session call.** ORT sessions ARE thread-safe; the lock is
  about the BOX, not correctness — with ``embeddings_threads = 1`` on 2 vCPU a
  32-row batch holds it ~150 ms, and letting four of those run at once would
  take both cores away from request handling.
"""

import logging
import threading
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime  # type: ignore
from numpy.typing import NDArray
from tokenizers import Tokenizer

from budget_api.embeddings.manifest import (
    config_values,
    load_manifest,
    model_stamp,
    verify,
)
from budget_api.embeddings.types import EmbedderLoadError, TextKind

logger = logging.getLogger(__name__)

#: ONNX Runtime ships NO type stubs and ``tokenizers`` only partial ones, so under
#: strict pyright every symbol of theirs reads as partially unknown. The seam is
#: declared ``Any`` HERE, once, instead of scattering ``# type: ignore`` over
#: every session line (the apscheduler-has-no-stubs situation in app.py, solved
#: the way a whole module can afford to): everything this file does with them —
#: three option fields, one session, one tokenizer, one ``run`` — is right below,
#: and its inputs and output ARE typed.
_ort: Any = onnxruntime

#: Token ceiling per text. A passage is merchant + note + four short fields
#: (``services/tx_text.py``), so 128 tokens is generous; e5's own 512 would only
#: make the sweep slower for padding nobody reads.
MAX_LENGTH = 128
#: The file the stamp and the session are built from — the manifest's LOCAL name.
_MODEL_FILE = "model.onnx"
_TOKENIZER_FILE = "tokenizer.json"
#: A property of e5, NOT of our text: the model was trained with asymmetric
#: prefixes and scores badly without them. Kept here so ``tx_text`` stays a
#: model-independent document.
_PREFIX: dict[TextKind, str] = {"query": "query: ", "passage": "passage: "}
#: Fallback pad id, used only if the artifact's ``config.json`` names none. The
#: value barely matters — ``attention_mask`` is 0 at every padded position, so
#: those positions reach neither attention nor the mean pooling — but feeding a
#: consistent (id, token) PAIR is what keeps ``encode_batch``'s tokens and ids
#: describing the same thing.
_FALLBACK_PAD_ID = 1


class OnnxEmbedder:
    """``Embedder`` over a local ONNX artifact. ``load()`` before ``embed()``."""

    name = "onnx"
    dim = 384

    def __init__(self, model_dir: Path, manifest_path: Path, *, threads: int) -> None:
        self._model_dir = model_dir
        self._manifest_path = manifest_path
        self._threads = threads
        self._lock = threading.Lock()
        self._session: Any = None
        self._tokenizer: Tokenizer | None = None
        self._input_names: frozenset[str] = frozenset()
        #: The stamp stored on every indexed row. EMPTY until ``load()`` has
        #: succeeded — and the DB CHECK ``model <> ''`` is what stops an
        #: unloaded embedder from writing rows that would look current forever.
        self.model = ""

    def load(self) -> None:
        """Verify → session → tokenizer → one warm call. Raises EmbedderLoadError.

        The verify step comes FIRST and reports its own precise reason (which file
        is missing or wrong). Everything after it is wrapped into one
        ``EmbedderLoadError`` carrying the exception CLASS and nothing else — the
        ``alfa_pdf.text_lines`` precedent: a narrow tuple here would be a list of
        ORT and tokenizers internals that moves with the library, and a boot-time
        traceback for "this box has no model" is noise in a server log.
        """
        manifest = load_manifest(self._manifest_path)
        verify(self._model_dir, manifest)
        try:
            options = _ort.SessionOptions()
            # Both set to the same figure, and the figure is a setting: on a
            # 2 vCPU box a single batch must not be allowed to take both cores
            # away from the request that is waiting behind it.
            options.intra_op_num_threads = self._threads
            options.inter_op_num_threads = self._threads
            options.graph_optimization_level = (
                _ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            )
            session = _ort.InferenceSession(
                str(self._model_dir / _MODEL_FILE),
                options,
                providers=["CPUExecutionProvider"],
            )
            tokenizer = Tokenizer.from_file(str(self._model_dir / _TOKENIZER_FILE))
            # The same stubs situation as ``_ort``, one library over: these two
            # configuration calls are ``**kwargs``-typed in the shipped stubs, so
            # they go through an Any alias instead of two ignores.
            configure: Any = tokenizer
            configure.enable_truncation(max_length=MAX_LENGTH)
            # Both halves come from the ARTIFACT (the verified config.json for the
            # id, the artifact's own vocabulary for the matching token), never
            # hardcoded: a different export with a different vocabulary would
            # otherwise be padded with an id that means something else in it.
            pad_id = int(
                config_values(self._model_dir).get(  # type: ignore[arg-type]
                    "pad_token_id", _FALLBACK_PAD_ID
                )
            )
            pad_token = tokenizer.id_to_token(pad_id) or "<pad>"
            configure.enable_padding(pad_id=pad_id, pad_token=pad_token)
            self._session = session
            self._tokenizer = tokenizer
            self._input_names = frozenset(item.name for item in session.get_inputs())
            self.model = model_stamp(manifest, _MODEL_FILE)
            # Warm-up: the first call pays ORT's lazy kernel initialisation
            # (~100 ms). Paid here, at boot, rather than inside whichever user's
            # request happens to be first.
            self.embed(["warmup"], kind="query")
        except Exception as exc:
            self._session = None
            self._tokenizer = None
            self.model = ""
            raise EmbedderLoadError(f"{self._model_dir}: {type(exc).__name__}") from exc
        logger.info(
            "embeddings loaded model=%s dim=%d threads=%d",
            self.model,
            self.dim,
            self._threads,
        )

    def embed(self, texts: Sequence[str], *, kind: TextKind) -> NDArray[np.float32]:
        """``(len(texts), 384)`` L2-normalised rows. Mean-pooled over the mask."""
        if not texts:
            # ORT refuses a zero-length batch, and an empty refresh batch is an
            # ordinary state (nothing stale). Shaped so a caller can stack it.
            return np.zeros((0, self.dim), dtype=np.float32)
        session = self._session
        tokenizer = self._tokenizer
        if session is None or tokenizer is None:
            raise EmbedderLoadError(f"{self._model_dir}: embed() before load()")

        prefix = _PREFIX[kind]
        with self._lock:
            encodings = tokenizer.encode_batch([prefix + text for text in texts])
            ids = np.array([enc.ids for enc in encodings], dtype=np.int64)
            mask = np.array([enc.attention_mask for enc in encodings], dtype=np.int64)
            feeds: dict[str, NDArray[Any]] = {
                "input_ids": ids,
                "attention_mask": mask,
            }
            if "token_type_ids" in self._input_names:
                # Fed ONLY when the session declares it: exports of the same model
                # differ here, and an undeclared input makes ORT raise
                # InvalidArgument on the first call — at which point the server
                # has already reported itself healthy.
                feeds["token_type_ids"] = np.zeros_like(ids)
            hidden: NDArray[np.float32] = session.run(None, feeds)[0]

        # Pooling is pure numpy over the output already in hand, so it runs
        # OUTSIDE the lock: it is the cheap half, and holding the session for it
        # would lengthen every other caller's wait for nothing.
        weights = mask.astype(np.float32)[:, :, None]
        pooled = (hidden * weights).sum(axis=1) / np.clip(
            weights.sum(axis=1), 1e-9, None
        )
        norms = np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None)
        return (pooled / norms).astype(np.float32)
