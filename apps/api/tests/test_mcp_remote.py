"""The remote MCP transport: ``/mcp`` driven the way Claude drives it.

No SDK client here, deliberately. ``streamablehttp_client`` wants its own HTTP
stack and opens a standalone GET stream that a ``json_response=True`` server has
nothing to answer with; what Claude's connector actually sends is one
self-contained JSON-RPC POST per call. The manager is stateless, so the SDK's
legacy stateless connection is born ready — "need not see ``initialize``"
(``streamable_http_manager.py``) — and every request below is therefore exactly
one POST with no handshake and no ``MCP-Protocol-Version`` header.

The app is built with ``public_base_url`` set (ruling R6 allows ``http://`` for
loopback only), because without it neither ``/mcp`` nor the OAuth routes are
registered at all — the state of the rest of the suite. The bearer comes from the
real flow through ``helpers.connect_oauth_app``: a grant obtained any other way
would prove nothing about the credential the transport actually receives.

Deliberately NOT here: the tool schemas (``test_mcp_tools.py`` owns the snapshot),
the two handlers' wiring over a real session (``test_mcp_server.py``'s in-memory
client), and the enforcement pipeline a grant reaches through an ordinary request
(``test_oauth_server.py::TestGrantEnforcement``). What is left — and what this
file is for — is the HTTP seam between them.
"""

import json
import uuid
from typing import Any, NoReturn

import pytest
from helpers import account_for_currency, connect_oauth_app
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.mcp.upload_receipt import UPLOAD_TOOL_NAME

PASSWORD = "password123"
PUBLIC_BASE_URL = "http://localhost"

#: The exact bytes ``RequireAuthMiddleware`` answers an anonymous call with. Pinned
#: because this header is the whole discovery handshake: Claude reads
#: ``resource_metadata`` out of it, fetches that document, finds the authorization
#: server and starts DCR. A changed quote or a dropped field means "cannot connect"
#: with no further diagnosis available to the user.
WWW_AUTHENTICATE = (
    'Bearer error="invalid_token", '
    'error_description="Authentication required", '
    f'resource_metadata="{PUBLIC_BASE_URL}'
    '/.well-known/oauth-protected-resource/mcp"'
)


async def _register_and_login(client: AsyncClient, email: str) -> dict[str, str]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


