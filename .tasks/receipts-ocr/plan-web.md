# Implementation Plan (web): receipts-ocr — S5 upload-and-poll, S6 confirm-prefill

Scope: apps/web only. Mobile frozen (2.4 deferred) — ignored here. Two web
subtasks from architecture D14 (S5, S6), STANDARD review tier. This plan folds in
the contract review of D12 + "Contract changes" (see "Contract feedback" below).
The 1.6 obligations (transactions-api §7, categories-api §7) are binding and cited
inline.

---

## Approach

The whole photo→transaction flow is a short-lived, single-session state machine:
capture image → downscale → `POST /receipts` → raw PUT to the presigned URL →
`POST /receipts/{id}/parse` → poll `GET /receipts/{id}` → prefilled confirm form →
existing `POST /transactions`. None of this is durable list state (there is no
receipts list endpoint, D12), so it lives entirely inside one modal opened from the
Transactions page and disappears on close.

Server state still goes through TanStack Query (the receipt row IS server state —
we do NOT copy it into Zustand; the rules forbid that). The three write steps are
mutations; the poll is a `useQuery` with a `refetchInterval` that stops itself on a
terminal status or after the client-side ~60s deadline (D12). The step-machine that
sequences "downscaling → creating → uploading → parsing → polling → ready/failed"
is genuine transient client UI state — it lives in a `useReducer`-backed hook local
to the modal (not Zustand: single component, dies on unmount).

The confirm step is deliberately NOT a new component. Per architecture D8 the
confirm action IS "create a transaction", so we extend the existing
`TransactionFormModal` with an optional `receipt` prop bundle (a third mode
alongside create/edit) rather than forking the form. This keeps one form, one
mutation path, one set of cache invalidations (obligation 9).

Alternative rejected — a bespoke poll loop with `setInterval`/`useEffect`: it would
re-implement retry, cancellation, and cache semantics TanStack Query already gives
us, and would violate "server state only via Query". Rejected — a dropzone library
(`react-dropzone`): the project has zero UI deps beyond RHF/router/query (see
package.json) and adding one needs senior-lead approval; a hand-rolled dropzone is
~40 lines and avoids the dependency.

---

## Subtask breakdown (web)

- **S5 web-upload-and-poll** (STANDARD) — dropzone/input, client downscale to
  ~1500px JPEG, create→PUT→parse→poll flow hook, full error-code UX (429 / 409 /
  422 / 503 / failed-status taxonomy). Depends on S3 (parse pipeline live).
- **S6 web-confirm-prefill** (STANDARD) — extend `TransactionFormModal` with a
  confirm mode: prefill amount (`toInputString`), date, merchant, suggested
  category; currency-mismatch warning; read-only items list; submit via the
  existing create mutation with `receipt_id` + `merchant`. Depends on S4 (confirm
  fields on the contract) and S5.

No re-split — each is one engineer-run sized. S5 is the heavier of the two; if it
runs long, the natural seam is downscale-util-first then flow-hook, but they ship
together.

---

## Screens / components affected

- `apps/web/src/routes/TransactionsPage.tsx` — add an "Add by photo" button in the
  toolbar next to "Add transaction"; add a `{ type: 'receipt' }` variant to the
  existing `ModalState` union that renders the new `ReceiptCaptureModal`. The
  existing create/edit modal wiring is untouched.
- `apps/web/src/features/transactions/TransactionFormModal.tsx` (S6) — new optional
  `receipt` prop enabling confirm mode (details below). No change to create/edit
  behavior when the prop is absent.

## New components / hooks

S5 (`apps/web/src/features/receipts/`):
- `ReceiptCaptureModal.tsx` — modal shell (reuses `components/Modal`) that hosts the
  whole flow: dropzone → progress → error/retry → (on ready) hands off to the
  confirm form. Owns the `useReceiptFlow` state.
- `ReceiptDropzone.tsx` — hand-rolled `<input type="file" accept="image/*">` +
  drag-and-drop zone (a `<button>`/labelled region, `onDragOver`/`onDrop`,
  keyboard-openable). No library.
