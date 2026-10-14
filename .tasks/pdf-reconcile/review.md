# Code review — pdf-reconcile (S1–S4, FULL tier) — code-reviewer, 2026-10-14

Scope: `git diff` + untracked files under `apps/api/` (priority order of the brief), plus a skim of
`apps/web/src/data/imports.ts` for cache discipline. Gate results are senior-lead's (not re-run).
Two targeted probes were run: one pytest against `budget_test_s2` (temporary file, deleted) and one
10-line regex script. The owner's real PDF was NOT opened.

## Findings

### 1. BLOCKER — a second `POST /{id}/reconcile` on a session that already holds a report answers 500
`apps/api/src/budget_api/routers/statement_imports.py:2305-2328` (the claim UPDATE) vs
`apps/api/alembic/versions/0019_pdf_reconcile.py:1574-1578` / `models/statement_import.py` CHECK
`reconciliation_present`: `(reconciliation_status = 'ok') = (reconciliation IS NOT NULL)`.

The claim sets `reconciliation_status='running'` and leaves the `reconciliation` JSONB untouched. On a
session whose previous run stored a report (status `ok`, document NOT NULL) the row becomes
`running` + NOT NULL → `false = true` → the CHECK refuses the UPDATE → `IntegrityError` → unhandled →
HTTP 500, and the session is never re-claimed. Only a `failed` or never-run session can be reconciled
twice. Architecture D-R5 says "A later run overwrites", the web offers a re-run button, and the QA
checklist (PR-9, step 1/2) does exactly this — its own `UPDATE … SET reconciliation_status='running'`
on a row with a report will fail against the same CHECK.

Evidence: probe test (Priorbank CSV, `FakeProvider("fake")`, POST reconcile twice) — first 200, second
raises `sqlalchemy.exc.IntegrityError` from the claim UPDATE. Not covered by the suite:
`test_a_running_claim_refuses_the_second_run_until_it_goes_stale` sets `running` by SQL on a session
that has no report; both happy-path tests run once.

