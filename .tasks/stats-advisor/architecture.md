# Architecture: stats-advisor (roadmap 4.1–4.5, WEB-ONLY, mobile frozen)

Architect output for scope grooming. Binding inputs: `.tasks/stats-advisor/task.md`,
`budget-app-architecture.md` §Статистика/§AI-советник/§3/§4, the transactions-api
grooming-review (§1 precedent, §6.6, §7), the currencies-goals grooming-review (§7)
+ architecture (D5/D9/D10–D14) + meta-review-s4-s5 carry-forwards, and the 0.3
api-client architecture (SSE escape hatch, ~lines 90–100). All code claims below
were verified against the working tree (files cited inline).

Decisions are D1–D16; PM-facing forks are OQ-1..8, each with a recommendation.
Everything not marked OQ is the default that ships. Inferred requirements are
marked **[assumption]** with the minimal interpretation taken.

---

## Part 0 — Layering ruling (the precedent moment)

### D1. The extraction precedent is DISCHARGED — and the services-layer definition is amended in writing

The transactions-api §1/§7 precedent ("aggregate SQL lives with its router at the
first consumer; 4.1 extracts and takes the architect look") was **overtaken by
events at 3.2**: the second consumer (goals free-balance) arrived one stage early,
and the extraction already happened — `services/tx_totals.converted_totals`
(services/tx_totals.py:50) is consumed by both `routers/transactions.py:347`
(summary) and `routers/goals.py:193` (free-balance window). Verified in source.
Nothing in `routers/transactions.py` needs re-extraction: the summary endpoint is
already a thin consumer. **The 4.1 ruling is therefore not "where does it move"
but "is the 3.2 home correct now that six series hang off it" — verdict: yes.**

Three homes were considered:

- **`domain/`** — rejected. A GROUP BY is a query; `domain/` is *pure* by the
  architecture doc's own definition (§4) and by the 1.4 ruling. The pure half of
  aggregation (`domain/fx.convert_minor`, and the new `domain/periods.py`, D5)
  already lives there; the SQL half cannot.
- **A new `repositories/` layer** — rejected as premature abstraction. Exactly one
  kind of query needs sharing (converted aggregation over transactions); CRUD
  stays with its routers, which has held cleanly for four stages. A repository
  layer would be one module wearing a layer's costume.
- **`services/`** — accepted, and the bend is now blessed EXPLICITLY rather than
  left implicit: **the working definition of `services/` is amended to "external
  integrations AND shared DB-touching query/orchestration modules with 2+
  consumers"** (precedents: `fx_jobs.py` sanctioned at 3.1, `fx_lookup.py` and
  `tx_totals.py` born-extracted at 3.2 with both consumers in-scope). Dependency
  direction is unchanged: routers → services → domain/models; services never
  import routers; `domain/` imports nothing internal but `domain/money.py`.

