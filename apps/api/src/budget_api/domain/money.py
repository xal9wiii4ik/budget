"""Decimal-string → integer minor-units conversion (architecture D6/D10, AM-1).

The FIRST server-side major→minor conversion: transactions receive ``amount_minor``
already integer, so this pure module is the receipts pipeline's only place that
scales a printed decimal down to storage minor units. Consumed by
``_serialize_receipt`` to derive ``total_minor`` at read time from the stored
decimal string (no denormalized column — GET stays a pure read, D6).

The exponent table below is the SERVER TWIN of
``packages/shared/src/currencies.ts`` (``CURRENCY_EXPONENTS`` +
``DEFAULT_CURRENCY_EXPONENT``): we enumerate ONLY the currencies whose ISO-4217
minor-unit exponent differs from 2 (exponent-0 and exponent-3 exceptions);
everything else — including a well-formed but unknown OCR result, and ``None`` —
defaults to 2. Keeping the ``currency`` argument LIVE (not a hardcoded x100) is
what stops a 100x cross-layer corruption on exponent-0 receipts (JPY et al.): the
server would store ``total_minor`` x100 and the web ``toInputString`` would render
it as whole yen. **Drift between this table and the shared one is a recorded risk**
(the two must be edited together until 3.2 single-sources them).
"""

from decimal import ROUND_HALF_UP, Decimal

# Twin of CURRENCY_EXPONENTS in packages/shared/src/currencies.ts — keep in sync.
_CURRENCY_EXPONENTS: dict[str, int] = {
    # exponent 0
    "BIF": 0,
    "CLP": 0,
    "DJF": 0,
    "GNF": 0,
    "ISK": 0,
    "JPY": 0,
    "KMF": 0,
    "KRW": 0,
    "PYG": 0,
    "RWF": 0,
    "UGX": 0,
    "VND": 0,
    "VUV": 0,
    "XAF": 0,
    "XOF": 0,
    "XPF": 0,
    # exponent 3
    "BHD": 3,
    "IQD": 3,
    "JOD": 3,
    "KWD": 3,
    "LYD": 3,
    "OMR": 3,
    "TND": 3,
}

# Exponent for any well-formed currency not in the table (and for None). Twin of
# DEFAULT_CURRENCY_EXPONENT in the shared module.
_DEFAULT_CURRENCY_EXPONENT = 2


def to_minor_units(total: str, currency: str | None) -> int:
    """Convert a decimal string to integer minor units at the currency's exponent.

    ``total`` must already be a well-formed non-negative decimal string (the
    ``ParsedReceipt.total`` validator guarantees this before storage). ``currency``
    is looked up in the exponent table (uppercased defensively); unknown/None → 2.
    """
    exponent = _CURRENCY_EXPONENTS.get(
        (currency or "").upper(), _DEFAULT_CURRENCY_EXPONENT
    )
    scale = Decimal(10) ** exponent
    return int((Decimal(total) * scale).quantize(Decimal(1), rounding=ROUND_HALF_UP))
