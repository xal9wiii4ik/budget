# QA Checklist: ai-layer (LLM categorization in statement import)

## Scope
What only a live HTTP run can prove: the LLM pass actually fires inside the upload route,
degrades instead of failing, and the numbers the preview screen shows (`ai_status`,
`ai_rows_suggested`, `ai_rows_flagged`) add up across rules + LLM + PATCH. Provider
internals, validation arms, prompt pin, evals accuracy — pytest (Section A), not re-run
here. No live model exists on this machine (no key, no Ollama): every case runs
`LLM_PROVIDER=fake` (deterministic substring matcher) or `off`.

## Stand (live run)
- Own DB per PM policy 2026-08-27: `createdb budget_qa_ai_layer` → `DATABASE_URL=...budget_qa_ai_layer`
  → `uv run alembic upgrade head`. Working `budget` on 5443 is NOT touched; drop is the orchestrator's call.
- API on **8021** from `apps/api`, stdout to `$SCRATCH/stand-fake.log`:
  `LLM_PROVIDER=fake FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false PUSH_SCHEDULER_ENABLED=false uv run uvicorn budget_api.app:create_app --factory --port 8021`
  Second arm `LLM_PROVIDER=off` (AT-3) and a third with `CATEGORIZE_DAILY_ROW_QUOTA=5/day` (AT-9): same port, restarted.
- **AS RUN 2026-10-14** — three parallel instances over ONE db `budget_qa_ai_layer` instead of
  restarts: **8021** `fake`, **8022** `off`, **8023** `fake` + `CATEGORIZE_DAILY_ROW_QUOTA=5/day`
  (mine — started and stopped by me, pid 86640, confirmed down). Users
  `qa-ai-a@budgetqa.dev` (`961d6e7a-7a36-4604-9aa9-b26a6688206f`) / `qa-ai-b@budgetqa.dev`,
  logged in ONCE each. SIX BYN card accounts for user A, because a live preview is unique per
  account (`uq_statement_imports_live_preview`) and a parallel case would displace AT-1's
  session: `acc_a` (AT-1/4/5/6/7/12), `acc_a2` (AT-3, 8022), `acc_a3` (AT-2), `acc_a4` (AT-10),
  `acc_a5` (AT-9, 8023). Evidence json under `$SCRATCH/ailayer/`.
- Users `qa-a@budgetqa.dev` (owner) / `qa-b@budgetqa.dev` (stranger), `Qa!Test1234`. **LOGIN
  ONCE** per user (`POST /auth/jwt/login`, form `username`/`password` → `TOKEN_A`/`TOKEN_B`),
  reuse everywhere; re-login only after a restart. One BYN account each: `ACC_A`, `ACC_B`.
- Upload recipe (statement-import scope): `curl -X POST :8021/statement-imports -H "Authorization: Bearer $TOKEN_A" -F file=@<fixture> -F account_id=$ACC_A -F format=priorbank_csv_v1`

## Fixtures I need (cp1251, derived from `apps/api/tests/fixtures/statement_priorbank_synthetic.csv`, scratch only — not committed)
All 18 system categories (migration `0003`) exist for every user; the fake matches a
category NAME as a case-insensitive substring of the row text, per kind.
- **F-A** — the main file: `МАГАЗИН ПРОДУКТЫ` −25,40 (matches expense `Продукты` → seeded,
  0.9 ≥ 0.7, not flagged); `PAYBYCARD.BY` −1,15 **twice byte-identical** (matches nothing →
  flagged, and the dedupe fan-out must give BOTH rows the same result); `ЗАЧИСЛЕНИЕ ЗАРПЛАТА
  ИЮНЬ` +1 500,00 — the shipped row says `ЗАРПЛАТЫ`, which is **not** a substring of
  `Зарплата`, so the edit is required for an income match to exist at all; `ВОЗВРАТ
  ПЕРЕПЛАТЫ ПРОДУКТЫ` +2 000,00 — income row carrying an EXPENSE category name; PLN row,
  `CH Debit PETROV P.`, zero-turnover and blocked rows stay as shipped.
- **F-FAIL** — F-A with one description containing `LLMFAIL`.
- **F-C** — F-A with dates shifted to July and amounts ±0,01 (same merchant texts, new
  fingerprints → `new`, not `exact`): the rules-first probe.
