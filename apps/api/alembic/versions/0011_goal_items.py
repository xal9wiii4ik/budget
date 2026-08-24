"""goal plan items: the tree, its files, the plan columns and the payment link

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-24

ALL DDL for the goal-planner backend core in one migration (the 0008 precedent),
in five blocks:

1. ``goal_items`` (§1) — the self-referencing tree. ``goal_id`` is denormalized
   onto every node; the parent link is the COMPOSITE FK
   ``(parent_id, goal_id) → (id, goal_id)`` and NOTHING else (plan §0 U-1), which
   needs the ``UNIQUE (id, goal_id)`` next to it and buys the guarantee "a parent
   is always in the same goal" from Postgres.
2. ``goal_items_no_cycle()`` + ``trg_goal_items_no_cycle`` (§2) — the cross-row
   invariant no CHECK can see. Raised as ``check_violation`` so the router can map
   the loser of a concurrent re-parent to the SAME 422 the pre-write check emits.
3. ``goal_item_files`` (§7) — the table only; its routes land in subtask 3.
4. ``goals.initial_budget_minor`` / ``goals.final_cost_override_minor`` (§5).
5. ``transactions.goal_item_id`` (§3) + the expense-only CHECK + a PARTIAL index.

NO backfill of any kind: existing goals get no items retroactively (task.md), and
``target_minor`` is untouched, so a goal without items keeps behaving exactly as
it does today. The two new goals columns and the transactions column are all
nullable with no server_default for that reason.

``ON DELETE SET NULL`` on ``transactions.goal_item_id`` is load-bearing and is the
whole cascade story of the scope: deleting a node cascades over its SUBTREE of
nodes and merely UNLINKS the payments attached to it. A transaction is never
deleted by anything here.

Pure DDL with a fully symmetric downgrade (the test conftest tears its schema down
with ``downgrade base``) — the trigger and the function are dropped there too, or a
second ``upgrade head`` on the same database would fail on ``CREATE FUNCTION``.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


#: §2 verbatim. ``pg_advisory_xact_lock`` on the GOAL is what makes the check
#: correct under concurrency: without it two simultaneous re-parents (A under B,
#: B under A) each read a state in which the other has not committed yet, both
#: pass, and the pair detaches from the tree into a closed loop.
_CREATE_CYCLE_TRIGGER = """
CREATE FUNCTION goal_items_no_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.goal_id::text, 0));
  IF EXISTS (
      WITH RECURSIVE anc AS (
          SELECT id, parent_id FROM goal_items WHERE id = NEW.parent_id
          UNION ALL
          SELECT gi.id, gi.parent_id
          FROM goal_items gi JOIN anc ON gi.id = anc.parent_id)
      SELECT 1 FROM anc WHERE id = NEW.id)
  THEN RAISE EXCEPTION 'goal_items cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
"""

_ATTACH_CYCLE_TRIGGER = """
CREATE TRIGGER trg_goal_items_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON goal_items
  FOR EACH ROW EXECUTE FUNCTION goal_items_no_cycle();
