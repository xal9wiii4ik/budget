# FINAL BUNDLE — web-transactions-ui (roadmap 1.6)

Status: **COMPLETE — all pipeline stages passed. Working tree left uncommitted
per instruction (no commits at any stage).**

Pipeline actually run: groom (plan + 32-TC checklist + Phase-4 gate with one
QA send-back) → implement (7 layers) → senior diff gate (PASS, 2 deviations
accepted) → parallel web-qa run (29/0/2+1) + code review (APPROVE-WITH-FIXES,
0 MAJOR) → meta-review (all 9 findings ruled, fix round scoped) → fix round
(9/9 landed, zero deviations) → senior fix-diff verification + independent
uncached gate re-run (this document).

## Final gate evidence (re-run by senior-lead, uncached, post-fix-round)

- `turbo run typecheck lint test --filter=@budget/web --filter=@budget/shared
  --force`: **6/6 tasks green**; web vitest 35/35 (6 files), shared 36/36
  (incl. the new `categoryFormSchema` color-refine contrast test).
- **A4**: `auth/coordinator.test.ts` — diff empty across all rounds; 10/10
  green in the final run. Body-preservation tripwire intact.
- **G1**: `git diff`/`git status` empty for ALL of `packages/api-client`;
  `schema.d.ts` byte-identical; `getErrorCode` unedited.
- **G3**: change surface = `apps/web` + `packages/shared` (+ PLAN.md, PM's own
  edit; + `.tasks/` artifacts).

## Obligation / amendment table — FINAL TICK (all 25 + 3 amendments)

Evidence columns: code (senior diff gate, diff-gate.md, file:line), review
(review.md "Verified correct"), browser (qa-web-checklist.md TC results).

