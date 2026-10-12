"""The 40 MCP tools, 35 of them the surface the TypeScript server published.

The snapshot in ``fixtures/mcp_tools_snapshot.json`` was taken from that server
BEFORE any of this existed (its ``dist/`` rebuilt from ``src/``), so a red
comparison on one of those 35 means the port — or the transcription of a curated
sentence — moved something a client saw yesterday. Fix the port, never the
snapshot.

A scope that ADDS tools adds their entries to the same fixture (the debts scope
was the first: five of them), so the file is now "every tool, pinned", and only
its ``source`` block still describes the TypeScript document the original 35 were
taken from — nothing reads that block and it is never rewritten.

The rest of the file is what the snapshot cannot say: the rules that must keep
holding when the CONTRACT grows a field (curated prose on money writes, an
optional PATCH field, the hidden idempotency key) and what a read token may see.
The error paths are exercised on a synthetic mini-document — the real contract is
deliberately free of every drift they describe.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from budget_api.mcp.decorator import ToolSpec
from budget_api.mcp.exposure import RouteTool, tool_specs
from budget_api.mcp.tools import (
    JsonObject,
    OpenApiDocument,
    ToolBuildError,
    build_tools,
    parse_document,
    tools_for_scope,
)
from budget_api.mcp.upload_receipt import (
    UPLOAD_TOOL_DESCRIPTION,
    UPLOAD_TOOL_INPUT_SCHEMA,
    UPLOAD_TOOL_NAME,
)
from budget_api.openapi_export import build_export_app, openapi_json

_SNAPSHOT = Path(__file__).parent / "fixtures" / "mcp_tools_snapshot.json"

#: read ⇔ GET; a departure from that rule is possible only through an explicit
#: parameter, which deliberately does not exist yet (mcp/decorator.py). These two
#: lists are that rule made checkable: a GET with a side effect, or a non-GET that
#: is safe for a read token, cannot be inherited in silence — it lands in the wrong
#: list here and forces its author to decide out loud. The ORDER is the walk order
#: (mount order, then declaration order) — also the order tools are published in.
READ_TOOLS = [
    "list_categories",
    "list_accounts",
    "list_deposits",
    "get_deposit",
    "list_debts",
    "get_debt",
    "list_transactions",
    "get_transactions_summary",
    "convert_currency",
    "list_upcoming_goal_deadlines",
    "get_goal_plan",
    "list_goals",
    "get_goal",
    "list_goal_contributions",
    "get_goal_progress",
    "list_recurring",
    "list_upcoming_recurring",
    "list_limits",
    "get_stats_summary",
    "get_stats_monthly",
    "get_top_merchants",
    "get_profile",
]

WRITE_TOOLS = [
    "create_category",
    "update_category",
    "create_account",
    "update_account",
    "create_debt",
    "update_debt",
    "record_debt_repayment",
    "create_transaction",
    "update_transaction",
    "delete_transaction",
    "create_goal_item",
    "update_goal_item",
    "create_goal",
    "update_goal",
    "add_goal_contribution",
    "create_recurring",
    "update_recurring",
    "set_category_limit",
]


def _built() -> dict[str, Any]:
    """Every tool the markers describe, built from the contract's own bytes."""
    app = build_export_app()
    document = parse_document(json.loads(openapi_json(app)))
    return {tool.name: tool for tool in build_tools(document, tool_specs(app))}


def _snapshot() -> dict[str, Any]:
    return json.loads(_SNAPSHOT.read_text(encoding="utf-8"))


def _mini_document(**paths: Any) -> OpenApiDocument:
    return parse_document({"paths": paths, "components": {"schemas": {}}}, "mini")


def _route(name: str, method: str, path: str, **spec: Any) -> RouteTool:
    return RouteTool(method=method, path=path, spec=ToolSpec(name=name, **spec))


