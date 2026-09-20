"""Generator: one FLAT MCP input schema per marked route, built from the contract.

A port of the TypeScript server's ``tools.ts``, kept faithful on purpose — the
snapshot in ``tests/test_mcp_tools.py`` compares what this builds against what the
old server published, tool by tool and byte by byte.

Flat on purpose: a model fills ``{transaction_id, amount_minor}`` far more reliably
than ``{transaction_id, body: {...}}``, and the one real risk of flattening — a body
property colliding with a parameter name — is caught at startup instead of silently
shadowing one of them.

Every problem found while building is COLLECTED, not raised on the spot: a contract
drift usually breaks several tools at once and the operator wants the whole list in
one go.

The document must be the BYTES of ``apps/api/openapi.json``
(``json.loads(openapi_json(app))``), never ``app.openapi()`` straight: the in-memory
schema orders object properties by pydantic field order, the file orders them
alphabetically (``sort_keys``), and the order of ``required`` follows the order of
``properties``.
"""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any, Literal, cast

from budget_api.mcp.decorator import ManagedBodyValue
from budget_api.mcp.exposure import RouteTool

JsonObject = dict[str, Any]

ToolScope = Literal["read", "write"]
TokenScope = Literal["read", "full"]

_JSON_CONTENT_TYPE = "application/json"

#: Immutable, so it is safe as a shared dataclass default.
_NO_MANAGED_BODY: Mapping[str, ManagedBodyValue] = MappingProxyType({})
_SCHEMA_REF_PREFIX = "#/components/schemas/"


class OpenApiError(Exception):
    """Anything wrong with the contract: malformed node, unresolvable ``$ref``."""


def as_object(value: Any) -> JsonObject | None:
    """A JSON object, or None.

    The cast is the type checker's price for reading a document (or a response
    body) whose shape is only known where it is used.
    """
    return cast(JsonObject, value) if isinstance(value, dict) else None


def as_array(value: Any) -> list[Any] | None:
    """A JSON array, or None — the companion of :func:`as_object`."""
    return cast("list[Any]", value) if isinstance(value, list) else None


class ToolBuildError(Exception):
    """Marker ↔ contract drift. Carries EVERY failure, not just the first."""

    def __init__(self, errors: Sequence[str]) -> None:
        self.errors: tuple[str, ...] = tuple(errors)
        super().__init__(
            "the tool allowlist is out of sync with openapi.json — regenerate the "
            "contract (`pnpm openapi` at the repo root) and rebuild:\n"
            + "\n".join(f"  - {line}" for line in errors)
        )


@dataclass(frozen=True)
class OpenApiDocument:
    """The contract, split into what the builder reads from it."""

    source: str
    paths: JsonObject
    schemas: JsonObject


def parse_document(raw: Any, source: str = "the exported contract") -> OpenApiDocument:
    """Validate the top level; deeper nodes are checked where they are used."""
    document = as_object(raw)
    if document is None:
        raise OpenApiError(f"{source} does not contain an OpenAPI document")
    paths = as_object(document.get("paths"))
    if paths is None:
        raise OpenApiError(f'{source} has no "paths" object')
    components = as_object(document.get("components"))
    schemas = as_object(components.get("schemas")) if components else None
    return OpenApiDocument(source=source, paths=paths, schemas=schemas or {})


