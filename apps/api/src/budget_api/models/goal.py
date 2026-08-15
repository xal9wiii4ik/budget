"""Goal + GoalContribution models — one aggregate, one file (architecture D10).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
neither table serves a fastapi-users protocol.

There is deliberately NO ``saved_minor`` column: progress is
``SUM(goal_contributions.amount_minor)`` (D10 — a stored copy is an update anomaly
in money). Contribution amounts are SIGNED (withdrawals are negative rows) with a
``<> 0`` CHECK; the ``SUM >= 0`` per-goal invariant is a router-level guard, not a
DB constraint (it spans rows). "Completed" is derived (``saved >= target``), and
``priority`` carries no DB uniqueness — duplicates are tie-broken by ``created_at``
in the split math (D11).
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    false,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class Goal(Base):
    __tablename__ = "goals"
    __table_args__ = (
        # Naming convention turns name="target_minor_positive" into
        # ck_goals_target_minor_positive.
        CheckConstraint("target_minor > 0", name="target_minor_positive"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    target_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Lower = higher priority.
    priority: Mapped[int] = mapped_column()
    archived: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class GoalContribution(Base):
    __tablename__ = "goal_contributions"
    __table_args__ = (
        CheckConstraint("amount_minor <> 0", name="amount_minor_nonzero"),
        # Covers both the per-goal SUM and the "прогресс по месяцам" range scan.
        Index("ix_goal_contributions_goal_id_occurred_at", "goal_id", "occurred_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    goal_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("goals.id", ondelete="CASCADE")
    )
    # SIGNED: a withdrawal is a negative row (D10).
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    occurred_at: Mapped[date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
