# Privacy scan of the tracked tree (2026-10-14, read-only)

Scope: all `git ls-files` (1245), lockfiles and `schema.d.ts` excluded; history
grepped for `sk-ant-`. Nothing modified, nothing deleted. Action is the PM's;
the sslip address is known and accepted while the repo is private.

## No secrets
`sk-ant-`, AWS keys, private keys, GitHub/Slack/GitLab tokens, JWT literals:
0 hits in files and history. `ANTHROPIC_API_KEY`/`JWT_SECRET`/VAPID/R2 appear
only as placeholders, empty values, the compose dev default
(`local-development-only-not-a-secret`) or QA-stand throwaways.
`minioadmin` is the dev default (README, compose, infra.md, config.py).

## PII — act before any public release
1. Real third-party name (Credo account holder, Georgian script) in
   `apps/web/src/features/imports/bankPhrases.test.ts:60-61`; identified as
   such in `.tasks/credo-import/task.md:93`.
2. Real Credo balances/period in `.tasks/credo-import/task.md:101-103`, echoed
   in `.tasks/credo-import/plan.md:13`, `task.md:13`,
   `apps/api/src/budget_api/services/statement_import/credo.py:14`.
3. Real merchant/amount/date lines (Minsk, CH travel) reused as "synthetic"
   rows: `apps/api/tests/helpers.py:179-229`, `bankPhrases.test.ts:27-53`,
   `apps/api/tests/test_statement_apply.py:566,605,752,779`,
   `apps/api/tests/test_statement_credo_parser.py:152-161`, docstrings in
   `services/statement_import/{credo,types,apply,categories}.py`,
   `models/statement_import.py`, `schemas/statement_import.py`,
   `alembic/versions/0014_statement_row_merchant.py:8-9`.
4. Priorbank statement id `Vpsk_71466782` + card/contract tails `…7351 VISA
   SIGNATURE` / `…5817`: `.tasks/statement-import/task.md:7,11-14,24`,
   `apps/api/tests/fixtures/statement_priorbank_synthetic.csv:3,7,15,17,23`,
   `apps/api/tests/test_statement_imports_api.py:48,125`.

## IDENTIFYING
5. Live prod host `159-195-5-69.sslip.io` + provider/plan/location:
   `PLAN.md:21`, `.tasks/mcp-remote/task.md:17`; in history (`de85501`,
   `4de5ed2`). Accepted while private.
6. Commit author email on all 195 commits (yandex.ru); GitHub username +
   Projects item id in `.tasks/web-push/task.md:3`.
7. `/Users/nikitazaretski` on 42 lines in 19 `.tasks/**` files (list in the
   scan transcript; heaviest: `auth-email-password/qa-checklist.md` ×9,
   `transactions-api/qa-checklist.md` ×5, `mcp-remote/qa-checklist.md` ×4);
   hostname `MacBook-Pro-Nikita.local` in `docs/infra.md:10`.
8. Other projects' service names: `docs/infra.md:5`,
   `.tasks/auth-email-password/qa-checklist.md:52,684`,
   `.claude/skills/grooming-workflow/SKILL.md:100-105`,
   `.tasks/mcp-decorators/task.md:52`.

## COSMETIC
- `@x.com` mailboxes in `apps/api/tests/*` (374) and `.tasks` (`pwn@x.dev`,
  `foo@x.com`) — real domain, fake boxes; `example.com` would be cleaner.
- `.claude/scheduled_tasks.lock` tracked in HEAD (session id, pid).
- Tracked PNGs (`.tasks/web-push/qa-web-evidence/`) are settings-text crops,
  no account data. No profanity. No `real-*` files tracked (gitignored, never
  committed).
