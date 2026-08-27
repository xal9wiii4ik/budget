# Implementation Plan (web): bank format from server

## Approach
The format list is a static server-owned registry, not session state, so it gets its
own long-lived query under a key that no import invalidation can reach.
`ImportUploadModal` grows a third control between account and file; the selected id
goes into the `format` field the upload request already has, so nothing about the
multipart body changes shape.

## Changes
- `data/queryKeys.ts` — `qk.importFormats()` → `['imports','formats']`. Safe under the
  existing family: every bare invalidation/removal there is `['imports', <uuid>, …]`,
  and `'formats'` is not a uuid. Documented in place.
- `data/imports.ts` — `useStatementFormats()` (`GET /statement-imports/formats`,
  `select` → `string[]`, long staleTime, no mutation invalidates it); `PRIORBANK_FORMAT`
  deleted; `UploadStatementVariables` gains `format`.
- `features/imports/statementFormatLabel.ts` (new, pure, node-only vitest) —
  `{kind:'known', labelKey} | {kind:'unknown', label: id}`; returns KEYS, never copy.
  Test covers the fallback branch (unknown id → the id itself), contrasted with a known id.
- `features/imports/ImportUploadModal.tsx` — «Банк» `<select>` + hint; selection is local
  state, the effective value is DERIVED at render (`picked ?? formats[0] ?? ''`) so the
  single/first format is preselected without an effect.
- `i18n/dict.en.ts` (key set) + `dict.ru.ts` — uploadFormat / hint / pickFormatFirst /
  formatsLoadFailed / formatsEmpty / formatPriorbankCsvV1.

## UI states
loading → disabled select with a placeholder option (no height jank); error/unreachable →
`QueryStateNotice compact` + retry, no select; ready+empty → explanatory line; ready →
options, first preselected. Submit is DISABLED whenever the effective format is `''`, and
`submit()` still guards with `imports.pickFormatFirst`.

## Risks
`StatementFormatsRead` / the path must exist in the regenerated `schema.d.ts` (backend);
typecheck blocks until then. No hand-edits there.