- `useReceiptFlow.ts` — the orchestration hook: a `useReducer` discriminated union
  driving the three mutations in sequence, then the poll. Returns
  `{ status, receipt?, errorMessage?, retry, reset }`.
- `downscale.ts` — canvas downscale + JPEG re-encode. Splits into a **pure**
  `targetDimensions(w, h, maxLong)` (unit-tested) and the DOM `downscaleToJpeg(file)`
  (not unit-tested — no canvas in jsdom).
- `pollInterval.ts` — pure `pollInterval(status, elapsedMs): number | false` (the
  ~2s-while-active, stop-on-terminal, give-up-after-~60s rule). Unit-tested.

S5 data layer (`apps/web/src/data/`):
- `receipts.ts` — `useCreateReceipt` (`POST /receipts`), `useParseReceipt`
  (`POST /receipts/{id}/parse`), `useReceiptPoll(id, enabled)`
  (`GET /receipts/{id}` with `refetchInterval`), and `uploadToPresigned(upload, blob)`
  — a **raw `fetch`** helper (NOT the api-client) for the external MinIO URL.
- `queryKeys.ts` — add `qk.receipt(id) => ['receipts', id]`.

S5 error layer (`apps/web/src/lib/`):
- `errors.ts` — add `receiptErrorMessage(code: string): string` (the full taxonomy
  table) + `describeReceiptError(error: unknown)` (extracts the code from an
  `ApiError` body via `getErrorCode`, falls back to network/generic). Mirrors the
  existing `describeTransactionError` pattern exactly.

S6 (`apps/web/src/features/transactions/`):
- `confirmDefaults.ts` — pure `buildConfirmDefaults(parsed, suggestion, categories,
  baseCurrency)` computing the prefilled form values (unit-tested).
- `ReceiptItemsList.tsx` — read-only `<ul>` of parsed items (D10, display only).
- (shared) `packages/shared/src/schemas.ts` — add an **optional** `merchant` field
  to `transactionFormSchema` (see Contract feedback / Risks).

---

## Data layer

Endpoints consumed (all exist after S2/S3/S4 per D12):
- `POST /receipts` → `ReceiptCreated { id, status, upload{ url, method, headers,
  expires_at } }`. Mutation via api-client.
- raw `PUT upload.url` with `upload.headers` (Content-Type: image/jpeg), body = the
  downscaled JPEG `Blob`. **Not** api-client — external host, no bearer, no
  401→refresh. Plain `fetch(url, { method: upload.method, headers: upload.headers,
  body: blob })`. Non-2xx → surface as an upload error.
- `POST /receipts/{id}/parse` → 202 `ReceiptRead` (status `processing`). Mutation.
  On success, seed the poll cache: `queryClient.setQueryData(qk.receipt(id), data)`
  so the first poll render isn't a flash.
- `GET /receipts/{id}` → `ReceiptRead`. `useQuery({ queryKey: qk.receipt(id),
  enabled, refetchInterval: (q) => pollInterval(q.state.data?.status, elapsed) })`.

**Query keys:** `['receipts', id]` — a new top-level family, disjoint from
`['transactions', ...]` and `['categories', ...]`, so no existing invalidation
predicate touches it. Receipt cache is ephemeral: short `gcTime`, dropped when the
modal closes (`queryClient.removeQueries({ queryKey: qk.receipt(id) })` on reset).

**Poll mechanism (decided): TanStack Query + `refetchInterval`.** Reasoning: the
receipt row is server state and the rule is "server state ONLY via Query — no
fetch-in-useEffect". `refetchInterval` returning `false` on a terminal status or
past the deadline is exactly the built-in idiom; a bespoke loop would re-invent
cancellation/cache and break the rule. The ~60s give-up is enforced by capturing a
`startedAt` when polling begins and comparing `Date.now() - startedAt` inside
`pollInterval`; past the deadline it returns `false` and the hook flips to a
`timedout` state with a **retry** affordance (re-issues `POST /parse`, per D12
"client-side, no server timeout endpoint").

