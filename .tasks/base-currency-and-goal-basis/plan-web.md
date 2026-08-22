# Implementation Plan (web): base-currency-and-goal-basis — W1

Binding decisions: `.tasks/base-currency-and-goal-basis/task.md` (D1, D2, the rejected
options, the accepted "stray row" edge). QA expectations already written down:
`.tasks/base-currency-and-goal-basis/qa-web-checklist.md` (TC-1…TC-15) — this plan is
written so every one of those 15 has a place to land.

Mobile is frozen and out of scope. No `packages/shared` edit is required (see
§Shared-package safety). No new library, no new state manager, no new query root.

## Approach

Three visible changes, one invisible one that carries most of the risk.

The visible ones are small and follow shipped patterns verbatim: a base-currency
`<select>` next to the language block (LanguageSection's instant-apply shape, same
`useUpdateProfile`), a declared-income field (react-hook-form + a web-local zod
factory, the `tokenFormSchema` precedent), and a rewrite of the free-balance block on
`/goals` from "one sentence plus a window label" into an exhaustive switch over the
new `free_balance_basis`.

The invisible one is cache invalidation. Today `useUpdateProfile` invalidates ONLY
`['profile']`, and its own comment says why: "the server localizes no payload, so a
language change makes nothing else stale". That sentence stops being true the moment
`base_currency` becomes writable — five cached families are computed server-side IN
the base currency. Getting this set right (and NOT over-invalidating) is where W1 can
actually break, so it gets its own section with per-family evidence.

The third theme is honesty of copy. The `/goals` free-balance sentence is currently a
claim about three full months of history. Under D2 that claim is false in two of the
three basis arms, and (see OQ-2) arguably weakened in the third. Rewriting the block
as an exhaustive switch — rather than appending a label to the existing sentence — is
therefore not cosmetic; it is the defect fix.

## Seam with B1 (contract)

W1 consumes exactly two contract additions from B1:

- `ProfileUpdate` += `base_currency?: string` (not nullable) and
  `monthly_income_minor?: number | null`.
- `GoalListRead` += `free_balance_basis: "average" | "declared" | "none"`.

`ProfileRead` already carries `base_currency: string` and
`monthly_income_minor: number | null` (schema.d.ts:1390-1399) — nothing to add there,
the read side needs no regen.

Wall-clock policy: if B1 lags, W1 may start against the SettingsPage/GoalsPage markup,
CSS and i18n keys, which need no new types at all. It may NOT ship hand-declared
types: no local `type FreeBalanceBasis`, no `as` on a `ProfileUpdate` body. The final
diff reads both unions out of `components['schemas'][…]`. If a temporary local type is
used to keep moving, it is deleted in the same subtask, and `pnpm typecheck` after the
regen is the proof it is gone.

## Files touched

- `apps/web/src/routes/SettingsPage.tsx` — mount the two new sections; read
  `?focus=income` (the /goals deep link).
- `apps/web/src/routes/SettingsPage.module.css` — classes for the warning block, the
  income row and its inline error/status.
- `apps/web/src/features/settings/BaseCurrencySection.tsx` — NEW.
- `apps/web/src/features/settings/MonthlyIncomeSection.tsx` — NEW.
- `apps/web/src/features/settings/incomeFormSchema.ts` — NEW (web-local zod factory).
- `apps/web/src/features/settings/currencyOptions.ts` + `.test.ts` — NEW (the only
  genuinely testable pure bit in W1; see §Tests).
- `apps/web/src/features/goals/FreeBalanceSummary.tsx` — NEW (the basis switch, lifted
  out of GoalsPage so the page stays a layout).
- `apps/web/src/routes/GoalsPage.tsx` — free-balance block replaced by the component;
  `basisWindow`/`basisLine` move INTO it (only the `average` arm may show them).
- `apps/web/src/data/profile.ts` — invalidation on a base-currency / income change.
- `apps/web/src/data/transactions.ts` — export `invalidateTxSummaries` beside the
  existing `invalidateTxLists` (the transactions key grammar stays in one file).
- `apps/web/src/i18n/dict.en.ts`, `dict.ru.ts` — new keys (en is the key set, ru is a
  mapped type over it: a missing key fails typecheck, which is the coverage gate).

