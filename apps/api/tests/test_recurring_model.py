"""Recurring-template schema contracts — real Postgres, real migrations, no mocks.

Pins the one genuinely-breakable piece of migration 0006's DDL: the
``anchor_matches_unit`` CHECK (D2). It is what makes an inconsistent unit/anchor
pair unrepresentable, and both ``domain/recurrence`` (which treats a missing
anchor as a programming error) and the materialization job rely on that. No
column-existence smoke tests and no ``category_limits`` DDL test: its composite PK
is exercised as the ON CONFLICT upsert target by the /limits tests, which is the
real failure mode.
"""

import uuid
from datetime import date

import pytest
from helpers import add_account
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import RecurringTemplate


async def _create_user(db_session: AsyncSession, email: str) -> uuid.UUID:
    """Insert a bare user via raw SQL (no register hook, so no profile side effect)."""
    user_id = uuid.uuid4()
    await db_session.execute(
        text(
            "INSERT INTO users (id, email, hashed_password) VALUES (:id, :email, :pw)"
        ),
        {"id": user_id, "email": email, "pw": "x"},
    )
    await db_session.commit()
    return user_id


def _monthly_template(
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    day_of_month: int | None,
    weekday: int | None,
) -> RecurringTemplate:
    return RecurringTemplate(
        user_id=user_id,
        account_id=account_id,
        name="Rent",
        amount_minor=100_000,
        kind="expense",
        currency="RUB",
        interval_unit="month",
        day_of_month=day_of_month,
        weekday=weekday,
        last_materialized_on=date(2026, 8, 17),
    )


class TestAnchorMatchesUnit:
    async def test_anchor_must_match_unit(self, db_session: AsyncSession) -> None:
        user_id = await _create_user(db_session, "anchor@x.com")
        account_id = (await add_account(db_session, user_id)).id
        # Committed, not merely flushed: each rejected arm below rolls the session
        # back, which would take an uncommitted account with it.
        await db_session.commit()

        # The OTHER unit's anchor does not satisfy a monthly template...
        db_session.add(
            _monthly_template(user_id, account_id, day_of_month=None, weekday=3),
        )
        with pytest.raises(
            IntegrityError, match="ck_recurring_templates_anchor_matches_unit"
        ):
            await db_session.commit()
        await db_session.rollback()

        # ...and neither does no anchor at all.
        db_session.add(
            _monthly_template(user_id, account_id, day_of_month=None, weekday=None)
        )
        with pytest.raises(
            IntegrityError, match="ck_recurring_templates_anchor_matches_unit"
        ):
            await db_session.commit()
        await db_session.rollback()

        # Accept contrast: without it both rejections would pass against a CHECK
        # of `false`.
        db_session.add(
            _monthly_template(user_id, account_id, day_of_month=15, weekday=None)
        )
        await db_session.commit()

        rows = (
            await db_session.scalars(
                select(RecurringTemplate).where(RecurringTemplate.user_id == user_id)
            )
        ).all()
        assert len(rows) == 1
        assert rows[0].day_of_month == 15
        assert rows[0].weekday is None