**Cache invalidation (S6, obligation 9):** the confirm submit goes through the
**existing** `useCreateTransaction`. Its `onSuccess` already invalidates the tx
lists AND `qk.txSummary(affectedMonth(created.occurred_at))`. Because it keys off
the **returned** `created.occurred_at`, the affected month is correct even when the
user edited the receipt date in the form — no change needed to
`data/transactions.ts`. The receipt query is removed on modal close. No optimistic
updates anywhere (no silent writes — D8; confirm is the only write).

---

## S5 detail

### Entry point / placement
"Add by photo" `<button>` in the `TransactionsPage` toolbar, immediately after "Add
transaction" — the two capture paths (manual for large expenses, photo for
everything else, per the PM hybrid model) sit side by side. It opens
`ReceiptCaptureModal` via a new `ModalState` variant. Manual add is unchanged.

### Dropzone
Hand-rolled, no library. A labelled drop region containing a hidden
`<input type="file" accept="image/*" capture>` triggered by a `<button>`; `onDragOver`
(preventDefault + hover style), `onDrop` reads `dataTransfer.files[0]`. Single file
only. Semantic HTML, real `<button>`, `<label>` association, focus-visible ring.
Rejects non-image MIME with an inline message before decode.

### Downscale (client, before upload)
`downscaleToJpeg(file)`:
- **Max-source guard before decode:** reject files over ~20 MiB up front (fast UX
  reject, avoids decoding/OOM on a huge image). This is a UX guard; the server's
  10 MiB post-encode cap (HEAD Content-Length, D5→422 `IMAGE_TOO_LARGE`) is the
  real limit and is handled in the error taxonomy regardless.
- **Decode + EXIF orientation:** `createImageBitmap(file, { imageOrientation:
  'from-image' })` so rotated phone photos come out upright and the bitmap's
  width/height are already the oriented dimensions. Fallback for browsers without
  the `imageOrientation` option: decode via an `HTMLImageElement` (`img.decode()`),
  which modern browsers auto-orient. (Verify Safari in web-qa.)
- **Scale:** `targetDimensions(w, h, 1500)` — scale so the **long** side is ≤1500px;
  never upscale (images already smaller pass through unchanged).
- **Re-encode:** draw onto a `<canvas>` at target size, `canvas.toBlob(cb,
  'image/jpeg', 0.8)`. Quality **0.8** (good OCR legibility vs size; tunable). PNG
  screenshots of bank pushes become JPEG here, matching the fixed `image/jpeg`
  upload contract (D12).

