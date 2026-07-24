# Senior diff gate — web-transactions-ui (1.6) implementation

Gate performed by senior-lead on the uncommitted working tree (post seven-layer
implementation, before QA/browser run and before code-reviewer). Method: direct
code reads of the risk-bearing files + independent re-run of the gates. This is
the responsibility-#4 gate; code-reviewer's line-by-line pass follows separately.

## Verdict: PASS — released to QA and code review. Both declared deviations ACCEPTED.

## Deviation rulings

1. **`qk.me` omitted; `meQueryKey` in `auth/useMe.ts` stays the single source.
   ACCEPTED.** Verified `meQueryKey` exists (useMe.ts:8) and is the key in use
   (useMe.ts:18). Duplicating the literal in `data/queryKeys.ts` would create two
   sources of truth for one cache entry — the deviation avoids a real drift bug.
   The plan's `qk.me()` line was a transcription of the existing key, not new
   design; nothing consumed it.
2. **`key={row.id}` on the edit modals (TransactionsPage.tsx:97,
   CategoriesPage.tsx:68). ACCEPTED.** Correctness guard the plan missed: RHF
   `defaultValues` are captured on mount; without a keyed remount, switching
   edited rows while the modal stays mounted would show stale prefill. Idiomatic
   React remount-on-identity-change. No obligation touched.

## Independent gate re-run (not trusting the report)

- `turbo run typecheck lint test --filter=@budget/web --filter=@budget/shared`:
  6/6 tasks green; web vitest 35/35 (6 files), shared 35/35 (3 files).
- A4: `auth/coordinator.test.ts` — `git diff` EMPTY (untouched) and its 10 tests
  green in the run above. Tripwire intact.
- G1: `git diff packages/api-client/.../schema.d.ts` — EMPTY (byte-identical).
  `getErrorCode` unedited; the new error layer is app-side (`apps/web/src/lib/errors.ts`).
