# Code Review — B2a + B2b (stats-advisor, /review_senior)

Combined uncommitted working-tree diff on HEAD af282f2. Per AM-10 the B2a
extraction diff (ai_gate, `user_rl_key` factory, goal_reads move) was reviewed
IN FULL, not as context. All claims below were verified against the code and the
installed dependencies, never against reports. Reviewer re-ran the gates:
**pytest 249 passed** (22 new: 17 in `test_advisor.py`, 5 in
`test_advisor_context.py`; TEST_DATABASE_URL on 5443), **ruff check clean**,
**ruff format clean**, **pyright strict 0/0/0**, **api-client typecheck green +
25 tests passed**. Contract diffs (`openapi.json`, `schema.d.ts`) are purely
additive — zero removed lines.

Senior-lead-accepted deviations (1)–(5) were treated as settled and are not
re-reported; none contradicts its stated rationale in the implementation.

## Findings

### 1. MINOR — `test_rl_namespaces_are_isolated` cannot detect the failure mode it claims to pin

`apps/api/tests/test_advisor.py:289-308`; `apps/api/src/budget_api/rate_limit.py:90-93`

**What/why:** The test's stated purpose (and plan B2b-6's) is "the failure mode
of a shared key factory: one counter for every limited surface". But slowapi
scopes every counter by endpoint independently of the key string — verified in
the installed slowapi's `Limiter.__evaluate_limits`:

```python
limit_scope = lim.scope or endpoint
...
args = [limit_key, limit_scope]
... self.limiter.hit(lim.limit, *args, ...)
```

