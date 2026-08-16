# Implementation Plan (web): stats-advisor (roadmap 4.2 charts / 4.4 advisor UI / 4.5 CSV button)

Frontend-engineer scope-grooming output. Nothing is implemented in this run.

**Binding inputs:** `.tasks/stats-advisor/task.md` (BINDING: the "Спросить AI" button
ships NOW; a 503 `{"detail":"AI_NOT_CONFIGURED"}` renders **"AI недоступен — ключ не
настроен"**), `architecture.md` (D4 stats shapes, D5 period grammar, D9 SSE
protocol + the 0.3 escape hatch, D13 CSV blob, D14 bounds, D16 web note),
`plan.md` (the wire contract: `schemas/stats.py`, `AdvisorAsk`/`AdvisorTurn`/
`AdvisorError`, the SSE event grammar, the CSV columns, "Regen + web handoff (B2b)"),
the **senior-lead rulings** (backend Disagreements 1–3 upheld: a 503 does NOT
consume advisor quota; the advisor has NO business 422 code — only
`HTTPValidationError`; `AdvisorError` models only the 503/429 arms; advisor context
window = 3 full months excluding the current partial; backend order B1 → B2a → B2b → B3),
`.tasks/currencies-goals/plan-web.md` (WD-style discipline, AM-5 decode rule, T-obligations,
W4 carry-forward F4(b): server series rendered verbatim, negative values tolerated),
and `.tasks/openapi-client-generation/architecture.md` D2c (the SSE escape hatch).

Every claim below was verified against the working tree (files cited inline).
Mobile is FROZEN — nothing in `apps/mobile`; one carry-forward note at the end.

**Order:** W1 → W2 → W3 → W4. Backend gating:

| web subtask | needs the regen commit of | why |
|---|---|---|
| W1 stats-core | **B1** | `/stats/summary`, `/stats/top-merchants`, `StatsError` |
| W2 stats-charts | **B1** (same commit as W1) | `/stats/monthly` |
| W3 advisor | **B2b** | `AdvisorAsk`/`AdvisorTurn`/`AdvisorError`, `paths["/advisor/ask"]["post"]` |
| W4 csv-export | **B3** | `/transactions/export` 200 `text/csv` |

W1/W2 are both unblocked by B1 and could run in parallel with W3/W4 in principle;
sequential single-engineer execution is the recommendation (the receipts §5
argument, reused at 3.2: `apps/web/src/data/queryKeys.ts`, `data/transactions.ts`
and `routes/StatsPage.tsx` would otherwise be edited by two runs at once).

**Why four subtasks and not the three the brief sketched.** The brief's W1 would
land a route + nav, a four-unit period grammar, a three-query data layer, an
invalidation policy change in the shipped transactions layer, a category pie, a
comparison block, a monthly Recharts chart, a merchants list AND a goals section
in one diff — two distinct review surfaces (pure period/comparison logic vs chart
rendering) in one run, which is exactly the argument the backend plan used to split
B2. Split, W1 is a diff whose risk is all in vitest-pinned pure modules and W2 is a
diff that is almost entirely presentational. Cost: one extra run.

**Tier: all four STANDARD** (implement + `/review-pr` self-review → senior diff
gate → web-qa), per the PM guidance "charts / CSV / UI = STANDARD" and the
receipts-R8 rationale: no new auth surface, and **no client-side money math** —
every aggregated or converted number is a server response field. Escalation clause
(the 3.2 W1 precedent): if at implementation any of the pure modules named below
cannot stay pure and leaks into JSX event soup, stop and ask senior-lead for FULL.

**Gates, every subtask:** `pnpm --filter @budget/web lint`, `typecheck`, `test`;
plus `pnpm --filter @budget/api-client typecheck` + `test` and `pnpm -r typecheck`
(the frozen-mobile guard) for any subtask that touches `packages/api-client` or
`packages/shared` (W3 does both). G1 is inverted this scope, as at 3.2:
`schema.d.ts` is EXPECTED to change — each W builds against the exact regen commit
its backend dependency produced, and **no W-subtask ever runs `pnpm openapi`, edits
`schema.d.ts`, or casts around a contract mismatch**. A type mismatch is a
STOP-and-report to senior-lead.

---

## Shared web design decisions (WS-n)

### WS-1. One `/stats` route, one period grammar; the picker owns the URL

New route `/stats` inside `ProtectedLayout` + a nav link "Stats"
(`apps/web/src/App.tsx`, `routes/ProtectedLayout.tsx` — the `/goals` addition at
3.2 is the template). Period selection lives in the **URL search params** (the
`TransactionsPage` `?month=` precedent, `routes/TransactionsPage.tsx:32-34`) so a
period is linkable and survives a reload.

All period ↔ URL ↔ wire mapping is one pure module,
`apps/web/src/features/stats/period.ts`:

```ts
export type PeriodSelection =
  | { unit: 'month';   month: string }    // "YYYY-MM"
  | { unit: 'quarter'; quarter: string }  // "YYYY-Q1".."YYYY-Q4"
  | { unit: 'year';    year: number }
  | { unit: 'custom';  from: string; to: string };   // "YYYY-MM-DD", inclusive

export function parsePeriodParams(params: URLSearchParams): PeriodSelection;
export function periodSearchParams(sel: PeriodSelection): Record<string, string>;
export function periodQuery(sel: PeriodSelection): StatsPeriodQuery;  // the WIRE object
export function shiftPeriod(sel: PeriodSelection, delta: -1 | 1): PeriodSelection;
export function periodLabel(sel: PeriodSelection, locale?: string): string;
```

- `parsePeriodParams` is **total**: a missing, unknown or malformed `period` (or a
  present-but-mismatched anchor) falls back to `{unit:'month', month: currentMonth()}`.
  The client therefore never sends a request that D5 would answer
  `422 PERIOD_ANCHOR_REQUIRED` — that code is a bug signal in the web (WS-6), not a
  user-facing error, exactly as `*_REQUIRED` is treated at 1.6/3.2.
