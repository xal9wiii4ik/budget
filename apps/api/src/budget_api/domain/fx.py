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

from decimal import ROUND_HALF_UP, Context, Decimal, localcontext

from budget_api.domain.money import currency_exponent

#: SIGNIFICANT digits of a reported transfer rate, not decimal places (A2). A
#: fixed 6-place quantize would round a VND→USD rate (~0.0000395) down to
#: 0.000040 — three of its digits gone — while 6 significant digits describe
#: 3.30000 and 0.0000395000 equally well.
_TRANSFER_RATE_PRECISION = 6


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


def transfer_rate(
    amount_minor: int,
    currency: str,
    counter_amount_minor: int,
    counter_currency: str,
) -> Decimal | None:
    """The rate a transfer's two legs IMPLY: target major per one source major (A2).

    Derived, never stored: the two amounts are the facts (the user typed what
    actually left and what actually landed), and a stored rate could only ever
    disagree with them after an edit. Computed SERVER-side so web, mobile and MCP
    all show the same string instead of three client divisions.

    Both legs cross to major units at their OWN currency's exponent — an exponent-0
    target (¥15000 for $100 is 150, not 1.5) is the whole reason this cannot be a
    plain ``counter_minor / amount_minor``. That crossing happens OUTSIDE the
    reduced-precision context below: 6 significant digits are right for a rate and
    catastrophic for a 15-digit amount.

    ``amount_minor == 0`` yields ``None``: the schema's ``ge=1`` makes it
    unreachable from the wire, but the model's CHECK is ``>= 0`` and a division by
    zero here would be a 500 on a plain GET.
    """
    if amount_minor == 0:
        return None
    source_major = Decimal(amount_minor).scaleb(-currency_exponent(currency))
    target_major = Decimal(counter_amount_minor).scaleb(
        -currency_exponent(counter_currency)
    )
    with localcontext(Context(prec=_TRANSFER_RATE_PRECISION, rounding=ROUND_HALF_UP)):
        return target_major / source_major


def invert(rate: Decimal) -> Decimal:
    """``1/rate`` at default-context precision — NOT quantized (D2).

    Only the 6 canonical directed pairs are stored; the opposite direction is
    derived here. Quantizing the inverse would bake a rounding error into every
    downstream multiplication, so the full-precision quotient is carried all the
    way to ``convert_minor``'s single quantize (the display layer quantizes its
    own copy for echoing, and only that copy).
    """
    return Decimal(1) / rate