@dataclass(frozen=True)
class BuiltTool:
    """One publishable tool: prose from the marker, schema from the contract."""

    name: str
    description: str
    scope: ToolScope
    method: str
    path: str
    input_schema: JsonObject
    #: Filled into the ``{placeholders}`` of ``path``.
    path_params: tuple[str, ...] = ()
    #: Serialised into the query string.
    query_params: tuple[str, ...] = ()
    #: Serialised into the JSON request body, taken from the model's arguments.
    body_props: tuple[str, ...] = ()
    #: Body properties kept OUT of ``input_schema`` and filled by the server
    #: itself: property name → how ``http.py`` produces the value. They live here
    #: and nowhere else, so the call layer never needs to know which tool it serves.
    managed_body: Mapping[str, ManagedBodyValue] = _NO_MANAGED_BODY

    def as_snapshot(self) -> JsonObject:
        """The TypeScript server's ``BuiltTool`` shape, for the snapshot test.

        The ONE normalisation is the case of ``method``: the walk reports HTTP
        methods as the framework spells them (``GET``), the old table spelled them
        lowercase. Everything else is compared as it is built.
        """
        return {
            "name": self.name,
            "description": self.description,
            "scope": self.scope,
            "method": self.method.lower(),
            "path": self.path,
            "inputSchema": self.input_schema,
            "pathParams": list(self.path_params),
            "queryParams": list(self.query_params),
            "bodyProps": list(self.body_props),
            "managedBody": dict(self.managed_body),
        }


def _omit(source: Mapping[str, Any], keys: Iterable[str]) -> JsonObject:
    dropped = set(keys)
    return {key: value for key, value in source.items() if key not in dropped}


def _is_null_branch(branch: Any) -> bool:
    node = as_object(branch)
    return node is not None and node.get("type") == "null"


def _resolve_ref(doc: OpenApiDocument, ref: str) -> JsonObject:
    """Only local component schemas resolve — nothing else is emitted by FastAPI."""
    if not ref.startswith(_SCHEMA_REF_PREFIX):
        raise OpenApiError(
            f'unsupported $ref "{ref}" (only {_SCHEMA_REF_PREFIX}* is resolvable)'
        )
    name = ref[len(_SCHEMA_REF_PREFIX) :]
    target = as_object(doc.schemas.get(name))
    if target is None:
        raise OpenApiError(
            f'unknown $ref "{ref}" — schema "{name}" is not in {doc.source}'
        )
    return target


def _get_operation(doc: OpenApiDocument, path: str, method: str) -> JsonObject | None:
    item = as_object(doc.paths.get(path))
    if item is None:
        return None
    return as_object(item.get(method.lower()))


def normalize_schema(
    doc: OpenApiDocument, schema: Any, seen_refs: frozenset[str]
) -> JsonObject:
    """Inline ``$ref``s and simplify the schema for a model audience.

    * ``title`` goes away at every level (pydantic emits "Amount Minor" for every
      field — noise);
    * a component's own ``title``/``description`` describe the COMPONENT, not the
      field referencing it, so they are dropped on inlining and the referencing
      node's own keys win;
    * ``anyOf: [X, {"type": "null"}]`` collapses to ``X``. That also removes the
      ability to send an explicit ``null``, i.e. to CLEAR a field in a PATCH:
      omit = keep, and there is no clearing through MCP (a deliberate v1 trade-off).

    ``format``, ``pattern``, ``enum``, ``minimum``, ``maximum`` and ``default``
    survive — they are the only machine-readable hints the model gets.
    """
    node = as_object(schema)
    if node is None:
        raise OpenApiError(f"expected a schema object, got {schema!r}")
    current: JsonObject = node
    seen = seen_refs

    ref: Any = current.get("$ref")
    if isinstance(ref, str):
        if ref in seen:
            raise OpenApiError(
                f'circular $ref "{ref}" cannot be flattened into a tool schema'
            )
        seen = seen | {ref}
        current = {
            **_omit(_resolve_ref(doc, ref), ("title", "description")),
            **_omit(current, ("$ref",)),
        }

    any_of = as_array(current.get("anyOf"))
    if any_of is not None:
        branches: list[Any] = [b for b in any_of if not _is_null_branch(b)]
        if len(branches) == 1:
            current = {
                **_omit(current, ("anyOf",)),
                **normalize_schema(doc, branches[0], seen),
            }
        elif len(branches) != len(any_of):
            current = {
                **current,
                "anyOf": [normalize_schema(doc, b, seen) for b in branches],
            }

    properties = as_object(current.get("properties"))
    if properties is not None:
        current = {
            **current,
            "properties": {
                name: normalize_schema(doc, prop, seen)
                for name, prop in properties.items()
            },
        }
    if "items" in current:
        current = {**current, "items": normalize_schema(doc, current["items"], seen)}

    return _omit(current, ("title",))


