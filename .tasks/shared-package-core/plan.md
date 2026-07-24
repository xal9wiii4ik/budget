# Implementation Plan (shared): shared-package-core (roadmap 0.4)

State at grooming: HEAD scaffold. `packages/shared` exports only `PACKAGE_NAME`
with one placeholder test. Stack facts verified: zod latest stable **4.4.3**
(`npm view zod version`), tsconfig `target: es2022` + `strict` (DOM + ES2022 libs
default → `Intl` available), `.npmrc node-linker=hoisted`, exports map points at
`src/index.ts` source directly (no build step), vitest 4.1.10 / typescript 5.9.3.

This is a **utilities task, not a framework**. Every export below names a
consumer on the 1.x–3.x horizon; anything without one is left out and flagged
YAGNI.

---

## 1. Proposed API surface

All symbols exported from the single `.` entry (barrel `src/index.ts`).

### money (`src/money.ts`)

```ts
// Exponent lookup — the source of truth for minor↔major conversion.
function getCurrencyExponent(currency: string): number;

type MoneyParseError =
  | 'empty'             // blank / whitespace-only
  | 'malformed'         // not /^\d+(\.\d+)?$/ after trim
  | 'negative'          // leading '-' — magnitudes only (see D1)
  | 'too-many-decimals' // more fraction digits than the currency exponent
  | 'overflow';         // result not Number.isSafeInteger

type ParseMoneyResult =
  | { ok: true; minor: number }
  | { ok: false; error: MoneyParseError };

// "12.50" + 'USD' -> { ok: true, minor: 1250 }. No float arithmetic (see D1).
function parseMoney(input: string, currency: string): ParseMoneyResult;

// 1250 + 'USD' + en-US -> "$12.50". Locale-aware, symbol shown.
function formatMoney(minor: number, currency: string, options?: { locale?: string }): string;

// 1250 + 'USD' + en-US -> "12.50" (no symbol, locale grouping). For chart axes
// and contexts where the symbol is rendered separately.
function formatAmount(minor: number, currency: string, options?: { locale?: string }): string;

// 1250 + 'USD' -> "12.50" — machine string: no grouping, '.' separator, fraction
// digits pinned to the exponent. The exact inverse of parseMoney, for form prefill.
function toInputString(minor: number, currency: string): string;
```

| Export | Consumer on the roadmap |
|---|---|
| `formatMoney` | 1.6 web transaction list + month summary; 1.8 mobile lists; 4.2/4.3 chart tooltips |
| `formatAmount` | 4.2 Recharts axis/label formatters, 4.3 Victory; 1.6 summary cells where currency shown once |
| `parseMoney` | 1.6 web add/edit form (amount input → minor); 1.8 mobile form; 2.3/2.4 receipt-confirm form; 3.5 multi-currency form (used directly in a cross-field `superRefine`) |
| `toInputString` | 1.6 web edit-transaction prefill (minor → editable "12.50"); 1.8 mobile edit prefill; 2.3/2.4 receipt-confirm prefill of OCR total |
| `getCurrencyExponent` | internal to money + schemas; 3.5 currency-aware input (max-decimals UI hint) |

### currencies (`src/currencies.ts`)

```ts
// ISO-4217 currencies whose exponent is NOT 2. Everything else defaults to 2.
const CURRENCY_EXPONENTS: Readonly<Record<string, number>>;
const DEFAULT_CURRENCY_EXPONENT = 2;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
```

`getCurrencyExponent` lives in `money.ts` but reads this table. See **D3** for
scope and the "default 2 is safe because every non-2 code is enumerated"
argument. `CURRENCY_CODE_PATTERN` is consumed by `currencyCodeSchema` (2.3
receipt currency validation, 3.5 picker).

### dates (`src/dates.ts`)

```ts
// "2026-07-24" (occurred_at wire format) -> "Jul 24, 2026" — NO timezone shift.
function formatApiDate(isoDate: string, options?: { locale?: string }): string;

// local Date -> "YYYY-MM-DD" for API params / form values.
function toApiDate(date: Date): string;

// today in the user's LOCAL date as "YYYY-MM-DD".
function todayApiDate(): string;
```

