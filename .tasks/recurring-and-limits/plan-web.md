# Implementation Plan (web): recurring-and-limits (roadmap 5.3 templates UI / 5.4 limits UI + polish P1–P3)

Frontend-engineer scope-grooming output. **Nothing is implemented in this run.**

**Binding inputs:** `.tasks/recurring-and-limits/task.md`; `architecture.md`
(D3 grammar + the day-clamp, D4 end conditions, D10 CRUD surface +
`RecurringTemplateRead` + `next_due_on` server-computed, D12 edits-affect-future,
D15 limit currency stamped + mismatch state, D16 `GET /limits?month=` shape,
D17 PUT upsert, D18 over-limit is a CLIENT visual state, D22 web boundaries);
`plan.md` (B1a → B1b → B2 → B3, the exact DTOs, error codes, and §Disagreement 5's
two anchor codes, §Risks "weekday convention across the wire");
**senior-lead rulings** — SL-C (template DELETE removes attribution; no persistent
"deleted template" state; id-with-no-match is a transient cache-staleness window →
name-less badge, no special copy) and the three polish fold-ins P1/P2/P3 with P1's
escalation clause; `.tasks/web-transactions-ui/obligations.md` (T7, T8′, T9, AM-5,
A4); `.tasks/stats-advisor/plan-web.md` (format precedent).

Every code claim below was verified against the working tree (files cited inline).
**Mobile is FROZEN** — nothing under `apps/mobile`; carry-forward section at the end.

**Order and backend gating:**

| web subtask | needs the regen commit of | what it consumes |
|---|---|---|
| **W1** query-layer network surfacing (P1) + ru terminator (P3) | — (no backend dep) | nothing new on the wire |
| **W2** `/recurring` screen + shared modal discard guard (P2) | **B2** | `/recurring` CRUD, `RecurringTemplateRead`, `RecurringError` |
| **W3** tx-list recurring badge | **B2** (same regen as W2) | `TransactionRead.recurring_template_id` |
| **W4** limits on `/categories` | **B3** | `GET /limits`, `PUT/DELETE /limits/{category_id}`, `LimitError` |
| **W5** budgets section on `/stats` (month unit only) | **B3**, after W4 | same endpoints, W4's components |

Strictly sequential (single engineer). W3 is after W2 because it reads W2's
`['recurring','list']` cache; W5 is after W4 because it reuses W4's components.
W1 has no backend dependency and ships first — it is the only subtask that touches
files every later subtask also touches (`lib/query.ts`, the screens' state
branches), so running it first avoids re-editing the same branches twice.

**Tier: all five STANDARD** (implement + `/review-pr` self-review → senior diff gate
→ web-qa). No new auth surface; **no client-side money math** — every aggregated,
converted or date-computed number is a server response field (`spent_minor`,
`limit_minor`, `next_due_on`). Escalation clauses:

