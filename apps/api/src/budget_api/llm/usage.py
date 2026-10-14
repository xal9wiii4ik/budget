"""Prices, the cost estimate, and the ONE log line that records an LLM call.

There is no call table in the database (brief): this module's ``log_call`` line IS
the record of what was spent. It therefore has to be greppable and has to carry no
user data — never the prompt, never an operation's text, only the shape of the
call plus the owner's user id.
"""

import logging
from decimal import ROUND_HALF_UP, Decimal

from budget_api.llm.types import Usage

logger = logging.getLogger(__name__)

#: USD per MILLION tokens, ``(input, output)``, as of 2026-10-14 per the published
#: table at docs.claude.com/pricing. Keys are the exact model ids this server may
#: send (``config.categorize_model``, and the dated snapshots the other two
#: Anthropic call sites pin), so a model with no entry gets ``None`` rather than a
#: silently wrong number.
PRICES_USD_PER_MTOK: dict[str, tuple[Decimal, Decimal]] = {
    "claude-haiku-5-5": (Decimal("0.10"), Decimal("0.50")),
    "claude-haiku-4-5-20251001": (Decimal("1.00"), Decimal("5.00")),
    "claude-sonnet-5-5": (Decimal("2.00"), Decimal("10.00")),
    "claude-sonnet-4-5-20250929": (Decimal("3.00"), Decimal("15.00")),
}

#: A cache READ is billed at a tenth of the input price (same published table).
CACHE_READ_FACTOR = Decimal("0.1")

_PER_MILLION = Decimal(1_000_000)
_CENTS_6 = Decimal("0.000001")


def estimate_cost(
    model: str,
    *,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
) -> Decimal | None:
    """USD estimate at six places, or ``None`` for a model with no published price.

    ``None`` is NOT zero: zero is Ollama's honest number (local inference costs no
    USD), and an unpriced hosted model must not read as free in the log.
    """
    prices = PRICES_USD_PER_MTOK.get(model)
    if prices is None:
        return None
    price_in, price_out = prices
    total = (
        Decimal(input_tokens) * price_in
        + Decimal(cache_read_tokens) * price_in * CACHE_READ_FACTOR
        + Decimal(output_tokens) * price_out
    ) / _PER_MILLION
    return total.quantize(_CENTS_6, rounding=ROUND_HALF_UP)


def failed_usage(provider: str, model: str, latency_ms: int) -> Usage:
    """The usage record of a call that never reported one (an error arm).

    Zero tokens and ``None`` cost say exactly that: we did not get a usage block
    back. A failed call that DID burn tokens upstream is invisible to us, and
    inventing a number for it would be worse than the honest zero.
    """
    return Usage(
        provider=provider,
        model=model,
        input_tokens=0,
        output_tokens=0,
        cache_read_tokens=0,
        latency_ms=latency_ms,
        estimated_cost_usd=None,
    )


def log_call(
    usage: Usage,
    *,
    prompt_version: str,
    outcome: str,
    batch_size: int,
    user_id: str | None = None,
) -> None:
    """Emit the one ``INFO`` line that records this call. Never the prompt.

    ONE ``logger.info`` with key=value TEXT rather than ``extra=...``: the app's
    formatter (``app.py::_configure_logging``) prints no extras, so a structured
    field would be invisible exactly where it matters. ``outcome`` is ``ok`` or
    ``error:<code>``.

    ``batch_size`` is "how big was this call" in the caller's own unit:
    operations for categorize, LINES for the Alfa extraction, the STEP index for
    the reconcile loop (where every call is one step of one conversation).
    """
    cost = usage.estimated_cost_usd
    logger.info(
        "llm call provider=%s model=%s prompt=%s outcome=%s batch=%d "
        "latency_ms=%d in=%d out=%d cache_read=%d cost_usd=%s user=%s",
        usage.provider,
        usage.model,
        prompt_version,
        outcome,
        batch_size,
        usage.latency_ms,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        "-" if cost is None else f"{cost:f}",
        user_id or "-",
    )
