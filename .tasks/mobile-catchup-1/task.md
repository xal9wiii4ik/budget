# mobile-catchup-1 — dictionary/language (A) + amount mirror (B)

Tier: STANDARD (no contract change, no money math, no migrations). Team:
mobile-engineer (A→B, one dispatch), mobile-qa once at the end. No architect.

## Repo facts
- Part B's foundation (accounts tab, account-form, transfer-form with two legs,
  `transfer_rate` string, AccountPicker, `signedLegFor`, `['accounts']`
  invalidation) landed in 18c627d; simulator QA in
  `.tasks/accounts-and-transfers/qa-mobile-checklist.md`. Missing: amount
  mirroring (web got it later: f8e47a0 → ca89238 → 0e872de) and nits N-2…N-6.
- Web mirror rule: `apps/web/src/features/transfers/amountMirror.ts` +
  `.test.ts` (pure `mirrorDecision`, ownership rule — the edit-mode defect fix
  is 0e872de). Web wiring: `TransferFormModal.tsx` ~L206-229 (`useRef` receipt +
  effect, `setValue(..., { shouldDirty: false })`).

## A. Dictionary and language
- `apps/mobile/src/data/profile.ts` — copy of web `data/profile.ts`
  (`GET /profile`, root `['profile']`, enabled while authenticated; PATCH kept
  for parity, per-field invalidation trimmed to what mobile caches).
- `apps/mobile/src/i18n/` — copy (not shared) of web `t.ts` + `types.ts`;
  mobile `dict.en.ts`/`dict.ru.ts` (~50 screen strings: tabs, forms, rows,
  auth, empty/error states); `context.ts` with `useT/useLang/useLocale`;
  provider resolves `profile.language` → device locale (`expo-localization`)
  → 'en'. NO local cache (deliberate: mobile has no synchronous store to read
  at bootstrap; login screen follows the device).
- `src/data/errors.ts` → `describe*Error(error, lang)` with copy from
  `errorMessage(key, lang)` (@budget/shared), like web `lib/errors.ts`.
- `APP_LOCALE` (`src/lib/locale.ts`, device tag) → `useLocale()` everywhere:
  locale follows the interface language, not the device (web lesson,
  docs/web.md "Host-default locale = the shipped defect").
- Known gap to record: zod messages in `@budget/shared/schemas.ts` stay English.

## B. Mirror
- Move `amountMirror.ts` + test into `packages/shared` (export `mirrorDecision`,
  `MirrorState` from the barrel). Web: ONLY change the import in
  `TransferFormModal.tsx` and delete the local module + test. Nothing else in
  apps/web (redesign is being visually verified in parallel).
- `transfer-form.tsx` repeats the web pattern (`useRef` + `mirrorDecision`),
  edit mode protected by the ownership rule (stored counter amount is never the
  mirror's). Mobile nuance: fields hold the RAW typed string (`100,5`), the
  mirror copies it verbatim; normalisation stays in the resolver.
- O-1 not opened. N-2…N-6 only if trivially adjacent (report which).

## Gates (shared is consumed by four packages)
web / mobile / api-client / mcp-server: lint + typecheck + test each; shared
itself too. Serialised, not parallel.

## QA
mobile-qa: ONE end-to-end simulator pass "account → transfer (mirror + currency
switch) → list" + language switch via PATCH /profile; manual iPhone checklist
written, not executed. Own API on a throwaway DB; users `qa-*@budgetqa.dev`;
8010/5173 are the user's containers.
