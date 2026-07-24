# Grooming Review (Phase 4) — shared-package-core (roadmap 0.4)

Senior-lead critical review of plan.md (frontend-engineer, D1–D9) and
mobile-review.md (mobile-engineer, 7 verdicts + 3 amendments). Verdict:
**accepted with the amendments below.** No artifact goes back for rewrite;
amendments are binding on the implementers.

## 1. Team selection (recorded)

- **frontend-engineer** — plan author; owns `packages/shared` per standing split.
- **mobile-engineer** — API-surface review (mobile-review.md). Decided as
  review-plus-stake, not plan contribution: there was no mobile code to plan,
  but the D9 re-point gives them two files at /implement, and their Hermes/Intl
  verdicts are binding input to D5/D7/D9. This resolves the PM's
  "review-only vs plan contribution" question: review at groom, small
  implementation stake at /implement.
- **architect** — NOT invoked. No DB, no new module; dependency direction
  (shared ← web/mobile) fixed at 0.1 and unchanged; the surface is pure
  functions, decomposed via D1–D9 and cross-checked by the mobile review.
  Judged non-structural.
- **backend-engineer** — NOT invoked. No `apps/api` change; no root-file change
  (verified: `@budget/shared#test` uses turbo default inputs — honest by
  default; zod lands in `packages/shared/package.json`, frontend-owned).
  Contingency stands: any root edit that emerges at /implement goes to
  backend-engineer per 0.1 §1.1.
- **qa-engineer / web-qa / mobile-qa** — NOT invoked for grooming. No
  endpoints, no user-journey change (scaffold text changes trivially under D9).
  The permanent gate is the real vitest suite (plan §4) + my diff review;
  mobile-qa's standing manual checklist picks up the D9 on-screen Hermes canary
  at its next device pass (see AM2).

## 2. Cross-check results (plan ↔ mobile review)

No conflicts. Mobile confirms every Intl option the plan uses is in the
pre-NumberFormat-v3 Hermes-safe baseline on the pinned stack (Expo ~57,
RN 0.86); the plan's avoided-options list (D5) is exactly the v3 surface mobile
flags as patchy — the two documents agree from opposite directions. Mobile's
"worst case is different rendering, not a crash" verdict, plus the plan's
en-US-pinned assertions confined to Node-run tests, closes the determinism
question. zod 4.4.3 on Metro/Hermes: no concern. D9 file edits: agreed by the
owner of those files.

My own verification of the risky spots (not delegated):

1. **Exponent tables (D3).** Checked against ISO 4217: the 16 exponent-0 and
   7 exponent-3 codes are complete for transactional currencies; CLF/UYW
   (exp 4) are non-transactional funds codes — exclusion is sound. Special
   codes (XAU, XXX) fall to the harmless default-2. The "default 2 is safe
   because every non-2 code is enumerated" argument holds.
2. **Overflow guard (D1/D6).** Any integer digit-string > MAX_SAFE_INTEGER
   rounds under IEEE754 to a value ≥ 2^53, all of which fail
   `Number.isSafeInteger` — the guard cannot be bypassed by rounding-down.
3. **Float boundary (D5).** The single `minor / 10**exp` into Intl is
   guarded + immediately rounded to exactly `exp` digits; parse and
   `toInputString` round-trip is fully integer/string. Accepted.
4. **TZ-shift test (D7/§4).** The `new Date(y, m-1, d)` local-construction
   pattern is the correct fix; the LA-pinned test genuinely contrasts the bug.
   TZ-caching fallback (env in test script) is recorded — acceptable.
5. **D9 wiring tests run on Node ICU, not Hermes** — the plan says so itself;
   the on-screen render is the true canary (render-only, no assertion), owned
   by mobile-qa's manual checklist. Correctly scoped.

## 3. Amendments (binding)

