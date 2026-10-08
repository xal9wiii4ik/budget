# Implementation Plan: mcp-remote — backend (B1 + B2)

Follows `architecture.md` verbatim except where rulings R1–R6 amend it (marked `[R#]`).

## Approach

Two seams. **B1: an OAuth 2.1 AS bolted onto the existing app as plain Starlette
routes** — the SDK's handlers do the RFC work, our `oauth/` package owns storage, policy
and consent only. The grant is a `personal_access_tokens` row, so the single enforcement
pipeline (`pat_auth` → allowlist → scope → `pat_audit`) is reached by ONE prefix branch
and nothing else. B1 is fully testable with httpx against the ASGI app: no transport, no
SDK client, no network.

**B2: the `/mcp` transport** — the SDK's stateless streamable-HTTP manager behind its
bearer middleware, tool calls being ordinary requests back into the same app through
`httpx.ASGITransport`. The one new idea is a per-request credential: `build_server`
stops closing over one `(client, ApiConfig, scope)` triple and takes a callable deriving
it from `ctx.request.scope["user"]` (verified: the SDK attaches the Starlette `Request`
to every message in BOTH protocol eras — `streamable_http.py:250`,
`_streamable_http_modern.py:297/451`). stdio passes a constant, so it is untouched.

## B1 — authorization server, grants, consent routes (FULL review)

**Migration + models.**
- `alembic/versions/0016_oauth_connector.py` — the five DDL blocks of §Database,
  `0015_push.py` style (`op.f(...)`, symmetric downgrade). Risky: the
  `personal_access_tokens` ALTER must emit a CHECK matching the model byte-for-byte
  (`alembic check`); the existing constraint there is the UN-prefixed `scope_valid`, so
  name both explicitly.
- Five new `models/oauth_*.py` + `models/__init__.py` re-export/`__all__`
  (`client_secret_hash` String(64) null `[R1]`; `state` Text, 2 KB at the provider
  `[R2]`), and `personal_access_token.py` gains `token_hash: Mapped[str | None]`,
  `oauth_client_id`, the CHECK.

**New package `src/budget_api/oauth/`.**
- `urls.py` — `PublicUrls.from_settings(settings) -> PublicUrls | None`. Pure; the ONE
  place a URL string is composed. `None` when `public_base_url == ""`.
- `clients.py` — DCR caps, `redirect_uri_allowed`, `is_loopback`, `BudgetClient`; `[R1]`
  accepts `token_endpoint_auth_method ∈ {none, client_secret_post, client_secret_basic}`,
  a missing value being the SDK default `client_secret_post`.
- `tokens.py` — the three prefixes, `mint`, `resolve_access_token`. Imports models only
  (no `pat_auth` import — that direction would cycle).
- `provider.py` — `BudgetOAuthProvider`; `register_client` stores only
  `sha256(client_info.client_secret)`, `get_client` returns `BudgetClient(…,
  client_secret=None)` `[R1]`.
- `client_auth.py` — our `ClientAuthenticator` REPLACEMENT `[R1]`: same contract
  (`authenticate_request(request) -> OAuthClientInformationFull`, raising
  `AuthenticationError`), comparing `sha256(presented)` to the stored hash with
  `hmac.compare_digest`. Cannot subclass-and-super — the SDK version rejects a
  secret-method client with no plaintext secret before any hook of ours runs.
- `consent.py` — `read_request`, `decide` (UPDATE…RETURNING consumption, code mint,
  `construct_redirect_uri`).
