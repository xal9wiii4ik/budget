"""Stats response schemas (architecture D4).

Imports only Pydantic + stdlib + the shipped ``CategorySummary`` — never
``models`` (architecture §1). ``CategorySummary`` is REUSED rather than
re-declared so ``/stats/summary`` and ``/transactions/summary`` share one
generated TypeScript type: two identical shapes under two names would let the two
screens' renderers drift apart.

Every window is echoed with an INCLUSIVE ``to`` (the server resolves
``[from, to_exclusive)`` internally and never leaks the exclusive end — a client
rendering "01.02 — 01.03" for February would be wrong by a day).

Money is minor units end-to-end and ``currency`` discloses the exponent to decode
them at (AM-5); ``unconverted_count`` is required everywhere it appears, because a
client that cannot see the exclusion would render a silently understated period as
a complete one (D9's exclude-and-flag).
"""

from datetime import date

from pydantic import BaseModel, Field

from budget_api.schemas.transaction import CategorySummary


class PeriodBounds(BaseModel):
    """Resolved window, echoed. ``from`` is a Python keyword — hence the alias
    (the ``FxConvertRead.from_currency`` precedent)."""

    from_: date = Field(serialization_alias="from")
    to: date  # INCLUSIVE


class PeriodTotals(BaseModel):
    """The ``previous`` block: totals only.

    No ``by_category`` (D4): the comparison screen compares totals, and a
    per-category diff view is additive later if it is ever asked for.
    """

    from_: date = Field(serialization_alias="from")
    to: date  # INCLUSIVE
    income_minor: int
    expense_minor: int
    net_minor: int  # signed: income - expense
    unconverted_count: int


class StatsSummaryRead(BaseModel):
    period: PeriodBounds
    currency: str  # profile base currency
    income_minor: int
    expense_minor: int
    net_minor: int  # signed: income - expense
    by_category: list[CategorySummary]  # ordered (kind, total DESC)
    unconverted_count: int
    # ALWAYS present (D4): one extra indexed aggregate, and a `compare=` knob
    # would be speculative config. Deltas are NOT computed server-side —
    # percent-against-zero is a display policy, not math.
    previous: PeriodTotals


class MonthlyPoint(BaseModel):
    month: str  # "YYYY-MM"
    income_minor: int
    expense_minor: int
    net_minor: int  # signed: income - expense
    # PER-POINT (D4): a single flagged month must not cast doubt on eleven clean ones.
    unconverted_count: int


class MonthlyRead(BaseModel):
    currency: str
    points: list[MonthlyPoint]  # dense, ascending, empty months kept as zeros


class MerchantTotalRead(BaseModel):
    merchant: str  # the verbatim stored string (no normalization — OQ-4)
    total_minor: int
    tx_count: int  # rows that made it into total_minor, never more


class TopMerchantsRead(BaseModel):
    period: PeriodBounds
    currency: str
    items: list[MerchantTotalRead]
    unconverted_count: int


class StatsError(BaseModel):
    """422 error envelope — mirrors ``TransactionError`` / ``GoalError``."""

    detail: str