async def _rpc(
    client: AsyncClient,
    token: str | None,
    method: str,
    params: dict[str, Any] | None = None,
) -> Response:
    """One JSON-RPC request over ``/mcp``, exactly as a remote client sends it."""
    headers = {
        # Both types: a client cannot know in advance whether this server answers
        # with a JSON body or an SSE stream.
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    return await client.post("/mcp", json=body, headers=headers)


def _result(response: Response) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    payload: dict[str, Any] = response.json()
    assert "error" not in payload, payload
    result: dict[str, Any] = payload["result"]
    return result


def _text(result: dict[str, Any]) -> str:
    content: list[dict[str, Any]] = result["content"]
    assert len(content) == 1, content
    text_block: str = content[0]["text"]
    return text_block


class TestUnauthenticated:
    async def test_get_and_post_without_a_bearer_answer_401_and_never_a_redirect(
        self, make_client: Any
    ) -> None:
        """The 401 is the connector's entry point, and a 3xx would break it.

        ``/mcp`` is a ``Route`` and not a ``Mount`` precisely so the router cannot
        answer the bare path with a 307 to ``/mcp/`` — a redirect every HTTP client
        follows WITHOUT the ``Authorization`` header. httpx does not follow
        redirects by default, so the status assertion below is also the "no 3xx"
        assertion.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)

        got = await client.get("/mcp")
        posted = await _rpc(client, None, "tools/list")

        for response in (got, posted):
            assert response.status_code == 401, response.text
            assert response.headers["www-authenticate"] == WWW_AUTHENTICATE


class TestPublishedSurface:
    @pytest.mark.parametrize(("mode", "count"), [("read", 23), ("full", 41)])
    async def test_tools_list_follows_the_grant_s_mode_and_never_offers_upload(
        self, make_client: Any, mode: str, count: int
    ) -> None:
        """The mode the user picked on the consent page IS the published surface.

        Same two counts as stdio (``test_mcp_tools.py`` pins the names), reached
        here through a bearer rather than through ``GET /tokens/self`` — the whole
        point of the per-request credential. ``upload_receipt`` is in neither
        list: it reads a path on the MCP server's filesystem, which remotely is
        the API container's.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers = await _register_and_login(client, f"list-{mode}@example.com")
        connected = await connect_oauth_app(client, headers, scope=mode)

        listed = _result(await _rpc(client, connected.access_token, "tools/list"))

        names = [tool["name"] for tool in listed["tools"]]
        assert len(names) == count
        assert UPLOAD_TOOL_NAME not in names


class TestToolCalls:
    async def test_a_read_call_returns_data_and_audits_the_grant_once(
        self, make_client: Any, db_session: AsyncSession
    ) -> None:
        """The call is a real request back into this app, as the grant.

        Two facts prove that and nothing else does: the model gets the account the
        API has (so the inner request was authenticated by the caller's own
        bearer), and ``pat_audit_log`` holds EXACTLY one row for the grant — the
        inner ``GET /accounts``. Exactly one is also the stdio-parity statement:
        the ``tools/list`` before it is protocol traffic and is not audited.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers = await _register_and_login(client, "call@example.com")
        account = await account_for_currency(client, headers)
        connected = await connect_oauth_app(client, headers, scope="read")

        _result(await _rpc(client, connected.access_token, "tools/list"))
        called = _result(
            await _rpc(
                client,
                connected.access_token,
                "tools/call",
                {"name": "list_accounts", "arguments": {}},
            )
        )

        assert called.get("isError") is not True
        assert [row["id"] for row in json.loads(_text(called))] == [account]
        audited = (
            await db_session.execute(
                text(
                    "SELECT method, path, status_code FROM pat_audit_log "
                    "WHERE token_id = :grant ORDER BY occurred_at"
                ),
                {"grant": uuid.UUID(connected.grant_id)},
            )
        ).all()
        assert [tuple(row) for row in audited] == [("GET", "/accounts", 200)]

    async def test_a_write_tool_is_unknown_to_a_read_grant_and_makes_no_request(
        self, make_client: Any
    ) -> None:
        """A read connector cannot reach a write tool even by name.

        The refusal is ``Unknown tool`` and NOT the API's ``TOKEN_SCOPE_READONLY``
        sentence, and that is on purpose: the dispatch table is rebuilt per request
        from the caller's own mode, so the name a read grant was never offered does
        not exist for it. The API's scope gate stays the backstop (it is what
        answers an ordinary request — ``test_oauth_server.py``), but no HTTP call
        is made here at all, which the untouched account list proves.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers = await _register_and_login(client, "readonly@example.com")
        connected = await connect_oauth_app(client, headers, scope="read")

        refused = _result(
            await _rpc(
                client,
                connected.access_token,
                "tools/call",
                {
                    "name": "create_account",
                    "arguments": {"name": "Nope", "currency": "USD", "type": "card"},
                },
            )
        )

        assert refused["isError"] is True
        assert _text(refused) == 'Unknown tool "create_account".'
        assert (await client.get("/accounts", headers=headers)).json() == []

    async def test_an_inner_500_reaches_the_model_as_text_not_as_an_exception(
        self, make_client: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``raise_app_exceptions=False`` on the inner transport, pinned.

        With the default ``True`` the inner failure would be raised INSIDE the
        JSON-RPC handler, and the model would get a protocol error it cannot read
        or act on instead of a sentence. The seam is the balance query of
        ``GET /accounts``, which is as close to an unexpected 500 as this app can
        be made to produce on purpose.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers = await _register_and_login(client, "boom@example.com")
        connected = await connect_oauth_app(client, headers, scope="read")

        async def boom(*_args: Any, **_kwargs: Any) -> NoReturn:
            raise RuntimeError("inner failure")

        monkeypatch.setattr("budget_api.routers.accounts.account_balances", boom)

        failed = _result(
            await _rpc(
                client,
                connected.access_token,
                "tools/call",
                {"name": "list_accounts", "arguments": {}},
            )
        )

        assert failed["isError"] is True
        assert "HTTP 500" in _text(failed)


class TestRevocation:
    async def test_a_revoked_grant_is_401_at_the_transport(
        self, make_client: Any
    ) -> None:
        """Settings → Revoke kills the connector itself, not just the API calls.

        One resolver serves both the ``/mcp`` bearer check and ``pat_auth``, so
        this cannot drift from ``test_oauth_server.py``'s revocation test; what is
        new here is that the transport answers the SAME 401 + metadata pointer an
        anonymous call gets, which is what makes Claude re-authenticate rather
        than report a broken server.
        """
        client = await make_client(public_base_url=PUBLIC_BASE_URL)
        headers = await _register_and_login(client, "revoked@example.com")
        connected = await connect_oauth_app(client, headers, scope="full")
        _result(await _rpc(client, connected.access_token, "tools/list"))

        revoked = await client.delete(
            f"/oauth/apps/{connected.grant_id}", headers=headers
        )
        assert revoked.status_code == 204

        after = await _rpc(client, connected.access_token, "tools/list")
        assert after.status_code == 401
        assert after.headers["www-authenticate"] == WWW_AUTHENTICATE
