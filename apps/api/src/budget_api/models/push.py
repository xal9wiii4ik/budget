"""Web push: the browser devices a user enabled, and the daily-digest claim (§1).

Two tables, one module — they exist only for each other:

* ``push_subscriptions`` — one row per browser device. ``endpoint`` is UNIQUE
  GLOBALLY, not per user, by design: a device that changed hands re-POSTs the same
  endpoint, and the subscribe UPSERT moves ``user_id`` — the rebind IS the
  conflict arm (``routers/push.py``). ``p256dh``/``auth`` are the browser's
  opaque base64url keys; ``user_agent`` is support-only (the one way to tell two
  rows apart when reading the table by hand).
* ``push_reminder_sends`` — the per-user-per-day CLAIM, the job's idempotency
  unit (``services/push_jobs.py``). The product rule is ONE notification per user
  per day, so "already done" is a day, not an item. The six counters are plain
  ints rather than jsonb: queryable by support, no shape to drift. No retention
  job — a row is tens of bytes and the job only ever touches today's date.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    SmallInteger,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    __table_args__ = (
        # The same two-value enumeration as ``profiles.language_valid``: the digest
        # is rendered in this language when the profile has none.
        CheckConstraint("lang IN ('ru', 'en')", name="lang_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    #: Push endpoints run ~200-400 characters, far under the btree limit — no cap.
    endpoint: Mapped[str] = mapped_column(Text, unique=True)
    p256dh: Mapped[str] = mapped_column(Text)
    auth: Mapped[str] = mapped_column(Text)
    lang: Mapped[str] = mapped_column(String(2))
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: Rewritten by the subscribe UPSERT (a re-POST, a rebind, a key rotation).
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class PushReminderSend(Base):
    __tablename__ = "push_reminder_sends"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    #: The UTC run date. The composite PK (user_id, sent_on) IS the claim: two
    #: concurrent runs race on it and exactly one INSERT wins.
    sent_on: Mapped[date] = mapped_column(Date, primary_key=True)
    # What the run found and what it did — written AFTER the sends; zeros when
    # nothing was due (the claim is taken regardless).
    goal_items: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    charges: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    deposits: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    #: The fourth family (debts scope): OPEN debts whose ``due_on`` falls inside
    #: the window. Appended after the three above, never interleaved — support
    #: reads these columns by name, and the digest spells the families in this
    #: same order.
    debts: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    delivered: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    removed: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
