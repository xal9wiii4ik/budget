"""Best-effort removal of stored objects (goal-planner §7).

The DB is the truth: a plan-node attachment is gone the moment its row is gone,
and that row is deleted and COMMITTED before anything here runs. What is left is
disk hygiene, so this job is deliberately unable to fail the request that
scheduled it — an unreachable MinIO must not block a user from deleting their own
plan node, and the orphan it leaves behind is a leak of disk, not of data (the key
carries only UUIDs).

Lives in ``services/`` rather than in a router because TWO routers schedule it —
``goal_item_files`` (one file) and ``goal_items`` (a whole subtree's files) — and a
router may never import another router (the ``goal_item_access`` rule). It does the
byte I/O that ``services/storage.py`` deliberately does not: storage presigns, this
sends.
"""

import logging
from collections.abc import Sequence

import httpx

from budget_api.services.storage import Storage

logger = logging.getLogger(__name__)

_DELETE_TIMEOUT_SECONDS = 10.0


async def delete_objects(storage: Storage, paths: Sequence[str]) -> None:
    """Delete every object key in ``paths``. Never raises.

    One client for the batch (a subtree delete can carry many keys). Failures are
    logged by exception CLASS only — never ``repr``/``str`` and never the URL:
    httpx puts the failing request's URL into its exception message, and that URL
    is a live presigned credential for this user's object while it lasts.
    """
    if not paths:
        return
    try:
        async with httpx.AsyncClient() as http:
            for path in paths:
                try:
                    response = await http.delete(
                        storage.presign_delete(path), timeout=_DELETE_TIMEOUT_SECONDS
                    )
                except httpx.HTTPError as exc:
                    logger.warning(
                        "object cleanup failed for one key: %s", type(exc).__name__
                    )
                    continue
                # S3 answers 204 for both "deleted" and "was not there"; anything
                # else means the object may still exist. Logged without the key's
                # URL, for the same reason as above.
                if response.status_code not in (204, 200, 404):
                    logger.warning(
                        "object cleanup returned %s for one key", response.status_code
                    )
    except Exception as exc:
        # Guard of last resort: this runs AFTER the response is committed, so an
        # unexpected error here has nothing left to report to and must not escape
        # into the ASGI background runner.
        logger.warning("object cleanup crashed: %s", type(exc).__name__)
