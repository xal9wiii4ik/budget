# Budget MCP server (`python -m budget_api.mcp`)

An [MCP](https://modelcontextprotocol.io) server that lets an AI client — Claude in the browser,
Claude Desktop, the Claude mobile app or Claude Code — read and change **your** budget through
the same API the web and mobile apps use. It publishes 40 tools (41 with receipt upload) derived
from the API routers themselves: the same `@mcp_tool` marker that lets a token reach a route is
what makes it a tool, so "reachable by a token" and "visible to the model" cannot disagree.

**Two modes, decided by the credential.** A `read` ("View only") token gets only the 22 read tools:
the write tools are not merely refused, the AI client never sees that they exist. A `full`
("View and change") token — or a connector you granted the same mode — gets all 40, including
the one irreversible tool, `delete_transaction`. The server publishes by that mode (the stdio
server reads its own token at startup, the remote connector reads the grant on every request);
the API enforces the same rule independently, so a read credential cannot write even if
something goes wrong on this side.

This replaces the former TypeScript package `packages/mcp-server` (removed 2026-09-20). What
changed for you is in §7.

**Two ways to connect.** §0 is the REMOTE connector — nothing to install, works from claude.ai
in a browser, from Claude Desktop, from the Claude mobile app and from Claude Code, and it signs
you in through Budget's own login page. §§1–9 are the LOCAL stdio server, which needs this
repository and a personal access token on the machine that runs it. The tools are the same 40
either way; only receipt upload (§6) is local-only.

---

## 0. Connect from Claude (web / Desktop / mobile / Claude Code)

Нужен только адрес вашего Budget — `https://<ваш-домен>/mcp`. Ничего устанавливать не надо.
All you need is your Budget address — `https://<your-domain>/mcp`. Nothing to install.

**Claude (claude.ai, Desktop, mobile)**

1. RU: **Settings → Connectors → Add custom connector**.
   EN: **Settings → Connectors → Add custom connector**.
2. Вставьте адрес / paste the address: `https://<your-domain>/mcp` (ровно так, без `/` на
   конце). Give it any name you like — "Budget" — and confirm.
3. Нажмите **Connect**: откроется страница входа в Budget. Войдите своим обычным email и
   паролем (нет аккаунта — на той же странице есть ссылка «создать аккаунт», после регистрации
   вас вернёт обратно).
   Press **Connect**: Budget's own sign-in page opens. Sign in with your usual email and
   password (no account yet — the link on that page registers one and brings you back).
4. На странице согласия выберите режим / on the consent screen pick the mode:
   - **Только просмотр** / **View only** — Claude видит данные и ничего не меняет;
   - **Просмотр и изменение** / **View and change** — Claude также создаёт, правит и удаляет
     транзакции.
   Затем **Разрешить доступ** / **Allow access**. Браузер вернёт вас в Claude, и коннектор
   готов. Чтобы сменить режим — отключите коннектор и подключите заново.

**Claude Code**

```bash
claude mcp add --transport http budget https://<your-domain>/mcp
```

Затем в сессии наберите `/mcp`, выберите `budget` и нажмите **Authenticate** — откроется тот же
вход в Budget и та же страница согласия. / Then run `/mcp` in a session, select `budget` and
press **Authenticate** — the same Budget sign-in and the same consent screen follow.

**Отключение / disconnecting.** Budget → **Настройки → Подключённые AI-приложения** →
**Отключить** (EN: **Settings → Connected AI apps → Disconnect**). Отключение действует
немедленно: Claude сразу перестаёт видеть данные. Удаление коннектора на стороне Claude само по
себе доступ НЕ отзывает — отзывайте его здесь.

**Если домен сменился.** Адрес коннектора — часть его личности, поэтому после смены домена
(`SITE_DOMAIN`, см. `docs/deploy.md`) старый коннектор перестаёт работать: удалите его в Claude
и добавьте заново с новым адресом. / A connector is identified by its URL, so after a domain
change the old one stops working: remove it in Claude and add it again with the new address.

> Проблемы с подключением — §8 (troubleshooting): «Authorization failed», 307 на `/mcp`,
> `WWW-Authenticate` и как это проверить curl'ом.

---

## 1. Issue a token

1. Open the web app and go to **Settings → Access tokens** (dev: `pnpm --filter @budget/web dev`,
   then <http://localhost:5173/settings>).
2. Press **New token**, name it so you recognise it later ("MacBook — Claude Desktop") and choose:
   - **View only** → scope `read`;
   - **View and change** → scope `full`.
3. Copy the token string. **It is shown exactly once.** It looks like `bgt_pat_…`.

Revoking a token in the same screen kills it immediately; the client using it starts answering
with an "invalid or revoked" error.

## 2. The launch command

There is nothing to build. The one command, from anywhere:

```bash
uv run --frozen --extra mcp --directory /absolute/path/to/budget/apps/api python -m budget_api.mcp
```

Every part is load-bearing:

- `--extra mcp` — the MCP SDK is an **optional extra** of the API project
  (`[project.optional-dependencies] mcp`), not a runtime dependency: the API Docker image is
  built without it and must stay that way. `uv run --extra mcp` installs the extra into the
  project venv on first use; on a dev machine the `dev` group already pulls it in, so the flag
  costs nothing but guarantees the SDK is there.
- `--frozen` — use `uv.lock` as is, never re-resolve on a client's start.
- `--directory` — absolute path: MCP clients do not run from this repo.
- `python -m budget_api.mcp` — the ONE entry point; there is no console script on purpose.

The Budget API must be running when the client starts: the server validates its token at
startup (`GET /tokens/self`) and exits with a sentence if the API is unreachable.

## 3. Connect Claude Desktop

Config (macOS): `~/Library/Application Support/Claude/claude_desktop_config.json`. Use the
**absolute path to `uv`** — GUI apps do not have your shell `PATH` (`which uv` → typically
`/opt/homebrew/bin/uv`). If you are migrating, keep the old `budget` entry until this one shows
"connected", then delete it — two servers with the same tool names confuse the model.

```json
{
  "mcpServers": {
    "budget-py": {
      "command": "/opt/homebrew/bin/uv",
      "args": [
        "run", "--frozen", "--extra", "mcp",
        "--directory", "/absolute/path/to/budget/apps/api",
        "python", "-m", "budget_api.mcp"
      ],
      "env": {
        "BUDGET_API_URL": "http://localhost:8010",
        "BUDGET_PAT": "bgt_pat_your_token_here"
      }
    }
  }
}
```

Add `"BUDGET_UPLOAD_DIR": "/absolute/path/to/receipts"` to `env` to enable `upload_receipt`
(§5). Restart Claude Desktop fully (Quit, not close the window) after editing the file.

## 4. Connect Claude Code

```bash
claude mcp add budget-py \
  --env BUDGET_API_URL=http://localhost:8010 \
  --env BUDGET_PAT=bgt_pat_your_token_here \
  -- uv run --frozen --extra mcp --directory /absolute/path/to/budget/apps/api python -m budget_api.mcp
```

## 5. Environment variables

| Variable | Required | Default | What it does |
|---|---|---|---|
| `BUDGET_PAT` | yes | — | The personal access token from Settings. The server refuses to start without it. |
| `BUDGET_API_URL` | no | `http://localhost:8010` | Base URL of the Budget API. Trailing `/` is trimmed. |
| `BUDGET_UPLOAD_DIR` | no | unset = uploads off | Absolute path to an EXISTING folder. When set, a `full` token also gets `upload_receipt`: the model passes a file *path* inside this folder (checked after symlink resolution), the file must be a real JPEG (magic bytes, not extension) under 10 MB. |

There is no `BUDGET_OPENAPI_PATH` any more: tools are built from the live application, not from
a contract file, so there is no stale-contract failure mode and no rebuild after `git pull`.

## 6. The tools

Read (both scopes, 20): `list_transactions`, `get_transactions_summary`, `list_categories`,
`list_accounts`, `list_deposits`, `get_deposit`, `list_goals`, `get_goal`, `get_goal_progress`,
`list_goal_contributions`, `get_goal_plan`, `list_upcoming_goal_deadlines`, `list_limits`,
`list_recurring`, `list_upcoming_recurring`, `get_profile`, `get_stats_summary`,
`get_stats_monthly`, `get_top_merchants`, `convert_currency`.

Write (`full` only, 15): `create_transaction`, `update_transaction`, `delete_transaction` (the
only irreversible one), `create_category`, `update_category`, `create_account`,
`update_account`, `create_recurring`, `update_recurring`, `set_category_limit`, `create_goal`,
`update_goal`, `add_goal_contribution`, `create_goal_item`, `update_goal_item` — plus
`upload_receipt` when `BUDGET_UPLOAD_DIR` is set.

Never published, each for a reason written next to the route (`# MCP: no — …`):
`delete_goal_item` (cascades over a subtree and attached files), `create_deposit` /
`update_deposit` (creating a money-holding entity, overriding the server's interest figure),
`PATCH /profile` (base currency is changed by a human), statement imports, receipt parsing
(spends your AI budget). Where each tool's description lives: `docs/mcp.md`.

By design: no bulk write (one entity per call, no delete-by-filter), no way to clear a field
(omitted = keep), money always in integer minor units and converted by the server, never by the
client. `create_transaction` carries a server-side idempotency `client_id` the model never sees,
so a transport retry cannot create a duplicate.

## 7. What is different from the TypeScript server

- **Order of tools in `tools/list`.** Both servers list every read tool before every write
  tool. Inside each group the old server followed its curated table; this one follows router
  order (categories, accounts, transactions, …). The set is identical; only the sequence the
  model reads differs.
- **`isError: false` on success.** The old server omitted the field on a successful call; this
  one sends it explicitly. Per the MCP spec the field is optional and defaults to `false`, so
  no client behaves differently.
- **`list_deposits` / `get_deposit`.** If your Claude Desktop still runs a `dist/` built before
  the deposits scope, these two read tools are new to you after switching. The current sources
  of both servers had them (35 = 35, verified byte-for-byte on 2026-09-20).
- No build step, no `BUDGET_OPENAPI_PATH`, no "allowlist out of sync" failure (§5).

## 8. Troubleshooting

Everything this server says goes to **stderr**, prefixed `budget-mcp:`; stdout belongs to the
protocol. Claude Desktop log: `~/Library/Logs/Claude/mcp-server-budget-py.log`.

- `uv: command not found` / `spawn uv ENOENT` → `command` must be the absolute path to `uv`.
- `BUDGET_PAT is not set — …` → the `env` block is missing or misspelled.
- `The API token is invalid or revoked — …` → issue a new token in Settings, paste the whole
  string including `bgt_pat_`.
- `Cannot reach the Budget API at http://localhost:8010 — is the server running?` → start the
  API (`cd apps/api && uv run uvicorn budget_api.app:create_app --factory --reload --port 8010`)
  or fix `BUDGET_API_URL`.
- `BUDGET_UPLOAD_DIR must be an absolute path` / `points at "…", which does not exist` → fix
  the folder; the server refuses to start rather than silently publish a broken tool.
- On success the log ends with `ready — 40 tools, token scope "full", API …, uploads off`
  (20 for a read token; 36 with uploads on).
- **The assistant only reads.** The token is `read`; create a `full` token and restart.
- **"not found (it does not exist, or it is not yours)"** — same answer on purpose for a foreign
  and a missing id; list first, then use the returned id.
- **"Too many API calls — wait a minute"** — per-token rate limit (60 reads/min, 20 writes/min).
- **A response ends with `_truncated`** — over 50 KB, cut from the tail; narrow the query.

**Remote connector (§0).** Checks you can run yourself, replacing `<your-domain>`:

- `curl -i https://<your-domain>/mcp` must answer **401** with
  `WWW-Authenticate: Bearer error="invalid_token", …, resource_metadata="https://<your-domain>/.well-known/oauth-protected-resource/mcp"`.
  A **307/308** instead means something redirects `/mcp` — Claude follows it without the
  `Authorization` header, and the symptom is "Authorization failed" on every call.
- `curl https://<your-domain>/.well-known/oauth-protected-resource/mcp` and
  `curl https://<your-domain>/.well-known/oauth-authorization-server` must both return JSON.
  A 404 (HTML from the web container) means the connector is off on the server — the API needs
  `PUBLIC_BASE_URL`, which `docker-compose.prod.yml` derives from `SITE_DOMAIN`.
- **"Authorization failed" after it worked for weeks** → the connector was disconnected in
  Budget (Settings → Connected AI apps), or the domain changed. Re-add it (§0).
- **Claude lists no write tools** → the grant is **View only**. Disconnect it in Budget and
  connect again choosing **View and change**; there is no in-place upgrade.
- **Too many registrations — wait an hour.** Adding the connector registers a fresh client, and
  that endpoint allows 30 registrations per hour per IP; hosted Claude calls it from Anthropic's
  shared egress, so the budget is effectively per deployment (`RATE_LIMITED`, HTTP 429).
- Remote tool calls appear in the same audit trail as token calls (§9), under the connector's
  own grant.

## 9. What the token did (audit)

Every call made with a token is recorded server-side in `pat_audit_log`, including rejected
ones. Bodies are never stored; `path` is the route template. No UI in v1 — SQL:

```sql
SELECT a.occurred_at, t.name AS token, t.scope, a.method, a.path, a.status_code, a.entity_id
FROM pat_audit_log a
JOIN personal_access_tokens t ON t.id = a.token_id
ORDER BY a.occurred_at DESC
LIMIT 50;
```

Locally: `docker compose exec postgres psql -U budget -d budget`. Rows outlive a revoked token;
pruning is a manual `DELETE` for now.
