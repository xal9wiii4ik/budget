# Implementation Plan (mobile): dictionary/language (A) + amount mirror (B)

Written AFTER implementation, as the record task.md asks for. What each file does
and why lives in the file headers; this is the map plus the decisions.

## A — what was copied from web, verbatim in substance

- `src/i18n/t.ts`, `types.ts`, `context.ts` — copies of `apps/web/src/i18n/*`.
  `t.ts` and `types.ts` are unchanged apart from a header note; `context.ts`
  dropped `setLang` (no picker on mobile).
- `src/data/profile.ts` — copy of web's, `qk.profile()` = `['profile']`, enabled
  while authenticated, `staleTime: 60_000`.
- `src/data/errors.ts` — same routing tables as before, copy now from
  `errorMessage(key, lang)` (@budget/shared), mirroring `apps/web/src/lib/errors.ts`
  code by code; `networkMessage(lang)` exported like web's.
- `src/auth/errors.ts` — now returns `messageKey`, exactly like web's; the screens
  render it with `t()`.

## A — what deliberately differs from web

- **No local language cache.** Web reads `budget.lang` from localStorage
  synchronously at bootstrap. Mobile has no synchronous store (SecureStore /
  AsyncStorage are async and hold tokens only), so the pre-login language is the
  DEVICE's. Precedence is `profile.language` → device → `'en'`.
- **No language picker**, so no `chosen` state and no `setLang`: the language is
  chosen in web settings and arrives on the profile. `useUpdateProfile` exists for
  parity but has no caller yet.
- **Per-field invalidation trimmed**: a base-currency change invalidates only
  `invalidateTxSummaries` (added to `src/data/transactions.ts`). Web's `['goals']`,
  `['stats']`, `['limits']`, `['goals','list']` families do not exist on mobile.
- **Own dictionary** (~90 keys), not web's ~700: different screens. Wording is
  lifted from web's ru dictionary wherever the same sentence exists.
- **No `t.test.ts`**: mobile's `t.ts` is a byte-copy of web's, and the ru plural
  trap is already pinned there. `errors.test.ts` gained ONE ru/en contrast that
  the copy comes from the shared dictionary and that routing is language-free.
- `src/lib/deviceLang.ts` is the only module importing `expo-localization`, and
  nothing under `src/**/*.test.ts` imports it (vitest graph stays Node-only).
  `src/lib/locale.ts` (`APP_LOCALE`) is deleted; every formatter and every
  `Intl.Collator` call now takes `useLocale()`, with `locale` in the `useMemo`
  deps of each sort.

## Known gap (unchanged, recorded)

zod messages in `@budget/shared/schemas.ts` are still English on both clients —
changing them is a cross-package call, not this scope's.

## B — amount mirror

`amountMirror.ts` + test moved (git mv) to `packages/shared/src/`, exported from
the barrel. Web changed in exactly one line (the import). Mobile's
`transfer-form.tsx` repeats web's wiring: `useWatch` on both amounts,
`sameCurrency` from the account index (both known and equal), `useRef` receipt,
effect → `setValue('counter_amount', next, { shouldDirty: false })`. Edit mode
needs no special case — the ownership rule covers it (pinned by the moved test
"leaves the stored amount of a transfer being edited alone"). Mobile mirrors the
RAW typed string (`100,5`); normalisation stays in the resolver.

## N-x nits from `.tasks/accounts-and-transfers/qa-mobile-checklist.md`

- **N-4 FIXED** (trivially adjacent, 3 lines each): the accounts and categories
  toolbars no longer print a count while the query is pending or errored.
- **N-1** stays fixed and is now a real CLDR plural (`accountCount`), so ru gets
  счёт/счёта/счетов instead of an English `=== 1` branch.
- **N-2** (scroll first error into view), **N-3** (RHF revalidation mode),
  **N-5** (`toInputString` renders `.` on a ru keyboard — shared money helper),
  **N-6** (a11y roles reported as GenericElement) — NOT fixed: each needs a
  behavioural change beyond a few lines. O-1 stays closed.
