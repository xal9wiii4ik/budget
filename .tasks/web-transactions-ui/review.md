# Code review — web-transactions-ui (1.6), /review_senior stage

Reviewer: CODE-REVIEWER. Scope: full uncommitted working-tree diff (new files under
`apps/web/src/{components,data,features,lib,routes}`, edits to `App.tsx`,
`auth/errors.ts`, `ProtectedLayout*`, `LoginPage`, `RegisterPage`,
`packages/shared/src/{dates,schemas,index}.ts` + tests, deleted
`TransactionsStubPage.tsx`). Excluded: `PLAN.md`, `.tasks/` artifacts. Declared,
senior-accepted deviations (existing `meQueryKey` instead of a `qk.me()` entry;
`key={id}` on the edit modals) were not re-flagged.

Gates run during review: `pnpm typecheck` (5/5 pass), `pnpm lint` (pass),
`pnpm --filter @budget/web --filter @budget/shared test` (35 + 35 pass, incl. the
A4 coordinator body-preservation case, untouched by the diff).

## Findings

### 1. MINOR — delete-path 404 leaves the stale row on screen (edit path handles it)

`apps/web/src/features/transactions/TransactionFormModal.tsx:150-162` /
`apps/web/src/data/transactions.ts:115-135`

The edit submit path catches an `ApiError` 404 and invalidates the tx lists so a
row deleted elsewhere disappears (lines 136-143 — correct per the plan's code map:
"TRANSACTION_NOT_FOUND (404) → form + trigger list invalidation"). The **delete**
path (`confirmDelete`) has the same failure mode — deleting a row another
session already deleted returns 404, the dialog shows "This transaction no longer
exists. Refresh and try again." — but performs no invalidation, so the stale row
stays in the list until a manual refresh, contradicting the message it just showed.

Fix (minimal, and it also removes duplication — see finding 5): move the
404-triggered list invalidation into `data/transactions.ts` as an `onError` on
`useUpdateTransaction` and `useDeleteTransaction` (`if (error instanceof ApiError
&& error.status === 404) void invalidateTxLists(queryClient)`), and drop the
inline copy in the modal.

### 2. MINOR — `MONTH_PATTERN` accepts impossible months ("2026-13", "2026-00")

`apps/web/src/routes/TransactionsPage.tsx:20,30`

`/^\d{4}-\d{2}$/` accepts `?month=2026-13`. That value flows into
`monthBounds('2026-13')` → `from: "2026-13-01"`, an invalid date the server 422s,
so a hand-typed URL yields a permanently-failing list/summary with a Retry button
that can never succeed — while `formatMonthLabel('2026-13')` normalises via
`Date(2026, 12, 1)` and cheerfully labels the header "January 2027" (label and
data disagree). The fallback-to-`currentMonth()` guard exists precisely for
malformed params; it just doesn't catch this class.

Fix: `const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;` — one line, and the
existing fallback handles the rest.

### 3. MINOR — Modal Esc/Tab-trap dies when focus leaves the dialog subtree

`apps/web/src/components/Modal.tsx:46-72,90`

The Esc handler and Tab trap are bound as React `onKeyDown` on the dialog `div`,
so they only fire while `document.activeElement` is inside the dialog. Two real
ways focus escapes:

