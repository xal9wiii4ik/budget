"""``model_manifest.json`` — the ONE pin, read by the fetcher AND by ``load()``.

``scripts/fetch_model.py`` reads this file to know what to download; this module
reads the SAME file at boot to prove the downloaded bytes are still those bytes.
One source of truth for the pins means a revision bump is a one-line diff that
both halves pick up, and a tampered or truncated artifact is caught before the
first inference rather than after a few thousand nonsense vectors.

Stdlib only — no numpy, no onnxruntime: ``verify`` must be runnable (and
testable) without a runtime that can load a model.
"""

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from budget_api.embeddings.types import EmbedderLoadError

#: Streaming read size for the sha256 pass. 1 MiB keeps the 118 MB model off the
#: heap; the whole verify is ~0.2 s warm, once per process.
_CHUNK = 1024 * 1024


@dataclass(frozen=True)
class ManifestFile:
    #: Path inside the Hugging Face repo — what the fetcher downloads.
    hf_path: str
    #: Name on disk. Deliberately SHORTER than ``hf_path``: the model stamp is
    #: built from it and has to fit ``transaction_embeddings.model`` String(64)
    #: (ruling FLAG-1 — the HF spelling would be 67 characters).
    local_name: str
    sha256: str


@dataclass(frozen=True)
class Manifest:
    repo: str
    revision: str
    files: tuple[ManifestFile, ...]


def load_manifest(path: Path) -> Manifest:
    """Parse the manifest, or raise ``EmbedderLoadError`` naming the path.

    Every failure mode of a missing/garbled manifest funnels into the ONE error
    the lifespan already handles: the practical difference between "no model" and
    "no manifest" is nil — both mean search is not available on this server.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        files = tuple(
            ManifestFile(hf_path=hf_path, local_name=spec["as"], sha256=spec["sha256"])
            for hf_path, spec in raw["files"].items()
        )
        return Manifest(repo=raw["repo"], revision=raw["revision"], files=files)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise EmbedderLoadError(
            f"{path}: unreadable manifest ({type(exc).__name__})"
        ) from exc


def verify(model_dir: Path, manifest: Manifest) -> None:
    """sha256 every file of ``manifest`` in ``model_dir``. First failure wins.

    Raises ``EmbedderLoadError`` naming the FILE and what is wrong with it —
    missing, UNREADABLE, or the wrong bytes. Checking all four (not just the
    model) is the point: a swapped ``tokenizer.json`` would produce plausible
    vectors from the wrong token ids, which is the failure nobody would notice.

    Every failure leaves as ``EmbedderLoadError`` and never as an ``OSError``,
    because the lifespan catches only that one class (D-M4): ``is_file()`` is
    True for a file this process may not read (wrong owner on a dev stand, a
    bind-mount at 0600), and a ``PermissionError`` escaping here would be a boot
    traceback instead of "search is not available on this server".
    """
    for entry in manifest.files:
        target = model_dir / entry.local_name
        if not target.is_file():
            raise EmbedderLoadError(f"{target}: missing")
        digest = hashlib.sha256()
        try:
            with target.open("rb") as handle:
                while chunk := handle.read(_CHUNK):
                    digest.update(chunk)
        except OSError as exc:
            raise EmbedderLoadError(
                f"{target}: unreadable ({type(exc).__name__})"
            ) from exc
        got = digest.hexdigest()
        if got != entry.sha256:
            raise EmbedderLoadError(
                f"{target}: sha256 mismatch (expected {entry.sha256}, got {got})"
            )


def model_stamp(manifest: Manifest, local_name: str) -> str:
    """``intfloat/multilingual-e5-small@614241f/model.onnx`` — 49 chars (FLAG-1).

    Unique per (repo, revision, artifact), which is all the stamp is for: it
    decides whether a stored vector was produced by the model this process runs.
    """
    return f"{manifest.repo}@{manifest.revision[:7]}/{local_name}"


def config_values(model_dir: Path) -> Mapping[str, object]:
    """The artifact's own ``config.json`` — the pad token id the tokenizer needs.

    Read from the VERIFIED file rather than hardcoded, so a different artifact
    with a different vocabulary cannot be padded with the wrong id silently.
    """
    raw = (model_dir / "config.json").read_text(encoding="utf-8")
    parsed: Mapping[str, object] = json.loads(raw)
    return parsed