- **F-BIG** — generated, 410+ unique non-matching descriptions (`ROW-0001`…).

## Section A — pytest (owner: backend-engineer)
Pointers by theme, NOT re-enumerated; authoritative lists are `plan.md` S1 (18), S2 (8),
S3 (5) + rulings R1/R3.
- **A-I `services/categorize`** (S1, 11): validation arms, dedupe call count + twin fan-out,
  `max_rows`, time budget, quota abort, `PROMPT_FINGERPRINTS` pin, R1's valid-but-low-confidence
  = SEEDED + flagged (unreachable live: the fake answers only 0.9 or none).
- **A-II providers** (S1, 7): Anthropic wire shape + 429/400 taxonomy, Ollama + `ConnectError`,
  replay round-trip / `replay_miss`. No network.
- **A-III router via the `app.state.llm` seam** (S2, 7 + 1 CHECK): seeding, `partial`/`failed`,
  `not_configured`, "rules-covered and exact rows never sent" via a counting fake, PATCH,
  counts at read, `?needs_review=` filter.
- **A-IV evals** (S3, 3 + anonymizer 2) per R3.
- **Section A status: ✅ senior-lead gate** — not re-run here (serialization policy):
  `uv run pytest` on `budget_test` → **778 passed in 203.57s**, 0 failed
  (`$SCRATCH/pytest-full.log`); JS gate `install rc=0 / turbo rc=0` (`$SCRATCH/js-summary.txt`).
- Gates I verify at /test: `uv run pytest`, `alembic upgrade head && alembic check` from
  `apps/api`, `pnpm --filter @budget/api-client test` (drift). `@budget/web` typecheck is
  expected RED until W1 (R2) — not reported as a failure.

## Section B — curl (owner: QA). 14 cases. 5 of them are the STOP set run right after S2.

### AT-1 [stop] Fake pass fires: source, confidence, reason, status, counts
- Pre: fake stand, fresh F-A upload (merchant/bank maps empty). `POST /statement-imports`
  (recipe) → `GET /{id}` → `GET /{id}/rows?limit=200`
- Expect: 201; session `ai_status="ok"`, `ai_provider="fake"`, `ai_model` non-null,
  `ai_prompt_version="categorize-v1"`, `ai_rows_suggested ≥ 2`, `ai_rows_flagged ≥ 2`;
  the `ПРОДУКТЫ` row: `suggestion_source="llm"`, `category_id == suggested_category_id`,
  `ai_confidence == 0.9`, `ai_reason == "name match"`, `needs_review=false`; BOTH
  `PAYBYCARD.BY` rows identical: no `category_id`, `needs_review=true`, `ai_reason=null`;
  amounts, `merchant`, `match_status`, candidates unchanged. — ✅
- **Actual** (`at1-session.json`, `at1-rows.json`): 201. Session `ai_status="ok"`,
  `ai_provider="fake"`, `ai_model="fake"`, `ai_prompt_version="categorize-v1"`,
  `ai_rows_suggested=2`, `ai_rows_flagged=5`, `rows_total=7`, `rows_blocked=2`,
  `rows_zero_skipped=1`, `by_match_status={exact:0,similar:0,new:7}`, `by_decision.import=7`.
  Row 0 `МАГАЗИН ПРОДУКТЫ`: `suggestion_source="llm"`, `category_id == suggested_category_id ==
  ce814749-…` (expense `Продукты`), `ai_confidence=0.9`, `ai_reason="name match"`,
  `needs_review=false`, `category_user_set=false` (learning gate untouched). Rows 1 and 2
  `PAYBYCARD.BY` byte-identical: `category_id=null`, `suggestion_source=null`,
  `ai_confidence=0.2`, `ai_reason=null`, `needs_review=true` — the dedupe fan-out gave BOTH
  copies the same answer on ONE call (`batch=4`, not 5, in the log). Amounts/merchant/
  `match_status`/`candidates` as in the no-AI arm (see the AT-3 diff).

### AT-2 [stop] Provider error degrades, the import still succeeds
- Pre: fake stand, F-FAIL.
- Expect: **201** (never 5xx); `ai_status` in {`partial`,`failed`}; every eligible row
  untouched (`suggestion_source=null`, `ai_confidence=null`, `needs_review=false`);
  `rows_total` and both count cross-sections identical to a no-AI upload. — ✅