so even if `user_rl_key` dropped the `namespace` segment entirely and produced
identical key strings for advisor and receipts, the two routes would still hold
separate counters and this test would still pass. As a pin of the namespace
segment it is vacuous (the standing test policy's "names a branch it never
actually exercises" class); the plan's premise was wrong at grooming time, not
the implementation. The behaviour itself is safe — doubly isolated — and the
test retains some value as end-to-end sanity (advisor 429 leaves receipts 201).
The `rate_limit.py` docstring ("The ``namespace`` segment keeps one limited
surface from spending another's budget") attributes to the namespace what
slowapi's endpoint scope already guarantees.

**Suggested fix:** keep the e2e test but re-caption it as integration sanity,
and add one pure unit arm that actually pins the factory — e.g. assert
`user_rl_key("receipt")(req) != user_rl_key("advisor")(req)` for the same
stashed user (and that both embed the user id). Optionally soften the
`rate_limit.py` docstring to "defence in depth alongside slowapi's per-endpoint
scope". No behaviour change required.

### 2. NIT — comment/code mismatch on the category tie-break

`apps/api/src/budget_api/services/advisor_context.py:92-94`

The comment says "with the name as a tie-break so equal totals do not reorder
between calls", but the sort key is `str(item[0][0])` — the category **UUID**
as a string, not the name (names are resolved in the same comprehension, before
the sort's view of the data, but the key never uses them). The result is still
deterministic (which is what matters), and it is a deliberate, harmless
extension of stats.py:227's bare `(kind, -total)`. Fix the comment (or sort by
resolved name if alphabetical ties are actually wanted).

### 3. NIT — duplicated comment lines in a test

`apps/api/tests/test_advisor.py:532-534`

Two near-identical consecutive comments ("A missing income is stated as
missing…" / "A missing income is STATED as missing…") — an editing leftover.
Delete one.

### 4. NIT — prompt hardcodes "три полных календарных месяца" next to a constant

`apps/api/src/budget_api/services/advisor.py:198-199` vs
`apps/api/src/budget_api/services/advisor_context.py:44`

The window length exists as `ADVISOR_WINDOW_MONTHS = 3`, but the prompt states
"три" as prose; a future change to the constant would make the prompt lie while
`test_render_prompt_states_window_income_and_plain_text_rule` (which pins the
literal phrase) keeps passing against the stale wording. Extremely low risk
(the constant is a design decision, not a knob). If touched at all: derive the
word from the constant or leave a cross-reference comment at the constant.

## AM-10 — B2a extraction diff reviewed: **APPROVED**

- **goal_reads move is genuinely verbatim**: all four moved bodies
  (`_saved_sum→saved_sum`, `_assemble_goal_reads→assemble_goal_reads`,
  `_load_goals_ordered→load_goals_ordered`, `_ComputedFields`) diffed
  programmatically against `HEAD:routers/goals.py` after de-underscoring —
  IDENTICAL, including comments. `_FREE_BALANCE_MONTHS` moved with them.
- **`receipt_rl_key = user_rl_key("receipt")`** produces byte-identical keys to
  the old function (`f"{scope}:receipt:{uid}"` in both, same scope/uid
  fallbacks).
- **Receipts 503 semantics unchanged**: the inline
  `await require_ai_configured(request)` sits at the exact former block
  position (after `settings = request.app.state.settings`, before the user-id
  capture), inside the slowapi-wrapped body — so 401-before-503 and
  503-consumes-parse-quota are both preserved; `tests/test_receipts.py` and
  `tests/test_goals_api.py` are unmodified and green (O-4).
- **`rate_limit → auth → models` is acyclic**: `auth.py` imports
  config/db/models only, never `rate_limit`.
- Zero-contract-diff (O-5) is unobservable in the combined diff (B2b regen
  landed on top); the contract deltas present are exactly the advisor's.

## Verified-correct (risky spots checked and found sound)

- **Failure taxonomy vs installed anthropic 0.120.0**: `APITimeoutError`,
  `APIConnectionError`, `APIStatusError` all subclass `anthropic.APIError`;
  `httpx.ReadTimeout`/`ReadError` subclass `httpx.HTTPError`; the mid-stream
  SSE `error` event is re-raised via `_make_status_error` in
  `AsyncStream.__stream__` — the docstring's pre-first-delta vs mid-stream
  claims are accurate; no bare except; `max_retries=1`.
- **`to_major_string` exactness** under adversarial inputs (reviewer-executed):
  `10**30+1` RUB and `10**40+7` JPY render exactly (the `localcontext`
  prec-bump defeats the default 28-digit rounding), `-1` RUB → `-0.01`,
  `0` JPY → `0`, exp-3 `BHD` → `0.005`; and every prompt figure goes through it
  with its OWN currency (`_goal_line`: target/saved/needed in goal currency,
  allocation in base — matches `assemble_goal_reads`' actual units).
- **Window alignment**: `advisor_window(today)` = `[first-3mo, first)`;
  `monthly_converted_totals(months=3, ending_first=shift_month(to_exclusive,-1))`
  covers `[shift_month(ending_first,-2), shift_month(ending_first,1))` = the
  identical rows; `converted_totals` and `merchant_converted_totals` take the
  same bounds; inclusive `window_to = to_exclusive - 1 day` handled once in the
  pure builder; `_window_unconverted_count`'s max-not-sum is correct (three
  overlapping views of one row set).
- **Auth-first order holds and is pinned**: signature is
  `stash_rl_user → require_ai_configured → get_session`;
  `test_ask_requires_auth` covers 401-on-unkeyed (no key-state leak pre-auth)
  AND 401-before-422 (the B1 carry-forward pattern, present as specified).
- **Gate-before-limiter (Disagreement 1)** holds mechanically — the gate is a
  dependency, slowapi wraps only the endpoint callable — and
  `test_ask_503_does_not_consume_rate_limit` is non-vacuous (with a counted 503
  the second call at `1/minute` would be 429).
- **Streaming discipline**: all DB work in `_build_context` before
  `StreamingResponse` is returned; the generator closes over
  `(advisor, str, tuple[Turn], AdvisorContext)` only — no session/ORM capture
  anywhere (income read as a scalar column, goals copied field-by-field out of
  `GoalRead`); exactly one terminal frame per path (both failure positions
  tested); `CancelledError` explicitly re-raised; `json.dumps` one-line framing
  escapes newlines/quotes (pinned by the newline-carrying delta).
- **No raw transactions can reach the prompt, structurally**:
  `services/advisor.py` imports stdlib + config + domain.money + SDKs only (the
  accepted refinement); `AdvisorContext` fields are aggregates/computed goal
  figures with no ids/notes/tx-dates; `test_prompt_carries_no_raw_transactions`
  is non-vacuous in both directions and discharges AM-7 (`unconverted_count==1`
  + "их количество: 1"). No question text or user id in any log call.
- **Contract honesty (O-8)**: `/advisor/ask` 200 carries `text/event-stream`
  only (no stray `application/json` arm — the `response_class` fix worked);
  422 is `HTTPValidationError` only; 429/503 are `AdvisorError`; `schema.d.ts`
  has `AdvisorAsk`/`AdvisorTurn`/`AdvisorError` + the operation, no unrelated
  churn; `claude-sonnet-4-5-20250929` is present in the installed SDK's
  `Model` literal.
- **Tests**: plan B2b-1..11 all present and non-vacuous; AM-4 (order+roles of
  `last_history`), AM-5 (empty/blank/2001/2000 arms), AM-8 (presence arm) all
  discharged; the fake matches the real `stream_advice` signature and
  async-generator shape; no `AsyncAnthropic`/`ANTHROPIC_API_KEY` anywhere in
  `tests/` (O-7); category-name degradation (unresolvable id → label, never a
  UUID) is unit-pinned.
- **Conventions**: mirrors receipts/stats throughout (`_limiter_any: Any`
  containment, UPPER_SNAKE detail codes, `responses` dicts, router mounted with
  `prime_rate_limit`, seam on `app.state`, `include_archived` category-name
  rationale documented at the call site as accepted).

## Verdict

**APPROVE-WITH-NITS.** One MINOR (a test that cannot fail the way it says it
can — worth one pure unit arm and two comment edits), three NITs. No blocker,
no behaviour defect found; every load-bearing constraint from the plan and the
amendments is implemented and genuinely pinned. B2a extraction diff reviewed:
**APPROVED** (see AM-10 section).
