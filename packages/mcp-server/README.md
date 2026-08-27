# Budget MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI client — Claude Desktop or
Claude Code — read and change **your** budget through the same API the web and mobile apps use.
It runs locally over stdio, talks to your Budget API with a personal access token that you issue
and can revoke at any time, and exposes 35 tools built from the API contract itself: listing and
filtering transactions, server-computed statistics and currency conversion, and — with a token
that allows it — creating and correcting transactions, categories, recurring payments, budgets
and goals.

**Two modes, decided by the token.** A `read` ("View only") token gets only the 20 read
tools: the write tools are not merely refused, the AI client never sees that they exist, so it
cannot even attempt a change. A `full` ("View and change") token gets all 35, including the one
irreversible tool, `delete_transaction`. The server checks its own token at startup and publishes
accordingly; the API enforces the same rule independently, so a read token cannot write even if
something goes wrong on this side.

---

## 1. Issue a token

1. Open the web app and go to **Settings → Access tokens** (dev: `pnpm --filter @budget/web dev`,
   then <http://localhost:5173/settings>).
2. Press **New token**, give it a name you will recognise later ("MacBook — Claude Desktop") and
   choose what it may do:
   - **View only** → scope `read`;
   - **View and change** → scope `full`.
3. Copy the token string. **It is shown exactly once** — if you lose it, revoke the token and
   create a new one. It looks like `bgt_pat_…`.

Revoking a token in the same screen kills it immediately; the MCP client using it will start
answering with an "invalid or revoked" error.

## 2. Build the server

MCP clients start this server as a plain `node` process, outside pnpm — so it must be compiled
first. Run this after every `git pull` that touches the package or the API contract:

```bash
pnpm --filter @budget/mcp-server build
```

This produces `packages/mcp-server/dist/index.js`, which is what you point the client at.

## 3. Connect Claude Desktop

Config file (macOS): `~/Library/Application Support/Claude/claude_desktop_config.json`
(create it if it does not exist). Use ABSOLUTE paths — the client does not run from this repo:

```json
{
  "mcpServers": {
    "budget": {
      "command": "node",
      "args": ["/absolute/path/to/budget/packages/mcp-server/dist/index.js"],
      "env": {
        "BUDGET_API_URL": "http://localhost:8010",
        "BUDGET_PAT": "bgt_pat_your_token_here"
      }
    }
  }
}
```

Restart Claude Desktop after editing the file. The Budget API must be running when the client
starts — the server validates its token at startup and exits if the API is unreachable.

## 4. Connect Claude Code

```bash
claude mcp add budget \
  --env BUDGET_API_URL=http://localhost:8010 \
  --env BUDGET_PAT=bgt_pat_your_token_here \
  -- node /absolute/path/to/budget/packages/mcp-server/dist/index.js
```

## 5. Environment variables

| Variable | Required | Default | What it does |
|---|---|---|---|
| `BUDGET_PAT` | yes | — | The personal access token from Settings. The server refuses to start without it. |
| `BUDGET_API_URL` | no | `http://localhost:8010` | Base URL of the Budget API. A trailing `/` is trimmed. |
| `BUDGET_OPENAPI_PATH` | no | `apps/api/openapi.json`, resolved from `dist/` | Override the contract file the tools are generated from. Only needed if the package is run from outside the monorepo. |

There are no other flags: the token decides the scope, and everything else is read from the
committed API contract at startup.

## 6. The tools

Read tools (both scopes):

| Tool | What it does |
|---|---|
| `list_transactions` | Search/filter transactions by period, category, direction — the source of every `transaction_id` |
| `get_transactions_summary` | Per-category totals for one month, computed server-side |
| `list_categories` | Categories with their ids and structure |
| `list_accounts` | Accounts (cards, cash) with their ids, currency and server-computed balance — the source of every `account_id` |
| `list_deposits` | Term/savings deposits: body and accrued interest, computed server-side |
| `get_deposit` | One deposit in detail |
| `list_goals` | Savings goals: target, saved so far, currency |
| `get_goal` | One goal in detail |
| `get_goal_progress` | Server-computed progress series for one goal |
| `list_goal_contributions` | Contribution history of one goal |
| `get_goal_plan` | One goal's plan tree, with the server's own rollups per node |
| `list_upcoming_goal_deadlines` | Plan nodes whose deadline falls in the next N days |
| `list_limits` | Monthly category limits with the amount already spent |
| `list_recurring` | Recurring templates with schedule, next due date, paused state |
| `list_upcoming_recurring` | Recurring charges due in the next N days, not yet booked |
| `get_profile` | The user's settings and, above all, their base currency |
| `get_stats_summary` | Income/expense/net for a period + the base currency |
| `get_stats_monthly` | Month-by-month trend |
| `get_top_merchants` | Top merchants for a period |
| `convert_currency` | Convert an amount at the server's daily rate |

Write tools (`full` token only):

| Tool | What it does |
|---|---|
| `create_transaction` | Record one transaction |
| `update_transaction` | Correct one transaction (preferred over deleting) |
| `delete_transaction` | Permanently delete ONE transaction — the only irreversible tool |
| `create_category` | Create one category |
| `update_category` | Rename or archive a category (archiving is how categories are "deleted" — history is kept) |
| `create_account` | Create one account |
| `update_account` | Rename, re-open or archive an account |
| `create_recurring` | Create one recurring template |
| `update_recurring` | Change or pause a recurring template |
| `set_category_limit` | Set a category's monthly limit (full replace, not an addition) |
| `create_goal` | Create one savings goal |
| `update_goal` | Change or archive a goal |
| `add_goal_contribution` | Record money put aside towards a goal |
| `create_goal_item` | Add one item to a goal's plan |
| `update_goal_item` | Correct or move one plan node |

Never published at all, and each for a reason rather than by omission:
`delete_goal_item` (it cascades over a whole subtree and the user's attached files),
`create_deposit` / `update_deposit` (creating a money-holding entity, and overriding the
server's own interest figure, are not things done from a chat reply — the API refuses
those pairs independently).

Two things the tools do NOT do, by design: there is no bulk write (one entity per call, no
delete-by-filter) and no way to clear a field — an omitted field keeps its current value. Money is
always handled in integer minor units and converted by the server, never by the AI client.

## 7. Troubleshooting

Everything this server says goes to **stderr** (stdout belongs to the MCP protocol). In Claude
Desktop the log is `~/Library/Logs/Claude/mcp-server-budget.log`; in Claude Code it is printed
when the server fails to start. Every message is prefixed `budget-mcp:`.

**The server exits immediately and the client shows no budget tools.** Read the log:

- `BUDGET_PAT is not set — issue a personal access token in the web app (Settings; the value is
  shown exactly once) and pass it to this server as BUDGET_PAT.`
  → the `env` block is missing or misspelled in the client config.
- `The API token is invalid or revoked — issue a new token in the web app (Settings) and update
  BUDGET_PAT.` → the token was revoked, mistyped or truncated. Issue a new one in Settings and
  update the config (the whole string, including the `bgt_pat_` prefix).
- `Cannot reach the Budget API at http://localhost:8010 — is the server running?`
  → start the API (`cd apps/api && uv run uvicorn budget_api.app:create_app --factory --reload
  --port 8010`), or fix `BUDGET_API_URL`.
- `cannot read the API contract at …/apps/api/openapi.json` → the package was moved out of the
  monorepo, or the file is missing. Run `pnpm openapi` at the repo root, or set
  `BUDGET_OPENAPI_PATH`.
- `the tool allowlist is out of sync with openapi.json — regenerate the contract (pnpm openapi at
  the repo root) and rebuild:` followed by a list. The API changed and this package is stale:
  run `pnpm openapi` at the repo root, then `pnpm --filter @budget/mcp-server build`. If the list
  still complains after that, the endpoint really is gone and the package needs a code change.

**The assistant only reads, and says it cannot change anything.** The token is `read`. There is no
setting to change here: create a "View and change" (`full`) token in Settings, put it in
`BUDGET_PAT` and restart the client — the write tools appear only for such a token. If the
assistant reports `This token is read-only — create a full token in the web app (Settings) to make
changes.`, the token was replaced with a read one after the client started.

**A tool answers "not found (it does not exist, or it is not yours)".** The id belongs to another
account or no longer exists — both answer the same way on purpose. Ask the assistant to list the
entity first and use the id it got back.

**"Too many API calls — wait a minute before trying again."** The per-token rate limit (60
reads/min, 20 writes/min) kicked in. Wait, then retry.

**A response ends with `_truncated`.** The answer was over the size limit and was cut from the
tail; the marker says how many rows were shown out of how many. Narrow the query (dates, category,
a smaller `limit`).

## 8. What the token did (audit)

Every call made with a personal access token is recorded server-side in `pat_audit_log` —
including calls that were rejected. Request and response bodies are never stored, and the `path`
is the route template, so the log says *what a token did and when*, not what your money looks
like. In v1 there is no UI for it; read it with SQL:

```sql
SELECT a.occurred_at, t.name AS token, t.scope, a.method, a.path, a.status_code, a.entity_id
FROM pat_audit_log a
JOIN personal_access_tokens t ON t.id = a.token_id
ORDER BY a.occurred_at DESC
LIMIT 50;
```

Locally: `docker compose exec postgres psql -U budget -d budget` and paste the query.

Rows for a revoked token stay until the token row is deleted; pruning old rows is a manual
`DELETE` for now.