- **AM1 — internal memoized formatter cache** (from mobile review, accepted by
  senior-lead). `formatMoney`/`formatAmount`/`formatApiDate` construct their
  `Intl.*Format` instances via a module-level cache keyed by
  locale|currency|exponent (resp. locale|dateStyle). Per-call Intl construction
  is expensive on Hermes/Android and invisible to the Node test gate; fixing it
  once in shared beats duplicating memoization in two clients. Implementation
  detail behind unchanged signatures — no API change, no test change required
  (a cache-hit test would be vacuous; correctness tests already cover output).
- **AM2 — canary scope + locale notes recorded** (mobile review notes 2+3):
  (a) the green D9 canary proves "the Intl currency path executes on Hermes",
  NOT device-locale correctness — not locale-matrix proof; (b) `options.locale`
  stays optional; 1.8 intent recorded: mobile passes an explicit locale from
  `expo-localization` rather than leaning on host default. Both land as code
  comments/README notes in the package, not new machinery.
- **AM3 — parser accepts `".5"` and `"12."`** (senior-lead amendment,
  PM may veto back to strict). The plan's regex `/^\d+(\.\d+)?$/` rejects two
  unambiguous, common typing forms. No-silent-rounding is not implicated
  (neither form rounds). Regex becomes `/^(?:\d+(?:\.\d*)?|\.\d+)$/` (bare "."
  still malformed); tests add `".5"/USD → 50`, `"12."/USD → 1200`, `"."` →
  malformed. Rationale: rejecting `".5"` at 1.6/1.8 form-submit would be a
  needless paper cut; the change costs one regex alternative and two tests.
- **AM4 — `MONEY_ERROR_MESSAGES` pinned down.** The D8 sketch references it
  without defining it. Resolution: internal (non-exported) English default
  messages in `schemas.ts`; the zod issue MUST carry `params.reason` =
  `MoneyParseError` code so clients can programmatically map/override messages
  (i18n later). `MoneyParseError` and `ParseMoneyResult` types ARE exported
  (already in §1) — that is the client-facing error contract.
- **AM5 — implementation nit (reviewer checkpoint, not plan rewrite).** In the
  D1 sketch, after the leading-zero strip with lookahead the `digits === ''`
  branch is dead (the lookahead always preserves one digit) — drop the dead
  branch or the lookahead, keep the `"0"→0` behavior tested.

## 4. Per-amendment / carry-forward checklist (Phase 4 obligation)

| Binding item | Source | Where it lands |
|---|---|---|
| Scaffold-lifetime placeholder: `packages/shared/src/index.test.ts` DIES here | 0.1 §1.3 (named carry-forward for 0.4) | ✓ plan §2/§6 — deleted; purpose absorbed by real tests + D9 wiring tests |
| Root-file ownership = backend-engineer; frontend touches no root file | 0.1 §1.1 | ✓ plan §5 STOP-and-flag; verified no root change needed (turbo default inputs) |
| Exact version pins | 0.1 | ✓ zod `4.4.3` (verified via `npm view` at groom time; re-verify pin at /implement) |
| Hoisted-linker phantom-dep discipline | 0.1 §1.1 / 0.3 note | ✓ plan D8: web/mobile must self-declare zod when importing it directly at 1.5+/1.8 |
| Every export names a roadmap consumer | PM directive this task | ✓ plan §1 tables; YAGNI exclusions recorded (symbol table, DEFAULT_CURRENCY, formatDateTime, transactionFormSchema) |
| No-vacuous-tests (TS application of pytest conventions) | 0.1 §1.3 spirit | ✓ plan §4: contrasting accept/reject pairs, round-trip proofs; currencies.test.ts deliberately omitted as redundant; AM1 cache explicitly NOT tested (vacuous) |
| AM1–AM5 (this review) | here | AM1/AM3/AM4/AM5 fold into frontend's implementation; AM2 lands as comments/README note; AM3 adds 3 test cases |
| D9 mobile edits | plan D9 | mobile-engineer owns `apps/mobile/app/index.tsx` + `src/wiring.test.ts` at /implement; web files frontend-owned |
| Per-amendment reporting at /implement | 0.1 retro / standing rule | Implementation report MUST tick every row of this table individually |

