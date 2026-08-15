"""Pure FX conversion math (architecture D6) — stdlib + ``decimal`` only.

No IO, no ORM, no framework: the ``domain/money.py`` / ``domain/merchant.py``
precedent. Rate *lookup* is IO and lives in ``services/fx_lookup.py``; callers
resolve a ``Decimal`` rate there and hand it in here.

Cross-exponent minor→minor is NOT a plain multiply — RUB (exponent 2) → JPY
(exponent 0) would be off by 100x — so every minor↔major crossing goes through
``currency_exponent`` from ``domain/money.py`` (domain→domain, one exponent
table for the whole server).

ROUND_HALF_UP is the single money-rounding mode of this codebase, established by
``domain/money.py:to_minor_units`` and reused here for conversion results (D6):
two rounding modes in one codebase is a bug factory. It is spelled out
explicitly at the one quantize below — nothing relies on the context default.
"""

from decimal import ROUND_HALF_UP, Decimal

from budget_api.domain.money import currency_exponent


def convert_minor(
    amount_minor: int, from_currency: str, to_currency: str, rate: Decimal
) -> int:
    """Convert ``amount_minor`` (in ``from_currency`` minor units) to ``to_currency``.

    ``rate`` is *to-per-one-from* in MAJOR units, at full precision as resolved by
    the lookup (an inverted rate is deliberately not pre-quantized — D2's
    "no intermediate quantization" rule). Rounding happens exactly once, here, at
    the final minor-unit quantize.
    """
    major = Decimal(amount_minor) / (Decimal(10) ** currency_exponent(from_currency))
    converted = major * rate
    scale = Decimal(10) ** currency_exponent(to_currency)
    return int((converted * scale).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def invert(rate: Decimal) -> Decimal:
    """``1/rate`` at default-context precision — NOT quantized (D2).

    Only the 6 canonical directed pairs are stored; the opposite direction is
    derived here. Quantizing the inverse would bake a rounding error into every
    downstream multiplication, so the full-precision quotient is carried all the
    way to ``convert_minor``'s single quantize (the display layer quantizes its
    own copy for echoing, and only that copy).
    """
    return Decimal(1) / rate