### Upload flow (the hook state machine)
`useReceiptFlow` discriminated union:
`idle → downscaling → creating → uploading → parsing → polling → ready | failed | timedout`.
- `downscaling`: run `downscaleToJpeg`; decode failure → `failed` (generic "couldn't
  read that image").
- `creating`: `POST /receipts`.
- `uploading`: raw PUT of the blob to `upload.url` with `upload.headers`.
- `parsing`: `POST /receipts/{id}/parse`; seed poll cache from the 202 body.
- `polling`: `useReceiptPoll` runs; on `parsed` → `ready` (carry the `ReceiptRead`);
  on `failed` → `failed` (map `receipt.error`); on deadline → `timedout`.
- `ready`: hand `ReceiptRead` to the confirm form (S6).
- `failed`/`timedout`: show the mapped message + a **Retry** button. Retry
  granularity: re-parse (`POST /parse`) when the receipt already uploaded (409/timeout/
  failed-status cases — the object is there); re-start from downscale when the image
  itself was rejected (`IMAGE_TOO_LARGE`, decode failure, `RECEIPT_NOT_UPLOADED`).

### Error UX taxonomy → `receiptErrorMessage`
Codes come from two places: HTTP error bodies (`getErrorCode(ApiError.body)`) on the
create/parse mutations, and the terminal `receipt.error` string on a `failed` poll
result. One table maps both:

| code | source | user message (intent) |
|---|---|---|
| `RATE_LIMITED` (429) | parse/create | "You've hit the limit for now — wait a minute and try again." |
| `RECEIPT_NOT_UPLOADED` (409) | parse | "Upload didn't complete. Try again." (restart) |
| `RECEIPT_PROCESSING` (409) | parse | "This receipt is already being read." (resume poll) |
| `RECEIPT_ALREADY_PARSED` (409) | parse | "This receipt was already read." (go to confirm) |
| `IMAGE_TOO_LARGE` (422) | parse | "That image is too large. Pick a smaller photo." (restart) |
| `AI_NOT_CONFIGURED` (503) | parse | "Photo reading isn't available right now. Enter it manually." |
| `NOT_A_RECEIPT` | failed | "That doesn't look like a receipt. Enter it manually." |
| `UNREADABLE_IMAGE` | failed | "Couldn't read the receipt. Try a clearer photo." |
| `INVALID_MODEL_OUTPUT` | failed | "Couldn't read this one. Try again or enter it manually." |
| `ANTHROPIC_ERROR` | failed | "Reading failed — try again in a moment." |
| `DOWNLOAD_FAILED` | failed | "Something went wrong reading the image. Try again." |
| (unknown string) | failed | generic fallback |
| network / non-ApiError | any | "Can't reach the server…" (reuse existing constant) |

`describeReceiptError` follows `describeTransactionError`'s shape: not-an-ApiError →
network message; else `switch (getErrorCode(body))` → table; else generic. The
`AI_NOT_CONFIGURED` and `NOT_A_RECEIPT` messages both point the user at manual entry
(the always-available path), matching the empty-state discipline.

### UI states (S5)
- **idle/empty:** dropzone with a clear call to action ("Drop a photo or choose a
  file — receipts or bank-screenshot") and a "or add manually" escape.
- **loading (downscaling/creating/uploading/parsing/polling):** a single stable
  progress panel with a status line ("Reading your receipt…") and a spinner/skeleton
  — no layout jank between steps (same panel size). Poll is invisible to the user
  (still "reading").
- **error/timeout:** mapped message + Retry + "enter manually".
- **success:** transitions to the confirm form (S6) in the same modal.

---

## S6 detail

### Form reuse (decided: extend, don't fork)
Add one optional prop to `TransactionFormModal`:
```
receipt?: {
  id: string;
  parsed: ParsedReceiptRead;
  suggestedCategoryId: string | null;
  suggestionSource: 'merchant_map' | 'model' | null;
}
```
When present the modal enters **confirm mode**: title "Confirm receipt"; no delete
button; defaults computed by `buildConfirmDefaults`; a merchant input is rendered; a
currency-mismatch banner and a read-only items list appear; submit calls the
existing `useCreateTransaction` with `receipt_id` + `merchant`. When absent, the
component behaves exactly as today (create/edit). This reuses the whole
category-select/kind-sync/amount-validation/error-routing machinery unchanged.

Base currency + degraded state reuse the existing path: the modal already sources
create-mode currency from `useSummary(month).data?.currency` and disables submit
while it's unknown (`createDegraded`). Confirm mode uses the same — pass the
receipt-date month (or current month; base currency is profile-level and identical
across months) so the summary currency = base currency.

### `buildConfirmDefaults(parsed, suggestion, categories, baseCurrency)`
Pure, unit-tested. Produces `TransactionFormInput`:
- `amount`: `toInputString(parsed.total_minor, parsed.currency ?? baseCurrency)` —
  the 0.4 carry-forward purpose. Uses the parsed currency's exponent so the decimal
  point lands correctly for the parsed value. (Edge: if parsed and base exponents
  differ, the prefilled string may not re-validate against the base-currency schema
  — see Open Questions Q2.)
- `occurred_at`: `parsed.date ?? todayApiDate()` (date nullable per D10).
- `merchant`: `parsed.merchant ?? ''`.
- `category_id`: `suggestion.suggestedCategoryId` **only if** it is present AND found
  in the loaded non-archived category list (guard against cache staleness / an id the
  UI can't render); else `''`. D6 already guarantees the server only suggests a
  visible, non-archived category, so this is a belt-and-suspenders fallback, not the
  common path.
- `kind` (**derivation, decided**): if a suggested category resolved, `kind =
  thatCategory.kind` (income categories → income; the receipt's sign follows the
  category, matching the form's existing category→kind sync). If no suggestion,
  default `kind = 'expense'` — receipts are overwhelmingly purchases. `ParsedReceipt`
  carries no kind (D10), so this is the only signal available.
- `note`: `''` (items live in their own read-only list, not the note).

### Suggestion source indicator (decided: subtle, dismiss-on-change)
When `suggestionSource` is non-null, render a small hint under the category select:
"Suggested from a similar receipt" (`merchant_map`) or "Suggested from this receipt"
(`model`). It disappears once the user changes the selection (derived from whether
the current value still equals the suggested id — no extra state). Keeps the
preselect honest without nagging.

### Currency-mismatch warning (D8)
Base currency = the summary currency already in hand. If `parsed.currency` is
non-null and `!== baseCurrency`, show a non-blocking banner above the amount:
"This receipt is in {parsed.currency}. It'll be saved in {baseCurrency} — check the
amount." The amount field stays editable (D8; server stamps base currency, stage 3.2
owns real multi-currency).

### Items list (D10)
`ReceiptItemsList` renders `parsed.items` as a read-only `<ul>` (name + amount when
present, formatted with the shared money helper against the parsed currency).
Display only — no split flow, no interaction. Stable `key` from index is acceptable
here **only because** the list is immutable (never reordered/edited); if that ever
changes, key on a real id.

### Submit
`onSubmit` in confirm mode builds the create body =
`{ amount_minor, kind, category_id: emptyToNull(category_id), occurred_at,
note: emptyToNull(note), receipt_id: receipt.id, merchant: emptyToNull(merchant) }`
and calls `createTransaction.mutateAsync`. Errors route through the existing
`describeTransactionError` (which already handles `CATEGORY_NOT_FOUND` /
`CATEGORY_ARCHIVED` / the 422 array). New 422 code `RECEIPT_NOT_FOUND` on create
(D12) should be added to `describeTransactionError` as a form-level "This receipt is
no longer available — you can still save it manually" (it fires only if the receipt
vanished, which this scope can't do — but map it honestly rather than fall to
generic). On success the modal closes; invalidation is automatic (obligation 9).

### UI states (S6)
- **loading:** base-currency unknown → `createDegraded` notice + submit disabled
  (existing behavior).
- **empty:** n/a (confirm always has a parsed receipt).
- **error:** field/form errors via the existing routing; currency banner is
  informational, not an error.
- **success:** modal closes, list + summary refetch.

---

## Contract feedback (folded contract review of D12 + "Contract changes")

Walking every field I consume as the client:

1. **`ReceiptCreated.upload`** — I need `url`, `method`, and `headers` to do the raw
   PUT. Confirm `headers` serializes as a plain string→string map I can pass to
   `fetch(..., { headers })`. If it's generated as a closed object literal
   `{ "Content-Type": "image/jpeg" }` that's fine; if `additionalProperties: string`
   it's also fine. **Ask:** ensure it is not typed as an opaque/empty object that
   forces a cast — I must not `as` to use it. `method` typed as the literal `"PUT"`
   is fine. `expires_at` is unused by the happy path (I PUT immediately); no problem.
2. **`ParsedReceiptRead.total_minor`** (int) — present and exactly what I prefill
   from via `toInputString`. Good. `total` (decimal string) is redundant for my
   needs but harmless. **Confirm `total_minor` is a plain integer minor-unit** (not a
   string) so no float/parse on my side.
3. **`ParsedReceiptRead.currency`** (nullable 3-letter) — used for `toInputString`
   exponent + the mismatch warning. Nullable handled (fall back to base). Good.
4. **`ParsedReceiptRead.date`** (nullable) — must be a date-only `"YYYY-MM-DD"`
   string matching the `occurred_at` contract, NOT a datetime. **Confirm** it
   serializes date-only; the form's date input and the summary month slicing both
   assume `YYYY-MM-DD`.
5. **`suggested_category_id` + `suggestion_source`** on `ReceiptRead` (D6) — both
   present, exactly the shape I need to preselect + label. Good. Relies on D6's
   guarantee that a suggested id is always a currently-visible, non-archived category
   (I still guard client-side).
6. **`receipt.error`** is an untyped `str | null`, not an enum component. So the
   failed-status codes (`NOT_A_RECEIPT`, etc.) are **not** in the generated types — I
   map known strings and fall back to generic for anything unknown. This is
   acceptable (matches the `{detail: CODE}` string convention the client already maps
   by hand), but flag it: the taxonomy is a prose contract (D10), not a typed enum,
   so a code rename on the server won't break my build — only silently fall to the
   generic message. **Recommend** the code strings stay stable (they're in D10) and
   web-qa spot-checks each mapped message once.
7. **`TransactionCreate` + `receipt_id`/`merchant`, `TransactionRead` + both** — the
   generated `TransactionCreate` type picks these up after S4 regen; my create body
   just adds the two keys, no new mutation path. Good. **`TransactionRead` gaining
   `merchant`/`receipt_id` is additive** and doesn't affect the 1.6 list/summary
   rendering (obligation confirmed — the row components don't read them).
8. **New 422 `RECEIPT_NOT_FOUND` on create** — covered by the existing AM-5 anyOf
   union shape (obligation 6's runtime narrow already handles string-code vs array);
   I add it to the `describeTransactionError` switch. No shape problem.
9. **No `GET /receipts` list / no `DELETE`** — matches my design (nothing renders a
   list; the modal owns the single receipt). No gap.

No blocking contract problem. The contract is accepted from the web consumer side.
Two "please confirm on regen" items (headers map shape #1, date-only #4) and one
recorded limitation (untyped `error` string #6).

---

## Test plan (vitest; per the no-vacuous-tests policy)

Unit-tested (genuinely breakable pure logic):
- `targetDimensions(w, h, maxLong)` — long-side selection (portrait vs landscape),
  no-upscale when already smaller, exact-boundary, rounding. `downscale.test.ts`.
- `pollInterval(status, elapsedMs)` — 2s while `pending`/`processing`, `false` on
  `parsed`/`failed`, `false` past the ~60s deadline. `pollInterval.test.ts`. This is
  the give-up logic — a real regression risk.
- `receiptErrorMessage` / `describeReceiptError` — every taxonomy code → its message,
  the two sources (ApiError body vs `receipt.error` string), and the unknown-code and
  network fallbacks. Extends `lib/errors.test.ts`. Non-vacuous: contrasts distinct
  codes, not one value re-asserted.
- `buildConfirmDefaults` — kind derivation (suggested income category → `income`; no
  suggestion → `expense`), null date → `todayApiDate`, archived/absent suggested id →
  `''` fallback, amount via `toInputString`. `confirmDefaults.test.ts`.

NOT unit-tested (deferred to web-qa browser journeys):
- `downscaleToJpeg` (canvas/`createImageBitmap` absent in jsdom; EXIF orientation and
  JPEG quality are visual/manual checks).
- `useReceiptFlow` full sequencing, the raw PUT, CORS preflight to MinIO, and the
  end-to-end modal → confirm → transaction journey.

I do not write web-qa's checklist; those journeys belong to the UI-subtask
implementation QA.

---

## Files created / modified

### S5
Created:
- `apps/web/src/features/receipts/ReceiptCaptureModal.tsx`
- `apps/web/src/features/receipts/ReceiptDropzone.tsx`
- `apps/web/src/features/receipts/useReceiptFlow.ts`
- `apps/web/src/features/receipts/downscale.ts` (+ `downscale.test.ts`)
- `apps/web/src/features/receipts/pollInterval.ts` (+ `pollInterval.test.ts`)
- `apps/web/src/data/receipts.ts`
- (CSS modules as needed for the modal/dropzone, mirroring existing `.module.css`)

Modified:
- `apps/web/src/data/queryKeys.ts` — add `qk.receipt`.
- `apps/web/src/lib/errors.ts` (+ `errors.test.ts`) — add receipt taxonomy.
- `apps/web/src/routes/TransactionsPage.tsx` — "Add by photo" button + modal variant.

### S6
Created:
- `apps/web/src/features/transactions/confirmDefaults.ts` (+ `confirmDefaults.test.ts`)
- `apps/web/src/features/transactions/ReceiptItemsList.tsx`

Modified:
- `apps/web/src/features/transactions/TransactionFormModal.tsx` — confirm mode.
- `apps/web/src/lib/errors.ts` — add `RECEIPT_NOT_FOUND` to `describeTransactionError`.
- `packages/shared/src/schemas.ts` — optional `merchant` on `transactionFormSchema`
  (see Risks).
- `apps/web/src/routes/TransactionsPage.tsx` — pass the ready receipt into the
  confirm modal (may be handled inside `ReceiptCaptureModal` instead — decided at
  implementation; leaning: the capture modal swaps to the confirm form itself so the
  page only knows one modal variant).

---

## Open questions (recommendations; Phase 3.5 style)

- **Q1 — `merchant` field on the shared `transactionFormSchema`.** The schema is
  shared with mobile (frozen). Adding `merchant` as a **required** input key would
  break mobile's `defaultValues` typing. **Recommend:** add it as
  `z.string().optional()` (or `.default('')`) so it's additive and non-breaking, and
  render the input only in confirm mode. This is a `packages/shared` edit — small and
  additive, but it touches a shared contract, so senior-lead should confirm frontend
  may make it (it's a form schema, which already lives in shared and is
  frontend-owned by precedent). Alternative: keep `merchant` out of the schema and
  handle it as a plain RHF field outside the zod object — messier, splits validation.
- **Q2 — prefill amount when parsed currency exponent ≠ base currency exponent.**
  `toInputString(total_minor, parsed.currency)` produces a string in the parsed
  currency's decimals; the amount field validates against `moneyAmountSchema(base)`.
  If exponents differ (e.g. JPY receipt, USD base, or vice-versa) the prefilled
  string can fail `too-many-decimals` or read oddly. **Recommend:** prefill with the
  parsed currency's formatting and rely on the mismatch warning + editability; accept
  that a cross-exponent case may need a manual fix. Cheap alternative if we want zero
  validation surprises: when currencies differ, prefill the amount **empty** and let
  the warning drive the user to type it. I lean to prefill-and-warn (fewer keystrokes
  in the common same-currency case, which is the vast majority).
- **Q3 — retry granularity on `timedout`.** Recommend re-`POST /parse` (object is
  already uploaded) rather than restart-from-photo; restart-from-photo only for
  image-rejection codes. Non-blocking; stated in S5 above.
- **Q4 — where the confirm form lives.** Recommend `ReceiptCaptureModal` swaps its
  own body from progress to the confirm form (renders `TransactionFormModal`'s
  confirm mode inline) so `TransactionsPage` only manages one modal variant.
  Alternative: the page owns a separate confirm-modal state and the capture modal
  reports a "ready" receipt up. Leaning to the former (self-contained flow).

## Risks

- **Shared-schema change (Q1)** — a mis-scoped `merchant` field could ripple to
  mobile typing; the optional form neutralizes it, but this is the one cross-package
  edit and needs the senior-lead nod.
- **Canvas/EXIF cross-browser** — `createImageBitmap({ imageOrientation })` and
  `canvas.toBlob` behavior (orientation, quality, memory on large images) vary by
  browser; not covered by vitest. Web-qa must exercise a rotated phone photo and a
  large PNG screenshot on Safari + Chrome.
- **CORS preflight to MinIO** — the raw PUT with a `Content-Type` header is a
  non-simple request → OPTIONS preflight. D9 says MinIO defaults to `*`; if the
  bucket/proxy config diverges, the browser PUT fails. Verify in web-qa; if it fails
  it's a backend/compose fix (root-file, backend-owned), not a client workaround.
- **Presign expiry** — we PUT immediately, so the 600s PUT TTL (D9) is ample; only a
  risk if the user's connection stalls between create and PUT. Surfaced as a normal
  upload error → Retry.
- **Poll deadline vs server pipeline** — the ~60s client deadline is shorter than the
  server's 90s parse timeout (D10). A slow-but-succeeding parse could hit the client
  `timedout` state; Retry re-parses and 409 `RECEIPT_PROCESSING`/`ALREADY_PARSED`
  then resumes/goes-to-confirm cleanly. Acceptable, but note the deadline is a UX
  choice — if false timeouts appear in QA, bump it (client-side, D12).
</content>
</invoke>
