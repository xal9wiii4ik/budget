# Mobile Review: shared-package-core (roadmap 0.4)

Reviewer: mobile-engineer. Scope: React Native / Hermes viability of the planned
`packages/shared` API surface. Target runtime: Expo SDK ~57, React Native 0.86.0,
React 19.2.3, Hermes (from `apps/mobile/package.json`). Grooming-stage review only.

Key runtime fact this review rests on: Hermes' `Intl` is **platform-backed** —
Android delegates to the OS ICU4J/`java.text`; iOS delegates to Foundation
(`NSNumberFormatter`/`NSDateFormatter`). Expo's Hermes build is the **Intl-enabled
variant**, so `Intl.NumberFormat` and `Intl.DateTimeFormat` exist at runtime and
draw locale data from the OS (not a JS-bundled CLDR). That makes broad-locale
support a strength, but makes exact output OS/ICU-vintage dependent.

---

## 1. `Intl.NumberFormat` option sets (D5) — OK

Neither option set will **throw** on the pinned Hermes. Every option used is in
the pre-"NumberFormat v3" baseline that platform-backed Hermes supports:
`style:'currency'|'decimal'`, `currency`, `currencyDisplay:'symbol'`,
`minimum/maximumFractionDigits`, and `useGrouping:true` (boolean form — accepted;
the newer string form `'auto'|'always'` is unnecessary and not used). No
construction-time RangeError for well-formed currency codes.

The plan's claim "basic USD en-US formatting is stable" is **safe** for the D9
wiring assertion, but only because of *where* it is asserted: the vitest wiring
test runs on Node (V8 + full ICU) → `formatMoney(12345,'USD',{locale:'en-US'})`
is deterministically `'$123.45'`. The on-device render is the true Hermes surface;
for the pinned `en-US`/USD case, both Android ICU and iOS Foundation render `$`
before the amount with a `.` decimal and `,` grouping — i.e. `$123.45` — across
all realistic ICU vintages on this SDK. The classic divergences (NBSP vs space,
`US$` vs `$`, symbol placement) bite for **non-US-English device locales and
non-USD currencies**, none of which the canary exercises. Worst case on device is
*different rendering*, not a throw — acceptable for a canary. Verdict OK.

Minor note (not a change to 0.4): `formatMoney(100,'JPY')` in `money.test.ts`
asserts `'¥100'` on Node — fine there; do not let anyone port that exact-string
JPY assertion to an on-device test, as Android ICU can render `JP¥` / `￥`
(fullwidth). The plan keeps all such assertions in Node vitest, so this is a
guardrail note, not a defect.

## 2. `Intl.DateTimeFormat { dateStyle: 'medium' }` (D7) — OK

Supported on this SDK. `dateStyle`/`timeStyle` are platform-backed on Hermes
(map to `NSDateFormatterMediumStyle` / Android `DateFormat.MEDIUM`). The early-
Hermes era where `dateStyle` threw "not supported" is long past for RN 0.86.
Crucially, `formatApiDate` builds a **local** `Date` from split components and
formats a date-only style, so no timezone conversion is exercised — see §7.
Verdict OK.

## 3. Avoided-options list (D5) — OK, complete enough

The avoided set (`currencySign:'accounting'`, `notation:'compact'`,
`roundingMode`, `roundingPriority`, `trailingZeroDisplay`, `signDisplay`) is
exactly the ES2023 NumberFormat-v3 surface that is patchy/absent on platform-
backed Hermes — correctly excluded. Nothing *in the used set* is a known Hermes
gap. Locale-fallback for a device locale with "no bundled data" is a non-issue
here: locale data is the OS's, so Hermes falls back through the OS resolution
chain to the OS default rather than failing — more robust than a JS-bundled ICU.
`undefined` locale is covered in §4. Verdict OK.

## 4. Default `locale: undefined` (host default) — OK, keep `locale` OPTIONAL

On platform-backed Hermes, `new Intl.NumberFormat(undefined, …)` resolves to the
OS default locale (`resolvedOptions().locale` reflects it). It does **not**
require `Intl.getCanonicalLocales`. So the host-default behavior is sensible and
no code change is needed for 0.4.

I do **not** want `locale` made required — that would force every web call site
to thread a locale for no benefit and break the clean host-default default. Keep
it optional. The one real-world caveat is a **1.8 client concern, not a 0.4 API
change**: Hermes' notion of "host default" has historically been less reliable
than `expo-localization`'s device-locale read on some Android OEM configs, so the
1.8 mobile screens should pass an explicit locale sourced from `expo-localization`
rather than rely on `undefined`. The current API shape already supports this
(`options.locale`), so nothing to change now — just recording the 1.8 intent.
Verdict OK (API shape correct as-is).

## 5. zod 4.4.3 on Metro / Hermes — OK

