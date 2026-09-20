"""The stdio MCP server: the pieces that are NOT proved by the tool snapshot.

The snapshot (test_mcp_tools.py) proves what the model sees. This file covers what
happens when it calls: the idempotency key that must be fresh per logical call, the
size guard, the three gates of the hand-written upload tool, the SDK glue driven by
a real in-memory client, and the rule that keeps the whole thing usable at all —
nothing but JSON-RPC on stdout.

API answers are served by ``httpx.MockTransport``: the process boundary is mocked,
everything on this side of it runs for real.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest
from mcp.client.session import ClientSession
from mcp.shared.memory import create_client_server_memory_streams

from budget_api.mcp.http import (
    ApiConfig,
    ConfigError,
    Err,
    Ok,
    build_request_body,
    describe_api_error,
)
from budget_api.mcp.server import build_published_tools, build_server
from budget_api.mcp.tools import BuiltTool
from budget_api.mcp.truncate import THRESHOLD_BYTES, byte_length, truncate_response
from budget_api.mcp.upload_receipt import (
    UPLOAD_TOOL_NAME,
    UploadConfig,
    is_inside,
    is_jpeg,
    read_upload_config,
    resolve_upload_path,
    upload_receipt,
)

JPEG_HEAD = b"\xff\xd8\xff\xe0"
CONFIG = ApiConfig(base_url="http://api.test", token="bgt_pat_test")


def _create_tool(**overrides: Any) -> BuiltTool:
    defaults: dict[str, Any] = {
        "name": "create_transaction",
        "description": "",
        "scope": "write",
        "method": "POST",
        "path": "/transactions",
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        },
        "body_props": ("amount_minor", "note"),
        "managed_body": {"client_id": "uuid"},
    }
    return BuiltTool(**{**defaults, **overrides})


def _row(index: int) -> dict[str, Any]:
    return {
        "id": f"00000000-0000-0000-0000-{index:012d}",
        "amount_minor": 1234 + index,
        "merchant": "A merchant name long enough to make these rows weigh something",
        "occurred_at": "2026-08-19",
    }


@pytest.fixture
def upload_dirs(tmp_path: Path) -> Iterator[tuple[Path, Path]]:
    """An allowed folder and a sibling that is NOT allowed, both real paths."""
    root = tmp_path.resolve()
    allowed = root / "allowed"
    outside = root / "elsewhere"
    allowed.mkdir()
    outside.mkdir()
    yield allowed, outside


class TestIdempotencyKey:
    def test_every_logical_call_gets_its_own_client_id(self) -> None:
        """Two deliberate calls are two transactions; only a REPLAY of one call
        reuses its key. A shared client_id would turn the second transaction into
        a replay of the first and the user would silently lose a row."""
        tool = _create_tool()

        first = build_request_body(tool, {"amount_minor": 1}) or {}
        second = build_request_body(tool, {"amount_minor": 1}) or {}

        assert first["client_id"] != second["client_id"]
        # `note` was not given: omitted, not null — on a PATCH that is the
        # difference between "keep it" and "clear it".
        assert list(first) == ["amount_minor", "client_id"]
        assert (
            build_request_body(_create_tool(body_props=(), managed_body={}), {}) is None
        )


class TestApiErrorMessages:
    """The five shapes a refusal arrives in — each mapped to a different sentence.

    These sentences are the only thing the user sees when a call fails, and they
    were transcribed by hand from the TypeScript server. A typo or a dropped branch
    is invisible until it happens live, so the branches are pinned here: the mapped
    codes, the no-oracle wording, the pass-through for an unknown code, pydantic's
    error array, and a 429 whose body is not JSON at all (a proxy page), which must
    still say "wait a minute" rather than dumping HTML at the model.
    """

    @pytest.mark.parametrize(
        ("status", "text", "expected"),
        [
            (
                403,
                '{"detail": "TOKEN_SCOPE_READONLY"}',
                "This token is read-only — create a `full` token in the web app "
                "(Settings) to make changes.",
            ),
            (
                404,
                '{"detail": "TRANSACTION_NOT_FOUND"}',
                "TRANSACTION_NOT_FOUND: not found (it does not exist, or it is "
                "not yours).",
            ),
            (
                422,
                '{"detail": "ACCOUNT_CURRENCY_MISMATCH"}',
                "The Budget API rejected the call (HTTP 422): "
                "ACCOUNT_CURRENCY_MISMATCH",
            ),
            (
                422,
                '{"detail": [{"loc": ["body", "amount_minor"], '
                '"msg": "Input should be a valid integer"}]}',
                "The Budget API rejected the arguments:\n"
                "  - body.amount_minor: Input should be a valid integer",
            ),
            (
                429,
                "<html>429 Too Many Requests</html>",
                "Too many API calls — wait a minute before trying again.",
            ),
        ],
    )
    def test_each_refusal_shape_gets_its_own_sentence(
        self, status: int, text: str, expected: str
    ) -> None:
        assert describe_api_error(status, text) == expected


class TestTruncation:
    def test_a_response_under_the_threshold_is_untouched(self) -> None:
        payload = {"items": [_row(1), _row(2)], "total": 2}

        assert truncate_response(payload) is payload

    def test_the_longest_array_is_cut_from_the_tail_and_the_cut_is_stated(self) -> None:
        """A silent cut would let the model quote a total it never saw."""
        items = [_row(index) for index in range(600)]
        assert byte_length({"items": items}) > THRESHOLD_BYTES

        result = truncate_response({"items": items, "total": 600})

        assert byte_length(result) <= THRESHOLD_BYTES
        assert result["items"][0] == _row(0)
        assert result["_truncated"]["shown"] == len(result["items"])
        assert result["_truncated"]["total"] == 600
        assert result["total"] == 600

    def test_one_element_survives_even_when_it_alone_is_too_big(self) -> None:
        """An empty shell with a marker answers nothing at all."""
        fat = {"note": "x" * THRESHOLD_BYTES}

        result = truncate_response({"items": [fat, fat, fat]})

        assert result["items"] == [fat]
        assert result["_truncated"]["shown"] == 1
        assert result["_truncated"]["total"] == 3

    def test_a_bare_array_is_wrapped_so_the_marker_has_somewhere_to_live(self) -> None:
        result = truncate_response([_row(index) for index in range(600)])

        assert result["items"][0] == _row(0)
        assert result["_truncated"]["total"] == 600


class TestUploadGates:
    def test_jpeg_is_decided_by_content_not_by_name(self) -> None:
        """A PNG renamed to .jpg is the whole reason this check exists."""
        assert is_jpeg(JPEG_HEAD)
        assert not is_jpeg(b"\x89PNG")
        # A truncated header is not "close enough".
        assert not is_jpeg(b"\xff\xd8")

    def test_a_sibling_folder_with_the_same_prefix_is_outside(self) -> None:
        """The bug this pins: "/a/uploads" also prefixes "/a/uploads-evil"."""
        fence = Path("/a/uploads")

        assert is_inside(fence, Path("/a/uploads/x.jpg"))
        assert is_inside(fence, fence)
        assert not is_inside(fence, Path("/a/uploads-evil/x.jpg"))

    async def test_no_directory_means_no_filesystem_access_at_all(self) -> None:
        """The default posture, and the reason the tool is not published at all."""
        assert (await read_upload_config({})).directory is None
        assert (
            await read_upload_config({"BUDGET_UPLOAD_DIR": "   "})
        ).directory is None

    async def test_a_relative_directory_is_refused_at_startup(self) -> None:
        """It would depend on where the client happened to launch this server."""
        with pytest.raises(ConfigError, match="absolute path"):
            await read_upload_config({"BUDGET_UPLOAD_DIR": "uploads"})

    async def test_climbing_out_of_the_folder_is_refused(
        self, upload_dirs: tuple[Path, Path]
    ) -> None:
        """`..` is collapsed BEFORE the comparison, so the escape is caught."""
        allowed, outside = upload_dirs
        (allowed / "receipt.jpg").write_bytes(JPEG_HEAD)
        (outside / "secret.jpg").write_bytes(JPEG_HEAD)

        inside = await resolve_upload_path(allowed, "receipt.jpg")
        climbed = await resolve_upload_path(allowed, "../elsewhere/secret.jpg")

        assert inside == allowed / "receipt.jpg"
        assert isinstance(climbed, Err)
        assert "outside the allowed upload folder" in climbed.message

    async def test_a_symlink_is_followed_before_it_is_judged(
        self, upload_dirs: tuple[Path, Path]
    ) -> None:
        """The link LIVES inside the folder; only its target betrays it. Comparing
        the requested path instead of the real one would let this through."""
        allowed, outside = upload_dirs
        secret = outside / "id_rsa.jpg"
        secret.write_bytes(JPEG_HEAD)
        (allowed / "innocent.jpg").symlink_to(secret)

        linked = await resolve_upload_path(allowed, "innocent.jpg")

        assert isinstance(linked, Err)
        assert "outside the allowed upload folder" in linked.message

    async def test_a_missing_file_is_a_plain_answer_not_a_crash(
        self, upload_dirs: tuple[Path, Path]
    ) -> None:
        missing = await resolve_upload_path(upload_dirs[0], "nope.jpg")

        assert isinstance(missing, Err)
        assert missing.message == 'No file at "nope.jpg".'

    async def test_a_non_jpeg_never_reaches_the_api(
        self, upload_dirs: tuple[Path, Path]
    ) -> None:
        """The content gate runs before the first API call, so a wrong file costs
        the user nothing — no receipt row, no signed URL, no stored object."""
        allowed, _ = upload_dirs
        (allowed / "screenshot.jpg").write_bytes(b"\x89PNG\r\n\x1a\n")
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            return httpx.Response(201, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await upload_receipt(
                client, CONFIG, UploadConfig(directory=allowed), "screenshot.jpg"
            )

        assert isinstance(result, Err)
        assert "is not a JPEG" in result.message
        assert calls == []

    async def test_the_happy_path_creates_puts_and_reads_back(
        self, upload_dirs: tuple[Path, Path]
    ) -> None:
        """Three steps, in the API's own order — and the answer is what the server
        says about the receipt, not what this code hoped happened."""
        allowed, _ = upload_dirs
        (allowed / "receipt.jpg").write_bytes(JPEG_HEAD)
        seen: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append((request.method, str(request.url)))
            if request.url.path == "/receipts" and request.method == "POST":
                return httpx.Response(
                    201,
                    json={
                        "id": "r-1",
                        "upload": {
                            "url": "http://storage.test/r-1.jpg",
                            "headers": {"Content-Type": "image/jpeg"},
                        },
                    },
                )
            if request.method == "PUT":
                assert request.content == JPEG_HEAD
                return httpx.Response(200)
            return httpx.Response(200, json={"id": "r-1", "status": "uploaded"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await upload_receipt(
                client, CONFIG, UploadConfig(directory=allowed), "receipt.jpg"
            )

        assert isinstance(result, Ok)
        assert result.data == {"id": "r-1", "status": "uploaded"}
        assert seen == [
            ("POST", "http://api.test/receipts"),
            ("PUT", "http://storage.test/r-1.jpg"),
            ("GET", "http://api.test/receipts/r-1"),
        ]

    async def test_a_redirected_put_is_not_an_upload(
        self, upload_dirs: tuple[Path, Path]
    ) -> None:
        """A 3xx from storage is not success. The client does not follow
        redirects, and `is_error` covers only 4xx/5xx — so a 307 on the PUT
        would once have been reported as "uploaded" with no object behind it,
        while the receipt_id went on to be attached to a transaction."""
        allowed, _ = upload_dirs
        (allowed / "receipt.jpg").write_bytes(JPEG_HEAD)
        read_back = False

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal read_back
            if request.url.path == "/receipts" and request.method == "POST":
                return httpx.Response(
                    201,
                    json={
                        "id": "r-1",
                        "upload": {"url": "http://storage.test/r-1.jpg"},
                    },
                )
            if request.method == "PUT":
                return httpx.Response(307, headers={"Location": "http://elsewhere/"})
            read_back = True
            return httpx.Response(200, json={"id": "r-1"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            result = await upload_receipt(
                client, CONFIG, UploadConfig(directory=allowed), "receipt.jpg"
            )

        assert isinstance(result, Err)
        assert "HTTP 307" in result.message
        # Nothing is read back: there is no upload to report on.
        assert read_back is False


class TestSdkGlue:
    async def test_an_in_memory_client_lists_and_calls_the_published_tools(
        self, upload_dirs: tuple[Path, Path]
    ) -> None:
        """The SDK wiring itself: list_tools and call_tool over a real session.

        36 names for a `full` token with an upload folder — the 35 generated tools
        plus the hand-written one — and an unknown name comes back as a tool ERROR
        the model can read, never as a protocol failure it cannot.
        """
        tools = build_published_tools()

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"items": [], "total": 0})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            server, published = build_server(
                client, CONFIG, tools, UploadConfig(directory=upload_dirs[0]), "full"
            )
            async with (
                create_client_server_memory_streams() as (
                    (client_read, client_write),
                    (server_read, server_write),
                ),
                anyio.create_task_group() as task_group,
            ):

                async def run_server() -> None:
                    await server.run(
                        server_read,
                        server_write,
                        server.create_initialization_options(),
                        raise_exceptions=True,
                    )

                task_group.start_soon(run_server)
                async with ClientSession(client_read, client_write) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    called = await session.call_tool("list_categories", {})
                    unknown = await session.call_tool("no_such_tool", {})

                    names = [tool.name for tool in listed.tools]
                    assert published == 36
                    assert len(names) == 36
                    assert UPLOAD_TOOL_NAME in names
                    assert called.is_error is not True
                    assert unknown.is_error is True
                task_group.cancel_scope.cancel()

    async def test_a_full_token_without_an_upload_folder_has_no_upload_tool(
        self,
    ) -> None:
        """Both conditions or nothing: a published tool that always refuses is
        worse than a missing one — the model keeps offering it to the user."""
        tools = build_published_tools()

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            _, published = build_server(
                client, CONFIG, tools, UploadConfig(directory=None), "full"
            )

        assert published == 35


class TestStdoutDiscipline:
    def test_building_the_app_and_the_tools_writes_nothing_to_stdout(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """stdout belongs to the JSON-RPC transport, so building the published
        tools must print nothing. Module imports are NOT covered here — they run at
        collection, before capsys listens; what this pins is the start-up work
        itself (`build_export_app()` and tool assembly) staying silent."""
        tools = build_published_tools()

        captured = capsys.readouterr()

        assert len(tools) == 35
        assert captured.out == ""