- **W1 (senior-lead's clause, restated):** if the reproduction shows the stall
  originates in the auth coordinator's token-refresh path, **STOP and flag to
  senior-lead**. `apps/web/src/auth/coordinator.ts` is not edited by this scope and
  `apps/web/src/auth/coordinator.test.ts` (the A4/AM-7 body-preservation vitest)
  stays **green and unmodified**.
- **W2:** if wiring the shared dirty-guard into `TransactionFormModal`'s
  receipt-confirm mode requires behavioural changes in `useReceiptFlow`, stop and
  ask senior-lead (that is a shipped multi-step flow, not a form).
- **W4:** if the limits slot cannot be added to `CategoryRow` without turning the
  categories screen into a period screen (a month stepper, URL params), stop —
  that is OQ-W3 escalating and it changes the screen's nature.

**Gates, every subtask:** `pnpm --filter @budget/web lint`, `typecheck`, `test`;
plus `pnpm --filter @budget/api-client typecheck` + `test` and `pnpm -r typecheck`
(the frozen-mobile guard) for any subtask touching `packages/api-client` or
`packages/shared` (W1, W2, W4 all do). **G1 is inverted this scope, as at 3.2/4.x:**
`schema.d.ts` is EXPECTED to change — each W builds against the exact regen commit
its backend dependency produced, and **no W subtask ever runs `pnpm openapi`, edits
`schema.d.ts`, or casts around a contract mismatch**. A mismatch is a
STOP-and-report to senior-lead.

**Test environment constraint (verified: `apps/web/vite.config.ts` →
`test: { environment: 'node' }`, and `apps/web/package.json` has NO
`@testing-library/*`):** there is no DOM in the web test setup. Every vitest case
below is therefore a **pure-module** test, and components are designed so the
decidable part (status derivation, badge resolution, over-limit, the discard
predicate, the patch builder) lives in a pure function that JSX only renders. That
is not a workaround — it is the shipped discipline (`rowDisplay.ts`, `period.ts`,
`realism.ts`, `patch.ts`).

---

# Shared web design decisions (WR-n)

## WR-1. Routes and navigation

- **New route `/recurring`** inside `ProtectedLayout` (`apps/web/src/App.tsx`), nav
  link **"Recurring"** in `routes/ProtectedLayout.tsx`, placed after "Categories"
  (both are setup/management screens): Transactions · Stats · AI · Categories ·
  Recurring · Goals.
  **Why a top-level route and not a section of `/categories` or a modal off
  `/transactions`:** D10 makes the list the management screen (it includes paused
  and ended templates), it owns full CRUD over its own resource, and D9 makes it
  the *honesty mechanism* for silent auto-materialization — the one screen that
  answers "where did this money row come from". Burying that inside another screen
  contradicts the reason the attribution exists. (OQ-W2 if PM disagrees.)
- **Limits get NO route.** Write + primary read live on **`/categories`** (that is
  where a category is managed and where "budget for this category" is a natural
  thought), and `/stats` gets a **read-only** budgets section **gated to the
  `month` period unit** (WR-6 / Disagreement 1). No URL params are added by this
  scope; `/categories` shows the **current month only** (OQ-W3).

## WR-2. Query keys + invalidation matrix (T9 discipline, extended)

`apps/web/src/data/queryKeys.ts` — two NEW top-level families, disjoint from
`['transactions', …]`, `['categories', …]`, `['stats', …]`, `['goals', …]`, so no
shipped invalidation predicate touches them (the predicate in `data/transactions.ts`
keys on `queryKey[0] === 'transactions'`):

```ts
recurringList: () => ['recurring', 'list'] as const,
limits:  (month: string) => ['limits', { month }] as const,
```

`recurringList` carries no parameters: `GET /recurring` takes none (D10 — all
templates, no pagination, no filters). The `'list'` segment is the same key[1]
disambiguation the goals family uses, so a future per-template sub-family
(`['recurring', id, …]`) cannot collide.

**Invalidation matrix additions** (the existing rows are unchanged):

| mutation | invalidates | why |
|---|---|---|
| template POST / PATCH | `['recurring']` | list is the only reader; a rename re-resolves badge names straight from this cache — no tx refetch (that IS the 1.6 name-cache point) |
| template **DELETE** | `['recurring']` **+ tx LISTS** (`key[0]==='transactions' && key[1] !== 'summary'`) | SL-C: the server SET NULLs `recurring_template_id` on historic rows. Money did not change → **no** summary, **no** `['stats']`, **no** `['limits']` invalidation. Without the list invalidation the cached rows keep a dangling id and render a name-less badge until the next natural refetch — allowed (SL-C) but avoidable in the one window we control |
| tx create / update / delete | **+ `['limits']`** (blanket prefix) added to the existing three | `spent_minor` moves. Blanket, not per-month: an `occurred_at` edit can cross a month boundary and deciding *which* cached months moved client-side would re-implement the server's window logic — verbatim the argument already written for `['stats']` in `data/transactions.ts` |
| limit PUT / DELETE | `['limits']` | nothing else reads limit rows |
| category POST / PATCH | unchanged (cache patch by id) | limits reference categories by id; the join is reactive off the categories cache |

**Not invalidated, deliberately:** nothing invalidates on *materialization* — rows
appear from the scheduler with no client event. No polling and no
`refetchInterval` is added (a personal app, one job a day at 00:30 UTC); the next
natural refetch shows them. Recorded so it is not read as an oversight.

## WR-3. AM-5 / T8′ decode discipline — every money site this scope adds

| value | decodes/formats with | never |
|---|---|---|
| `RecurringTemplateRead.amount_minor` | `template.currency` | the profile base |
| template form `amount` input | the currency **selected in the form** (object-level schema, the goal-form precedent) | a factory-bound base |
| `LimitItem.limit_minor` | `LimitItem.limit_currency` (the **stored stamp**, D15) | `LimitsRead.currency` |
| `LimitItem.spent_minor` | `LimitsRead.currency` (current base) | `limit_currency` |
| limit form `amount` input | `LimitsRead.currency` (the base it will be stamped with) | the previous stamp |

**No `?? fallback` at any decode site** (AM-5, binding). The mismatch case
(`limit_currency !== currency`) is exactly where a fallback would be tempting and is
exactly where it would lie: the two numbers are then in different currencies, each
renders with its own, and **nothing is compared** (WR-5).

## WR-4. Periodicity: form ↔ `interval_unit` / `day_of_month` / `weekday`

Form shape (one radio + one dependent control), mirroring the DB CHECK so the
server's `ANCHOR_REQUIRED` / `ANCHOR_MISMATCH` are unreachable from the UI:

```
( ) Monthly   on day [1..31 ▾]     -> interval_unit: 'month', day_of_month: N, weekday: null
( ) Weekly    on     [Mon..Sun ▾]  -> interval_unit: 'week',  weekday: W,      day_of_month: null
```

- **Weekday encoding is ISO 0 = Monday** (D3, `date.weekday()`), which is NOT
  JavaScript's `Date.getDay()` (0 = Sunday). The backend plan flags this as a scope
  risk. Mitigation: the labels come from one pure, tested helper
  `weekdayLabels(locale)` returning index 0..6 = Mon..Sun, built by formatting a
  known reference week with `Intl.DateTimeFormat(locale, { weekday: 'long' })`.
  **`Date.getDay()` never appears in this scope** (grep is the diff-gate check).
- **Day-31 copy, not client math:** the monthly control shows a static note —
  "Months shorter than this use their last day (31 → Feb 28)". The clamp is D3's
  server rule; the client states it and never computes it.
- **`next_due_on` is rendered verbatim** (D10/D22). There is no client-side due-date
  math anywhere in this scope — not for "ended", not for "next", not for the
  paused label (WR-5).
- Client-side validation mirrors the server 422s exactly: `name` 1..100 trimmed;
  `amount_minor` ge 1 / le `MAX_MINOR_AMOUNT`; `kind` required (defaulted from the
  picked category, the 1.2 sign-authority direction — category → kind only);
  anchor matches unit; `end_date` optional `YYYY-MM-DD`. An `end_date` **in the
  past is accepted** (D4 allows it; the server does not reject it) and gets an
  inline note "This end date has passed — nothing will be created" instead of a
  block: the honest report of what the server will do, not a rule the server has.

## WR-5. Derived states are derived from SERVER fields, never recomputed

Two pure modules carry every "state" this scope shows:

```ts
// features/recurring/templateStatus.ts
export type TemplateStatus =
  | { status: 'paused' }
  | { status: 'ended';  endDate: string | null }
  | { status: 'active'; nextDueOn: string };

export function templateStatus(t: RecurringTemplateRead): TemplateStatus;
```

`paused` wins first (server returns `next_due_on: null` when paused OR ended, so
the flag is the only disambiguator); then `next_due_on === null` ⇒ `ended` (its
`end_date` is shown for information, **not** compared to today); else `active`.
Nothing here parses or compares dates.

```ts
// features/limits/limitProgress.ts
export type LimitProgress =
  | { status: 'mismatch'; limitMinor: number; limitCurrency: string; spentMinor: number; currency: string }
  | { status: 'under' | 'over'; ratio: number; remainingMinor: number; /* + the pair */ };

export function limitProgress(item: LimitItem, currency: string): LimitProgress;
```

- **Comparison gate:** if `item.limit_currency !== currency` → `mismatch`, and the
  function returns **no ratio and no over/under** — the render then shows both
  amounts, each in its own currency, plus the D15 "update the budget" affordance.
  A comparison across currencies is the silent guess stage 3 forbids.
- **Over-limit is strict `spent_minor > limit_minor`.** `spent === limit` is
  **not** over ("you have spent exactly your budget" is not an overrun). Pinned by
  a boundary test.
- `ratio` is presentation geometry clamped to `[0,1]` for a CSS width (the shipped
  `GoalCard` precedent: "presentation geometry, NOT money math"); the *numbers* are
  always the server's minor units through `formatMoney`. `remainingMinor` is one
  subtraction of two same-currency server values — D18 explicitly sanctions it.

## WR-6. Where limits are shown (and where they are not)

- `/categories` — per **expense**, non-archived category row: the limit slot
  (bar + "spent X of Y" + actions). Affordances are gated client-side on
  `kind === 'expense'` and `archived === false` (obligation C4: the server 422
  `CATEGORY_NOT_EXPENSE` / `CATEGORY_ARCHIVED` is a backstop, not the primary UX).
  A limit that already exists on a since-archived category **is still rendered**
  (D14/D15 return it) with its Remove action available and Set/Edit hidden.
- `/stats` — a read-only "Budgets" section that renders **only when the selected
  period unit is `month`**, using the selected month; for quarter/year/custom it
  renders one explanatory line and a link to `/categories`. Rationale in
  Disagreement 1.
- `unconverted_count` is **period-level** (D16) → one `UnconvertedNotice` above the
  budgets group, scope "these spent amounts". Never per row: a per-bar honesty flag
  would imply per-category counts the API deliberately does not return.

## WR-7. Error helpers (`apps/web/src/lib/errors.ts`) — one table per resource

Two new helpers, following the shipped pattern (a resource gets its own table when
its field set and failure modes are disjoint):

```ts
describeRecurringError(error): FieldError<'name'|'amount_minor'|'category_id'|'end_date'|'day_of_month'|'weekday'|'merchant'|'note'>
describeLimitError(error): FieldError<'amount_minor'>
```

- `RECURRING_TEMPLATE_NOT_FOUND` (404) → form-level "This template no longer
  exists. Refresh and try again." + the mutation's `onError` refetches the list
  (the T6/T9 precedent).
- `CATEGORY_NOT_FOUND` / `CATEGORY_ARCHIVED` (422) → `category_id` field.
- `NAME_REQUIRED`, `AMOUNT_REQUIRED`, `KIND_REQUIRED`, `CURRENCY_REQUIRED`,
  `INTERVAL_UNIT_REQUIRED`, `PAUSED_REQUIRED`, **`ANCHOR_REQUIRED`,
  `ANCHOR_MISMATCH`** → the **bug-signal family** (generic message, form level):
  the shared schema mirrors the CHECK and the patch builder never emits the
  non-matching anchor, so reaching any of them means the client is broken, not the
  user (T6 discipline; Disagreement 3).
- Limits: `CATEGORY_NOT_FOUND` (404 here — the category is the addressed resource)
  and `CATEGORY_ARCHIVED` / `CATEGORY_NOT_EXPENSE` (422) → form-level messages that
  name the cause ("Budgets are only for expense categories"), because the limit
  dialog has no category field to route to (the category is the path). `LIMIT_NOT_FOUND`
  (404 on DELETE) → "This budget is already gone." + list invalidation.
- Both helpers end with the shipped `getValidationIssues` + `routeIssue` arm and the
  `NETWORK_MESSAGE` / `GENERIC_MESSAGE` constants — no new copy constants.

## WR-8. Shared zod schemas live in `packages/shared` (house rule)

Additive to `packages/shared/src/schemas.ts` (+ the barrel), so the frozen mobile
client keeps compiling and reuses them at unfreeze:

```ts
export function recurringTemplateFormSchema(): ...   // object-level transform
export function categoryLimitFormSchema(currency: string): ...  // factory: fixed currency
export type RecurringTemplateFormInput / …FormValues
export type CategoryLimitFormInput / …FormValues
```

`recurringTemplateFormSchema` is object-level (not a per-field factory) for the
goal-form reason: `currency` is a **form field**, so `amount` can only be parsed
against the currency selected right now. It emits the output shape the patch
builder and the create call consume:
`{ name, amount_minor, kind, currency, category_id: string, merchant: string, note: string, interval_unit, day_of_month: number|null, weekday: number|null, end_date: string|null }`
— string fields keep the RHF `""` sentinel; the `""`→`null` bridge stays downstream
in `emptyToNull` / the patch builder, exactly as for note/deadline (T7).
`paused` is deliberately **not** a form field (WR-9).

## WR-9. Patch-builder extension (T7, one builder, in `packages/api-client/src/patch.ts`)

```ts
export function buildRecurringTemplatePatch(
  values: RecurringTemplateFormValues,
  initial: RecurringTemplateFormValues,
): RecurringTemplateUpdate;
```

- **Never-null** (changed → emit, unchanged → omit, never `null`):
  `name`, `amount_minor`, `kind`, `currency`, `interval_unit`.
- **Clearable trichotomy** (unchanged → omit; `""` → explicit `null`; value → value):
  `category_id`, `merchant`, `note`, `end_date`.
- **The anchor pair is NOT a naive field diff.** Rule: emit **only the anchor that
  matches the effective (post-patch) unit**, and emit it when it changed **or when
  the unit changed** (the server requires the new unit's anchor — `ANCHOR_REQUIRED`).
  The non-matching anchor key is **never emitted at all** — not a value (that is
  `ANCHOR_MISMATCH`) and not an explicit `null` (pointless: the server clears a
  merely-stored stale anchor itself, plan §B2). This is the `eff_cur` rule from the
  transaction builder, applied to a pair.
- `paused` is **not** in this builder: pause/resume is a row-level action with its
  own one-field PATCH behind its own affordance — the goals `archived` precedent
  ("not something the edit form can change behind a Save button").
- Limits need **no** builder: `PUT` is a full upsert with a one-field body.

## WR-10. P1 — network-unreachable surfacing (diagnosis + fix)

**Symptom (qa-web stats-advisor D1):** with uvicorn killed, `/stats` and the
shipped `/goals` sit on skeletons indefinitely — no `role="alert"`, no Retry, after
~45 s; "the queries never leave `pending`". App-wide, pre-existing.

**In-source diagnosis (what was verified, and what is hypothesis):**

*Verified — the coordinator does NOT swallow the failure.*
`auth/coordinator.ts:authFetch` does `let response = await doFetch(input)` with no
try/catch, so a `TypeError` from a refused connection propagates; `openapi-fetch@0.17`
(`dist/index.mjs:123-154`) re-throws it after middleware; `throwOnError`
(`packages/api-client/src/errors.ts`) never sees a result object at all. **Nothing on
the auth path converts a network failure into a hang.** The refresh path cannot be
implicated either: `runRefresh` rejects if `authRefresh` rejects and `inFlight` is
cleared in a `finally`. → The senior-lead's escalation clause is **not** expected to
fire; if the live repro contradicts this, W1 stops and reports.

*The mechanism that produces "pending forever" (query-core 5.101.4, read in
`node_modules/.../retryer.js`):* a query sits in `status: 'pending'` with
`fetchStatus: 'paused'` whenever
`canStart() = canFetch(networkMode) && canRun()` is false at start, or
`canContinue() = focusManager.isFocused() && (networkMode === 'always' || onlineManager.isOnline()) && canRun()`
is false between retries. With the app's defaults (`networkMode` unset ⇒ `'online'`),
that happens whenever `onlineManager.isOnline()` is false (any `offline` window
event — DevTools throttling, a VPN/interface flap, a sleeping laptop) **or** the tab
is hidden between retries. **And the app has no UI for it at all:** every screen
branches `isPending ? skeleton : isError ? alert : …` (verified in `StatsPage.tsx:97`,
`GoalsPage.tsx:43`, `CategoriesPage.tsx:39`, `TransactionList.tsx:41`), and a paused
query is `isPending === true` forever. That is a real, unconditional gap regardless
of which trigger QA hit, and it is the D1 symptom exactly.

*What is NOT yet explained from source alone:* with `onlineManager` online and the
tab focused, the shipped retry policy (`lib/query.ts`: `failureCount < 2`, default
exponential delay 1 s + 2 s) should surface an error in ≈3 s. So either the online
manager was false in QA's session (most likely: `#online` flips on a single
`offline` event and never flips back until an `online` event) or the tab lost
visibility between retries. **W1 therefore begins with a bounded, instrumented
reproduction** (kill the API, log `status` / `fetchStatus` / `failureCount` /
`onlineManager.isOnline()` / `document.visibilityState` from a temporary
`queryClient.getQueryCache().subscribe`), and the finding is written into the
subtask report. The fix below covers the mechanism either way.

**Fix (three parts, all in the shared query/UI layer — no coordinator edit):**

1. `apps/web/src/lib/query.ts` — `networkMode: 'always'` on the query **and**
   mutation defaults. Argued: `navigator.onLine` is evidence about the *browser's
   network interface*, not about *our* API (which is a localhost/LAN host in dev
   and one origin in prod). Treating it as a gate produces the worst possible
   outcome — a silent, permanent, unexplained "loading". With `'always'` the fetch
   is attempted, fails, retries within the existing bounded budget and lands in
   `error`, where every screen already has an alert + Retry, and the mutation forms
   already render `NETWORK_MESSAGE` from the shipped helpers. The retry budget is
   **unchanged** (`failureCount < 2`, ≈3 s to error). Note `canContinue()` still
   requires focus, so a background tab pauses retries and resumes on return — that
   is correct behaviour and is left alone.
2. `apps/web/src/lib/queryPhase.ts` (NEW, pure) — the discriminated union every
   screen branches on, so "paused" can never again be invisible:
   ```ts
   export type QueryPhase = 'loading' | 'unreachable' | 'error' | 'ready';
   export function queryPhase(q: { status; fetchStatus; isPlaceholderData? }): QueryPhase;
   ```
   `pending + paused` → `'unreachable'`; `pending + fetching|idle` → `'loading'`;
   `error` → `'error'`; `success` → `'ready'` (also when `isPlaceholderData`, so a
   period step keeps dimming instead of flashing skeletons — the shipped behaviour).
3. `apps/web/src/components/QueryStateNotice.tsx` (NEW) — one `role="alert"` block
   with a message and a Retry button, used for both `'error'` and `'unreachable'`
   (the copy differs: unreachable says the app cannot reach the server and the
   Retry will try again). The five shipped screens adopt it in place of their
   open-coded error paragraphs. **Copy and markup are the shipped ones** (the
   existing alerts already say "Couldn't load…" + Retry) — this is consolidation
   plus the missing third arm, not a redesign.

**A4:** `auth/coordinator.ts` and `auth/coordinator.test.ts` are untouched by every
subtask in this plan; the report states it and pastes the suite result.

## WR-11. P2 — dirty-form discard confirmation, at the shared modal layer

`apps/web/src/components/Modal.tsx` gains one optional prop:

```ts
isDirty?: boolean;   // default false
```

`Modal` owns an internal `confirmingDiscard` state. All three close channels (Esc,
backdrop mousedown, the × button) route through one `requestClose()`:

```ts
// apps/web/src/lib/discardGuard.ts (pure)
export function shouldConfirmDiscard(isDirty: boolean, closeDisabled: boolean): boolean;
// dirty && !closeDisabled -> true ; otherwise false
```

A clean form closes immediately (unchanged behaviour for every shipped modal that
does not pass `isDirty`). When confirming, the dialog renders a **discard panel in
place of the body inside the SAME dialog** — not a nested `ConfirmDialog`. Reason:
`ConfirmDialog` renders its own `Modal`, and two live modals means two document-level
Esc handlers and two focus traps fighting; more importantly the form must stay
**mounted** (unmounting loses every typed value, which is the opposite of a discard
*guard*). Implementation detail for the diff: the children stay mounted behind
`hidden`, and the focus-trap's focusable collection filters out invisible nodes
(`el.checkVisibility?.() ?? el.offsetParent !== null`) so Tab cannot walk into the
hidden form.

Adopters in W2: the new template modal, plus the four shipped form modals
(`CategoryFormModal`, `TransactionFormModal`, `GoalFormModal`, `ContributionModal`)
each pass RHF's `formState.isDirty`. **Not** adopted: `ConfirmDialog` (no form) and
`ReceiptCaptureModal` (a flow, not a form; its `closeDisabled` already guards the
in-flight upload — escalation clause if that turns out to need flow changes).

## WR-12. P3 — the ru double terminator

`packages/shared/src/dates.ts` + barrel:

```ts
export function sentenceEnd(label: string): string;
// "июнь 2026 г." -> unchanged ; "June 2026" -> "June 2026." ; "" -> ""
```

Appends `.` only when the trimmed label does not already end in `.`, `!`, `?`, `…`.
Home justified: the offending terminator is produced by *this file's* `Intl`
formatters (`formatMonthLabel` yields "июнь 2026 г."), and mobile will hit the same
label the moment it unfreezes.

Call sites fixed: `features/stats/StatsPage.tsx:142` ("No transactions in
{periodLabel(selection)}.") and the shipped `features/transactions/TransactionList.tsx:66`
("No transactions in {monthLabel}. Add your first one.") — qa-web D4 confirms the
same pattern on both.

**Placement note (deviation from the brief's wording, recorded — see Disagreement 5):**
the brief says fold P3 into "whichever subtask touches stats copy"; the only later
subtask that does is W5, which is gated on B3. P3 has no backend dependency and W1
already edits both affected files for the `QueryStateNotice` adoption, so it ships
in W1 instead of waiting for the last subtask.

---

# W1 — network-unreachable surfacing (P1) + ru terminator (P3)   (tier: STANDARD)

**Depends on:** nothing. **Contract-touching:** no.

## Files

New:
- `apps/web/src/lib/queryPhase.ts` + `queryPhase.test.ts`
- `apps/web/src/components/QueryStateNotice.tsx` + `.module.css`

Modified:
- `apps/web/src/lib/query.ts` — `networkMode: 'always'` on `queries` and
  `mutations` defaults, with the WR-10 rationale as a comment. Retry policy
  unchanged.
- `apps/web/src/routes/StatsPage.tsx`, `routes/GoalsPage.tsx`,
  `routes/CategoriesPage.tsx`, `features/transactions/TransactionList.tsx`,
  `features/stats/TopMerchants.tsx`, `MonthlyChart.tsx`, `GoalsProgressSection.tsx`
  — branch on `queryPhase(...)` and render `QueryStateNotice` for
  `'error' | 'unreachable'`. Existing skeleton/empty/success arms unchanged.
- `apps/web/src/routes/ProtectedLayout.tsx` — the A1 me-query affordance gains the
  `'unreachable'` arm (same helper).
- `packages/shared/src/dates.ts` + `src/index.ts` + `dates.test.ts` — `sentenceEnd`.
- `apps/web/src/routes/StatsPage.tsx`, `features/transactions/TransactionList.tsx`
  — P3 call sites.

**Not modified (stated in the report):** `apps/web/src/auth/**`.

## UI states

Every adopted screen: `loading` (existing skeletons, unchanged) · `unreachable`
(NEW — alert + Retry, copy: "Can't reach the server. Check your connection and try
again.", reusing the shipped `NETWORK_MESSAGE` wording) · `error` (existing copy,
now via the shared component) · `empty` (unchanged, minus the double dot) ·
`ready` (unchanged).

## Vitest (non-vacuous, contrast arms)

1. `queryPhase.test.ts` — `pending+paused` → `'unreachable'` **contrasted with**
   `pending+fetching` → `'loading'` (the whole point: two states that both report
   `isPending`); `error+idle` → `'error'`; `success+idle` → `'ready'`;
   `success + isPlaceholderData` → `'ready'` (not `'loading'` — pins that a period
   step keeps the dimmed numbers).
2. `dates.test.ts` additions — `sentenceEnd("июнь 2026 г.")` unchanged (the real
   D4 case) **contrasted with** `sentenceEnd("June 2026")` → `"June 2026."`; `""` →
   `""` (no lone dot); `"Готово?"` unchanged.

## Obligations (W1)

R5 (new), A4 (untouched, evidenced), G2. P1's escalation clause is discharged or
fired in the subtask report, with the instrumented reproduction's numbers.

---

# W2 — `/recurring` screen + shared modal discard guard (P2)   (tier: STANDARD)

**Depends on:** B2's regen commit. **Contract-touching:** consumes only.

## Files

New:
- `apps/web/src/data/recurring.ts` — `useRecurringTemplates`, `useCreateTemplate`,
  `useUpdateTemplate`, `useDeleteTemplate` (WR-2 invalidation).
- `apps/web/src/routes/RecurringPage.tsx` + `.module.css`
- `apps/web/src/features/recurring/TemplateList.tsx`, `TemplateRow.tsx`,
  `TemplateFormModal.tsx` (+ css modules)
- `apps/web/src/features/recurring/templateStatus.ts` + `.test.ts`
- `apps/web/src/features/recurring/periodicity.ts` + `.test.ts`
  (`weekdayLabels(locale)`, `periodicityLabel(template, locale)`)
- `apps/web/src/lib/discardGuard.ts` + `.test.ts`

Modified:
- `apps/web/src/App.tsx`, `routes/ProtectedLayout.tsx` — route + nav link.
- `apps/web/src/data/queryKeys.ts` — `recurringList`.
- `apps/web/src/lib/errors.ts` — `describeRecurringError` (WR-7).
- `packages/shared/src/schemas.ts` + barrel + `schemas.test.ts` —
  `recurringTemplateFormSchema`.
- `packages/api-client/src/patch.ts` + `patch.test.ts` —
  `buildRecurringTemplatePatch`; `src/index.ts` export.
- `apps/web/src/components/Modal.tsx` (+ css) — the `isDirty` guard (WR-11).
- `features/categories/CategoryFormModal.tsx`,
  `features/transactions/TransactionFormModal.tsx`,
  `features/goals/GoalFormModal.tsx`, `features/goals/ContributionModal.tsx`
  — pass `isDirty={formState.isDirty}` (one line each).

## Data layer

`GET /recurring` (no params) at `qk.recurringList()`, `staleTime: 60_000` (the
categories precedent — templates change rarely). `POST` / `PATCH /recurring/{id}` /
`DELETE /recurring/{id}` per WR-2. The DELETE mutation unwraps the 204 by hand (the
shipped `useDeleteTransaction` pattern: `throwOnError` treats `undefined` data as
failure). 404 `onError` → invalidate `['recurring']` so a row deleted elsewhere
disappears behind the message (T6/T9).

**Base currency for the create form:** resolved via the shipped
`useSummary(currentMonth())` in a modal *shell* that renders "Loading account
currency…" / an error line before the form exists — verbatim the
`TransactionFormModal` shell (`TransactionFormModal.tsx:70-115`) and for the same
reason: there is no `/profile` endpoint on the wire (verified — the paths list has
none), a guessed base is the AM-5 sin, and the currency decides which exponent the
amount parses with. Cost: one summary request on this screen, usually a cache hit.
(OQ-W1 is the fork.)

## Screens / components

`RecurringPage`: header ("Recurring") + "New template" button; `TemplateList`
grouped by nothing (flat, server order `created_at, id`), each `TemplateRow`:

- name; amount via `formatMoney(±amount_minor, template.currency)` signed by `kind`
  (the shipped row convention: expense negative/red, income positive/green);
- category name + icon joined from `buildCategoryIndex(useCategories())`
  (archived-inclusive, T3) — `null` → "Uncategorized", id-with-no-match →
  "Unknown category" (the shipped `TransactionRow` strings);
- `periodicityLabel` — "Monthly on day 5" / "Weekly on Monday";
- status from `templateStatus`: **Active** → "Next on {formatApiDate(next_due_on)}";
  **Paused** → badge + "Paused — nothing is created while paused, and skipped dates
  are not backfilled when you resume" (D6 semantics, stated once so the resume
  behaviour is never a surprise); **Ended** → badge + "Ended {formatApiDate(end_date)}"
  when `end_date` is present;
- actions: **Edit** (modal), **Pause/Resume** (one-field PATCH, no confirmation —
  reversible and self-describing), **Delete** (`ConfirmDialog`, destructive).

**Delete copy (SL-C, load-bearing):** "Delete this template? The schedule stops and
the 'Recurring' label is removed from the transactions it already created. Those
transactions and their amounts stay." — it must say the attribution dies and the
money does not, because that is exactly the asymmetry a user cannot guess.

`TemplateFormModal` (create/edit): name, amount + `CurrencySelect`, kind
(radio; defaulted from the picked category by direct assignment — T5), category
select (non-archived, client-filtered from the archived-inclusive cache), merchant,
note, the WR-4 periodicity control, end date (optional). Submit: create → full body;
edit → `buildRecurringTemplatePatch`, skipped entirely when the patch is empty (the
goals precedent).

## UI states

| state | render |
|---|---|
| loading | 3 skeleton rows, fixed height (no jank) |
| unreachable / error | `QueryStateNotice` (W1) |
| empty | "No recurring templates yet." + "Add rent, a salary or a subscription and it will be created automatically on schedule — you'll see it in your transactions with a Recurring label." + primary **New template** button |
| ready | the list (includes paused and ended rows — D10: the list IS the management screen) |
| form pending | submit disabled + "Saving…"; modal × disabled (`closeDisabled`) |
| form error | field-routed via `describeRecurringError`; unroutable → form-level |
| delete pending / error | `ConfirmDialog`'s shipped pending + error arms |

a11y: labelled inputs, the periodicity radio group in a `<fieldset><legend>`, row
actions are real `<button>`s, `ConfirmDialog` focus behaviour unchanged.

## Vitest (non-vacuous, contrast arms)

1. `patch.test.ts` — `buildRecurringTemplatePatch` trichotomies:
   (a) untouched → `{}`;
   (b) unit stays `month`, day changes → `{ day_of_month }` only, **no `weekday`
   key** (`'weekday' in patch === false`, contrasted with (c));
   (c) unit `month → week` with a weekday picked → `{ interval_unit, weekday }` and
   **no `day_of_month` key** — the arm a naive field diff fails by emitting a stale
   `day_of_month`;
   (d) unit unchanged, only `amount_minor` changed → `{ amount_minor }` (proves the
   anchor is not re-emitted on every save);
   (e) clearables: `merchant`/`note`/`end_date`/`category_id` emptied → explicit
   `null`, changed → the value, untouched → absent;
   (f) `name`/`currency`/`kind` never emitted as `null`.
2. `schemas.test.ts` — `recurringTemplateFormSchema`:
   month arm without `day_of_month` → issue at `['day_of_month']`, contrasted with
   the same input **with** it → parses; week arm without `weekday` → issue at
   `['weekday']`; a month template that also carries a stale `weekday` → output
   `weekday: null` (the mirror of the DB CHECK); amount parsed at the **selected**
   currency — `("5000", 'JPY')` → `5000` vs `("50.00", 'RUB')` → `5000` (the 100×
   contrast that catches a base-bound exponent); `end_date: ""` → `null`.
3. `templateStatus.test.ts` — paused **and** `next_due_on === null` → `'paused'`
   (paused wins), contrasted with not-paused + `null` → `'ended'`, and not-paused +
   a date → `'active'` carrying that exact string (pins verbatim rendering).
4. `periodicity.test.ts` — `weekdayLabels('en-US')[0] === 'Monday'` **and**
   `[6] === 'Sunday'`; `weekdayLabels('ru-RU')[0]` starts "понедельник",
   `[6]` "воскресенье". Both ends are asserted so a `getDay()` off-by-one (which
   would still make index 0 *a* weekday) cannot pass.
5. `discardGuard.test.ts` — `(dirty, notPending)` → true; `(clean, notPending)` →
   false; `(dirty, pending)` → false. Three arms, each contradicting a different
   wrong implementation.

## Obligations (W2)

T7 successor (WR-9), T8′ successor (template amount at its own currency), T9
successor (`['recurring']` family + delete → tx lists), C4 (affordance gating), R1,
R2, R6, G1-inverted, G2.

---

# W3 — transaction-list "Recurring" badge   (tier: STANDARD)

**Depends on:** B2's regen (same commit as W2) **and** W2 (reads its cache/hook).

## Files

New: `apps/web/src/features/transactions/recurringBadge.ts` + `.test.ts`

Modified: `features/transactions/TransactionRow.tsx` (+ `TransactionList.module.css`),
`features/transactions/TransactionList.tsx` (passes the index through),
`routes/TransactionsPage.tsx` (mounts `useRecurringTemplates()` and builds the index).

## Data layer

No new query key: the badge reads the **cached `['recurring','list']`** — the 1.6
category name-cache pattern, and D10's stated reason for keeping the name off
`TransactionRead`. `TransactionsPage` mounts `useRecurringTemplates()` (staleTime
60 s) and builds `Map<id, RecurringTemplateRead>` with `useMemo`; the row renders
from the map. One extra small request per visit to `/transactions`, justified: the
alternative is a name that never resolves.

```ts
export type RecurringBadge = { name: string | undefined };
export function recurringBadge(
  tx: TransactionRead, index: Map<string, { name: string }>,
): RecurringBadge | null;
```

`recurring_template_id === null` → `null` (no chip). Non-null and resolvable → chip
+ name. **Non-null and unresolvable → chip with `name: undefined`** — a plain
"Recurring" chip, **no special copy, no "deleted" state** (SL-C: this is only a
transient cache-staleness window, and W2's delete invalidates the tx lists to close
the one window we control). While the recurring query is pending or errored the
index is empty, which lands in exactly the same degraded arm — no per-row spinner,
no layout shift.

## UI states

The chip is a static `<span>` inside the row's details column (the row itself is a
`<button>`; nothing focusable is nested). Loading of the *template names* never
blocks the row. Empty/error/loading of the transaction list are unchanged.

## Vitest

1. `recurringBadge.test.ts` — resolvable id → `{ name: 'Rent' }`; **unresolvable id
   with a non-empty index** → `{ name: undefined }` (the cache-miss degradation, and
   the index is deliberately non-empty so the arm is not accidentally the same as
   the empty-map case); empty index → `{ name: undefined }`; `null` id → `null`.
   The `null`-id and unresolvable arms are the contrast pair that a naive
   `index.get(id!) ?? null` implementation fails.

## Obligations (W3)

R3 (SL-C degradation + delete → tx-list invalidation), T9 successor, G2.

---

# W4 — category limits on `/categories`   (tier: STANDARD)

**Depends on:** B3's regen commit.

## Files

New:
- `apps/web/src/data/limits.ts` — `useLimits(month)`, `useUpsertLimit`,
  `useDeleteLimit`.
- `apps/web/src/features/limits/limitProgress.ts` + `.test.ts`
- `apps/web/src/features/limits/LimitBar.tsx` (+ css) — the shared bar used by W4
  and W5.
- `apps/web/src/features/limits/LimitFormModal.tsx` (+ css)

Modified:
- `apps/web/src/data/queryKeys.ts` — `limits(month)`.
- `apps/web/src/data/transactions.ts` — the three mutations also invalidate
  `['limits']` (WR-2).
- `apps/web/src/lib/errors.ts` — `describeLimitError`.
- `packages/shared/src/schemas.ts` + barrel + test — `categoryLimitFormSchema`.
- `apps/web/src/routes/CategoriesPage.tsx`, `features/categories/CategoryList.tsx`,
  `CategoryRow.tsx` (+ css) — the limit slot.

## Data layer

`GET /limits` with **no `month` param** → the server defaults to the current UTC
month and echoes it; the key is `qk.limits(currentMonth())` so the echoed and
requested months can never drift within a session (and a day rollover produces a
new key rather than a stale entry). `PUT /limits/{category_id}` body
`{ amount_minor }` → 200 `LimitRead`; `DELETE` → 204 (hand-unwrapped). Both
invalidate `['limits']`; the PUT response is **not** written into the cache by hand
— it carries no `spent_minor`, so patching would require inventing one.

## Screens / components

`CategoryRow` gains a fixed-height limit slot (reserved even while the limits query
loads — no jank), rendered only for `kind === 'expense'`:

| case | render |
|---|---|
| no limit, active category | subtle "Set a budget" button |
| no limit, archived category | nothing (a budget on an archived category is not an action we offer; C4 gating mirrors the server's 422) |
| limit, matching currency, `spent <= limit` | `LimitBar` + "{formatMoney(spent, currency)} of {formatMoney(limit, limit_currency)}" + "{remaining} left"; Edit / Remove |
| limit, matching currency, `spent > limit` | the same, in the over state (colour + text "over by {…}"), `role="status"` on the over line — informational, not an alert |
| limit, **currency mismatch** (D15) | **no bar, no comparison**: "Budget: {formatMoney(limit, limit_currency)} · spent {formatMoney(spent, currency)}" + notice "This budget is set in {limit_currency} but your base currency is now {currency}. Update the budget to compare them." + an **Update budget** action (the PUT re-stamps) |
| limit on an archived category | rendered read-only with **Remove** available, Edit hidden |

Section header above the groups: "Budgets for {formatMonthLabel(currentMonth())}"
and, when `unconverted_count > 0`, the shipped `UnconvertedNotice` with
`scope="these spent amounts"`.

`LimitFormModal`: one amount field, currency shown as **read-only text** (the base
from `LimitsRead.currency`) with the line "Budgets are set in your base currency."
— D15 makes the stamp a server decision, so offering a picker would promise a
choice the API does not have. Remove goes through `ConfirmDialog` ("Remove this
budget? Your transactions are not affected.").

## UI states

loading (limits query pending → the slot renders a fixed-height placeholder, the
category rows themselves are already there) · unreachable/error (**one**
section-level `QueryStateNotice` above the groups + Retry, never per row) · empty
(no limits at all → the group header carries a one-line "No budgets yet — set one
on any expense category to track how much of it you've used this month.") · ready ·
mutation pending/error (in-modal, per WR-7).

a11y: the bar is `role="progressbar"` with `aria-valuemin/max/now` and an
`aria-valuetext` of the **formatted pair** (minor units are meaningless read aloud —
the shipped `GoalCard` rule); in the mismatch case there is **no** progressbar at
all (nothing to measure), which is also the correct screen-reader story.

## Vitest

1. `limitProgress.test.ts`
   - `spent < limit` → `'under'` with `remainingMinor` correct and `ratio < 1`;
   - **`spent === limit` → `'under'`** (the boundary: equality is NOT over) —
     contrasted directly with `spent === limit + 1` → `'over'`;
   - `spent > limit` → `'over'` with `ratio` clamped to exactly `1` (no >100 % width);
   - **`limit_currency !== currency` → `'mismatch'`, and the result carries neither
     `ratio` nor an over/under status** — the render gate; the same numbers that
     would be `'over'` in the matching case are used, so the test proves the gate,
     not the arithmetic;
   - `spent_minor === 0` with a limit → `'under'`, ratio 0 (a limited category with
     no spending is still listed by the server).
2. `limitProgress` decode contrast (AM-5): a `{limit_minor: 5000, limit_currency:'JPY'}`
   against `{spent_minor: 5000, currency:'RUB'}` renders "¥5,000" and "50,00 ₽" —
   swapping the two currencies changes both strings by 100×. This is the T8′
   tripwire in the same shape as `rowDisplay.test.ts`.
3. `schemas.test.ts` — `categoryLimitFormSchema('RUB')`: `"0"` → issue (server
   `ge=1`), `"0,50"`/`"0.50"` → `50`, blank → issue, over-exponent → issue with the
   `params.reason` code. The `"0"` arm is contrasted with `"1"` → `100` so the
   floor is proven, not assumed.

## Obligations (W4)

T8′ successor (the two-currency decode pair), T9 successor (tx → `['limits']`), C4,
R4, G1-inverted, G2.

---

# W5 — budgets section on `/stats` (month unit only)   (tier: STANDARD)

**Depends on:** B3's regen, and W4 (components + data layer).

## Files

New: `apps/web/src/features/stats/BudgetsSection.tsx` (+ css),
`features/stats/budgetsVisibility.ts` + `.test.ts`
Modified: `apps/web/src/routes/StatsPage.tsx` (mounts the section under the period card).

## Behaviour

`budgetsVisibility(selection)` → `{ visible: true; month } | { visible: false }`.
Visible **only** for `selection.unit === 'month'`, and then it queries
`useLimits(selection.month)` — i.e. the section follows the period picker's month,
including past months (the endpoint takes `?month=`; here it is genuinely
meaningful). For quarter/year/custom the section renders **one line**: "Budgets are
monthly — pick a month period to see them." plus a link to `/categories`. Read-only:
no Set/Edit/Remove here (one write surface, W4's).

## UI states

loading (three bar skeletons) · unreachable/error (`QueryStateNotice`) · empty
("No budgets set for {month}." + link to `/categories`) · ready · not-applicable
(the non-month explanation above).

## Vitest

1. `budgetsVisibility.test.ts` — `month` → `{visible:true, month}` carrying the
   selection's exact month string; `quarter`, `year`, `custom` → `{visible:false}`.
   The month arm asserts the *passed-through* month (not just the boolean), which is
   what a copy-paste from the summary period query would get wrong.

## Obligations (W5)

WR-6 gate (Disagreement 1), T8′, G2.

---

# Obligations trail — what this scope extends, and the new entries

**Successors to existing items** (the originals in
`.tasks/web-transactions-ui/obligations.md` are NOT rewritten):

- **T7 — EXTENDED (third builder).** `buildRecurringTemplatePatch` joins
  `buildTransactionPatch` / `buildCategoryPatch` / `buildGoalPatch` in the ONE
  builder module. New rule shape recorded: an **anchor PAIR** whose emitted member
  is chosen by the effective post-patch unit, and whose other member is never
  emitted — not as a value, not as `null` (WR-9). `paused` is excluded from the
  builder by the goals-`archived` precedent.
- **T8′ — EXTENDED (three new decode sites).** `amount_minor` at
  `template.currency`; `limit_minor` at `limit_currency`; `spent_minor` at
  `LimitsRead.currency`. **AM-5 no-fallback holds verbatim**: the mismatch case
  renders two currencies side by side rather than reaching for one of them.
- **T9 — EXTENDED.** Two new families (`['recurring','list']`, `['limits',{month}]`);
  tx mutations gain `['limits']`; template DELETE additionally invalidates the tx
  LISTS (and nothing else — money did not change). Full matrix in WR-2.
- **C4 — EXTENDED.** Affordance gating now also covers limits: Set/Edit only for
  `kind === 'expense'` and non-archived categories; the server's
  `CATEGORY_NOT_EXPENSE` / `CATEGORY_ARCHIVED` stay backstops.
- **T6 — EXTENDED.** The bug-signal family gains `ANCHOR_REQUIRED`,
  `ANCHOR_MISMATCH`, `INTERVAL_UNIT_REQUIRED`, `PAUSED_REQUIRED` (unreachable from a
  UI whose schema mirrors the CHECK).
- **A4 — UNTOUCHED.** No auth/coordinator change in W1–W5; the AM-7
  body-preservation vitest stays green and unmodified. W1 carries the explicit
  stop-and-flag clause.

**New entries for the trail:**

- **R1.** `weekday` is ISO **0 = Monday**. `Date.getDay()` must not appear in this
  scope (grep at the diff gate); labels come from the tested `weekdayLabels`.
- **R2.** `next_due_on` and every other date/aggregate is rendered **verbatim**; no
  client due-date math, no client clamp, no `end_date < today` comparison.
- **R3.** SL-C: an unresolvable `recurring_template_id` renders a name-less
  "Recurring" chip with **no** special copy; template DELETE invalidates the tx
  lists to close the one staleness window the client owns.
- **R4.** Over-limit is strict `>`; `spent === limit` is not over; any comparison is
  gated on `limit_currency === currency`.
- **R5.** Every screen renders a distinct, actionable state for a **paused**
  (unreachable) query — `role="alert"` + Retry. `networkMode: 'always'` is a
  deliberate app-wide default with the WR-10 argument attached.
- **R6.** Discard confirmation fires **only** when the form is dirty and no
  mutation is pending; clean forms close freely on Esc/backdrop/×; the guard lives
  once, in `Modal`.

---

# Disagreements with the architecture / backend plan (numbered — none silent)

1. **Limits on `/stats` must be gated to the `month` period unit.** The task brief
   says "indication in stats/categories screens" and D22 says "spent X of Y bars
   from `GET /limits`", but D16 makes a limit **calendar-month-only** and rejected
   bolting a month-only arm onto the period-generic `/stats/summary` for precisely
   that reason. Rendering a monthly bar while the user is looking at a quarter or a
   custom range would put the rejected contract lie back into the UI. I therefore
   ship the stats budgets section only for `period=month` (following the picker's
   month, which the endpoint supports) and one explanatory line otherwise.
   **Veto cost:** drop W5 — limits then live on `/categories` only, and the brief's
   "stats screens" half goes unserved.
2. **`unconverted_count` is rendered once per screen, not per bar.** D16 returns a
   period-level count on purpose ("per-category counts would fork tx_totals' return
   shape for a flag nobody renders per-bar"). A per-row honesty marker would imply a
   per-category number we do not have, so the banner sits above the group. Recorded
   so a reviewer does not read the absent per-row flag as a miss.
3. **Backend §Disagreement 5 (two anchor codes) is supported — and is unreachable
   from the web.** Keeping `ANCHOR_REQUIRED` and `ANCHOR_MISMATCH` distinct is right
   for API clients generally, but the shared schema mirrors the CHECK and WR-9's
   builder never emits the non-matching anchor, so both land in the bug-signal
   family (generic message, no field routing). If senior-lead collapses them to one
   code, **nothing on the web changes** — that is the point of recording it.
4. **The web depends on backend OQ-1's `next_due_on` floor shipping as
   recommended.** With the `max(last_materialized_on, today - 1 day)` floor, "Next
   on {date}" is always today-or-later and `templateStatus` has three arms. If the
   floor is vetoed, a pending catch-up renders "Next on 5 Aug" on 18 Aug, which
   reads as a broken screen — the web would then need a fourth "catching up" arm
   and copy explaining a server-internal state to the user. Recorded as a
   dependency, with the recommendation: **keep the floor**.
5. **P3 ships in W1, not in the stats-copy subtask.** The brief said to fold it into
   "whichever subtask touches stats copy"; the only later subtask that does (W5) is
   gated on B3, while P3 is a one-line shared-helper fix with no backend dependency
   and W1 already edits both affected files. Cost of insisting on the letter: the
   nit waits behind two backend subtasks for no benefit.

---

# Open questions for senior-lead (recommendation = what ships if unanswered)

1. **Base-currency source for the template form.** The recurring screen has no
   natural base-currency read (there is no `/profile` endpoint; `GET /recurring`
   does not echo a base). **Recommendation: reuse `useSummary(currentMonth())`
   behind the shipped modal-shell pattern**, keeping a real `CurrencySelect`
   (a EUR subscription is a genuine case, and 3.2 made currency a form field).
   **Alternative fork:** drop the picker entirely and always send `currency: null`
   so the server stamps the base — one less query and no shell, at the cost of
   making single-currency the only expressible template and showing the user a
   currency they never chose.
2. **`/recurring` as a top-level nav item.** **Recommendation: yes** (WR-1 —
   it is the screen that explains where auto-created money comes from, D9). Fork:
   nav grows to six items; the alternative is a section inside `/categories`,
   which buries it.
3. **Month scope of the limits UI on `/categories`.** **Recommendation: current
   month only, no stepper, no URL param** — `/categories` is a settings screen and
   a month stepper would change its nature; `GET /limits?month=` stays headroom and
   is exercised by W5's stats section. Fork: if PM wants past-month budget review on
   the categories screen now, W4 grows a stepper + `?month=` and the key/URL story
   with it.

---

# Mobile carry-forward (FROZEN — notes only, nothing under `apps/mobile`)

Everything added to `packages/shared` and `packages/api-client` in this scope is
**additive**: `sentenceEnd`, `recurringTemplateFormSchema`,
`categoryLimitFormSchema`, `buildRecurringTemplatePatch` (a NEW function — the
existing `buildTransactionPatch` overloads are untouched, so mobile's 2-arg
single-currency call still compiles). `pnpm -r typecheck` is the guard on every
subtask that touches either package.

What mobile must replicate at unfreeze:

- **ISO weekday 0 = Monday** in the periodicity control (R1) — RN's date pickers
  are as `getDay()`-shaped as the web's.
- **`next_due_on` verbatim** and `templateStatus`'s paused-wins ordering (R2);
  reuse the pure module rather than re-deriving.
- **Badge degradation (R3):** name-less "Recurring" chip on a cache miss, no
  "deleted" copy; the name comes from the cached `/recurring` list, never from
  `TransactionRead`.
- **Limits (R4):** strict `>` for over-limit, the `limit_currency === currency`
  comparison gate, the two-currency decode pair (WR-3), and the period-level
  `unconverted_count` banner.
- **Invalidation matrix (WR-2)** including tx → `['limits']` and template DELETE →
  tx lists.
- **P1 (R5) needs a mobile-specific decision:** React Native's online manager is
  wired to NetInfo, where "offline" is far more often *true and correct* than in a
  browser. `networkMode: 'always'` may be the wrong default there; the invariant to
  keep is the UI one — a paused query must render an actionable state, never an
  eternal skeleton.
- **P2 (R6):** the discard guard lives in the web `Modal`; RN needs its own
  implementation of the same predicate (`shouldConfirmDiscard` is pure and
  reusable), including the Android hardware back button as a close channel.

---

# Risks

- **Weekday off-by-one** is the single most likely silent bug in this scope
  (`getDay()` is 0=Sunday, the wire is 0=Monday, and six of seven values look
  plausible either way). Guarded by `weekdayLabels` + a both-ends test + a diff-gate
  grep, and by QA creating a weekly template and checking the day the row lands on.
- **P1's `networkMode: 'always'` is an app-wide behaviour change.** Every shipped
  screen and every mutation now attempts a request while the browser believes it is
  offline, and forms surface an error where they previously hung. QA must re-verify
  the shipped screens (transactions, categories, goals, stats, advisor), not just
  the new ones. If the W1 reproduction shows a different root cause, the change may
  be reduced to the `queryPhase` + notice half.
- **Materialized rows appear with no client event.** Nothing invalidates on a
  scheduler write; a user sitting on `/transactions` at 00:30 UTC sees the new row
  only after a natural refetch. Deliberate (WR-2); a mismatch between a template's
  "Next on today" and an absent row is a *timing* artefact (D9: up to ~24 h), not a
  bug — QA should be briefed so it is not filed as one.
- **The badge costs a `/recurring` fetch on the transactions screen.** Small and
  cached (60 s), but it is a new dependency of the busiest screen on a new endpoint;
  if `/recurring` errors, the badges silently degrade to name-less (by design) —
  which means a broken endpoint is invisible there. The `/recurring` screen itself
  is where that failure surfaces.
- **`/categories` gains money.** It has been a period-free settings screen; the
  limits slot puts month-scoped, converted numbers on it. Scoped to the current
  month with an explicit header, but it is a change in the screen's nature and the
  reason OQ-W3 exists.
- **P2 touches four shipped modals.** The change is one prop each, but the guard
  intercepts Esc/backdrop/× for all of them — a regression here is felt everywhere.
  The dirty/clean/pending trichotomy is pinned by vitest; the DOM behaviour
  (hidden-children focus filtering) is not testable in this repo's node-only vitest
  setup and must be an explicit qa-web check.
