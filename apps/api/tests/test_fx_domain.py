"""Pure conversion math (architecture D6) — no DB, no app, no fixtures.

Covers only what is unique to the domain layer: the cross-exponent scaling that a
"plain multiply" would get wrong, the single rounding mode's two arms, the legal
zero result, and why the inverted rate is carried at full precision.
"""

from decimal import ROUND_HALF_UP, Decimal

import pytest

from budget_api.domain.fx import convert_minor, invert, transfer_rate


class TestConvertMinor:
    @pytest.mark.parametrize(
        ("from_currency", "to_currency", "expected_minor"),
        [
            # 1234.56 major x 1.9 = 2345.664 major, scaled to the TARGET exponent:
            ("RUB", "JPY", 2346),  # exp 2 -> 0: 2345.664 -> 2346 (half-up)
            ("USD", "BHD", 2345664),  # exp 2 -> 3: exact at 3 dp
            ("USD", "EUR", 234566),  # exp 2 -> 2: 234566.4 -> 234566
        ],
    )
    def test_cross_exponent_conversion(
        self, from_currency: str, to_currency: str, expected_minor: int
    ) -> None:
        # Same amount, same rate, three target exponents: a plain minor x rate
        # multiply happens to match only the 2->2 row and is off by 100x/1000x on
        # the other two.
        assert (
            convert_minor(123456, from_currency, to_currency, Decimal("1.9"))
            == expected_minor
        )

    def test_round_half_up_boundary(self) -> None:
        # 1.00 USD x 0.125 = 0.125 EUR = exactly 12.5 minor -> up (ROUND_HALF_UP);
        # x 0.1249 = 12.49 minor -> down. Both arms of the one rounding mode.
        assert convert_minor(100, "USD", "EUR", Decimal("0.125")) == 13
        assert convert_minor(100, "USD", "EUR", Decimal("0.1249")) == 12

    def test_converts_to_zero_minor(self) -> None:
        # 0.01 RUB at 0.01 USD/RUB = 0.0001 USD = 0.01 minor -> 0. A legal result:
        # the stored snapshot allows zero (the >= 0 CHECK, not > 0).
        assert convert_minor(1, "RUB", "USD", Decimal("0.01")) == 0

    def test_invert_full_precision(self) -> None:
        inverse = invert(Decimal(3))
        quantized = inverse.quantize(Decimal("1E-8"), rounding=ROUND_HALF_UP)

        # The default-context inverse round-trips to 1 to ~28 significant digits;
        # an 8 dp inverse is off by ~1e-8.
        assert abs(inverse * Decimal(3) - 1) < Decimal("1E-27")
        assert abs(quantized * Decimal(3) - 1) > Decimal("1E-9")

        # Which is exactly the difference between an exact conversion and a
        # 1-minor drift on a large amount — hence NO intermediate quantization.
        assert convert_minor(300_000_000, "USD", "EUR", inverse) == 100_000_000
        assert convert_minor(300_000_000, "USD", "EUR", quantized) == 99_999_999


class TestTransferRate:
    @pytest.mark.parametrize(
        ("amount_minor", "currency", "counter_minor", "counter_currency", "expected"),
        [
            # 100.00 USD -> 330.00 BYN: the everyday case, exact.
            (10_000, "USD", 33_000, "BYN", "3.3"),
            # 100.00 USD -> 15000 JPY (exponent 0!): 150, not 1.5 and not 15000.
            # A rate computed from raw minor units would report 1.5 here.
            (10_000, "USD", 15_000, "JPY", "150"),
            # ...and the other direction, target exponent 2 from source exponent 0.
            (15_000, "JPY", 10_000, "USD", "0.00666667"),
            # Six SIGNIFICANT digits, not six decimal places: a fixed 6 dp quantize
            # would report 0.000040 here and lose two of the rate's three digits.
            (1_000_000, "VND", 3_950, "USD", "0.0000395"),
            # ROUND_HALF_UP at the 6th significant digit: 1000000/700000 = 1.428571…
            (70_000, "USD", 100_000, "EUR", "1.42857"),
        ],
    )
    def test_rate_from_both_legs_at_their_own_exponents(
        self,
        amount_minor: int,
        currency: str,
        counter_minor: int,
        counter_currency: str,
        expected: str,
    ) -> None:
        rate = transfer_rate(amount_minor, currency, counter_minor, counter_currency)

        assert rate is not None
        assert format(rate, "f") == expected

    def test_zero_source_amount_has_no_rate(self) -> None:
        # The schema's ge=1 keeps this off the wire, but the model's CHECK is >= 0:
        # a zero-amount row must render as "no rate", never as a 500 on a GET.
        assert transfer_rate(0, "USD", 100, "EUR") is None