| Item | Discharged by | Verified |
|---|---|---|
| C1 patch-builder omit-vs-null | lib/patch.ts (clearableChange + emptyToNull post-fix) | code+review+vitest; TC-20/21/23 wire |
| C2 error map + field-level 409 (incl. kind-only) | lib/errors.ts | code+review; TC-20 ✅ TC-21 ✅ TC-22 ✅ |
| C3 Collator re-sort within kind | data/categoryLookup.ts | code+review+vitest; TC-26 ✅ TC-18 ✅ |
| C4 is_system gates edit/archive | CategoryRow/CategoryFormModal | code+review; TC-18 ✅ |
| C5 single categories cache, mutation-row updates | data/categories.ts | code+review; TC-19 ✅ TC-23 ✅ TC-24 ✅ |
| C6 archive=PATCH behind confirm, no DELETE | CategoryFormModal + ConfirmDialog | code+review; TC-23 ✅ (no DELETE on wire) |
| C7 case-insensitive color | patch.ts compare + schema pattern | code+review+vitest; TC-19 ✅ |
| C8 no client dedup gate | (absence verified) | code+review; TC-20 ✅ (request reached server) |
| T1 limit=200 + derived has_more + N-of-M | data/transactions.ts + TransactionsPage | code+review; TC-8 ✅ (250-row month) |
| T2 params.query, from/to as keys, toApiDate | data/transactions.ts | code+review; TC-4 ✅ |
| T3 archived-inclusive join, composite keys, Uncategorized | SummaryHeader/TransactionRow | code+review; TC-7 ✅ TC-17 ✅ (no key warnings) TC-23/24 ✅ |
| T4 formatMoney everywhere; signed net; magnitude inputs | SummaryHeader/TransactionRow/FormModal | code+review; TC-6 ✅ TC-12 ✅ TC-16 ✅ |
| T5 no Kind alias; safe-direction assignment | per-site generated refs | code+review (grep clean); TC-10 ✅ |
| T6 422 string\|ValidationError[] runtime narrow | lib/errors.ts getValidationIssues | code+review+vitest; TC-22 ✅ TC-13 ✅ |
| T7 tx patch discipline | lib/patch.ts | code+review+vitest; TC-13 ✅ (amount-only body) TC-14 ✅ (null-vs-absent on wire) |
| T8 no currency collected; render from data | forms + chip | code+review; TC-6/9/19 ✅ |
| T9 keys, dual-month invalidation, predicate, no GET/{id} | data/transactions.ts (+404 onError post-fix) | code+review; TC-9/12/15/25/27/30 ✅ **TC-31 ✅ (A+B refetched, C untouched — predicate proven live)** |
| T10 shared month helpers + vitest | packages/shared/dates.ts | code+review+vitest (Dec/leap); TC-4 ✅ (year rollover live) |
| A1 me-error affordance | ProtectedLayout | code+review; TC-2 ⚠ blocked (tooling) — path verified by code read |
| A2 bounce authed off /login,/register | Login/RegisterPage | code+review; TC-1 ✅ |
| A3 email-TLD → field-level | auth/errors.ts + lib/errors.ts | code+review; TC-32 ✅ (live: server itself rejected @test.local — feature demonstrably working) |
| A4 body-preservation tripwire | untouched, 10/10 green every round | senior-verified 3× |
| G1 contract byte-identical | api-client untouched | senior-verified 3× + reviewer |
| G2 lint/typecheck/vitest every round | 7 layers + fix round + 2 independent senior re-runs | green throughout |
| G3 root ownership | surface audit | clean |
| AM-1.6-a offset=pageParam, stable-slice key | queryKeys.ts/transactions.ts | code+review; binding for 1.8 |
| AM-1.6-b single archived-inclusive categories source | data/categories.ts | code+review; binding for 1.8 |
| AM-1.6-c kind-SEGMENTED picker sanctioned | TransactionFormModal | meta-review ruling; binding for 1.8 (mobile checklist must not inherit TC-10's "filtered" wording) |

## QA outcome (browser, live)

29 PASS / 0 FAIL / 2 BLOCKED + 1 PARTIAL of 32. Blocked/partial are
tooling-only (browser pane lacks request interception for forced-failure TCs);
TC-2's path additionally verified by code read. Every load-bearing journey
passed live, including the four this task existed to prove: TC-31 (dual-month
invalidation + predicate, by network log), TC-17 (refund double-bucket, zero
React key warnings), TC-13/14 (PATCH omit-vs-null observed on the wire), TC-26
(Cyrillic collation). MANUAL-RESIDUAL items (color feel, focus feel) listed in
the checklist for a human pass. Seed data left in place for reruns (restore
steps documented in the checklist; QA users under @budgetqa.dev).

## Review chain

- review.md: APPROVE-WITH-FIXES — 0 MAJOR / 4 MINOR / 5 NIT.
- meta-review.md: all 9 findings AGREE (calibration deltas stricter: finding 4
  pinned to the stronger emptyToNull variant; NIT 6 upgraded; finding 9's
  schema test made required with a vacuity boundary).
- Fix round: 9/9 landed exactly to scope, zero deviations; every site
  re-verified by senior read (diff-gate standard).

## Deviations ledger (all declared, all ruled)

1. `qk.me` omitted — meQueryKey stays single source. ACCEPTED (diff gate).
2. `key={id}` edit-modal remounts. ACCEPTED (diff gate).
3. Kind-segmented picker vs checklist's "filtered" wording. ACCEPTED →
   AM-1.6-c (meta-review; root cause was checklist wording, not code).
4. Local HEX_COLOR_PATTERN copy in CategoryFormModal (fix round kept shared
   surface closed). ACCEPTED; promotion to a shared export is triggered by a
   second real consumer (mobile 1.8's preview guard), not before.

## Carry-forwards recorded for later tasks

- **1.7 (deploy)**: dev API run on :8010 (uvicorn manual); CORS config must
  cover the deployed web origin per architecture §3.
- **1.8 (mobile MVP)**: AM-1.6-a/b/c are binding patterns; reuse shared
  `transactionFormSchema`/`categoryFormSchema`/month helpers; consider
  exporting the hex pattern from shared when the mobile color preview lands;
  mobile QA checklist must not inherit TC-10's "filtered" picker wording.
- **3.2 (multi-currency)**: real profile GET/PATCH endpoint needed when
  base-currency change UI arrives (R2 workaround — summary-sourced currency —
  is MVP-scoped by design).
- Pre-existing `@budget/api` pytest failures reported by the engineer were
  DB-connectivity (API/DB not running at the time); environment was brought up
  and healthy for QA. Not caused by this diff (which touches no Python).

## State

All changes uncommitted in the working tree. NOT committed, NOT pushed, per
standing instruction. Task 1.6 ready for PM sign-off and PLAN.md status flip.
