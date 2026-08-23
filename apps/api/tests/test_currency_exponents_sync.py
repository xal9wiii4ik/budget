"""Cross-layer guard (D9/OQ-6): ``domain/money.py`` == the shared TS twin.

``domain/money.py`` duplicates ``packages/shared/src/currencies.ts`` by design
(the server cannot import TypeScript). Drift between the two is a 100x
mis-scaling on exponent-0/3 currencies, so this test parses the TS literal and
compares both tables exactly, in both directions. It lives in the backend suite
because that is the layer owning ``money.py`` — the table's edit always happens
here first.

The same file carries a SECOND hand-written twin since the base-currency scope:
``SUPPORTED_CURRENCIES``, the set ``PATCH /profile`` validates a new base
against. Its drift is quieter but worse-tempered — a currency added only to the
TS list is offered by the settings picker and then refused by the server with
``CURRENCY_NOT_SUPPORTED``, and one added only server-side is a base the UI can
never reach.
"""

import re
from pathlib import Path

import pytest

from budget_api.domain import money

# parents[3] of apps/api/tests/<file> is the repo root — no reliance on cwd.
_SHARED_TS = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "shared"
    / "src"
    / "currencies.ts"
)

_ENTRY = re.compile(r"^\s*([A-Z]{3}): (\d+),", re.MULTILINE)
_DEFAULT = re.compile(r"DEFAULT_CURRENCY_EXPONENT = (\d+)")
_TABLE = re.compile(r"CURRENCY_EXPONENTS[^{]*\{(.*?)\n\};", re.DOTALL)
_SUPPORTED = re.compile(r"SUPPORTED_CURRENCIES = \[(.*?)\] as const", re.DOTALL)
_CODE = re.compile(r"'([A-Z]{3})'")


def _shared_source() -> str:
    """The TS twin's text; a MISSING file fails loudly instead of skipping.

    A skip would turn a moved/renamed currencies.ts into a permanently-green dead
    guard — exactly the drift these tests exist to catch.
    """
    if not _SHARED_TS.is_file():
        pytest.fail(
            f"currencies.ts not found at {_SHARED_TS} — the currency guards are "
            "dead; fix the path"
        )
    return _SHARED_TS.read_text(encoding="utf-8")


class TestCurrencyExponentsSync:
    def test_shared_table_matches_server_table(self) -> None:
        source = _shared_source()

        table = _TABLE.search(source)
        assert table is not None, "CURRENCY_EXPONENTS object literal not found"
        parsed = {code: int(exp) for code, exp in _ENTRY.findall(table.group(1))}
        default_match = _DEFAULT.search(source)
        assert default_match is not None, "DEFAULT_CURRENCY_EXPONENT not found"

        # >= 20: an extraction bug returning {} must fail loudly here rather than
        # vacuously "match" an accidentally-empty twin.
        assert len(parsed) >= 20, f"only parsed {len(parsed)} entries — regex rot"
        # The private table IS the artifact under guard: comparing through the
        # public currency_exponent() accessor would only probe the keys the TS
        # file happens to list, so a server-side EXTRA entry would slip through.
        assert parsed == money._CURRENCY_EXPONENTS  # pyright: ignore[reportPrivateUsage]
        assert (
            int(default_match.group(1)) == money._DEFAULT_CURRENCY_EXPONENT  # pyright: ignore[reportPrivateUsage]
        )


class TestSupportedCurrenciesSync:
    def test_shared_list_matches_server_set(self) -> None:
        source = _shared_source()

        listed = _SUPPORTED.search(source)
        assert listed is not None, "SUPPORTED_CURRENCIES literal not found"
        parsed = set(_CODE.findall(listed.group(1)))

        # Non-empty guard: a regex that stopped matching must fail here rather
        # than vacuously "agree" with an empty parse.
        assert parsed, "parsed no currency codes — regex rot"
        # Both directions in one comparison: a code in either list alone fails.
        assert parsed == set(money.SUPPORTED_CURRENCIES)
