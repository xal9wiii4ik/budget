"""Conversion preview — ``GET /fx/convert`` (architecture D8).

Thin: the rate comes from ``services/fx_lookup``, the arithmetic from
``domain/fx``. The endpoint exists so no client ever does rate math (a second
implementation of D6's cross-exponent scaling in TypeScript is exactly the 100x
bug this scope removes).

Auth-required, no rate limit (a DB-only read — the transactions/categories
precedent). No business 4xx: an unresolvable rate is a 200 with the null triple
(D7), so a rate-lag day degrades the form instead of breaking it.
"""

from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.db import get_session
from budget_api.domain.fx import convert_minor
from budget_api.mcp.decorator import mcp_tool
from budget_api.models import User
from budget_api.pat_auth import current_user_jwt_or_pat
from budget_api.schemas.fx import FxConvertRead
from budget_api.services.fx_lookup import lookup_rate

router = APIRouter()

_CURRENCY_PATTERN = r"^[A-Z]{3}$"
#: DISPLAY precision of the echoed rate string — the stored column's own scale
#: (Numeric(18, 8)). The math never sees this: an inverted rate is quantized here
#: for the wire only, after convert_minor has used the full-precision value.
_RATE_DISPLAY_EXPONENT = Decimal("1E-8")


@router.get("/convert", response_model=FxConvertRead)
@mcp_tool(
    name="convert_currency",
    description=(
        "Convert an amount between currencies at the server's daily rate. Use this "
        "for ANY cross-currency figure — never multiply amounts yourself. Minor "
        "units in and out."
    ),
    params={
        "amount_minor": (
            "Amount in MINOR units of the source currency: 12.34 EUR is 1234; JPY "
            "has no minor unit, so 500 JPY is 500."
        ),
        "from": "Source currency, ISO 4217 uppercase (e.g. EUR).",
        "to": "Target currency, ISO 4217 uppercase (e.g. USD).",
        "date": "Rate date as YYYY-MM-DD; defaults to the most recent rate.",
    },
)
async def convert(
    amount_minor: int = Query(ge=0),
    from_currency: str = Query(alias="from", pattern=_CURRENCY_PATTERN),
    to: str = Query(pattern=_CURRENCY_PATTERN),
    on_date: date | None = Query(default=None, alias="date"),
    user: User = Depends(current_user_jwt_or_pat),
    session: AsyncSession = Depends(get_session),
) -> FxConvertRead:
    # Format-only currency validation (D7): the API is deliberately NOT restricted
    # to the picker's supported set, so a JPY receipt can be previewed honestly.
    effective_date = on_date or datetime.now(UTC).date()
    found = await lookup_rate(session, from_currency, to, effective_date)
    if found is None:
        # Never 404/500 — the pair simply has no rate yet (D7).
        return FxConvertRead(
            converted_minor=None,
            rate=None,
            rate_as_of=None,
            from_currency=from_currency,
            to=to,
            amount_minor=amount_minor,
        )
    return FxConvertRead(
        converted_minor=convert_minor(amount_minor, from_currency, to, found.rate),
        rate=str(found.rate.quantize(_RATE_DISPLAY_EXPONENT, rounding=ROUND_HALF_UP)),
        rate_as_of=found.rate_as_of,
        from_currency=from_currency,
        to=to,
        amount_minor=amount_minor,
    )
