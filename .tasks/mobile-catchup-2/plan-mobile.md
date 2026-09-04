# Implementation Plan (mobile): transaction form catch-up (mobile-catchup-2)

Executed plan for `.tasks/mobile-catchup-2/task.md`. Decisions only — the code
carries the reasons inline.

## Approach

The web form is the model of DECISIONS, not of code. Everything already proven
pure on web moves into a package so both clients share one behaviour, and only
presentation is written twice. Mobile keeps NO converted-to-base section, so it
passes `baseAmountEdited=false` and `base_amount` stays the schema's "" sentinel.

## Moves into packages (web changes = import lines only)

- `packages/shared/src/originalPair.ts` ← web `features/transactions/originalPair.ts`:
  `isPairMode / spendPrefill / spendCurrencyOptions / migrateAmounts` + their
  tests. `OriginalPair` is declared STRUCTURALLY here (shared must not depend on
  api-client); `TransactionRead` satisfies it.
  Web's file keeps `describeOriginalPairError` (it names WEB dict keys) and
  re-exports the four.
- `packages/api-client/src/createBody.ts` ← web `convertedSection.ts`:
  `buildCreateBody` + its five test cases. Web's `convertedSection.ts` re-exports
  it; `TransactionFormModal.tsx` is untouched.

## Screens / navigation

- `apps/mobile/app/(app)/transaction-form.tsx` — the whole scope. Route, params
  and the deep-link-safe edit load are unchanged. Order changes: the KIND
  segment moves to the TOP (every label below it is direction-worded).

## New mobile modules

- `src/features/transactions/kindCopy.ts` — the direction-worded label table,
  mobile dict keys. Lookup table, no test (a wrong key is a typecheck error).
- `src/features/transactions/originalPairError.ts` — mobile twin of web's
  `describeOriginalPairError`; local because it names MOBILE dict keys.
- `src/features/transactions/chargePreview.ts` — `chargePreviewRequest()`: the
  pure decision "may we ask the server for a charge estimate?". Tested.
- `src/features/transactions/SpendCurrencyPicker.tsx` — chips over
  `spendCurrencyOptions`, plus an "Other currency…" chip revealing a 3-letter
  code input (the list is a SUGGESTION, not a whitelist — D7).
- `src/features/transactions/CountryField.tsx` — the folded "More" section
  (Pressable disclosure, no modal library) with a chip list.
- `src/features/transactions/AttachPhotoField.tsx` — photo state machine.
- `src/data/fx.ts`, `src/data/receipts.ts` — copies of web's data layer, trimmed
  to what mobile calls (no parse, no poll, no imperative fx caller).
- `src/lib/countryLabel.ts` — the Hermes `Intl.DisplayNames` seam.
- `src/lib/useDebouncedValue.ts` — copy of web's.

## Data layer

- `GET /fx/convert` via `qk.fxConvert(params)` (copied key grammar: every input is
  in the key, so nothing invalidates it; staleTime 5 min).
- `POST /receipts` → `PUT <presigned>` (RAW fetch, no bearer, `upload.headers`
  verbatim) → `GET /receipts/{id}` under `qk.receipt(id)`. SERVER LIMITATION:
  `view_url` is non-null only for a receipt whose upload the server considers
  proven (status processing/parsed/failed), and no upload-confirm endpoint for
  receipts exists — a photo attached from mobile stays `pending`, so its
  `view_url` is null forever. So the preview is web's shape: the picked asset's
  LOCAL uri is the in-session preview, `view_url` (per-read presigned GET, TTL
  300 s) covers receipts scanned on web, and with neither the field shows a text
  line; an `onError` on `<Image>` falls back to the same line — never a broken
  image. Follow-up outside this scope: a receipts upload-confirm endpoint would
  make `view_url` available without a scan (needs backend-engineer).
- Wire: create = `buildCreateBody` + `merchant` + `receipt_id`; edit =
  `buildTransactionPatch` + an EXPLICIT `merchant` diff (the builder deliberately
  emits no merchant key) + an explicit `receipt_id` diff (attach/replace/detach).
- A TYPED charged amount always goes on the wire as `amount_minor`; no preview
  ever writes into a field (`chargePreviewRequest` returns null while the field
  is non-empty — pinned by a test).

## Platform concerns

- `expo-image-picker@~57.0.16` added (was NOT installed) + the `expo-image-picker`
  plugin in `app.json` with iOS usage strings. Camera and library permissions are
  requested at the tap; a denial renders copy with a `Linking.openSettings()`
  button. Size pre-check against 5 000 000 bytes (server `receipt_max_bytes`)
  using `asset.fileSize`; `quality: 0.6` keeps a phone photo under it.
- Hermes has no `Intl.PluralRules` (D-1), so `Intl.DisplayNames` is assumed
  absent too: `countryLabel` uses it when `typeof … === 'function'`, else a flag
  emoji (regional-indicator pair, no Intl) + the code. A probe line in
  `src/lib/probes.ts` logs which arm is live on device.
- D-4: `KeyboardAwareForm` gains a `footer` rendered OUTSIDE the ScrollView,
  inside the KeyboardAvoidingView, padded by `insets.bottom`. Save/Delete move
  there in all four form screens.
- D-3: `LabeledInput` passes `accessibilityLabel ?? label` to its TextInput.

## UI states

- Photo field: idle → creating → uploading → attached / error(retry) /
  permission-denied(open Settings) / too-large. Attached shows the image or the
  text fallback, and a confirm before detaching (detach = unlink only, said so).
- Charge field (pair, create, empty only): converting / estimate / no-rate-ahead /
  fetch-failed / default — all TEXT.
- Everything else keeps the screen's existing loading / unavailable / error arms.

## Open questions

- None blocking. `Intl.DisplayNames` under Hermes, the picker under Expo Go and
  the presigned PUT to MinIO from the simulator are device-verification items
  for mobile-qa.

## Risks

- The presigned PUT from the simulator to MinIO is mobile's first integration
  boundary of this kind (host resolution differs from the API base URL).
- `fetch(uri).blob()` on Hermes for a `file://` / `ph://` URI is the other
  untested seam; a failure surfaces as the field's recoverable error arm.