def _managed_value_problem(kind: ManagedBodyValue, schema: JsonObject) -> str | None:
    """A managed property must be something the server can actually produce.

    This check is what turns "the contract retyped client_id" from a silent 422 on
    the user's first write into a startup error next to every other drift.
    """
    if kind == "uuid" and schema.get("type") != "string":
        return (
            "is filled with a generated uuid, but the contract types it as "
            f"{schema.get('type')!r}"
        )
    return None


def _string_list(value: Any) -> list[str]:
    entries = as_array(value) or []
    return [entry for entry in entries if isinstance(entry, str)]


@dataclass
class _Accumulator:
    properties: JsonObject = field(default_factory=dict[str, Any])
    required: list[str] = field(default_factory=list[str])
    #: Property name → where it came from, for the collision message.
    origins: dict[str, str] = field(default_factory=dict[str, str])
    path_params: list[str] = field(default_factory=list[str])
    query_params: list[str] = field(default_factory=list[str])
    body_props: list[str] = field(default_factory=list[str])


def _build_one(
    doc: OpenApiDocument, route: RouteTool, errors: list[str]
) -> BuiltTool | None:
    spec = route.spec
    label = f"{spec.name} ({route.method.upper()} {route.path})"
    operation = _get_operation(doc, route.path, route.method)
    if operation is None:
        errors.append(f"{label}: no such path+method in the contract")
        return None

    acc = _Accumulator()
    failed = False
    managed_body = spec.managed_body
    #: Managed names actually found in the body — the rest are drift (below).
    managed_found: set[str] = set()

    def add(name: str, schema: JsonObject, required: bool, origin: str) -> None:
        nonlocal failed
        previous = acc.origins.get(name)
        if previous is not None:
            errors.append(
                f'{label}: "{name}" is both a {previous} and a {origin} — '
                "flattening would shadow one of them"
            )
            failed = True
            return
        acc.origins[name] = origin
        acc.properties[name] = schema
        if required:
            acc.required.append(name)

    try:
        parameters = as_array(operation.get("parameters"))
        if parameters is not None:
            for entry in parameters:
                parameter = as_object(entry)
                name = parameter.get("name") if parameter else None
                location = parameter.get("in") if parameter else None
                if (
                    parameter is None
                    or not isinstance(name, str)
                    or not isinstance(location, str)
                ):
                    errors.append(f"{label}: malformed parameter entry {entry!r}")
                    failed = True
                    continue
                if location not in ("path", "query"):
                    # A header/cookie parameter would need a value the model cannot
                    # know; losing it silently would send a broken request.
                    errors.append(
                        f'{label}: unsupported "{location}" parameter "{name}" — '
                        "only path and query are supported"
                    )
                    failed = True
                    continue
                schema = normalize_schema(
                    doc, parameter.get("schema") or {}, frozenset()
                )
                description = parameter.get("description")
                if isinstance(description, str) and "description" not in schema:
                    schema["description"] = description
                add(
                    name,
                    schema,
                    parameter.get("required") is True,
                    f"{location} parameter",
                )
                if location == "path":
                    acc.path_params.append(name)
                else:
                    acc.query_params.append(name)

        request_body = as_object(operation.get("requestBody"))
        if request_body is not None:
            content = as_object(request_body.get("content"))
            media = as_object(content.get(_JSON_CONTENT_TYPE)) if content else None
            if media is None or media.get("schema") is None:
                errors.append(
                    f"{label}: request body has no {_JSON_CONTENT_TYPE} schema"
                )
                failed = True
            else:
                body = normalize_schema(doc, media["schema"], frozenset())
                body_properties = as_object(body.get("properties"))
                if body_properties is None:
                    errors.append(
                        f"{label}: request body is not an object schema with properties"
                    )
                    failed = True
                else:
                    body_required = set(_string_list(body.get("required")))
                    for prop_name, raw_prop in body_properties.items():
                        prop = as_object(raw_prop)
                        if prop is None:
                            errors.append(
                                f'{label}: body property "{prop_name}" is not a '
                                "schema object"
                            )
                            failed = True
                            continue
                        managed = managed_body.get(prop_name)
                        if managed is not None:
                            # Deliberately NOT added to the schema: a property the
                            # server fills must be invisible to the model, or the
                            # model can forge it.
                            managed_found.add(prop_name)
                            problem = _managed_value_problem(managed, prop)
                            if problem is not None:
                                errors.append(
                                    f'{label}: managed body property "{prop_name}" '
                                    f"{problem}"
                                )
                                failed = True
                            continue
                        add(
                            prop_name,
                            prop,
                            prop_name in body_required,
                            "body property",
                        )
                        acc.body_props.append(prop_name)
    except OpenApiError as error:
        errors.append(f"{label}: {error}")
        return None

    for missing in managed_body:
        if missing in managed_found:
            continue
        errors.append(
            f'{label}: managed body property "{missing}", which the request body '
            "does not have"
        )
        failed = True

    for curated_name, curated in spec.params.items():
        schema = as_object(acc.properties.get(curated_name))
        if schema is None:
            errors.append(
                f'{label}: curated description for "{curated_name}", which the '
                "operation does not accept"
            )
            failed = True
            continue
        schema["description"] = curated

    if failed:
        return None

    return BuiltTool(
        name=spec.name,
        description=spec.description,
        scope=scope_of(route.method),
        method=route.method,
        path=route.path,
        input_schema={
            "type": "object",
            "properties": acc.properties,
            "required": acc.required,
            "additionalProperties": False,
        },
        path_params=tuple(acc.path_params),
        query_params=tuple(acc.query_params),
        body_props=tuple(acc.body_props),
        managed_body=dict(managed_body),
    )


