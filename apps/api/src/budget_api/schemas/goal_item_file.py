"""Plan-node attachment schemas (goal-planner §7).

Own module rather than an appendix to ``goal_item.py``: attachments are their own
router and their own lifecycle (presign → confirm → delete), and the plan tree
carries only the two COUNTERS, never the files themselves (PM §8 — 500 nodes x 10
files would be up to 5000 presigns per render).

``PresignedUpload`` is imported from ``schemas/receipt.py`` rather than cloned: the
upload handshake is literally the same object (url + advisory Content-Type +
expiry), and a second identical component would give clients two names for one
thing. Cross-schema import is the ``goal.py`` → ``transaction.py`` precedent.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel

from budget_api.schemas.receipt import PresignedUpload


class GoalItemFileCreated(BaseModel):
    """POST response: the row (always unconfirmed) + where to PUT the bytes."""

    id: uuid.UUID
    #: Always ``false`` here. The row exists, the object does not yet — only the
    #: confirm route's HEAD probe may flip this.
    uploaded: bool
    upload: PresignedUpload
    created_at: datetime


class GoalItemFileRead(BaseModel):
    """One attachment as the list and the confirm route return it."""

    id: uuid.UUID
    uploaded: bool
    #: Presigned GET, minted per read and never stored — and ONLY for a confirmed
    #: object (the receipts ``_UPLOAD_PROVEN_STATUSES`` rule: a URL is handed out
    #: only for bytes the server has seen). Null while ``uploaded`` is false.
    view_url: str | None
    created_at: datetime


class GoalItemFileError(BaseModel):
    """404/409/422/503 error envelope — mirrors ``GoalItemError``."""

    detail: str