| Export | Consumer |
|---|---|
| `formatApiDate` | 1.6 web transaction list (`occurred_at` column); 1.8 mobile; 2.3/2.4 receipt date |
| `toApiDate` | 1.6 date-picker value → `occurred_at` param; 1.4 filter range params from web |
| `todayApiDate` | 1.6 add-transaction default date; transaction/summary period defaults |

`formatDateTime` (for `created_at`) is **left out** — no named consumer in 1.x
(MVP lists show `occurred_at`, not the creation timestamp). See **D7**.

### schemas (`src/schemas.ts`)

```ts
import { z } from 'zod';

// z.string().regex(CURRENCY_CODE_PATTERN)
const currencyCodeSchema: z.ZodType<string, string>;

// Factory: fixed-currency amount field. string "12.50" -> number 1250, with
// per-currency exponent validation surfaced as zod issues (see D8 sketch).
function moneyAmountSchema(currency: string): z.ZodType<number, string>;
```

| Export | Consumer |
|---|---|
| `currencyCodeSchema` | 1.6 form (once currency is a field); 2.3/2.4 validate OCR-returned currency; 3.5 picker |
| `moneyAmountSchema` | 1.6 web add/edit form (single base currency in MVP); 1.8 mobile form; 2.3/2.4 receipt-confirm amount |

A **full `transactionFormSchema` is deliberately NOT shipped in 0.4** — see D8.

---

## 2. Module layout

```
packages/shared/src/
  index.ts        # barrel: re-export money, currencies, dates, schemas
  money.ts        # parse/format/toInputString/getCurrencyExponent
  currencies.ts   # CURRENCY_EXPONENTS table + constants
  dates.ts        # formatApiDate/toApiDate/todayApiDate
  schemas.ts      # zod: currencyCodeSchema, moneyAmountSchema
  money.test.ts
  currencies.test.ts
  dates.test.ts
  schemas.test.ts
```

**Single `.` entry, no subpath exports.** The package is tiny; ESM +
bundler (Vite/Metro) tree-shaking drops unused symbols without subpath config.
Subpath exports (`@budget/shared/money`) add package.json `exports`-map surface
and per-consumer import churn with zero present benefit → deferred (YAGNI). If
mobile bundle size ever forces splitting zod out of the money/date path, revisit
then. The placeholder `src/index.test.ts` is **deleted** (per binding 0.1 §1.3);
its "the package resolves" purpose is absorbed by the real tests + the wiring
smoke tests (D9).

---

## 3. Decisions (D1–D9)

### D1 — Safe parsing pattern — RECOMMENDATION

Algorithm (no float arithmetic; all integer/string ops):

```ts
function parseMoney(input: string, currency: string): ParseMoneyResult {
  const s = input.trim();                       // leading/trailing whitespace OK
  if (s === '') return { ok: false, error: 'empty' };
  if (s.startsWith('-')) return { ok: false, error: 'negative' };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: 'malformed' };

  const exp = getCurrencyExponent(currency);    // hardcoded table (D2)
  const [intPart, fracPart = ''] = s.split('.');
  if (fracPart.length > exp) return { ok: false, error: 'too-many-decimals' };

  const frac = fracPart.padEnd(exp, '0');       // "5" -> "50" for exp 2
  // digit-string concatenation, then a single Number() — no *10^n float math:
  const digits = (intPart + frac).replace(/^0+(?=\d)/, ''); // strip leading zeros
  const minor = Number(digits === '' ? '0' : digits);
  if (!Number.isSafeInteger(minor)) return { ok: false, error: 'overflow' };
  return { ok: true, minor };
}
```

- **Decimal separator: `.` only.** Accepting `,` as a decimal AND locale
  thousands separators is ambiguous (`"1,250"` = 1250 or 1.25?) and a locale
  rabbit hole. MVP is single-currency, dev-for-self; a numeric-ish text input
  standardized on `.` is enough. Escape hatch documented for 3.5. *Alternative:*
  normalize a lone `,`→`.` when no `.` present — deferred, not worth the
  ambiguity now.
