# QA Checklist: pdf-reconcile (API level, FULL tier)

## Scope
Three features on one flow: an Alfa PDF extracted by an LLM, a balance check stamped at
apply/replace, and a reconcile agent. What only a live HTTP run can prove: a real PDF
goes through pypdf → prompt → server conversion → DB and comes back as a session; the
numbers the import screen shows (`opening/closing_balance_minor`, `self_check_*`,
`balance_check`, `app_balance_minor_at_end`, `balance_diff_minor`,
`reconciliation_counts`) are consistent with the ledger `GET /accounts` reports; the two
new 503 arms are distinguishable on the wire; the claim refuses a second loop. Everything
that pytest proves cheaper — validation arms, taxonomy per error, prematch algebra,
CHECK byte-identity, prompt pins, evals accuracy — is Section A and is NOT re-run here
(each omission is named at the bottom with the test that closes it).

No live model exists on this machine (no key, no Ollama): every live case runs
`LLM_PROVIDER=fake` (D-E12 extract arm + D-L2 scripted tool arm) or `off`. Live run
ceiling: **15 scenarios** (PM policy 2026-08-19), 4 of them STOP-probes.

**The owner's real statement is never touched.** `.tasks/pdf-reconcile/real-alfa-local.pdf`
is not uploaded, not opened and not quoted by any case here. Every PDF curl uses the
committed synthetic fixtures under `apps/api/tests/fixtures/alfa/`.

---

## Stand (live run)

**Docker-disk guard, before anything else.** `docker system df` + `df -h /`. Above **85 %**
on the Docker disk or the volume holding it: STOP, report to the orchestrator, prune
nothing (memory: docker-disk quirks). The stand needs no new image — only the existing
`budget-postgres-1` on 5443 and local uvicorn processes.

