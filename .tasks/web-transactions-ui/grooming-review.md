# Grooming review (senior-lead, Phase 4) — web-transactions-ui (1.6)

Artifacts under review: plan-web.md (frontend-engineer), qa-web-checklist.md
(web-qa, 30 TCs at time of review). Gate basis: obligations.md (C1-C8, T1-T10,
A1-A4, G1-G3). I independently verified the plan's factual claims before ruling:
`getErrorCode` location (`packages/api-client/src/auth.ts`, hand-written,
re-exported — NOT generated, so G1 is unaffected by the error-layer work),
`safeNextPath` (`auth/next.ts:8`), `useIsAuthenticated` (`auth/useAuth.ts:16`),
`toInputString`/`moneyAmountSchema` shared exports, and (earlier, at team
selection) the summary router source for R2 (`transactions.py` L272-278: summary
returns profile base currency with fallback even for an empty month, read-only).

## Rulings on the two frontend-engineer awareness flags

### Flag 1 — form schemas (`transactionFormSchema`, `categoryFormSchema`) into `packages/shared`. ACCEPTED.

This is not a widening at all: stage 0.4 defines shared's remit as including
"zod-схемы форм" verbatim — the engineer is putting form schemas exactly where
the architecture says they live. The substantive argument seals it: the
note≤500, amount-minor, and hex-color rules must match the server on BOTH
clients; schemas in `apps/web` would force 1.8 to duplicate them (drift risk in
exactly the rules the server enforces) or migrate them mid-task (churn). One
boundary condition I attach: the schemas depend only on zod + shared's own
money helpers — no react-hook-form, no web-only imports. RHF specifics
(resolver, `""` bridging) stay in `apps/web` per the plan. Checked at diff.

### Flag 2 — `useInfiniteQuery` with `offset` as `pageParam`, not a key member. ACCEPTED, with a recorded wording amendment.

The obligation text (T2/T9) lists `offset` among the "filters" folded into the
key, but that text predates my R4 pagination ruling; its INTENT is cache
correctness — distinct slices cache distinctly and invalidation reaches them.
The idiomatic infinite-query shape preserves that intent better than the
letter: pages accumulate under one key entry, invalidation refetches all loaded
pages, and "Load more" gets correct accumulate semantics for free. Folding
`offset` into the key with manual page-stitching would re-implement
`useInfiniteQuery` by hand — more code and subtler bugs for zero cache benefit.

**Amendment AM-1.6-a (binding, and recorded for the 1.8 mobile reader who will
consume the same obligations lists):** the tx list key is
`['transactions', {from, to, category_id?, kind?, limit}]` — the STABLE filter
slice; `offset` is the infinite-query page cursor, not a key member. The
summary-exclusion predicate (`key[1] !== 'summary'`) stands with it.

Both PM leans confirmed; both flags were exactly the right thing to surface
rather than silently decide — no send-back needed on either.

## PM point 3 — A1 affordance pinned. RESOLVED.

The plan pins the design: inline header affordance in `ProtectedShell`
("Couldn't load your account" + Retry button calling `me.refetch()`); shell and
nav still render; content is not blocked; 401 never reaches this path (the
coordinator owns it). TC-2's expectation ("visible, actionable error affordance,
not a blank/half shell") matches. TC-2/TC-5 are unblocked. One editorial nit,
not a send-back: TC-2's cross-reference to "TC-19 note on currency sourcing" is
loose (TC-19's note is about the categories screen); the create-form degraded
path is actually pinned in the plan's Forms section (chip omitted + submit
disabled until summary currency resolves). Consistent either way.

## PM point 4 — invalidation table vs journeys. ONE GAP FOUND → send-back.

The plan's table is correct and complete: create/delete invalidate list
(predicate) + affected month summary; **edit invalidates the summaries of BOTH
the old and new month** (its own #1 risk); category mutations touch only the
categories key (joins re-render reactively — right, and cheaper than refetching
tx data). The predicate keeps list invalidation from blanket-refetching every
cached month's summary.

The checklist, however, never moves a transaction across a month boundary:
TC-13/14 edit within a fixed month, TC-30's "no storm" check is too coarse to
prove the predicate. The single most forgettable invalidation in the plan had
no journey. **Send-back issued to web-qa: TC-31** — edit a tx's date from month
A to B; assert A's summary SHRINKS without manual refresh (the stale-old-month
failure mode), B's grows, and network shows summary refetches for A and B only
while a pre-cached month C's summary stays quiet (proves the predicate).
Also **TC-32**: A3's coverage-map entry said the auth-field case was "noted,
not re-driven" — insufficient; it is the only end-to-end proof of the
`describeAuthError` → `getValidationIssues` wiring and costs one journey
(register with `user@example.test` → 422 ValidationError[] → field-level email
error). Both additions in flight; no renumbering of existing TCs.

## Line-by-line obligation gate

Verdict per item: plan step + browser TC (or explicitly-owned vitest). ✓ = both
present and consistent.