## 5. Decisions made this grooming (PM may veto, no answer required)

- API surface = plan §1 exactly: `parseMoney`/`formatMoney`/`formatAmount`/
  `toInputString`/`getCurrencyExponent` + `CURRENCY_EXPONENTS`/
  `CURRENCY_CODE_PATTERN` + 3 date helpers + `currencyCodeSchema`/
  `moneyAmountSchema`. Single `.` entry, no subpath exports.
- D1: string/integer parsing, `.`-only decimal separator, reject negatives
  (sign lives on category kind), reject too-many-decimals (no silent rounding),
  discriminated result — accepted, plus AM3.
- D2: hardcoded exponent table is the sole conversion source of truth; Intl is
  display-only with fraction digits pinned to our table — accepted (cross-runtime
  CLDR divergence must not leak into stored values).
- D3: exception-only registry (all non-2-exponent codes), unknown → 2, never
  throw on well-formed codes; no symbol/name data (YAGNI until 3.5) — accepted.
- D4: NOTHING exported for base currency — it is server state (`profiles`),
  belongs in the Query cache — accepted.
- D6: `number` + `isSafeInteger` guards; bigint rejected (api-client JSON
  alignment) — accepted.
- D7: 3 date helpers, no date library, no `formatDateTime` — accepted.
- D8: zod primitives only (`moneyAmountSchema` factory + `currencyCodeSchema`);
  NO `transactionFormSchema` in 0.4 — accepted; this is the YAGNI tension the
  PM flagged, resolved toward primitives (see open Q1).
- D9: retire `PACKAGE_NAME`; 4 scaffold files re-point to
  `formatMoney(12345,'USD',{locale:'en-US'})` = `"$123.45"`; mobile screen
  becomes a render-only Hermes canary — accepted (see open Q2).
- `toInputString` added beyond original framing — accepted (float-free inverse
  of parseMoney; consumers: 1.6/1.8 edit prefill, 2.3/2.4 OCR-total prefill).

## 6. Open questions for the PM (veto-style; defaults = recommendations)

1. **Zod scope: primitives-only vs roadmap 0.4's literal "zod-схемы форм".**
   The plan ships `moneyAmountSchema`+`currencyCodeSchema` and defers
   `transactionFormSchema` to 1.6/1.8 (contract fixed at 1.4; provisional
   constraints now = guaranteed rework). **Recommendation: accept
   primitives-only** — the money transform is the shared break-prone piece;
   form assembly is cheap once constraints are real.
2. **Retire `PACKAGE_NAME` now (touches 4 scaffold files in both apps) vs keep
   until 1.5/1.8.** **Recommendation: retire** — zero-cost live Hermes/Intl
   canary on the mobile scaffold screen; wiring tests keep their 0.1 §1.2
   purpose while asserting a real value.
3. **`.`-only decimal separator for MVP** (comma-locale users get a validation
   error until 3.5 revisits). **Recommendation: accept** — locale-aware comma/
   thousands parsing is an ambiguity rabbit hole; dev-for-self MVP.
4. **Exception-only exponent table, unknown → exponent 2, CLF/UYW excluded.**
   **Recommendation: accept** — provably safe for transactional codes; throwing
   on unknown would be brittle for the stage-2 OCR path.
5. **AM3 — accept `".5"`/`"12."`** (my amendment over the plan's stricter
   regex). **Recommendation: accept**; veto restores strict `/^\d+(\.\d+)?$/`.
6. **AM1 — internal memoized formatter cache** (mobile's ask, ~10 lines).
   **Recommendation: accept**; veto moves memoization to each client at
   1.6/1.8.
7. **Nothing exported for base currency** (roadmap 0.4 names "the base-currency
   concept" — resolved as "deliberately nothing; it's server state").
   **Recommendation: accept** — a shared `DEFAULT_CURRENCY` would drift from
   the profile.

No blocking questions. Defaults apply if unanswered; ready for /implement on
PM's go. Implementation order: frontend slice (package + web files) first,
mobile-engineer's two D9 edits after the package lands.
