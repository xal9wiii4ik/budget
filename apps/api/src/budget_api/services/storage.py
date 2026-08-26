"""Object-storage seam — presigned S3/MinIO URLs (architecture D9).

Stateless and Settings-only: this module imports **no** ``models`` and touches
**no** database (D13 layering — this is the services-layer precedent). A ``Storage``
instance is constructed once per app onto ``app.state.storage`` and handed a
``Settings``; every method is pure local SigV4 computation with **no network I/O**,
so the presign calls are safe to invoke synchronously inside async handlers. The
actual byte I/O (HEAD/GET against the presigned URLs) is async httpx and lands in
the S3 parse pipeline, not here.

Content-Type is **advisory** everywhere in this module: minio-py's
``presigned_put_object`` takes no headers and signs ``SignedHeaders=host`` only, so
the ``Content-Type`` we hand back is a hint the client SHOULD send — MinIO will not
reject a PUT that omits or changes it. The real size gate is the parse-time HEAD
``Content-Length`` check (S3), never a signed content-type. See senior-lead V1.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse

from minio import Minio

from budget_api.config import Settings


@dataclass(frozen=True)
class PresignedRequest:
    """A presigned S3 request the client executes directly against storage.

    ``headers`` is advisory (see module docstring): for a PUT it carries
    ``{"Content-Type": "image/jpeg"}``, which the client SHOULD send but storage
    does not enforce (minio-py signs the host only, never the content-type).
    """

    url: str
    method: str
    headers: dict[str, str]
    expires_at: datetime  # tz-aware UTC


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Storage:
    """Presign facade over minio-py. Constructed from Settings, no DB, no models."""

    def __init__(self, settings: Settings) -> None:
        parsed = urlparse(settings.s3_endpoint_url)
        self._client = Minio(
            parsed.netloc,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
            secure=(parsed.scheme == "https"),
            region=settings.s3_region,
        )
        self._bucket = settings.s3_bucket
        self._put_ttl = settings.s3_presign_put_ttl_seconds
        self._get_ttl = settings.s3_presign_get_ttl_seconds

    def object_path(self, user_id: uuid.UUID, receipt_id: uuid.UUID) -> str:
        """Deterministic per-user object key; one object per receipt."""
        return f"{user_id}/{receipt_id}.jpg"

    def goal_item_file_path(self, user_id: uuid.UUID, file_id: uuid.UUID) -> str:
        """Key for a plan-node attachment (goal-planner §7); one object per row.

        Same bucket, its own ``goal-items/`` prefix — a second Storage class would
        buy nothing, and the prefix keeps the two lifecycles legible in the bucket
        (receipts are never deleted, these go with their node).
        """
        return f"{user_id}/goal-items/{file_id}.jpg"

    def presign_put(self, path: str) -> PresignedRequest:
        url = self._client.presigned_put_object(
            self._bucket, path, expires=timedelta(seconds=self._put_ttl)
        )
        # Content-Type is ADVISORY, not signed: minio-py cannot put it into the
        # SigV4 SignedHeaders (host-only), so this header is a client hint, never a
        # server-side gate. Do not claim enforcement here or in the schema.
        return PresignedRequest(
            url=url,
            method="PUT",
            headers={"Content-Type": "image/jpeg"},
            expires_at=_utcnow() + timedelta(seconds=self._put_ttl),
        )

    def presign_get(self, path: str) -> str:
        return self._client.presigned_get_object(
            self._bucket, path, expires=timedelta(seconds=self._get_ttl)
        )

    def presign_head(self, path: str) -> str:
        # Per-method presign: get_presigned_url signs the HEAD verb so the parse
        # pipeline can probe object existence + Content-Length without a GET.
        return self._client.get_presigned_url(
            "HEAD", self._bucket, path, expires=timedelta(seconds=self._get_ttl)
        )

    def presign_delete(self, path: str) -> str:
        """Signed DELETE for the attachment cleanup job (goal-planner §7).

        A presign, NOT ``Minio.remove_object``: that method is a blocking network
        call, and this module's whole contract is "no I/O here, safe to call from
        an async handler" (module docstring). The request itself is async httpx in
        the background task that owns the cleanup.
        """
        return self._client.get_presigned_url(
            "DELETE", self._bucket, path, expires=timedelta(seconds=self._get_ttl)
        )