| Ob. | Plan step | QA / vitest | Verdict |
|---|---|---|---|
| C1 | `lib/patch.ts` buildCategoryPatch + patch.test.ts | vitest (core) + TC-20/21/23 wire bodies | ✓ |
| C2 | describeCategoryError map; 409→`name` field incl. kind-only | TC-20, TC-21, TC-22 | ✓ |
| C3 | `categoryLookup.sortForDisplay` (Collator-in-kind) + test | TC-26 (Ё/Е divergence seed), TC-18 | ✓ |
| C4 | CategoryRow/FormModal gate on `is_system`; 403 backstop | TC-18 | ✓ |
| C5 | Single `['categories',{includeArchived:true}]` source + setQueryData-by-id | TC-19, TC-23, TC-24 | ✓ (see AM-1.6-b) |
| C6 | Archive/unarchive PATCH via ConfirmDialog; no DELETE | TC-23 (incl. no-DELETE network assert) | ✓ |
| C7 | Case-insensitive hex regex; no canonical-casing assumption | TC-19 (lowercase hex) | ✓ |
| C8 | No client dedup pre-gate; server 409 → field | TC-20 (request reaches server) | ✓ |
| T1 | Infinite query limit=200; derived has_more; total→"N of M" | TC-8 (250-row seed) | ✓ (AM-1.6-a) |
| T2 | `params.query`; from/to via toApiDate; object keys only | TC-4 | ✓ |
| T3 | buildCategoryIndex (archived-incl.); composite key; Uncategorized | TC-7, TC-17 (console key-warning assert), TC-23, TC-24 | ✓ |
| T4 | formatMoney everywhere; toInputString ONLY for edit-prefill magnitude | TC-6, TC-12, TC-16 | ✓ |
| T5 | Per-site enum refs; category.kind→tx kind direct assignment | TC-10; alias discipline checked at my diff gate | ✓ |
| T6 | getValidationIssues runtime narrow; five tx codes mapped | TC-22, TC-13; errors.test.ts | ✓ |
| T7 | buildTransactionPatch + test | TC-13 (only amount_minor in body), TC-14 (null-vs-absent wire assert) | ✓ |
| T8 | No currency fields; render from row/summary currency | TC-6, TC-9, TC-19 | ✓ |
| T9 | Keys + dual invalidation + predicate; no GET /{id}; Q3 removes cold-deep-link branch | TC-9/12/15/25/27/30 + **TC-31 (send-back)** | ✓ after TC-31 |
| T10 | Shared monthParam/monthBounds/shiftMonth/formatMonthLabel + vitest (Dec, leap Feb) | TC-4 (year rollover end-to-end) | ✓ |
| A1 | ProtectedShell inline affordance + Retry (pinned) | TC-2 | ✓ |
| A2 | Navigate guard on Login/Register via useIsAuthenticated + safeNextPath | TC-1 (incl. ?next= honor) | ✓ |
| A3 | describeAuthError consults getValidationIssues → email field | **TC-32 (send-back)** + TC-22 shared path | ✓ after TC-32 |
| A4 | Coordinator body-preservation vitest untouched + green | vitest-owned; correctly excluded from browser scope | ✓ |
| G1 | schema.d.ts byte-identical; error layer built app-side, getErrorCode unedited (location verified) | checked every round + at diff | ✓ |
| G2 | typecheck/lint/full vitest per landed layer | run-phase gate | ✓ |
| G3 | Root ownership; shared additions within 0.4 remit (Flag-1 ruling) | at diff | ✓ |

**Amendment AM-1.6-b (recorded for 1.8):** C5's "archived and default lists
cache separately" is satisfied degenerately under the Q5 ruling — only the
archived-inclusive key is ever fetched; non-archived views are client-derived.
The key-shape discipline stands; there is simply no second cache entry to keep
separate. Mobile should adopt the same single-source shape.

## Other Phase 4 checks

- **Vitest inventory honest** (repo no-vacuous-tests rule): every listed test
  targets genuinely breakable logic (omit-vs-null builders, string/array narrow,
  Collator contrast vs raw order, month rollover/leap, day-grouping boundary);
  the explicit not-tested list (key concatenation, sign one-liner,
  presentational components) is the right restraint. QA's split note (browser
  verifies manifestation, vitest owns the logic) matches — no double-coverage.
- **QA seed plan is runnable** (two accounts, Bonus×2 kinds for TC-21, Ё/Е
  Cyrillic set, archive-after-assignment ordering, 250-row scripted loop with
  rate-limit throttle noted) and correctly API-only.
- **Build order** (shared → lib → data → UI shell → screens → routing) reviews
  incrementally and gates per layer; stub deletion last. Approved as the
  implementation sequence.
- **Plan risks are real and owned**: cross-month invalidation (now TC-31),
  currency-exponent guard (disable-submit beats guessing JPY-vs-RUB), modal
  focus trap (TC-29), composite-key silence (TC-17 console assert).

## Verdict

**Plan-web.md: ACCEPTED as written** — no revision required; both flags ruled
in the engineer's favor; obligations coverage table checks out 25/25 against my
tick-list. **QA checklist: ACCEPTED (32 TCs)** — TC-31/TC-32 landed and were
verified against the send-back spec (TC-31: old-month-shrinks assertion + month-C
predicate proof; TC-32: field-level email routing, logged-out ordering vs TC-1).
PM accepted all three open-question defaults (Q1 sign/color, Q3 modal surface,
Q5 single archived-inclusive query); AM-1.6-a/b binding; shared-schemas boundary
condition has diff-gate teeth. Implementation green-lit in the seven-layer build
order. /review_senior runs post-implementation; this file plus obligations.md
are the per-amendment tick-list for my diff gate.
