"""Cross-layer guard (D9/OQ-6): the server exponent table == the shared TS twin.

``domain/money.py`` duplicates ``packages/shared/src/currencies.ts`` by design
(the server cannot import TypeScript). Drift between the two is a 100x
mis-scaling on exponent-0/3 currencies, so this test parses the TS literal and
compares both tables exactly, in both directions. It lives in the backend suite
because that is the layer owning ``money.py`` — the table's edit always happens
here first.
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


class TestCurrencyExponentsSync:
    def test_shared_table_matches_server_table(self) -> None:
        if not _SHARED_TS.is_file():
            # A skip here would turn a moved/renamed currencies.ts into a
            # permanently-green dead guard — exactly the drift this test exists
            # to catch.
            pytest.fail(
                f"currencies.ts not found at {_SHARED_TS} — the exponent guard is "
                "dead; fix the path"
            )
        source = _SHARED_TS.read_text(encoding="utf-8")

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
