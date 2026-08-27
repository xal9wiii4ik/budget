"""Deposit — the METADATA of a term deposit, never a second wallet (§Tables).

The money itself lives where all money in this app lives: on an ``accounts`` row
of type ``deposit``, 1:1 with this one, moved only by ordinary transfers. That is
the whole point of the design (deposits architecture §"Вердикт по гипотезе") —
balances, currency stamping, history and the transfer CHECKs of 0008 keep working
with no new money code, and ``tx_totals.py`` stays the single place transfers are
cut out of aggregates.

So this table deliberately stores NO money except the manual anchor:

* there is no ``currency`` column — the linked account's currency is the single
  source, and a copy here could only ever disagree with the row that stamps every
  transaction;
* there is no ``principal`` column — the opening body is the account's
  ``starting_balance_minor`` (AMENDMENT §1: a setup fact, exactly like an ordinary
  account's, instead of a back-dated transfer that would restate the balance of
  the account it came from), and every later top-up or withdrawal is a transfer;
* there is no stored ``accrued`` — interest is computed on read by
  ``domain/deposits.py`` (the computed-balance precedent). The ONLY stored number
  about interest is the user's manual correction, ``accrued_override_minor`` with
  the date it was taken on, and the forecast CONTINUES from that anchor.

``account_id`` is UNIQUE with ``ondelete="RESTRICT"``: the 1:1 is a database fact,
and since accounts are archived and never deleted, RESTRICT is the invariant
("a deposit never loses its ledger"), not a cascade policy.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    String,
    Uuid,
    false,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.enums import DepositCapitalization
from budget_api.models.base import Base

# Rebuilt from the shared enum so the enum is the single source for both model and
# schema (the models/account.py pattern). The rendered SQL MUST stay byte-identical
# to migration 0012; DepositCapitalization's definition order guarantees this.
_CAPITALIZATION_VALUES = ", ".join(f"'{c.value}'" for c in DepositCapitalization)


class Deposit(Base):
    __tablename__ = "deposits"
    __table_args__ = (
        CheckConstraint(
            f"capitalization IN ({_CAPITALIZATION_VALUES})",
            name="capitalization_valid",
        ),
        CheckConstraint("rate_percent >= 0", name="rate_non_negative"),
        CheckConstraint(
            "tax_rate_percent IS NULL OR (tax_rate_percent >= 0 AND "
            "tax_rate_percent <= 100)",
            name="tax_rate_range",
        ),
        # NULL term_end = open-ended (a savings account), which is why this is not a
        # plain ``>``: SQL would evaluate the comparison to NULL and pass anyway,
        # but spelling the NULL arm out keeps the constraint readable next to the
        # router's DEPOSIT_TERM_BEFORE_OPENING refusal.
        CheckConstraint(
            "term_end IS NULL OR term_end > opened_on", name="term_after_opening"
        ),
        # The anchor is a PAIR: a number without the date it was taken on would make
        # every later forecast unanchored in time, and a date without a number would
        # anchor nothing.
        CheckConstraint(
            "(accrued_override_minor IS NULL) = (accrued_override_as_of IS NULL)",
            name="accrued_override_pair",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    #: The hidden ledger account (1:1). RESTRICT, not CASCADE: accounts are archived
    #: rather than deleted, so a delete here would be a bug worth failing loudly.
    account_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("accounts.id", ondelete="RESTRICT"), unique=True
    )
    name: Mapped[str] = mapped_column(String(100))
    #: Annual rate in PERCENT (10.95 = 10.95 % p.a.), Numeric so the arithmetic in
    #: domain/deposits.py is Decimal end to end — never float. Four decimal places
    #: cover the fractions retail deposits are actually quoted at.
    rate_percent: Mapped[Decimal] = mapped_column(Numeric(8, 4))
    capitalization: Mapped[str] = mapped_column(String(16))
    #: May be in the PAST: creating a deposit opened a year ago is a headline
    #: requirement (task.md §5), and the whole timeline is seeded from this date.
    opened_on: Mapped[date] = mapped_column(Date)
    #: NULL = open-ended. Past term_end the accrual freezes on that date and the
    #: computed ``status`` reads ``matured``.
    term_end: Mapped[date | None] = mapped_column(Date, nullable=True)
    #: Withholding rate in percent; NULL = not taxed, which is a different answer
    #: from 0 and is why ``accrued_after_tax_minor`` is null rather than equal to
    #: the gross.
    tax_rate_percent: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 2), nullable=True
    )
    #: The manual correction (task.md §4: manual beats computed, everywhere). Set
    #: through PATCH; the date is stamped by the SERVER, never sent by a client.
    accrued_override_minor: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    accrued_override_as_of: Mapped[date | None] = mapped_column(Date, nullable=True)
    archived: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