- `routes.py` — `oauth_routes(app, settings) -> list[Route]`: AS metadata, PRM ×2,
  `/oauth/{authorize,token,register}`; `register` wrapped in the SDK's own
  `mcp.server.transport_security.RequestBodyLimitMiddleware(handler, 16384)` (reuse, do
  not re-implement — small deviation from §D7's wording) + the per-IP limiter hit. The
  SDK handlers are BOUND METHODS, so Starlette wraps them with `request_response`; only
  `/mcp` (B2) is a raw ASGI endpoint.

**App surface.**
- `routers/oauth.py` — the four JWT-only routes of §Contract, each with `# MCP: no —
  escalation surface`; `schemas/oauth.py` for their models.
- `pat_auth.py` — `_pat_from_request` accepts both prefixes; the lookup branches on it.
  Everything after the `PatContext` stash is untouched:
  ```python
  if raw.startswith(OAUTH_ACCESS_PREFIX):
      resolved = await resolve_access_token(session, raw)   # oauth/tokens.py
  else:
      resolved = (await session.execute(select(PersonalAccessToken, User)...)).first()
  if resolved is None or not resolved[1].is_active:
      raise HTTPException(401, detail="TOKEN_INVALID")
  pat, user = resolved
  ```
- `routers/tokens.py` — list and `DELETE /{token_id}` add
  `PersonalAccessToken.oauth_client_id.is_(None)`.
- `config.py` — `public_base_url: str = ""` + a `field_validator`: scheme http|https, no
  path/query/fragment, trailing slash stripped, `http://` only for
  `localhost`/`127.0.0.1` `[R6]`; plus the six lifetime/limit fields of §D8.
- `app.py` — after `app.state.pat_allowlist`, append the Starlette routes when
  `PublicUrls.from_settings(resolved)` is not None. The B2 lifespan hook is designed
  now: the lifespan will read `app.state.mcp_manager` / `app.state.mcp_api_client`, set
  in `create_app` only when the URLs exist — so B2 adds no new branch there.
- `pyproject.toml` `[R4]` — `mcp>=2.2,<3` into `dependencies`; `mcp = []` as a no-op
  alias (**verified**: `uv lock` accepts an empty extra, `uv run --extra mcp` works);
  dev group drops `budget-api[mcp]`; `uv lock` regenerated; Dockerfile untouched.
- Contract: `pnpm openapi` (four paths, tag `oauth`) + `schema.d.ts`, one commit.
  `openapi_md5` in `tests/fixtures/mcp_tools_snapshot.json` is PROVENANCE only — no test
  reads it (docs/mcp.md claims otherwise; fix the doc).

**Metadata we publish** (built by us, served by the SDK's `MetadataHandler`):
```
issuer=base · authorization_endpoint=base/api/oauth/authorize · token_endpoint=base/api/oauth/token
registration_endpoint=base/api/oauth/register · response_types_supported=["code"]
grant_types_supported=["authorization_code","refresh_token"]
token_endpoint_auth_methods_supported=["none","client_secret_post","client_secret_basic"]  [R1]
code_challenge_methods_supported=["S256"]  # no scopes_supported / CIMD / revocation_endpoint
PRM: resource=base/mcp · authorization_servers=[base] · bearer_methods_supported=["header"]
```

**Two fragments worth spelling out** (verified against the SDK call sites):
```python
# oauth/clients.py — the SDK calls this BEFORE provider.authorize, and again on its error path.
def validate_redirect_uri(self, redirect_uri: AnyUrl | None) -> AnyUrl:
    if redirect_uri is None:
        return super().validate_redirect_uri(None)        # the one-registered-URI case
    for registered in self.redirect_uris or ():
        if _same_target(registered, redirect_uri):        # loopback: ignore ONLY the port
            return redirect_uri
    raise InvalidRedirectUriError(f"Redirect URI '{redirect_uri}' not registered for client")
```
```sql
-- oauth/provider.py::exchange_refresh_token — single-use under a race, one statement.
UPDATE oauth_refresh_tokens SET used_at = now(), replaced_by_id = :new_id
 WHERE id = :id AND used_at IS NULL RETURNING id;   -- zero rows → already spent →
 -- revoke the grant and return None, which the SDK answers as invalid_grant
```

**Tests — ≈17**, in `tests/test_oauth_server.py` (the AS over the ASGI app) and
`tests/test_oauth_routes.py` (the four FastAPI routes, disjointness from `/tokens`). One
test per theme unless noted: the honest flow DCR → authorize (302 to consent) → decision → token → an OAuth bearer
answering a data route; refresh rotation and reuse-revokes-the-grant; code replay
revokes; PKCE wrong verifier; redirect_uri refusals (2 — at DCR, and
tampering/loopback-port/foreign at authorize); `resource` mismatch → `invalid_target`;
DCR caps + the per-IP 429 (2); `client_secret_post` round-trip incl. a wrong secret →
401 `invalid_client` and no plaintext stored `[R1]`; a write under a `read` grant → 403
`TOKEN_SCOPE_READONLY` with the audit row carrying the grant id; `DELETE
/oauth/apps/{id}` → next call 401; no-oracle 404s on the four routes; `/tokens` hiding
grants and `DELETE /tokens/{grant}` 404ing; consent request single-use/expired; and
`[R3]` one test building the app with `public_base_url="http://testserver"` asserting
the exposure walk does not raise and that both PRM paths + the AS metadata serve the
bytes above. The 2 KB `state` cap `[R2]` rides the authorize-refusals parametrize;
`test_pat_auth.py` gains four `NEVER_PAT` pairs (no new test).

**Estimates (agent-min):** write 150 · gates (ruff/pyright/`make test`/`alembic check` + up-down/`pnpm openapi`) 40 · verification 25.

## B2 — the `/mcp` transport (FULL review, external integration)

- `mcp/server.py` — `build_server(tools, *, credential, upload)` with `credential:
  Callable[[ServerRequestContext[object]], ToolCredential | None]` → frozen
  `ToolCredential(client, ApiConfig, scope)`. `on_list_tools` calls `tools_for_scope`
  PER REQUEST; the published-count return becomes a helper so `serve()` still logs it;
  stdio passes `lambda _ctx: CONSTANT`. Risky: `tests/test_mcp_server.py` has two
  `build_server` call sites (~375, ~420) asserting 36/35 — both move to the new
  signature, the stdio assertions stay identical.
- `mcp/remote.py` — `build_remote(app, urls) -> (Server, StreamableHTTPSessionManager)`:
  tools from the running app; `StreamableHTTPSessionManager(server, stateless=True,
  json_response=True)`; credential from `ctx.request.scope["user"].access_token`
  (`.token` + `.scopes[0]` = the mode); one `httpx.AsyncClient(transport=ASGITransport(
  app, raise_app_exceptions=False), base_url="http://budget.internal")` in lifespan;
  `upload` always off remotely.
- `oauth/routes.py` — adds `Route("/mcp", endpoint=AuthenticationMiddleware(
  RequireAuthMiddleware(StreamableHTTPASGIApp(manager), required_scopes=[],
  resource_metadata_url=urls.prm), backend=BearerAuthBackend(
  ProviderTokenVerifier(provider), resource_server_url=urls.resource)),
  methods=["GET","POST","DELETE"])` — an ASGI object, served raw; `Mount` forbidden (D2).
- `app.py` — lifespan enters `manager.run()` and closes the client, only when
  `app.state.mcp_manager` exists (the hook designed in B1).
- `apps/web/nginx.conf` — `location = /mcp` and `location /.well-known/oauth-` →
  `api:8000` (`proxy_http_version 1.1`, `Connection ""`, `proxy_buffering off`,
  `proxy_read_timeout 300s`, `client_max_body_size 4m`, NO `sub_filter`); plus
  `X-Frame-Options: DENY` + `frame-ancestors 'none'` on the existing `location =
  /index.html` (it already has its own `add_header`, so nothing is inherited away).
- `docker-compose.prod.yml` — `PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-https://${SITE_DOMAIN}}`;
  `.env.prod.example` a comment only; `docker-compose.yml` / `.env` untouched.

**Driving the transport in pytest — decision.**
**Plain httpx JSON-RPC POSTs**, not the SDK client: `streamablehttp_client` wants an
`httpx2.AsyncClient` (a second HTTP stack — `httpx2.ASGITransport` does exist) and
spawns a standalone GET stream task `json_response=True` has nothing to answer with.
Verified in the SDK: the legacy stateless connection is "born-ready … need not see
`initialize`" (`streamable_http_manager.py` ~235) and a POST needs only `Accept:
application/json` under `json_response` (`streamable_http.py:540`). So each test POST is
ONE self-contained JSON-RPC request, no `MCP-Protocol-Version` header, no handshake.

**Tests — ≈6**, in `tests/test_mcp_remote.py`: the 401 shape without a bearer (`WWW-Authenticate: Bearer error="invalid_token", …,
resource_metadata="…"`, 401 and NOT a 3xx, POST and GET alike); `tools/list` by mode
(full 35 / read 20, `upload_receipt` in neither); `tools/call` of a read tool returning
data AND writing a `pat_audit_log` row with the grant id; a write tool under a read
grant refused with the `TOKEN_SCOPE_READONLY` sentence; a revoked grant → 401.
`describe_api_error`'s `TOKEN_SCOPE_READONLY` wording is rewritten to cover the remote
case `[R5]` ("…issue a full token, or reconnect the AI app choosing full access"), which
edits the pinned parametrize in `test_mcp_server.py` — not a new test.

**Estimates (agent-minutes):** write 90 · gates 30 · self-verification 25.

## Open questions (with recommendations)

1. **`[R5]` edits a pinned string** in `test_mcp_server.py`. Recommend: one sentence
   serving both transports, no second code path.
2. **`oauth/client_auth.py` replaces rather than subclasses** the SDK authenticator —
   recommend as written; subclassing cannot work (see above).
3. **`PublicUrls` once in `create_app`** (`app.state.public_urls`) vs per request.
   Recommend once: settings cannot change under a running app.
4. **`GET /oauth/apps` without `client_id`** — recommend keeping it out: a uuid the user
   cannot act on; connectors are told apart by name + timestamps.
5. **`location /.well-known/oauth-`** is a prefix that also catches future `oauth-*`
   documents — recommend it over two exact-match blocks.

## Risks

- **`AnyHttpUrl` trailing slash** in PRM/AS-metadata equality — measured benign: the SDK
  metadata models set `url_preserve_empty_path=True` and
  `BearerAuthBackend._issued_for_this_resource` strips a trailing slash anyway. Still
  the first thing to check on an audience mismatch.
- **`Route` vs `Mount` for `/mcp`** — a `Mount` makes the router 307 `/mcp` → `/mcp/`,
  dropping Authorization. Pinned by the "no 3xx" assertion.
- **`raise_app_exceptions=False`** is mandatory: True makes an inner 500 raise inside
  the JSON-RPC handler instead of becoming error text. The inner request re-enters the
  whole middleware stack (so `pat_audit` writes the row, CORS no-ops) — intended.
- **`test_mcp_server.py`'s two `build_server` call sites** and the 36/35 counts: stdio
  must come out of the refactor behaviourally identical.
- **`openapi_md5`** is provenance, not a pin (no test reads it); update it anyway and
  FIX `docs/mcp.md`, which claims it is pinned.
- **uvicorn access log** shows the `/oauth/authorize` query (challenge hash, client
  nonce) and `?req=`; the token POST is a form, so no secret is logged (§D10).
- **Exposure walk** now meets `Route`s whose endpoint is an ASGI object or a bound
  method; neither carries a marker, so they land in `walk()` and never in `collect()`
  (`[R3]` pins it). A `Mount` would raise `TypeError` at `create_app` — the tripwire.
- **Mount order**: the Starlette routes are appended AFTER the routers, so a future
  `/oauth/{x}` catch-all in `routers/oauth.py` would shadow `/oauth/authorize`.