zod v4 is pure JS/ESM, no native deps, no `eval`, no `Intl` reliance, no
Node-only builtins on its hot path. Metro resolves its `exports` map fine and
Hermes runs it (it relies only on `RegExp`/`Object`/`Symbol`, all present). No
known Metro-bundling or Hermes-runtime issue at 4.4.3. I confirm the D8
hoisted-linker note: because `packages/shared` declares zod as a runtime dep and
the linker is `hoisted`, zod becomes phantom-visible repo-wide; if `apps/mobile`
later authors its *own* schemas importing `zod` directly it must self-declare zod
in its `package.json` (today it does not import zod directly — it only consumes
`@budget/shared`, which is fine transitively). Verdict OK.

## 6. D9 edits I'd own (`app/index.tsx` + `src/wiring.test.ts`) — OK / agree

- `src/wiring.test.ts` asserting `formatMoney(12345,'USD',{locale:'en-US') === '$123.45'`
  runs under vitest on **Node/V8 + full ICU** → deterministic `'$123.45'`.
  Asserting the exact string there is **safe**. I agree it proves cross-package
  *resolution + execution*, not Hermes.
- `app/index.tsx` should **render only, assert nothing** — correct as planned.
  It pins `{locale:'en-US'}`, which makes it a "does Hermes Intl execute the
  currency path without throwing, and roughly right for the stable case" canary.
  That is the right minimal canary; it must not gain an on-device string
  assertion (device ICU vintage is not ours to pin). mobile-qa eyeballs the
  rendered `$123.45` manually.

One lean amendment I want recorded (§7 item): the pinned-`en-US` canary will
*not* surface the real device-locale divergences (e.g. `US$` on an en-GB device),
because it hardcodes the locale. That is acceptable for 0.4 — the canary's job is
"Intl currency path runs on Hermes," not "locale matrix is correct." I flag it so
no one over-reads a green canary as proof of locale correctness. I agree with the
D9 edits as written; the two mobile edits are mine at /implement, coordinated via
senior-lead.

## 7. Anything that fights RN at 1.8 — one CONCERN (perf note), Date handling OK

**Date/TZ handling — OK.** Hermes' historically incomplete Android TZ database is
**not** triggered by these helpers: `formatApiDate` never does UTC parsing (no
`new Date('2026-07-24')`), builds a local `Date` from components, and formats a
date-only style; `toApiDate`/`todayApiDate` use local `getFullYear/Month/Date`.
No named-zone or UTC-offset math runs, so there is nothing for Hermes TZ data to
get wrong. Good — the D7 pattern is exactly right for Hermes.

**CONCERN (minor, non-blocking) — per-call `Intl.NumberFormat` construction.**
On platform-backed Hermes, constructing an `Intl.NumberFormat`/`DateTimeFormat`
crosses into OS ICU/Foundation and is materially more expensive than the same
construction on V8. The 1.8 transaction list is a `FlatList` that re-renders many
rows; `formatMoney`/`formatAmount`/`formatApiDate` each constructing a fresh
formatter per cell per render is a real, measurable JS-thread cost on Android
mid-tier devices, and it is invisible in the Node vitest suite.

Fix (cheap, benefits both clients, keeps 0.4 a utilities task): have the shared
money/date helpers hold an **internal memoized formatter cache** keyed by
`(locale ?? '', currency, exp)` / `(locale ?? '', 'medium')`, so repeated calls
reuse one `Intl.*` instance. This is an implementation-only detail behind the
already-planned signatures — no API-surface change, no consumer churn. If the plan
prefers not to add caching in 0.4, then at minimum add a one-line note in D5/Risks
that 1.8 mobile must memoize formatters at the list layer. I mildly prefer the
shared-cache option because it fixes the cost once for web and mobile instead of
pushing an easy-to-forget obligation onto every list screen. Verdict: CONCERN
with fix.

---

## Overall verdict: approve with amendments

The Intl/Hermes portability core is sound — nothing in the used option sets
throws on Expo SDK ~57 Hermes, `dateStyle:'medium'` is supported, the Date
helpers correctly sidestep Hermes TZ pitfalls, zod 4.4.3 bundles/runs cleanly,
and the D9 Node-vs-Hermes distinction is stated honestly. No blockers.

Amendments requested (all lightweight, none change the API signatures):
1. **[minor, primary]** Add an internal **memoized formatter cache** inside the
   shared money/date helpers (keyed by locale+currency+exponent), or, failing
   that, a D5/Risks note that 1.8 mobile must memoize formatters at the list
   layer. Rationale: per-call `Intl.*` construction is a real JS-thread cost on
   Hermes/Android and is invisible to the Node test gate. (§7)
2. **[note only]** Record in D5/Risks that the `{locale:'en-US'}`-pinned D9 canary
   validates only the "Intl currency path executes on Hermes" case, **not**
   device-locale correctness (`US$`/NBSP divergences); a green canary must not be
   read as locale-matrix proof. (§6)
3. **[note only]** Keep `options.locale` **optional** (do not make it required),
   but note the 1.8 intent that mobile passes an explicit locale from
   `expo-localization` rather than relying on Hermes host-default. API shape is
   already correct; no 0.4 change. (§4)

No rework needed. Items 2–3 are documentation notes; item 1 is the only one worth
an implementation decision, and it lives entirely behind the existing signatures.