**Module ruling: `services/tx_totals.py` stays, and GROWS** (reuse-existing-
operation gate: generalize, don't fork a parallel `stats_queries.py`). Renaming to
`tx_aggregates.py` was considered and rejected — churn in two shipped consumers
and their docstrings for zero structural gain.

### D2. `tx_totals` public surface after 4.1 (signature SHAPES, not code)

The three-bucket conversion algorithm (native == base / valid snapshot /
display-time fold-in, exclude-and-flag) is THE invariant; every new function
reuses it — one conversion resolution in the codebase, ever.

- `converted_totals(session, user_id, base, date_from, date_to_exclusive) -> ConvertedTotals`
  — **unchanged**. Both existing consumers untouched.
- NEW `monthly_converted_totals(session, user_id, base, *, months, ending_first) ->
  list[MonthTotals]` where `MonthTotals = (month: date, income_minor, expense_minor,
  unconverted_count)`. Dense series (empty months emitted as zeros — the goals
  progress precedent), current month included. Implementation shape (decided, not
  latitude): **one window-wide pass** — buckets 1+2 in a single
  `GROUP BY date_trunc('month', occurred_at), kind` query, ONE bucket-3 scan over
  the whole window folded per month in Python. NOT twelve per-month
  `converted_totals` calls (24 round-trips for one chart is silly even at personal
  scale). The goals free-balance loop (3 calls, routers/goals.py:191) is NOT
  refactored onto this — its behavior is meta-review-pinned ("Free-balance window
  = 3 converted_totals calls", accepted deviation 5) and touching it buys nothing.
- NEW `merchant_converted_totals(session, user_id, base, date_from,
  date_to_exclusive, *, kind, limit) -> MerchantTotals` where `MerchantTotals =
  (items: list[(merchant: str, total_minor: int, tx_count: int)],
  unconverted_count)`. `WHERE merchant IS NOT NULL`, same CASE + bucket-3 fold-in
  grouped by the **verbatim stored merchant string** (OQ-4), ordered total DESC;
  the top-N cut is applied AFTER the fold-in (a bucket-3 row can reorder the
  tail). NULL-merchant rows are simply out of the population — "top merchants"
  over merchantless rows is not a meaningful bucket, no flag needed
  **[assumption: top merchants = expense rows only; a "top income sources" view
  is not in the task text]**.

### D3. §6.6 / D9 carry-forwards — written verdicts

- **Two-query summary fold (transactions §6.6): DISCHARGED at 3.2.** The old
  totals+breakdown pair is now ONE grouped query (`tx_totals.py:75-85`); income/
  expense totals are Python sums over ≤ dozens of buckets. **GROUPING SETS:
  rejected** — it would move a trivial Python sum into SQL syntax the codebase
  doesn't use anywhere else, to save microseconds.
- **Bucket-3 fold-in EXPLAIN revisit (currencies-goals §7 / D9): verdict — the
  Python fold-in STAYS.** Bucket-3 rows are structurally rare (foreign-currency
  rows with stale/absent snapshots); a LATERAL rate-join would move money math
  out of `domain/fx` into SQL, untestable against the pure functions. The
  EXPLAIN obligation is discharged with evidence, not assertion: the /implement
  report for the aggregates subtask MUST include one `EXPLAIN ANALYZE` of the
  new monthly grouped query against a seeded ~5k-row user, confirming an index
  range scan on `ix_transactions_user_id_occurred_at` + in-memory aggregation.
  Re-arm trigger: any stats endpoint measured >100ms at realistic volume.

---

## Part 1 — Stats API surface (4.1)

### D4. One router, three endpoints; goals progress is NOT re-served

New `routers/stats.py`, mounted at `/stats`, tags=["stats"], auth-required,
**no rate limit** and no `prime_rate_limit` dependency (DB-only reads, no cost
driver — the categories/fx/goals mount precedent, app.py:160-176). The router
computes NO math: it resolves the period (D5), calls `tx_totals` functions, sorts,
and shapes DTOs. Base currency via the read-only profile fallback
(`DEFAULT_BASE_CURRENCY`, no write on GET — transactions summary precedent).

1. **`GET /stats/summary`** — category breakdown + income vs expenses + prev-period
   comparison for one period. Response (render-ready, Phase-3.5 rule):

   ```
   {
     "period": {"from": date, "to": date},          # resolved inclusive bounds, echoed
     "currency": str,                                # profile base
     "income_minor": int, "expense_minor": int, "net_minor": int,   # signed net
     "by_category": [{"category_id": uuid|null, "kind": "expense"|"income",
                      "total_minor": int}],          # ordered (kind, total DESC) —
                                                     # the 1.4 summary ordering
     "unconverted_count": int,
     "previous": {"from": date, "to": date, "income_minor": int,
                  "expense_minor": int, "net_minor": int, "unconverted_count": int}
   }
   ```

   `previous` is ALWAYS present (one extra indexed aggregate; a `compare=` knob
   would be speculative config). **Server returns both periods' totals, no delta
   fields**: delta/percent rendering is presentation (percent against a zero base
   is a display policy, not math), while every number that requires conversion or
   aggregation is server-computed — that is the honest reading of "клиент ничего
   не пересчитывает". `previous` carries NO by_category breakdown **[assumption:
   the comparison screen compares totals; a per-category diff view is not in the
   task text — additive later if 4.2 wants it]**. Category buckets are
   reference-by-id (the 1.6 include-archived name-cache pattern already exists on
   the web; returning names would fork the category-rendering path).

2. **`GET /stats/monthly?months=N`** — monthly dynamics, `N` int 1..60 default 12,
   window = N calendar months ending at the CURRENT month inclusive (goals
   progress precedent). Response:

   ```
   {"currency": str,
    "points": [{"month": "YYYY-MM", "income_minor": int, "expense_minor": int,
                "net_minor": int, "unconverted_count": int}]}   # dense, zeros kept
   ```

   Per-point `unconverted_count` (not one top-level number): a single flagged
   month must not cast doubt on eleven clean ones — the honesty pattern extended,
   as the carry-forward requires, to per-bucket resolution where buckets are the
   payload.

3. **`GET /stats/top-merchants`** — period params (D5) + `limit` int 1..50
   default 10. Response:

   ```
   {"period": {...}, "currency": str,
    "items": [{"merchant": str, "total_minor": int, "tx_count": int}],
    "unconverted_count": int}
   ```

**Goals progress: REUSED, not re-served.** `GET /goals` (portfolio with computed
realism) and `GET /goals/{id}/progress` (monthly series) already return
render-ready stats-shaped payloads built by the whole-portfolio assembler
(routers/goals.py). A `/stats/goals` projection would be a second assembler whose
numbers could drift from the goals screen — exactly the AM-4 consistency class.
The 4.2 stats screen composes the existing queries client-side. Sixth series:
done, zero new code.

**`/transactions/summary` is KEPT unchanged** (OQ-1): it is a shipped contract
with a live 1.6 consumer, it rides the same `converted_totals` (no logic
duplication, only a thin month-shaped shell), and deprecating it buys a web
migration for nothing. `/stats/summary` supersedes it for new screens.

### D5. Period parameterization: ONE server-side grammar, shared by summary and top-merchants; new pure `domain/periods.py`

The server must own period semantics because **prev-period is a server feature**
and "previous month/quarter/year" are calendar operations, not fixed-length
shifts (inferring calendar-ness from raw from/to spans would be implicit magic).
One grammar for both period-scoped endpoints (monthly has its own `months=` knob):

- `?period=month&month=YYYY-MM` (reuse the pinned `_MONTH_PATTERN` regex, AM-6
  discipline: pattern-validate at the Query layer, never parse-then-catch)
- `?period=quarter&quarter=YYYY-Q[1-4]` (regex at the Query layer)
- `?period=year&year=YYYY` (int, ge/le bounds)
- `?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`

Missing/mismatched anchor for the chosen period → 422 `PERIOD_ANCHOR_REQUIRED`
(business code, `StatsError` model mirroring `TransactionError`; the honest anyOf
422 union per the standing AM-5 pattern). `from > to` on custom → **empty-200
zeros** (decision-l consistency: read filters never error). Previous period:
calendar-previous for month/quarter/year; for custom, the same-length window
immediately preceding `from` **[assumption: minimal interpretation of "сравнение
с прошлым периодом" for arbitrary ranges]**.

All window math is pure and lives in NEW **`domain/periods.py`** (stdlib
`datetime` only): `period_bounds(...)`, `previous_period(...)`, `month_key(...)`,
and **`shift_month` — moved here from routers/goals.py:113**, which becomes its
second consumer's extraction per the first/second-consumer rule; `routers/goals.py`
refactors to import it IN THIS SCOPE (mechanical, behavior-identical, existing
goals tests are the guard — the category_access.py-at-1.4 template).

### D6. Index / performance verdicts (written, per shape)

Reference index: `ix_transactions_user_id_occurred_at` (models/transaction.py:52).
Every stats query leads with `user_id = :u AND occurred_at` range — the index
selects the row set; grouping (hash agg) runs over the selected rows in memory.
At personal volumes (thousands of rows/user) this is milliseconds.

| Query shape | Verdict |
|---|---|
| category breakdown (`GROUP BY category_id, kind` over period) | covered; **no new index** |
| monthly dynamics (`GROUP BY date_trunc('month', occurred_at), kind`) | covered (grouping is post-scan); **no new index**; no expression index on date_trunc |
| top merchants (`GROUP BY merchant`, merchant unindexed) | covered — merchant is a grouping key, never a WHERE predicate in this scope; **no index on merchant** |
| prev-period | second range scan on the same index; **no new index** |
| CSV export (list filters + ASC order) | covered (range scan; sort of a personal-scale export is fine); **no new index** |
| **`transactions.category_id` (the 1.2 trigger)** | **DISCHARGED: no index.** (a) no query filters by category_id without the leading (user_id, occurred_at) selection; (b) the list-endpoint category filter post-filters an index-selected personal-scale set; (c) the FK's delete-side scan concern is moot — categories are archived, never deleted (no delete endpoint exists). Re-arm trigger: a category hard-delete feature, real multi-user volume, or a measured slow plan. |

Plus the D3 EXPLAIN-evidence obligation on the monthly query.

---

## Part 2 — AI advisor (4.4)

### D7. `services/advisor.py` — the Anthropic streaming seam (ReceiptParser template)

Stateless, Settings-only, imports NO models and touches NO DB (the
receipt_parser.py precedent, now the third such seam). Constructed once per app
onto `app.state.advisor` in `create_app`; **all pytest mocks swap the fake at
this seam** — no live-call gates (binding).

Shape:
- `class Advisor:` built from Settings; method
  `stream_advice(question: str, history: Sequence[Turn], context: AdvisorContext)
  -> AsyncIterator[str]` yielding text deltas (SDK `messages.stream` under the
  hood). Errors before the first delta and mid-stream both raise
  `AdvisorError("ANTHROPIC_ERROR")` — the ROUTER decides how each surfaces (D9).
- `render_prompt(context) -> str` exposed as a pure function on the module so the
  prompt text is unit-testable without the SDK.
- `AdvisorContext`: a frozen dataclass whose fields are **aggregate-only types by
  construction** — per-category totals with category NAMES (3 full months),
  monthly income/expense/net for those months, top merchants for the window,
  profile base currency + `monthly_income_minor`, and the goals portfolio
  (name, target, saved, deadline, monthly_needed, realistic, allocated). There is
  structurally nowhere to put a `Transaction` row — that is how the binding "NO
  raw transactions in the prompt" (§Безопасность) is enforced, not by review
  vigilance. **[assumption: "no raw transactions" = no per-transaction rows/notes/
  dates; per-merchant and per-category AGGREGATES are exactly what §AI-советник
  prescribes ("агрегаты за 3 месяца, цели, доход")]**.

Context assembly: the ROUTER builds `AdvisorContext` by calling the same shared
functions the stats endpoints use — `monthly_converted_totals`,
`converted_totals`, `merchant_converted_totals` (D2) and the goals assembler
(D8). No dedicated `advisor_context.py` module (YAGNI — it would be a file
holding one function with one consumer).

New Settings (all defaulted, so explicit `Settings(...)` sites — openapi_export,
conftest — need no new env, the config.py house rule): `advisor_model`
(dated **Sonnet** snapshot — advisor quality is the product, unlike OCR where
Haiku suffices; env-swappable), `advisor_max_tokens` (default 2048),
`advisor_timeout_seconds` (default 120), `advisor_ask_rate_limit` (D10).
`anthropic_api_key` is SHARED with receipts — one key, one configured/not state.

### D8. Goals assembler extraction — second consumer fires the rule

The advisor context needs the computed goals portfolio. `_assemble_goal_reads`
(+ its private helpers `_load_goals_ordered`, `_saved_sum`, `_base_currency`) in
routers/goals.py:143-298 gains its second consumer → per the recorded
first/second-consumer rule it is EXTRACTED to **`services/goal_reads.py`**
(sanctioned by the D1 amended services definition), signatures unchanged;
`routers/goals.py` keeps only route handlers and refactors to import it, in this
scope, existing goals pytest suite as the guard. Alternative rejected: a leaner
advisor-private goals query — a second source of realism numbers that can drift
from the goals screen (the AM-4 class again). The advisor tells the user what the
goals screen shows, byte-for-same-source.

### D9. `POST /advisor/ask` — SSE protocol, contract honesty, error surfacing

`routers/advisor.py`, mounted at `/advisor`,
`dependencies=[Depends(prime_rate_limit)]` (receipts precedent — a limited router
must never mount unprimed, app.py:180-185).

**Request**: `{question: str (strip, 1..2000), history?: [{role: "user"|"assistant",
content: str}]}` — history capped (≤10 turns, ≤8000 chars total, 422 on excess).
Chat memory is CLIENT-carried; the server stays stateless, no chat table (OQ-2).

**Pre-stream errors are plain JSON status codes** (the stream has not started):
- 503 `{"detail":"AI_NOT_CONFIGURED"}` — via the shared guard (D11). This is the
  binding UI requirement's backend half: the button ships now, an unkeyed server
  answers honestly, the web maps this exact code to "AI недоступен — ключ не
  настроен".
- 429 `{"detail":"RATE_LIMITED"}` — existing global handler shape (rate_limit.py:98).
- 422 — validation, honest anyOf union (standing AM-5 pattern, `AdvisorError`).

**Stream**: FastAPI `StreamingResponse`, `media_type="text/event-stream"`,
`Cache-Control: no-store`. Event protocol (data is ALWAYS one-line JSON — SSE
frames cannot carry raw newlines; JSON encoding solves it once):

```
event: delta        data: {"text": "<chunk>"}          (0..n times)
event: done         data: {}                           (terminal, success)
event: error        data: {"detail": "ANTHROPIC_ERROR"} (terminal, mid-stream failure)
```

Exactly one terminal event, then the response closes. A mid-stream Anthropic
failure CANNOT change the already-sent 200 status — the `error` event IS the
error channel, and the client treats a connection drop without a terminal event
as an error too. No `id:`/`retry:` fields, no heartbeat (single-user, short
generations — YAGNI; a re-ask re-streams, there is no resume semantics).

**OpenAPI honesty**: the route declares `response_model=None` and an explicit 200
with content `text/event-stream` (raw content schema, `{"type": "string"}`, with
the event grammar in the description) plus the 503/429/422 arms as real typed
components. The contract therefore tells the truth: consumers see a
non-JSON-streaming 200 and fully typed error arms. **The web client uses the 0.3
recorded escape hatch exactly as designed** (openapi-client-generation D2c): a
hand-written `askAdvisor` in `packages/api-client/src/` that imports the
generated request/error TYPES but calls plain `fetch` + `ReadableStream` SSE
parsing (`openapi-fetch` `parseAs: "stream"` is the recorded lighter fallback).
Load-bearing detail: the endpoint is a **POST**, so browser `EventSource` (GET-
only) is structurally unusable — fetch-stream parsing is not a preference but the
only option; the hand-written helper must say so in its docstring.

**Guard order**: the slowapi wrapper runs before the endpoint body, so a 503
response still consumes quota — same behavior as receipts parse, accepted for
consistency (an unkeyed server being hammered is itself worth limiting).

### D10. Daily rate limit — per-user key via a GENERALIZED factory

The account, not the IP, is the cost driver (localhost/NAT share addresses) —
the receipts D11 argument verbatim. `rate_limit.py`'s `receipt_rl_key` hardcodes
its `"receipt:"` namespace; the advisor is its second consumer → **generalize**
(reuse-existing-operation gate): one `user_rl_key(namespace: str)` factory
returning the keyed function (scope-prefix + namespace + rl_user_id, fallback to
remote address pre-auth exactly as today); `receipt_rl_key` becomes
`user_rl_key("receipt")`, advisor uses `user_rl_key("advisor")`. The
`_rl_stash_user` dependency moves alongside or is duplicated-then-shared —
implementation latitude, but ONE stash mechanism, not two. Existing receipts
limit tests are the refactor guard.

Limit value: `advisor_ask_rate_limit: str = "5/minute;20/day"` (two-tier, the
receipt_parse pattern — the daily tier is the wallet guard the doc demands, the
minute tier stops accidental client loops). Value is a tuning knob (OQ-3).
429 shape: the existing `{"detail": "RATE_LIMITED"}` handler, declared on the
route so the contract carries it.

### D11. `AI_NOT_CONFIGURED` shared home — extract, don't fork

The empty-key → 503 guard currently lives inline in routers/receipts.py:267-272.
Second consumer → extraction, and the home is the **top-level shared-router-helper
slot that `category_access.py` established** (not `services/` — this is an HTTP
guard, not an integration): new **`budget_api/ai_gate.py`** with
`async def require_ai_configured(request: Request) -> None` raising
`HTTPException(503, detail="AI_NOT_CONFIGURED")`. Used as a dependency by the
advisor route; **routers/receipts.py refactors onto it in this scope** (the 1.4
category_access template: extract at second consumer, refactor the first, same
task, existing tests guard). The 503 wire shape is byte-identical across both
consumers by construction — reuse, not a second pattern (binding task
requirement honored).

### D12. Non-streaming fallback: NOT built

YAGNI. Web fetch-streaming is proven; mobile is frozen; the 0.3 escape hatch is
the designed consumption path. Recorded trigger: if React Native's fetch proves
stream-incapable at mobile unfreeze, add a `?stream=false` collected-JSON mode
THEN (additive, same context/seam — the endpoint's internals already produce a
full string).

---

## Part 3 — CSV export (4.5, lean)

### D13. `GET /transactions/export` — streaming CSV, header auth, no token-in-query

Lives in `routers/transactions.py` (it is a transactions read wearing a different
content type; same filters, same router — no new module). Path `/transactions/export`
— collision-free (verified: no `GET /{transaction_id}` exists; declared before any
future one per the standing U5 discipline).

- **Filters**: exactly the list endpoint's set — `from`, `to`, `category_id`,
  `kind`. No pagination (an export is the whole matching set). Read filters never
  error (decision-l): foreign category / from>to → header-only CSV.
- **Streaming**: `StreamingResponse` over an async generator; rows fetched in
  batches (`yield_per`-style, ~500) so memory stays flat regardless of size.
  `media_type="text/csv; charset=utf-8"`,
  `Content-Disposition: attachment; filename="transactions.csv"`.
- **Ordering**: chronological ASC (`occurred_at, created_at, id`) — a deliberate,
  documented deviation from the list's DESC: spreadsheets read top-down in time.
- **Columns** (decision, not byproduct): `id, occurred_at, kind, amount, currency,
  base_amount, base_currency, category, merchant, note`. Amounts are **major-unit
  decimal strings** (exact scaling via the one exponent table in `domain/money` —
  no rounding is involved, minor→major at the currency's exponent) because the
  export's consumer is a human in Excel, not a program (OQ-6); `base_amount`
  empty when the snapshot pair is NULL (stage-3 semantics carried through: the
  export shows the STORED snapshot, it does not re-convert). `category` is the
  category NAME resolved include-archived (an archived category still owns its
  history — the 1.6 obligation-3 argument), empty for uncategorized.
  **[assumption: lean = no receipt_id/created_at columns; additive later if
  asked]**.
- **Excel encoding**: UTF-8 **with BOM** (without it, Excel mangles Cyrillic
  category names — a known, boring failure), RFC-4180 quoting/CRLF via Python's
  `csv` module. The BOM is bytes-level, prepended once by the generator.
- **Auth ruling**: **Authorization header, like every other endpoint. Token-in-
  query is REJECTED** (tokens land in server logs, proxies, and browser history —
  a security smell with a 15-minute-JWT only partially mitigating it). The web
  client does NOT navigate to the URL; it fetches through the api-client
  (openapi-fetch `parseAs: "blob"` — no escape hatch needed, this is not a
  stream-parse problem), then triggers the download via
  `URL.createObjectURL` + a synthetic anchor click. Contract-honest: the route
  declares its 200 as `text/csv` (raw content schema, string).

---

## Part 4 — Carry-forwards ruled

### D14. Joint upper-bound pass on amount columns: LAND HERE (minimal form)

Open since S3 (meta-review-s4-s5). Analysis: **DB-side overflow is not real** —
Postgres `SUM(bigint)` returns `numeric` (arbitrary precision), Python ints are
unbounded, so aggregates cannot overflow server-side. The REAL risk is
client-side: JS `Number.MAX_SAFE_INTEGER ≈ 9.0e15`, and `packages/shared`'s
`assertSafeMinor` already THROWS on unsafe minors — one typo'd 17-digit
`amount_minor` (BigInteger accepts up to ~9.2e18) poisons every list, summary,
stats, and CSV render for that user. Stats (this scope) multiplies the blast
radius — which is why this scope is the natural landing point.

**Land, minimally**: one shared constant `MAX_MINOR_AMOUNT = 999_999_999_999_999`
(1e15−1 minor ≈ 10 trillion major at exponent 2 — absurdly generous for a
personal budget, and sums of realistic row counts stay JS-safe) applied as
`le=` at the SCHEMA layer to every user-supplied amount:
`TransactionCreate/Update.amount_minor` + `base_amount_minor`,
`GoalCreate/Update.target_minor` + `initial_saved_minor`,
`ContributionCreate.amount_minor` (magnitude, both signs). No DB CHECK change
(the contract layer is where `ge=1` already lives — same split as 1.4 decision h;
existing rows can't exceed it since the schema always bounded entry to sane
users). Contract regen rides the aggregates subtask. Pytest: one boundary arm
per schema family, non-vacuous against the accept-at-max arm. PM veto = defer
with trigger "first unsafe-minor decode throw in the wild" (OQ-5).

### D15. Remaining carry-forward dispositions

- **F4(a) future-dated contribution policy** (meta-review → PM): recommendation
  recorded for the PM — **keep allowing** future `occurred_at` on contributions
  (consistent with transactions AM-7 future-date pin); the progress chart
  excludes future months (already shipped behavior), the card's `saved_minor`
  includes them. Rejecting now would add a validation arm no user asked for.
  Not a stats-scope code change either way. (OQ-7)
- **F4(b) chart reconciliation + negative-Y** — already recorded in plan-web W4;
  nothing for this architecture beyond: the 4.2 stats charts inherit the same
  rule (render server series verbatim, tolerate negative net_minor months).
- **AM-5 decode discipline** — extends to every new money decode in 4.2 screens
  and the CSV column formatting (server-side major formatting uses the exponent
  table, never a hardcoded /100).

### D16. Mobile note (4.3 frozen) + web note (4.2)

Mobile, when unfrozen, reuses the SAME contract: `/stats/*` series render in
Victory Native XL exactly as Recharts renders them (both consume
`points[]`/`by_category[]` verbatim — that is what "render-ready" buys). Two
recorded flags, nothing designed: (a) the SSE helper's RN-fetch streaming risk →
D12's `?stream=false` trigger; (b) mobile becomes the third exponent-table
consumer → fires the OQ-6@3.x codegen re-evaluation. Web (4.2): STANDARD-tier
screens over the ready series; no client-side aggregation of any kind; the
"Спросить AI" button ships with the 503→"AI недоступен — ключ не настроен"
mapping keyed on the exact `AI_NOT_CONFIGURED` code (binding).

---

## File-inventory sketch (boundaries, not a plan)

- `services/tx_totals.py` — +2 functions (D2); `services/goal_reads.py` — NEW,
  moved assembler (D8); `services/advisor.py` — NEW seam (D7).
- `domain/periods.py` — NEW pure module; `routers/goals.py` sheds
  `_shift_month` + assembler (D5/D8).
- `routers/stats.py` — NEW (D4); `routers/advisor.py` — NEW (D9);
  `routers/transactions.py` — +export route only (D13);
  `routers/receipts.py` — refactor onto `ai_gate` (D11).
- `budget_api/ai_gate.py` — NEW shared guard (D11); `rate_limit.py` —
  `user_rl_key` factory generalization (D10); `config.py` — advisor settings
  (D7/D10); schemas — `StatsError`/stats DTOs/`AdvisorError` + D14 bounds.
- `app.py` — mount `/stats` (unprimed) + `/advisor` (primed), `app.state.advisor`.
- Contract regen + `packages/api-client/src/` hand-written `askAdvisor` (D9).
- **No migrations. No new tables. No new indexes.** (First scope since 1.2 with
  zero DDL — worth saying out loud.)

Dependency direction check: routers → services (tx_totals, goal_reads, advisor,
fx_lookup) → domain (fx, periods, goals, money) → models; `ai_gate`/`rate_limit`
are top-level HTTP helpers imported by routers only; `services/advisor.py`
imports config + schemas only (no models/DB — the seam rule); no reverse edges
introduced anywhere.

---

## Open questions for PM (veto-style; defaults = what ships)

| # | Fork | Recommendation |
|---|---|---|
| OQ-1 | `/transactions/summary` vs `/stats/summary` coexistence | **Keep both** — shipped 1.6 consumer stays; both ride one aggregate module; no deprecation churn. Veto = migrate the 1.6 summary screen to /stats and retire the old route (a web subtask appears). |
| OQ-2 | Advisor chat memory: client-passed capped history / single-turn / server-stored chat table | **Client-passed history** (≤10 turns) — real chat UX, stateless server, zero new tables. Server-stored is the growth path, not the personal-app path. |
| OQ-3 | Advisor limit value | **`5/minute;20/day`** per user — pure tuning knob (Settings field), cheap to change until clients bake retry UX. |
| OQ-4 | Top-merchants grouping key: verbatim stored string vs Python-side `normalize_merchant` merge | **Verbatim string** — data flows mostly from the receipts pipeline with stable names; case-variant split is cosmetic at personal scale. Re-visit trigger: visible duplicate rows on the real screen (then merge via normalize in the fold-in, no contract change). |
| OQ-5 | Upper-bound pass: land (D14) vs stay deferred | **Land** — the risk is client decode-throw, stats widens the blast radius, and the fix is a shared `le=` constant + regen. Veto = defer with the "first unsafe-minor throw" trigger. |
| OQ-6 | CSV amounts: major-unit decimal strings vs raw minor ints | **Major-unit strings** — the consumer is Excel/a human; exact scaling via the exponent table, no rounding. Veto = minor ints (programmatic re-import fidelity), losing Excel readability. |
| OQ-7 | F4(a): future-dated goal contributions | **Keep allowing** (AM-7 consistency); chart excludes future months, card includes them — already-shipped behavior, documented instead of changed. |
| OQ-8 | Advisor model: dedicated `advisor_model` (Sonnet default) vs reuse `anthropic_model` (Haiku) | **Dedicated Sonnet-default setting** — advice quality IS the feature; OCR economics don't transfer. Veto = one shared model knob (cheaper, dumber advice). |

Verify-at-implementation flags (not PM questions): SDK streaming-iterator error
taxonomy (which exceptions surface mid-stream vs pre-stream — pin in the seam's
docstring, mock both arms in pytest); `StreamingResponse` + slowapi decorator
interplay (the wrapper must not consume the generator); Excel-BOM behavior
verified once by hand at /test (open the exported file, Cyrillic intact).
