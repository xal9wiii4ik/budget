# Code review: mcp-remote (B1 + B2 + W1), FULL tier — 2026-10-08

Verdict: **no BLOCKER, no MAJOR.** 4 MINOR, 2 NIT. The security checklist passes on every
line; the four MINORs are robustness/ops/test-gap items, not exploitable defects.
Evidence paths are `apps/api/src/budget_api/…` unless stated.

## Findings

**[MINOR] #1 Refresh rotation has no grace window — a lost token response kills the grant**
`oauth/provider.py:439-459` (claim) + `:407-413` (reuse → `_revoke_grant`). Claude gives a
refresh request 30 s and "treats the flow as a failure even if your server eventually
completes" (spec `authentication.txt:124`), then retries with the SAME refresh token: the row is
already `used_at`, so the retry is "reuse" and the grant is revoked — the user must reconnect
the connector. Strict rotation is design-accepted (architecture §D3/§8, spec :121), but the
timeout interplay was not considered. Suggested fix (~15 lines): in `load_refresh_token`, when
`used_at` is within `oauth_refresh_grace_seconds` (e.g. 60) and the grant is live, treat the
presentation as a retry: claim-and-void the successor row (`replaced_by_id`, its access token
too) and issue a fresh pair; outside the window keep today's revoke. Senior-lead's call.

**[MINOR] #2 Expired access/refresh rows are never pruned on the happy path**
`oauth/provider.py:285`, `:404` are the only `_prune_credentials` call sites — both are the
"lookup returned nothing" branch. A healthy connector (hourly refresh, no failures) accumulates
~24 `oauth_access_tokens` + ~24 `oauth_refresh_tokens` rows per grant per day indefinitely
(~17k/grant/year, two tables); correctness is unaffected (`expires_at > now()` is in the
resolver), only growth. Fix: call `_prune_credentials` (or its three DELETEs, without the extra
commit) inside `_issue_pair` / at the top of `exchange_refresh_token`, where every healthy
client passes at least hourly. No index on `expires_at` for these three tables either — add
one if the prune stays a full-table DELETE (migration-level, same commit as the model change).

**[MINOR] #3 DCR limit `10/hour` is keyed on an IP every claude.ai user shares**
`oauth/routes.py:240-245`, `config.py:287`. For the hosted apps the DCR and token calls come
from Anthropic's egress, not the user's browser, and "DCR causes Claude to register a new
client on every fresh connection" (spec :64). Net effect: at most 10 connector additions per
hour across ALL users of this deployment, and any claude.ai user can exhaust it for everyone by
re-adding the connector 10× (refusals count too, R8). Not a breach — an onboarding DoS, cheap
to trigger. Options: raise `oauth_register_rate_limit` (e.g. `60/hour`), or keep 10/hour but
exempt a successful registration from the window. Document the figure in `apps/api/MCP.md`.

**[MINOR] #4 Two load-bearing branches have no test**
(a) `oauth/client_auth.py:109-123` — the `client_secret_basic` branch (base64 + RFC 6749 §2.3.1
percent-decoding + client-id cross-check) is the most hand-written parsing in the scope and
`test_oauth_server.py:451` exercises only `client_secret_post`. (b) The expiry predicates:
`oauth/tokens.py:100` (`OAuthAccessToken.expires_at > now()`) and the refresh-expiry path
(`provider.py:420` → SDK `token.py:215`) — nothing builds an app with
`oauth_access_token_lifetime_seconds=0` / `oauth_refresh_token_lifetime_seconds=0`, although the
suite's own docstring names that mechanism. One parametrised test per item: Basic auth
round-trip + wrong secret; lifetime 0 → `401 TOKEN_INVALID` on a data route and
`invalid_grant` on refresh. Both are "behaviour that can break", per CLAUDE.md's test rule.

**[NIT] #5 `/mcp/` (trailing slash) is answered by the SPA with `200 text/html`**
`apps/web/nginx.conf:103` is `location = /mcp`; `/mcp/` falls into `location /` → `index.html`.
A user who pastes the URL with a slash gets HTML instead of the 401 handshake and "cannot
connect" with no hint. `location = /mcp/ { return 404; }` (not a redirect — a 3xx would drop
`Authorization`) makes the failure honest.

**[NIT] #6 `client_secret_basic` still requires `client_id` in the form body**
`oauth/client_auth.py:67-69`. RFC 6749 §2.3.1 puts the id in the header for Basic; a client
that omits it from the body gets `invalid_client`. Harmless today — the SDK's own request
models (`token.py:27,42`) require `client_id` in the body anyway — but worth a comment so the
next reader does not "fix" one side without the other.