- Safari does not focus buttons/radios on click, and clicking non-focusable
  content (e.g. the ConfirmDialog's message `<p>`) moves focus to `<body>` —
  after which Esc does nothing and Tab can walk out of the "trapped" dialog into
  the background page.
- The submit button is `disabled` while pending; if it had focus when it became
  disabled the browser drops focus to `<body>` with the same result.

The initial-focus + trap works in the common Chrome path, but the a11y-fragile
part the plan itself flagged ("focus trap + restore is the a11y-fragile part")
should not depend on where the last click landed.

Fix: attach the keydown handler at document level for the modal's lifetime —
`useEffect(() => { document.addEventListener('keydown', handler); return () =>
document.removeEventListener('keydown', handler); })` — with the trap clause
re-entering the dialog (`first.focus()`) whenever `activeElement` is outside it.

### 4. MINOR — "SINGLE place `\"\"` is interpreted" claim is false for the create paths

`apps/web/src/lib/patch.ts:2-3` vs
`apps/web/src/features/transactions/TransactionFormModal.tsx:129,131` and
`apps/web/src/features/categories/CategoryFormModal.tsx:67-68`

`patch.ts`'s header comment states it is "the SINGLE place where the RHF empty
sentinel `\"\"` is interpreted", but the create submit paths open-code the same
bridge four times (`values.category_id === '' ? null : …`, `values.note === '' ?
null : …`, `values.icon === '' ? null : …`, `values.color === '' ? null : …`).
C1/T7's letter ("wrapped once, not open-coded per call site") binds the PATCH
builders, which do comply — so this is not an obligation breach — but the diff
either violates its own stated discipline or documents it wrongly, and a future
create-path edit has no guard against diverging from the bridge rule.

Fix (pick one): export a two-line `emptyToNull(value: string): string | null`
from `patch.ts` and use it at the four create call sites; or soften the comment
to "the single place `\"\"` is interpreted **for PATCH bodies**".

### 5. NIT — not-`'summary'` predicate duplicated outside the data layer

`apps/web/src/features/transactions/TransactionFormModal.tsx:138-143` re-states
the list-invalidation predicate inline because `invalidateTxLists`
(`data/transactions.ts:31-36`) is module-private. If the key shape ever changes,
this copy is the one that gets missed. Subsumed by the finding-1 fix; otherwise
export `invalidateTxLists` and call it.

### 6. NIT — Modal's × button renders enabled-but-dead while a confirm is pending

`apps/web/src/components/ConfirmDialog.tsx:34`. `onClose={isPending ? () => {} :
onCancel}` correctly deadens Esc/backdrop during the mutation, but the Modal
header's × button still looks clickable and silently does nothing. Consider a
`closeDisabled` prop on `Modal` that disables the × (also gives screen-reader
users the disabled semantics), or accept as-is for MVP.

### 7. NIT — live color preview applies arbitrary user CSS before validation

`apps/web/src/features/categories/CategoryFormModal.tsx:179-183`. `colorPreview`
is `useWatch`'d raw input and goes straight into `style={{ background: … }}`;
until submit-time zod validation, any CSS background value applies — e.g. typing
`url(https://…)` issues a fetch from the user's own browser. Not an XSS vector
(CSSOM, own input, never persisted un-validated — the server re-validates the
hex pattern), purely a tightening: render the swatch color only when
`HEX_COLOR_PATTERN.test(colorPreview)`.

### 8. NIT — duplicated kind-radio onChange handler

`apps/web/src/features/transactions/TransactionFormModal.tsx:222-254`. The
clear-incompatible-category handler is pasted identically into both radios.
Extract one `const onKindChange = (event) => {…}` (it already reads
`event.target.value`, so it's kind-agnostic). Behavior is correct as written
(uses `getValues`, no stale closure).

### 9. NIT — comment inaccuracy in `formatMonthLabel`

`packages/shared/src/dates.ts:97`: "(local midday)" — the code constructs local
midnight of day 1 (`new Date(y, m - 1, 1)`). Behavior is still TZ/DST-safe (a
nonexistent midnight resolves forward within the same date under the ES spec, and
only the month/year are formatted), but the comment describes code that isn't
there. Also note the build order promised `schemas.test.ts` additions for the new
form schemas; the only genuinely breakable uncovered branch is
`categoryFormSchema`'s `v === '' || HEX_COLOR_PATTERN.test(v)` refine (the
empty-color-allowed arm, which mobile 1.8 will reuse). One test would guard it;
under the repo's no-vacuous-tests rule this is optional, not demanded.

## Verified correct (load-bearing checks that passed)

- **G1**: `git status`/`git diff` show zero changes (tracked or untracked) under
  `packages/api-client`; `schema.d.ts` untouched; `getErrorCode` unedited
  (verified source: safe on non-object bodies, arrays fall through to
  `undefined` → the ValidationError[] arm reaches the `default`/post-switch path
  as designed).
- **G2**: typecheck, lint, and full vitest for `@budget/web` + `@budget/shared`
  all green on the working tree (run during this review).
- **A4**: `auth/coordinator.test.ts` not in the diff; BODY PRESERVATION case
  executed and green.
- **C1/T7 (patch builders)**: omit-vs-null exactness verified line-by-line —
  `clearableChange` returns `undefined` only as an omit signal and callers skip
  assignment, so `undefined` never reaches the wire; `name`/`kind`/
  `amount_minor`/`kind`/`occurred_at` can never be `null`; empty patch `{}` short-
  circuits the mutation at both call sites. **C7 edge**: color compared
  case-insensitively (`toLowerCase()` both sides) so a case-only difference is
  not resent, and a genuine change emits the user's verbatim casing (server owns
  canonicalisation) — matches the server's `^#[0-9A-Fa-f]{6}$` pattern.
  Amount round-trip on edit prefill (`toInputString` → `parseMoney`) is exact
  (both are float-free string/int paths), so an untouched amount diffs equal and
  is omitted.
