"""Fetch the pinned embedding artifact named by ``model_manifest.json``.

Run at BUILD time (the ``model`` stage of the Dockerfile) and ONCE by hand on a
dev or QA stand — never at request time and never from the running API: the
server's only relationship with the artifact is to VERIFY it (``embeddings/
manifest.py``), against this same manifest file.

Stdlib only (``argparse``, ``hashlib``, ``http.client``, ``json``, ``os``,
``pathlib``, ``sys``, ``urllib``) on purpose: the Docker stage that runs it is a bare
``python:3.12-slim`` with no venv, and the fetch must not drag a dependency tree
(``huggingface_hub`` and ``requests``) into a layer whose only output is four
files. No token, no login — the repository is public.

Idempotent by construction: a file already present with the right sha256 is
SKIPPED, so a rebuild that did not change the pins re-downloads nothing and a
second manual run on a stand prints four skips and exits 0.

Always run it as ``python -I fetch_model.py …``: isolated mode keeps the
script's own directory off ``sys.path``, so a stray ``json.py`` beside it can
never shadow a stdlib import.
"""

import argparse
import hashlib
import http.client
import json
import os
import sys
import urllib.request
from pathlib import Path

#: Hugging Face's resolve endpoint, pinned to a REVISION rather than a branch:
#: ``main`` moving under us would change the bytes without changing the manifest.
_URL = "https://huggingface.co/{repo}/resolve/{revision}/{path}"
#: Read size for both hashing and streaming. 1 MiB keeps a 118 MB model to ~118
#: iterations without holding it in memory.
_CHUNK = 1024 * 1024


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _fetch_one(url: str, target: Path, expected: str, timeout: float) -> str:
    """Download ``url`` to ``target`` unless it is already there and intact.

    Returns ``"cached"`` or ``"downloaded"``; raises ``ValueError`` on a hash
    mismatch and lets ``urllib``'s own errors out — :func:`main` turns both into
    one stderr line and exit code 2.
    """
    if target.exists() and _sha256(target) == expected:
        return "cached"

    # Hashed as it is written, into a sibling part file: the final name appears
    # only once the bytes are proven, and ``os.replace`` on the same filesystem
    # is atomic, so an interrupted run can never leave a half file that the next
    # run (or the API's verify step) would read as the artifact.
    part = target.with_name(f".{target.name}.part")
    digest = hashlib.sha256()
    try:
        with (
            urllib.request.urlopen(url, timeout=timeout) as response,
            part.open("wb") as handle,
        ):
            while chunk := response.read(_CHUNK):
                digest.update(chunk)
                handle.write(chunk)
        got = digest.hexdigest()
        if got != expected:
            raise ValueError(f"sha256 mismatch (expected {expected}, got {got})")
        os.replace(part, target)
    finally:
        part.unlink(missing_ok=True)
    return "downloaded"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="path to model_manifest.json")
    parser.add_argument("--dest", required=True, help="directory to fetch into")
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args(argv)

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    repo: str = manifest["repo"]
    revision: str = manifest["revision"]
    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    for hf_path, spec in manifest["files"].items():
        local_name: str = spec["as"]
        target = dest / local_name
        url = _URL.format(repo=repo, revision=revision, path=hf_path)
        try:
            outcome = _fetch_one(url, target, spec["sha256"], args.timeout)
        except ValueError as exc:
            print(f"{local_name}: {exc}", file=sys.stderr)
            return 2
        except (OSError, http.client.HTTPException) as exc:
            # ONE catch covering every transport failure: ``urllib``'s own
            # ``URLError``/``HTTPError`` and ``TimeoutError`` are all OSError
            # subclasses, as is a dest directory that cannot be written. The
            # second class is there because ``http.client``'s are NOT: a CDN that
            # drops the connection mid-body raises ``IncompleteRead``, which would
            # otherwise be the one fetch failure with a traceback. One line, no
            # traceback: in a Docker build log the useful fact is WHICH file could
            # not be fetched and why, not this script's frames.
            print(f"{local_name}: fetch failed ({exc})", file=sys.stderr)
            return 2
        print(f"{local_name}: {outcome} ({target})")

    print(f"{repo}@{revision[:7]} verified in {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
