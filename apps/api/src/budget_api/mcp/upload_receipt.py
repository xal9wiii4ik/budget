"""The one tool that is NOT generated from the contract.

Every other tool is a thin wrapper over a single API call, built from the
contract. Uploading a receipt is three steps — create the row, PUT the bytes
straight to object storage, read the result back — and, crucially, it touches the
local filesystem. That is why it is written by hand instead of being a marker on a
route (``POST /receipts`` and ``GET /receipts/{receipt_id}`` are
``@pat_reachable``: reachable by the token this server carries, but not tools).

WHY A PATH AND NOT THE BYTES. This server is a LOCAL process on the user's
machine — it can read the file itself, and the model never sees a single byte. It
sends a path and gets an id back.

WHY THE PATH IS FENCED. A tool that opens an arbitrary path is a new attack
surface: the server runs as the user, so it can read whatever the user can, and a
model that is confused — or that picked up an instruction from someone else's
document — could hand over ``~/.ssh/id_rsa`` just as easily as a receipt. Three
gates below, in order of how much they can be lied to:

1. the tool does not exist unless BUDGET_UPLOAD_DIR is configured, so the default
   posture is "no filesystem access at all";
2. the resolved REAL path must sit inside that directory — resolved, so a symlink
   pointing outside is caught rather than followed;
3. the CONTENT must be a JPEG. Extensions are trivially forged; the magic bytes
   are what the file actually is.

Filesystem calls go through ``anyio.to_thread`` — this module runs inside the
stdio server's event loop, and a blocking read of a 10 MB file would stall the
JSON-RPC stream it shares with every other call.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import anyio.to_thread
import httpx

from budget_api.mcp.http import (
    ApiConfig,
    ConfigError,
    Err,
    Ok,
    describe_api_error,
)
from budget_api.mcp.tools import JsonObject, as_object

#: The API stores one object per receipt as `.jpg` and advertises image/jpeg.
_JPEG_MEDIA_TYPE = "image/jpeg"

#: 10 MB. Large enough for any phone photo of a receipt, small enough that a
#: mistaken path (a disk image, a database dump) is refused rather than pushed
#: into object storage.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

#: The storage PUT is the one call that may carry megabytes, so it gets its own,
#: longer budget than the 30 s of an ordinary API call.
_STORAGE_TIMEOUT_SECONDS = 60.0

UPLOAD_TOOL_NAME = "upload_receipt"

UPLOAD_TOOL_DESCRIPTION = (
    "Upload a receipt image (JPEG) from a local file and return its receipt id. The "
    "file is read by this server and sent straight to storage — the image never "
    "passes through the conversation. Use the returned id as `receipt_id` when "
    "creating or updating a transaction, which is what attaches the photo to a "
    "spend. This tool does NOT read the receipt: extracting a total or a merchant "
    "from the image happens in the app, not here, so do not claim to have read what "
    "it says. Only JPEG is accepted, because that is the single format the receipt "
    "storage keeps."
)

UPLOAD_TOOL_INPUT_SCHEMA: JsonObject = {
    "type": "object",
    "properties": {
        "path": {
            "type": "string",
            "description": (
                "Path to a JPEG file the USER pointed at — a photo or screenshot "
                "of a receipt. Take it from what the user actually said; never "
                "guess a path, never walk the filesystem looking for one. "
                "Relative paths resolve inside the allowed upload folder."
            ),
        },
    },
    "required": ["path"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class UploadConfig:
    """The fence. ``directory`` is absolute and symlink-resolved; None = no tool."""

    directory: Path | None


async def read_upload_config(env: Mapping[str, str]) -> UploadConfig:
    raw = (env.get("BUDGET_UPLOAD_DIR") or "").strip()
    if not raw:
        return UploadConfig(directory=None)
    if not os.path.isabs(raw):
        raise ConfigError(
            f'BUDGET_UPLOAD_DIR must be an absolute path, got "{raw}". A relative '
            "path would depend on where the client happened to launch this server."
        )
    # Resolve the directory ONCE at startup so every later containment check
    # compares two real paths. Without this, a symlinked upload dir would make
    # every legitimate file look like it is outside the fence.
    resolved = await anyio.to_thread.run_sync(_realpath, Path(raw))
    if resolved is None:
        raise ConfigError(f'BUDGET_UPLOAD_DIR points at "{raw}", which does not exist.')
    return UploadConfig(directory=resolved)


def _realpath(path: Path) -> Path | None:
    try:
        return path.resolve(strict=True)
    except OSError:
        return None


def is_jpeg(data: bytes) -> bool:
    """JPEG starts FF D8 FF; nothing else this server accepts does."""
    return len(data) >= 3 and data[:3] == b"\xff\xd8\xff"


def is_inside(directory: Path, candidate: Path) -> bool:
    """True when ``candidate`` is the directory itself or sits underneath it.

    The separator matters: without it ``/home/user/uploads-evil`` passes a naive
    prefix check against ``/home/user/uploads``.
    """
    fence = str(directory)
    target = str(candidate)
    return target == fence or target.startswith(fence.rstrip(os.sep) + os.sep)


async def resolve_upload_path(directory: Path, raw: str) -> Path | Err:
    """Resolve the model's path against the fence.

    Returns a message the assistant can read out loud rather than raising: a
    refused path is a normal answer ("that file is outside the folder you
    allowed"), not a server fault.
    """
    requested = Path(raw) if os.path.isabs(raw) else directory / raw
    # resolve() collapses `..` AND follows symlinks, so both escape routes end up
    # compared against the fence rather than against the string the model supplied.
    real = await anyio.to_thread.run_sync(_realpath, requested)
    if real is None:
        return Err(f'No file at "{raw}".')
    if not is_inside(directory, real):
        return Err(
            f'"{raw}" resolves outside the allowed upload folder ({directory}). '
            "Move the file there, or ask the user to widen BUDGET_UPLOAD_DIR."
        )
    return real


def _read_file(path: Path) -> bytes:
    return path.read_bytes()


def _file_size(path: Path) -> int | None:
    """The size of a regular file, or None when the path is not one."""
    stat = path.stat()
    return stat.st_size if path.is_file() else None


async def _fetch_json(
    client: httpx.AsyncClient, config: ApiConfig, method: str, path: str
) -> Ok | Err:
    """The two API calls of this flow — same wording as the generated tools use."""
    try:
        response = await client.request(
            method,
            f"{config.base_url}{path}",
            headers={
                "Authorization": f"Bearer {config.token}",
                "Accept": "application/json",
            },
            timeout=30.0,
        )
    except httpx.HTTPError as error:
        return Err(f"The Budget API at {config.base_url} did not answer: {error}")

    text = response.text
    # `is_success` (2xx), not `is_error` (4xx/5xx): the client does not follow
    # redirects, so a 3xx would otherwise read as a success with no JSON behind it.
    if not response.is_success:
        return Err(describe_api_error(response.status_code, text))
    try:
        return Ok(response.json())
    except ValueError:
        return Err("The Budget API returned a body that is not JSON.")


def _created_receipt(data: Any) -> tuple[str, str, JsonObject] | None:
    """``{id, upload: {url, headers}}`` — or None when the API said something else."""
    row = as_object(data)
    if row is None:
        return None
    upload = as_object(row.get("upload"))
    receipt_id = row.get("id")
    url = upload.get("url") if upload is not None else None
    if not isinstance(receipt_id, str) or not isinstance(url, str):
        return None
    headers = as_object(upload.get("headers")) if upload is not None else None
    return receipt_id, url, headers or {}


async def upload_receipt(
    client: httpx.AsyncClient,
    config: ApiConfig,
    upload: UploadConfig,
    raw_path: Any,
) -> Ok | Err:
    """Create the receipt row, push the bytes, hand back what the API says of it.

    The order is the API's own: the row is durable before a URL is signed, so a
    failed PUT leaves a ``pending`` receipt rather than a signed URL with nothing
    behind it. A pending receipt attached to nothing is harmless — which is why
    this flow needs no retry bookkeeping.
    """
    if upload.directory is None:
        return Err(
            "Receipt upload is switched off: BUDGET_UPLOAD_DIR is not set. The user "
            "has to name a folder this server may read from before files can be "
            "uploaded."
        )
    if not isinstance(raw_path, str) or raw_path.strip() == "":
        return Err("Give the path to a JPEG file.")

    resolved = await resolve_upload_path(upload.directory, raw_path.strip())
    if isinstance(resolved, Err):
        return resolved

    size = await anyio.to_thread.run_sync(_file_size, resolved)
    if size is None:
        return Err(f'"{raw_path}" is not a file.')
    if size > MAX_UPLOAD_BYTES:
        megabytes = size / (1024 * 1024)
        cap = MAX_UPLOAD_BYTES // (1024 * 1024)
        return Err(f"That file is {megabytes:.1f} MB; receipts are capped at {cap} MB.")

    data = await anyio.to_thread.run_sync(_read_file, resolved)
    if not is_jpeg(data):
        return Err(
            f'"{raw_path}" is not a JPEG (checked its contents, not its name). '
            "Save the photo as JPEG and try again."
        )

    created = await _fetch_json(client, config, "POST", "/receipts")
    if isinstance(created, Err):
        return created
    receipt = _created_receipt(created.data)
    if receipt is None:
        return Err("The API did not return an upload target for this receipt.")
    receipt_id, url, headers = receipt

    # Content-Type here is advisory — the presigned signature covers the host only
    # (services/storage.py) — but sending what the API advertised keeps the stored
    # object honest about itself.
    content_type = headers.get("Content-Type")
    try:
        put = await client.put(
            url,
            content=data,
            headers={
                "Content-Type": content_type
                if isinstance(content_type, str)
                else _JPEG_MEDIA_TYPE
            },
            timeout=_STORAGE_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as error:
        return Err(f"Could not upload the image to storage: {error}")
    # Only a 2xx means the object is in storage. `is_error` would wave a 3xx
    # through — the TS server checked `response.ok` (2xx) here for that reason —
    # and the assistant would then report an upload that never landed while the
    # receipt_id goes on to be attached to a transaction.
    if not put.is_success:
        return Err(
            f"Storage refused the upload (HTTP {put.status_code}). The receipt row "
            "exists but has no image."
        )

    # Read the row back so the assistant reports what the server knows, not what
    # this function hopes happened.
    read = await _fetch_json(client, config, "GET", f"/receipts/{receipt_id}")
    return read if isinstance(read, Ok) else Ok({"id": receipt_id})