class TestSnapshot:
    def test_tools_match_the_typescript_snapshot(self) -> None:
        """Name, prose, scope, flat schema and the ORDER of `required` — all of it.

        This is the compatibility proof of the whole scope: a client that was
        talking to the old server sees the same 35 tools, with the same sentences.
        """
        built = {name: tool.as_snapshot() for name, tool in _built().items()}
        expected = {tool["name"]: tool for tool in _snapshot()["tools"]}

        assert sorted(built) == sorted(expected)
        # Compared as WIRE TEXT, not as parsed objects: `1 == 1.0` in Python, so an
        # object comparison would pass while `tools/list` still differed in every
        # money bound (the live probe caught exactly that).
        for name in sorted(built):
            assert json.dumps(built[name], sort_keys=True) == json.dumps(
                expected[name], sort_keys=True
            ), name

    def test_upload_tool_matches_the_snapshot(self) -> None:
        """The hand-written tool is prose too, and it was transcribed by hand."""
        expected = _snapshot()["upload_tool"]

        assert expected["name"] == UPLOAD_TOOL_NAME
        assert expected["description"] == UPLOAD_TOOL_DESCRIPTION
        assert expected["inputSchema"] == UPLOAD_TOOL_INPUT_SCHEMA


class TestScope:
    def test_read_is_get_and_the_two_lists_are_pinned(self) -> None:
        """read ⇔ GET, made checkable — see the note on READ_TOOLS."""
        tools = _built().values()

        assert [t.name for t in tools if t.scope == "read"] == READ_TOOLS
        assert [t.name for t in tools if t.scope == "write"] == WRITE_TOOLS

    def test_a_read_token_sees_only_the_read_tools(self) -> None:
        """A published write tool teaches the model to loop on a guaranteed 403."""
        tools = list(_built().values())

        for_read = [tool.name for tool in tools_for_scope(tools, "read")]

        assert for_read == READ_TOOLS
        assert len(tools_for_scope(tools, "full")) == 40


class TestCurationRules:
    """What must keep holding when the CONTRACT grows a field of its own."""

    def test_every_money_write_field_is_curated(self) -> None:
        """The flat schema takes whatever the contract has, so a new body field
        reaches the model the moment the API grows one. Without a curated line it
        arrives with NO text at all and the model is free to invent what it means
        — which on a money write is the whole safety mechanism missing."""
        built = _built()

        assert (
            "original_amount_minor"
            in built["create_transaction"].input_schema["properties"]
        )
        assert "converted_minor" in built["create_goal_item"].input_schema["properties"]

        undescribed: list[str] = []
        for name in (
            "create_debt",
            "update_debt",
            "record_debt_repayment",
            "create_transaction",
            "update_transaction",
            "create_goal_item",
            "update_goal_item",
            "add_goal_contribution",
            "set_category_limit",
        ):
            properties: JsonObject = built[name].input_schema["properties"]
            undescribed += [
                f"{name}.{prop}"
                for prop, schema in properties.items()
                if not schema.get("description")
            ]

        assert undescribed == []

    def test_a_patch_never_requires_an_optional_field(self) -> None:
        """Every body field of an update is optional (omit = keep); only the path
        parameter is mandatory. A normalisation bug that promoted a nullable field
        into `required` would force the model to resend what it was not asked to
        change."""
        built = _built()

        for name in (
            "update_debt",
            "update_transaction",
            "update_category",
            "update_account",
            "update_recurring",
            "update_goal",
            "update_goal_item",
        ):
            tool = built[name]
            assert tool.method == "PATCH"
            assert tool.input_schema["required"] == list(tool.path_params)

    def test_client_id_is_managed_and_invisible(self) -> None:
        """The idempotency key is the server's, not the model's: visible, it can be
        forged or replayed; lost, a retried transfer becomes two."""
        create = _built()["create_transaction"]

        assert "client_id" not in create.input_schema["properties"]
        assert "client_id" not in create.body_props
        assert dict(create.managed_body) == {"client_id": "uuid"}