Untouched on purpose: `features/goals/freeBalanceWindow.ts` (its rule is still the
server's window rule — D2 changed the DIVISOR, not the window), `data/queryKeys.ts`
(no new key), every form schema in `packages/shared`.

## 1. Settings — base currency (D1)

`BaseCurrencySection`: `useProfile()` for the current value, `useUpdateProfile()` for
the write, instant apply on `change` — the LanguageSection shape, minus the local
`setLang` half (there is no client-side copy of the base currency to apply; the truth
is the server's, and the screens that render it read it from their own responses).

Guard exactly like LanguageSection: ignore a `change` whose value equals the current
base (QA TC-3 wants exactly one PATCH, no storm).

Option list: `currencyOptions(profile.base_currency)` — `SUPPORTED_CURRENCIES`
(USD/EUR/RUB/BYN) plus, if the stored base is outside that set, the stored base itself
as a first option. Rationale: a `<select>` whose `value` matches no `<option>` renders
blank in every browser, i.e. the screen would silently misreport the user's base
currency. This cannot happen with today's server default (RUB) but is one hand-written
DB row away, and the failure mode is a lie about money settings. It is the one piece
of real branching in W1, so it is a pure module with a test.

Warning copy — **decision: static, always visible, no confirm dialog.**
Reasons, in order: (a) the change is display-only and one click reversible, so the
`ConfirmDialog` rule ("destructive actions require confirmation") does not reach it;
(b) a confirm would have to carry the same three sentences, so the user reads them
either way — but the static form is also readable BEFORE touching the control, which
is when the information is actually useful; (c) QA TC-2 expects it "visible without
hovering/expanding". Rendered as a `<p>` in a bordered note block under the select,
NOT `role="alert"` (it is standing copy, not an event); the PATCH failure message
below it IS `role="alert"`.

Copy states exactly three things, matching D1: what you see changes, stored history
does not change, rows with no usable rate are shown as unconverted rather than folded
in silently.

States: profile loading → the section renders with a disabled select and a stable
placeholder width (no jank, no missing control); `queryPhase` error/unreachable →
`QueryStateNotice` with a retry, no select at all (an editable control over an unknown
current value is a trap); pending → the "saving…" span, select disabled while
`isPending`; error → inline message under the control, the select keeps the value the
user picked (LanguageSection's documented reasoning: rolling back would lie about what
was asked).

## 2. Settings — declared monthly income (D2)

`MonthlyIncomeSection`: react-hook-form + `zodResolver(incomeFormSchema(base, t))`,
with an explicit Save button. Deliberately NOT instant-apply like the two selects — a
free-text money field has no "committed" moment other than a submit, and debounced
auto-save of a half-typed amount is exactly how a "12" gets written on the way to
"12000".

`incomeFormSchema(currency, t)` lives in `features/settings/`, not `packages/shared`:
the tokenFormSchema ruling — shared schemas exist because two clients validate the
same form, and mobile is frozen with no settings screen. It is a factory over BOTH the
currency (the `categoryLimitFormSchema` precedent: exponent bound at construction) and
`t` (messages are user-facing copy).

Shape: one field `income: string`. Empty/whitespace → output `null` (clears, D2). Non
empty → `parseMoney(raw, currency)`; on failure a zod issue whose message comes from
`t`, mapped from the `MoneyParseError` code. No client money arithmetic anywhere: the
only crossing is `parseMoney` in, `toInputString`/`formatMoney` out.

Prefill: `toInputString(profile.monthly_income_minor, base)` when set, `''` when null.
Since a base switch on the same screen changes the currency the field is INTERPRETED
in, the resolver is rebuilt via `useMemo` on `base`. (All four supported currencies
have exponent 2, so no re-parse can actually change today — the factory is there so
that stays true if the list ever grows.)

The PATCH body is a diff, per patch-builder discipline: submit sends
`{ monthly_income_minor: value }` only when it differs from the prefill baseline —
`null` when cleared, the number when changed, and the section short-circuits a submit
that changes nothing.

Copy carries the two facts that D2 and the rejected-options list demand: the number is
read as an amount in your BASE currency, and it is never auto-converted when the base
changes — you have to retype it. That sentence sits next to the field (QA TC-7), not
in the currency section.

States: loading → skeleton row of the same height as the input; error/unreachable →
the shared `QueryStateNotice` (shared with the currency section — one profile query,
one notice); pending → button label switches to the "saving…" copy and is disabled;
success → a short "saved" status line (`role="status"`), cleared on the next edit;
error → inline `role="alert"` under the field, plus field-level zod messages.

Deep link target: the wrapping element gets `id="settings-income"` and the input
`id="settings-income-input"`; SettingsPage reads `useSearchParams()` and, when
`focus=income`, focuses the input once on mount. That is a real DOM effect, so a
`useEffect` is legitimate here (it is not state syncing).

## 3. Goals — free-balance basis (D2)

`FreeBalanceSummary({ list })` renders a `switch (list.free_balance_basis)` with no
`default` arm, so a future fourth basis value is a typecheck failure rather than a
blank box. Five outcomes:

1. `average`, `free_balance_minor > 0` — today's prefix / `<strong>amount</strong>` /
   suffix, plus the window line (`freeBalanceWindow` + current-month note). Unchanged
   markup. See OQ-2 about the wording.
2. `average`, `<= 0` — today's `goals.freeBalanceNone` + the window line.
3. `declared`, `> 0` — new copy: this is your declared monthly income, and it will
   switch to your actual numbers as soon as there is history. NO window line: naming
   three months that contributed nothing is precisely the lie this task is fixing.
4. `declared`, `== 0` — a declared income of 0 is allowed by the server CHECK, so it
   is reachable: says the declared income is zero, so there is nothing to share out,
   and points at the settings field.
5. `none` — hint + `<Link to="/settings?focus=income">`: there is no history yet and
   no declared income, so nothing can be shared out; tell us your monthly income and
   goals start planning immediately. This replaces the current "you spent at least as
   much as you earned" sentence, which is a flat falsehood for a history-less user and
   is the reported defect.

Everything else on the page (realism notice, cards, empty state, modals) is untouched.
The block still renders only in the `ready` arm — never over a skeleton or an error.

Why no pure module + node test here: the mapping is `basis` × `sign` → which JSX to
return, with zero arithmetic and no reuse; extracting it would produce a function whose
test restates the switch. The brief's own instruction — do not manufacture logic — and
the fact that exhaustiveness is already pinned by the generated union make a component
the honest packaging. (`realism.ts`, the precedent for extraction, exists because it
had a comparison rule; this has none.)

## 4. i18n

New keys, en + ru (en first — `dict.ru.ts` is a mapped type over it, so typecheck IS
the completeness gate; no test needed for coverage):

- `settings.baseCurrency.title|lede|label|saving|saveFailed|warning|loadFailed`
- `settings.income.title|lede|label|baseNote|clearHint|save|saving|saved|saveFailed`
- `settings.income.error.malformed|negative|tooManyDecimals|overflow`
  (the `MoneyParseError` codes the field can actually produce; `empty` is not an error
  here — empty means "clear")
- `goals.freeBalanceDeclaredPrefix|freeBalanceDeclaredSuffix|freeBalanceDeclaredBasis`
- `goals.freeBalanceDeclaredZero`
- `goals.freeBalanceNoBasisTitle|freeBalanceNoBasisBody|freeBalanceNoBasisLink`

Formatter discipline: every `formatMoney` / `toInputString` call site in the new code
passes `{ locale }` from `useLocale()` — the currency section and the income section
both take `locale` even though the schema does not. Currency CODES in the select are
not translated (they are ISO codes, like the language section's self-named options);
the select shows `USD` etc., with the option label built as code + the localized
currency name ONLY if `Intl.DisplayNames('currency')` is already used elsewhere —
it is not, so v1 shows bare codes and leaves display names to a follow-up.

## 5. Invalidation (the risky part)

Evidence first — which cached responses are computed FROM the profile base currency:

| Family | Server evidence | Verdict |
|---|---|---|
| `['goals', …]` | `services/goal_reads.py:91` `read_base_currency` → `base_currency`, `free_balance_minor`, waterfall | INVALIDATE (bare `['goals']` prefix: list + per-goal) |
| `['stats', …]` | `routers/stats.py:213,265,306` | INVALIDATE (blanket, tx-mutation precedent) |
| `['limits', {month}]` | `routers/limits.py:112,182` — `currency` echoed is the base, and it drives `limitProgress`'s mismatch arm | INVALIDATE (blanket) |
| `['transactions','summary',month]` | `routers/transactions.py:821` | INVALIDATE via predicate (see below) |
| `['transactions', filters]` | rows echo the STORED `tx.base_currency` snapshot (`routers/transactions.py:189`) | NO — refetch would return identical bytes and re-fetch every infinite page |
| `['fx','convert', params]` | every input, incl. `to`, is IN the key | NO — the new base is a different key, so it refetches by construction |
| `['accounts','list']`, `['recurring','list']`, `['receipts',id]`, `['tokens','list']` | no `read_base_currency` in their routers | NO |

The summary predicate is the mirror image of `invalidateTxLists`:
`key[0] === 'transactions' && key[1] === 'summary'`. It is exported from
`data/transactions.ts` as `invalidateTxSummaries` so the transactions key grammar keeps
living in exactly one file (no cycle: `transactions.ts` does not import `profile.ts`).

Trigger condition — this must NOT fire for a language change. In `onSuccess`, read the
previous profile out of the cache BEFORE `setQueryData`, then:

- `previous?.base_currency !== updated.base_currency` → invalidate the four families
  above. (Comparing cached-vs-returned rather than inspecting `variables` also catches
  a base changed by another writer, and never fires on a same-value PATCH.)
- `previous?.monthly_income_minor !== updated.monthly_income_minor` → invalidate
  `['goals','list']` only: with basis `declared` the free balance IS that number, so
  a goals screen left open in another tab is stale the moment income is saved. Nothing
  else on the server reads `monthly_income_minor` on a cached path (the advisor reads
  it per request over SSE, which has no Query cache).
- neither changed (language-only PATCH) → today's behaviour exactly, `['profile']`.

Consequence worth stating: after a base switch, `/transactions` refetches its summary,
which is where `TransactionFormModal` gets `baseCurrency` from
(`TransactionFormModal.tsx:149`), so the converted section and the fx preview follow
automatically — and `editPrefillBaseAmount` already degrades a stale snapshot to `''`
by design (`convertedSection.ts:107-125`, AM-5). No change needed there; QA TC-9/TC-11
observe it.

## 6. UI states summary

- `/settings`: profile loading → disabled control + skeleton input; unreachable/error →
  one `QueryStateNotice` with retry covering both new sections; ready → controls;
  saving → disabled + status; save failed → inline `role="alert"`, user input kept.
  Tokens section behaviour unchanged.
- `/goals`: loading skeleton, unreachable/error notice, ready → one of the five
  free-balance arms; empty goal list keeps its existing empty state (which now sits
  under a truthful basis line — the `none` arm plus "no goals yet" is the brand-new
  user's screen and must read as a coherent instruction, not two contradictory ones).

## 7. Tests

Only `currencyOptions` gets a node vitest file (3 cases: base inside the set → the four
codes in list order; base outside → it appears exactly once, first; no duplicates when
base is in the set). It is the only branch in W1 that can silently produce a wrong
screen and is not already pinned by typecheck.

Explicitly NOT written: dictionary coverage (mapped type + typecheck), plural rules
(existing `t.test.ts`), the basis switch (typecheck exhaustiveness over the generated
union), the money parse (`parseMoney` is already tested in `packages/shared`), the
invalidation wiring (a mocked-QueryClient test would assert the implementation back to
itself; QA TC-8…TC-11 exercise it against a real server, which is where it can fail).

## Shared-package safety

No file under `packages/shared` or `packages/api-client/src` (hand-written part) is
edited, so the frozen mobile client cannot be affected by W1. `SUPPORTED_CURRENCIES`,
`parseMoney`, `toInputString`, `formatMoney` are consumed as-is.

## Open questions (for senior-lead)

- **OQ-1 (blocking order).** task.md already flags it: our B1 must land after the
  uncommitted `recurring-dates-and-income` contract pair is committed. W1 needs B1's
  regenerated `schema.d.ts`. Confirm the sequence before W1 starts.
- **OQ-2 (disagreement with "average copy stands").** Under D2 the average divides by
  months WITH data, not by 3. The shipped sentence "Over the last 3 full months you had
  about X a month left over" + "Counted over the months A – B" then overstates its own
  basis in exactly the accepted "stray row" edge (one stray row in one month → the
  figure is one month's number presented as a three-month average). The window label is
  still true (those are the months scanned); the PREFIX is the problem. Cheapest honest
  fix, no API change: reword prefix/none to "on the months with activity in A – B",
  keeping the window line. The expensive alternative — B1 returning the count of months
  with data so the copy can say "1 of 3 months" — is more truthful and I would take it
  if B1 has not started. Decision needed; I will implement the reword unless told
  otherwise, and I will not silently keep copy I believe is misleading.
- **OQ-3 (currency option labels).** Bare ISO codes in v1, or code + localized name via
  `Intl.DisplayNames('currency')` (new Intl usage on web, needs the `{ locale }` rule
  applied)? I default to bare codes.
- **OQ-4 (income section placement).** It is a GOALS input living on `/settings`
  because that is where the profile is written. QA TC-13 assumes a `/goals` → settings
  deep link, which this plan implements. Confirm no one wants the field duplicated on
  `/goals` (I recommend against: two write surfaces for one value).

## Risks

1. **Over-invalidation.** A blanket `['transactions']` would refetch every loaded
   infinite page for no byte change; the plan uses a summary-only predicate. Watch for
   this in review — it is the easy wrong thing to type.
2. **Under-invalidation.** If the trigger condition is written against `variables`
   instead of the cached-vs-returned comparison, a base change made in another tab
   leaves this tab's `/stats` and `/categories` mixing currencies. QA TC-9/TC-10.
3. **Open tx form during a cross-tab base switch.** The form's `baseCurrency` comes
   from the summary query, so it can change under an open modal mid-edit; a typed
   converted-amount override then means a different currency. Rare (settings and the
   modal are different routes, so it needs two tabs), non-destructive (the server
   re-stamps), accepted — noted for QA, not defended against in v1.
4. **Basis arm × zero.** `declared` with income 0 and `average` with a negative free
   balance are both reachable; a switch that only checks `> 0` in one arm produces a
   blank or contradictory line. Five outcomes enumerated above for that reason.
5. **Contract drift while B1 is in flight.** If B1 names the field differently
   (`free_balance_basis` vs anything else) the goals arm fails to compile — good, that
   is the intended failure mode, and the fix is a rename, not a cast.

## Estimates (AGENT-MINUTES)

| Part | Write | Gates | Expected fix circles |
|---|---|---|---|
| Settings: base-currency section + `currencyOptions` + test | 18 | — | 8 |
| Settings: income section + schema + deep-link focus | 20 | — | 10 |
| Goals: `FreeBalanceSummary` (5 arms) + GoalsPage rewire | 14 | — | 8 |
| i18n keys en+ru | 8 | — | 4 |
| Invalidation (profile.ts + `invalidateTxSummaries`) | 8 | — | 6 |
| **W1 total** | **68** | **12** (`pnpm typecheck`, `pnpm lint`, `pnpm test` for web) | **36** (1–2 review circles; OQ-2 copy rework is the likeliest) |

## ACCEPTANCE RULINGS (senior-lead, 2026-08-22)

- **OQ-1**: confirmed; hard sequencing in task.md (B1 on PM's go after the
  recurring contract-pair commit; W1 strictly after B1; one combined live run).
- **OQ-2**: RESOLVED with the expensive-but-honest option — B1 adds
  `free_balance_months_with_data: int` (plan.md Amendment A2). Average arm:
  N == 3 → shipped sentence stands verbatim; N in {1,2} → "по N из 3 месяцев с
  активностью" + window line. The reword-only fallback is dropped.
- **OQ-3**: bare ISO codes approved for v1; `Intl.DisplayNames` is a follow-up.
- **OQ-4**: approved — single write surface on /settings, `/goals` deep-links.
- **Invalidation trigger**: cached-vs-returned comparison ACCEPTED over
  task.md's original body-presence rule (D3 updated). Decisive argument: the A1
  income clear is a SERVER-side effect of a base switch — comparison sees it in
  the response, body inspection cannot. Fail-open on empty cache is mandatory.
- **AMENDMENT (A1, income clear) — plan predates it, §2 copy changes**: the
  income note must say the declared income is RESET by a base switch and
  re-entered in the new currency ("не конвертируется" alone is now
  insufficient); prefill naturally empties because the PATCH response carries
  `monthly_income_minor: null`. The base-currency warning copy (§1) gains the
  same sentence (qa-web TC-2/TC-7 already amended). No structural change.
- **PM caption requirement** (extend, don't rewrite): plan §3 is judged
  COMPLIANT — the committed window caption survives verbatim in the `average`
  arm and is suppressed only where naming empty months would mislead
  (declared/none). Flagged to PM in the grooming report for veto.
