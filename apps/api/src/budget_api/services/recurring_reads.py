"""The ONE definition of "charges the live templates still owe" (B4).

Moved verbatim out of ``routers/recurring.py:list_upcoming`` when the push digest
became its second reader (web-push architecture §4): the widget and the morning
reminder must agree on which charges are coming, so they share this function
rather than two copies of the loop. The router's docstring still describes the
semantics (it IS the OpenAPI text); this module owns the query.

Strictly read-only: the watermark is read, never written.
"""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.domain.recurrence import upcoming_due_dates
from budget_api.enums import RecurrenceUnit, TransactionKind
from budget_api.models import RecurringTemplate


@dataclass(frozen=True)
class UpcomingCharge:
    """One future occurrence of one template — ``UpcomingChargeRead``'s fields."""

    template_id: uuid.UUID
    name: str
    amount_minor: int
    currency: str
    kind: TransactionKind
    due_on: date
    account_id: uuid.UUID
    category_id: uuid.UUID | None


async def read_upcoming_charges(
    session: AsyncSession, user_id: uuid.UUID, *, today: date, through: date
) -> list[UpcomingCharge]:
    """Unmaterialized charges due in ``[today, through]``, by (due_on, created_at, id).

    Paused templates are excluded; the floor and the end-date clamp are
    ``upcoming_due_dates``' — the same helper ``next_due_on`` renders with.
    """
    templates = (
        await session.scalars(
            select(RecurringTemplate)
            .where(
                RecurringTemplate.user_id == user_id,
                RecurringTemplate.paused.is_(False),
            )
            .order_by(RecurringTemplate.created_at, RecurringTemplate.id)
        )
    ).all()
    # (due_on, creation rank) is the B5 sort key `(due_on, created_at, id)`: the
    # query already ordered the templates, so the rank carried alongside each row
    # supplies the tiebreak without re-reading either column.
    charges: list[tuple[date, int, UpcomingCharge]] = []
    for rank, template in enumerate(templates):
        for due_on in upcoming_due_dates(
            RecurrenceUnit(template.interval_unit),
            day_of_month=template.day_of_month,
            weekday=template.weekday,
            watermark=template.last_materialized_on,
            today=today,
            end_date=template.end_date,
            through=through,
        ):
            charges.append(
                (
                    due_on,
                    rank,
                    UpcomingCharge(
                        template_id=template.id,
                        name=template.name,
                        amount_minor=template.amount_minor,
                        currency=template.currency,
                        kind=TransactionKind(template.kind),
                        due_on=due_on,
                        account_id=template.account_id,
                        category_id=template.category_id,
                    ),
                )
            )
    charges.sort(key=lambda charge: (charge[0], charge[1]))
    return [charge for _, _, charge in charges]