- **Actual** (`at2-session.json`, `at2-rows.json`): **201**, no 5xx. `ai_status="failed"`,
  both ai counts 0, stamps still filled (`fake`/`fake`/`categorize-v1`) — "we asked THIS model
  and got nothing". All 7 rows `suggestion_source=null, category_id=null, ai_confidence=null,
  ai_reason=null, needs_review=false`. `rows_total=7`, `by_match_status={0,0,7}`,
  `by_decision.import=7` — identical to AT-1/AT-3. Log: `outcome=error:unavailable batch=4
  … cost_usd=-`.
- **Note, by design not a defect**: the income batch (`ЗАРПЛАТА`, `ВОЗВРАТ`) carries no
  `LLMFAIL` and would have answered, but `unavailable` ∈ `ABORTING_CODES` sets the service's
  `stop` event, so the sibling batch returns early → `failed` rather than `partial`. That is
  the documented contract of `services/categorize.categorize` ("a provider outage stops the
  remaining batches"); recorded here so the next reader does not read it as a lost result.

### AT-3 [stop] `LLM_PROVIDER=off` → `not_configured`, row shape unchanged
- Pre: restart stand with `LLM_PROVIDER=off`; upload F-A.
- Expect: 201; `ai_status="not_configured"`, the three stamps null, both ai counts 0; all
  rows `ai_confidence=null`, `ai_reason=null`, `needs_review=false`; `diff` of the rows
  payload with ai keys stripped (jq) against AT-1's → empty. — ✅
- **Actual** (8022, `at3-session.json`, `at3-rows.json`): 201. `ai_status="not_configured"`,
  `ai_provider/ai_model/ai_prompt_version` all **null**, both ai counts 0. All 7 rows
  `ai_confidence=null, ai_reason=null, needs_review=false, suggestion_source=null`.
  `diff <(jq -S '…del(.id,.ai_*,.needs_review,.candidates,.suggest*,.category_id,.suggestion_source)' at1-rows.json) <(… at3-rows.json)`
  → **empty**: the pre-scope row payload is byte-for-byte what it was.

### AT-4 [stop] The flag clears when the user looks; the number and the filter move
- Pre: AT-1 session (`ai_rows_flagged = N`), a flagged `PAYBYCARD.BY` row id.
- `GET /{id}/rows?needs_review=true` · `PATCH /{id}/rows/{row_id} {"category_id":"<Прочее expense uuid>"}` ·
  re-`GET /{id}` · `GET /{id}/rows?needs_review=true&match_status=new` · decision-only
  `PATCH {"decision":"skip"}` on the OTHER flagged row.
- Expect: both PAYBYCARD rows in the first filter; PATCH 200 with `needs_review=false` and
  `ai_confidence` PRESERVED; `ai_rows_flagged == N-1`; patched row gone from
  `?needs_review=true`, present in `?needs_review=false`, filter combines with
  `match_status`; the decision-only PATCH changes neither flag nor count. — ✅
- **Actual**: `GET …/rows?needs_review=true` → 200, `total=5`, BOTH `PAYBYCARD.BY` ids present
  (+ `SKLEP`, `PETROV`, `ВОЗВРАТ`). `PATCH {"category_id":"3363eedd-…"}` → **200**,
  `needs_review=false`, `category_user_set=true`, **`ai_confidence=0.2` preserved**,
  `ai_reason=null`. Session `ai_rows_flagged` **5 → 4** (`ai_rows_suggested` unchanged at 2).
  `?needs_review=true` → `total=4`, patched row absent; `?needs_review=false` → `total=3`,
  patched row present. Filter composes: `?needs_review=true&match_status=new` → 4,
  `…&match_status=exact` → 0. Decision-only `PATCH {"decision":"skip"}` on the other
  `PAYBYCARD` → 200, `decision="skip"` with `needs_review=true` and `ai_confidence=0.2`
  untouched, session still `ai_rows_flagged=4`.

### AT-5 [stop] A flagged row does not block apply
- Pre: AT-4 session; leave one flagged, category-less row with decision `create`.
- `POST /{id}/apply` → `GET /transactions?account_id=$ACC_A`
- Expect: 200, `created` counts the flagged row, session `status="applied"`; the created
  transaction exists with `category_id=null`; no 422 mentioning review. — ✅
- **Actual** (`at5-apply.json`): **200** `{"created":6,"skipped":1,"replaced":0,
  "already_existed":0}` — the 1 skipped is AT-4's decision-only row, and the three still-flagged
  category-less rows ARE among the created. Session `status="applied"`, `applied_at` set,
  `ai_status="ok"` and `ai_rows_flagged=4` kept as the record of what the user was shown.
  `GET /transactions?account_id=$ACC_A`: `SKLEP WARSZAWA`, `CH Debit PETROV P.`,
  `ВОЗВРАТ ПЕРЕПЛАТЫ ПРОДУКТЫ` all with `category_id=null`; `МАГАЗИН ПРОДУКТЫ` →
  `ce814749-…`, `ЗАЧИСЛЕНИЕ ЗАРПЛАТА ИЮНЬ` → `8fe4d517-…`, `PAYBYCARD.BY` → `3363eedd-…`.
  No 422 of any kind.

### AT-6 Rules win over the LLM for rows they cover
- Pre: AT-5's PATCH + apply taught the merchant map for that text; upload **F-C** (same
  merchants, new dates → `new`, not `exact`).
- Expect: 201; the taught row `suggestion_source="merchant"` with `ai_confidence=null` and
  `ai_reason=null` — proof it was never sent; other rows still `llm`; `ai_status="ok"`;
  `ai_rows_suggested` counts only `llm` rows. — ✅
- **Actual** (`at6-session.json`, `at6-rows.json`): 201, all 7 rows `match_status="new"`
  (July dates, ±0,01), `ai_status="ok"`. Both `PAYBYCARD.BY` rows:
  `suggestion_source="merchant"`, `category_id=3363eedd-…`, **`ai_confidence=null` and
  `ai_reason=null`** — the proof they were never sent. `МАГАЗИН ПРОДУКТЫ` and `ЗАРПЛАТА`
  still `llm`/0.9/"name match"; `SKLEP`/`PETROV`/`ВОЗВРАТ` still 0.2 + flagged.
  `ai_rows_suggested=2` (the two `llm` rows only, merchant rows excluded), `ai_rows_flagged=3`.

### AT-7 Exact-matched rows are never sent → `skipped`
- Pre: after AT-5, re-upload **F-A** (same fingerprints as the applied session).
- Expect: 201; all rows `match_status="exact"`; `ai_status="skipped"` with `ai_provider="fake"`
  stamped; all rows `ai_confidence=null`, `needs_review=false`; both ai counts 0. — ✅
- **Actual** (`at7-session.json`, `at7-rows.json`): 201. `ai_status="skipped"` with
  `ai_provider="fake"`, `ai_model="fake"`, `ai_prompt_version="categorize-v1"` stamped;
  `ai_rows_suggested=0`, `ai_rows_flagged=0`; every row `ai_confidence=null, ai_reason=null,
  needs_review=false`.
- **Deviation from the written expectation, explained, not a defect**: `by_match_status` is
  `{exact:6, new:1}`, not 6+1=7 exact. Row 2 is the `PAYBYCARD` duplicate AT-4 set to
  `decision="skip"`, so AT-5 never created it and its fingerprint matches no transaction.
  The case's claim still holds: that row is covered by the **merchant** rule
  (`suggestion_source="merchant"`, `ai_confidence=null`), so with the other six `exact` the
  eligible set is empty → `skipped`. The checklist text was written before AT-4's skip existed.

### AT-8 An income row never receives an expense category
- Pre: AT-1 session (F-A carries both income rows).
- Expect: `ВОЗВРАТ ПЕРЕПЛАТЫ ПРОДУКТЫ` (positive): NO `category_id`, `needs_review=true` —
  the expense `Продукты` uuid appears nowhere on that row; `ЗАЧИСЛЕНИЕ ЗАРПЛАТА ИЮНЬ`:
  `suggestion_source="llm"` with the **income** `Зарплата` uuid `8fe4d517-…`. — ✅
- **Actual** (AT-1 rows, index 6 and 3): `ВОЗВРАТ ПЕРЕПЛАТЫ ПРОДУКТЫ` (`kind="income"`,
  `+200000`): `category_id=null`, `suggested_category_id=null`, `suggestion_source=null`,
  `ai_confidence=0.2`, `needs_review=true` — `grep -c ce814749-…` over the **whole row object**
  → **0**, the expense `Продукты` uuid appears nowhere. `ЗАЧИСЛЕНИЕ ЗАРПЛАТА ИЮНЬ`
  (`kind="income"`): `suggestion_source="llm"`, both category fields `8fe4d517-33d6-437d-a2c0-4cd95e262676`
  (income `Зарплата`), 0.9, "name match". The kind split is enforced in `_plan` (a kind with no
  eligible category is never sent) and holds on the wire.

### AT-9 Daily row quota exhausted → honest status, no crash
- Pre: restart stand with `CATEGORIZE_DAILY_ROW_QUOTA=5/day` + rate limiting on; upload F-A
  twice (quota is per user per day, so the second upload starves).
- Expect: upload 1 → 201, `ai_status` in {`ok`,`partial`}; upload 2 → **201** with `ai_status`
  in {`failed`,`partial`}, rows untouched, no 429 on the upload itself, no 5xx. — ✅
- **Actual** (8023, `at9-1.json`, `at9-2.json`): upload 1 → **201**, `ai_status="ok"`,
  `ai_rows_suggested=2`, `ai_rows_flagged=3` (5 unique eligible rows: 3 expense + 2 income,
  exactly the 5/day budget). Upload 2 → **201** (not 429, not 5xx), `ai_status="failed"`,
  both counts 0, all 7 rows `ai_confidence=null, needs_review=false` (the two `PAYBYCARD`
  rows keep their `merchant` rule — rules cost no quota). The CAUSE stays server-side only:
  `api-8023.log` → `categorize pass aborted (quota): 0 of 5 eligible rows covered`; nothing
  about a quota reaches the wire. No refund, as designed.

### AT-10 400-row cap and wall clock on a real upload
- Pre: fake stand, **F-BIG** (410+ unique non-matching rows); `time curl -X POST …`
- Expect: 201; `ai_status="partial"` (rows past `categorize_max_rows_per_import=400`
  untouched); wall clock recorded, well under the 45 s budget. The budget itself is NOT
  live-testable (the fake is instant) — pytest's sleeping provider owns it. — ✅
- **Actual** (`at10-session.json`, `at10b-rows-*.json`): 201, `rows_total=410`, all `new`,
  `ai_status="partial"`, `ai_rows_flagged=400`. Exactly **400 touched / 10 untouched**, and the
  untouched ones are `row_index` **400…409** (`ROW-0401…ROW-0410`), each
  `ai_confidence=null, ai_reason=null, needs_review=false, suggestion_source=null,
  category_id=null` — the cap is `categorize_max_rows_per_import=400` in document order,
  rows past it read exactly as before this scope. 21 `llm call … batch=20` log lines.
- **Wall clock**: 0.107 s on the measured upload; re-measured 3×: **0.112 / 0.075 / 0.078 s**
  (`/usr/bin/time -p` real 0.11). Three orders of magnitude under the 45 s budget — the fake is
  in-process, so this measures the route (parse + 410-row write + 21 batches), not a model.
- **Fixture note**: the first F-BIG attempt came back `ai_status="skipped"` with all 410 rows
  `suggestion_source="bank_category"`. Not a defect — my generated rows carried
  `Прочие расходы`, which AT-4's PATCH + AT-5's apply had just TAUGHT the bank-category map,
  so the rules covered all 410 and the LLM was correctly never asked. Regenerated with
  untaught bank categories. Incidental extra live proof of AT-6's rule.

### AT-11 The log line is the call record and leaks no operation text
- Pre: after AT-1/AT-8, `grep 'llm call ' $SCRATCH/stand-fake.log`
- Expect: ≥1 line `provider=fake model=… prompt=categorize-v1 outcome=ok batch=… latency_ms=…
  in=… out=… cache_read=… cost_usd=… user=<qa-a uuid>`; `grep -iE
  'ПРОДУКТЫ|PAYBYCARD|SKLEP|ЗАРПЛАТА|PETROV'` over the whole log → NOTHING. — ✅
- **Actual**: 85 `llm call` lines for my user, full field set, e.g.
  `llm call provider=fake model=fake prompt=categorize-v1 outcome=ok batch=4 latency_ms=0 in=0
  out=0 cache_read=0 cost_usd=0 user=961d6e7a-7a36-4604-9aa9-b26a6688206f`; the failure arm
  logs `outcome=error:unavailable … cost_usd=-`.
- **Leak grep, widened beyond the written list** —
  `grep -icE 'ПРОДУКТЫ|PAYBYCARD|SKLEP|ЗАРПЛАТА|PETROV|ВОЗВРАТ|ROW-0|LLMFAIL|МАГАЗИН'` over
  **all three** stand logs (8021, 8022, 8023) → **0 / 0 / 0**. No operation text, no merchant,
  no amount, no filename content anywhere. Also `grep -c ' 500 |Traceback'` → 0/0/0.

### AT-12 No-oracle unchanged by the new fields and the new filter
- Pre: `TOKEN_B`, AT-1 session + row id. qa-b calls `GET /{id}`, `GET /{id}/rows?needs_review=true`,
  `PATCH /{id}/rows/{row_id} {"category_id":…}`, each also against a random UUID.
- Expect: 404 `IMPORT_NOT_FOUND`, bodies byte-identical (`diff <(…) <(…)`) to the
  random-UUID answers; the new filter opens no oracle. — ✅
- **Actual**: qa-ai-b against qa-ai-a's live session id → `GET /{id}` **404**,
  `GET /{id}/rows?needs_review=true` **404**, `PATCH /{id}/rows/{row_id} {"category_id":…}`
  **404**; against a random UUID pair → 404/404/404. All six bodies `{"detail":"IMPORT_NOT_FOUND"}`
  and `cmp -s` **byte-identical** own-vs-random for each of the three routes. The new
  `needs_review` filter answers 404 at the same gate — it is evaluated after `_load_own`, so it
  opens no oracle.

### AT-13 Statement-import stays unreachable by a token
- Pre: mint a PAT with JWT (`POST /tokens`, scope `full`); call `GET /statement-imports/{id}`
  and `POST /statement-imports` with `Bearer bgt_pat_…`
- Expect: 403 `TOKEN_ENDPOINT_FORBIDDEN` — unchanged, no markers added by this scope. — ✅
- **Actual**: `POST /tokens {"name":"qa-ai-pat","scope":"full"}` → 201, `bgt_pat_…`. With it:
  `GET /statement-imports/{id}` **403** `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}`,
  `POST /statement-imports` (multipart) **403** same body, and the scope's new
  `GET /{id}/rows?needs_review=true` **403** same body. The refusal is by MECHANISM (no MCP
  marker → not in the derived allowlist), so the new route surface inherits it for free.

### AT-14 The live contract carries the new surface
- `curl -s :8021/openapi.json | jq` + `diff` against committed `apps/api/openapi.json` (empty).
- Expect: `StatementRowRead` + `ai_confidence` (number|null), `ai_reason`, `needs_review`;
  `StatementImportRead` + `ai_status`, `ai_provider`, `ai_model`, `ai_prompt_version`,
  `ai_rows_suggested`, `ai_rows_flagged`; `StatementSuggestionSource` contains `llm`;
  `StatementAiStatus` = `[not_configured, skipped, ok, partial, failed]` in that order;
  `GET /statement-imports/{import_id}/rows` declares the `needs_review` query param. — ✅
- **Actual**: `diff` of the normalized live `:8021/openapi.json` against committed
  `apps/api/openapi.json` → **EMPTY** (live == committed, so the contract pair is not stale).
  `StatementRowRead`: `ai_confidence` `anyOf[number,null]`, `ai_reason` `anyOf[string,null]`,
  `needs_review` `boolean` — all three in `required`. `StatementImportRead`: `ai_status`
  `$ref StatementAiStatus`, `ai_provider`/`ai_model`/`ai_prompt_version` `anyOf[string,null]`,
  `ai_rows_suggested`/`ai_rows_flagged` `integer` — all six in `required`.
  `StatementSuggestionSource = ['merchant','bank_category','llm']`.
  `StatementAiStatus = ['not_configured','skipped','ok','partial','failed']` — that order.
  `GET /statement-imports/{import_id}/rows` params: `[import_id, offset, limit, match_status,
  needs_review]`, the new one `anyOf[boolean,null]`, `required:false`.

## Deliberately NOT in the live run (and what closes it)
- Validation arms, below-threshold seeding (R1), time budget, concurrency, dedupe call
  count → A-I (the fake cannot produce them).
- Anthropic/Ollama wire shape, taxonomy, replay → A-II; a live model call is out of scope
  by environment. CHECK byte-identity + the 0018 downgrade → A-III. Evals accuracy /
  anonymizer / report → A-IV (numbers stay labelled synthetic).
- Field-level 422s, `IMPORT_FINISHED`, pagination, 10/min upload limit, bulk-decision,
  replace → statement-import pytest + `.tasks/statement-import/qa-checklist.md`.
- Web rendering of the flag/reason/`ai_status` → web-qa after W1.

## Results (full run, 2026-10-14)

STOP set first, then the rest, in dependency order:
AT-1 → AT-2 → AT-3 → AT-12 → AT-4 → AT-5 → AT-6 → AT-7 → AT-10 → AT-9 → AT-11 → AT-13 → AT-14.
(AT-8 is read off AT-1's session; AT-12 was pulled forward so it ran against a session AT-6
had not yet displaced.)

| | case | verdict | the one fact |
|---|---|---|---|
| AT-1 | fake pass fires | ✅ | 201, `ok`/`fake`/`fake`/`categorize-v1`, 2 suggested / 5 flagged; twins share one answer from one `batch=4` call |
| AT-2 | provider error degrades | ✅ | 201 (no 5xx), `failed`, all 7 rows untouched, counts equal to the no-AI arm |
| AT-3 | `LLM_PROVIDER=off` | ✅ | `not_configured`, three stamps null, rows-payload diff vs AT-1 empty |
| AT-4 | flag clears, number + filter move | ✅ | flagged 5→4, `ai_confidence=0.2` preserved through the PATCH, filter composes with `match_status`, decision-only PATCH moves nothing |
| AT-5 | flagged row does not block apply | ✅ | 200 `created=6 / skipped=1`; the flagged rows landed as transactions with `category_id=null` |
| AT-6 | rules win | ✅ | taught rows `merchant` with `ai_confidence=null` — never sent; `ai_rows_suggested=2` counts only `llm` |
| AT-7 | exact rows never sent | ✅ | `skipped` with the provider stamped, both counts 0 (one row `new`, see the deviation) |
| AT-8 | income never gets an expense category | ✅ | expense `Продукты` uuid absent from the whole income row object; `ЗАРПЛАТА` → income `8fe4d517-…` |
| AT-9 | quota exhausted | ✅ | 201 `ok` then 201 `failed`; cause only in the log, no 429, no 5xx |
| AT-10 | 400-row cap + wall clock | ✅ | `partial`, untouched rows are exactly `row_index` 400…409; **0.075–0.112 s** vs a 45 s budget |
| AT-11 | log line, no leak | ✅ | 85 full-field `llm call` lines; leak grep over 3 logs → 0/0/0 |
| AT-12 | no-oracle | ✅ | 404 ×3, bodies byte-identical to the random-UUID answers |
| AT-13 | PAT stays refused | ✅ | 403 `TOKEN_ENDPOINT_FORBIDDEN` on GET, POST and the new filter |
| AT-14 | live contract | ✅ | live `openapi.json` diff vs committed EMPTY; all 9 fields, both enums, the new query param |

- Total: 14 · Passed: **14** · Failed: **0** · Blocked: **0**
- Section A (pytest): ✅ senior-lead gate — 778 passed, 0 failed.
- Defects found: **none**.
- Deviations from the written expectations (both explained in place, neither a product defect):
  AT-7's `by_match_status` is `{exact:6,new:1}` because AT-4 skipped one twin; AT-2 reads
  `failed` rather than `partial` because `unavailable` is an aborting code by design.
- Observations worth one line each, not defects: a `skip` decision in a preview makes that row
  `new` on the next upload of the same file (pre-existing statement-import behaviour, visible
  here only because this scope made me re-upload); the bank-category map learns fast enough
  that a synthetic 410-row fixture can be fully rule-covered on the second scenario.
- **Verdict: ✅ READY FOR REVIEW.**
- Stand hygiene: my 8023 instance stopped (pid 86640, port confirmed dead). `budget_qa_ai_layer`
  left as-is with the QA data in it — the drop is the orchestrator's call. Working `budget`
  on 5443 and ports 8010/5173 untouched. No repo file modified by this run; fixtures live in
  `$SCRATCH/ailayer/` only.
