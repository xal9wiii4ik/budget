"""Canonical OpenAPI schema export.

Single source of truth for the bytes of apps/api/openapi.json: the
`python -m budget_api.openapi_export` CLI (which writes the committed file) and
the pytest drift test both import `openapi_json`/`build_export_app` from here, so
a regenerated schema and its drift check can never disagree on formatting.

Hermetic: the app is built with an explicit dummy database_url and never calls
get_settings(), so no .env, environment, database, or network is consulted;
app.openapi() runs no lifespan and touches no DB.
"""

import json
import sys
from pathlib import Path

from fastapi import FastAPI

from budget_api.config import Settings

# Explicit, obviously-fake values for the two required Settings fields
# (database_url, jwt_secret). Supplying every required field means
# pydantic-settings consults neither env nor .env, so the export stays hermetic.
# The dummy secret never appears in the schema — it only signs tokens at runtime,
# and app.openapi() runs no request path.
_EXPORT_DATABASE_URL = "postgresql+asyncpg://openapi-export-placeholder/none"
_EXPORT_JWT_SECRET = "openapi-export-placeholder-secret"


def build_export_app() -> FastAPI:
    """Build the app exactly as the export/drift path expects — hermetic settings.

    ``create_app`` is imported HERE and not at module scope, and that is
    load-bearing: since the mcp-remote scope ``app.py`` builds the ``/mcp``
    transport from the running app, so it imports ``mcp/remote.py`` →
    ``mcp/server.py`` → this module. A module-level ``from budget_api.app import
    create_app`` would close that loop and ``import budget_api.app`` would fail
    on a half-initialised module. :func:`openapi_json` — the half everything
    else wants — depends on nothing but fastapi, so the one function that really
    does need the app factory is the one that pays for it.
    """
    from budget_api.app import create_app

    return create_app(
        Settings(database_url=_EXPORT_DATABASE_URL, jwt_secret=_EXPORT_JWT_SECRET)
    )


def openapi_json(app: FastAPI) -> str:
    """Canonical serializer: the exact bytes committed to apps/api/openapi.json.

    sort_keys makes JSON object-key order irrelevant (keys are non-semantic);
    array order (e.g. `required`, enum members) is preserved because it is
    semantic. indent=2, UTF-8 (ensure_ascii=False), trailing newline.
    """
    return (
        json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    )


def main(argv: list[str]) -> None:
    document = openapi_json(build_export_app())
    if argv:
        Path(argv[0]).write_text(document, encoding="utf-8")
    else:
        sys.stdout.write(document)


if __name__ == "__main__":
    main(sys.argv[1:])
