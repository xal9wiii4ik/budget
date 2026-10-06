"""web push: device subscriptions and the daily-digest claim

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-06

Two new tables for the web-push scope (architecture §1), nothing existing is
touched:

1. ``push_subscriptions`` — one row per browser device. ``endpoint`` is UNIQUE
   across ALL users (``uq_push_subscriptions_endpoint``): the subscribe UPSERT
   conflicts on it, which is how a device that changed hands is rebound. The
   ``lang`` CHECK is the same literal as ``profiles.language_valid``.
2. ``push_reminder_sends`` — the per-user-per-day claim of the digest job; the
   composite PK ``(user_id, sent_on)`` is the idempotency key two concurrent runs
   race on. Five SmallInteger counters, server-defaulted to 0 so the claim INSERT
   names only the key.

Pure DDL with a symmetric downgrade (the test conftest tears its schema down with
``downgrade base``). No backfill — a new feature has no history. No retention
either: a claim row is tens of bytes and nothing reads past today's date.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=False),
        sa.Column("auth", sa.Text(), nullable=False),
        sa.Column("lang", sa.String(length=2), nullable=False),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "lang IN ('ru', 'en')", name=op.f("ck_push_subscriptions_lang_valid")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_push_subscriptions_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_push_subscriptions")),
        sa.UniqueConstraint("endpoint", name=op.f("uq_push_subscriptions_endpoint")),
    )
    op.create_index(
        op.f("ix_push_subscriptions_user_id"),
        "push_subscriptions",
        ["user_id"],
        unique=False,
    )
    op.create_table(
        "push_reminder_sends",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("sent_on", sa.Date(), nullable=False),
        sa.Column(
            "goal_items", sa.SmallInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "charges", sa.SmallInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "deposits", sa.SmallInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "delivered", sa.SmallInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "removed", sa.SmallInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_push_reminder_sends_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "user_id", "sent_on", name=op.f("pk_push_reminder_sends")
        ),
    )


def downgrade() -> None:
    op.drop_table("push_reminder_sends")
    op.drop_index(
        op.f("ix_push_subscriptions_user_id"), table_name="push_subscriptions"
    )
    op.drop_table("push_subscriptions")
