# Implementation Plan (web): currencies-goals (roadmap 3.2 web + 3.5)

Frontend-engineer scope-grooming output. Binding inputs: `task.md` (requirement 3
verbatim: converted amount in a SEPARATE, EDITABLE section of the tx form),
`architecture.md` (D5/D7/D8/D9/D10–D12), `plan.md` (Web handoff, S3 web-contract
ripple, S5 GoalRead/GoalListRead + [SL-3]/D-List, PATCH decision table),
`.tasks/web-transactions-ui/obligations.md` (T1–T10/C1–C8/A1–A4),
`.tasks/receipts-ocr/grooming-review.md` §4 AM-5 (binding decode discipline) and
R3 (shared form schemas are frontend-owned). Mobile is FROZEN — nothing in
`apps/mobile`; every shared-package change below is verified additive against the
frozen mobile imports (see WD-2).

Nothing is implemented in this run. All paths absolute-from-repo-root.

**Order:** W1 → W2 → W3 → W4. Backend gating: W1/W2 need S3's contract regen
commit (which transitively includes S2's `/fx/convert`); W3/W4 need S5's. W2 could
run parallel to W3 in principle, but sequential single-engineer execution is the
recommendation (the receipts §5 argument: parallelism buys nothing here and
`apps/web` diffs would overlap in `lib/errors.ts` / `data/queryKeys.ts`).

**Gates every subtask:** `pnpm --filter @budget/web lint`, `typecheck`, `test`;
`pnpm --filter @budget/shared test`; `pnpm --filter @budget/api-client test`
(A4: the AM-7 body-preservation vitest MUST stay green, untouched). G1 is
inverted this scope: `schema.d.ts` is EXPECTED to change — each W-subtask builds
against the exact regen commit its backend dependency produced, never a
hand-edited schema.

---

## Shared web design decisions (WD-n)

### WD-1. `SUPPORTED_CURRENCIES` + one `CurrencySelect` component (D7)

`packages/shared/src/currencies.ts` gains, next to `CURRENCY_EXPONENTS` (R3:
frontend-owned; no server twin exists to sync — the server is deliberately
format-only per D7/OQ-4, so NO cross-layer guard test is warranted for this
constant, unlike the exponent table):

```ts
// The convertible set (D7): closure of the six canonical FX pairs. The tx/goal
// pickers offer exactly this; the API deliberately accepts any ^[A-Z]{3}$.
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'RUB', 'BYN'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
```

New `apps/web/src/components/CurrencySelect.tsx` — a dumb `<select>` wrapper:
props `{ id, registration (RHF), extraCurrency?: string | null, disabled? }`.
Options come from a pure exported helper (unit-testable without rendering):

```ts
// currencyOptions('JPY') -> ['USD','EUR','RUB','BYN','JPY']; in-set or null extra
// -> the 4 supported only (dedupe). The D7 confirm-mode exception lives HERE:
// receipts confirm passes parsed.currency so an out-of-set parsed code is still
// offered (and preselected) — the picker gates, validation never does (WD-2).
export function currencyOptions(extraCurrency?: string | null): string[]
```

The `extraCurrency` prop is built in W1 (it is the component's API, one line) even
though its first caller is the future receipts S6 confirm mode — deliberately not
YAGNI-deferred, because D7 specifies the exception as part of the picker's
contract and retrofitting a prop later means reopening a reviewed component.

### WD-2. Form schemas: new multi-currency factories in `packages/shared`; the old `transactionFormSchema` stays untouched (mobile freeze)

Verified: `apps/mobile/app/(app)/transaction-form.tsx` imports
`transactionFormSchema` and builds `resolver: zodResolver(transactionFormSchema(schemaCurrency))`.
Changing that factory's signature or its input/output shape breaks the frozen
mobile build. Therefore:

- `transactionFormSchema(currency)` is left byte-identical, marked
  `@deprecated — single-currency form; web uses multiCurrencyTransactionFormSchema
  since 3.2; fold together at mobile unfreeze (recorded trigger)`.
- New factory in `packages/shared/src/schemas.ts`:

```ts
export function multiCurrencyTransactionFormSchema(baseCurrency: string)
// input  (RHF state): { amount: string; currency: string; base_amount: string;
//                       kind; category_id; occurred_at; note }
// output (submit):    { amount: number (minor, in `currency`); currency: string;
//                       base_amount_minor: number | null;  // null = "auto" sentinel, see WD-3
//                       kind; category_id; occurred_at; note }
```

Mechanics: a `z.object` whose amount/base_amount are plain strings, followed by a
single object-level `superRefine`+`transform`:
- `amount` parses via `parseMoney(raw, values.currency)` — the SELECTED
  currency's exponent, not a fixed constructor argument. This is the reason for
  object-level validation: the currency is now a form field, and a per-field
  `moneyAmountSchema(fixed)` cannot see it. Issues are attached with
  `path: ['amount']` and the same `params.reason` MoneyParseError contract, so
  existing field-error rendering works unchanged.
- `base_amount`: when `values.currency === baseCurrency` → output
  `base_amount_minor: null` unconditionally (the field is not rendered and must
  never reach the wire — the 422 `BASE_AMOUNT_WITHOUT_CURRENCY` guard starts at
  the schema). When foreign: `'' → null` (auto sentinel); non-empty parses via
  `parseMoney(raw, baseCurrency)` (the BASE currency's exponent — the converted
  section's value is denominated in base; issues on `path: ['base_amount']`).
- `currency`: `currencyCodeSchema` (free `^[A-Z]{3}$` string), **NOT
  `z.enum(SUPPORTED_CURRENCIES)`** — argued: (a) D7's confirm-mode exception
  requires submitting a parsed out-of-set code (a JPY receipt confirms as JPY);
  (b) the server is format-only (OQ-4 accepted), and a client enum would invent a
  stricter contract than the API's, exactly the class of client-side re-invention
  T-obligations prohibit; (c) gating belongs to the picker's option list (WD-1),
  which already prevents free-typing — the schema would only ever reject values
  the UI cannot produce. Pinned by a vitest accepting `'JPY'`.

Also new: `goalFormSchema(–)` (W3) — same object-level pattern: `target` parses
against the in-form `currency` field; `deadline: string` (`''` = none);
`priority: string` (digits, `''` = auto-append); `initial_saved: string`
(create-only, `''` = none, parses against `currency`); `archived` handled outside
the form (card action, C6 precedent). And `contributionFormSchema(goalCurrency)`
(W4): `amount` magnitude via `moneyAmountSchema(goalCurrency)` + `direction:
z.enum(['add','withdraw'])` (sign applied at the call site: the API takes signed
`amount_minor`, the form collects magnitude+direction — the T4 magnitude/sign
split precedent), `occurred_at`, `note`.

All three live in `packages/shared` with vitest there (R3: frontend-owned;
imports zod + shared money helpers only — no RHF, the established boundary).

### WD-3. The converted section (requirement 3) — exact mechanics

Rendered inside `TransactionFormModal` only when `currencyKnown && values.currency
!== baseCurrency` (D8). `baseCurrency` = the existing source
(`summary.data?.currency` for create, and for edit too — the row's `currency` is
now the TRANSACTION currency, no longer usable as the base; see W1 file notes).
Visually a separated fieldset: "Amount in {baseCurrency}" + input + hint line +
"Reset to auto" button.

**The `''`-as-auto sentinel (one representation, three wire intents).** The
`base_amount` form field's empty string means "automatic — server computes"; a
non-empty string is an explicit user-owned value. This maps the D5/[SL-2]
omitted/null/value trichotomy onto the exact `clearableChange` machinery T7/C1
already established:

| form state → | CREATE body (`currency !== base`) | PATCH body (via builder) |
|---|---|---|
| `''` (auto), was `''` initially | omit `base_amount_minor` → server auto-computes (D5) | omit (unchanged) |
| `''` (auto), was a value initially (user hit Reset) | — (create has no initial) | `base_amount_minor: null` → discard-override-recompute (plan Disagreement 2 / PATCH row 5) |
| non-empty value | send the minor number (override wins by being the stored value) | changed → send number; unchanged → omit |
| any state, `currency === base` | NEVER sent (schema nulls it; builder drops it) — the `BASE_AMOUNT_WITHOUT_CURRENCY` / PATCH-row-3 guard | same: builder emits no `base_amount_minor` whenever effective currency is base, even combined with a currency-change-to-base in the same PATCH |

**Preview autofill (create mode).** `useFxPreview` (new `apps/web/src/data/fx.ts`)
wraps `GET /fx/convert` with TanStack Query, key
`qk.fxConvert({ amountMinor, from, to, date })`, `enabled` only when: foreign
currency selected, `parseMoney(amount, currency).ok`, and `occurred_at`
well-formed. Inputs are debounced (~300 ms) via a small `useDebouncedValue` hook
(`apps/web/src/lib/useDebouncedValue.ts`); `staleTime` 5 min (rates are daily —
refires on rerender are pure waste; invalidation is irrelevant, the key changes
with the inputs). `parseMoney` here is ENCODING the query param, not rate math —
the client still never multiplies by a rate (D8).

Dirty tracking — **explicit edited flag, not RHF `isDirty`**: local
`baseAmountEdited` state set `true` only in the field's `onChange` (a real user
keystroke), reset by "Reset to auto" and by any `currency` change. RHF's
`isDirty` is rejected for this job because it compares against `defaultValues`:
a user who edits and then happens to retype the default flips back to
"not dirty" and previews would silently resume overwriting — a state machine the
user can't see. The effect: when a preview result arrives AND
`!baseAmountEdited`, `setValue('base_amount', toInputString(converted_minor,
baseCurrency), { shouldDirty: false, shouldValidate: false })`; once edited,
previews never write again.

**What CREATE sends — omit-when-untouched (recorded deviation, Disagreements §1).**
On submit, `base_amount_minor` is included only when `baseAmountEdited` and the
field parses non-empty. An autofilled-but-untouched value is OMITTED and the
server recomputes (identical math, same stored rate). D5 sketched "the POSTed
value (auto or user-edited) is stored"; omitting the untouched auto value is
chosen instead because (a) the displayed figure is a debounced preview — a fast
type-and-submit can race it stale, and shipping a stale preview as a stored
"override" is a silent lie; (b) the section labels the auto value "≈" (estimate),
so the server's authoritative recompute at the same rate is what the user was
promised; (c) it keeps "stored override ⇔ a human typed it" true, which is the
only reading under which requirement 3's "their override wins" means anything.

**No-rate UX (D7/D8).** Preview 200 with the null triple → hint text: "No
exchange rate available for {currency}→{base}. You can enter the {base} amount
yourself." Field stays enabled; a manually typed value still submits as the
override (`baseAmountEdited` is true by construction) and stores as the snapshot
— the system stays fully usable for unsupported currencies. No error styling:
this is degradation, not failure (never blocks submit).

**Rate honesty line.** On a successful preview, render "Rate {rate} as of
{rate_as_of}" under the field (D2's disclosed `rate_as_of` — shows the user when
a weekend/stale rate was used). Server strings verbatim; no reformatting of
`rate`.

**Edit mode.** The field prefills from the row: snapshot present AND
`base_currency === baseCurrency` → `toInputString(base_amount_minor,
base_currency)` (decode with the PAIRED currency — AM-5; the CHECK constraint
guarantees the pair is atomic, so no `??` fallback ever appears); snapshot
absent or stale-base (`base_currency !== baseCurrency`, the D5 base-change
bypass) → `''` (auto) — the plan's flagged risk "the web must not present the
override as active after a base change" is satisfied by construction. Edit mode
does NOT preview-autofill into the field (the stored value is the truth; an
unsolicited overwrite of a stored override is exactly what dirty-tracking
exists to prevent). Instead, when any conversion input (`amount`, `currency`,
`occurred_at`) is form-dirty and `base_amount` untouched, show the hint
"Will be recalculated at the {occurred_at} rate on save" — honest surface of
PATCH row 6's server recompute. "Reset to auto" clears to `''` → PATCH sends
`null` (row 5).

**AM-5 at every decode site (binding).** Sites in this scope and their currency
source — never `?? baseCurrency`, never a hardcoded code:
1. edit prefill: `toInputString(tx.base_amount_minor, tx.base_currency)` (pair).
2. preview autofill/row secondary display: `converted_minor`/`base_amount_minor`
   decode with the base/summary currency they are denominated in (the `to` we
   requested / the stored `base_currency`), never the row's `currency`.
3. goal amounts: `target/saved/monthly_needed` with `goal.currency`;
   `allocated_monthly_minor`/`free_balance_minor` with the profile base currency
   (WD-6) — two currencies on ONE card, per-field formatMoney (T4 extended).
4. contribution amounts with `goal.currency`.
A vitest contrast case (W2) pins the 100× failure mode: a `(5000, 'JPY')`
snapshot must render ¥5,000, not 50.00.

### WD-4. Query keys and invalidation (T9 discipline extended)

`apps/web/src/data/queryKeys.ts` additions:

```ts
fxConvert: (p: FxConvertParams) => ['fx', 'convert', p] as const,
goalsList: (includeArchived: boolean) => ['goals', 'list', { includeArchived }] as const,
goalContributions: (goalId: string) => ['goals', goalId, 'contributions'] as const,
goalProgress: (goalId: string, months: number) => ['goals', goalId, 'progress', months] as const,
```

`'list'` at key[1] keeps per-goal families (`['goals', goalId, ...]`) out of
list-only invalidations — the same disambiguation trick as
`['transactions','summary',...]`.

Invalidation rules:
- **Goal CRUD mutations** → invalidate prefix `['goals']` (list + every per-goal
  family; delete/archive make per-goal caches garbage anyway).
- **Contribution mutations (add / delete)** → invalidate `['goals','list']` (the
  list embeds `saved_minor`, realism, waterfall — server-computed, not locally
  patchable) + prefix `['goals', goalId]` (that goal's contributions AND
  progress). Other goals' progress caches are untouched (surgical, the T9 style);
  note the waterfall means other goals' `allocated_monthly_minor` can change from
  a contribution (a goal completing frees its share) — covered because the LIST
  is invalidated and cards render from the list, not from per-goal caches.
- **Transaction mutations → goals list: YES** (argued): `free_balance_minor` and
  everything derived from it (realistic, months_to_target, allocations) is
  computed from the last 3 FULL months of transactions. Any tx create/update/
  delete may change it (a current-month tx doesn't — partial month excluded —
  but an edit/delete of a past-month row does, and discriminating "does this
  mutation touch the window" client-side re-implements the server's window
  logic, which D8/D12 forbid in spirit). Blanket
  `invalidateQueries({ queryKey: ['goals','list'] })` in the three tx mutations'
  `onSuccess` is a no-op unless the goals screen has ever been loaded, so the
  cost is zero for non-goals users. Added in W3 (the key exists from then).
- **fx previews** are never invalidated (key embeds all inputs; staleTime covers
  the rest).

### WD-5. Error-helper extensions (`apps/web/src/lib/errors.ts`)

All via the existing single-branch `getErrorCode` + `getValidationIssues`
machinery (C2/T6 — the generated error types are still not trusted as
exhaustive at runtime).

| code | helper | surfaces as |
|---|---|---|
| `BASE_AMOUNT_WITHOUT_CURRENCY` | describeTransactionError | form-level GENERIC — the builder/schema guarantee it is never sent; if it fires it is a bug signal, the `*_REQUIRED` T6 precedent |
| `CURRENCY_REQUIRED` | describeTransactionError | form-level GENERIC (same family) |
| `GOAL_NOT_FOUND` (404) | describeGoalError (new) | form-level "This goal no longer exists. Refresh and try again." + mutation `onError` invalidates `['goals']` (the T6/T9 404-refetch precedent) |
| `NAME_REQUIRED` / `TARGET_REQUIRED` / `CURRENCY_REQUIRED` / `PRIORITY_REQUIRED` / `ARCHIVED_REQUIRED` | describeGoalError | form-level GENERIC (builder-guaranteed unreachable) |
| `CONTRIBUTION_EXCEEDS_SAVED` (422) | describeContributionError (new) | **field-level on `amount`**: "That's more than this goal has saved." — fires on withdraw AND on deleting a positive contribution (there it renders in the list row / dialog as the operation error, same message) |
| `CONTRIBUTION_NOT_FOUND` (404) | describeContributionError | row/dialog-level "This contribution no longer exists." + invalidate `['goals', goalId]` |
| 422 ValidationError[] arm | both new helpers | routed field-level via `routeIssue` with each resource's field list (goal: name/target_minor/currency/deadline/priority; contribution: amount_minor/occurred_at/note) |

### WD-6. Base-currency source on the goals screen + contract ask CA-1

`GoalListRead` (S5 shape) carries `free_balance_minor` and per-goal
`allocated_monthly_minor` in the profile base currency — but **no field says
which currency that is**. The web must not guess (`?? 'USD'` is the exact AM-5
sin) and must not decode base amounts with `goal.currency`.

**CA-1 (contract ask to S5, recommended):** add `base_currency: str` to
`GoalListRead` (one field, read from the profile the assembler already loads).
Kills a cross-feature data dependency and an entire hazard class.
**Fallback if declined:** the goals screen reuses the established source —
`useSummary(currentMonth).data?.currency` (the tx-form precedent; profile-level,
month-independent) — and degrades exactly like the tx form (base-denominated
fields render as bare `formatAmount`-less placeholders / screen shows a loading
state until the summary resolves). The plan budgets for the fallback; W3 drops
the extra query if CA-1 ships.

---

# W1 — tx-form-currency-and-converted-section   (tier: STANDARD)

**Depends on:** backend S3 contract regen commit (transitively S2's
`/fx/convert` — S2 lands before S3 by plan order) · **Goal:** requirement 3
end-to-end in the web tx form: currency picker (supported set), separate
editable converted section with debounced server preview, correct
create/PATCH wire semantics for `currency` + `base_amount_minor`.

**Tier reasoning:** PM guidance says web UI = STANDARD, and the receipts-R8
rationale holds: no new auth surface, no client money MATH (the client encodes/
decodes minor units through the existing shared helpers; every conversion number
is server-produced). The risk concentration (send/omit/null trichotomy) is
extracted into pure, vitest-pinned functions below, which is what makes STANDARD
honest. Escalation clause: if at implementation the trichotomy cannot stay in
pure helpers (i.e. it leaks into JSX event soup), senior should bump to FULL.

## Files

`packages/shared`:
- `src/currencies.ts` — `SUPPORTED_CURRENCIES`, `SupportedCurrency` (WD-1).
- `src/schemas.ts` — `multiCurrencyTransactionFormSchema(baseCurrency)` +
  `MultiCurrencyTransactionFormInput/Values` types (WD-2); `@deprecated` tag on
  `transactionFormSchema` (body untouched — mobile freeze).
- `src/index.ts` — exports.
- `src/schemas.test.ts` — extended (tests below).

`packages/api-client`:
- `src/patch.ts` — `buildTransactionPatch` extended for the new
  `MultiCurrencyTransactionFormValues` shape: `currency` (changed → emit;
  never null), `base_amount_minor` via the trichotomy, plus the
  effective-currency guard: when `values.currency === baseCurrency` (new third
  argument, or a values-carried base) no `base_amount_minor` key is ever
  emitted regardless of field state (PATCH row 3 protection). Signature grows a
  `baseCurrency` param — web-only caller, additive for mobile (mobile calls the
  old schema path; verified it imports `buildTransactionPatch`? — checked at
  implementation; if mobile imports it, keep the old signature working via an
  optional param + old-shape overload so the frozen build stays green).
- `src/patch.test.ts` — extended (tests below).

`apps/web`:
- `src/components/CurrencySelect.tsx` + `.module.css` — WD-1 (options via
  `currencyOptions`, exported from the same file).
- `src/data/fx.ts` — `useFxPreview` (WD-3); `FxConvertParams` type.
- `src/data/queryKeys.ts` — `qk.fxConvert`.
- `src/lib/useDebouncedValue.ts` — generic debounce hook (fake-timer vitest).
- `src/features/transactions/convertedSection.ts` — the PURE logic module:
  `shouldShowConvertedSection(currency, base)`,
  `buildCreateBody(values, baseCurrency, baseAmountEdited)` (the omit-when-
  untouched rule, WD-3), `editPrefillBaseAmount(tx, baseCurrency)` (AM-5 +
  stale-base → `''`). Extracted so the wire semantics are vitest-able without
  rendering.
- `src/features/transactions/TransactionFormModal.tsx` — the integration:
  currency `CurrencySelect` next to the amount input (replacing the read-only
  `currencyChip` when in create/edit — the chip remains the fallback while
  summary loads); converted fieldset per WD-3; resolver switched to
  `multiCurrencyTransactionFormSchema(baseCurrency)`; defaultValues gain
  `currency` (edit: `tx.currency`; create: `baseCurrency`) and `base_amount`
  (edit-prefill rule); `initial` values for the PATCH diff gain both fields;
  currency-change handler resets `baseAmountEdited` and (edit mode) re-derives
  the `base_amount` prefill; submit path calls `buildCreateBody` /
  extended `buildTransactionPatch`. NOTE: `schemaCurrency`'s job changes — the
  resolver needs the BASE currency; the amount field's exponent now follows the
  in-form `currency` value via the object-level schema (WD-2), so the resolver
  identity no longer depends on the selected currency at all (no resolver-swap
  gymnastics).
- `src/features/transactions/TransactionFormModal.module.css` — converted
  fieldset styles.
- `src/lib/errors.ts` — `BASE_AMOUNT_WITHOUT_CURRENCY`, `CURRENCY_REQUIRED`
  (WD-5); `TransactionField` unchanged (`base_amount` errors come from zod
  client-side; the server codes are form-level).
- `src/lib/errors.test.ts` — extended.

## Steps

1. Shared constants + schema factory + vitests (green before any UI).
2. `currencyOptions`/`CurrencySelect`, `useDebouncedValue`, `useFxPreview`.
3. `convertedSection.ts` pure module + vitests (the trichotomy is pinned before
   the modal is touched).
4. Patch-builder extension + vitests (both packages still mobile-green:
   `pnpm -r typecheck` proves the freeze held).
5. Modal integration; manual pass against local API (S3 landed ⇒ real
   `/fx/convert`).
6. Error-helper additions + tests.

## Vitest (non-vacuous; the named cases)

`packages/shared/src/schemas.test.ts`:
- amount parses with the SELECTED currency's exponent: same input `"12.50"`
  accepted under `currency:'USD'`, rejected `too-many-decimals` under
  `currency:'JPY'` (both arms — kills a fixed-exponent regression).
- `base_amount` parses with the BASE exponent, not the selected: base `'JPY'`,
  currency `'USD'`, `base_amount:"1200"` → 1200 minor; `"12.50"` → rejected.
- `currency === base` → output `base_amount_minor` is `null` even when the
  input string is non-empty (the schema-level 422 guard).
- schema accepts `'JPY'` as currency (out-of-set — pins WD-2's enum rejection).
- `'' base_amount` under foreign currency → `null` (auto sentinel).

`packages/api-client/src/patch.test.ts`:
- trichotomy triplet on one initial state (stored override):
  untouched → key absent; edited to a new value → number; cleared to `''` →
  explicit `null` (three arms, one fixture — the omitted/null/value contract).
- currency change emitted; unchanged currency omitted; currency changed TO base
  in the same patch as a non-empty `base_amount` → patch contains `currency`
  but NO `base_amount_minor` key (PATCH row 3 guard — the one case that would
  422 server-side).
- no-snapshot initial (`''`) left `''` → key absent (a bare clear is NOT sent
  as null when there was nothing to discard).

`apps/web` (`convertedSection.test.ts`):
- `buildCreateBody`: foreign + edited → `base_amount_minor` present; foreign +
  untouched (autofilled) → absent (Disagreements §1 pin, both arms); base
  currency → neither `base_amount_minor` nor a non-base `currency`… (currency
  always sent explicitly; assert `base_amount_minor` absent).
- `editPrefillBaseAmount`: valid pair → `toInputString` result; stale
  `base_currency` → `''`; null pair → `''` (three arms).
- `currencyOptions`: no extra → 4; `'JPY'` → 5 with JPY last; `'EUR'` → 4
  (dedupe).
- `useDebouncedValue`: fake timers — value settles only after the window;
  rapid re-sets restart it (genuine timer logic, not a vacuous render test).

`apps/web` (`errors.test.ts`): `BASE_AMOUNT_WITHOUT_CURRENCY` → form-level
generic (and NOT routed to a field).

---

# W2 — summary-degradation-and-row-display   (tier: STANDARD)

**Depends on:** backend S3 contract regen (same as W1); ordered after W1 only
for single-engineer serialization (no code dependency on W1 beyond shared
constants). · **Goal:** honest multi-currency READ surfaces: the summary
degradation flag, foreign-row display in the list, and the receipts-confirm
supersession bookkeeping.

## Files

- `apps/web/src/features/transactions/SummaryHeader.tsx` — when
  `summary.unconverted_count > 0`, render a non-error notice line
  (`role="status"`): "{n} operation(s) not converted — no exchange rate.
  Totals exclude them." (D9's exclude+flag made visible; wording final at
  impl). No layout rework.
- `apps/web/src/features/transactions/TransactionRow.tsx` — foreign rows
  (`tx.currency !== summary.currency`): primary amount stays
  `formatMoney(amount_minor, tx.currency)` (T4/T8′ — the row's OWN currency);
  secondary muted text `≈ {formatMoney(base_amount_minor, base_currency)}`
  ONLY when the snapshot pair is present AND `base_currency ===
  summary.currency` (stale-base snapshots are hidden — the D5 bypass must not
  be presented as active; plan Risks item). No snapshot → no secondary line
  (the summary banner carries the no-rate story; per-row nagging rejected).
- `apps/web/src/features/transactions/rowDisplay.ts` (new, pure) —
  `baseEquivalent(tx, summaryCurrency): { minor, currency } | null` extracted
  for the vitest below; `TransactionRow` consumes it.
- `apps/web/src/features/transactions/rowDisplay.test.ts` — tests below.
- `.tasks/receipts-ocr/plan-web.md` + `.tasks/web-transactions-ui/obligations.md`
  — supersession notes appended (see Obligations section; doc edits, part of
  this subtask's commit).

**Receipts-confirm pass-through: bookkeeping, not code.** Receipts web S5/S6
are NOT yet implemented (verified: no `features/receipts/`, no confirm mode in
the modal — the receipts scope is paused at its S5 live-call gate). There is no
banner in code to retire. W2 therefore (a) appends the amendment to
`.tasks/receipts-ocr/plan-web.md` S6: confirm mode sends
`currency: parsed.currency` in the create body (D5 contract closure), validates
the amount against the PARSED currency via the multi-currency schema (which
dissolves receipts R4's cross-exponent residual entirely), passes
`extraCurrency={parsed.currency}` to `CurrencySelect` (D7 exception), and the
currency-mismatch banner spec is DROPPED — replaced by the converted section
this scope built; (b) nothing else. When receipts S6 eventually runs it
implements against the amended spec directly. If (against current state) S6 had
landed first, this subtask would own the code retirement — recorded so the
dependency is explicit either way.

## Vitest

`rowDisplay.test.ts`:
- valid snapshot under matching summary currency → `{minor, currency}` returned;
  formatted via the PAIR: the **AM-5 contrast case** — pair `(5000,'JPY')` under
  an RUB summary renders `¥5,000` (exponent 0), and asserting against the
  wrong-decode value (`50.00`) is the contrast arm.
- stale pair (`base_currency:'RUB'`, summary `'EUR'`) → null (hidden).
- base-currency row → null (no secondary line on ordinary rows).
- (SummaryHeader banner: conditional-render logic is one ternary off a typed
  field — no component test; the house rule against vacuous tests applies. The
  web-qa checklist covers it live.)

---

# W3 — goals-screen-core   (tier: STANDARD)

**Depends on:** backend S5 contract regen commit (+ W1 for `CurrencySelect`,
shared schema patterns) · **Goal:** the goals screen: route + nav, data layer,
per-goal cards with the honest unrealistic messaging, create/edit/archive/
delete.

**Tier reasoning:** STANDARD per PM guidance — the screen renders
server-computed numbers verbatim (D12: the calculator is server-side ONLY; the
web never computes money math — every realism/waterfall/free-balance figure is
a response field). The moving parts are display routing and the PATCH builder,
both vitest-pinned. Same escalation clause as W1.

## Files

`packages/shared`:
- `src/schemas.ts` + `src/index.ts` — `goalFormSchema` (WD-2) + types.
- `src/schemas.test.ts` — target-vs-currency exponent cases (mirror of W1's,
  against the goal schema — only the arms that differ: `initial_saved` empty →
  null; priority `''` → null/auto).

`packages/api-client`:
- `src/patch.ts` — `buildGoalPatch(values, initial)`: name/target_minor/
  currency/priority never null (changed → emit); `deadline` clearable
  (`'' → null`, the C1 `clearableChange` reuse — deadline is the ONE
  user-owned nullable field per D12); `archived` is NOT part of the form
  builder (card-level PATCH `{archived}` mirrors C6's dedicated flow).
- `src/patch.test.ts` — deadline trichotomy (clear → null / set → value /
  untouched → absent); non-nullable fields never null; empty patch on
  no-change.

`apps/web`:
- `src/App.tsx` — `<Route path="/goals" element={<GoalsPage />} />` inside
  `ProtectedLayout`.
- `src/routes/ProtectedLayout.tsx` — nav link "Goals".
- `src/routes/GoalsPage.tsx` + `.module.css` — screen shell: list +
  "New goal" button; top-level degradation banner when
  `list.realism_unavailable` ("Free-balance estimate is incomplete — some
  transactions have no exchange rate."); free-balance line
  `formatMoney(free_balance_minor, baseCurrency)` ("You can set aside about
  {x}/month"); loading/empty/error states (empty: honest CTA copy).
- `src/data/goals.ts` — `useGoals(includeArchived)` (`GET /goals`),
  `useCreateGoal`, `useUpdateGoal`, `useDeleteGoal` with WD-4 invalidations +
  the 404 `onError` refetch (T9 precedent); base currency per WD-6 (CA-1 field
  if granted, else the `useSummary` fallback).
- `src/data/queryKeys.ts` — `qk.goalsList` (+ the `['goals']` root family
  documented in the header comment).
- `src/data/transactions.ts` — the three tx mutations additionally invalidate
  `['goals','list']` (WD-4, argued there).
- `src/features/goals/GoalCard.tsx` + `.module.css` — per-goal card:
  name; progress bar `saved_minor / target_minor` + labels both via
  `formatMoney(_, goal.currency)`; `completed` badge; deadline; then the
  computed block:
  - `monthly_needed_minor` → "Need {formatMoney(x, goal.currency)}/month".
  - `allocated_monthly_minor` → "Allocated {formatMoney(x, baseCurrency)}/month
    of your free balance" — the T4-extended mixed-currency card: two currencies,
    each field formatted with ITS OWN currency, never cross-decoded (AM-5).
  - `realistic === true` → quiet affirmative ("On track at your current pace").
  - `realistic === false` → the honest block: "Unrealistic at your current
    pace." + suggestions rendered ONLY from server fields, verbatim:
    `months_to_target != null` → "At your free balance this takes
    {months_to_target} months — move the deadline to {suggested_deadline}?";
    `months_to_target === null` → "Your free balance doesn't cover this goal
    right now." (the D11 unreachable case — no fake suggestion). No client
    arithmetic anywhere (D8/D12 stance).
  - per-goal `realism_unavailable === true` → "Can't check realism — no
    exchange rate for {goal.currency}." and the realism block suppressed
    ([SL-3]: this goal only; siblings render fully; top-level flag independent).
  - actions: edit, archive/unarchive (ConfirmDialog, C6 pattern), delete
    (ConfirmDialog, destructive: "contributions will be deleted too").
- `src/features/goals/GoalFormModal.tsx` + `.module.css` — create/edit:
  name, target amount, `CurrencySelect` (no extraCurrency), deadline (native
  date input, clearable), priority (numeric input, hint "lower = higher
  priority"; blank = "add last"), initial saved (create only). Edit-mode
  currency change: ConfirmDialog warning per D12 ("Changing the currency
  relabels all saved amounts in {new}; nothing is recalculated.") before
  submit. Errors via `describeGoalError` → field routing.
- `src/features/goals/realism.ts` (pure) — `realismContent(goal): RealismView`
  discriminated union (`ok | unrealistic-movable | unrealistic-unreachable |
  unavailable | completed`) — the messaging decision table extracted for the
  vitest; `GoalCard` renders it.
- `src/lib/errors.ts` + `errors.test.ts` — `describeGoalError` (WD-5).

## Vitest

- `realism.test.ts` — the decision table, one case per branch with contrasting
  fixtures: `realistic:false + months_to_target:7` → movable (and the exact
  fields echoed); `realistic:false + months_to_target:null` → unreachable (no
  suggested deadline in the view — pins "never invent a suggestion");
  `realism_unavailable:true` → unavailable EVEN IF other fields are
  non-null (server contract says ignore them); `completed:true` wins over all.
- `patch.test.ts` / `schemas.test.ts` — listed above.
- `errors.test.ts` — `GOAL_NOT_FOUND` → form-level; `CONTRIBUTION_EXCEEDS_SAVED`
  routed by describeContributionError not describeGoalError (negative test that
  the goal helper falls through to generic — guards against a copy-paste
  catch-all).

---

# W4 — goals-contributions-and-progress   (tier: STANDARD)

**Depends on:** W3 (+ S5) · **Goal:** contribution add/withdraw/history/delete
and the progress chart.

## Files

`packages/shared`:
- `src/schemas.ts` + tests — `contributionFormSchema(goalCurrency)` (WD-2:
  magnitude + direction; the sign is applied at the call site).

`apps/web`:
- `src/data/goals.ts` — `useContributions(goalId)` (limit=200 + offset
  load-more, the T1 ruling applied to the `{items,total}` envelope),
  `useAddContribution`, `useDeleteContribution` (WD-4 invalidations;
  `CONTRIBUTION_NOT_FOUND` 404 `onError` → invalidate `['goals', goalId]`),
  `useGoalProgress(goalId, months=12)`.
- `src/data/queryKeys.ts` — `qk.goalContributions`, `qk.goalProgress`.
- `src/features/goals/ContributionModal.tsx` + `.module.css` — from a card
  action ("Add / withdraw"): direction toggle (add/withdraw), amount magnitude
  (validated against `goal.currency`), date (default today), note. Submit body:
  `amount_minor: direction === 'withdraw' ? -minor : minor`. Withdraw errors:
  `CONTRIBUTION_EXCEEDS_SAVED` → amount field (WD-5). The exceeded check is
  server-owned (C8 spirit: no client re-implementation of the SUM≥0 invariant
  as a hard gate; the field error is the UX).
- `src/features/goals/ContributionList.tsx` — expandable section on the card
  (or within a detail modal — implementer's call, no route change): rows
  `occurred_at · formatMoney(amount_minor, goal.currency) · note`, withdrawals
  visually negative; per-row delete behind ConfirmDialog (guarded 422 mapped
  same as withdraw).
- `src/features/goals/GoalProgressChart.tsx` — **Recharts** (blessed stack;
  add `recharts` to `apps/web/package.json`, exact version pinned at
  implementation — first chart dependency in the app): one responsive
  `AreaChart` of `saved_end_minor` per `month` with a horizontal
  `ReferenceLine` at `target_minor`; bars/tooltip show `contributed_minor`.
  Series rendered VERBATIM from `GET /goals/{id}/progress` — no client
  accumulation, no gap-filling (the server emits empty months with 0 — D12);
  axis/tooltip values via `formatAmount(minor, goal.currency)` (T4; the only
  transformation is minor→display through the shared helper). Loading/empty
  states (a goal with no contributions renders the empty chart honestly, not a
  spinner forever).
- `src/lib/errors.ts` + `errors.test.ts` — `describeContributionError` (WD-5).

## Vitest

- `contributionFormSchema`: magnitude+direction — withdraw direction does NOT
  make `parseMoney` see a minus sign (the schema takes magnitude; a typed "-5"
  → `negative` error surfaced on the field, both arms).
- sign application helper (extract `signedAmountMinor(direction, minor)` pure):
  add → +, withdraw → − (trivial BUT it is the one place a sign flip corrupts a
  ledger; one two-arm test, justified under the house rule).
- `errors.test.ts` — `CONTRIBUTION_EXCEEDS_SAVED` → `amount` field;
  `CONTRIBUTION_NOT_FOUND` → row-level message shape.
- Chart: NO component vitest (rendering a third-party chart asserts the
  library, not our behavior — vacuous by the house rule); the verbatim-series
  rule is upheld by there being no transform code to test; web-qa checks it
  live.

---

## Obligations: supersessions and updates (explicit)

- **T8 — PARTIALLY SUPERSEDED (this scope).** The 1.6 rule was "no currency
  collected in forms; every amount renders with the row's own currency; no
  hardcoded currency." As of 3.2 the first clause is DEAD: the tx form (W1),
  goal form (W3), and — when receipts S6 runs — the confirm form DO collect
  currency via `CurrencySelect` over `SUPPORTED_CURRENCIES` (D7). The second
  and third clauses SURVIVE and are extended: **T8′ — every amount renders/
  decodes with its OWN field's currency (tx currency for `amount_minor`,
  paired `base_currency` for `base_amount_minor`, goal currency for goal
  amounts, profile base for free-balance/allocations); no hardcoded currency;
  no `?? baseCurrency` in any minor-unit decode (AM-5).**
- **T7 — EXTENDED, not superseded.** The PATCH-builder discipline now covers
  `currency` (never null) and `base_amount_minor` (the omitted/null/value
  trichotomy via the `''`-sentinel + the effective-currency drop rule). Still
  exactly one builder, no open-coded diffs at call sites.
- **T4 — EXTENDED.** Mixed currencies now occur within one card (goal vs base):
  per-field `formatMoney`, never per-screen.
- **T9 — EXTENDED.** Tx mutations additionally invalidate `['goals','list']`
  (WD-4). The existing list/summary invalidation matrix is unchanged.
- **Receipts plan-web S6 — SPEC AMENDED (W2 owns the doc edit).** The
  currency-mismatch banner and the R4 "prefill-and-warn" residual are
  superseded: confirm mode passes `parsed.currency` through (D5 closure),
  validates against the parsed currency via the multi-currency schema, and uses
  `CurrencySelect extraCurrency` (D7 exception). No code retirement needed —
  receipts S5/S6 are unimplemented as of this grooming (verified in-tree).
- **R3 reaffirmed:** all new form schemas live in `packages/shared`,
  frontend-owned; zod + shared helpers only, no RHF imports.
- **A4 untouched:** no auth/coordinator changes anywhere in this scope; the
  AM-7 tripwire suite must stay green through every subtask.
- **`transactionFormSchema` deprecated, not removed** (mobile freeze; removal
  trigger = mobile unfreeze task adopts the multi-currency factory).

## Disagreements (with architecture/plan — numbered, none silent)

1. **CREATE omits an untouched auto-converted value (refines D5's sketch).**
   D5 reads "the POSTed value (auto or user-edited) is stored in the snapshot
   pair"; this plan sends `base_amount_minor` only when the user actually
   edited the field, and lets the server auto-compute otherwise (identical
   stored result via the same rate; D5 explicitly supports the omitted path).
   Rationale in WD-3: a debounced preview can be stale at submit time, and
   storing a stale client echo as the "override" is a silent data lie; "≈"
   labeling promises an estimate, the server recompute delivers the exact one;
   and it preserves "stored override ⇔ human intent". Veto cost before W1:
   one condition in `buildCreateBody` + two test arms.
2. **Edit mode does not live-autofill the converted field** (D8's "the form
   auto-fills the editable override section" is applied to CREATE only). In
   edit, the stored snapshot is the truth on screen; recompute-on-save (PATCH
   row 6) is surfaced as a hint instead of a live overwrite of a possibly
   user-owned stored value. Same veto cost class.
3. **CA-1: `GoalListRead.base_currency` requested from S5** (WD-6). Not a
   conflict with D12 — an additive field ask; the fallback (summary-sourced
   base currency) ships if declined, but couples the goals screen to a
   transactions query for one string.

## Open questions (for senior-lead; recommendation = default that ships)

1. **CA-1** (above) — recommend granting; one line in the S5 assembler.
2. **Contribution history placement:** inline expandable section on the card
   vs a goal-detail modal. Recommend inline-expandable (no new route, no
   detail query — the list read already powers the card; contributions load
   on expand). Implementer may flip within W4 without re-grooming.
3. **Recharts version:** unpinned until implementation (first chart dep in
   `apps/web`; align major with the mobile Victory decision only in the sense
   of neither blocking the other — none needed now).

## Risks

- **RHF resolver + object-level transform:** zodResolver with
  `superRefine`+`transform` output types is the one novel RHF mechanic here;
  the 1.6 form already uses input/output split typing
  (`useForm<Input, unknown, Values>`), so the pattern extends — but W1 step 1
  should smoke the resolver typing before the modal work starts (cheap fail-
  fast).
- **Preview churn:** debounce + staleTime keep `/fx/convert` calls bounded;
  the endpoint is an indexed PK lookup (D8) so even a miss here is cheap —
  no client cache invalidation complexity is warranted.
- **Frozen-mobile typecheck:** every shared/api-client edit runs the full
  workspace typecheck; the deprecated-factory strategy (WD-2) makes a mobile
  break structurally impossible, but the gate stays.
- **S3's `SummaryRead.unconverted_count` is a required-field read change:**
  harmless to existing web code (response types gaining fields don't break
  consumers) — W2 consumes it; no interim breakage window because web builds
  only against committed regens.
