# Follow-ups (mobile) — deferred out of mobile-catchup-2

Recorded so the next pass does not re-discover them. Simulator evidence and TC
numbers: `qa-mobile-checklist.md` in this directory.

## Escalation — needs a server/contract change (NOT this scope's)

- **E-1 — a photo attached without scanning can never be shown back.**
  `GET /receipts/{id}.view_url` is presigned only for statuses in
  `_UPLOAD_PROVEN_STATUSES` (processing/parsed/failed,
  `apps/api/src/budget_api/routers/receipts.py`); a receipt that went
  POST /receipts → presigned PUT and was never `/parse`d stays `pending` forever,
  because receipts have NO upload-confirm endpoint (goal item files DO have one:
  `POST …/files/{id}/confirm`). Both clients therefore show a text line instead
  of the picture on every reopen; mobile keeps an in-session preview of the
  picked asset, exactly like web's object URL. Minimal step: a receipts
  upload-confirm (HEAD the object, flip `pending` → an "uploaded" status that
  `_view_url` honours) + contract regen → FULL tier, backend + all four
  consumers. Web's `AttachPhotoField.tsx` comment ("no presigned GET on the
  contract") is stale and should be corrected in the same pass.

## From this scope's simulator QA (2026-09-04)

- **N-1 — a form-root error renders off-screen after a footer Save.** With Save
  pinned (D-4), a long form is submitted from its bottom while the root
  `FieldError` sits at the top of the scroll content (measured y = −434). Same
  mechanism as catch-up-1's N-2 (no scroll-to-first-error in
  `KeyboardAwareForm`); one fix covers both.
- **N-2 — the transactions LIST hides the original pair.** A €50.00 spend reads
  only `-$58.63`; nothing in `src/features/transactions/*Row.tsx` renders
  `original_amount_minor`/`original_currency`. Web shows it via
  `rowDisplay.primaryAmount`. Part-3 candidate (list/search is part 3's area).
- **N-3 — `toInputString` prints a dot on a comma keyboard** (catch-up-1's N-5,
  re-confirmed on the two new amount fields).
- **N-4 — Expo Go substitutes its own permission usage strings**; the `app.json`
  strings are only visible in a standalone build (TC-M3).
- **N-5 — dead dictionary key `photo.attach`** (both dicts): the field labels
  its buttons `photo.takePhoto` / `photo.choosePhoto` / `photo.replace`. Drop it
  with the next dictionary touch.

## Still open from mobile-catchup-1 (`../mobile-catchup-1/follow-ups.md`)

N-2 (scroll first error into view), N-3 (RHF revalidation mode), N-5
(`toInputString` locale), N-6 (a11y roles timing), the zod-messages gap, and the
cold-restart language change. D-3 and D-4 are CLOSED by this scope.

## Manual-device checklist

`qa-mobile-checklist.md` Section B (TC-M1…TC-M8) — written, not executed. TC-M1
(real camera capture; the simulator shutter is a no-op) is the largest
unverified area of this scope.
