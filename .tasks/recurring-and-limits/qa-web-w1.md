# QA Web Checklist: W1 — network-unreachable surfacing (P1) + ru terminator (P3)

Scope: `recurring-and-limits` / subtask **W1**. Executed 2026-08-18 against the
uncommitted working tree.

## Environment

| item | value |
|---|---|
| API | own uvicorn on **127.0.0.1:8011** (`FX_SCHEDULER_ENABLED=false`, `RECURRING_SCHEDULER_ENABLED=false`, `RATE_LIMIT_ENABLED=false`) |
| DB | Postgres :5443, **own database `budget_qa_w1`** (created + `alembic upgrade head` → 0006, dropped at the end) — the shared `budget` DB was NOT touched |
| Web | `pnpm dev` on :5173 via the `web` launch config, pointed at 8011 through a gitignored `apps/web/.env.local` (removed at the end; `apps/web/.env` untouched) |
| User | fresh throwaway `qa-w1-20260818@example.com`, registered through the UI |
| Browser locale | **ru-RU** (`navigator.language`) — money `0,00 ₽`, months `август 2026 г.` |
| Port 8010 | never contacted, never signalled; confirmed still held by the other run (pid 74978) at start and end |

Deviations from the brief, recorded:
- `RATE_LIMIT_ENABLED=false` so repeated register/login during the run could not
  trip the 5/hour register limit. Not on any tested surface.
- The email domain `.test` is rejected by the server's email validator
  (`422 value_error`, pre-existing, unrelated to W1) → used `example.com`.
- Own database instead of the shared `budget` one, to guarantee zero interference
  with the 8010 run.

## Test cases

### TC-1 (J1a): /stats with the API killed — hard reload
- **Steps**: logged in, /stats working → `kill` uvicorn → hard reload `/stats` → wait 4 s.
- **Expected**: `role="alert"` + Retry within ~4 s on every section; no eternal skeleton.
- **Observed** (accessibility tree, `read_page`):
  - `alert "Can't reach the server. Check your connection and try again."` + `button "Retry"` (summary)
  - `alert "Couldn't load top merchants."` + Retry
  - `alert "Couldn't load the monthly chart."` + Retry
  - `alert "Couldn't load your goals."` + Retry
  - zero skeletons remaining.
- **Status**: ✅ PASS

### TC-2 (J1b): /goals with the API killed — hard reload
- **Observed**: `alert "Couldn't load your goals."` + Retry within 4 s; header, nav
  and the "New goal" button still usable.
- **Status**: ✅ PASS

### TC-3 (J1c): header me-affordance on a cold load with the API down
- **Expected**: an alert instead of the eternal email skeleton.
- **Observed**: on every screen loaded during the outage the banner rendered
  `alert "Couldn't load your account."` + `button "Retry"`; no
  `emailSkeleton` element present.
- **Status**: ✅ PASS

### TC-4 (J1d): Retry recovers the screen without a page reload
- **/categories**: outage alert → API restarted → click Retry → full category list
  rendered, no reload. ✅
- **header me**: click the header Retry → `generic "qa-w1-20260818@example.com"`
  replaces the alert. ✅
- **/stats**: outage alert → API restarted → click the summary Retry → all four
  sections (summary + breakdown, top merchants, 12-month chart, goals) rendered
  data, no reload. ✅
- **/goals**: same cycle → goals screen with its surplus copy and empty state. ✅
- **Note (not a defect)**: immediately after the /stats Retry, all four sections
  briefly showed the `unreachable` copy ("Can't reach the server…") before
  resolving to data — i.e. the retryer paused between attempts while the pane was
  unfocused, which is the documented `canContinue()` behaviour left alone by
  WR-10. It is surfaced as an actionable alert, not a stuck skeleton, and it
  self-resolved.
- **Status**: ✅ PASS

### TC-5 (J1e): /transactions and /categories under the same outage (extra adopters)
- **Observed**: `/transactions` → "Couldn't load this month's summary." +
  `alert "Couldn't load transactions."` + Retry. `/categories` →
  `alert "Couldn't load your categories."` + Retry. No skeletons.
- **Status**: ✅ PASS

### TC-6 (J2): the paused ('unreachable') arm
- **Deliberate induction**: ❌ NOT-RUNNABLE — the browser pane exposes no DevTools
  network-condition control and no JS evaluation, so an `offline` window event
  cannot be dispatched. Mechanism stays pinned by `queryPhase.test.ts` and the
  node-level repro.