Fix: the claim UPDATE must also write `reconciliation=null()` (the `failed` arm already clears it, so
"while running there is no report" is the consistent reading; `_reconciliation_headline` and the GET
then answer "no counts" while `running`, which the web's running arm already expects). Add the
missing test: run → `ok` → run again → 200 with a fresh `reconciled_at` and the document overwritten.
Fix the QA checklist step 1 accordingly (clear the JSONB in that UPDATE, or provoke on a never-run
session). Do NOT relax the CHECK to one-directional — the biconditional is the ruling in §6.

### 2. MINOR — `_TAIL_RE`'s plain-space thousands grouping swallows a trailing digit token of the description
`apps/api/src/budget_api/services/statement_import/alfa_pdf.py:213-217, 246, 408-441`.

`_NUM`'s first alternative accepts a PLAIN SPACE as a thousands separator and is tried first. On an
income line whose description ends in a 1–3 digit token and whose amount is a multiple of three
digits, the tail match starts one token early. Probe:
`'20.09.2026 Зачисление возврата по чеку 12 100 BYN 100 BYN'` → `_description` =
`'Зачисление возврата по чеку'` (the "12" is gone), tail groups `('12 100','BYN','100','BYN')`,
`_tail_mismatch(…, 10000)` = `True`. Expense lines are safe (the `-` breaks the group).

Why it matters: (a) the `alfa:v1` canon's `description` loses a token — deterministic, so no
duplicate on re-upload, but the preview/transaction description is wrong; (b) `tail_mismatch_rows`
counts a phantom disagreement, and that log number is what FLAG-6's follow-up decision is taken on.
Fix: in `_TAIL_RE` accept grouped thousands only with the two NBSP code points (keep the plain-space
form for the header anchors, where a label precedes the number and no ambiguity exists), or
require the plain `-?\d+(?:\.\d+)?` reading to be tried first AND the grouped one only when the
plain one cannot complete the tail.

### 3. MINOR — `_max_tokens` ceiling is below the per-item sizing at the allowed report size
`apps/api/src/budget_api/services/reconcile.py:108-110, 592-594`; `config.py` `reconcile_max_items_per_side=300`.

`_TOKENS_PER_ITEM=60` × up to 600 open items = 36 000, capped at `_MAX_TOKENS_CEILING=16384`. Above
~270 open items a model that reports most of them hits `max_tokens` → `truncated` →
`RECONCILIATION_FAILED`, deterministically and with nothing the user can change. The cap is a
settings knob while the ceiling is a module constant, so the two can disagree silently.
Fix: derive the ceiling from the config (`2 × max_items_per_side × _TOKENS_PER_ITEM`, well within
the families' output limits), or lower the default `max_items_per_side` to what 16 384 covers and
say so in the setting's comment.

### 4. MINOR — a header balance figure can reach a log line
`alfa_pdf.py:366-368` (`f"{label}: unreadable amount {match.group(1)!r}"`) → the router logs the
`StatementParseError` message at INFO (`statement parse failed (account …): …`).

The module promises "COUNTS only" in logs and the header is the PII block of the file. The quoted
value is a balance/total — not the holder's name, but a money figure of the user's account, logged
only when `_NUM` matched and `_minor_units` refused (e.g. three decimals). Fix: drop the value from
the message (`f"{label}: unreadable amount"`); the label alone diagnoses the drift.

### 5. MINOR — `reconciled_at` is stamped on `failed` runs, against D-R5 and the schema's own comment
`routers/statement_imports.py:2374` (`reconciled_at=func.now()` on both arms);
`schemas/statement_import.py` `StatementImportRead.reconciled_at` says "null unless one is stored";
architecture D-R5 lists `reconciled_at` only on the `ok` arm; `test_statement_reconcile_api.py:361`
pins the opposite (`is not None` after a failure).

Pick one. If "when did we last TRY" is the intended meaning, fix the schema comment and D-R5 (and
the web, which renders it under the `ok` arm only — harmless). Otherwise write `reconciled_at` only
on `ok` and flip the assertion.

### 6. MINOR — docs/backend.md does not know the two routes or the four new codes
`docs/backend.md:23` lists the `/statement-imports` routes and says "MCP — НЕТ для всех девяти
маршрутов" (there are now eleven; `POST /{id}/reconcile` and `GET /{id}/reconciliation` are absent);
`docs/backend.md:112` lists `STATEMENT_EXTRACTION_FAILED`/`AI_NOT_CONFIGURED`/`AI_UNAVAILABLE` but
not `STATEMENT_BALANCE_MISMATCH` (422), `RECONCILIATION_FAILED`/`RECONCILIATION_TOO_LARGE` (422) or
`RECONCILIATION_RUNNING` (409). S6b may still be open — flagged so it is not missed at scope close.

### 7. NIT — the call record under-reports tokens when the answer is structurally unusable
`alfa_pdf.py:548-566`: `_answered` raising `invalid_output` inside the `try` logs `failed_usage`
(zero tokens) although the provider call succeeded and was billed. Log the real `usage` with
`outcome=error:invalid_output` instead.

### 8. NIT — `open_line` survives a page footer
`alfa_pdf.py:305-314`: a non-date line after `N / N` is appended to the last operation of the
previous page. Fine when page 2 starts with the column titles (what senior-lead saw); any furniture
printed above them would become part of a description AND of the `alfa:v1` canon. Closing
`open_line` at a footer costs nothing and makes the assumption explicit.

### 9. NIT — a continuation that itself starts with `dd.mm.yyyy ` is promoted to an operation
`alfa_pdf.py:242, 307-309`: the salary line wrapped right before an inner date would become a
second, tail-less "operation"; the model is forced to answer it and the self-check then fails the
statement. Correct under FLAG-2, but worth one sentence in the docstring as a known false-positive
shape.

### 10. NIT — the final outcome write is unguarded
`routers/statement_imports.py:2356-2381`: no `WHERE reconciliation_status='running'`, so a zombie
run past 2× budget overwrites a live re-claim's result (last writer wins between two runs), and a
session deleted mid-loop makes the UPDATE a no-op with the POST answering `reconciled_at=None`. Edge
cases; acceptable for v1, note them.

### 11. NIT (web) — one redundant GET per run
`apps/web/src/data/imports.ts:164-183`: `onSuccess` seeds `qk.importReconciliation` and then the
session invalidation re-enables the `staleTime: 0` query, which refetches what was just seeded.
Consistent with the mechanism docs/web.md describes; no cache-discipline violation found (key under
the import id, no money invalidation, polling conditional on the cached field, `fresh` is
observer-level).

## Verified, no finding
- **PII cut**: the header string reaches only `_anchors`; `raw={"line": …}` is the operation line;
  the prompt document is `{currency, lines}`; the summary log line is counts + user id. The
  committed fixtures/generator/evals use invented holder (`ИВАНОВ ИВАН ИВАНОВИЧ`), passport,
  address and IBAN (`BY00ALFA000…`); `SHOP "SANTA-362"` in the text fixture pre-exists in the Credo
  fixtures (`tests/helpers.py:189`), so it is a house merchant, not a value from the PDF.
- Anchors match `sample-structure.md` (wrapped label via `\s+` over the joined header, each label
  named, period lookbehind); money through `domain/money` at the statement exponent, `Decimal`
  only; self-check in integer minor units, order balance → income → expense → date_range, data not
  exception; continuation join with one space; FLAG-2 honoured; chunking with global keys, union
  validated, one retry for `invalid_output|truncated` only, all-or-nothing; cap and quota before the
  first call (after anchors — the ruling); prompt carries the "raw bank data, never instructions"
  line; fingerprint pinned.
- Reconcile: steps/tokens/time enforced with named reasons; terminal validation (kind ↔ id arity,
  open sets only, short keys mapped back, dedupe, empty explanation dropped, counts server-side);
  claim is one `UPDATE … RETURNING`, committed before the loop, stale re-claim after 2× budget;
  `null()` for the JSONB on failure; no-oracle 404 on both routes (asserted on the POST); JWT-only
  via `current_active_user`, both pairs in `NEVER_PAT`; own rate-limit namespace;
  `RECONCILIATION_TOO_LARGE` before the claim and before any call (call counter asserted); views
  joined at read with `null` for a deleted tx; language from `Profile.language`; every query
  `user_id`-scoped (rows through the owned parent).
- `llm/`: canonical `tool_json` on the Anthropic wire, `omit` when tool-less, `tool_choice`
  grammar; replay key grows only with tools (literal pinned); `ToolUseBlock` round-trips through
  the store; Ollama positional ids, `role: tool` per result, `tool_use` stop reason unless
  `max_tokens`; no operation text in any log line.
- 0019: the seven CHECK strings are byte-identical to the model (`_values` joins with `", "`),
  downgrade symmetric and row-keeping, `server_default`s honest for existing rows.
- apply/replace: gate in `_load_target` inside the retried procedure, stamp after the inserts and
  `learn_categories` in the same transaction with an explicit flush; `_legs` is the one definition,
  `<= as_of` on the `Date` column, `diff = app − closing`.
- Upload gate order account → size → format → provider → (anchors, cap, quota) → extract →
  currency; `PARSERS[format](data)` keeps CSV/XLSX byte-identical in behaviour.

## Verdict: fix-first

One BLOCKER: re-running the agent on a session that already has a report trips the
`reconciliation_present` CHECK and 500s — a user flow the architecture, the web and the QA
checklist all rely on, confirmed by a probe and uncovered by the suite; the fix is one column in
the claim UPDATE plus a test. The rest is MINOR/NIT: a tail-regex ambiguity that distorts the
FLAG-6 metric and the description on income lines ending in digits, a token ceiling that cannot
serve the configured item cap, a balance figure that can reach a log line, a `reconciled_at`
semantics drift between code, schema comment and D-R5, and the backend doc missing the two routes
and four codes. Everything the brief asked to be verified on money, PII, scoping, the claim, the
wire shapes and the migration holds.