- `periodQuery` emits **`period` always** (D5 makes it required; there is no default
  server-side and we do not want a typo'd param to silently return a month) plus
  exactly the one anchor that unit needs — never a stray `month=` alongside
  `period=year`, which D5 rejects as a mismatched anchor.
- `shiftPeriod` powers the prev/next stepper for month/quarter/year and is the
  **identity** for `custom` (the stepper is not rendered for custom — "the same
  length immediately before" is a server concept for the comparison block, not a
  navigation gesture the user asked for).
- `periodLabel` is presentation only: "July 2026", "Q3 2026", "2026",
  "Mar 10 – Mar 20, 2026" (via the shared `formatMonthLabel` / `formatApiDate`).
  Once the response lands the section header ALSO shows the server-echoed
  `period.from`/`period.to` — the resolved bounds are the server's, we never
  compute period bounds client-side.

Calendar primitives that are genuinely date-wire helpers go to
**`packages/shared/src/dates.ts`** next to `shiftMonth`/`monthBounds` (the
established home; additive → frozen-mobile safe, and mobile needs the same math at
unfreeze): `quarterParam(year, q)`, `currentQuarter()`, `shiftQuarter(q, delta)`,
`formatQuarterLabel(q, {locale})`, `quarterOfMonth(month)`. The URL/selection
mapping stays web-local (it is routing, not date math).

### WS-2. Query keys + invalidation (T9 discipline extended)

`apps/web/src/data/queryKeys.ts` additions — a new top-level `['stats', ...]`
family, disjoint from `['transactions', ...]` so no existing predicate touches it:

```ts
export type StatsPeriodQuery =
  | { period: 'month';   month: string }
  | { period: 'quarter'; quarter: string }
  | { period: 'year';    year: number }
  | { period: 'custom';  from: string; to: string };

statsSummary:      (p: StatsPeriodQuery) => ['stats', 'summary', p] as const,
statsMonthly:      (months: number)      => ['stats', 'monthly', { months }] as const,
statsTopMerchants: (p: StatsPeriodQuery, limit: number) =>
                     ['stats', 'top-merchants', p, { limit }] as const,
```

The key member IS the wire query object — one source of truth for "which period am
I looking at", so a key can never drift from the request that filled it.

**Invalidation policy — stated, not buried.** `data/transactions.ts`'s three
mutations (`useCreateTransaction`, `useUpdateTransaction`, `useDeleteTransaction`)
gain `invalidateStats(queryClient)` = `invalidateQueries({ queryKey: ['stats'] })`,
next to the existing `invalidateGoalsList` call:

- **Blanket, not surgical.** Any tx write can move any period: an edit that changes
  `occurred_at`, `amount_minor`, `currency`, `base_amount_minor`, `category_id`,
  `kind` or `merchant` lands in some cached period, and deciding *which* cached
  periods a write touches client-side would re-implement the server's window and
  bucket logic — the exact thing D4/D12 forbid in spirit and the same argument WD-4
  used for the goals list. The cost is zero for users who never open /stats (an
  invalidation of an empty family is a no-op).
- **Receipts** create transactions through `useCreateTransaction`, so they are
  covered with no extra code.
- **Category mutations do NOT invalidate stats.** `by_category` is
  reference-by-id (D4); names/colors/archived come from the `['categories']` cache,
  which already has its own invalidation. A rename must not refetch aggregates.
- **Goal/contribution mutations do NOT invalidate stats.** The stats screen's goals
  section reuses the existing `useGoals` query (D4: goals progress is NOT re-served),
  so the shipped `['goals']` invalidations already cover it.
- **CSV export invalidates nothing** (it is a read with no cache entry — WS-8).
- **The advisor invalidates nothing and is never cached** (WS-7).

All three stats queries use `placeholderData: keepPreviousData` (the `useGoals`
precedent) so stepping the period dims the current numbers instead of flashing the
whole screen back to skeletons. Default `staleTime` (30 s, `lib/query.ts:15`) is
kept — freshness after writes comes from the explicit invalidation, not from polling.

### WS-3. AM-5 decode discipline — every money decode site in this scope

Binding (receipts-ocr §4 AM-5, restated at 3.2 T8′): **every minor value is decoded
with the currency it is denominated in, taken from the same response object; never
`?? base`, never a hardcoded code, never another response's currency.**

| site | currency source |
|---|---|
| `/stats/summary` `income/expense/net_minor`, `by_category[].total_minor`, `previous.*` | `summary.currency` (that response's own field) |
| prev-period **delta** (`current − previous`) | `summary.currency` — both operands come from ONE response, so the subtraction can never mix currencies |
| `/stats/monthly` `points[].income/expense/net_minor` + chart axis/tooltip | `monthly.currency` |
| `/stats/top-merchants` `items[].total_minor` | `topMerchants.currency` |
| goals section `saved_minor`/`target_minor` | `goal.currency`; `free_balance_minor` → `list.base_currency` (the field granted at 3.2 CA-1, `GoalsPage.tsx:61`) |
| CSV export | **no client decode at all** — the server emits major-unit strings (D13/OQ-6) and the web never parses the file |
| advisor | **no client decode at all** — the answer is prose; the client never parses a number out of the model's text and never re-formats one |

The three stats responses each carry their own `currency`. They will always agree
(one profile base), but the web reads each response's own field — borrowing one
response's currency to render another's numbers is precisely the AM-5 sin, and it
would go wrong the day a base-currency change lands between two cached queries.

### WS-4. The client recomputes nothing — and what "presentation math" is allowed to mean

Binding (D16, "клиент ничего не пересчитывает"). Explicitly FORBIDDEN in this scope:

- summing `by_category[]` to obtain a total (use `income_minor`/`expense_minor`);
- accumulating, gap-filling, clamping or re-ordering any server series (F4(b));
- computing any currency conversion, free balance, realism, or monthly-needed figure;
- deriving a period's bounds, or a "previous period", client-side.

ALLOWED, and confined to ONE pure module `apps/web/src/features/stats/comparison.ts`:

```ts
export type Comparison =
  | { kind: 'both-zero' }                                   // nothing to compare
  | { kind: 'no-base';  deltaMinor: number }                // previous <= 0 -> absolute only
  | { kind: 'ratio';    deltaMinor: number; percent: number };

export function compare(currentMinor: number, previousMinor: number): Comparison;
export function share(partMinor: number, totalMinor: number): number | null;
```

D4 is explicit that the server ships both periods' totals and no delta fields
because "delta/percent rendering is presentation". The policy, decided here:

1. **Delta** = integer subtraction of two same-currency minors from one response.
   No float, no rounding, and D14's `MAX_MINOR_AMOUNT` (1e15−1) makes the result
   safe-integer by construction, so `formatMoney`'s `assertSafeMinor` cannot throw
   on it.
2. **Percent, division-by-zero-base policy:** a percent is rendered **only when
   `previous > 0`**. `previous === 0` → `no-base`: show the absolute delta plus
   honest copy ("nothing last period"), never "+100%", never "∞", never a hidden
   `NaN`. **`previous < 0` (a negative previous NET is legitimate) → also
   `no-base`**: a percentage change against a negative base has no direction a
   reader can trust, so we show the absolute movement instead of a number that
   would flip sign for the wrong reason. Both zero → `both-zero`: "same as last
   period", no arrow.
3. `percent = Math.round(((current − previous) / previous) * 100)` — a float
   division whose result is a **percentage**, never fed back into money and never
   stored. Displayed as an integer with an explicit sign.
4. **`share(part, total)`** returns `null` when `total <= 0`; otherwise the part's
   percentage **of the server's own kind total** (`expense_minor` / `income_minor`),
   never of a client-summed bucket total. If the buckets ever fail to add up to the
   server total, the shares visibly fail to reach 100 % — we surface that rather
   than hide it behind a normalized denominator.
5. **Semantic colour, no invented judgement.** Expense up = warning tone, expense
   down = positive tone, income the reverse, net by sign. No "you overspent" copy —
   the app does not editorialize; that is the advisor's job.

### WS-5. Honesty surfaces (the `unconverted_count` pattern, extended per the carry-forward)

The 3.2 `SummaryHeader` banner (`SummaryHeader.tsx:80-89`, `role="status"`, not an
error) is the template and its wording is reused:

- `/stats/summary` → one banner for the current period; `previous.unconverted_count > 0`
  additionally suppresses **the percent** in the comparison block and replaces it
  with "last period is incomplete" copy — comparing a complete period against an
  incomplete one and printing a crisp percentage is a quiet lie.
- `/stats/top-merchants` → one banner ("… excluded from these totals"), same shape.
- `/stats/monthly` → **per-point**, which is the whole reason D4 made it per-point:
  the tooltip for a flagged month shows its own count, and one note under the chart
  names the flagged months ("Mar, Jun include transactions with no exchange rate —
  those are left out of the bars"). Counting flagged months is a count of FLAGS, not
  of money — no aggregation rule is bent.
- **The current month is partial.** D4's monthly window ends at the CURRENT month
  inclusive, so the last bar is always a part-month and will always look like a dip.
  The chart labels it ("this month so far") and the note says so. Not fixed by
  changing the request — a dynamics chart that stops last month is worse — fixed by
  saying it out loud (the F4(b) discipline).
- **Top merchants are expense-only** (D2 `[assumption]`, hardcoded server-side, no
  `kind` param): the section heading says "Top merchants (spending)", otherwise a
  missing salary source reads as a bug.

### WS-6. Error helpers (`apps/web/src/lib/errors.ts`) — one table per resource, as established

| code / arm | helper | surfaces as |
|---|---|---|
| `PERIOD_ANCHOR_REQUIRED` (422, `StatsError`) | `describeStatsError` (new, W1) | **panel-level generic** + a "reset to this month" action. `parsePeriodParams` is total (WS-1), so reaching this code is a bug signal — the `*_REQUIRED` T6 precedent |
| `HTTPValidationError` array arm on stats | `describeStatsError` | panel-level generic (no fields to route to on a read screen) |
| `AI_NOT_CONFIGURED` (503) | `describeAdvisorError` (new, W3) | **verbatim binding copy: "AI недоступен — ключ не настроен"** |
| `RATE_LIMITED` (429) | `describeAdvisorError` | "Слишком много запросов. Подождите и попробуйте снова." (no `Retry-After` on the wire — see OQ-3) |
| `ANTHROPIC_ERROR` (mid-stream `error` event) | `describeAdvisorError` | partial answer KEPT + notice under it |
| `STREAM_INCOMPLETE` (synthetic, WS-7) | `describeAdvisorError` | partial answer KEPT + "connection lost" notice |
| `STREAM_MALFORMED` (synthetic, WS-7) | `describeAdvisorError` | generic (protocol bug signal) |
| 422 on `/advisor/ask` | `describeAdvisorError` | generic. Per the upheld ruling the advisor has **no business 422 code**, only `HTTPValidationError`, and the client caps (WS-7) make it unreachable — so it is a bug signal, never a field message |
| non-`ApiError` (network) | all | the existing `NETWORK_MESSAGE` |

`AI_NOT_CONFIGURED` already has an English entry in `receiptErrorMessage`
(`errors.ts:221`) for the receipts flow. **That entry is NOT touched** — the two
surfaces have different copy by decision (see OQ-2 on language); a shared table
would force one wording onto two very different flows.

### WS-7. The SSE escape hatch: `askAdvisor` in `packages/api-client/src/`

Two new hand-written modules (0.3 D2c, exactly as designed — the endpoint is a
**POST**, so browser `EventSource` is GET-only and structurally unusable; this is
the only option, and the docstring says so):

```
packages/api-client/src/sse.ts       — the frame parser (transport-agnostic, pure)
packages/api-client/src/advisor.ts   — askAdvisor: fetch + ReadableStream + the parser
```

Both import **types only** from `./generated/schema` (`AdvisorAsk`, `AdvisorTurn`,
`AdvisorError` — the symbols B2b's handoff names) and reuse the shipped `ApiError`
from `./errors`. Neither is generated; neither hand-edits anything generated.

**Header discipline (AM-2, honestly worded).** These files use no DOM globals
(`window`/`document`/`localStorage`/`navigator`) — but they DO use `fetch`,
`Request`, `ReadableStream` and `TextDecoder`, which are runtime globals, not DOM.
The header states that plainly plus the recorded mobile caveat (D12): React
Native's fetch does not expose a streaming response body, which is precisely D12's
`?stream=false` trigger. Claiming blanket platform-freedom here would be a lie.

**Auth: the injected-fetch seam, reused — no second token source.** `client.ts:12`
types the seam as `fetch?: (input: Request) => Promise<Response>` and `lib/api.ts:28`
passes `coordinator.authFetch`. `askAdvisor` takes the **same** seam:

```ts
export interface AskAdvisorOptions {
  baseUrl: string;
  fetch: (input: Request) => Promise<Response>;   // pass coordinator.authFetch
  body: AdvisorAsk;
  signal?: AbortSignal;
}
export type AdvisorStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; detail: string };

export async function* askAdvisor(o: AskAdvisorOptions): AsyncGenerator<AdvisorStreamEvent>;
```

so the bearer, the single silent 401→refresh→retry and the AM-7 body-preserving
clone all come from the shipped coordinator with zero duplication — and mobile's
own coordinator exposes the identical seam (`apps/mobile/src/auth/coordinator.ts`),
so the helper is reusable at unfreeze without change. **Verified**: `authFetch`
clones the request BEFORE sending (`coordinator.ts:163`) and returns the `Response`
untouched, so the streaming body is never consumed by the auth layer.

**Failure taxonomy — two channels, deliberately:**

- **Pre-stream** (`!response.ok`): read the body as text → `JSON.parse` (the same
  best-effort openapi-fetch does) → `throw new ApiError(status, body)`. 503 and 429
  therefore flow into the shipped `getErrorCode` machinery unchanged.
- **Mid-stream**: a 200 has already been sent, so the status can no longer change —
  the `error` event IS the channel (D9). `askAdvisor` yields
  `{type:'error', detail}` and stops.
- **Drop without a terminal event** (stream ends after 0..n deltas, no `done`, no
  `error`): yields `{type:'error', detail: 'STREAM_INCOMPLETE'}` — D9's explicit
  client obligation.
- **Malformed frame** (unparseable `data`, or a `delta` without a string `text`):
  yields `{type:'error', detail: 'STREAM_MALFORMED'}` and stops. Silently skipping
  a frame would turn a protocol break into a truncated answer the user believes.
- **Unknown event names are ignored** (forward-compatible with a future heartbeat).
- After a terminal event the reader is cancelled; `signal` abort propagates to
  `fetch` and closes the generator.

**The frame parser (`sse.ts`) is the one genuinely test-worthy unit in this scope:**

```ts
export interface SseFrame { event: string; data: string }
export function createSseFrameParser(): {
  push(chunk: Uint8Array): SseFrame[];   // owns the TextDecoder({stream:true}) AND the line buffer
  flush(): SseFrame[];                   // trailing complete frames only
};
```

It owns the streaming `TextDecoder` (so a UTF-8 character split across two network
chunks is reassembled instead of becoming U+FFFD — Russian answers make this a
*when*, not an *if*), normalizes `\r\n`, skips comment lines (`:` heartbeats),
joins multiple `data:` lines with `\n` per the SSE spec, strips exactly one space
after the colon, and dispatches only on a blank line — so an incomplete trailing
frame is never dispatched, which is what makes "drop without terminal event"
detectable at all.

### WS-8. Advisor client state: React state, not Zustand, not the Query cache

`zustand` is **not a dependency of `apps/web`** (verified in `package.json`) and
this plan does not add it — the chat transcript is transient, single-screen state,
which `useReducer` covers. It is equally NOT server state: the server is stateless
(chat memory is client-carried per OQ-2), there is no GET to revalidate and no
cache key that could ever be re-filled, so writing it into the Query cache would be
cache abuse. The **network call** is a `useMutation` (pending/error come from the
standard machinery; a streaming POST is a mutation by every definition), with the
deltas delivered through an `onEvent` callback passed in the mutation variables and
dispatched into the reducer.

**History caps enforced client-side BEFORE send** (so users never see a raw 422),
in a pure module `apps/web/src/features/advisor/history.ts`:

```ts
export function buildHistory(turns: TranscriptTurn[]): AdvisorTurn[];
```

Guarantees, all of them load-bearing:
1. ≤ **10** turns and ≤ **8000** total content chars (the `AdvisorAsk` caps).
2. Trimming drops the **oldest complete user+assistant PAIR**, never a single turn.
   Reason, verified against the backend plan: the router builds
   `messages=[*history, question]` for the Anthropic SDK, which requires
   alternation starting with `user` — a history that begins with an assistant turn
   would surface to the user as a mysterious `ANTHROPIC_ERROR`. So the result
   always starts with `user` and alternates.
3. Turns with empty/whitespace content are excluded (`AdvisorTurn.content` has
   `min_length=1`).
4. **Aborted or errored assistant answers are excluded together with their user
   turn** — an incomplete answer is not context the model should reason from. It
   stays visible on screen; it just does not travel.

The question itself is validated by a **shared zod schema**
(`packages/shared/src/schemas.ts`: `advisorAskSchema` — `z.string().trim().min(1).max(2000)`,
matching `AdvisorAsk.question`), used through react-hook-form like every other form
in the app, and reusable by mobile at unfreeze (the R3 frontend-owned-schemas rule).

### WS-9. Chart conventions (shared with the shipped goals chart)

`GoalProgressChart.tsx:153` already owns a `formatTick` helper whose comment
explains the `Math.round` (Recharts derives non-integer "nice" tick values while
the shared money helpers correctly reject non-integer minors; it affects a GRIDLINE
LABEL only). W2 is its second consumer → extract to
`apps/web/src/lib/chartFormat.ts` (`moneyTickFormatter(currency)`) and refactor the
goals chart onto it in the same subtask — the first/second-consumer rule this
codebase applies everywhere, mechanical and behaviour-identical.

Inherited verbatim from the shipped chart: `accessibilityLayer` on every chart,
`domain={['auto','auto']}` on every Y axis (never `[0,'auto']` — a negative net
month must be visible, not flattened against the baseline: F4(b)),
`isAnimationActive={false}`, `formatMonthShortLabel` for month ticks, a
fixed-height `chartBox` with a matching skeleton so the data landing causes no
reflow. **Recharts 3.10.1 is already pinned** (`apps/web/package.json`, verified) —
no dependency change anywhere in this scope, in any subtask.

---

# W1 — stats-core: route, period grammar, summary + breakdown + comparison   (tier: STANDARD)

**Depends on:** backend **B1**'s regen commit.
**Goal:** the `/stats` screen exists, the period picker drives the D5 grammar from
the URL, and `GET /stats/summary` renders as income/expenses, a category breakdown
and an honest prev-period comparison.

## Files

`packages/shared`:
- `src/dates.ts` — `quarterParam`, `currentQuarter`, `shiftQuarter`,
  `quarterOfMonth`, `formatQuarterLabel` (WS-1; additive, frozen-mobile safe).
- `src/index.ts` — exports.
- `src/dates.test.ts` — extended (quarter arms only; see Vitest).

`apps/web`:
- `src/App.tsx` — `<Route path="/stats" element={<StatsPage />} />` inside
  `ProtectedLayout` (**route added: `/stats`**).
- `src/routes/ProtectedLayout.tsx` — nav link "Stats" (between Transactions and
  Categories).
- `src/routes/StatsPage.tsx` + `.module.css` — the shell: `<h1>`, `PeriodPicker`,
  the summary/comparison/breakdown sections, and the W2/W3 mount points (added in
  their own subtasks).
- `src/features/stats/period.ts` (**pure**, WS-1) + `period.test.ts`.
- `src/features/stats/comparison.ts` (**pure**, WS-4) + `comparison.test.ts`.
- `src/features/stats/PeriodPicker.tsx` + `.module.css` — a unit segmented control
  (Month / Quarter / Year / Custom, real `<button>`s with `aria-pressed`), the
  prev/next stepper for the three calendar units (the shipped `MonthPicker` shape,
  `aria-label`led, `aria-live="polite"` on the label), and two native
  `<input type="date">`s with `<label>`s for custom. Writes to search params only.
- `src/features/stats/StatsTotals.tsx` + `.module.css` — income / expense / net
  cards, each with its comparison line (delta + percent per WS-4).
- `src/features/stats/CategoryBreakdown.tsx` + `.module.css` — expense group then
  income group, rows rendered in the server's order (D4: `(kind, total DESC)`),
  name/icon/archived styling joined from the archived-inclusive category index
  (`buildCategoryIndex`, `SummaryHeader.tsx:96-100` precedent), amount + share %.
- `src/data/stats.ts` — `useStatsSummary(sel)`; `StatsSummaryRead` etc. typed from
  `components['schemas']`.
- `src/data/queryKeys.ts` — `StatsPeriodQuery`, `qk.statsSummary` (WS-2).
- `src/data/transactions.ts` — `invalidateStats` added to the three mutations (WS-2).
- `src/lib/errors.ts` + `errors.test.ts` — `describeStatsError` (WS-6).

## Data layer

`GET /stats/summary` with `params.query = periodQuery(selection)`. Query key
`['stats','summary', <that same object>]`. `keepPreviousData`. Category names come
from the existing `useCategories()` (archived-inclusive, `qk.categories()`) — no
new query, no name duplication in the stats payload (D4).

## UI states (explicit — this is where frontends rot)

| state | rendering |
|---|---|
| loading (first) | skeleton cards at the final box size + a skeleton breakdown list — no reflow when data lands |
| loading (period step) | previous numbers stay, container gets a `dimmed` class + `aria-busy` |
| empty (200, all zeros, `by_category: []`) | "No transactions in {period}." + two actions: "Add a transaction" (link to /transactions) and "Pick another period" — an empty state that says what to do next |
| partial (`unconverted_count > 0`) | the WS-5 `role="status"` banner; totals still render |
| comparison, `previous` zero/negative/incomplete | WS-4 `no-base` / `both-zero` copy; percent suppressed |
| error | `role="alert"` + Retry (the `GoalsPage.tsx:48-54` shape) |
| 422 `PERIOD_ANCHOR_REQUIRED` | panel-level generic + "reset to this month" (bug signal, WS-6) |

## Vitest (non-vacuous only)

`packages/shared/src/dates.test.ts`:
1. `shiftQuarter` across the year boundary in both directions (`2026-Q1` → `2025-Q4`,
   `2025-Q4` → `2026-Q1`) — the arm a naive `q±1` gets wrong.

`apps/web/src/features/stats/period.test.ts`:
2. `parsePeriodParams` fallback arms, contrasted against a valid one in the same
   test: no params, `period=month` with no `month`, `period=year&month=2026-08`
   (mismatched anchor), `period=bogus` → all default to the current month; a valid
   `period=quarter&quarter=2026-Q2` survives untouched. This is what keeps
   `PERIOD_ANCHOR_REQUIRED` unreachable.
3. `periodQuery` emits exactly one anchor per unit — asserted by object equality, so
   a stray `month` alongside `period=year` fails the test (that stray is precisely
   what D5 422s on).
4. round-trip `sel → periodSearchParams → parsePeriodParams === sel` for all four units.
5. `shiftPeriod` is the identity for `custom` and steps the other three (one arm each).

`apps/web/src/features/stats/comparison.test.ts`:
6. `compare`: `previous === 0` → `no-base` (explicitly **not** `Infinity`/`NaN`);
   `previous < 0` → `no-base`; a normal increase and a normal decrease → `ratio`
   with the expected signed rounded percent; equal values → `ratio` with `percent: 0`
   (the contrast arm that stops "0 means no data" confusion).
7. `share`: `total === 0` → `null`; a normal part → the rounded percentage.

`apps/web/src/lib/errors.test.ts`:
8. `PERIOD_ANCHOR_REQUIRED` → panel-level, and NOT routed to any field.

**No component tests** (`apps/web` vitest runs `environment: 'node'` and there is no
testing-library in the tree — verified in `vite.config.ts` / `package.json`).
Rendering assertions would be vacuous under the house rule; web-qa covers the screens live.

## Obligations (W1)

- **S-1** the client sends `period` on every stats request and exactly one matching
  anchor (evidence: test 3).
- **S-2** no client-side aggregation: the /implement report states that no
  `by_category` sum, no period-bounds computation and no conversion appears in the
  diff (WS-4).
- **S-3** every money decode names its response's own `currency` (WS-3) — grep line
  in the report showing no `?? ` fallback on any currency argument.
- **S-4** the stats invalidation is added to **all three** tx mutations (WS-2).

---

# W2 — stats-charts: monthly dynamics, top merchants, goals progress   (tier: STANDARD)

**Depends on:** W1 (the `/stats` shell) + backend **B1**'s regen (same commit).
**Goal:** the three remaining series on the stats screen, all rendered verbatim.

## Files

`apps/web`:
- `src/lib/chartFormat.ts` — `moneyTickFormatter(currency)` extracted from
  `GoalProgressChart.tsx:153` (WS-9).
- `src/features/goals/GoalProgressChart.tsx` — refactored onto it (mechanical,
  behaviour-identical; the shipped chart's own comment moves with the code).
- `src/features/stats/MonthlyChart.tsx` + `.module.css` — Recharts `ComposedChart`:
  income and expense `Bar`s + a net `Line`, `XAxis` `formatMonthShortLabel`,
  `YAxis domain={['auto','auto']}`, tooltip via `formatMoney(_, monthly.currency)`
  plus the per-point `unconverted_count` when > 0, the current-month "so far"
  marker and the flagged-months note (WS-5). A small 6 / 12 / 24 months selector
  (local `useState` — a genuine view preference, WS-8 class) feeding `months`.
- `src/features/stats/TopMerchants.tsx` + `.module.css` — ordered list rendered in
  the server's order (`total DESC, merchant ASC`), `formatMoney(item.total_minor,
  topMerchants.currency)` + `tx_count`, heading "Top merchants (spending)" (WS-5),
  a `limit` of 10 (constant; no selector until someone asks), `key={item.merchant}`
  (the merchant string is the server's grouping key and is unique within the
  response — the one case where a non-uuid key is the entity identity).
- `src/features/stats/GoalsProgressSection.tsx` + `.module.css` — **reuses the
  existing `useGoals(false)` query** (D4: goals progress is NOT re-served): per goal
  a name, a progress bar and `formatMoney(saved, goal.currency)` /
  `formatMoney(target, goal.currency)`, plus a link to `/goals` for the full cards.
  No new endpoint, no new query key, no realism/waterfall re-rendering here (that
  screen owns it — one assembler, one presentation, the AM-4 argument).
- `src/data/stats.ts` — `useStatsMonthly(months)`, `useStatsTopMerchants(sel, limit)`.
- `src/data/queryKeys.ts` — `qk.statsMonthly`, `qk.statsTopMerchants`.
- `src/routes/StatsPage.tsx` + `.module.css` — mounts the three sections.

## Note on scope of the period picker (see Disagreement 1)

`/stats/monthly` takes only `months=N` ending at the current month — it is NOT
period-scoped. The screen therefore renders it as a **visually separate "Last N
months" section with its own selector**, outside the period picker's card, so that
selecting "2024" and seeing 2026 bars is impossible to misread. Recorded as a
deliberate design consequence, not an accident.

## UI states

Per section, independently (one failing section never blanks the screen):
loading → fixed-height skeleton matching the chart box; empty → for monthly, an
all-zero series still renders the axes with "No activity in this window" (a
flatline is information, a spinner is not); for merchants, "No merchant names yet —
receipts and manual entries with a merchant show up here"; for goals, the existing
empty-goals copy + a link to create one; error → `role="alert"` + Retry per section.

## Vitest

**None.** Every unit in this subtask is either a Recharts render (asserting the
library, not our behaviour — vacuous by the house rule and impossible in the `node`
environment) or a straight `.map` over a server array with no transform to test.
The absence of transform code IS the verbatim-rendering guarantee. web-qa checks
the visuals live.

## Obligations (W2)

- **S-5** no accumulation / gap-filling / clamping / re-sorting of any series;
  `domain={['auto','auto']}` on every Y axis (F4(b)) — evidence: the diff's chart
  props quoted in the report.
- **S-6** per-point `unconverted_count` is surfaced per point, never collapsed into
  one number (D4's stated reason).
- **S-7** the current partial month is labelled as partial (WS-5).
- **S-8** the goals section adds **zero** new queries or endpoints (D4).

---

# W3 — advisor: the escape-hatch client + the chat screen   (tier: STANDARD)

**Depends on:** backend **B2b**'s regen commit (`AdvisorAsk`, `AdvisorTurn`,
`AdvisorError`, `paths["/advisor/ask"]["post"]`).
**Goal:** the binding requirement — the "Спросить AI" button ships, streams when the
server has a key, and says "AI недоступен — ключ не настроен" when it does not.

**Tier note.** STANDARD is right (no auth surface — the shipped coordinator seam is
reused wholesale; no money math at all), and the genuinely novel part (SSE frame
parsing) is extracted into a pure, heavily-tested module. If at implementation the
parser cannot be kept transport-agnostic and pure, stop and ask for FULL.

## Files

`packages/api-client`:
- `src/sse.ts` — `createSseFrameParser` (WS-7) + `sse.test.ts`.
- `src/advisor.ts` — `askAdvisor` + the event union (WS-7) + `advisor.test.ts`.
- `src/index.ts` — export both (additive; `pnpm -r typecheck` proves the mobile
  freeze held).

`packages/shared`:
- `src/schemas.ts` + `src/index.ts` — `advisorAskSchema` (WS-8).

`apps/web`:
- `src/lib/api.ts` — export the already-validated `baseUrl` const (it is built and
  checked there today, lines 7-13; the advisor needs the same string and must not
  re-read `import.meta.env`).
- `src/data/advisor.ts` — `useAskAdvisor()`: a `useMutation` whose `mutationFn`
  consumes `askAdvisor({ baseUrl, fetch: coordinator.authFetch, body, signal })`
  and forwards each event to the caller's `onEvent`. **No query key, no cache
  entry, no invalidation** (WS-2/WS-8) — documented in the module header.
- `src/features/advisor/history.ts` (**pure**, WS-8) + `history.test.ts`.
- `src/features/advisor/useAdvisorChat.ts` — `useReducer` transcript + an
  `AbortController` ref + the mutation. Transcript turn shape:
  `{ id, role, text, status: 'complete' | 'streaming' | 'stopped' | 'error', errorDetail? }`
  (a discriminated status, which is what the render switches on).
- `src/features/advisor/AdvisorChat.tsx` + `.module.css` — the transcript (`<ol>`,
  stable `key` from the turn id), the composer (RHF + `advisorAskSchema`, a
  `<textarea>` with a real `<label>`, a live char counter, Cmd/Ctrl+Enter to send),
  a **Stop** button while streaming, and the error/notice blocks.
- `src/routes/AdvisorPage.tsx` + `.module.css` — **route added: `/advisor`**;
  `src/App.tsx` + `src/routes/ProtectedLayout.tsx` — the route and a nav link.
- `src/routes/StatsPage.tsx` — the **"Спросить AI"** button in the page toolbar,
  navigating to `/advisor` (the binding entry point; ships regardless of server key
  state — there is no capability probe, no feature flag, and no endpoint that would
  let us hide it honestly).
- `src/lib/errors.ts` + `errors.test.ts` — `describeAdvisorError` (WS-6).

## Streaming render, states, a11y

| state | rendering |
|---|---|
| idle / empty | "Спросите про свои траты" + 2–3 example-question buttons that fill the composer — an empty state that says what to do next |
| pending (request sent, no delta yet) | the assistant bubble appears with a typing indicator; Ask disabled, **Stop enabled** |
| streaming | text appended per delta (`white-space: pre-wrap`); Stop cancels via `AbortSignal` and marks the turn `stopped` — the partial text **stays on screen** |
| done | turn marked `complete`; a single polite `role="status"` announcement ("Ответ готов") |
| 503 `AI_NOT_CONFIGURED` | **"AI недоступен — ключ не настроен"** verbatim, `role="alert"`; composer stays enabled (the server may get a key; the button never hides) |
| 429 `RATE_LIMITED` | human message (WS-6) |
| `error` event mid-stream / `STREAM_INCOMPLETE` | partial answer KEPT, marked `error`, notice under it, retry available |
| network failure | `NETWORK_MESSAGE` |

A11y: the streaming region is `aria-live="off"` **on purpose** — a polite live
region re-announced on every token is unusable with a screen reader; completion is
announced once via a separate `role="status"` node. The composer is a real `<form>`
with a labelled `<textarea>` and `<button type="submit">`; Stop is a `<button>`.

Answers render as **plain text** (`pre-wrap`). No markdown renderer: that would be a
new dependency, which needs senior-lead approval and is not in this scope (see OQ-4).

## Vitest

`packages/api-client/src/sse.test.ts` — **the one genuinely test-worthy unit**:
1. a whole frame in one chunk → `{event:'delta', data:'{"text":"hi"}'}`.
2. **chunk-boundary splits**: the SAME frame fed as byte-splits at three positions —
   mid-field-name (`eve|nt: delta`), mid-data (`{"te|xt":"hi"}`) and exactly between
   the two terminating newlines — all three produce the identical single frame. The
   split-at-the-separator arm is the one a naive `chunk.split('\n\n')` fails.
3. **mid-multibyte split**: a Cyrillic payload ("Привет") whose UTF-8 bytes are cut
   between the two bytes of a character → text reassembled exactly. The contrast
   arm asserts no U+FFFD anywhere — a non-streaming decoder passes test 2 and fails
   this one, which is why both exist.
4. multiple frames in one chunk → both returned, in order.
5. `\r\n` line endings → identical frames (proxy normalization).
6. a comment/heartbeat line (`: ping`) and an unknown field yield **no** frame,
   while the following real frame still parses (contrast in one test).
7. two `data:` lines in one frame → joined with `\n` (spec behaviour; a parser that
   drops the second silently truncates an answer).
8. `flush()` after a **truncated** trailing frame returns nothing — the property
   that makes "drop without a terminal event" detectable at all.

`packages/api-client/src/advisor.test.ts` (fake `fetch` returning a
`ReadableStream` of `Uint8Array`s — no network, no MSW):
9. deltas then `done` → `[delta, delta, done]`, and the concatenated text matches.
10. 503 body `{"detail":"AI_NOT_CONFIGURED"}` → throws `ApiError` with `status 503`
    and that body, **before** any stream read (the fake asserts its stream was never
    consumed); same test's 429 arm contrasts the status.
11. `error` event after two deltas → the two deltas are yielded first, then
    `{type:'error', detail:'ANTHROPIC_ERROR'}`, and nothing after it.
12. stream ends after deltas with no terminal event → deltas then
    `{type:'error', detail:'STREAM_INCOMPLETE'}` (the D9 client obligation).
13. `AbortSignal` aborted mid-stream → the generator completes without yielding a
    terminal `error` (an intentional stop is not a failure — the UI's `stopped`
    state depends on this distinction).

`apps/web/src/features/advisor/history.test.ts`:
14. 12 turns → 10 turns, oldest **pair** dropped, result starts with `user` and
    alternates (the arm that prevents an SDK-level `ANTHROPIC_ERROR`).
15. 4 short turns whose contents total > 8000 chars → trimmed to fit, still
    starting with `user`; a contrast arm just under the cap is untouched.
16. an `error`/`stopped` assistant turn is excluded **together with its user turn**;
    an empty-content turn is excluded.

`apps/web/src/lib/errors.test.ts`:
17. `AI_NOT_CONFIGURED` → **exactly** the binding string (a string-equality
    assertion, so a copy edit fails the build), and `RATE_LIMITED` → its own
    message (contrast arm).

## Obligations (W3)

- **S-9** the binding copy is byte-exact — evidence: test 17's assertion quoted in
  the report.
- **S-10** the "Спросить AI" button ships and is never conditionally hidden — no
  capability probe anywhere in the diff.
- **S-11** `askAdvisor` uses the coordinator seam, not a second token source —
  evidence: a grep showing no `localStorage`/token read in `packages/api-client/src/advisor.ts`.
- **S-12** `packages/api-client` hand-written files import **types only** from
  `generated/`; the drift test (`drift.test.ts`) stays green and `schema.d.ts` is
  untouched by this subtask.
- **S-13** no new runtime dependency in `apps/web` or `packages/api-client`
  (evidence: `git diff --stat` on both `package.json`s is empty).
- **S-14** `pnpm -r typecheck` green (frozen mobile) after the shared/api-client
  additions.

---

# W4 — CSV export button   (tier: STANDARD)

**Depends on:** backend **B3**'s regen commit.
**Goal:** one honest download button on the transactions screen.

## Files

`apps/web`:
- `src/lib/download.ts` — `downloadBlob(blob: Blob, filename: string): void`:
  `URL.createObjectURL` → a synthetic `<a download>` appended to `document.body`,
  clicked, removed, then `URL.revokeObjectURL` on the next macrotask (revoking in
  the same tick races the download start in some browsers). The **only** DOM-poking
  module added in this scope, deliberately isolated so nothing else needs it.
- `src/data/transactions.ts` — `useExportTransactions()`: a **`useMutation`**
  (a user-triggered side effect producing a file — caching a blob under a query key
  would be wrong on every axis), `mutationFn` =
  `throwOnError(apiClient.GET('/transactions/export', { params: { query }, parseAs: 'blob' }))`.
  **Verified** against the installed `openapi-fetch@0.17.0`: `parseAs` is a
  documented option (`src/index.d.ts:130`), `response[parseAs]()` is called on the
  success path (`src/index.js:262`), and the **error** path always re-parses as
  text→JSON regardless of `parseAs` (`src/index.js:267-273`) — so `ApiError.body`
  still carries the `{detail}` envelope and the shipped `getErrorCode` machinery
  works unchanged. `ParseAsResponse<…, {parseAs:'blob'}>` types `data` as `Blob`,
  so **no cast is needed**; if the generated `text/csv` 200 does not resolve to a
  usable type, that is a STOP-and-report (D13/O-8 is the backend's obligation), never
  an `as`.
- `src/routes/TransactionsPage.tsx` — an "Export CSV" button in the existing
  `toolbarActions` group (next to "Add transaction" / "Add by photo"), passing the
  **current filters verbatim** (`filters.from`, `filters.to`, and `category_id` /
  `kind` when the screen ever sets them — `TxListFilters` already carries the
  optional pair, so the passthrough is written once and stays correct if list
  filtering grows). `limit`/`offset` are NOT sent — an export is the whole matching
  set (D13).
- `src/routes/TransactionsPage.module.css` — button style.
- `src/lib/errors.ts` — no new table needed; the failure is panel-level and reuses
  `NETWORK_MESSAGE`/`GENERIC_MESSAGE` (an export has no fields and no business codes
  — read filters never error, D13/decision-l).

Filename is built client-side from the current period —
`transactions-2026-08.csv`, or `transactions-2026-08-01_2026-08-31.csv` for an
explicit range — rather than reusing the server's constant
`Content-Disposition` name: three exports in a row must not overwrite each other in
the Downloads folder. Presentation only; no contract implication.

## UI states

Idle → "Export CSV". Pending → the button is `disabled` with "Exporting…" (no
spinner overlay; the page stays usable). Success → the file downloads, the button
returns to idle, and a transient `role="status"` line confirms it (a silent
download in a browser that saves without a prompt is indistinguishable from a
no-op). Error → an inline `role="alert"` next to the button with a Retry, never a
modal. Empty result → a header-only CSV downloads (D13's documented behaviour) and
the confirmation line says the export was empty — we do not pre-check the row count
to suppress it (that would be a second source of truth about what matched).

## Vitest

**None.** `downloadBlob` is pure DOM plumbing untestable under `environment: 'node'`
and would need a jsdom dependency the project does not have; the mutation is a
one-line client call. Both are web-qa surfaces (S-17). Filename construction is a
template string with one branch — a test for it would be the vacuous kind the house
rule rejects.

## Obligations (W4)

- **S-15** the export goes **through the api-client** (auth header, no token in the
  query string — D13 is explicit) and never via `window.location`/a bare `<a href>`
  to the API URL.
- **S-16** the current filters are passed through, and `limit`/`offset` are not.
- **S-17** web-qa live check (inherits backend O-9): the downloaded file opens in
  Excel with Cyrillic category names intact (the BOM), and the browser download
  path works in Chrome + Safari.

---

# Obligations carried into /implement reports (summary)

| # | Obligation | Owner |
|---|---|---|
| S-1 | `period` + exactly one matching anchor on every stats request | W1 |
| S-2 | zero client-side aggregation / period math / conversion | W1, W2 |
| S-3 | every money decode uses its own response's `currency` (AM-5) | W1, W2 |
| S-4 | `['stats']` invalidated by all three tx mutations | W1 |
| S-5 | series rendered verbatim; `domain={['auto','auto']}` (F4(b)) | W2 |
| S-6 | per-point `unconverted_count` surfaced per point | W2 |
| S-7 | the current partial month is labelled partial | W2 |
| S-8 | goals section adds no new endpoint/query (D4) | W2 |
| S-9 | "AI недоступен — ключ не настроен" byte-exact (BINDING) | W3 |
| S-10 | the "Спросить AI" button ships unconditionally | W3 |
| S-11 | advisor auth via the coordinator seam only | W3 |
| S-12 | hand-written api-client files import generated **types** only; drift test green | W3 |
| S-13 | no new runtime dependency anywhere in this scope | W1–W4 |
| S-14 | `pnpm -r typecheck` green (frozen mobile) | W3 |
| S-15 | CSV via the api-client, header auth, no token-in-query | W4 |
| S-16 | current filters passed through; no pagination params | W4 |
| S-17 | live checks: Excel/BOM + download in two browsers; advisor stream with a real key | web-qa |

Standing obligations reaffirmed, unchanged: **T8′** (own-currency decode, no
hardcoded currency), **T9** (explicit invalidation, no cache patching of
server-computed numbers), **T4** (per-field `formatMoney`), **C2/T6** (stable-code
error tables, `*_REQUIRED`-class codes are bug signals), **A4** (no auth/coordinator
change — the AM-7 body-preservation vitest in `packages/api-client` must stay green
and untouched through W3), **R3** (form schemas live in `packages/shared`).

---

# Disagreements with the architecture / backend plan (numbered — none silent)

1. **`/stats/monthly` is not period-scoped, so one screen carries two different time
   scopes.** D4 gives monthly only `months=N` ending at the current month, while
   summary and top-merchants follow the D5 period grammar. Selecting "2024" and
   seeing bars ending in 2026 is a real misreading hazard. I am **shipping the UI
   workaround** (WS-5/W2: a visually separate "Last N months" section with its own
   selector, outside the period card) rather than asking for a contract change,
   because a dynamics chart that stops at the selected period's end is *less*
   useful for the common month view, and the alternative costs backend work for a
   rarely-used combination. **Recorded so the inconsistency is deliberate.** Veto
   cost: add the D5 period params to `/stats/monthly` (backend: one dependency
   reuse + tests; web: delete the selector, one line in the query hook).
2. **The advisor surface is written in Russian while the rest of the app is
   English.** The binding copy is Russian, the entry button is "Спросить AI" in the
   task text, and the model answers in Russian (the backend's `render_prompt` is
   Russian by B2b's design) — so an English shell around a Russian conversation with
   a Russian error line is the least incoherent option available without an
   app-wide localization pass, which is out of scope and unrequested. I am shipping
   the **advisor panel fully in Russian and touching no other screen's copy** (in
   particular `receiptErrorMessage`'s existing English `AI_NOT_CONFIGURED` entry
   stays as-is). Flagged to PM as OQ-2; veto cost is one message table.
3. **D14's `MAX_MINOR_AMOUNT` is deliberately NOT mirrored into the client form
   schemas.** The narrowed server bound (1e15−1) sits below the shared
   `parseMoney` overflow guard (9.0e15), so amounts in that band now 422 with a raw
   Pydantic message routed to the amount field by the shipped `routeIssue`
   machinery. Mirroring the constant into `packages/shared` would buy a slightly
   nicer message for an absurd input, at the cost of touching three form schemas the
   frozen mobile client imports. Recorded trigger to revisit: **anyone actually hits
   it**. (Not a change to D14 — the server bound is right; only its client mirror is
   declined.)

---

# Open questions for senior-lead (recommendation = what ships if unanswered)

1. **Advisor entry point placement.** Recommendation: a dedicated `/advisor` route
   + nav link, with the binding "Спросить AI" button on `/stats` navigating to it.
   The alternative (a modal on the stats screen) loses the transcript on close, adds
   a focus trap around a streaming region, and gives the composer no room. Flipping
   to a modal later is a W3-internal change, no re-grooming.
2. **Language (Disagreement 2).** Recommendation: Russian advisor panel, English
   everywhere else, no app-wide localization in this scope. PM's call; the veto is
   cheap (one table + three labels).
3. **Contract ask CA-1 — `Retry-After` on the advisor 429.** With
   `headers_enabled=False` in `rate_limit.py` the client cannot tell the user
   whether the minute tier or the daily tier fired, so the copy has to stay vague.
   **Recommendation: do NOT ask** — the receipts precedent already ships "wait a
   minute" for `RATE_LIMITED`, and a two-tier limit on a personal app does not
   justify reopening a shipped rate-limit surface.
4. **Contract ask CA-2 — instruct the model to answer in PLAIN TEXT (no markdown)**,
   one line in B2b's `render_prompt`. **Recommendation: grant.** The web renders the
   answer with `pre-wrap` and will not add a markdown dependency without approval,
   so raw `**bold**` and `##` headings would otherwise show up literally. Backend
   cost: one prompt line. If declined, the fallback is unchanged (literal markdown
   on screen), and adding a renderer becomes a separate, approval-gated ask.
5. **Should `/stats` replace the `SummaryHeader` block on `/transactions`?** OQ-1
   was answered "keep both" backend-side, so the shipped month summary stays. I
   recommend leaving the transactions screen **completely untouched apart from the
   W4 export button** — retiring a working surface for tidiness is churn. Confirm
   there is no PM expectation that `/transactions` starts consuming `/stats/summary`.

---

# Mobile carry-forward (4.3 FROZEN — note only)

Nothing in `apps/mobile` changes in this scope, and every shared/api-client edit
above is additive (verified against mobile's actual imports: `categoryFormSchema`,
`loginFormSchema`, `registerFormSchema`, `transactionFormSchema`,
`multiCurrencyTransactionFormSchema`, `currentMonth`/`formatMonthLabel`/`monthBounds`,
`buildCategoryPatch`/`buildTransactionPatch`/`emptyToNull`, `ApiError`/`throwOnError`,
`components`, `ApiClient`/`TokenPair`). At unfreeze, mobile replicates against the
**same contract**: `/stats/*` series render in Victory Native XL exactly as Recharts
renders them here (both consume `points[]`/`by_category[]` verbatim — that is what
"render-ready" buys), the quarter/period helpers added to `packages/shared` are
reusable as-is, `askAdvisor` takes the identical injected-fetch seam that mobile's
own coordinator already exposes, and `advisorAskSchema`/`buildHistory` port
unchanged. **Recorded risk: React Native's fetch does not expose a streaming
response body** — that is exactly D12's trigger for a `?stream=false` collected-JSON
mode, and `TextDecoder` availability under Hermes must be checked then too. CSV
export is web-only (there is no filesystem/download story on mobile in this design).

---

# Risks

- **The SSE parser is the whole advisor.** Every failure mode of a streamed answer
  (truncation, mojibake, a swallowed terminal event) lives in ~60 lines. Mitigated
  by making it pure, transport-agnostic and the only heavily-tested unit in the
  scope — including the byte-split arms, which are exactly the cases a local test
  against one big chunk never reaches.
- **Streaming through the auth coordinator.** `authFetch` clones the request before
  sending and returns the `Response` untouched (verified, `coordinator.ts:160-180`),
  so the body stream survives — but a 401 mid-scope would replay the POST and
  restart the answer from scratch. Acceptable (a 15-minute access token vs a
  ~30-second generation), and worth one web-qa look at an expiring session.
- **Reverse-proxy buffering** (backend Risks, inherited): behind an nginx without
  `proxy_buffering off` / `X-Accel-Buffering: no`, the stream arrives as one lump
  and the UI silently degrades to non-streaming. It will still be *correct*, so QA
  must be told this is a deploy-config symptom, not a web bug.
- **Per-delta `setState`.** Each delta dispatches a reducer action; React 19 batches
  within a task but each `await` is a new task, so a fast model could cause frequent
  re-renders of the transcript. The transcript is a handful of nodes, so this is
  cheap — but if profiling ever shows jank, the fix is to buffer deltas in a ref and
  flush on `requestAnimationFrame`. Recorded, not built.
- **`parseAs: 'blob'` typing** depends on the generated `text/csv` 200 resolving
  through openapi-fetch's `MediaType` inference. Verified feasible against 0.17.0's
  types, but if the generated 200 carries a stray `application/json` arm (backend
  O-8's STOP condition) the web types go wrong too — W4 must report the mismatch,
  never cast around it.
- **Period-picker × cache growth.** Every distinct period is its own cache entry;
  a user stepping through 24 months leaves 24 summary entries. Bounded by the
  default `gcTime` and trivially small — noted only so it is not "discovered" later.
- **Two screens now depend on `useCategories()` for names.** A category cache miss
  degrades stats rows to "Unknown category" exactly as the shipped summary does
  (`SummaryHeader.tsx:97`) — consistent, and deliberately not re-solved here.