- **Incidental live observation**: ✅ — during TC-4 the /stats sections rendered
  `"Can't reach the server. Check your connection and try again."` while
  `TopMerchants`/`MonthlyChart`/`GoalsProgressSection` pass a *fixed* message
  (`"Couldn't load top merchants."` etc.); that sentence can only be produced by
  `phase === 'unreachable'`. So the paused arm was seen live rendering
  `role="alert"` + Retry — never a stuck skeleton — and then resolved to data.
- **"request still attempted while the browser believes it is offline"**: not
  verifiable here (same tooling limit).
- **Status**: ⏸ PARTIAL — the arm's *rendering* is PASS by live observation; the
  forced-offline induction is NOT-RUNNABLE.

### TC-7 (J3): P3 single-terminator empty-state copy
- **/transactions, empty month (ru)**: `No transactions in август 2026 г. Add your
  first one.` — the Intl label already ends in `.`, `sentenceEnd` added nothing;
  **exactly one dot**, no `г..`. ✅
- **/stats, empty period (ru, июль 2026)**: `No transactions in июль 2026 г.` —
  one terminator. ✅
- **en-locale arm**: ❌ NOT-RUNNABLE — the pane's `navigator.language` is ru-RU and
  the tooling cannot override the Intl locale. Unit-pinned in
  `packages/shared/src/dates.test.ts` (`"June 2026"` → `"June 2026."`).
- **Status**: ✅ PASS (the ru case — the actual D4 defect — is verified live)

### TC-8 (J4a): /transactions mutation round-trip under `networkMode:'always'`
- **Steps**: Add transaction → 12.50 RUB, category "Кафе и рестораны" → Save;
  then open the row → Delete → confirm.
- **Observed**: `POST /transactions → 201`, row appears and summary flips to
  `EXPENSE 12,50 ₽ / NET -12,50 ₽` with no reload; `DELETE` → row gone, summary
  back to `0,00 ₽`, empty state re-rendered. Cache invalidation intact.
- **Money/date rendering**: `12,50 ₽`, `-12,50 ₽`, `18 авг. 2026 г.` — no float
  artefacts, correct symbol.
- **Status**: ✅ PASS

### TC-9 (J4b): shipped-screen sweep with the API up
- `/transactions` list + summary ✅ · `/categories` 18 system categories ✅ ·
  `/goals` empty state + surplus copy ✅ · `/stats` summary, by-category, top
  merchants, 12-month chart, goals section ✅ · `/advisor` renders its intro/no-key
  state, does not hang ✅.
- **Period step** (август → июль → август): numbers stayed rendered, no skeleton
  flash; `isPlaceholderData` keeps `queryPhase` at `'ready'` as designed.
- **Status**: ✅ PASS

### TC-10 (J4c): console + network hygiene
- **Console**: zero app-thrown errors across the whole run. The only entries are
  browser resource errors: pre-login `401`s from a stale localStorage token, the
  one `422` from the `.test` email typo, and `ERR_CONNECTION_REFUSED` during the
  deliberate outages. No React warnings, no render-loop noise.
- **Network**: one request per query per screen; no duplicate storms; retry budget
  behaved (error within ~3–4 s). Post-outage a `401 → POST /auth/refresh 200` pair
  fired and the screen recovered — the coordinator path is healthy and untouched.
- **Status**: ✅ PASS

### TC-11: refresh / deep-link
- F5 / direct navigation to `/transactions`, `/stats`, `/goals`, `/categories`
  restores the session and the screen every time (used as the vehicle for TC-1/2/5).
- **Status**: ✅ PASS

## Summary

| | |
|---|---|
| Total | 11 |
| Passed | 10 (TC-1..5, TC-7..11) |
| Failed | 0 |
| Partial / not-runnable | TC-6 (forced-offline induction — no DevTools network conditions, no JS eval in the browser pane); TC-7's en-locale arm (pane locale is ru-RU) |

**✅ READY FOR REVIEW.** The P1 defect (eternal skeleton on /stats and /goals with
the API unreachable) does not reproduce: every adopted screen and the header
me-affordance surface a `role="alert"` + Retry within ~4 s, and Retry recovers the
screen in place. The P3 ru double terminator does not reproduce either — verified
live in the ru locale on both call sites. No regression found in the shipped
screens under the new app-wide `networkMode:'always'`.

No coordinator behaviour was exercised beyond the normal `401 → refresh → retry`
path, which worked; `apps/web/src/auth/**` is untouched by this diff, so the P1
escalation clause is **not fired**.
