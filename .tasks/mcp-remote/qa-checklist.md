# QA Checklist: mcp-remote — Claude connector over OAuth (PLAN 5.6b)

## Scope
14 STOP/INFO probes against the **prod-like stack** — the only place the thing under test exists:
`PUBLIC_BASE_URL` set, Caddy terminating TLS, nginx owning `/api/`, `= /mcp`, `/.well-known/oauth-`.
Every probe is a *topology or real-client* fact: discovery statics at the public edge, one full OAuth
round-trip driven by the official Python SDK, one by Anthropic's own `claude` CLI, the credential-abuse
paths that must also *revoke*, the audit trail, the stdio regression. Codes, field validation,
no-oracle 404s, scoping, boundaries, idempotency and lifetime expiry are pytest's — Section C.
Browser journeys (consent page, Settings) are **web-qa**.
**Stand** (recipe verbatim from `.tasks/deploy/qa-checklist.md` P5; `docs/infra.md` §Dev stand):
```bash
S=/private/tmp/claude-501/-Users-nikitazaretski-work-budget/747ab211-bae8-459f-898e-7671d506058f/scratchpad
# $S/.env.prod.qa: SITE_DOMAIN=localhost · PUBLIC_BASE_URL=https://localhost:8443 ·
#   CADDY_HTTP_PORT=8480 · CADDY_HTTPS_PORT=8443 · JWT_SECRET / POSTGRES_PASSWORD /
#   MINIO_ROOT_USER / MINIO_ROOT_PASSWORD = throwaway values (the 5 `${VAR:?}` keys)
docker run --rm alpine df -h /                       # STOP if > 85% before up
cd /Users/nikitazaretski/work/budget
DC="docker compose --env-file $S/.env.prod.qa -f docker-compose.prod.yml -p budget-prod-qa"
$DC up -d --build
$DC exec caddy cat /data/caddy/pki/authorities/local/root.crt > $S/caddy-root.crt
CA=$S/caddy-root.crt; B=https://localhost:8443
curl --cacert $CA -s $B/api/health                   # gate: {"status":"ok",...}
```
`curl --cacert $CA` everywhere — `-k` only as a documented fallback. Hands off: 5173 / 8010 / 5443 /
9010 / 9011 (dev) and 5433 / 8000 / 8081 (foreign); the stack owns its own volumes under
`budget-prod-qa`, the dev `budget` DB is never touched and no migration ever runs against it.
**Users / sessions.** `qa-mcpr-1@budgetqa.dev`, `qa-mcpr-2@budgetqa.dev` / `Qa!Test1234`, fresh
(empty DB). **LOGIN ONCE** per user → `$J1`, `$J2`, reused everywhere; no probe here is about JWT
auth, so no re-login. `C='Content-Type: application/json'`.
**Token budget.** THE single live run of the scope: one bring-up, one teardown, ≈150k tokens. A
second bring-up means a probe failed and a fix landed — report, don't replay the program.

## REQUIREMENTS FOR THE ENGINEER (these probes are impossible otherwise)
- **R-A** `PUBLIC_BASE_URL` must be an env passthrough on the api service
  (`${PUBLIC_BASE_URL:-https://${SITE_DOMAIN}}`) — compose cannot know the 8443.
- **R-B** The stdio server must run **inside** the api image (`$DC exec api python -m
  budget_api.mcp`), i.e. the `mcp` SDK is a runtime dep of the image (D1). That is P13's only
  TLS-free route; CA injection via `SSL_CERT_FILE` is the fallback and may not work (httpx pins certifi).
- **R-C** `GET /api/oauth/requests/{id}` must return `client_name`, `redirect_host`, `loopback` —
  P4 reads the consent screen through the API instead of a browser.
- **R-D** The DCR per-IP limiter must key on the **real** client IP through Caddy→nginx, and the plan
  must state whether a *rejected* registration consumes the bucket (limiter outside validation per
  D7 ⇒ yes). P9 budgets the bucket on that answer.
- **R-E** `state` cap: the lead's ruling is **≤ 2 KB**; `architecture.md` §Tables still says "cap 512
  at the provider". One is wrong — fix before implementing; P8 probes 2 KB.

## Section A — pytest (owned by backend-engineer; by THEME, the backend plan enumerates)
- **pure modules, ~18** — `urls.py` derived URLs / no trailing slash / empty setting → `None`;
  `clients.py` exact claude.ai URI, loopback port-agnostic but path-exact, DCR caps,
  `validate_redirect_uri` + `validate_scope` overrides.
- **metadata documents, ~5** — AS + both PRM dicts byte-shape, no `scopes_supported`, `S256` only.
- **provider, ~23** — authorize (missing `redirect_uri`, `invalid_target`, pending row, prune,
  `state` cap, consent URL); exchange (grant+pair in one tx, replay → `invalid_grant` **and** revoke,
  verifier mismatch, expiry, `scope` = consented mode); refresh (rotation, sliding 30 d, reuse →
  revoke, widened scope refused).