class TestDriftIsCollected:
    """Marker ↔ contract drift, on a synthetic document: one exception, every line."""

    def test_collects_every_error_at_once(self) -> None:
        """An operator fixing drift wants the whole list, not the first line of it."""
        document = _mini_document(
            **{
                "/thing/{thing_id}": {
                    "post": {
                        "parameters": [
                            {"name": "thing_id", "in": "path", "required": True},
                            {"name": "X-Trace", "in": "header"},
                        ],
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "thing_id": {"type": "string"},
                                            "client_id": {"type": "integer"},
                                        },
                                    }
                                }
                            }
                        },
                    }
                }
            }
        )
        routes = [
            _route(
                "do_thing",
                "POST",
                "/thing/{thing_id}",
                description="d",
                managed_body={"client_id": "uuid"},
            ),
            _route("do_thing", "POST", "/thing/{thing_id}", description="d"),
        ]

        with pytest.raises(ToolBuildError) as raised:
            build_tools(document, routes)

        assert [error.split(": ", 1)[1] for error in raised.value.errors] == [
            'unsupported "header" parameter "X-Trace" — only path and query are '
            "supported",
            '"thing_id" is both a path parameter and a body property — flattening '
            "would shadow one of them",
            'managed body property "client_id" is filled with a generated uuid, but '
            "the contract types it as 'integer'",
            "duplicate tool name in the allowlist",
        ]

    def test_a_managed_name_the_body_does_not_have_is_drift(self) -> None:
        """Otherwise the property is quietly never sent and the user's first write
        comes back 422 from the API instead of failing here."""
        document = _mini_document(
            **{
                "/thing": {
                    "post": {
                        "requestBody": {
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {"name": {"type": "string"}},
                                    }
                                }
                            }
                        }
                    }
                }
            }
        )

        with pytest.raises(ToolBuildError) as raised:
            build_tools(
                document,
                [
                    _route(
                        "do_thing",
                        "POST",
                        "/thing",
                        description="d",
                        managed_body={"client_id": "uuid"},
                    )
                ],
            )

        assert "which the request body does not have" in raised.value.errors[0]

    def test_a_curated_name_the_operation_does_not_accept_is_drift(self) -> None:
        """A renamed query parameter would otherwise keep its curated prose in the
        marker while the model sees the new name with no text at all."""
        document = _mini_document(
            **{
                "/thing": {
                    "get": {"parameters": [{"name": "limit", "in": "query"}]},
                }
            }
        )

        with pytest.raises(ToolBuildError) as raised:
            build_tools(
                document,
                [
                    _route(
                        "list_things",
                        "GET",
                        "/thing",
                        description="d",
                        params={"offset": "how many to skip"},
                    )
                ],
            )

        assert list(raised.value.errors) == [
            'list_things (GET /thing): curated description for "offset", which the '
            "operation does not accept"
        ]


class TestNormalisation:
    def test_anyof_null_collapses_including_the_partial_case(self) -> None:
        """``anyOf: [X, null]`` becomes X — that is why omit = keep and a field
        cannot be cleared through MCP. With TWO real branches left the null is
        dropped but the union stays a union, which is the case a naive "take the
        first branch" port would silently flatten into the wrong type."""
        document = _mini_document(
            **{
                "/thing": {
                    "get": {
                        "parameters": [
                            {
                                "name": "one",
                                "in": "query",
                                "schema": {
                                    "anyOf": [
                                        {"type": "string", "format": "date"},
                                        {"type": "null"},
                                    ]
                                },
                            },
                            {
                                "name": "two",
                                "in": "query",
                                "schema": {
                                    "anyOf": [
                                        {"type": "string"},
                                        {"type": "integer"},
                                        {"type": "null"},
                                    ]
                                },
                            },
                        ]
                    }
                }
            }
        )

        tool = build_tools(
            document, [_route("list_things", "GET", "/thing", description="d")]
        )[0]
        properties: JsonObject = tool.input_schema["properties"]

        assert properties["one"] == {"type": "string", "format": "date"}
        assert properties["two"] == {"anyOf": [{"type": "string"}, {"type": "integer"}]}