def scope_of(method: str) -> ToolScope:
    """read ⇔ GET; a departure from that rule is possible only through an explicit
    parameter, which deliberately does not exist yet (mcp/decorator.py).

    The runtime gate decides by method as well (``pat_auth._WRITE_METHODS``), so a
    tool that claimed otherwise could only teach the model to loop on 403s.
    """
    return "read" if method.upper() == "GET" else "write"


def tools_for_scope(
    tools: Sequence[BuiltTool], scope: TokenScope
) -> tuple[BuiltTool, ...]:
    """What a token of this scope may SEE.

    A read token is never shown a write tool — including ``delete_transaction``:
    the server would refuse the call anyway (it is the only enforcement), but an
    advertised tool teaches the model to loop on something that cannot succeed.
    """
    return tuple(tool for tool in tools if scope == "full" or tool.scope == "read")


def _wire_numbers(value: object) -> object:
    """Whole-valued floats become ints, recursively — the shape clients always saw.

    ``openapi.json`` spells the money bounds as ``999999999999999.0``. The old
    server ran the schema through ``JSON.stringify``, which prints an integral
    number without a fraction, so every client ever received ``999999999999999``.
    Python's ``json.dumps`` keeps the ``.0``; without this pass the two servers'
    ``tools/list`` differ in 58 places while ``1 == 1.0`` hides it from a test
    that compares parsed objects. Bools are left alone: ``True`` is an int in
    Python and must stay a bool on the wire.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _wire_numbers(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_wire_numbers(v) for v in value]
    return value


def build_tools(
    doc: OpenApiDocument, routes: Sequence[RouteTool]
) -> tuple[BuiltTool, ...]:
    """Build every tool, or raise ONE error listing everything that is wrong."""
    errors: list[str] = []
    tools: list[BuiltTool] = []
    names: set[str] = set()

    for route in routes:
        if route.spec.name in names:
            errors.append(f"{route.spec.name}: duplicate tool name in the allowlist")
            continue
        names.add(route.spec.name)
        tool = _build_one(doc, route, errors)
        if tool is not None:
            schema = _wire_numbers(tool.input_schema)
            assert isinstance(schema, dict)
            tools.append(replace(tool, input_schema=schema))

    if errors:
        raise ToolBuildError(errors)
    return tuple(tools)