- **credential resolution, ~12** — `resolve_access_token` (expired / revoked / inactive user / wrong
  prefix → `None`, one query); `pat_auth` second prefix yields the same `PatContext` through
  allowlist, scope gate, 429, `last_used_at`, with the PAT branch unchanged.
- **four JWT-only routes, ~14** — 404 no-oracle (unknown/expired/consumed/foreign/PAT-id), decision
  allow+deny, `/oauth/apps` listing incl. revoked, `NEVER_PAT` membership.
- **remote tool pipeline, ~8** — `tools_for_scope` 20/35 per request, no `upload_receipt`,
  ASGITransport call path, audit row, inner 500 → tool error text.
- **migration 0016 + contract, ~6** — up/down, CHECK `(token_hash IS NULL) <> (oauth_client_id IS
  NULL)`, `alembic check`, openapi/schema pair, md5 pin in `test_mcp_server.py`.

## Section B — live STOP-probes, in order
Order is load-bearing: P4 produces the grant P6 destroys; P9 exhausts the DCR bucket for the
hour, so it runs after every DCR consumer. Keep a running tally of registrations from P4 on.

### P1 [STOP] `/mcp` unauthenticated is a 401, never a 3xx
```bash
curl --cacert $CA -sI $B/mcp -w '%{http_code}\n'
curl --cacert $CA -si -X POST $B/mcp -H "$C" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | head -20
```
Expect **401** on both (GET may be 405 — record), `WWW-Authenticate: Bearer error="invalid_token", …
resource_metadata="https://localhost:8443/.well-known/oauth-protected-resource/mcp"`. No `Location`,
no 307/308 — a slash redirect here is the documented "Authorization dropped on redirect" failure
(troubleshooting §Your server URL redirects) and D2's reason for `Route` over `Mount`.
Failure = claude.ai never starts sign-in. **Status**: ✅ pass (2026-10-08)
GET **401**, POST **401**, `redirect_url` empty on both, no `location` header anywhere. Header
byte-for-byte (identical on GET and POST, the B2 amendment applied):
`www-authenticate: Bearer error="invalid_token", error_description="Authentication required",
resource_metadata="https://localhost:8443/.well-known/oauth-protected-resource/mcp"`; body
`{"error": "invalid_token", "error_description": "Authentication required"}`; also
`x-content-type-options: nosniff`, `via: 1.1 Caddy`, `server: nginx/1.27.5` — the full edge chain.

### P1b [INFO, added by senior-lead] `GET /mcp` WITH a valid bearer
`curl --cacert $CA -si -X GET $B/mcp -H "Authorization: Bearer $AT" -H 'Accept: text/event-stream'
--max-time 5`. **Status**: ✅ recorded (not a defect either way).
**HTTP/2 200**, `content-type: text/event-stream`, `cache-control: no-cache, no-transform`, and the
stream carries **no bytes at all**: curl held the connection until the timeout (exit 28,
`time_total=5.007`). So in stateless JSON mode the SDK does open the GET SSE stream and never writes
to it — it does not 405. Owner-facing consequence: a client that opens the GET stream will keep an
idle connection (nginx `proxy_read_timeout 300s`) and must not wait on it for a response.

### P2 [STOP] both PRM paths + AS metadata at the public edge
```bash
for p in /.well-known/oauth-protected-resource/mcp /.well-known/oauth-protected-resource /.well-known/oauth-authorization-server; do
  echo "== $p"; curl --cacert $CA -s -w ' [%{http_code}]\n' $B$p; done
```
Expect 200 JSON ×3. PRM (both paths, identical): `resource == "https://localhost:8443/mcp"`,
`authorization_servers == ["https://localhost:8443"]` (neither with a trailing slash),
`bearer_methods_supported == ["header"]`, **no `scopes_supported`**. AS: `issuer ==
"https://localhost:8443"`, `authorization_endpoint`/`token_endpoint`/`registration_endpoint` all
under `https://localhost:8443/api/oauth/`, `code_challenge_methods_supported == ["S256"]`,
`response_types_supported == ["code"]`, `grant_types_supported` = the two,
`token_endpoint_auth_methods_supported` **includes `none`** (R1 may add the secret methods).
Failure = Claude cannot locate or trust the AS. **Status**: ✅ pass
All three **200**. PRM at both paths, byte-identical:
`{"resource":"https://localhost:8443/mcp","authorization_servers":["https://localhost:8443"],
"bearer_methods_supported":["header"]}` — no trailing slashes, no `scopes_supported`. AS:
`issuer` `https://localhost:8443`, `authorization_endpoint`/`token_endpoint`/`registration_endpoint`
= `…/api/oauth/{authorize,token,register}`, `response_types_supported ["code"]`,
`grant_types_supported ["authorization_code","refresh_token"]`,
`token_endpoint_auth_methods_supported ["client_secret_basic","client_secret_post","none"]` (R1's
three, `none` included), `code_challenge_methods_supported ["S256"]`, no `scopes_supported`, no
`revocation_endpoint`. The nginx `/.well-known/oauth-` prefix block forwards all three verbatim.