"""


def upgrade() -> None:
    op.create_table(
        "goal_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("goal_id", sa.Uuid(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "links",
            sa.dialects.postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("amount_minor", sa.BigInteger(), nullable=True),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("converted_minor", sa.BigInteger(), nullable=True),
        sa.Column("converted_currency", sa.String(length=3), nullable=True),
        sa.Column("deadline", sa.Date(), nullable=True),
        sa.Column("remind_on", sa.Date(), nullable=True),
        sa.Column("remind_days_before", sa.Integer(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "amount_minor IS NULL OR amount_minor > 0",
            name=op.f("ck_goal_items_amount_minor_positive"),
        ),
        sa.CheckConstraint(
            "currency ~ '^[A-Z]{3}$'", name=op.f("ck_goal_items_currency_format")
        ),
        sa.CheckConstraint(
            "converted_minor IS NULL OR converted_minor >= 0",
            name=op.f("ck_goal_items_converted_minor_non_negative"),
        ),
        sa.CheckConstraint(
            "converted_currency ~ '^[A-Z]{3}$'",
            name=op.f("ck_goal_items_converted_currency_format"),
        ),
        sa.CheckConstraint(
            "(converted_minor IS NULL) = (converted_currency IS NULL)",
            name=op.f("ck_goal_items_converted_pair"),
        ),
        sa.CheckConstraint(
            "converted_minor IS NULL OR amount_minor IS NOT NULL",
            name=op.f("ck_goal_items_converted_needs_amount"),
        ),
        sa.CheckConstraint(
            "remind_days_before IS NULL OR remind_days_before >= 0",
            name=op.f("ck_goal_items_remind_days_before_non_negative"),
        ),
        sa.CheckConstraint(
            "NOT (remind_on IS NOT NULL AND remind_days_before IS NOT NULL)",
            name=op.f("ck_goal_items_remind_exactly_one_or_none"),
        ),
        sa.CheckConstraint(
            "parent_id <> id", name=op.f("ck_goal_items_parent_not_self")
        ),
        sa.ForeignKeyConstraint(
            ["goal_id"],
            ["goals.id"],
            name=op.f("fk_goal_items_goals_goal_id"),
            ondelete="CASCADE",
        ),
        # plan §0 U-1: the ONLY parent link. No plain FK on parent_id exists, so
        # there is exactly one cascade path from a node to its children.
        sa.ForeignKeyConstraint(
            ["parent_id", "goal_id"],
            ["goal_items.id", "goal_items.goal_id"],
            name=op.f("fk_goal_items_goal_items_parent_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goal_items")),
        sa.UniqueConstraint("id", "goal_id", name=op.f("uq_goal_items_id")),
    )
    op.create_index(
        op.f("ix_goal_items_goal_id"), "goal_items", ["goal_id"], unique=False
    )
    op.create_index(
        "ix_goal_items_parent_id", "goal_items", ["parent_id"], unique=False
    )

    op.execute(_CREATE_CYCLE_TRIGGER)
    op.execute(_ATTACH_CYCLE_TRIGGER)

    op.create_table(
        "goal_item_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("goal_item_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("storage_path", sa.String(length=255), nullable=False),
        sa.Column(
            "uploaded", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["goal_item_id"],
            ["goal_items.id"],
            name=op.f("fk_goal_item_files_goal_items_goal_item_id"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_goal_item_files_users_user_id"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goal_item_files")),
    )
    op.create_index(
        op.f("ix_goal_item_files_goal_item_id"),
        "goal_item_files",
        ["goal_item_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_goal_item_files_user_id"),
        "goal_item_files",
        ["user_id"],
        unique=False,
    )

    op.add_column(
        "goals", sa.Column("initial_budget_minor", sa.BigInteger(), nullable=True)
    )
    op.add_column(
        "goals", sa.Column("final_cost_override_minor", sa.BigInteger(), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_goals_initial_budget_minor_positive"),
        "goals",
        "initial_budget_minor IS NULL OR initial_budget_minor > 0",
    )
    op.create_check_constraint(
        op.f("ck_goals_final_cost_override_minor_positive"),
        "goals",
        "final_cost_override_minor IS NULL OR final_cost_override_minor > 0",
    )

    op.add_column("transactions", sa.Column("goal_item_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_transactions_goal_items_goal_item_id"),
        "transactions",
        "goal_items",
        ["goal_item_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        op.f("ck_transactions_goal_item_expense_only"),
        "transactions",
        "goal_item_id IS NULL OR kind = 'expense'",
    )
    op.create_index(
        "ix_transactions_goal_item_id",
        "transactions",
        ["goal_item_id"],
        unique=False,
        postgresql_where=sa.text("goal_item_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_transactions_goal_item_id", table_name="transactions")
    op.drop_constraint(
        op.f("ck_transactions_goal_item_expense_only"), "transactions", type_="check"
    )
    op.drop_constraint(
        op.f("fk_transactions_goal_items_goal_item_id"),
        "transactions",
        type_="foreignkey",
    )
    op.drop_column("transactions", "goal_item_id")

    op.drop_constraint(
        op.f("ck_goals_final_cost_override_minor_positive"), "goals", type_="check"
    )
    op.drop_constraint(
        op.f("ck_goals_initial_budget_minor_positive"), "goals", type_="check"
    )
    op.drop_column("goals", "final_cost_override_minor")
    op.drop_column("goals", "initial_budget_minor")

    op.drop_index(op.f("ix_goal_item_files_user_id"), table_name="goal_item_files")
    op.drop_index(op.f("ix_goal_item_files_goal_item_id"), table_name="goal_item_files")
    op.drop_table("goal_item_files")

    # The trigger goes with its table, but the FUNCTION is schema-level and would
    # survive it: a second `upgrade head` on the same database then dies on
    # CREATE FUNCTION. The suite tears down with `downgrade base` and runs twice on
    # the same Postgres, so this line is what keeps the second run green.
    op.execute("DROP TRIGGER IF EXISTS trg_goal_items_no_cycle ON goal_items")
    op.execute("DROP FUNCTION IF EXISTS goal_items_no_cycle()")

    op.drop_index("ix_goal_items_parent_id", table_name="goal_items")
    op.drop_index(op.f("ix_goal_items_goal_id"), table_name="goal_items")
    op.drop_table("goal_items")