- G3: change surface is apps/web + packages/shared only (+ PLAN.md, PM's own edit).
- Environment for QA: PG healthy on 5443 (docker budget-postgres-1), alembic at
  head (0003), API started on :8010, `/health` = `{"status":"ok","database":"ok"}`.

## 25-obligation tick against ACTUAL CODE (file:line evidence)

- [x] C1 — `lib/patch.ts:30-50` buildCategoryPatch: touched-only; `clearableChange`
      maps `""`→null / unchanged→omit; name/kind emitted only when changed, never
      null; `undefined` never emitted as intent (patch.ts:13-16). 9 vitest cases.
- [x] C2 — `lib/errors.ts:85-108`: three category codes mapped;
      CATEGORY_NAME_CONFLICT → field `name` with in-kind message (errors.ts:95-99,
      comment covers kind-only PATCH); array arm routed via loc tail.
- [x] C3 — `data/categoryLookup.ts` sortForDisplay (Collator within kind), used by
      picker (TransactionFormModal.tsx:107) and CategoriesPage; vitest contrasts
      Cyrillic order vs raw.
- [x] C4 — CategoryRow.tsx:30,36: System tag + early return (no edit/archive
      affordances); CategoryFormModal.tsx:193 archive affordance gated
      `!category.is_system`.
- [x] C5 — `data/categories.ts`: single `['categories',{includeArchived:true}]`
      query (Q5/AM-1.6-b); create appends returned row, update replaces by id via
      setQueryData; no single-row GET anywhere.
- [x] C6 — delete tx via ConfirmDialog (TransactionFormModal.tsx:164-178);
      archive/unarchive PATCH `{archived}` behind ConfirmDialog in
      CategoryFormModal; no DELETE endpoint call for categories.
- [x] C7 — patch.ts:45 case-insensitive color compare (case-only diff not resent);
      schemas.ts hex pattern `[0-9A-Fa-f]` case-insensitive.
- [x] C8 — no client-side dedup gate exists; 409 relied on and field-routed.
- [x] T1 — `data/transactions.ts:38-55` useInfiniteQuery; derived
      `getNextPageParam` (loaded < total ? loaded : undefined); limit in stable
      filters (200 set at TransactionsPage).
- [x] T2 — queryFn spreads filters + offset into `params.query`
      (transactions.ts:44-46); from/to only object keys; `qk.txList(filters)`.
- [x] T3 — SummaryHeader.tsx:17-19 composite `${category_id ?? 'uncategorized'}:${kind}`
      key; join against archived-inclusive index (props from single query);
      null bucket → "Uncategorized" (line 86); archived name muted (87-89).
- [x] T4 — formatMoney for income/expense/net + breakdown totals
      (SummaryHeader.tsx:63,69,75,96); `toInputString` appears ONLY at edit
      prefill of `amount_minor` magnitude (TransactionFormModal.tsx:64); zero
      `toFixed`/float paths (grep clean).
- [x] T5 — no `type Kind` alias (grep clean across features/data);
      category→tx kind by direct assignment (TransactionFormModal.tsx:268);
      per-site `components['schemas'][...]` references.
- [x] T6 — errors.ts:29-47 runtime narrow (array/`{loc,msg}` guard, string arm →
      undefined); five tx codes mapped (errors.ts:124-142) with
      `*_REQUIRED` → generic fallback; 404 additionally triggers list refetch at
      the form call site (TransactionFormModal.tsx:138-143).
- [x] T7 — patch.ts:52-70: category_id/note `""`→null via clearableChange;
      amount_minor/kind/occurred_at only-when-changed, never null.
- [x] T8 — no currency input anywhere; chip display-only
      (TransactionFormModal.tsx:210); create degraded → submit disabled
      (lines 54, 352) instead of guessing an exponent; edit uses row.currency.
- [x] T9 — keys per AM-1.6-a (queryKeys.ts); not-'summary' predicate
      (transactions.ts:31-36); create/delete invalidate list + affected month;
      EDIT invalidates OLD+NEW month via Set (transactions.ts:104-110) with
      previousOccurredAt captured from the in-hand row; edit modal sources row
      via component state (no GET /{id}; no per-tx route exists).
- [x] T10 — shared/dates.ts monthParam/currentMonth/shiftMonth/monthBounds/
      formatMonthLabel; local component math (TZ-safe); vitest incl. Dec
      rollover + leap/non-leap Feb; formatApiDate untouched, used for
      occurred_at only.
- [x] A1 — ProtectedLayout.tsx: `me.isError` → "Couldn't load your account." +
      Retry calling `me.refetch()`; shell still renders.
- [x] A2 — LoginPage.tsx:22,52 and RegisterPage.tsx:16,53: authed →
      `<Navigate to={safeNextPath(next)} replace />`.
- [x] A3 — auth/errors.ts default arm consults `getValidationIssues` + email loc
      tail BEFORE generic fallback → field-level email message.
- [x] A4 — coordinator.test.ts untouched (diff empty), 10/10 green.
- [x] G1 — schema.d.ts diff empty; packages/api-client untouched.
- [x] G2 — full gate re-run green (see above); engineer also gated per layer.
- [x] G3 — root ownership respected; shared additions within 0.4 remit;
      schemas.ts imports only zod + shared money helpers (boundary condition
      verified in diff — no RHF, no web modules).

## Notes for code-reviewer / meta-review

- `schemaCurrency` fallback `'USD'` in TransactionFormModal (line 53) is
  unreachable for a real submit (createDegraded disables submit until the true
  currency resolves; edit always has row.currency). Acceptable; reviewer may
  double-check the reachability claim.
- `useUpdateCategory` relies on setQueryData only (no invalidation) — per plan
  and C5; staleTime 60s means cross-device staleness up to a minute. MVP-fine.
- Delete mutation unwraps the 204 by hand because `throwOnError` treats
  `undefined` data as failure — sound, matches openapi-fetch 204 semantics.