### P3 [STOP] body-parser contract on the two POST endpoints
```bash
curl --cacert $CA -si -X POST $B/api/oauth/token -H "$C" -d '{"grant_type":"authorization_code","code":"x"}' | head -5
curl --cacert $CA -si -X POST $B/api/oauth/register -H 'Content-Type: application/x-www-form-urlencoded' -d 'redirect_uris=http://localhost:1/cb' | head -5
```
Expect **400** `invalid_request` on `/token` (NOT 415 — authentication.txt §Token refresh names 415
as the classic break) and **400** on `/register` (JSON-only, RFC 7591 §3.1). **Status**: ✅ pass
`/token` with a JSON body → **400**, `cache-control: no-store`,
`{"error":"invalid_request","error_description":"the token endpoint takes
application/x-www-form-urlencoded"}` — not 415. `/register` with a form body → **400**
`{"error":"invalid_client_metadata","error_description":": Invalid JSON: expected value at line 1
column 1"}`. (This refusal still spends a DCR bucket slot — R8; counted as hit #1 in P9's tally.)

### P4 [STOP] full flow, mode `read`, official Python SDK + browser played by curl
One script, `$S/oauth_flow.py`, run as
`uv run --frozen --directory /Users/nikitazaretski/work/budget/apps/api python $S/oauth_flow.py read $J1`.
Shape (`mcp` 2.2 in that venv): `OAuthClientMetadata(redirect_uris=["http://localhost:4242/cb"],
client_name="Budget QA probe", response_types=["code"], grant_types=["authorization_code",
"refresh_token"], token_endpoint_auth_method="none")` — R1 arm 1, explicit →
`OAuthClientProvider(f"{B}/mcp", md, InMemoryStorage(), redirect_handler=…, callback_handler=…)` →
`streamable_http_client(f"{B}/mcp", http_client=httpx2.AsyncClient(verify=CA, auth=auth))` →
`ClientSession(r, w)`. The CA goes on the client the SDK is *given* — the provider's own
discovery/DCR/token calls ride it; the SDK ignores `follow_redirects` on `/mcp`.
`handle_redirect(url)`: `GET url`, `follow_redirects=False` → assert **302** with `Location ==
https://localhost:8443/oauth/consent?req=<uuid>`; then play the browser against the API with `$J1`:
`GET /api/oauth/requests/<req>` → `client_name == "Budget QA probe"`, `redirect_host == "localhost"`,
`loopback == true`, `expires_at` present; `POST …/decision {"decision":"allow","scope":"read"}` →
`redirect_to` on `http://localhost:4242/cb`; parse `code`/`state`; `handle_callback()` returns
`AuthorizationCodeResult(code=…, state=…)`.
Then assert: `initialize()` ok; `list_tools()` → **exactly 20 names**, all read, **no
`upload_receipt`**, no `create_*`/`update_*`/`delete_*`; `call_tool("list_accounts", {})` → an account
payload, not a tool error; `call_tool("create_account", …)` → **refused**, and record *which* shape
(unknown tool vs an error naming read-only). Token response `scope == "read"`, `expires_in == 3600`.
Keep both tokens + the grant id for P6/P7/P10/P11.
Failure = the connector does not work at all, or a read grant can write. **Status**: ✅ pass
Driver `$S/mcpr/oauth_flow.py` (`uv run --frozen --directory apps/api python …`), transport
`httpx2.AsyncClient(verify=$CA, auth=OAuthClientProvider(…))` passed as `http_client=` to
`streamable_http_client` — the SDK's own discovery → DCR → authorize → token chain, nothing hand-rolled.
- DCR 201, `client_id=cf280b10-…`, `token_endpoint_auth_method=none`, no secret minted (R1 arm 1).
- `handle_redirect`: authorize **302** → `Location: https://localhost:8443/oauth/consent?req=92d47fcb-…`
  (exactly the consent URL, nothing else in the response body).
- `GET /api/oauth/requests/<req>` (`$J1`) **200**: `{"client_name":"Budget QA probe read",
  "redirect_host":"localhost","loopback":true,"expires_at":"…14:30:07Z"}` — R-C satisfied.
- `POST …/decision {"decision":"allow","scope":"read"}` **200**,
  `redirect_to=http://localhost:4242/cb?code=bgt_oac_…&state=…` (state echoed verbatim).
- `initialize()` → `serverInfo.name = "budget"`. `list_tools()` → **exactly 20**, zero
  `create_/update_/delete_/set_/upload_` names, no `upload_receipt`. The 20 names are **identical**
  to P13's stdio read list (compared sorted, name-by-name).
- `call_tool("list_accounts")` → `is_error=false`, and after creating an account with `$J1` the same
  call over `/mcp` returned it: `[{"id":"13c32b9f-…","name":"QA Cash","balance_minor":12345,…}]`, 200.
- Token response: `scope="read"`, `expires_in=3600`, `access_token` `bgt_oat_…`, `refresh_token` `bgt_ort_…`.
- **AMENDED (B2 fact)**: `call_tool("create_account", …)` → `is_error=true`, content
  `Unknown tool "create_account".` The read grant's dispatch table has no write entry, so no inner
  HTTP call is made and no 403 audit row exists — see P11.
Grant id `a971b3b0-d450-4d97-bae7-f6ff1bd4ccaa`; code/verifier/client kept for P6.

### P5 [STOP] second flow, mode `full`, `token_endpoint_auth_method` OMITTED (R1 arm 2)
Same script, `full $J1`, with the field left OUT of `OAuthClientMetadata` — per R1 the server must
still register the client (none / `client_secret_post` / `client_secret_basic`, secret stored hashed)
and the flow must complete. Assert: `list_tools()` → **exactly 35**, still no `upload_receipt`;
`call_tool("create_category", …)` succeeds; `GET /api/categories` under `$J1` shows that category (the
write really hit the user's data through the real request path); `GET /api/oauth/apps` lists **two**
grants — `scope=read` and `scope=full`, declared `client_name`s, `last_used_at` set on both,
`revoked_at` null. A refusal *because the field is absent* is the defect R1 names: record the
`invalid_client_metadata` body and stop. **Status**: ✅ pass
**AMENDED (B2/R1 fact): the field OMITTED must SUCCEED, and it does.** Metadata actually put on the
wire: `{"redirect_uris":["http://localhost:4242/cb"],"client_name":"Budget QA probe full",
"response_types":["code"],"grant_types":["authorization_code","refresh_token"]}` — no
`token_endpoint_auth_method`. DCR **201** with `client_id=1590e53d-…`,
`token_endpoint_auth_method="client_secret_post"` and a `client_secret` in the body, which the SDK
client stored and used at `/token` (the exchange succeeded, so the server's SHA-256 comparison works
end to end). No `invalid_client_metadata` anywhere.
- `list_tools()` → **exactly 35**, no `upload_receipt`. Token `scope="full"`, `expires_in=3600`.
- `create_category` over `/mcp` → `is_error=false`,
  `{"id":"98d79c9d-…","name":"QA remote write","kind":"expense","is_system":false}`; `GET
  /api/categories` with `$J1` lists `QA remote write` — the write really hit the user's data through
  the real request path. (The driver's first attempt sent `{"body":{…}}`; the server answered the
  house 422 as tool text — `The Budget API rejected the arguments: - body.name: Field required` —
  a driver bug, re-called with the schema's flat arguments.)
- `GET /api/oauth/apps` (`$J1`) → both grants present with declared `client_name`s, `scope` `read`
  and `full`, `last_used_at` set on both, `revoked_at` null.
- **Deviation**: the listing held **4** grants, not 2. Two extra `read` grants (`9545d8dd-…`,
  `2434ca3c-…`) came from two aborted driver runs that crashed on a client-side `AttributeError`
  (`serverInfo`/`isError` renamed in SDK 2.2) *after* the token exchange had already created the
  grant. Server behaviour, not a defect; it also moved P9's DCR tally by two.

### P6 [STOP] authorization-code replay revokes the grant it produced
Re-POST P4's consumed code to `/api/oauth/token` (form body, same `redirect_uri`, same verifier) →
**400 `invalid_grant`**. Then with P4's *access* token: `POST $B/mcp` `tools/list` → **401** with
`WWW-Authenticate`; `GET /api/oauth/apps` (`$J1`) → that grant now has `revoked_at` set.
Failure = a stolen code buys a live grant. **Status**: ✅ pass
Re-POST of P4's consumed code (form body, same `redirect_uri`, the SDK's own `code_verifier`,
`client_id=cf280b10-…`) → **400** `{"error":"invalid_grant","error_description":"authorization code
does not exist"}`. P4's access token on `POST /mcp tools/list` → **401** with the same
`WWW-Authenticate` document pointer as P1. `GET /api/oauth/apps` (`$J1`): grant
`a971b3b0-…` now `revoked_at=2026-10-08T14:21:46.813037Z` (it was null before the replay).

### P7 [STOP] refresh rotates; the consumed refresh token kills the grant
On the `full` grant: form POST `grant_type=refresh_token&refresh_token=$RT&client_id=$CID` → 200 with a
**new** `access_token` AND a **new** `refresh_token` (≠ old), `scope=full`; the new access token works
on `/mcp`. Then present the **OLD** refresh token again → **400 `invalid_grant`**, `GET /api/oauth/apps`
shows `revoked_at`, and the just-issued access token 401s.
Failure = refresh reuse is survivable (OAuth 2.1 / authentication.txt §Token refresh). **Status**: ✅ pass
On P5's `full` grant (`f09682cb-…`, client `client_secret_post`, so `client_id` + `client_secret` in
the form): refresh → **200**, `scope=full`, `expires_in=3600`, access token rotated AND refresh token
rotated (both `!=` the old strings). Replaying the **OLD** refresh token → **400**
`{"error":"invalid_grant","error_description":"refresh token does not exist"}`; `GET
/api/oauth/apps` → `revoked_at=…14:22:25.357311Z`; the just-issued access token then **401**s on `/mcp`.
"The new access token works on `/mcp`" was re-proved on a second grant (`39b9869e-…`) minted on the
same already-registered client (no new DCR): refresh **200** with both tokens rotated, then the new
access token on `POST /mcp tools/list` → **200** with 35 tools. (The first run's response to that one
assertion was lost to a driver parse bug, hence the re-proof; that second grant is the one P10 kills.)

### P8 [STOP] PKCE, redirect_uri and audience hardening — one batch, registered URI `http://localhost:4242/cb`
Each line is a separate request; all at `/api/oauth/{authorize,token,register}`:
1. `/token` with a **wrong `code_verifier`** on a fresh code → 400 `invalid_grant`.
2. `/authorize?…&code_challenge_method=plain` → refused: **302** back to the registered
   `redirect_uri` with `error=invalid_request` (RFC 6749 §4.1.2.1 — once client + redirect_uri are
   trusted the SDK REDIRECTS the error; pinned by B1's tests), NEVER a consent page. A 400 is also
   acceptable only when no redirect_uri could be resolved. (Senior-lead amendment after B1.)
3. `/authorize` with `redirect_uri=http://localhost:9999/cb` → **302** to the consent page (loopback
   is port-agnostic — authentication.txt §Callback URLs, Claude Code needs it).
4. `/authorize` with `redirect_uri=http://localhost:4242/evil` → **400** (path must match exactly).
5. `/authorize` with `redirect_uri=https://evil.example/cb` → **400**.
6. DCR with `redirect_uris=["https://claude.ai.evil.example/api/mcp/auth_callback"]` → **400
   `invalid_redirect_uri`** (prefix-match trap).
7. `/authorize?…&resource=https://other.example/mcp` → **302** to the registered `redirect_uri`
   with `error=invalid_target` (same RFC rule as item 2), never a consent page.
8. `state` of exactly 2048 bytes → accepted and echoed back on `redirect_to`; 2049 → refused (R-E).
Failure on any = an open-redirect / audience / PKCE hole reachable from the public edge. **Status**: ✅ pass (8/8)
All against the already-registered client `1590e53d-…` (no new DCR except item 6).
1. **400** `{"error":"invalid_grant","error_description":"incorrect code_verifier"}` on a fresh code.
2. **302** `Location: http://localhost:4242/cb?error=invalid_request&error_description=code_challenge_method%3A+Input+should+be+%27S256%27&state=st82` — redirected error, no consent page.
3. `redirect_uri=http://localhost:9999/cb` → **302** `https://localhost:8443/oauth/consent?req=fc2a451e-…` (loopback is port-agnostic).
4. `…:4242/evil` → **400** `{"error":"invalid_request","error_description":"Redirect URI 'http://localhost:4242/evil' not registered for client","state":"st84"}` — a direct body, no redirect (correct: the URI could not be resolved).
5. `https://evil.example/cb` → **400**, same shape.
6. DCR `https://claude.ai.evil.example/api/mcp/auth_callback` → **400** `{"error":"invalid_redirect_uri","error_description":"each redirect_uri must be exactly 'https://claude.ai/api/mcp/auth_callback' or an http loopback URI"}` — prefix trap closed.
7. `resource=https://other.example/mcp` → **302** `http://localhost:4242/cb?error=invalid_target&error_description=unknown+resource&state=st87`, never a consent page.
8. `state` = 2048 × `s` → **302** to the consent page; consenting it returned
   `redirect_to=http://localhost:4242/cb?code=…&state=<2048 chars, all 's'>` (echoed to the byte).
   2049 → refused: **302** `…/cb?error=invalid_request&error_description=state+must+be+at+most+2048+characters` (R-E/R2 cap confirmed at 2048, not 512).

### P9 [INFO→STOP on envelope] DCR per-IP limit at the edge
Run **after** every other DCR consumer, with the tally from P4/P5/P8/P12. Fire registrations until the
11th in the hour → **429**, body `{"detail":"RATE_LIMITED"}` (the house envelope; if the plan states
another, record both). Proves the limiter keys on the real client IP through Caddy→nginx, not on
Caddy's own address — pytest cannot see that chain. A *rejected* registration consumes the bucket too
(R-D), so the 429 may arrive before the 11th success: assert the envelope, not the count. **Status**: ✅ pass
Ran last of all DCR consumers. Tally from this host IP: P3 (rejected form body) 1, P4 ×3 = 4, P5 = 5,
P8.6 (rejected) = 6, `claude mcp login` = 7 (its second, pty-driven run reused the stored client — no
new registration), then two 201s (#8, #9) and **hit #10 → 429** with exactly the house envelope
`{"detail":"RATE_LIMITED"}`. Rejected registrations do spend the bucket (R8 confirmed: 3 of the 10
were 400s).
**Discriminator for the thing pytest cannot see** — that the limiter keys on the REAL client IP, not
on the proxy's: with the host IP already at 429, the byte-identical registration sent from a
different source address inside the stack (`api` container → nginx → api, which is what makes
`X-Forwarded-For`'s leftmost entry a different IP) answered **201**. A limiter keyed on the proxy
address would have refused it from the same exhausted bucket.

### P10 [STOP] revoke from Settings is immediate and silent about foreign ids
On the surviving grant (re-run P5's flow once if P6/P7 consumed both): `DELETE /api/oauth/apps/{id}`
(`$J1`) → **204**; next `tools/call` with that access token → **401** + `WWW-Authenticate`; a refresh
with its refresh token → **400 `invalid_grant`**; `DELETE` again → **404 `OAUTH_APP_NOT_FOUND`**; the
same `DELETE` as **user 2** (`$J2`) → **404 byte-identical** (diff bodies and header sets);
`GET /api/tokens` (`$J1`) → grants **absent**; a plain PAT's id on `DELETE /api/oauth/apps/{id}` →
**404**; a grant id on `DELETE /api/tokens/{id}` → **404**.
Failure = the kill switch is not a kill switch, or it is an existence oracle. **Status**: ✅ pass
On the surviving grant `39b9869e-…` (P7's second grant): `DELETE /api/oauth/apps/{id}` (`$J1`) →
**204**. Next `tools/call list_accounts` with its access token → **401** + the full
`WWW-Authenticate`. Refresh with its refresh token → **400** `invalid_grant` (`refresh token does not
exist`). `DELETE` again → **404** `{"detail":"OAUTH_APP_NOT_FOUND"}`. The same `DELETE` as **user 2**
(`$J2`) → **404**, bodies `diff`-clean (byte-identical) and the response header NAME SETS identical.
`GET /api/tokens` (`$J1`) → only the two PATs, no grants. A plain PAT's id on
`DELETE /api/oauth/apps/{id}` → **404 OAUTH_APP_NOT_FOUND**; the grant id on `DELETE
/api/tokens/{id}` → **404 TOKEN_NOT_FOUND`** (each router keeps its own code, neither leaks the other's).

### P11 [STOP] audit trail carries the grant id
`$DC exec -T postgres psql -U budget -d budget -c "select pal.method, pal.path, pal.status_code,
pal.token_id, pat.oauth_client_id is not null as is_grant from pat_audit_log pal join
personal_access_tokens pat on pat.id = pal.token_id order by pal.occurred_at desc limit 20;"`
(columns are `path` and `occurred_at` — `models/pat_audit_log.py`; senior-lead fix at grooming)
Expect rows for P4/P5's tool calls with `token_id` = the grant ids (`is_grant = t`), including the
**403** of the refused write from P4. `tools/list` must NOT appear (stdio parity).
Failure = remote tool use is invisible to the audit log. **Status**: ✅ pass (amended)
Five rows, every one of them a grant (`is_grant = t`), newest first:
```
 method |    path     | status_code |               token_id               | is_grant | scope
 POST   | /categories |         201 | f09682cb-…(P5 full)                  | t        | full
 POST   | /categories |         422 | f09682cb-…(P5 full)                  | t        | full
 GET    | /accounts   |         200 | a971b3b0-…(P4 read)                  | t        | read
 GET    | /accounts   |         200 | a971b3b0-…(P4 read)                  | t        | read
 GET    | /accounts   |         200 | 2434ca3c-…(aborted-run read grant)   | t        | read
```
`token_id` is the grant id on every row and joins to `personal_access_tokens` with
`oauth_client_id IS NOT NULL`. No `tools/list` row (stdio parity), and the 422 row proves even a
refused *inner* request is audited.
**AMENDED (B2 fact), the sheet's "expect the 403 of the refused write" is withdrawn**: a write tool
under a `read` grant is answered `Unknown tool "create_account".` by the per-request dispatch table,
so no inner HTTP call happens and **no 403 row can exist**. Confirmed: no 403 anywhere in the table.
Column names `path` / `occurred_at` were correct as fixed at grooming.

### P12 [STOP, minimal] Anthropic's real client: DCR + authorize + loopback callback
Goal is only "it works with `claude` 2.1.294", not a tool matrix. `export NODE_EXTRA_CA_CERTS=$CA`;
`claude mcp add --transport http budget-qa $B/mcp`; `claude mcp login budget-qa --no-browser` (prints
the authorize URL, then prompts for the redirect URL). Drive the prompt from a FIFO: start `login`
with stdin on the FIFO in the background, read stdout until the authorize URL appears, open it with
curl (302 → `?req=`), play the consent with `$J1` as in P4, write the resulting `redirect_to` into the
FIFO. Then `claude mcp list` → `budget-qa` **connected**. If the paste loop does not cooperate inside
15 minutes, **stop and document the manual step** instead — P4/P5 already prove the protocol; this
probe only proves Claude's own client agrees. Finish with `claude mcp remove budget-qa` +
`claude mcp logout budget-qa`. **Status**: ✅ pass
`claude` **2.1.294**, `NODE_EXTRA_CA_CERTS=$CA`, run from a scratch cwd so the server landed in
local (project) config only. `claude mcp add --transport http budget-qa https://localhost:8443/mcp`
→ added; `claude mcp list` before login → `! Needs authentication` (so it read the 401 and the PRM).
`claude mcp login budget-qa --no-browser`:
- **Its own DCR against our server**: `client_id=30501535-…`, `client_name="Claude Code (budget-qa)"`.
- Authorize URL it built: `…/api/oauth/authorize?response_type=code&client_id=…&code_challenge=…&
  code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A61072%2Fcallback&state=…&
  resource=https%3A%2F%2Flocalhost%3A8443%2Fmcp` — note the **ephemeral loopback port 61072**, which
  is not the registered port; the port-agnostic loopback rule is what makes this client work at all.
- Authorize **302** → `…/oauth/consent?req=50d1c2c6-…`; consent screen read
  `{"client_name":"Claude Code (budget-qa)","redirect_host":"localhost","loopback":true,…}`; decision
  `allow`/`full` → `redirect_to=http://localhost:61072/callback?code=…&state=…`.
- Pasted back: **`Authenticated with "budget-qa". Its tools are now available in Claude Code.`**
- `claude mcp list` → `budget-qa: https://localhost:8443/mcp (HTTP) - ✔ Connected`; `claude mcp get`
  → `Status: ✔ Connected` (its health check is a real connect over the connector).
**The manual step the sheet allowed for, documented**: with stdin on a FIFO the CLI refuses outright —
`Couldn't complete authentication for "budget-qa": stdin isn't a terminal, so authentication can't be
completed here. Re-run in an interactive terminal — e.g. 'ssh -t' — and paste the redirect URL when
prompted.` It needs a **pty**; driven through `pty.fork()` (`$S/mcpr/p12_pty.py`) it completes. That
is a `claude`-side constraint, not our server's. One benign notice on its side:
`[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp … SEP-2352 isolation is inactive`.
Cleanup: `claude mcp logout` + `claude mcp remove` both fine, config entry gone, `claude mcp list` no
longer shows it. **Note for the owner (matches MCP.md §0):** `logout`/`remove` do NOT revoke
server-side — grant `6bd2f013-…` "Claude Code (budget-qa)" stayed active in `/oauth/apps` afterwards,
which is exactly why the doc tells users to disconnect in Budget's Settings.

### P13 [STOP] stdio regression — the old path still works
Mint read and full PATs under `$J1`, then inside the image (R-B, no TLS): `$DC exec -T -e
BUDGET_API_URL=http://localhost:8000 -e BUDGET_PAT=$PAT api python -m budget_api.mcp`, driven by the
`mcpprobe.py` frame driver from `.tasks/mcp-decorators/qa-checklist.md` (Popen, stdin held OPEN,
`initialize` → `notifications/initialized` → `tools/list`). Expect **20** names for the read PAT and
**35** for the full PAT (36 only with an upload folder — not set here). Failure = D1's dependency
move or `build_server`'s new `credential` argument broke the path the owner uses today. **Status**: ✅ pass
R-B confirmed: the `mcp` SDK is in the image, `python -m budget_api.mcp` runs inside the api
container, no TLS involved. Driver `$S/mcpr/mcpprobe.py` (Popen, stdin held OPEN, `initialize` →
`notifications/initialized` → `tools/list`), command
`dc exec -T -e BUDGET_API_URL=http://127.0.0.1:8000 -e BUDGET_PAT=<pat> api python -m budget_api.mcp`.
- read PAT → **20** tools, no write names, no `upload_receipt`; stderr
  `budget-mcp: ready — 20 tools, token scope "read", API http://127.0.0.1:8000, uploads off`.
- full PAT → **35** tools, no `upload_receipt` (no upload dir set, as expected); stderr
  `budget-mcp: ready — 35 tools, token scope "full", API http://127.0.0.1:8000, uploads off`.
The 20 read names are identical to what the remote read grant published in P4 — one tool table, two
transports.

### P14 [INFO] teardown + disk
`$DC down -v --rmi local` (THIS project only), then `docker run --rm alpine df -h /` — report, and
escalate above 85%. No DB drop, no foreign container, no global prune: mass deletions are reported
to the orchestrator, not performed. **Status**: ✅ pass
Disk **before** `up`: `overlay 58.4G, used 32.9G, avail 22.5G, 59%` — under 85%, proceeded.
`dc down -v --rmi local` on `budget-prod-qa` only: 5 containers, 4 volumes (`pg_data`, `minio_data`,
`caddy_data`, `caddy_config`), 1 network and the locally built images removed. Verified after:
`docker ps -a | grep budget-prod-qa` = 0, `docker volume ls` = 0, `docker network ls` = 0. The
owner's dev stack was untouched and is still up and healthy (`budget-postgres-1`, `budget-minio-1`);
the dev `budget` DB was never connected to, and no migration ran against it.
Disk **after**: `used 37.1G, avail 18.3G, **67%**` — +4.2 GB, all of it buildx cache from the one
`up --build`. Below the 85 % gate, so nothing was pruned: **a `docker builder prune` is for the
orchestrator to decide**, not for this role. One more consequence to report rather than fix:
`--rmi local` also dropped the locally built `budget-minio:RELEASE.2025-04-22T22-12-26Z` (the
build-from-source MinIO of `docker-compose.prod.yml`), so the next prod-like bring-up rebuilds MinIO
from source. The owner's dev MinIO is a different, registry image (`minio/minio:…`) and still present.

## Section C — what pytest proves and is NOT re-probed live
Every *decision inside the process* stays in Section A and is deliberately absent above: codes and
envelopes per endpoint; pydantic/DCR field validation (URI count, name length, `response_types`, body
cap); the no-oracle 404 families (`OAUTH_REQUEST_NOT_FOUND` unknown/expired/consumed,
`OAUTH_APP_NOT_FOUND` foreign/missing/revoked — P10 keeps only the byte-identical *foreign* pair, the
one chain-level claim among them); `user_id` scoping; boundaries; idempotent re-POSTs; all four
lifetime expiries (code 60 s, pending 10 min, access 1 h, refresh 30 d sliding — live would mean
sleeping, and `oauth_*_lifetime_seconds` exist so pytest does it in ms); the per-token 60/20-per-minute
budgets; `tools_for_scope` name by name; the 0016 CHECK + downgrade; the openapi/schema pair. Consent
rendering, the "declared by the app itself" label, the loopback warning, Settings list/dim/disconnect
and the anti-framing headers are **web-qa**.

## Summary (run 2026-10-08, one bring-up, one teardown)
Live (B): **15** probes (P1–P14 + P1b) / ✅ **15** / ❌ **0** / 🚫 **0**. **Overall: ✅ READY FOR
REVIEW.** No defect found; nothing was escalated as a code change.
Pytest (A): not run by this role — `make test` is the backend/senior-lead gate and the brief said
the gates were already green; running it would have raced the live stand (serialisation rule).

**Amendments applied during the run** (each noted in its probe):
1. P1 — the exact `WWW-Authenticate` string from B2, and 401 on GET as well as POST (no 405).
2. P4 / P11 — a write tool under a `read` grant answers `Unknown tool "create_account".` with
   `isError: true`; no inner HTTP call, therefore **no 403 audit row**. The sheet's "expect the 403
   of the refused write" is withdrawn; `tools/list` and unknown-tool calls are not audited.
3. P5 — with `token_endpoint_auth_method` OMITTED the server must and does SUCCEED
   (`client_secret_post`, secret minted and used); the probe's "record the refusal and stop" arm
   never fired.
4. P8.2 / P8.7 — a refused-but-trusted authorize request is a 302 back to the registered
   `redirect_uri` carrying `error=…` (already amended in the sheet before the run).
5. P11 — audit columns `path` / `occurred_at` (grooming fix, correct as written).
6. P13 — runs inside the api container against `http://127.0.0.1:8000` (R-B).
7. P1b — added as an INFO probe by senior-lead; recorded, not a defect.

**Things worth the owner's attention, none of them a defect**
- `GET /mcp` with a valid bearer returns a 200 `text/event-stream` that is never written to and is
  held open (P1b).
- `claude mcp login --no-browser` requires a real TTY; a pipe is refused by the CLI itself (P12).
- Signing out / removing the connector in `claude` does not revoke the grant server-side — only
  Settings → Connected AI apps does, which is exactly what `MCP.md` §0 already tells users (P12).

**Stand hygiene.** Users `qa-mcpr-1@budgetqa.dev` / `qa-mcpr-2@budgetqa.dev` only, project
`budget-prod-qa` only, ports 8480/8443 only; 5173 / 8010 / 5443 / 9010 / 9011 and 5433 / 8000 / 8081
untouched; the owner's dev stack stayed up throughout and its `budget` DB was never connected to.
Artifacts (tokens, driver scripts, raw frames, logs) under
`/private/tmp/claude-501/-Users-nikitazaretski-work-budget/747ab211-bae8-459f-898e-7671d506058f/scratchpad/mcpr/`.
