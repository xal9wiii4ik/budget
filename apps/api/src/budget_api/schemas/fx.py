"""FX conversion-preview schemas.

Imports only Pydantic + stdlib, never ``models`` (architecture §1).

No ``FxError``: ``GET /fx/convert`` has no business 4xx at all — a missing rate is
a 200 with the null triple (D7), and malformed params are FastAPI's automatic
``HTTPValidationError``. A hand-declared error model with no route emitting it
would only add a dead component to the contract.
"""

from datetime import date

from pydantic import BaseModel, Field


class FxConvertRead(BaseModel):
    """GET /fx/convert response (D8): the conversion plus the echoed request.

    ``converted_minor``/``rate``/``rate_as_of`` are null TOGETHER when no rate can
    be resolved for the pair — the client shows "no rate available" and offers the
    manual-override field. ``rate`` is a decimal STRING (never a float) quantized
    to 8 dp for display; the math behind ``converted_minor`` uses the full-precision
    rate. ``rate_as_of`` is the stored row's own date, which may be older than the
    requested date (nearest-previous resolution, disclosed honestly).
    """

    converted_minor: int | None
    rate: str | None
    rate_as_of: date | None
    # ``from`` is a Python reserved word: the field is ``from_currency`` and the
    # wire name is ``from`` (mirrors the ``from_``/alias query precedent in
    # routers/transactions.py:list_transactions).
    from_currency: str = Field(serialization_alias="from")
    to: str
    amount_minor: int
