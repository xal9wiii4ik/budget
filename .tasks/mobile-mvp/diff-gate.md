# Senior diff gate — mobile-mvp (1.8)

Reviewer: senior-lead. Two implementation layers gated; one send-back issued and
verified fixed. All verdicts grounded in direct file/diff reads, not engineer
reports.

## Layer 1 — web/packages promotions (frontend-engineer): PASS

- `packages/api-client/src/patch.ts` / `errors.ts`: verbatim relocations
  (compared against pre-move web sources read during grooming). Platform-free
  header present in errors.ts with the grep warning.
- Barrel `index.ts`: additive-only — existing lines byte-identical, 4 appended
  export lines (read the diff).
- `apps/web/src/lib/query.ts`: VALUE re-export shim confirmed
  (`export { ApiError, throwOnError } from '@budget/api-client'`); queryClient
  retained, imports ApiError from the package.
- AM-hex: `HEX_COLOR_PATTERN` exported from shared schemas + barrel; web local
  copy deleted from CategoryFormModal (import re-pointed).
- Proofs verified: (a) api-client→shared imports are `import type` only
  (patch.ts:20, patch.test.ts:2 — grepped); (b) no `lib/patch` import remains in
  apps/web; (c) `git diff packages/api-client/src/generated` empty; (d) `apps/api`
  untouched. S1 (amended) HELD.
- Gate: 9/9 turbo tasks green; api-client 14, shared 36, web 23 tests.
- Declared deviation (unused `ValidationIssue` type import omitted at web call
  site): ACCEPTED — correct lint hygiene, zero contract impact.

## Layer 2 — mobile implementation (mobile-engineer): PASS after one send-back

Read in full: `src/auth/coordinator.ts`, `src/data/transactions.ts`,
`app/(app)/_layout.tsx`, `src/lib/{probes,baseUrl}.ts`; grep-verified:
patch-builder call sites in both form modals, queryKeys conformance diff vs web
(identical modulo one comment citation), change-surface containment.

### SEND-BACK (found by senior read, fixed and re-verified)

**coordinator.ts O4 rebuild gated body capture on `input.body`** — the
browser-spec ReadableStream getter that RN's whatwg-fetch-derived polyfill does
NOT implement. Node/undici exposes `.body`, so the vitest gate was blind to it;
on-device every protected POST/PATCH body would have been silently dropped.
Exactly the O4 divergence class. Fix landed and verified by source read:
body presence decided by METHOD (GET/HEAD → none; else `await input.text()`,
`'' → null`), `build()` passes `body: bodyText ?? undefined`; regression
tripwire test added (Request-like fake with `body: undefined` but working
`text()` — asserts payload on initial send AND 401 replay); `[probe:O4c]`
records the real polyfill shape on-device; spike file updated with the hazard.
Coordinator suite 12/12; mobile gate 3/3 tasks, 28/28 tests; Metro export
smoke clean (1818 modules).

### Structural obligations (senior-gate-owned per coverage map) — final tick

| ID | Verdict | Evidence |
|---|---|---|
| S1 | HELD | generated/** diff empty; apps/api untouched; mobile touched only apps/mobile + lockfile + spike file (git status read) |
| S2 | HELD | plan-mobile.md / plan-web.md; no plan.md written |
| S3 | HELD | full-repo turbo 15/15 green (api 65, web 23, api-client 14, mobile 27→28, shared 36); re-run green after fix round for @budget/mobile |
| S4 | HELD | `src/wiring.test.ts` deleted; vitest-only; coordinator DI verified — imports only @budget/api-client (read); no RN/expo module in the vitest graph (engineer grep + senior read of coordinator imports) |
| S5 | HELD | no new packages; copies confirmed app-owned |
| O1 | HELD | coordinator.ts imports only api-client helpers + ApiError/TokenPair (read); no auth-core |
| A-1 | HELD | login/refresh/logout via shared helpers (coordinator.ts:12–17, 165, 222, 236); encoding never re-derived |
| AM-hex (web-copy deletion) | HELD | CategoryFormModal local pattern deleted, shared import in place (diff read) |
| W1 (builder bodies) | HELD | edit paths call buildTransactionPatch/buildCategoryPatch; create paths use emptyToNull for category_id/note/icon/color (grep of both form modals); builders are the promoted verbatim modules |
| O5/R3 | HELD | resume timeout race implemented with injectable TimerSeam; covered in vitest |
| AM-1.6-a/b | HELD | queryKeys conformance diff vs web: identical modulo comment; MONTH_LIMIT shared between tab and modal for identical filter slices |
| W8 | HELD | dual-month Set + `key[1] !== 'summary'` predicate read in data/transactions.ts |
| O6 | HELD | guard redirects via <Redirect> with next + reason=expired; authFetch contains no navigation (read) |

### Deviations ledger (layer 2, all declared, all ruled)

1. `experiments.typedRoutes: false` — ACCEPTED. Typed-route codegen requires the
   long-running dev server, so it cannot participate in the standalone typecheck
   gate; typed `useLocalSearchParams` (the O6-relevant part) is unaffected. The
   two `as Href` casts are contained to the auth screens. Re-enable is a
   follow-up if the codegen step is ever wired into the gate.
2. SectionList for both lists — the plan's own stated choice; not a deviation in
   substance.
3. `confirmAction({destructive})` generalization — ACCEPTED, better than the
   plan (unarchive gets a non-destructive confirm).
4. Color-row composition detail — cosmetic, ACCEPTED.

## Gate outcome

Both layers PASS. Working tree uncommitted per standing instruction. Cleared for
stage 5 (mobile-qa degraded-honest run per R7) and stage 6 (/review_senior) in
parallel.