- **C2/T6 (error narrowing)**: `getValidationIssues` is robust to malformed
  bodies — non-object, `null`, string/object `detail`, garbage array entries
  (skipped), non-scalar `loc` parts (filtered). `locTailField` skips the FastAPI
  `"body"` wrapper and numeric indexes. All five tx codes + three category codes
  mapped per the plan's table; 409 `CATEGORY_NAME_CONFLICT` → field `name`;
  `*_REQUIRED` → generic form (unexpected-signal semantics); non-`ApiError` →
  network message.
- **A3**: `describeAuthError` default arm consults `getValidationIssues` and
  routes a `loc`-tail `email` issue to the email field before the 429/generic
  fallbacks; register's reserved-TLD 422 (`['body','email']`) hits it.
- **T9/invalidation completeness**: create → lists (predicate) + created month's
  summary; edit → lists + **both** old (`variables.previousOccurredAt`, captured
  from the row in hand — no GET /{id}) and new (`updated.occurred_at`) months'
  summaries with a `Set` deduping the same-month case; delete → lists + the
  deleted row's month. Category mutations touch only the categories cache
  (`setQueryData` append / replace-by-id) — joins re-render reactively. The
  not-`'summary'` predicate is correct against the key shapes (`txSummary`
  key[1] is the string `'summary'`; `txList` key[1] is the filters object).
- **Query-key stability (review focus 2)**: `filters` is recreated per render,
  but TanStack v5 hashes keys structurally (stable-sorted `JSON.stringify`), so
  identity churn does not re-key; `offset` is the `pageParam` per AM-1.6-a;
  `getNextPageParam` derives `has_more = loaded < total` and `total` drives
  "Showing N of M" (T1).
- **RHF resolver freshness**: verified against installed react-hook-form 7.82.0
  source — `control._options = props` executes every render, so the
  `transactionFormSchema(currency)` resolver refreshes when the summary currency
  resolves; until then the create form is degraded (chip omitted, submit
  disabled — and HTML implicit submission is blocked by a disabled default
  button, so the `'USD'` placeholder schema can never validate a real submit).
  Edit mode uses `row.currency` unconditionally (T8); no currency is ever
  collected; no hardcoded currency reaches the wire.
- **T3**: breakdown keyed `${category_id ?? 'uncategorized'}:${kind}` (refund
  double-kind case safe); join uses the archived-inclusive index; `null` bucket
  → "Uncategorized"; archived names render muted.
- **T4**: all summary/row amounts through `formatMoney`; sign derived from
  `kind` (row negates expense magnitude); `toInputString` used only for the edit
  prefill magnitude; no `toFixed`/float arithmetic anywhere in the diff.
