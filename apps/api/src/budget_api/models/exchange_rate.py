"""ExchangeRate model — one row per (base, quote, as_of_date) (architecture D2).

Plain ``Mapped[...]``/``mapped_column`` style WITHOUT the ``TYPE_CHECKING`` split:
this table serves no fastapi-users protocol.

Only the 6 directed canonical pairs are stored (``fx_jobs.CANONICAL_PAIRS``);
inverses are derived at read time. The composite PK IS the lookup index — the hot
query is ``WHERE base=:b AND quote=:q AND as_of_date <= :d ORDER BY as_of_date
DESC LIMIT 1``, a leftmost-prefix range scan on exactly this btree — so no
secondary index is defined. The PK is also the ``ON CONFLICT`` target of the
idempotent fetch job (D3).

``rate`` is *quote per one base* and is the only value in the pipeline that is
quantized (8 dp, ROUND_HALF_UP — see services/fx_rates.py).
"""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, DateTime, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class ExchangeRate(Base):
    __tablename__ = "exchange_rates"
    __table_args__ = (
        # Naming convention turns name="rate_positive" into
        # ck_exchange_rates_rate_positive.
        CheckConstraint("rate > 0", name="rate_positive"),
        CheckConstraint("base ~ '^[A-Z]{3}$'", name="base_format"),
        CheckConstraint("quote ~ '^[A-Z]{3}$'", name="quote_format"),
    )

    base: Mapped[str] = mapped_column(String(3), primary_key=True)
    quote: Mapped[str] = mapped_column(String(3), primary_key=True)
    as_of_date: Mapped[date] = mapped_column(Date, primary_key=True)
    rate: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    provider: Mapped[str] = mapped_column(String(16))
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
