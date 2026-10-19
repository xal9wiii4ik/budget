"""The semantic search wire shapes — and the hit schema the Q&A reuses (D-R5).

``TransactionSearchHit`` EMBEDS ``TransactionRead`` rather than extending it or
replacing it with a leaner row. One money projection, one opinion about which
amount leads: the web's row renderer, its ``rowDisplay.primaryAmount`` and every
MCP client already consume exactly that shape, and a second row DTO would be a
second answer to "what did this cost". ``score`` rides BESIDE the transaction for
the same reason — a field added to ``TransactionRead`` would appear (null) on
every other transaction response in the contract.

``schemas/advisor_qa.py`` imports the hit and the total from here and never the
other way round: the Q&A is a consumer of retrieval, not its peer (ruling ASK-2 —
the two responses carry literally the same schema so one client component renders
a search row and a citation).
"""

from pydantic import BaseModel

from budget_api.schemas.transaction import TransactionRead
from budget_api.services.tx_totals import RowsTotal


class SearchTotal(BaseModel):
    """The server's total over the RETRIEVED rows, in the profile base currency.

    The client sums nothing: ``net_minor`` is computed here, and
    ``unconverted_count`` is the honest count of rows that left every sum because
    no rate existed for their day (D9's exclude-and-flag, applied to a result
    page). A page with a non-zero count is NOT a page whose total is wrong — it
    is a page whose total describes fewer rows than it lists, which is a fact the
    UI has to say out loud.
    """

    #: The profile's base currency — never the currency of any individual row.
    currency: str
    income_minor: int
    expense_minor: int
    #: Signed ``income - expense``, computed server-side (the SummaryRead rule).
    net_minor: int
    unconverted_count: int

    @classmethod
    def from_rows(cls, total: RowsTotal, currency: str) -> "SearchTotal":
        """``RowsTotal`` → the wire shape. THE place ``net_minor`` is subtracted.

        Both consumers of ``converted_total_for_rows`` build this DTO — the search
        route and the Q&A — so the subtraction the service deliberately left out
        of ``RowsTotal`` happens once rather than once per router. The import of a
        service dataclass is the price: the alternative was two routers each
        spelling out the same five fields, which is how the two totals drift
        apart.
        """
        return cls(
            currency=currency,
            income_minor=total.income_minor,
            expense_minor=total.expense_minor,
            net_minor=total.income_minor - total.expense_minor,
            unconverted_count=total.unconverted_count,
        )


class TransactionSearchHit(BaseModel):
    """One ranked result: the whole transaction plus its raw cosine score.

    ``score`` is RELATIVE inside one list and nothing else: real answers sit in a
    narrow band (0.78..0.87 for the production model) and the margin between a
    right and a wrong row can be 0.006, so it is never a quality bar, a
    percentage or a progress bar. There is no server-side cut-off by default
    (D-R3).
    """

    transaction: TransactionRead
    score: float


class TransactionSearchRead(BaseModel):
    """``GET /transactions/search``. ``items`` are in rank order, best first."""

    items: list[TransactionSearchHit]
    total: SearchTotal
    #: The caller's user-wide count of rows not yet indexed, AFTER this request's
    #: bounded repair and independent of the request's filters (ruling ASK-6):
    #: "N recent operations are still being indexed and may be missing here".
    pending_count: int
    #: How many indexed rows the scan considered, bounded by
    #: ``search_max_candidates``. Diagnostic, not a number to render.
    candidates: int
    #: The artifact stamp the ranked vectors were produced by — the same string
    #: stored on every indexed row, so an answer can be attributed to a model.
    model: str


class SearchError(BaseModel):
    """The 422/429/503 envelope — one ``detail`` string code, as everywhere."""

    detail: str
