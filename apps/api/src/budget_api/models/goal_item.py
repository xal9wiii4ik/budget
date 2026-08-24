"""GoalItem + GoalItemFile — the goal's plan tree and its attachments (§1/§7).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
neither table serves a fastapi-users protocol. Own module rather than an appendix
to ``goal.py``: the plan tree is its own aggregate (the models/account.py
precedent), and ``goal.py`` stays about the goal and its ledger.

``goal_id`` is denormalized onto EVERY node, not just the roots (§1): it is what
lets the user-scope join be one hop (``goal_items → goals``) instead of a
recursive climb, and — paired with ``UNIQUE (id, goal_id)`` — it is what makes the
composite parent FK below expressible.

The parent link is that COMPOSITE FK and nothing else (plan §0 U-1): there is
deliberately NO plain ``ForeignKey`` on ``parent_id``. Two FKs for one
relationship would mean two CASCADE paths for one delete, and the composite one
carries a guarantee the
plain one cannot — a parent is always in the SAME goal, enforced by Postgres
rather than by router goodwill.

What is NOT here: the cycle backstop. ``goal_items_no_cycle()`` and
``trg_goal_items_no_cycle`` are created by migration 0011 via ``op.execute`` —
a PL/pgSQL function is not expressible as a ``__table_args__`` entry (the
precedent runs the other way: the partial unique index of ``transactions`` IS
declared in the model because SQLAlchemy can render it). The router refuses a
cycle with 422 before the write; the trigger is what holds when two concurrent
re-parents each pass that check.
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
    ForeignKeyConstraint,
    Index,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    false,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class GoalItem(Base):
    __tablename__ = "goal_items"
    __table_args__ = (
        # Naming convention turns name="amount_minor_positive" into
        # ck_goal_items_amount_minor_positive.
        CheckConstraint(
            "amount_minor IS NULL OR amount_minor > 0", name="amount_minor_positive"
        ),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
        # >= 0, not > 0: an auto-computed conversion of a tiny amount can legally
        # quantize to 0 minor units (the transactions base-snapshot precedent —
        # only a USER-supplied override is ge=1, and that lives at the schema layer).
        CheckConstraint(
            "converted_minor IS NULL OR converted_minor >= 0",
            name="converted_minor_non_negative",
        ),
        CheckConstraint(
            "converted_currency ~ '^[A-Z]{3}$'", name="converted_currency_format"
        ),
        # The goal-currency snapshot pair: both set or both NULL, never half (the
        # ``base_snapshot_pair`` twin on transactions).
        CheckConstraint(
            "(converted_minor IS NULL) = (converted_currency IS NULL)",
            name="converted_pair",
        ),
        # A conversion of nothing is nothing: a grouping node without its own
        # amount can carry no snapshot of that amount.
        CheckConstraint(
            "converted_minor IS NULL OR amount_minor IS NOT NULL",
            name="converted_needs_amount",
        ),
        # Reminder INTENT, exactly one of two or none (§6): a fixed date stands
        # still, "N days before" rides the effective deadline. Storing both would
        # be two different requests in one row.
        CheckConstraint(
            "remind_days_before IS NULL OR remind_days_before >= 0",
            name="remind_days_before_non_negative",
        ),
        CheckConstraint(
            "NOT (remind_on IS NOT NULL AND remind_days_before IS NOT NULL)",
            name="remind_exactly_one_or_none",
        ),
        # The cheap first line against a cycle; the trigger from 0011 owns the
        # multi-row case, which no CHECK can see.
        CheckConstraint("parent_id <> id", name="parent_not_self"),
        # Required BY the composite FK below (Postgres needs a unique index on the
        # referenced columns), not a business rule of its own.
        UniqueConstraint("id", "goal_id"),
        ForeignKeyConstraint(
            ["parent_id", "goal_id"],
            ["goal_items.id", "goal_items.goal_id"],
            ondelete="CASCADE",
        ),
        Index("ix_goal_items_parent_id", "parent_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    goal_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("goals.id", ondelete="CASCADE"), index=True
    )
    # No ForeignKey of its own — see the module docstring (plan §0 U-1). NULL = a
    # root of the goal's plan.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: A JSON array of URL strings (booking link, hotel page). Count and length are
    #: capped at the schema layer, where every other user-input bound of this
    #: codebase lives.
    links: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    #: The node's OWN price — a guideline and a CEILING (task.md), never the number
    #: that rolls up. NULLABLE: a grouping node ("Accommodation") may have no price
    #: of its own at all.
    amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    #: Stamped from the GOAL when the client sends none (§1).
    currency: Mapped[str] = mapped_column(String(3))
    #: The same amount in the GOAL's currency — a write-time snapshot, or a user
    #: override which always wins (house invariant). NULL/NULL means "no rate
    #: existed", and the node is then counted as unconverted rather than summed.
    converted_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    converted_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    #: NULL means INHERITED (from the nearest ancestor with a date, else from the
    #: goal). Nothing is ever materialized into this column: a written-out date
    #: would survive the goal being moved and start lying (task.md).
    deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    remind_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    remind_days_before: Mapped[int | None] = mapped_column(nullable=True)
    #: Order among SIBLINGS, step 1024 (§10b). Server-owned: the client asks for
    #: "up"/"down" and never writes this number.
    sort_order: Mapped[int] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class GoalItemFile(Base):
    """An image attached to a node. Table only in B1 — the routes land in B3.

    Deliberately NOT ``receipts``: that table carries an OCR lifecycle
    (status/parsed_json/error/claim token) and the rule "a file is never deleted",
    while a booking photo is PART of the node and goes with it (task.md §Вложения).
    """

    __tablename__ = "goal_item_files"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    goal_item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("goal_items.id", ondelete="CASCADE"), index=True
    )
    #: Denormalized owner: the presign path is keyed by user, and a file read must
    #: not have to climb item → goal to learn whose bytes these are.
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    storage_path: Mapped[str] = mapped_column(String(255))
    #: Proof that bytes actually landed (the receipts ``_UPLOAD_PROVEN_STATUSES``
    #: rule): a view URL is minted only for a confirmed object.
    uploaded: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
