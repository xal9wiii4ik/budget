"""Edge-1 drift: committed openapi.json is exactly what the exporter produces."""

from pathlib import Path

from budget_api.openapi_export import build_export_app, openapi_json

_COMMITTED = Path(__file__).parent.parent / "openapi.json"


class TestOpenApiExport:
    def test_committed_schema_matches_current_app(self) -> None:
        expected = openapi_json(build_export_app())
        actual = _COMMITTED.read_text(encoding="utf-8")

        assert actual == expected, (
            "apps/api/openapi.json is stale — run `pnpm openapi` from the repo "
            "root and commit apps/api/openapi.json + "
            "packages/api-client/src/generated/schema.d.ts."
        )
