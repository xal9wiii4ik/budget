"""Print ``src/budget_api/domain/country_names.py`` — run ONCE, by hand.

The runtime module is a COMMITTED literal, exactly like the synthetic Alfa PDF
fixtures (``tests/fixtures/alfa/make_fixtures.py``): this generator is never run
by the suite, never by the image and never by a request. ``pycountry`` is a
20 MB data package whose only job here is to be typed out once; shipping it as a
runtime dependency so the server could rebuild a constant table on every boot
would be the wrong trade.

Regenerate (from ``apps/api``) only when the ISO list itself changes, and commit
the diff together with the test that pins the count:

    uv run --with pycountry --isolated --no-project python -I \
        scripts/gen_country_names.py > src/budget_api/domain/country_names.py

``--isolated --no-project`` keeps ``pycountry`` out of this project's
environment, and ``-I`` keeps the script's own directory off ``sys.path``.

The name chosen per country is ``common_name or name``: "South Korea" reads like
a merchant's country and "Korea, Republic of" does not, and the embedded text
this feeds is meant to be the string a person would write.
"""

import json
import sys

import pycountry  # type: ignore[import-not-found]

_HEADER = '''"""ISO-3166-1 alpha-2 → the English short name of the country (GENERATED).

Do NOT edit by hand: produced by ``scripts/gen_country_names.py`` from
``pycountry``, committed, and never regenerated at runtime (see that script's
docstring for the one command that rewrites this file). ``pycountry`` is NOT a
dependency of this application.

The table exists because the canonical transaction text
(``services/tx_text.py``) embeds a country as ``"Poland (PL)"``: the name beside
the code wins every retrieval probe in ``evidence.md`` while a bare ``PL`` is
borderline. It is the FIRST server-side name table in this codebase — the web
keeps using the browser's own ``Intl.DisplayNames``, which no server has.

Changing a name here re-spells every passage that carries that country, so every
affected row's ``text_hash`` changes and the sweep re-embeds it. That is the
intended (and only) consequence.
"""

from collections.abc import Mapping
from types import MappingProxyType

#: The {count} officially assigned alpha-2 codes, each mapped to ``common_name or
#: name`` from ``pycountry`` ("South Korea", not "Korea, Republic of").
COUNTRY_NAMES: Mapping[str, str] = MappingProxyType(
    {{
{rows}
    }}
)


def country_label(code: str | None) -> str | None:
    """``"PL"`` → ``"Poland (PL)"``; an unknown code → ``"(XX)"``; ``None`` → ``None``.

    An unknown code is NOT an error and NOT dropped: the column is a free
    two-letter field (CHECK ``country ~ '^[A-Z]{{2}}$'``), so a user may legally
    store a code this table has never heard of, and the honest passage still says
    which code it was.
    """
    if code is None:
        return None
    name = COUNTRY_NAMES.get(code)
    return f"{{name}} ({{code}})" if name is not None else f"({{code}})"
'''


def main() -> int:
    names: dict[str, str] = {}
    for country in pycountry.countries:
        code: str = country.alpha_2
        names[code] = getattr(country, "common_name", None) or country.name
    # ``json.dumps`` rather than ``repr``: the committed file has to come out
    # already ruff-formatted (double quotes, non-ASCII kept verbatim), because
    # nobody re-formats a generated module by hand.
    rows = "\n".join(
        f"        {json.dumps(code)}: {json.dumps(name, ensure_ascii=False)},"
        for code, name in sorted(names.items())
    )
    sys.stdout.write(_HEADER.format(count=len(names), rows=rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