- **T5**: no shared `Kind` alias (grepped); enum references are per-site
  (`CategoryRead['kind']`, generated schema types); category→tx kind flows by
  direct assignment only, and a manual kind flip clears an incompatible category
  (no reverse assignment).
- **T2**: `from`/`to` are only ever object keys built from `monthBounds`; full
  filter set + `limit: 200` in the key; `params.query` throughout.
- **T10/month math**: all component-wise local `Date` construction — no ISO
  string parse anywhere, so no UTC shift; `monthBounds` last-day via
  `Date(y, m, 0)`; DST-nonexistent midnights resolve forward within the same
  date per spec, so no month-label drift; `formatApiDate` used for `occurred_at`
  only, `created_at` never rendered (grepped).
- **C3**: `Intl.Collator(locale, { sensitivity: 'base' })` within kind groups;
  non-mutating sort; stable `Array.sort` preserves server order for base-equal
  names; the vitest genuinely contrasts code-point vs collator order (Ё/А).
- **C4/C6/C8**: system rows render as non-interactive `div`s (no edit path
  exists to reach the modal); archive/unarchive is PATCH `{archived}` behind
  `ConfirmDialog`, no DELETE anywhere; no client-side dedup pre-gate — server
  409 routes to the `name` field.
- **C5/Q5**: single archived-inclusive `['categories', {includeArchived: true}]`
  query is the sole source; picker/management/joins client-filter it.
- **A1**: terminal `me.isError` renders an inline `role="alert"` affordance with
  a working Retry (`me.refetch()`); shell, nav, logout, and content all still
  render.
- **A2**: both auth pages bounce authenticated visitors via
  `<Navigate to={safeNextPath(next)} replace />` after hooks (no hook-order
  violation), reusing the open-redirect guard.
- **Delete 204 handling**: `useDeleteTransaction` bypasses `throwOnError`
  (which would treat `data: undefined` as failure) and unwraps
  `response.ok`/`error` by hand — correct.
- **Modal focus lifecycle across the ConfirmDialog swap**: form values survive
  (RHF `shouldUnregister: false` default keeps the store while the subtree
  unmounts), and the unmount→mount effect ordering chains focus capture/restore
  back to the original opener correctly.
- **Security**: no `dangerouslySetInnerHTML`/`innerHTML` (grepped); all
  user-entered strings (notes, names, icons) rendered as React text; no token
  ever leaves the auth layer into the new code; `?next=` handling stays behind
  `safeNextPath`.
- **Shared-schemas boundary (senior condition)**: `packages/shared/src/schemas.ts`
  imports only `zod`, `./currencies`, `./money` — no react-hook-form, no web
  modules; RHF specifics stay in `apps/web`.
- **Icon length interplay**: input `maxLength={16}` (UTF-16 units) is always ≤
  the server's 16-code-point cap, so no icon-length 422 is reachable from the UI;
  the name >100 server backstop routes through the ValidationError[] arm to the
  `name` field.
- **Test quality (repo no-vacuous rule)**: every new vitest case exercises a
  breakable branch (omit-vs-null incl. the C7 case-only contrast, string/array/
  object narrow, collator-vs-code-point contrast with an explicit no-mutation
  assert, Dec/leap-Feb/non-leap-Feb/rollover-both-directions, day-grouping across
  a month boundary). No redundant or vacuous test found.
- **Stub removal**: `TransactionsStubPage` deleted with zero remaining
  references; routes swapped in `App.tsx`.

## Verdict

**APPROVE-WITH-FIXES.**

No MAJOR findings. All 25 obligations (C1-C8, T1-T10, A1-A4, G1-G3) are
discharged in code as planned, the declared deviations match the senior-accepted
list, and every gate is green. The four MINORs (delete-404 staleness, month-regex
robustness, modal keydown scoping, and the ""-bridge single-place claim) are
small, localized, and none blocks the core flows; findings 1-4 should land before
merge, the NITs are at the implementer's discretion.