- **Empty / whitespace-only** → `'empty'`. **Trailing/leading whitespace**
  trimmed, then parsed.
- **Too many decimals** (`"12.505"` USD, `"1.5"` JPY) → `'too-many-decimals'`.
  We **reject, never silently round** — silently rounding a user's money entry
  erodes trust (mirrors the architecture's "no silent OCR autowrite" stance).
- **Negative** → `'negative'`, rejected. Confirmed against the architecture:
  sign is carried by category `kind` (expense/income), `amount_minor` is the
  magnitude; the form's amount field is a positive quantity. *If the backend
  later stores signed amounts, add an opt-in `{ allowNegative }` — not now.*
- **Overflow** → `Number.isSafeInteger` guard on the result (`'overflow'`).
- **Return a discriminated `ParseMoneyResult`, not throw / not `NaN`.** The
  consumers are a zod transform and RHF; a typed error union maps cleanly to
  field messages. No `parseMoneyOrThrow` variant (no consumer → YAGNI).

### D2 — Exponent source of truth — RECOMMENDATION: hardcoded table

Agree with your lean. `getCurrencyExponent` reads the **hardcoded
`CURRENCY_EXPONENTS`** table for all minor↔major *conversion* (parse,
`toInputString`, and the fraction-digit count fed to Intl). `Intl` is used
**only to render the display string**, and even there we **pin
`minimum/maximumFractionDigits` to our table's exponent** rather than trusting
Intl's per-currency default. Rationale: Hermes and browser V8 ship different
CLDR/ICU vintages; `resolvedOptions()` can disagree across runtimes, and
conversion must be deterministic and identical to the backend's ISO-4217 view.
Deriving the exponent from `Intl` would leak that nondeterminism into stored
values. *Alternative (Intl-derived exponent) rejected* on determinism grounds.

### D3 — Currency registry scope — RECOMMENDATION: enumerate non-2 exponents, default 2

- **(a) Table = every ISO-4217 currency whose exponent ≠ 2; unknown → default
  2.** This is the key correctness argument: the set of exponent-0 and
  exponent-3 currencies is small and stable, so enumerating *all* of them makes
  "default 2 for anything unlisted" **safe** — no real currency is silently
  mis-scaled by 100×. Shipping all ~180 codes would be dead weight; shipping
  only the exceptions is complete for conversion.

  ```ts
  const CURRENCY_EXPONENTS = {
    // exponent 0
    BIF:0, CLP:0, DJF:0, GNF:0, ISK:0, JPY:0, KMF:0, KRW:0, PYG:0, RWF:0,
    UGX:0, VND:0, VUV:0, XAF:0, XOF:0, XPF:0,
    // exponent 3
    BHD:3, IQD:3, JOD:3, KWD:3, LYD:3, OMR:3, TND:3,
  } as const;
  ```

  Unknown / not-listed well-formed code (e.g. an OCR result from stage 2) →
  **fallback exponent 2, do not throw.** A receipt yielding an odd-but-real code
  must not crash the client; the code *shape* is validated separately by
  `currencyCodeSchema`. *Alternative (throw on unknown) rejected* — too brittle
  for the OCR path. Accepted residual risk: the two exponent-4 units of account
  (CLF, UYW) are excluded — they are non-transactional and will not appear on a
  receipt; if one ever does it renders with 2 decimals. Flagged in Risks.

- **(b) Symbol / display-name data: LEFT OUT (YAGNI).** `formatMoney` uses
  `Intl.NumberFormat(..., { style: 'currency' })`, which already renders the
  symbol from the code — no home-grown symbol table needed. A currency
  name/symbol registry only has a consumer at **3.5** (the picker), and even
  then `Intl.DisplayNames` may cover it. Not in 0.4.

### D4 — Base-currency concept — RECOMMENDATION: export nothing

`base_currency` is **server state** in `profiles`, arriving via the profile API
at 1.2+; on the client it belongs in the TanStack Query cache, not a shared
constant. A `DEFAULT_CURRENCY = 'USD'` in shared would be a config value
masquerading as a util, and would risk drifting from what the server considers
the user's base. No export has a nameable consumer that couldn't read it from
the profile. **Nothing shipped for base currency.** *Alternative* (a
`DEFAULT_CURRENCY` const consumed by the 1.6 form default) rejected — the form
default is the profile's `base_currency`, not a hardcoded shared const. I agree
with the skeptical lean in your framing.

### D5 — Formatting API — RECOMMENDATION

Signatures as in §1. **Intl options used, exhaustively:**

- `formatMoney`: `Intl.NumberFormat(locale, { style: 'currency', currency,
  currencyDisplay: 'symbol', minimumFractionDigits: exp, maximumFractionDigits: exp })`
- `formatAmount`: `Intl.NumberFormat(locale, { style: 'decimal',
  minimumFractionDigits: exp, maximumFractionDigits: exp, useGrouping: true })`
- `toInputString`: **no Intl** — pure string math (pad `minor.toString()` to
  `exp+1`, splice in `.`), float-free and deterministic.

**Explicitly AVOIDED** (patchy Hermes support): `currencySign: 'accounting'`,
`notation: 'compact'`, `roundingMode`, `roundingPriority`,
`trailingZeroDisplay`, `signDisplay`. Default `locale` = `undefined` (host
default) in app code, but **all tests pin `'en-US'`**.

The **one controlled float boundary**: `formatMoney`/`formatAmount` must hand
Intl a *major* Number, computed as `minor / 10 ** exp`. This is the only place a
float appears; it is immediately rounded by Intl to exactly `exp` fraction
digits (absorbing the ≤1e-16 IEEE error), and inputs are guarded with
`Number.isSafeInteger(minor)` (throw a clear `RangeError` if violated — a
programming error, not user input). All value-affecting arithmetic (parse,
round-trip) stays integer/string. `toInputString` is fully float-free, so the
form round-trip (`parseMoney` ↔ `toInputString`) never touches a float.

**Unknown-currency behavior:** guard `CURRENCY_CODE_PATTERN`; a malformed code
throws `RangeError` (programmer error). A well-formed but unknown code uses
fallback exponent 2 and Intl renders the code as its own "symbol"
(`"XYZ 12.50"`) — engines do not throw for well-formed unknown codes.

`formatAmount` (symbol-less) is kept — consumer named above (charts). I am
**adding `toInputString`** beyond your D5 framing: it is the necessary inverse of
`parseMoney` for edit-form prefill and must be grouping-free / `.`-separated,
which neither `formatMoney` nor `formatAmount` (locale grouping) provides.
Surfaced explicitly so you can accept/reject.

### D6 — Minor-unit representation — RECOMMENDATION: `number`

Use **`number`**. `Number.MAX_SAFE_INTEGER` ≈ 9.0e15 minor units ≈ 90 trillion
major units — far beyond personal-budget magnitudes. It also matches the
generated api-client: `amount_minor` is PG `BigInteger` but crosses the wire as
a JSON number (JSON has no bigint), so the client types it `number`; using
`bigint` in shared would force a lossy/awkward conversion at every boundary.
**Guard strategy:** `Number.isSafeInteger` at both boundaries — inside
`parseMoney` (→ `'overflow'` error) and inside the format helpers (→ `RangeError`
on out-of-range input). *Alternative (bigint) rejected* — misaligned with the
api-client and can't represent the fractional major value Intl needs anyway.

### D7 — Date helpers — RECOMMENDATION: 3 helpers, no date library

Ship `formatApiDate`, `toApiDate`, `todayApiDate` (§1). Kill the
timezone-shift bug by **never constructing a Date from the raw ISO date string**:

```ts
function formatApiDate(isoDate: string, options?: { locale?: string }): string {
  const [y, m, d] = isoDate.split('-').map(Number);   // no new Date('2026-07-24') (UTC!)
  const local = new Date(y, m - 1, d);                 // local midnight
  return new Intl.DateTimeFormat(options?.locale, { dateStyle: 'medium' }).format(local);
}
function toApiDate(date: Date): string {               // local Y-M-D, zero-padded
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
const todayApiDate = () => toApiDate(new Date());
```

Intl option used: `{ dateStyle: 'medium' }` only (well-supported on Hermes).
**No `formatDateTime`** — `created_at` has no 1.x display consumer (leave until a
task actually renders it). **No date library (dayjs/date-fns).** These helpers
are ~15 lines of pure `Date`/string math; a lib is unjustified weight and — under
the hoisted linker — becomes phantom-visible repo-wide. Confirmed: no date lib.

### D8 — Zod scope — RECOMMENDATION: (b) primitives only, no full form schema

Ship the **reusable hard part** and defer form assembly:

- `moneyAmountSchema(currency)` — the money string→minor transform with
  per-currency validation, the genuinely tricky bit both clients must share
  byte-for-byte.
- `currencyCodeSchema` — shape validation.

**Do NOT ship `transactionFormSchema` in 0.4.** Consumer-horizon argument: the
transaction *contract* is fixed by **1.4** (note max length, `category_id` UUID
shape, whether currency is user-selectable pre-3.5) and the actual forms by
**1.5/1.6** (web) / **1.8** (mobile). Baking provisional constraints now
guarantees a 1.4 contradiction → rework and web/mobile drift. The forms compose
their `z.object({...})` from these primitives once the constraints are real.
*Alternative (a)* full schema now — rejected (premature). *Alternative (c)* no
zod at all — rejected: the money transform is exactly the shared, break-prone,
test-worthy piece that justifies 0.4.

Transform sketch (zod v4):

```ts
function moneyAmountSchema(currency: string) {
  return z.string().transform((raw, ctx) => {
    const r = parseMoney(raw, currency);
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', params: { reason: r.error },
        message: MONEY_ERROR_MESSAGES[r.error] });
      return z.NEVER;
    }
    return r.minor;                       // string in, number (minor units) out
  });
}
```

**zod declared in `packages/shared` `dependencies` (runtime, exact pin `4.4.3`)
— NOT devDependencies** (schemas + inferred types are exported at runtime).
Version verified today via `npm view zod version` → 4.4.3 (v4 era, as the task
predicted). **Hoisted-linker note:** adding zod makes it phantom-visible across
the whole repo; `apps/web` and `apps/mobile` that later import `zod` *directly*
(their own schemas) **must declare `zod` in their own package.json** — do not
rely on the phantom hoist. Consuming `@budget/shared`'s schemas pulls zod
transitively and is fine.

### D9 — PACKAGE_NAME — RECOMMENDATION: retire now, re-point the 4 files as a live canary

Retire `PACKAGE_NAME` and re-point the four scaffold-lifetime files to
`formatMoney(...)`, turning the **mobile render into a live Hermes/Intl canary**
— this surfaces the D5 Hermes risk at runtime immediately, at zero extra cost,
and the wiring smoke tests then prove not just workspace *resolution* but actual
*execution* of a real util per runtime (their 0.1 §1.2 purpose is preserved).
All four use `formatMoney(12345, 'USD', { locale: 'en-US' })` → **`"$123.45"`**
(locale-pinned → deterministic; basic USD formatting is stable across ICU
versions — no exotic locale/currency in smoke tests).

Exact edits:

| File | Owner @ /implement | Edit |
|---|---|---|
| `apps/web/src/App.tsx` | frontend (me) | import `formatMoney`; render `Budget — {formatMoney(12345, 'USD', { locale: 'en-US' })}` |
| `apps/web/src/App.test.tsx` | frontend (me) | assert rendered html `toContain('$123.45')` |
| `apps/mobile/app/index.tsx` | mobile-engineer | import `formatMoney`; `Text` = `Budget — mobile scaffold ({formatMoney(12345,'USD',{locale:'en-US'})})` |
| `apps/mobile/src/wiring.test.ts` | mobile-engineer | assert `formatMoney(12345,'USD',{locale:'en-US'}) === '$123.45'` |

**Caveat to record for senior-lead:** the mobile *test* runs under vitest
(Node/V8), so it proves resolution+execution in Node, **not** Hermes; only the
**running app screen** exercises Hermes — that's mobile-qa's manual check. The
two mobile edits require mobile-engineer coordination via senior-lead.
*Alternative (keep `PACKAGE_NAME`)*: simpler, no cross-team edit, but leaves a
consumer-less export alive and forfeits the free canary — rejected. Mild
redundancy (a `formatMoney` break fails both unit and wiring tests) is
acceptable: the wiring test's *purpose* is cross-package execution, and asserting
a real value fulfils it without being vacuous.

---

## 4. Test plan (replaces the deleted placeholder)

No vacuous/tautological tests; each case contrasts a distinct behavior.

**`money.test.ts`**
- `getCurrencyExponent`: `JPY`→0, `KWD`→3, `USD`→2, unknown `'ZZZ'`→2 (default).
- `parseMoney` accept: `"12.50"/USD`→1250; `"12.5"/USD`→1250 (pad); `"100"/JPY`
  →100; `"1.234"/KWD`→1234; `"0"/USD`→0; `"  12.50  "/USD`→1250 (trim);
  `"007.50"/USD`→750 (leading zeros).
- `parseMoney` reject (distinct error codes): `""`→empty; `"abc"`/`"1.2.3"`→
  malformed; `"-5"`→negative; `"12.505"/USD` & `"1.5"/JPY`→too-many-decimals;
  a value past `MAX_SAFE_INTEGER` (e.g. `"99999999999999999"`)→overflow.
- Round-trip: for `[1250/USD, 100/JPY, 1234/KWD, 0/USD]`,
  `parseMoney(toInputString(m,c),c)` returns `{ok:true, minor:m}` — proves the
  parse↔input-string inverse is exact and float-free.
- `toInputString`: 1250/USD→`"12.50"`, 5/USD→`"0.05"`, 100/JPY→`"100"`,
  1234/KWD→`"1.234"` (exp-0 has no dot; exp-3 pads).
- Format (all `locale:'en-US'`, stable outputs): `formatMoney(1250,'USD')`→
  `"$12.50"`; `formatMoney(100,'JPY')`→`"¥100"` (0 fraction digits proves the
  pinned exponent); `formatMoney(1234,'KWD')`→3-fraction output;
  `formatAmount(1250,'USD')`→`"12.50"` (no symbol).
- Safe-integer guard: `formatMoney(Number.MAX_SAFE_INTEGER+1,'USD')` throws.

**`dates.test.ts`**
- **TZ-shift guard:** pin `process.env.TZ = 'America/Los_Angeles'` (negative
  offset) at the top of the file *before* importing `./dates` — helpers build
  `Date` lazily inside functions, so the TZ is honored. Assert
  `formatApiDate('2026-07-24','en-US') === 'Jul 24, 2026'` — the bug (`new
  Date('2026-07-24')` → UTC midnight → "Jul 23" in LA) would make this fail.
  Implementation caveat: if the runner caches TZ, fall back to configuring TZ in
  the `test` script; the assertion itself is the guard either way.
- `toApiDate(new Date(2026,0,5))` → `"2026-01-05"` (zero-pad month+day).
- `todayApiDate()` matches `/^\d{4}-\d{2}-\d{2}$/` and equals
  `toApiDate(new Date())` (local, not UTC).

**`schemas.test.ts`** (thin-wrapper tests — prove wiring, don't re-enumerate
parse cases already covered in money.test)
- `moneyAmountSchema('USD')`: `.parse("12.50")`→1250 (transform wires through);
  `.safeParse("12.505")` fails with issue reason `too-many-decimals` (proves the
  error surfaces as a zod issue, contrasting the accept case).
- `moneyAmountSchema('JPY')`: `.safeParse("1.5")` fails — proves the factory
  threads currency into the exponent check (contrast vs USD accepting `"1.50"`).
- `currencyCodeSchema`: accept `"USD"`; reject `"usd"`, `"US"`, `"DOLLAR"`
  (accept/reject pairs on the shape).

**`currencies.test.ts`** — folded into `money.test.ts` (`getCurrencyExponent`
cases above); a separate file would only re-assert the same lookups → omitted to
avoid redundancy.

Determinism: every format assertion pins `'en-US'`; all chosen outputs
(`"$12.50"`, `"¥100"`, `"12.50"`, `"Jul 24, 2026"`) are ICU-stable basics. No
assertion depends on host locale or ICU vintage.

---

## 5. package.json changes (`packages/shared`)

```jsonc
"dependencies": {
  "zod": "4.4.3"          // NEW — runtime, exact pin (verified latest stable)
}
```

No script changes (`lint`/`typecheck`/`test` already present and sufficient).
No new devDeps (vitest 4.1.10, typescript 5.9.3 already there). **No root-file
changes.** The exports map still points at `src/index.ts` (source, no build);
the barrel re-exporting `schemas.ts` pulls zod at consumer build time — fine
under bundler resolution.

**STOP-and-flag check:** I do not believe any root file needs to change. Turbo's
`@budget/shared#test` uses default inputs (fine). If review finds a root change
is actually required, it goes to backend-engineer (0.1 §1.1) — I will not touch
root.

---

## 6. Carry-forward checklist

| Item | Status in this plan |
|---|---|
| Placeholder `src/index.test.ts` deleted/absorbed (0.1 §1.3) | Deleted; purpose absorbed by money/dates/schemas tests + D9 wiring smoke tests |
| Exact version pins for node deps | `zod` pinned `4.4.3` (no `^`/`~`); verified via `npm view zod version` |
| No root-file edits (0.1 §1.1 backend owns) | None; explicit STOP-and-flag if review disagrees |
| Hoisted-linker phantom-dep note for zod (0.3) | Documented (D8): web/mobile must self-declare zod if importing it directly |
| Every export has a named 1.x–3.x consumer | Tables in §1; consumer-less items (symbol table, DEFAULT_CURRENCY, formatDateTime, full transactionFormSchema) left out and flagged YAGNI |

---

## 7. Risks / open questions (each an either/or + recommendation)

1. **Hermes Intl divergence (mobile).** Expo/Hermes `Intl.NumberFormat` currency
   support and bundled locale data vary by SDK. *Either* trust Intl on-device
   *or* ship a formatting fallback. **Recommend:** trust it, keep the options
   surface minimal (D5 list), and rely on the D9 canary + mobile-engineer review
   to catch gaps early. **Open for mobile-engineer:** confirm `style:'currency'`
   + `dateStyle:'medium'` render correctly on the target Expo SDK's Hermes.
2. **Controlled float in `formatMoney`.** *Either* accept the single
   `minor/10**exp` division (guarded, Intl-rounded) *or* hand-build the grouped
   string. **Recommend** the division — hand-building loses locale symbol
   placement/decimal char and reimplements grouping for no real gain.
3. **`.`-only decimal separator.** *Either* `.`-only now *or* locale-aware comma
   parsing. **Recommend** `.`-only for MVP; revisit at 3.5 with the currency
   picker. Risk: comma-locale users typing `"12,50"` get a `malformed` error —
   acceptable for dev-for-self MVP.
4. **Unknown-currency exponent = default 2.** Safe *only* because every non-2
   ISO-4217 code is enumerated (D3). Accepted residual: exponent-4 units
   CLF/UYW excluded (won't appear on receipts). *Either* accept *or* add a full
   ISO table. **Recommend** accept.
5. **Date-test TZ pinning.** Node TZ caching can blunt `process.env.TZ` set at
   runtime. *Either* set it top-of-file *or* in the `test` script. **Recommend**
   top-of-file with a script-level fallback if flaky; the assertion is the guard
   regardless.
6. **`toInputString` addition (beyond your D5 framing).** I added it as the
   float-free inverse of `parseMoney` for edit-form prefill. *Either* keep it
   *or* have 1.6 derive the prefill string ad hoc. **Recommend** keep — the
   round-trip is exactly the kind of shared, break-prone logic 0.4 should own and
   test once.