**Own DB** (PM policy 2026-08-27 — `budget` on 5443 is the user's live app, never a polygon):
```bash
docker exec budget-postgres-1 psql -U budget -d postgres \
  -c "CREATE DATABASE budget_qa_pdf_reconcile"
cd apps/api && DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_qa_pdf_reconcile \
  uv run alembic upgrade head
```
Migrations are applied to the QA DB only — the API container that serves the user applies
migrations at start, so a revision landing in `budget` would wedge it (2026-08-27 incident).

**Three API processes, one QA DB**, all with the scheduler gates off, stdout to
`$SCRATCH/pdfrec/api-80NN.log`. Ports **8021 / 8022 / 8023** — never 8010, 5173, 8000,
8081, 5433:
```bash
export QA_DB=postgresql+asyncpg://budget:budget@localhost:5443/budget_qa_pdf_reconcile
export OFF="FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false PUSH_SCHEDULER_ENABLED=false"
# 8021 — the main fake stand
DATABASE_URL=$QA_DB LLM_PROVIDER=fake $OFF \
  uv run uvicorn budget_api.app:create_app --factory --port 8021
# 8022 — provider absent (PR-3)
DATABASE_URL=$QA_DB LLM_PROVIDER=off $OFF \
  uv run uvicorn budget_api.app:create_app --factory --port 8022
# 8023 — fake + a 3-line extraction quota (PR-5); also hosts PR-13, see the case
DATABASE_URL=$QA_DB LLM_PROVIDER=fake EXTRACT_DAILY_LINE_QUOTA=3/day $OFF \
  uv run uvicorn budget_api.app:create_app --factory --port 8023
```
The limiter's storage is namespaced per app (`rate_limit_scope`), so each process has its
own counters — that is why the rate-limit case can live on 8023 without fighting the
upload budget spent on 8021.

**Users — LOGIN ONCE each** (PM policy 2026-08-18), reuse `$TOKEN_A`/`$TOKEN_B` everywhere;
re-login only after restarting the process that minted nothing (the JWT is stateless, so a
restart does not invalidate it):
```bash
curl -s -X POST :8021/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"qa-pdf-a@budgetqa.dev","password":"Qa!Test1234"}'
TOKEN_A=$(curl -s -X POST :8021/auth/login \   # fixed on the run: the route is /auth/login
  -d 'username=qa-pdf-a@budgetqa.dev&password=Qa!Test1234' | jq -r .access_token)
```
`qa-pdf-a@budgetqa.dev` = owner, `qa-pdf-b@budgetqa.dev` = stranger, `Qa!Test1234`. Real
user data is never used.

**Accounts.** A live preview is unique per account (`uq_statement_imports_live_preview`), so
every parallel session needs its own account — otherwise a later upload silently displaces
the session an earlier case is still asserting on:

| var | currency | used by |
|---|---|---|
| `ACC_GOOD` | BYN | PR-1, PR-6, PR-7, PR-9, PR-10, PR-13 |
| `ACC_MISMATCH` | BYN | PR-2 |
| `ACC_OFF` | BYN | PR-3 (8022) |
| `ACC_FAIL` | BYN | PR-4 |
| `ACC_QUOTA` | BYN | PR-5 (8023) |
| `ACC_CREDO` | USD | PR-8, PR-11 |
| `ACC_PRIOR` | BYN | PR-8 |
| `ACC_TRANSFER` | BYN | PR-7 (the counter-leg) |

```bash
ACC_GOOD=$(curl -s -X POST :8021/accounts -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"name":"qa good","currency":"BYN","type":"card","starting_balance_minor":0}' | jq -r .id)
```

**Upload recipe** (the only multipart route of the API, 10/min per user — pace the uploads):
```bash
curl -s -X POST :8021/statement-imports -H "Authorization: Bearer $TOKEN_A" \
  -F file=@apps/api/tests/fixtures/alfa/alfa_good.pdf \
  -F account_id=$ACC_GOOD -F format=alfa_pdf_v1
```

**Credo bytes for PR-8** are not a committed file — the suite builds them. Same builder,
into scratch:
```bash
cd apps/api && uv run python -c \
  "import pathlib; from tests.helpers import build_credo_xlsx; \
   pathlib.Path('$SCRATCH/pdfrec/credo.xlsx').write_bytes(build_credo_xlsx())"
```
(That fixture is USD, opening `100000`, closing `179637` — the numbers PR-8 asserts.)

### Fixture contract I need from S3 (ask, not a decision)
D-E13/A2 commit three PDFs but do not say what is in them. The live run needs exactly
these three roles, and all three are also what S3's own pytest wants:
1. `alfa_good.pdf` — anchors consistent, self-check **passes**, ≥1 FX row (`original_*` pair),
   ≥1 `Зачисление` credit, ≥1 `Перевод` line (`possible_transfer`), one description with
   inner `dd.mm.yyyy` dates (the date trap), 2 pages so the repeated table header is exercised.
2. `alfa_mismatch.pdf` — identical shape, one operation amount off (or one line absent) so
   `self_check_status=failed`, `self_check_failed=balance`, with both numbers non-null.
3. `alfa_llmfail.pdf` — `alfa_good` with `LLMFAIL` inside one operation description
   (D-E12/D-L2 fail marker), so the provider-outage arm is reachable without a network.
If the engineer names them differently, the run uses whatever `ls apps/api/tests/fixtures/alfa/*.pdf`
reports and records the mapping — the three ROLES are the requirement.

---

## Section A — pytest (owner: backend-engineer)
Themes, not assertions; the authoritative per-test list is the engineer's `plan*.md`. Each
line is behaviour that can genuinely break.

### S1 — `llm/` tool-use (types, anthropic, ollama, fake, replay key)
- `tool_choice` grammar → each provider's wire shape: `None`/`auto`/`any`/`tool:<name>`;
  a spelling outside the grammar is refused rather than silently sent.
- Anthropic (`MockTransport`): `tools` carried as `{name, description, input_schema}`,
  `stop_reason="tool_use"` surfaces on the response, a `ToolResultPart` in history goes
  out as a `tool_result` block.
- Ollama: `message.tool_calls[i]` → `ToolUseBlock(id="ollama-<i>")` — ids deterministic per
  response (the next request's replay hash depends on them); `ToolResultPart` → a
  `{"role":"tool"}` message; `tool_choice` IGNORED silently (not `unsupported`);
  `stop_reason="tool_use"` iff `tool_calls` non-empty.
- **Replay key regression (D-L1):** a request WITHOUT tools hashes exactly as today — an
  existing committed categorize fixture still replays. This is the one test that keeps the
  scope from invalidating every recorded fixture.
- `_response_json` / `_response_from_json` round-trip a `ToolUseBlock` (today dropped
  silently — the bug the loop would hit first).
- `unsupported` still raised for the shapes that stay missing (`ImagePart`) — the code was
  not repurposed.
- `FakeProvider`: document dispatch (`operations` → categorize, `lines` → extract), the
  extract regex incl. the FX pair and the merchant tail, `LLMFAIL` → `unavailable`;
  the scripted tool arm picks step 1/2/3 from the number of tool results present and the
  terminal call lists every open row/tx.

### S2 — migration `0019` + `account_balance_as_of` + the apply gate
- Enum definition order + CHECK byte-identity for the five new CHECKs (the 0018 rule), and
  each paired CHECK's truth table refused by the DB, not only by code: `self_check_detail`,
  `balance_check_pair`, `reconciliation_present`.
- Downgrade keeps every row (an `alfa_pdf_v1` session survives as a journal row);
  upgrade → downgrade → upgrade over a non-empty table; `alembic check` clean after.
- **A1 cutoff:** a tz-aware transaction at `period_to 23:59` IS inside
  `account_balance_as_of(..., period_to)`; a row at `period_to+1 00:00` is not.
- `account_balance_as_of` = starting balance + both transfer legs + debt movements, scoped
  to the user and the account (a sibling account's rows and another user's rows excluded) —
  i.e. the same number `GET /accounts` publishes.
- Apply/replace stamp: `match` on an exact ledger; `mismatch` with one extra in-period row
  and the SIGN of `balance_diff_minor` (= app − closing); `not_available` when
  `closing_balance_minor` is NULL. Stamped in the SAME transaction as the rows: a failing
  apply leaves no stamp.
- The gate: `self_check_status='failed'` → apply AND replace 422 `STATEMENT_BALANCE_MISMATCH`;
  row PATCH, bulk-decision, replace-preview, DELETE unaffected; the gate sits inside the
  retried procedure, so the IntegrityError retry cannot slip past it.

### S3 — Alfa extractor + the upload route
- Anchors: all six read from the joined text, incl. the wrapped `Баланс на начало` /
  `периода` label and the negative `Расход`; decimal-point / dropped-trailing-zero formats;
  a missing or unparseable anchor → `StatementParseError` with **zero provider calls**
  (counting fake) — no token spent on a file we cannot validate.
- Operation-line selection: only post-header lines starting `dd.mm.yyyy `; the page-2
  repeated header and the `N / N` footer excluded; a long `Зачисление` description with
  inner dates is neither split nor re-dated.
- **PII:** holder, passport, address, IBAN appear in neither the built request, nor `raw`,
  nor any log line — asserted against the prompt document and the stored row.
- Server conversion refusals, each → `StatementExtractionError("invalid_output")` → 422
  `STATEMENT_EXTRACTION_FAILED` with nothing stored: more decimals than the exponent, a
  non-`^[A-Z]{3}$` code, a currency ≠ the header's, an unparseable date, an unknown key, a
  missing key, a half `original_*` pair.
- Row shaping: `kind` from the sign, `amount_minor` = magnitude, `merchant` stripped ≤255
  and never `None`, `possible_transfer` from the SERVER regex, `fee_minor=0`,
  `txn_date == booked_date`, `txn_time`/`bank_category` NULL.
- Self-check order and first-failure-wins over `balance → income_total → expense_total →
  date_range`, with `expected_minor`/`actual_minor` filled and NULL for `date_range`; a
  failed self-check still RETURNS a complete statement.
- Chunking: 61 lines → 2 calls, validation over the UNION; a lost chunk (invalid_output
  after its own single retry / unavailable / time budget) → extraction failed and nothing
  stored; the retry is per-chunk only; `extract_max_lines` → 422 `STATEMENT_TOO_LARGE`.
- Quota: refused BEFORE the first call with `cost=lines` → 429 `RATE_LIMITED`.
- `PROMPT_FINGERPRINTS` pin; `FORMAT_IDS == FINGERPRINT_VERSIONS.keys()`; **`alfa:v1` canon
  determinism** — the same lines with a different model paraphrase produce the same
  `client_id` (the re-import-the-whole-history invariant).
- Registry: `EXTRACTORS` separate, `PARSERS` byte-identical, `GET /formats` publishes
  `FORMAT_IDS`.
- Router gate order account → size → format → provider → quota → extract; `app.state.llm
  is None` → 503 `AI_NOT_CONFIGURED` while a CSV upload on the same app is unaffected;
  **A3** the categorize pass still runs after extraction (two passes, `ai_status` keeps its
  meaning); provider outage mid-extraction → 503 `AI_UNAVAILABLE`, unusable output → 422 —
  and neither leaves a session behind.
- Exactly ONE test opens a committed PDF (`text_lines` over a fixture); encrypted / not a
  PDF / zero extractable text → 422 `STATEMENT_PARSE_FAILED`.

### S4 — reconcile service + routes
- `prematch` settles `exact` only (by the stored `client_id`, not by a guess); `similar`
  becomes `pairs` with `amount_delta_minor`/`date_delta_days`; every open row also gets
  same-kind open txs within ±3 days as pairs; `row_to_parsed` preserves the fingerprint.
- Loop: the fake's three steps → a report with all open rows `missing_in_app` and all open
  txs `extra_in_app`; terminal-call validation per D-R4 (foreign id dropped and counted,
  id arity per kind, explanation ≤300, duplicate `(row, tx)` first-wins); ending in text or
  exhausting `max_steps` → `invalid_output`; token-sum and time-budget aborts carry the
  right `aborted_reason`; `reconcile` never raises.
- `counts_by_kind` + `unmentioned_rows` + `unmentioned_transactions` add up against the
  open sets (the report's own arithmetic).
- `max_items_per_side` → 422 `RECONCILIATION_TOO_LARGE` before any call.
- Candidate window `[period_from−3d, period_to+3d]`, EITHER transfer leg, user-scoped.
- Claim SQL: a second POST while `running` → 409 `RECONCILIATION_RUNNING`; a
  `reconciliation_started_at` older than 2× the budget re-claims; the claim is COMMITTED
  before the loop.
- Outcome write: `ok` → JSONB + `reconciled_at` + the provider/model/prompt trio; `failed`
  → JSONB NULL + trio, 503 `AI_UNAVAILABLE` for `unavailable`, 422 `RECONCILIATION_FAILED`
  otherwise; a later run overwrites.
- Status gate (`parsed|applied|replaced` only); `GET /{id}` carries
  `reconciliation_status`/`reconciled_at`/`reconciliation_counts` + **A4**
  `reconciliation_summary`, all null unless `ok`; `GET /{id}/reconciliation` on a
  never-reconciled session → 200 `status='none'`, `items: []`; foreign/missing → one
  byte-identical 404 `IMPORT_NOT_FOUND`.
- JWT-only: both new routes land in the derived never-set of `test_pat_auth.py`.
- `require_llm_provider` 503s on `app.state.llm is None` and does NOT 503 on an empty
  `anthropic_api_key` under `LLM_PROVIDER=fake` (the whole reason the new gate exists).

### S5 — evals
- `gen_alfa --seed` deterministic (same seed → byte-identical jsonl) and its gold rows
  arithmetically consistent with the anchors it writes.
- `extract.py` metric arithmetic over a hand-made gold/predicted pair: a wrong merchant does
  not also count as a wrong amount; row-count exact rate; self-check pass rate.
- `reconcile.py` precision/recall per kind over `(kind, row_id, transaction_id)` triples on
  a report with one right and one wrong item.
- `tests/test_evals_regression.py` replays BOTH new runners with no network and no DB,
  floors as calibrated on the fake; reports carry `synthetic: true`.
- `run.py` keeps its CLI and public names after the `common.py` extraction (the untouched
  existing test is the proof).

### S6 — contract
- `pnpm openapi` regenerates both artifacts; the api-client drift test is green with the
  pair committed together.
- The exported schema carries the 12 new `StatementImportRead` fields + A4's
  `reconciliation_summary`, `StatementReconciliationRead`, `DiscrepancyCounts`, the five new
  enums in their frozen order, and the new codes on `StatementImportError`'s `anyOf`
  (`STATEMENT_EXTRACTION_FAILED`, `STATEMENT_BALANCE_MISMATCH`, `RECONCILIATION_FAILED`,
  `RECONCILIATION_TOO_LARGE`, `RECONCILIATION_RUNNING`, `AI_UNAVAILABLE`,
  `AI_NOT_CONFIGURED`); `GET /formats` publishes `FORMAT_IDS`.
- `test_openapi_export.py` / `test_mcp_exposure.py` snapshots updated deliberately, not
  regenerated blindly.

**Gates I verify at /test** (not re-run from Section A): `uv run pytest` (on `budget_test`,
NOT the QA DB), `alembic upgrade head && alembic check` from `apps/api`,
`pnpm --filter @budget/api-client test`, `pnpm turbo lint typecheck test`.

---

## Section B — live curls (owner: QA). 15 cases, 4 of them STOP-probes.

STOP-probes (`[stop]`) run on `/test` of the subtask that first crosses the boundary — PR-1,
PR-2, PR-3 after S3, PR-9 after S4 — and are not re-run at the end unless the code under
them moved. Everything else runs once, end of scope, in the order listed.

### PR-1 [stop] A fixture PDF becomes a session: pypdf → fake → DB, self-check passed
- **First boundary crossing of the scope.** `POST :8021/statement-imports` with
  `file=@apps/api/tests/fixtures/alfa/alfa_good.pdf`, `format=alfa_pdf_v1`, `account_id=$ACC_GOOD`
  → `GET /{id}` → `GET /{id}/rows?limit=200`.
- Expect **201**; `source_format="alfa_pdf_v1"`; `period_from/to` = the `Период` anchor;
  `opening_balance_minor`/`closing_balance_minor` non-null and equal to the header values;
  `self_check_status="passed"`, `self_check_failed=null`, both self-check numbers null;
  `balance_check="not_available"` with `app_balance_minor_at_end`/`balance_diff_minor` null
  (D-B1 — nothing is computed at upload); `rows_total` = the number of operation lines;
  `reconciliation_status="none"`, `reconciliation_counts`/`reconciliation_summary` null.
  Rows: the FX row carries `original_amount_minor`/`original_currency`, every other row
  carries neither; `merchant` is a string (never null) for a `Покупка` row; the
  `Перевод` row has `possible_transfer=true`; Cyrillic intact; `kind` matches the sign;
  `fee_minor=0`. **A3:** `ai_status` ∈ {`ok`,`partial`,`skipped`} with the three stamps
  filled — the categorize pass still ran on top of the extraction.
- Same frame, maximum assertions: `grep` the 8021 log for `llm call ` → ≥2 lines with
  `prompt=extract-alfa-v1` (+ the categorize lines), full key=value field set; then a leak
  grep over the log AND over `GET /{id}/rows` for the fixture's holder name, passport,
  address and IBAN substrings → **0 hits** in both.
- **Status**: ✅ PASS (2026-10-14, 8021)
- **Evidence**: upload **201** `id=e4051760…`, `source_format=alfa_pdf_v1`,
  `period_from=2026-09-01`/`period_to=2026-09-30`, `opening_balance_minor=100000`,
  `closing_balance_minor=176164`, `self_check_status=passed`, `self_check_failed=null`,
  both self-check numbers `null`; `balance_check=not_available` with
  `app_balance_minor_at_end=null`, `balance_diff_minor=null` (D-B1 holds);
  `rows_total=24` + `rows_zero_skipped=1` = the 25 operation lines of the fixture;
  `reconciliation_status=none`, `reconciliation_counts=null`, `reconciliation_summary=null`.
  `ai_status=ok`, `ai_provider=fake`, `ai_model=fake`, `ai_prompt_version=categorize-v1`
  (**A3**: the categorize pass ran on top of the extraction).
  Rows (`GET /{id}/rows?limit=200`, 24 items): exactly one row carries the FX pair
  (`2026-09-04 ONLINE SHOP KZ amount_minor=3550, original_amount_minor=450000,
  original_currency=RUB`), zero rows carry half a pair; 0 rows with `merchant=null`
  (a `Покупка` row → `"GASTRONOM NA UGLU"`, a non-merchant line → `""`); both `Перевод` /
  `Зачисление перевода` rows `possible_transfer=true`; `kind` ∈ {expense, income} matching
  the sign; 0 rows with `fee_minor≠0`; 0 rows with `txn_date≠booked_date`; Cyrillic intact
  (`"Зачисление заработной платы …"`); the date trap held — the salary line is ONE row dated
  `2026-09-03` (no row on 31.08/03.09 duplicates), and the PDF-wrapped long description came
  back joined (`"BOLSHOY GIPERMARKET NA PROSPEKTE PRIDUMANNOM DOM TRIDCAT SEM KORPUS DVA
  SEKCIYA PYAT"`). Row arithmetic: income 178651 − expense 102487 + opening 100000 = 176164
  = `closing_balance_minor`.
  Log (`api-8021.log`): 3 `llm call ` lines — `provider=fake model=fake
  prompt=extract-alfa-v1 outcome=ok batch=25 latency_ms=0 in=0 out=0 cache_read=0
  cost_usd=0 user=…` plus two `prompt=categorize-v1 outcome=ok batch=18/batch=1`; full
  key=value set present. *Checklist wording note (not a defect):* "≥2 lines with
  `prompt=extract-alfa-v1`" is unreachable by design — 25 lines is one chunk, so the
  extract pass is exactly ONE call; the ≥2 total `llm call` lines (extract + categorize) is
  what the case actually proves.
  PII grep over the log AND the rows payload for `ИВАНОВ`, `AB1234567`, `паспорт`,
  `BY00ALFA`, `ул. Придуманная`, `г. Минск`, `5***********1234` → **0 hits in both**. One
  grep for the bare token `Придуманная` hits once in the rows payload, inside the OPERATION
  description `"Перевод средств на помощь ребенку М ария Придуманная"` — the fixture's
  transfer payee, not the header PII block (the address string `ул. Придуманная` is 0 hits).

### PR-2 [stop] Mismatching fixture: parsed and displayable, but not applicable
- Chained on its own account. Upload `alfa_mismatch.pdf` to `$ACC_MISMATCH` → `GET /{id}`
  → `POST /{id}/apply` → `PATCH /{id}/rows/{row_id}` → `GET /{id}/replace-preview?from=<period_from>`
  → `DELETE /{id}`.
- Expect: upload **201** (a failed self-check is DATA, D-E7): `self_check_status="failed"`,
  `self_check_failed="balance"`, `self_check_expected_minor` and `self_check_actual_minor`
  both non-null and their difference = the fixture's planted error; rows all present.
  `POST /apply` → **422** `{"detail":"STATEMENT_BALANCE_MISMATCH"}` and the session still
  `status="parsed"`, `applied_at` null, `GET /transactions?account_id=$ACC_MISMATCH` still
  empty — the refusal wrote nothing. `PATCH` a row's `category_id` → **200**.
  `replace-preview` → **200**. `DELETE` → **204**, then `GET /{id}` → 404.
- **Status**: ✅ PASS (2026-10-14, 8021)
- **Evidence**: upload **201** `id=e884c70d…`: `self_check_status=failed`,
  `self_check_failed=balance`, `self_check_expected_minor=177414`,
  `self_check_actual_minor=176164`, difference **1250** = the fixture's
  `MISMATCH_MINOR`; `closing_balance_minor=177414`, `rows_total=24` (all rows present).
  `POST /apply` → **422** `{"detail":"STATEMENT_BALANCE_MISMATCH"}`; after it the session is
  still `status=parsed`, `applied_at=null`, and `GET /transactions?account_id=$ACC_MISMATCH`
  → `{"n":0,"total":0}` — the refusal wrote nothing. `GET /replace-preview?from=2026-09-01`
  → **200** `{"deleted_total":0,…,"transfers_kept":0,"will_create":24}`. `DELETE` → **204**,
  then `GET /{id}` → **404** `{"detail":"IMPORT_NOT_FOUND"}`.
  The row `PATCH` arm was re-run on a second identical upload (`id=19cd0375…`, same
  `self_check_status=failed`) because the first attempt sent an empty `category_id` (my
  jq slip, 422 on the input, not on the gate):
  `PATCH /rows/18972407…` `{"category_id":"c861af3a…"}` → **200**
  `{"id":"18972407…","category_id":"c861af3a…","decision":"import"}`; its `replace-preview`
  **200** and `DELETE` **204** too — the balance gate touches apply/replace only.

### PR-3 [stop] Provider absent: the PDF format 503s, the CSV format does not
- On **8022** (`LLM_PROVIDER=off`). `POST /statement-imports` `alfa_good.pdf` + `alfa_pdf_v1`
  → then the same process, Priorbank CSV (`apps/api/tests/fixtures/statement_priorbank_synthetic.csv`,
  `format=priorbank_csv_v1`) to `$ACC_PRIOR`.
- Expect: PDF → **503** `{"detail":"AI_NOT_CONFIGURED"}` and no session row for `$ACC_OFF`
  (there is no listing route — verify with a read-only
  `SELECT count(*) FROM statement_imports WHERE account_id='$ACC_OFF'` → 0 on the QA DB);
  CSV → **201**, a complete session with
  `self_check_status="not_available"` — the scope's gate did not spill onto the sync parsers.
  Also `GET :8022/statement-imports/formats` → `alfa_pdf_v1` IS published (the format exists
  on this build; only the provider is missing).
- **Status**: ✅ PASS (2026-10-14, 8022)
- **Evidence**: PDF → **503** `{"detail":"AI_NOT_CONFIGURED"}`;
  `SELECT count(*) FROM statement_imports WHERE account_id='$ACC_OFF'` → **0** (nothing
  stored). Priorbank CSV on the SAME process → **201** `id=f3c43470…`, `rows_total=7`,
  `opening_balance_minor=null`, `closing_balance_minor=null`,
  `self_check_status=not_available`, `balance_check=not_available`,
  `ai_status=not_configured` — the gate did not spill onto the sync parsers.
  `GET :8022/statement-imports/formats` → `{"formats":["priorbank_csv_v1","credo_xlsx_v1",
  "alfa_pdf_v1"],"ai_formats":["alfa_pdf_v1"],"ai_available":false}` — `alfa_pdf_v1` IS
  published while the provider is missing, and the settled wire shape
  `{formats, ai_formats, ai_available}` is live.

### PR-4 Provider outage mid-extraction → 503 `AI_UNAVAILABLE`, nothing stored
- 8021, `alfa_llmfail.pdf` → `$ACC_FAIL`.
- Expect **503** `{"detail":"AI_UNAVAILABLE"}` — not 422 (the file is fine, the model is
  not), not 500; no session for `$ACC_FAIL`; the 8021 log carries one
  `outcome=error:unavailable … prompt=extract-alfa-v1` line and no operation text.
- **Status**: ✅ PASS (2026-10-14, 8021)
- **Evidence**: **503** `{"detail":"AI_UNAVAILABLE"}` (not 422, not 500);
  `SELECT count(*) … WHERE account_id='$ACC_FAIL'` → **0**; the log carries exactly one
  `llm call provider=fake model=fake prompt=extract-alfa-v1 outcome=error:unavailable
  batch=25 latency_ms=0 … cost_usd=- user=…` line, and a grep for operation text
  (`GASTRONOM|Покупка товара|Зачисление`) over the whole log → **0 hits**.

### PR-5 Extraction line quota → 429 before the first call
- On **8023** (`EXTRACT_DAILY_LINE_QUOTA=3/day`), upload `alfa_good.pdf` (more than 3
  operation lines) to `$ACC_QUOTA`.
- Expect **429** `{"detail":"RATE_LIMITED"}`; no session; and **zero** `llm call` lines with
  `prompt=extract-alfa-v1` added to `api-8023.log` (the whole point of refusing before the
  first call). A CSV upload on 8023 still 201 — the quota is extraction-scoped.
- **Status**: ✅ PASS (2026-10-14, 8023)
- **Evidence**: **429** `{"detail":"RATE_LIMITED"}`; `SELECT count(*) … WHERE
  account_id='$ACC_QUOTA'` → **0**; `grep -c 'prompt=extract-alfa-v1' api-8023.log` =
  **0 before and 0 after** — refused before the first call, no token spent. Priorbank CSV
  on 8023 (own throwaway account `$ACC_Q2`) → **201** `id=c255042b…`, `rows_total=7`,
  `ai_status=ok` — the quota is extraction-scoped.

### PR-6 Apply on an exact ledger → `balance_check=match`, and the two numbers agree
- Chained on PR-1's session. `GET /{id}` → read `opening_balance_minor` → `PATCH /accounts/$ACC_GOOD
  {"starting_balance_minor": <that value>}` (nothing else on the account; no other
  transactions) → `POST /{id}/apply` → `GET /{id}` → `GET /accounts/$ACC_GOOD` →
  `GET /transactions?account_id=$ACC_GOOD`.
- Expect: apply **200** with `created == rows_total`; session `status="applied"`,
  `balance_check="match"`, `app_balance_minor_at_end == closing_balance_minor`,
  `balance_diff_minor == 0`; the account's balance as `GET /accounts` reports it equals
  `closing_balance_minor` too — the number computed at apply and the number the user sees
  on the accounts screen are the same number; the FX row's transaction carries the
  `original_*` pair unconverted.
- **Status**: ✅ PASS (2026-10-14, 8021)
- **Evidence**: `PATCH /accounts/$ACC_GOOD {"starting_balance_minor":100000}` → 200.
  `POST /apply` → **200** `{"created":24,"skipped":0,"replaced":0,"already_existed":0}` =
  `rows_total`. Session: `status=applied`, `applied_at=2026-10-14T18:55:13Z`,
  `balance_check=match`, `app_balance_minor_at_end=176164 == closing_balance_minor=176164`,
  `balance_diff_minor=0`. `GET /accounts` for that account → `balance_minor=176164` — the
  number stamped at apply and the number the accounts screen shows are the SAME number.
  `GET /transactions?account_id=$ACC_GOOD` → 24 items, and the FX one is
  `{occurred_at:2026-09-04, amount_minor:3550, currency:BYN, original_amount_minor:450000,
  original_currency:RUB, merchant:"ONLINE SHOP KZ"}` — the pair carried through
  unconverted.

### PR-7 One in-period transfer leg survives a replace → `mismatch` with the right sign
- Chained on PR-6. `POST /transactions` a **transfer** of 10.00 BYN out of `$ACC_GOOD`
  into `$ACC_TRANSFER`, `occurred_at` inside the period (replace never deletes transfer
  rows — `apply.DELETABLE_BY_REPLACE`) → re-upload `alfa_good.pdf` to `$ACC_GOOD` →
  `GET /{id}/replace-preview?from=<period_from>` → `POST /{id}/replace
  {"from_date": <period_from>, "confirm_deleted_total": <deleted_total>}` → `GET /{id}`.
- Expect: preview reports `transfers_kept=1` and `deleted_total` = the applied rows only;
  replace **200**; session `balance_check="mismatch"`,
  `app_balance_minor_at_end == closing_balance_minor − 1000`, and
  **`balance_diff_minor == −1000`** — app minus closing, negative because the app knows one
  outgoing leg the statement does not. The replace is NOT blocked (informational, D-B1).
  Both transfer legs still exist afterwards.
- **Status**: ✅ PASS (2026-10-14, 8021)
- **Evidence**: transfer `7550b485…` 1000 BYN `$ACC_GOOD → $ACC_TRANSFER` at `2026-09-15`
  → 201. Re-upload → `id=27162ea0…`, `by_match_status={"exact":24,"similar":0,"new":0}`
  (the fingerprints settled themselves). `GET /replace-preview?from=2026-09-01` →
  `{"deleted_total":24,…,"transfers_kept":1,"debt_movements_kept":0,"will_create":24}` —
  the transfer is kept, `deleted_total` counts the applied rows only.
  `POST /replace {"from_date":"2026-09-01","confirm_deleted_total":24}` → **200**
  `{"deleted":24,"created":24,"already_existed":0}` — NOT blocked (informational, D-B1).
  Session: `status=replaced`, `balance_check=mismatch`,
  `app_balance_minor_at_end=175164 == 176164 − 1000`, **`balance_diff_minor=-1000`** (app
  minus closing, negative as specified). Both legs alive afterwards (`$ACC_GOOD` 1 transfer
  row, `$ACC_TRANSFER` 1 transfer row, both `2026-09-15`, 1000); `GET /accounts` →
  `balance_minor=175164`, i.e. the same number the session stamped.

### PR-8 The other two formats report what they can prove
- 8021. (a) Credo XLSX (`$SCRATCH/pdfrec/credo.xlsx`, `format=credo_xlsx_v1`) → `$ACC_CREDO`
  (USD); (b) Priorbank CSV → `$ACC_PRIOR` (BYN); then `PATCH /accounts/$ACC_CREDO
  {"starting_balance_minor": 100000}` → `POST` apply on the Credo session; apply the
  Priorbank session too.
- Expect (a): 201 with `opening_balance_minor=100000`, `closing_balance_minor=179637`,
  `self_check_status="passed"` (the chain already proves it); after apply with every row
  imported, `balance_check="match"`, `balance_diff_minor=0`.
  Expect (b): 201 with both anchors **null** and `self_check_status="not_available"`; after
  apply `balance_check="not_available"` with `app_balance_minor_at_end` AND
  `balance_diff_minor` both null — the `balance_check_pair` CHECK holding on the wire.
- **Status**: ✅ PASS (2026-10-14, 8021)
- **Evidence** (a) Credo XLSX `id=6cd93b07…` → **201**, `statement_currency=USD`,
  `rows_total=10`, `opening_balance_minor=100000`, `closing_balance_minor=179637`,
  `self_check_status=passed`, `balance_check=not_available` at upload; after
  `starting_balance_minor=100000` + apply (`created:10`) → `status=applied`,
  `balance_check=match`, `app_balance_minor_at_end=179637`, `balance_diff_minor=0`.
  (b) Priorbank CSV: the PR-3 session `f3c43470…` was reused instead of a fresh upload
  (same QA DB, one live preview per account — documented deviation, saves an upload against
  the 10/min budget): `opening_balance_minor=null`, `closing_balance_minor=null`,
  `self_check_status=not_available`; after apply (`created:7`) → `status=applied`,
  `balance_check=not_available` with `app_balance_minor_at_end=null` AND
  `balance_diff_minor=null` — the `balance_check_pair` CHECK holding on the wire.

### PR-9 [stop] The reconcile loop: a real tool loop over HTTP, both outcomes
- **Second boundary crossing.** (a) On a session with planted divergence: upload
  `alfa_good.pdf` to `$ACC_MISMATCH` (free after PR-2's DELETE) and seed two unrelated
  transactions inside the period on that account; `POST /{id}/reconcile` →
  `GET /{id}/reconciliation` → `GET /{id}`.
  (b) On PR-7's replaced `$ACC_GOOD` session: `POST /{id}/reconcile`.
- Expect (a) **200** with the full `StatementReconciliationRead`: `status="ok"`,
  `reconciled_at` set, `provider="fake"`, `model`, `prompt_version="reconcile-v1"`,
  `settled_exact=0`, `open_rows=rows_total`, `open_transactions=2`, `items` = one
  `missing_in_app` per open row + one `extra_in_app` per open tx (D-L2), every item's
  `row_id`/`transaction_id` arity matching its kind, `explanation` ≤300,
  `counts` + `unmentioned_*` summing to the open sets, `summary` a non-empty string;
  `GET /{id}/reconciliation` byte-identical to the POST body; `GET /{id}` carries the same
  `reconciliation_counts` and `reconciliation_summary` (A4) without the item list.
  Expect (b): `settled_exact == rows_total`, `open_rows=0`, `items=[]` except whatever the
  surviving transfer leg contributes as `extra_in_app` — i.e. the server settled the
  fingerprint matches itself and the model was left only the genuinely open row.
  3 ≤ steps ≤ 8; the log shows one `llm call … prompt=reconcile-v1` line per step.
- **Status**: ✅ PASS (2026-10-14, 8021)
- **Evidence** (a) `id=8e0d95b3…` on `$ACC_MISMATCH` (`by_match_status.new=24`) with two
  seeded unrelated expenses (777, 1313 at `2026-09-10`). `POST /reconcile` → **200**:
  `status=ok`, `reconciled_at=2026-10-14T18:56:26Z`, `provider=fake`, `model=fake`,
  `prompt_version=reconcile-v1`, `settled_exact=0`, `open_rows=24`, `open_transactions=2`,
  `counts={missing_in_app:24, extra_in_app:2, amount_differs:0, date_differs:0,
  fx_difference:0}`, `unmentioned_rows=0`, `unmentioned_transactions=0`,
  `summary="scripted fake reconciliation: every open item is reported"`; `items` = **26** =
  24 `missing_in_app` (each `row_id` set, `transaction_id` null, `row` view attached) + 2
  `extra_in_app` (each `transaction_id` set, `row_id` null — both seeded txs by merchant);
  longest `explanation` 45 chars (≤300); counts + unmentioned sum exactly to the open sets.
  `GET /{id}/reconciliation` **byte-identical** to the POST body (`cmp -s` → equal).
  `GET /{id}` → the same `reconciliation_counts` and
  `reconciliation_summary` (**A4**), `reconciliation_status=ok`, same `reconciled_at`, and
  **no** `items` key. Log: 3 `prompt=reconcile-v1 outcome=ok` lines with `batch=1,2,3` —
  3 steps, inside 3 ≤ steps ≤ 8.
  (b) PR-7's replaced session `27162ea0…` → **200**: `settled_exact=24`, `open_rows=0`,
  `open_transactions=1`, `items` = exactly ONE `extra_in_app` = the surviving transfer leg
  `7550b485… "qa transfer" 1000` — the server settled the fingerprint matches itself and
  left the model only the genuinely open row. 3 more `reconcile-v1` lines (6 total).

### PR-10 The claim: a second loop is refused, a stale claim is re-taken
- **How to provoke, proposed** (the fake loop finishes in milliseconds, so a wall-clock race
  is not reproducible): force the claim state in the QA DB — permitted, it is my own DB —
  and assert the SQL predicate from outside:
  1. `UPDATE statement_imports SET reconciliation_status='running', reconciliation_started_at=now(),
     reconciliation=NULL, reconciled_at=NULL WHERE id='<PR-9a id>'` → `POST /{id}/reconcile` →
     **409** `{"detail":"RECONCILIATION_RUNNING"}`, and the row is untouched (still `running`,
     `reconciliation IS NULL`). The JSONB MUST be nulled in the same UPDATE: CHECK
     `ck_statement_imports_reconciliation_present` (`(reconciliation_status='ok') =
     (reconciliation IS NOT NULL)`) refuses `running` on a row that holds a report — which is
     also why the service's own claim clears it (the DEF-1 fix). A never-run session works
     here too, and then nothing needs nulling.
  2. `UPDATE … SET reconciliation_started_at = now() - interval '5 minutes'` (> 2×
     `reconcile_time_budget_seconds=60`) → `POST` again → **200**, a fresh `reconciled_at`,
     the report overwritten.
  3. Informational, best-effort: two concurrent `POST`s backgrounded in one shell; record
     whichever pair of codes comes back (200+409 or 200+200) as an observation, not a
     verdict — the gate above is the verdict.
- Optional engineer-side nicety, **not required by QA**: a fake-only latency knob
  (`LLM_FAKE_LATENCY_MS`, one `await asyncio.sleep`) would make step 3 a real race. If S1
  adds it, step 3 becomes the primary method and steps 1–2 stay as the predicate check.
- **Status**: ⚠ PASS with a defect found by the probe (2026-10-14, 8021) — see **DEF-1**
- **Evidence**: the first attempt to force the claim ON PR-9a's id (`8e0d95b3…`) was
  REFUSED BY THE DB, which is itself the finding: `UPDATE … SET
  reconciliation_status='running'` on a row that already holds a report violates
  `ck_statement_imports_reconciliation_present`
  (`CHECK ((reconciliation_status = 'ok') = (reconciliation IS NOT NULL))`). The row stayed
  `ok` and untouched (`md5(reconciliation::text)` and `reconciled_at` identical before and
  after) — but the `POST /reconcile` that followed answered **500 Internal Server Error**,
  because the service's own claim UPDATE hits the same CHECK. See **DEF-1**: this is a
  real, SQL-free defect (clean repro on PR-7's session, untouched by any UPDATE).
  Steps 1–2 were therefore provoked on a never-reconciled session (`e4051760…`, PR-1's,
  `reconciliation IS NULL`) — the only state in which `running` is legal:
  1. `UPDATE … status='running', started_at=now()` → `POST` → **409**
     `{"detail":"RECONCILIATION_RUNNING"}`; row untouched (`status=running`,
     `reconciliation IS NULL`, `reconciled_at` empty).
  2. `UPDATE … started_at = now() - interval '5 minutes'` (> 2×60 s) → `POST` → **200**,
     fresh `reconciled_at=2026-10-14T18:57:30Z`, full report written
     (`settled_exact=24`, `open_rows=0`, 1 item) — the stale claim was re-taken.
  3. Concurrency probe (informational) on a third session (`c255042b…`, `status=none`): two
     backgrounded POSTs in one shell → **200 + 409** — a genuine race, the claim is
     committed before the loop and the loser gets `RECONCILIATION_RUNNING`.

### PR-11 No-oracle and the never-reconciled session
- `$TOKEN_B` against PR-9a's id and against a random UUID, on BOTH new routes
  (`POST /{id}/reconcile`, `GET /{id}/reconciliation`); then `$TOKEN_A` on the Credo session
  which was never reconciled.
- Expect: four **404** `{"detail":"IMPORT_NOT_FOUND"}`, own-vs-random bodies `cmp -s`
  byte-identical per route (conventions.md no-oracle; the 409/503 arms must not fire before
  ownership and give a stranger an existence oracle). The never-reconciled own session →
  **200** with `status="none"`, `items: []`, `counts` all zero — not a second 404 (D-R5).
- **Status**: ✅ PASS (2026-10-14, 8021)
- **Evidence**: `$TOKEN_B` → `POST /statement-imports/8e0d95b3…/reconcile` **404** and
  `POST /statement-imports/95485d53-d9d8-434b-87f5-b6a4b004caae/reconcile` **404**, bodies
  `cmp -s` identical (`{"detail":"IMPORT_NOT_FOUND"}`); the same pair on
  `GET /{id}/reconciliation` → **404** / **404**, bodies `cmp -s` identical. No 409/503 arm
  fired ahead of ownership, so a stranger gets no existence oracle.
  `$TOKEN_A` on the never-reconciled Credo session `6cd93b07…` → **200**
  `{"import_id":"6cd93b07…","status":"none","reconciled_at":null,"provider":null,
  "model":null,"prompt_version":null,"settled_exact":0,"open_rows":0,
  "open_transactions":0,"counts":{all five 0},"items":[],"summary":null}` — D-R5 as
  settled at grooming, not a second 404.

### PR-12 A token still cannot reach the import family
- Mint a PAT with `$TOKEN_A` (`POST /tokens {"name":"qa-pdf","scope":"full"}`), then with
  `Bearer bgt_pat_…`: `POST /statement-imports/{id}/reconcile`,
  `GET /statement-imports/{id}/reconciliation`, `POST /statement-imports` (multipart).
- Expect **403** `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}` on all three, bodies identical —
  the two new routes inherit the refusal by MECHANISM (no marker → not in the derived
  allowlist, D-R6), and the live run is what proves no marker crept in.
- **Status**: ❌ FAIL on the letter of the expectation (2026-10-14, 8021) — see **DEF-2**
- **Evidence**: the refusal MECHANISM holds — no PAT reaches anything in the import family,
  and the two new routes leak nothing. But the shapes differ:
  `POST /statement-imports/{id}/reconcile` → **401** `{"detail":"Unauthorized"}`;
  `GET /statement-imports/{id}/reconciliation` → **401** `{"detail":"Unauthorized"}`;
  `POST /statement-imports` (multipart) → **403** `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}`.
  The three bodies are NOT identical (`cmp` differs). Control runs with the same PAT:
  `GET /accounts` **200** (the PAT is valid), while every PRE-EXISTING import route answers
  the family's code — `GET /statement-imports/{id}` **403 TOKEN_ENDPOINT_FORBIDDEN**,
  `GET /statement-imports/formats` **403**, `GET /{id}/rows` **403**, `POST /{id}/apply`
  **403**. So only the two NEW routes answer 401. The cause is deliberate and documented in
  `routers/statement_imports.py::_stash_rl_user_jwt` ("`current_active_user` straight from
  `auth.py` rather than this router's PAT-aware dependency … must stay unreachable by a
  token even if the allowlist derivation ever changed") — stricter, but it changes the wire
  answer a client sees. Cosmetic, senior-lead's call: see **DEF-2**.

### PR-13 Reconcile rate limit
- On **8023** (its own limiter namespace, so 8021's budget is irrelevant): four
  `POST /{id}/reconcile` within a minute on an applied session.
- Expect the first three **200** (the fake releases the claim each time) and the fourth
  **429** `{"detail":"RATE_LIMITED"}` per `reconcile_rate_limit="3/min;10/day"`; the session's
  stored report is the third run's. Run this case LAST on that session — the `10/day` arm
  means POSTs are a finite budget per user per process.
- **Status**: ❌ FAIL (2026-10-14, 8023) — consequence of **DEF-1**, no separate defect
- **Evidence**: four `POST /statement-imports/f3c43470…/reconcile` (applied Priorbank
  session, `reconciliation IS NULL`) inside one minute:
  #1 **200** (`status=ok`, `reconciled_at=2026-10-14T18:59:03Z`), #2 **500**
  `Internal Server Error`, #3 **500**, #4 **429** `{"detail":"RATE_LIMITED"}`.
  The rate-limit arm itself is CORRECT — `3/min;10/day` counted all three attempts and
  refused the fourth on its own limiter namespace, with 8021's budget untouched. The
  expectation "the first three 200 and the stored report is the third run's" fails only
  because of **DEF-1**: every re-run on a session that already holds a report 500s, so the
  stored report is still run #1's (`reconciled_at=18:59:03Z`, `counts` all zero).

### PR-14 The live contract equals the committed one
- `pnpm openapi` on a clean tree → `git status --porcelain apps/api/openapi.json
  packages/api-client/src/generated/schema.d.ts` **empty** (regeneration is idempotent, the
  pair is in the commit); `pnpm --filter @budget/api-client test` green (drift);
  `diff <(curl -s :8021/openapi.json | jq -S .) <(jq -S . apps/api/openapi.json)` **empty**.
- jq assertions in the same pass: `StatementImportRead` carries all 12 new fields +
  `reconciliation_summary`, each in `required`; `StatementReconciliationRead` and
  `DiscrepancyCounts` exist with the documented shape; the five new enums carry their values
  in the frozen order; the new codes are on the error `anyOf`; `GET /statement-imports/formats`
  response includes `alfa_pdf_v1`; the two new paths are declared with their 200/403/404/409/422/503 arms.
- **Status**: ✅ PASS (2026-10-14; gates per the orchestrator's instruction not re-run)
- **Evidence**: per instruction `pnpm openapi` / `pnpm --filter @budget/api-client test`
  were NOT re-run (senior-lead's run on the merged tree: drift test green); the pair's
  co-change was checked instead —
  `git diff --stat apps/api/openapi.json packages/api-client/src/generated/schema.d.ts` →
  **non-empty on both** (`openapi.json +708/-…`, `schema.d.ts +420/-…`, 1111 insertions
  total), i.e. both halves moved in the same tree.
  `diff <(curl -s :8021/openapi.json | jq -S .) <(jq -S . apps/api/openapi.json)` →
  **empty** — the live contract IS the committed one.
  jq over `apps/api/openapi.json`: `StatementImportRead` carries all 13 new fields
  (`opening_balance_minor`, `closing_balance_minor`, `self_check_status`,
  `self_check_failed`, `self_check_expected_minor`, `self_check_actual_minor`,
  `balance_check`, `app_balance_minor_at_end`, `balance_diff_minor`,
  `reconciliation_status`, `reconciled_at`, `reconciliation_counts`,
  `reconciliation_summary` — A4 included) and **every one of them is in `required`**
  (set difference = 0). `StatementReconciliationRead` (14 properties: import_id, status,
  reconciled_at, provider, model, prompt_version, settled_exact, open_rows,
  open_transactions, counts, unmentioned_rows, unmentioned_transactions, items, summary)
  and `DiscrepancyCounts` (the five kinds) exist, plus `StatementDiscrepancy`,
  `DiscrepancyKind`, `DiscrepancyRowView`, `DiscrepancyTxView`. Enum order frozen as
  documented: `StatementSelfCheckStatus=[not_available,passed,failed]`,
  `StatementSelfCheckFailure=[balance,income_total,expense_total,date_range]`,
  `StatementBalanceCheck=[not_available,match,mismatch]`,
  `StatementReconciliationStatus=[none,running,ok,failed]`,
  `DiscrepancyKind=[missing_in_app,extra_in_app,amount_differs,date_differs,fx_difference]`.
  `StatementFormatsRead` = `{formats, ai_formats, ai_available}`, all three `required`;
  `GET /statement-imports/formats` publishes `alfa_pdf_v1` live (PR-3). The two new paths
  are declared: `/{import_id}/reconcile` POST `[200,404,409,422,429,503]`,
  `/{import_id}/reconciliation` GET `[200,404,422]`.
  Two expectations in this case do not match the API's actual contract shape and are
  **not** defects: (i) no 403 arm is declared on the new paths — but none is declared on
  ANY import path (`GET /{import_id}` `[200,404,422]`, `POST /statement-imports`
  `[201,404,422,429,503]`), so the new pair follows the family; (ii) the new error codes
  are not "on `StatementImportError`'s `anyOf`" because `detail` is
  `{"title":"Detail","type":"string"}` — codes are never enumerated in this contract.
  They do appear in the schema prose (`STATEMENT_BALANCE_MISMATCH` ×3,
  `RECONCILIATION_FAILED`, `RECONCILIATION_TOO_LARGE`, `RECONCILIATION_RUNNING`,
  `AI_UNAVAILABLE`, `AI_NOT_CONFIGURED` ×1 each); **`STATEMENT_EXTRACTION_FAILED` appears
  0 times** anywhere in `openapi.json` — an observation about documentation, not a wire
  defect (PR-2/PR-4 show the codes themselves are correct on the wire).

### PR-15 Gates (verified, not authored, by QA)
- `uv run pytest` from `apps/api` against `budget_test` → 0 failed, and the new-test count
  moved; `alembic upgrade head && alembic check` → clean; `pnpm turbo lint typecheck test`;
  **evals replay**: `uv run pytest -k evals` green with no network and no DB (both new
  runners replayed, reports labelled synthetic).
- Any failure here is escalated to senior-lead — QA does not fix engineer code.
- **Status**: ✅ verified by senior-lead's run (not re-run by QA, per the orchestrator's
  instruction: a parallel pytest/turbo would collide with the other lines)
- **Evidence**: senior-lead's gate run on the merged tree — API pytest **826 passed**,
  `pnpm turbo lint typecheck test` **12/12 tasks**, api-client contract-drift test green.
  QA re-ran none of them; the only contract check QA performed itself is PR-14's
  live-vs-committed `diff` (empty) and the `git diff --stat` co-change of the pair.

---

## Deliberately NOT in the live run (and what closes each)
- Every per-code validation arm of the extractor (bad decimals, bad currency code, unknown
  key, half FX pair, unparseable date) → S3 pytest; the fake cannot emit them on demand.
- Missing/unparseable anchors → `STATEMENT_PARSE_FAILED`, encrypted / non-PDF / zero-text
  → S3 pytest (one of them owns the single PDF-opening test).
- Self-check order (`income_total`/`expense_total`/`date_range` arms) → S3 pytest; only the
  `balance` arm is provoked live, because only it needs a committed fixture.
- Chunk boundary (61 lines → 2 calls), per-chunk retry, lost chunk, time budget,
  `extract_max_lines` → S3 pytest; a live fixture that big would be a second eval, not a probe.
- `RECONCILIATION_TOO_LARGE`, `max_steps`/token/time aborts, terminal-call validation
  (foreign ids, duplicates, explanation truncation), `RECONCILIATION_FAILED` (422 arm) → S4
  pytest; the scripted fake is deterministic and never produces them.
- Prematch algebra, the ±3-day pair construction, the candidate window, `row_to_parsed` → S4
  pytest (pure functions, no HTTP needed).
- `account_balance_as_of` edge cases incl. the A1 23:59 cutoff, debt movements, sibling
  accounts → S2 pytest; live only the end-to-end `match`/`mismatch`/`not_available` triple.
- CHECK byte-identity, the paired-CHECK truth tables, downgrade-keeps-rows → S2 pytest +
  `alembic check`.
- Anthropic / Ollama wire shapes, `stop_reason`, replay-key stability → S1 pytest with
  `MockTransport`; a live model call is out of scope by environment (no key, no Ollama).
- Evals accuracy numbers → S5; committed reports stay labelled synthetic, no number from a
  fake run reaches the README.
- Field-level 422s of the pre-existing flow, `IMPORT_FINISHED`, pagination, bulk-decision,
  the 10/min upload limit, `STATEMENT_CURRENCY_MISMATCH` → `.tasks/statement-import/qa-checklist.md`
  and its pytest; unchanged by this scope.
- Web rendering of the self-check banner, the balance line and the reconciliation screen →
  web-qa, after the frontend plan. Mobile stays frozen.

## Cleanup (end of run)
- Stop every uvicorn I started (8021/8022/8023) and confirm the ports are dead; ports
  8010/5173 and the user's containers are never touched.
- Scratch evidence stays under `$SCRATCH/pdfrec/` — no repo file is modified by the run,
  no fixture is committed from it.
- `budget_qa_pdf_reconcile` is left in place with the QA data and **reported** to the
  orchestrator for the drop (`DROP DATABASE budget_qa_pdf_reconcile` is the orchestrator's
  call, not mine). `budget` on 5443 untouched, its revision unmoved.
- `docker system df` once more in the final report, so the next scope starts from a known
  disk figure.

---

## Defects

### DEF-1 — a second reconcile run on the same session returns 500 (functional, blocking PR-13)
Any `POST /statement-imports/{id}/reconcile` on a session whose previous run SUCCEEDED
(`reconciliation_status='ok'`, report stored) answers **500 Internal Server Error**. The
claim UPDATE flips the status to `running` but leaves the stored report in place, and the
migration's own CHECK refuses that combination:

```
CHECK ((reconciliation_status = 'ok') = (reconciliation IS NOT NULL))   -- ck_statement_imports_reconciliation_present
```

API traceback (`api-8021.log`):

```
sqlalchemy.exc.IntegrityError: CheckViolationError: new row for relation "statement_imports"
violates check constraint "ck_statement_imports_reconciliation_present"
[SQL: UPDATE statement_imports SET reconciliation_status=$1::VARCHAR, reconciliation_started_at=now()
 WHERE statement_imports.id = $2::UUID AND statement_imports.user_id = $3::UUID
 AND (statement_imports.reconciliation_status != $4::VARCHAR
      OR statement_imports.reconciliation_started_at < now() - $5::INTERVAL)
 RETURNING statement_imports.id]
[parameters: ('running', UUID('…'), UUID('…'), 'running', datetime.timedelta(seconds=120))]
```

What it breaks on the wire: "a later run overwrites" (the §4 outcome-write rule) is
unreachable through HTTP; the user who reconciles twice sees a 500. No data is corrupted
(the transaction rolls back, the previous report survives intact).

Reproduction, no SQL involved anywhere:

```bash
# any session in parsed|applied|replaced, on the fake stand
curl -s -X POST localhost:8021/statement-imports/$IMP/reconcile \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{}'   # 200, status=ok
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8021/statement-imports/$IMP/reconcile \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{}'   # 500
```

Observed twice independently: on `27162ea0…` (PR-9b's session, never touched by any UPDATE)
and as PR-13 #2/#3 on `f3c43470…`. Likely fix (engineer's call): the claim must also set
`reconciliation = NULL` (and `reconciled_at`/trio per the CHECK's truth table) in the same
UPDATE, or the CHECK must tolerate `running` holding a stale report.

### DEF-2 — the two new routes refuse a PAT with 401, the rest of the family with 403 (cosmetic)
`POST /{id}/reconcile` and `GET /{id}/reconciliation` answer **401
`{"detail":"Unauthorized"}`** to a valid `bgt_pat_…`, while every pre-existing route of the
import family answers **403 `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}`** (verified with the
same PAT in the same minute: `GET /statement-imports/{id}`, `/formats`, `/{id}/rows`,
`POST /{id}/apply` → all 403; `GET /accounts` → 200, so the PAT itself is live). Access is
refused either way, so there is no security hole and no oracle; the deviation is the wire
answer a client has to map. The cause is deliberate — `_stash_rl_user_jwt` depends on
`current_active_user` directly, which never produces the router's token code — so this is a
decision to confirm, not necessarily a bug to fix. Repro:

```bash
PAT=$(curl -s -X POST localhost:8021/tokens -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' -d '{"name":"qa-pdf","scope":"full"}' | jq -r .token)
curl -s -w ' [%{http_code}]\n' -X POST localhost:8021/statement-imports/$IMP/reconcile \
  -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' -d '{}'
# {"detail":"Unauthorized"} [401]      — expected {"detail":"TOKEN_ENDPOINT_FORBIDDEN"} [403]
curl -s -w ' [%{http_code}]\n' localhost:8021/statement-imports/$IMP -H "Authorization: Bearer $PAT"
# {"detail":"TOKEN_ENDPOINT_FORBIDDEN"} [403]
```

### Non-defects recorded for the record
- PR-1's "≥2 `prompt=extract-alfa-v1` lines": one chunk = one call for a 25-line fixture;
  the checklist expectation is arithmetically unreachable, the code is right.
- PR-14's "403 arm declared" / "codes on the error `anyOf`": neither exists anywhere in
  this contract's error shape; the new paths follow the family exactly.
- `STATEMENT_EXTRACTION_FAILED` is absent from `openapi.json` even as prose, while its five
  siblings are documented there. Documentation nit for the engineer, no wire impact.

---

## Run record (stand, as handed over)

- Docker-disk guard at start: images 23.31 GB (11.9 GB reclaimable), containers 323.9 MB,
  volumes 8.181 GB, build cache 3.526 GB; `df -h /` → **28 % used** (12 Gi of 460 Gi).
  Well under the 85 % stop line; **nothing pruned** (memory: docker-disk quirks).
- All three API processes and the QA DB were handed over already running: `budget_qa_pdf_reconcile`
  on 5443 at revision 0019, 8021 `LLM_PROVIDER=fake`, 8022 `off`, 8023 fake +
  `EXTRACT_DAILY_LINE_QUOTA=3/day`. QA started and stopped nothing, created and dropped no
  database, and never touched `budget`, 8010, 5173 or the user's containers.
- Login once per user (PM policy 2026-08-18): `qa-pr-a@budgetqa.dev` (owner,
  `user_id=ed2d21f9-5585-4773-8058-b19ff89f499c`) and `qa-pr-b@budgetqa.dev` (stranger),
  registered by QA, one `/auth/login` each, tokens reused across all 15 cases. **The login
  route is `POST /auth/login` (form), not `/auth/jwt/login`** as the Stand section says —
  the checklist's snippet is stale; fixed here for the next run.
- Own accounts (never web-qa's): `ACC_GOOD=0fac9cdc…`, `ACC_MISMATCH=b872e4ab…`,
  `ACC_OFF=20a1660a…`, `ACC_FAIL=48492b0a…`, `ACC_QUOTA=64f287fa…`, `ACC_CREDO=51978b02…`,
  `ACC_PRIOR=6e11be00…`, `ACC_TRANSFER=313374c0…`, plus `ACC_Q2=985b596b…` (the CSV arm of
  PR-5, created because `$ACC_QUOTA` holds no session and a live preview is per-account).
- Fixtures used: `apps/api/tests/fixtures/alfa/{alfa_good,alfa_mismatch,alfa_llmfail}.pdf`,
  `apps/api/tests/fixtures/statement_priorbank_synthetic.csv`, and `credo.xlsx` built into
  scratch by `tests.helpers.build_credo_xlsx`. **`.tasks/pdf-reconcile/real-alfa-local.pdf`
  was never opened, uploaded or quoted.** The fixture-contract ask at the top of this file
  is satisfied by the committed three: roles, names and planted error (`MISMATCH_MINOR=1250`)
  all as requested.
- Evidence files: `$SCRATCH/pdfrec/pr*.json`, `$SCRATCH/pdfrec/live-openapi.json`,
  `$SCRATCH/pdfrec/env.sh` (ids and tokens). No repo file was modified by the run except
  this checklist.

## Cleanup (done / left for the orchestrator)

- Deleted via the API: the two deletable sessions (`c255042b…`, `8e0d95b3…`) → 204 each.
  Four of mine refuse deletion by design (`422`, finished sessions): `e4051760…` (applied),
  `27162ea0…` (replaced), `6cd93b07…` (applied Credo), `f3c43470…` (applied Priorbank).
  They stay, together with my two users, nine accounts and their transactions.
- Remaining in `budget_qa_pdf_reconcile` for user `ed2d21f9…`: 4 statement_imports. The
  other rows in that DB belong to the parallel web-qa line and were not touched.
- **`DROP DATABASE budget_qa_pdf_reconcile` is the orchestrator's call**, as is stopping
  8021/8022/8023 — QA started neither and stopped neither.
- Docker disk at the end of the run: unchanged from the start figure above (no image built,
  no container created, nothing pruned).

## Summary (filled on the run 2026-10-14)
- Total: **15** · STOP-probes re-run at end of scope: PR-1, PR-2, PR-3, PR-9 (the code under
  them moved after their subtasks, so all four were run again)
- Passed: **13** (PR-1…PR-11, PR-14, PR-15 — PR-10 passes on its own gates and is the case
  that UNCOVERED DEF-1) · Failed: **2** (PR-12 → DEF-2 cosmetic; PR-13 → DEF-1 functional)
  · Blocked: **0**
- Defects: **DEF-1** functional (a second reconcile run → 500, `reconciliation_present`
  CHECK vs the claim UPDATE), **DEF-2** cosmetic (401 vs the family's 403 on a PAT).
- Section A (pytest): verified by senior-lead's run, not re-run here — API **826 passed**,
  JS **12/12 tasks**, api-client drift green.
- Verdict: **❌ FAIL OVERALL — senior-lead must handle DEF-1** (one-line fix in the claim
  UPDATE, plus a pytest that re-runs reconcile on an `ok` session; DEF-2 is a decision, not
  necessarily a fix). Everything the scope was built for — extraction, the balance stamp,
  the reconcile loop, the claim, the no-oracle pair, the contract — works on the wire.
