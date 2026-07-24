# Implementation Report — shared-package-core (roadmap 0.4)

Status: **complete, all gates green, ready for PM review. NO commits made** (per
PM instruction; working tree holds the full diff).

Slices: frontend-engineer (packages/shared + web re-points, plus one gated
fix-back), mobile-engineer (two D9 edits + expo boot check). Senior-lead read
every diff before acceptance; one defect found and fixed at the gate (SL-1
below).

## Changed files

- `packages/shared/src/` — NEW: `money.ts`, `currencies.ts`, `dates.ts`,
  `schemas.ts`, `money.test.ts`, `dates.test.ts`, `schemas.test.ts`;
  REWRITTEN: `index.ts` (barrel, PACKAGE_NAME gone); DELETED: `index.test.ts`
  (placeholder); NEW: `packages/shared/README.md` (AM2 notes).
- `packages/shared/package.json` — zod `4.4.3` (deps, exact pin); `test`
  script pins `TZ='America/Los_Angeles'` (see Deviations 1).
- `apps/web/src/App.tsx`, `App.test.tsx` — D9 re-point to
  `formatMoney(12345,'USD',{locale:'en-US'})` / assert `$123.45`.
- `apps/mobile/app/index.tsx` (render-only Hermes canary),
  `apps/mobile/src/wiring.test.ts` (Node-scope comment + real-value assert).
- `pnpm-lock.yaml` — sanctioned update from `pnpm install` (zod).
- **FLAG:** `PLAN.md` shows an unattributed working-tree edit (0.4 status
  ⬜→🔄). Neither engineer claims it; senior-lead did not sanction it and left
  it untouched rather than revert a possibly-PM-authored change. PM to keep or
  drop at commit time.

## Per-amendment / carry-forward checklist (grooming-review §4, ticked individually)

| Row | Verdict | Evidence |
|---|---|---|
| Placeholder `index.test.ts` dies (0.1 §1.3) | ✓ | Deleted; absorbed by 3 real test files (26 tests) + re-pointed web/mobile wiring tests |
| Root-file ownership / no root edits by frontend | ✓* | No engineer root edits except sanctioned lockfile; *PLAN.md flag above (unattributed, left untouched) |
| Exact version pins | ✓ | zod `4.4.3`, re-verified `npm view zod version` at /implement (unchanged); no ranges |
| Hoisted phantom-dep discipline | ✓ | README + plan note; neither app imports zod directly yet; rule recorded for 1.5+/1.8 |
| Every export names a consumer | ✓ | Barrel = plan §1 exactly (15 symbols incl. 2 error types = AM4 contract); YAGNI exclusions upheld (no symbol table, no DEFAULT_CURRENCY, no formatDateTime, no transactionFormSchema) |
| No-vacuous-tests | ✓ | Contrasting accept/reject pairs, round-trip proofs, distinct error codes; no cache test (vacuous); currencies.test.ts folded into money.test.ts |
| AM1 memoized formatter cache | ✓ | Module-level Maps in money.ts (`locale\|currency\|exp`, `locale\|decimal\|exp`) and dates.ts (`locale\|medium`), signatures unchanged |
| AM2 canary/locale notes | ✓ | README "Locale / Hermes notes" + top-of-file comments; `locale` optional; 1.8 expo-localization intent recorded |
| AM3 `.5`/`12.` accepted | ✓ | `/^(?:\d+(?:\.\d*)?|\.\d+)$/`; tests: `.5`→50, `12.`→1200, `.`→malformed |
| AM4 MONEY_ERROR_MESSAGES + params.reason | ✓ | Internal non-exported record; zod issue carries `params.reason` = MoneyParseError; schemas test asserts `reason === 'too-many-decimals'` |
| AM5 no dead branch | ✓ | Leading-zero strip removed entirely; `Number("00750")`→750; `"0"`→0 and `"007.50"`→750 tested |
| D9 mobile edits by mobile-engineer | ✓ | Two-file diff exactly per plan D9 table; render-only screen, Node-scope comment in wiring test |
| Per-amendment reporting at /implement | ✓ | This table |

## Senior-lead gate findings (beyond the plan)

- **SL-1 (fixed at gate):** `toInputString` lacked input guards while sibling
  format helpers throw — `toInputString(-5,'USD')` returned garbage `"0.-5"`
  (edit-form prefill path). Fixed: `assertNonNegativeMinor` (safe integer AND
  ≥ 0, RangeError) + one contrast test (`-5`, `12.5` both throw). Negative
  stays legal for `formatMoney` (negative nets are legitimate display values).
- Exponent tables independently verified against ISO 4217 (16 exp-0 + 7 exp-3
  complete for transactional codes; CLF/UYW exclusion sound).
- Overflow guard verified un-bypassable (any digit string > 2^53 rounds to a
  non-safe integer).

## Acceptance evidence

1. Full gate: `TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test
   pnpm turbo lint typecheck test --env-mode=loose` → **15/15 successful**
   (shared 26 tests, web 1, mobile 1, api suite).
2. API tests additionally **force-run uncached** against live Postgres on 5443
   → 3 passed (compose file maps 5433 but this machine's container runs on
   5443 — 5433 occupied by another project; `.env` already points at 5443,
   conftest overridden via TEST_DATABASE_URL, hence `--env-mode=loose`).
3. Expo boot check: Metro ready on :8092; expo-router entry bundle fetched
   HTTP 200 (~6.9 MB); grep hits `formatMoney`×6, `12345`×4,
   `packages/shared`×6, `UnableToResolveError`×0; transpiled call site
   `(0, _budgetShared.formatMoney)(12345, 'USD', …)` present; zod and
   @budget/shared resolved by Metro; process killed, port freed.
   **Acceptance criterion corrected (transparency):** the PM's "bundle must
   contain the formatted money string" is not satisfiable literally —
   `"$123.45"` is computed at runtime by Intl and is correctly ABSENT from the
   bundle. The check proves boot + resolution + call-site presence; actual
   Hermes render of `$123.45` is deferred to mobile-qa's manual device
   checklist per AM2.

## Deviations from plan (all flagged by the implementers, accepted by senior-lead)

1. **TZ pin moved to the `test` script** (plan's recorded fallback):
   `process.env` in a test file fails typecheck without `@types/node`, and
   script-level TZ beats Node's TZ caching anyway. The TZ-shift assertion
   (`'2026-07-24'` → `'Jul 24, 2026'` under America/Los_Angeles) is the guard.
2. **KWD format asserted via `toContain('1.234')`** not an exact string — the
   symbol/amount separator char for KWD is ICU-vintage dependent; the
   3-fraction pinning (vs USD's 2) is still proven.
3. Boot-check bundle criterion corrected as described above.
