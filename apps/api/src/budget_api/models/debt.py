"""Debt — the METADATA of a loan to or from a person, never a second ledger.

The money lives where all money in this app lives: on ``transactions`` rows
booked against an account. A debt movement IS one such row, marked with the link
trio ``debt_id``/``debt_role``/``debt_amount_minor`` (see
``models/transaction.py``), so balances, currency stamping, account history and
the statement matcher keep working with no new money code — and
``services/tx_totals.py`` stays the single place such rows are cut out of the
income/expense aggregates (debts architecture §"Proposed approach").

So this table deliberately stores NO money at all:

* there is no ``amount`` column — the principal IS the opening movement row
  (``debt_role='principal'``, at most one by partial unique index), and every
  partial repayment is another row (the ``deposits`` "no money on the metadata
  table" precedent);
* there is no ``remaining``, no ``closed`` and no ``closed_on`` — all three are
  arithmetic over the movements, computed on read by ``services/debt_reads.py``
  through ``domain/debts.py``. A stored flag would have to be recomputed by every
  movement write AND delete, and deleting a repayment must simply REOPEN the debt.

``direction`` and ``currency`` are IMMUTABLE (absent from ``DebtUpdate``):
``movement_kind`` derives each movement's ``kind`` from the direction, so a
direction that could change would retro-flip the sign of money already booked,
and the currency is what every stored ``debt_amount_minor`` is denominated in.
Correcting either is delete-and-redo — which is why ``DELETE /debts/{id}`` is a
real delete whose ``ON DELETE CASCADE`` takes the movements with it.

``counterparty`` is free text and deliberately NOT normalized or unique: the
person is not a Budget user, and two debts with one person are two debts.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import DebtDirection
from budget_api.models.base import Base

# Rebuilt from the shared enum so the enum is the single source for both model and
# schema (the models/deposit.py pattern). The rendered SQL MUST stay byte-identical
# to migration 0017; DebtDirection's definition order guarantees this.
_DIRECTION_VALUES = ", ".join(f"'{d.value}'" for d in DebtDirection)


class Debt(Base):
    __tablename__ = "debts"
    __table_args__ = (
        CheckConstraint(f"direction IN ({_DIRECTION_VALUES})", name="direction_valid"),
        # The same format-only rule every currency column in this schema carries
        # (transactions.currency_format): the picker restricts what is offered, the
        # column refuses what is malformed.
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    #: IMMUTABLE — see the module docstring.
    direction: Mapped[str] = mapped_column(String(8))
    #: The person, as the user named them. Free text: not a Budget user, not
    #: normalized, not unique.
    counterparty: Mapped[str] = mapped_column(String(100))
    #: The debt's ONE currency, explicit on create and IMMUTABLE afterwards. Every
    #: movement's ``debt_amount_minor`` is denominated in it, which is what lets
    #: ``remaining`` be an integer sum of a single column — the account a movement
    #: is booked on may be denominated in something else entirely.
    currency: Mapped[str] = mapped_column(String(3))
    #: "Give it back by" — nullable, and the ONLY thing the push digest reads a
    #: debt for (names only, never amounts).
    due_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
