"""PatAuditLog model — one append-only row per PAT-authenticated call (5.6 §6).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split
(the ``category_limit.py`` precedent).

What is deliberately NOT stored: request and response BODIES, and query strings.
``path`` is the ROUTE TEMPLATE (``route.path_format``), so an audit row can never
become a second copy of the user's money data — it answers "what did this token do
and when", nothing else. Volume is bounded by the per-token rate limits themselves
(<=80 rows/min worst case); retention is a manual SQL prune until the HTTP phase.

``user_id`` is denormalized (no FK): the read "everything this user's tokens did"
must not need a JOIN, and the row is already deleted with its token when the user
goes away (``token_id`` cascades, and the token cascades from ``users``).

ONE composite index ``(token_id, occurred_at)`` — "what did this token do, newest
first" is the only query v1 has (architecture §6); a second index on ``user_id``
would be write cost with no reader.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    SmallInteger,
    String,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class PatAuditLog(Base):
    __tablename__ = "pat_audit_log"
    __table_args__ = (Index("ix_pat_audit_token_time", "token_id", "occurred_at"),)

    #: Identity (not uuid4): an append-only log wants the compact, ordered key.
    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    token_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("personal_access_tokens.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    method: Mapped[str] = mapped_column(String(8))
    #: Route TEMPLATE, e.g. ``/transactions/{transaction_id}`` — never the raw URL.
    path: Mapped[str] = mapped_column(String(200))
    status_code: Mapped[int] = mapped_column(SmallInteger)
    #: The entity a write touched: the path parameter for PATCH/PUT/DELETE (a 204
    #: has no body at all), the response ``id`` for a 2xx POST. Null for reads and
    #: for writes that never named an entity.
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