## Security checklist (one line each)

- **Open redirect / redirect_uri tampering — OK.** Registration allowlist: exact string equality
  with `CLAUDE_REDIRECT_URI` or http loopback, fragment refused (`oauth/clients.py:72-83`); at
  `/authorize` the SDK calls `BudgetClient.validate_redirect_uri` BEFORE `provider.authorize`
  and on its error path (`handlers/authorize.py:109,176`); loopback compare ignores port only
  (`clients.py:86-103`); `redirect_to` is composed from the stored row via
  `construct_redirect_uri` (`consent.py:107-157`), no request field can move it; web guard
  compares `origin` + pathname (`features/oauth/redirectGuard.ts:35-49`, tested). Tests:
  `test_oauth_server.py:317-381`, `:384-435`.
- **PKCE downgrade — OK.** `code_challenge_method: Literal["S256"]`, `code_verifier` required
  (`handlers/authorize.py:33`, `token.py:31`); challenge stored on the request row then the
  code row (`consent.py:149`) and compared by the SDK (`token.py:186-189`). Test `:233`.
- **Code replay — OK.** `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`
  (`provider.py:317-328`); replay revokes the produced grant both at load (`:287-291`) and on
  a lost race (`:329-335`). Test `:216`.
- **Refresh reuse — OK** (see #1 for the grace question). Single-use claim `:440-450`; reuse
  revokes the grant `:407-413`, `:451-455`; rotation returns the new pair in the same response
  and links `replaced_by_id` after the successor exists `:472-488`. Test `:184`.
- **CSRF on consent — OK.** No cookie is read anywhere in `oauth/`, `routers/oauth.py`, `mcp/`,
  `pat_auth.py` or the SDK's `server/auth` (grep: zero hits); all four routes are
  `current_active_user` bearer-only; `app.py:299` states the AM-9 rule.
- **Clickjacking — OK.** `X-Frame-Options: DENY` + `CSP frame-ancestors 'none'`, both `always`,
  on `location = /index.html` — the block every SPA route internally redirects to
  (`nginx.conf:37-41`).
- **Token leakage in logs — OK.** Every `logger.*` in `oauth/` logs a client id, grant id,
  request id, method name or reason only (`provider.py:192,258,363,577`,
  `client_auth.py:87,127`, `consent.py:136,156`); `mcp/` has no logger beyond stdio's
  `log_stderr` (unchanged). SDK: `bearer_auth.py:75` logs the `resource` string only;
  `authorize.py:220` a generic exception. Honest exposure: uvicorn/nginx access lines carry the
  `/oauth/authorize` query (`code_challenge` = a hash, `state` = client nonce) and the one-time
  `?req=` — accepted in architecture §D10; `/token` is a form POST (body never logged).
- **Scope escalation read→full — OK.** Mode lives on the grant row (`provider.py:346-352`,
  from the code row written at consent `consent.py:147`); wire `scope` ignored at authorize
  (`clients.py:191`), at exchange, and at refresh (`provider.py:435-437`, SDK refuses wider);
  `/mcp` dispatch table rebuilt per request from the caller's mode (`mcp/server.py:543`);
  inner request is METHOD-gated by `pat_auth` (unchanged). Tests `test_mcp_remote.py:186`,
  `test_oauth_server.py:560`.
- **Revoked token accepted anywhere — OK.** ONE resolver `oauth/tokens.py:81-111` joining
  `revoked_at IS NULL`, `oauth_client_id IS NOT NULL`, `expires_at > now()`, `is_active`; used by
  `pat_auth.py:792-793` and the `/mcp` verifier (`routes.py:176-177` → `provider.py:492-508`);
  refresh joins the grant and re-reads `revoked_at` (`provider.py:386-415, :460-471`); code
  exchange re-reads the owner (`:340-345`); stateless transport builds a fresh transport per
  request and runs the bearer middleware every time (`streamable_http_manager.py:206-259`).
  Tests `test_mcp_remote.py:251`, `test_oauth_server.py:592`.
- **No-oracle 404s — OK.** `OAUTH_REQUEST_NOT_FOUND`: `read_request` and `decide` both collapse
  unknown/expired/consumed into one predicate set (`consent.py:72-76, :110-114`);
  `OAUTH_APP_NOT_FOUND`: one UPDATE whose WHERE is the authorisation (`routers/oauth.py:170-182`);
  `/tokens` ↔ `/oauth/apps` disjoint by `oauth_client_id IS NULL / IS NOT NULL` in all four
  queries (`routers/tokens.py:135, :158`, `routers/oauth.py:132, :176`). Byte-identical bodies
  asserted `test_oauth_routes.py:42-83`, cross-listing `:86-118`.
- **DCR abuse — OK** (see #3 for the keying). Per-IP limiter runs before the handler
  (`routes.py:115-128, :240`), 16 KiB cap on `Content-Length` AND on chunked bodies
  (`transport_security.py:126-170`), URIs 1..10 × ≤2 KB, name ≤100, response/grant types
  pinned, auth method ∈ {none, post, basic} (`clients.py:106-163`); no outbound fetch (no CIMD).
  Tests `test_oauth_server.py:384-518`.
- **Audience binding — OK.** `resource` at authorize must equal ours (trailing slash tolerated)
  else `invalid_target` (`provider.py:225-231, :521-523`); `AccessToken.resource` is always
  `urls.resource` (`:506`); `BearerAuthBackend(resource_server_url=AnyHttpUrl(urls.resource))`
  (`routes.py:208-211`) compares URL-normalised minus trailing slash. PRM `resource`, metadata
  `issuer` and `AccessToken.resource` all derive from the one `PublicUrls` (`urls.py:64-77`),
  built from strings so `AnyHttpUrl` cannot add a `/` (`routes.py:314, :336`); bytes pinned
  `test_oauth_server.py:616-659`. Config validator strips `/` and refuses paths (`config.py:297`).
- **Race conditions — OK.** Concurrent code exchange / refresh / double-click consent all
  reduce to `UPDATE … RETURNING` claims under READ COMMITTED (`provider.py:317, :440`,
  `consent.py:107`): the loser's UPDATE waits on the winner's row lock and re-evaluates to zero
  rows. Not covered by a test (acceptable: the mechanism is the statement).
- **DB / migration — OK.** 0016 downgrade is the exact mirror (indexes → tables → CHECK → DELETE
  grants → FK → column → NOT NULL → `oauth_clients`); `pat_audit_log.token_id` is
  `ON DELETE CASCADE` (0007:102) so the destructive DELETE succeeds; plain name `"credential"`
  gets the metadata naming convention (alembic `schemaobj.py:197-202`) → the model's
  `name="credential"` and the downgrade's `op.f("ck_personal_access_tokens_credential")` agree;
  `token_hash` nullable + XOR CHECK; FKs/ondeletes match the models; indexes match the lookups
  (`token_hash` UNIQUE on all three credential tables, `grant_id` on access/refresh,
  `expires_at` on requests); self-FK `replaced_by_id` CASCADE is safe for the prune (the
  successor always outlives the predecessor). See #2 for the missing `expires_at` indexes.
- **stdio path unchanged — OK.** `serve()` passes a constant `ToolCredential`
  (`mcp/server.py:571-573`); handlers hold no caller state; `test_mcp_server.py` only adapted
  call sites; R5 wording pinned.
- **ASGITransport inner-call pitfalls — OK.** `raise_app_exceptions=False` (`app.py:178`,
  pinned `test_mcp_remote.py:218`); ONE client built in the lifespan, manager entered after it so
  it is torn down first (`app.py:174-187`); verifier session closed before the handler runs
  (`provider.py:496-497`); inner request opens its own session via `get_session`; no lock or
  thread hop → no deadlock; outer `/mcp` request has no `request.state.pat` so only the inner
  call is audited (asserted `test_mcp_remote.py:175-184`). The SDK attaches the Starlette
  request on BOTH the legacy stateless path (`streamable_http.py:249-250`) and the
  modern-version path (`_streamable_http_modern.py:449`), so `credential()` resolves whichever
  `MCP-Protocol-Version` Claude sends; DNS-rebinding settings default OFF (`transport_security.py:48`).
- **nginx — OK** (see #5). `location /.well-known/oauth-` with URI-less `proxy_pass` forwards
  the path verbatim; `= /mcp`; neither block has `sub_filter` or `Accept-Encoding ""`; headers
  carry `always`; `client_max_body_size 4m` matches the SDK cap.
- **Tests — OK** (see #4 for the two gaps). Every test asserts wire behaviour that one
  forgotten predicate would break; no vacuous or duplicate test found. R3 discovery test is
  the exposure-walk tripwire in disguise, which is the right place for it.
