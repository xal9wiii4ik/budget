# QA Web Checklist: receipts-ocr S5 (web-upload-and-poll) + S6 (web-confirm-prefill)

Browser-level QA of the two web subtasks. Executed by web-qa against a running
dev stack; no application code, compose files or conftest touched (env-only setup).

## Scope

Covered: the "Add by photo" journey end to end in the browser — dropzone →
client downscale → `POST /receipts` → raw PUT to MinIO → the PM two-button choice
(2026-07-28) → save-only path, AI path, confirm prefill (S6), the failure/timeout
panels, plus a regression smoke of the pre-existing transaction CRUD + currency
picker.

NOT covered here: pure logic already unit-tested by frontend-engineer
(`targetDimensions`, `pollInterval`, `receiptErrorMessage`/`describeReceiptError`,
`buildConfirmDefaults`, converted-section math) — not re-asserted; API contract
behaviour (qa-engineer, `qa-checklist.md`); mobile (frozen).

## Environment

- API **server A** = no-key (`ANTHROPIC_API_KEY` unset, `FX_SCHEDULER_ENABLED=false`),
  `http://localhost:8010` — the default for A/B/C/G/H.
- API **server B** = `ANTHROPIC_API_KEY=sk-qa-placeholder-not-a-real-key`,
  `http://localhost:8011` — used ONLY for D/E/F, to get past the in-request 503 gate.
  A placeholder key can only ever 401 at Anthropic: provably zero cost, no real key
  anywhere.
- Web: vite dev server on `http://localhost:5173` (`VITE_API_URL` switched via an
  untracked `apps/web/.env.local` for the server-B phase; removed at cleanup).
- DB: `psql -h localhost -p 5443 -U budget -d budget` (never the 5433 container).
  MinIO 9010/9011 from the committed compose.
- Test user: `qa-web-0816@budgetqa.dev` (registered through the UI), own categories.
- Fixtures (scratchpad): `receipt-big.jpg` 2000x3000 (~167 KB) so the client
  downscale really scales, `bank-push.png` 750x400, `notes.txt` (non-image).

Driver: Playwright 1.55/1.50.1 CLI against the SAME dev stack (chromium, real
browser, real file picker via `setInputFiles` — the only way to feed a file into
the hidden `<input type=file>`). Console + network captured per journey; scripts
and screenshots in the run scratchpad (`pw/tc*.mjs`, `shots/*.png`).

## Test cases

| # | Journey | Status |
|---|---|---|
| TC-1 | Upload happy path: big JPEG → progress → TWO-BUTTON choice; **no** `POST /parse` fired; browser PUT to `localhost:9010` 200 (CORS preflight OK) | ✅ pass |
| TC-2 | Save-only: "Save without scanning" → saved panel → "Add transaction with this receipt" → plain form (NO prefill) → save → `transactions.receipt_id` = the receipt (psql); list + summary refresh without reload | ✅ pass |
| TC-3 | AI path with NO key: "Scan with AI" → exact honest `AI_NOT_CONFIGURED` message naming the missing key; NO dead "Try again"; primary action → manual form with the receipt still attached (psql `receipt_id`) | ✅ pass |
| TC-4 | Confirm flow (server B, hand-seeded parsed row): 409 `RECEIPT_ALREADY_PARSED` → poll resumes → "Confirm receipt" prefilled → Save → psql `receipt_id` + `merchant` + `merchant_category_map`; list + summary updated | ✅ pass |
| TC-5 | Failed parse (server B, placeholder key 401 → `ANTHROPIC_ERROR`): mapped message + working "Try again"; polling STOPS in the network log | ✅ pass |
| TC-6 | Timeout panel (server B): row forced to `processing` before "Scan with AI" → 409 `RECEIPT_PROCESSING` → poll resumes → TIMEOUT panel after the client deadline, polling stops | ✅ pass |
| TC-7 | Dropzone rejection: non-image file → inline rejection, dropzone still available | ✅ pass |
| TC-8 | Regression smoke: plain create / edit / delete; currency picker + converted section | ✅ pass |
| TC-9 | Console hygiene across all journeys: no uncaught errors / React warnings | ✅ pass |
| TC-10 | Responsive sanity at 375px (capture modal + confirm form) + keyboard/a11y pass | ✅ pass (1 cosmetic OBS-1, pre-existing) |
| TC-11 | Double-submit on the confirm form must not create two transactions for one receipt | ✅ pass |
| TC-12 | F5 in the middle of the capture flow: no crash, session kept, receipt left as a documented orphan | ✅ pass |
| MD-1 | **MANUAL-DEVICE ITEM — not attempted here:** Safari EXIF-orientation + `canvas.toBlob` behaviour of `downscaleToJpeg` (plan-web Risks). Out of reach in this environment: needs a real Safari/iOS device with a rotated phone photo. Neither passed nor failed. | ⛔ not attempted |

## Evidence per case

**TC-1** — `receipt-big.jpg` (2000x3000, 167 KB) → progress panel ("Preparing the
photo…"/"Uploading the photo…") → choice panel "Photo uploaded. What should we do
with it?" with exactly two actions ("Scan with AI", "Save without scanning") in
212 ms. Network: `POST /receipts 201`, `PUT localhost:9010/... 200` (single request
— the extra `ERR_ABORTED` line in the raw log is a Playwright event artifact; the
`request` event shows ONE PUT), **zero** `POST /receipts/{id}/parse`. CORS: the PUT
carries `Content-Type: image/jpeg` (non-simple → preflighted) and returned 200, so
the MinIO preflight is fine. Client downscale verified on the stored object:
**1000x1500 JPEG, 21 127 bytes, ContentType image/jpeg** (read back from the bucket)
— the 1500px long side and the advisory header both land.

**TC-2** — "Save without scanning" → "Receipt saved." panel (parse call count still
zero) → "Add transaction with this receipt" opens the plain **New transaction**
form: amount `""`, date today, **no** merchant field, **no** delete button, no
receipt chrome. Saved 31.40 → psql: `amount_minor=3140, receipt_id=797c4333…,
merchant=NULL`, receipt row still `pending`. UI updated without reload: EXPENSE
`RUB 31.40`, row present ("Showing 1 of 1").

**TC-3** — `POST …/parse → 503`; panel shows exactly:
"AI reading is unavailable: no AI key is configured on the server. The photo is
saved — add the transaction manually and it stays attached." Buttons present:
"Add transaction with this receipt", "Choose another photo" — **no "Try again"**
(`retryModeForParse('AI_NOT_CONFIGURED') === 'none'` holds in the UI). No poll was
started (0 `GET /receipts/{id}`). The manual form saved 7.77 → psql
`receipt_id=1488823c…`. Screenshot `shots/tc3-no-key.png`.

**TC-4** — seeded `parsed_json = {model:{total "12.50", currency USD, merchant
"QA Coffee House", date 2026-08-14, items Latte 4.50 / Croissant 8.00,
suggested_category_id <own cat>}, suggested_category_id: <own cat>,
suggestion_source: "merchant_map"}`. Click "Scan with AI" → `POST /parse 409`
(ALREADY_PARSED) → **one** `GET /receipts/{id} 200` → straight into **Confirm
receipt**. Prefill: amount `12.50`, currency `USD` (kept selectable via
`extraCurrency`), date `2026-08-14`, merchant `QA Coffee House`, category
preselected `QA Coffee` with hint "Suggested from a similar receipt", kind expense;
read-only items list "Latte $4.50 / Croissant $8.00" (no inputs/buttons inside it);
**no delete button**. Amendment §5 confirmed: converted section "Amount in RUB"
appeared for free with `1037.46` and the honest hint "Rate 82.99643696 as of
Aug 14, 2026 ≈ Estimate…" (rate dated by the RECEIPT date). Saved unchanged →
psql `1250|USD|103746|58de737f…|QA Coffee House|<own cat>|2026-08-14` and
`merchant_category_map` gained `qa coffee house → <own cat>`. List/summary updated
live: `-$12.50 ≈ -RUB 1,037.46` under Aug 14. Screenshots `tc4-confirm*.png`.
(The `model` suggestion arm was covered in TC-11: hint reads "Suggested from this
receipt".)

**TC-5** — placeholder key → Anthropic 401 → row `failed|ANTHROPIC_ERROR` in
2.3 s. Panel: "Reading the receipt failed. Try again in a moment." with
"Try again" / "Add transaction with this receipt" / "Choose another photo".
"Try again" re-POSTed `/parse` (202), failed identically, panel unchanged, no
crash. Polling stopped at the terminal state both times: 2 GETs → still 2 after
8 s idle; 4 → still 4 after another 8 s.

**TC-6** (the senior watch item on the render-time timeout derivation) — row forced
to `processing` + `parse_started_at=now()` BEFORE the click; `POST /parse 409`
(RECEIPT_PROCESSING) → flow resumed polling (spinner "Reading the receipt…", no
error panel at 6 s). The **timeout panel appeared at 60.8 s** ("This is taking
longer than expected. The photo is uploaded — you can wait and try reading it
again, or add the transaction yourself." + "Try reading again" + "Add transaction
with this receipt") — inside the ~80 s fail threshold; the derivation off
`dataUpdatedAt` costs exactly one extra poll past the deadline. Polling stopped
dead: 31 GETs at the timeout, still 31 after 10 s idle (~2 s cadence, no storm).

**TC-7** — `notes.txt` through the picker → "That file is not an image. Pick a photo
or a screenshot." with the dropzone still rendered, and **0** network calls (the
guard runs before `POST /receipts`).

**TC-8** — plain create with USD under an RUB base: converted section with a live
`GET /fx/convert?amount_minor=500&from=USD&to=RUB` → auto `414.98` + rate hint
(no degraded state needed, rates present as of Aug 15); category select synced the
kind; list + summary updated. Edit → `PATCH 200` (`-$6.25 ≈ -RUB 518.73`), delete →
`DELETE 204` and the row/summary dropped. F5 restored the page.

**TC-9** — across all runs: no `pageerror`, no React warnings, no key/act warnings.
The only console `error` entries are the browser's own "Failed to load resource:
… 503/409" lines for the deliberately provoked responses in TC-3/TC-4/TC-6 — the
app handles both in-band.

**TC-10** — 375x812: capture modal, choice panel and saved panel all fit
(`document.scrollWidth === innerWidth === 375`), both choice buttons visible and
tappable (287x36); confirm form fits too. Keyboard: "Add by photo" opens with
Enter, focus lands inside the dialog (Close), first Tab reaches "Choose a photo",
Escape closes both modals and focus returns to the triggering button
("Add by photo" / "Add transaction"). All inputs have real `<label for>`.

**TC-11** — confirm form, `Save` double-clicked (30 ms apart): exactly ONE
`POST /transactions 201`, `count(*) where receipt_id = … → 1`.

**TC-12** — F5 while sitting on the choice panel: page reloads to a working
Transactions screen, session intact, no crash/console error; the uploaded receipt
stays `pending` and unreferenced — the documented consequence the saved panel warns
about ("after you close this window the photo can no longer be picked out").

## Observations (not failures of S5/S6)

- **OBS-1 (cosmetic, pre-existing, currencies-goals WD-3):** at 375 px the
  "Reset to auto" button of the converted section overflows the modal's right edge
  by ~3.7 px and is visually clipped. Reproduced in the **plain create form with no
  receipt involved** (`shots/tc10b-plain-create-375.png`), so it is not introduced
  by S6 — S6 only reuses the section as the amendment requires. Button is still
  visible and clickable; no document-level overflow.
- Mid-flow F5 loses the in-progress receipt (by design — the flow is session-only,
  there is no receipts list endpoint). The UI says so on the saved panel; recorded
  because it is the one journey where a user can strand an uploaded object.

## Summary

Total 12 executed + 1 manual-device item deferred.
- **Passed: 12** (TC-1 … TC-12)
- **Failed: 0**
- **Blocked: 0**
- **Not attempted: MD-1** (Safari EXIF/canvas — needs a real device; explicitly out
  of reach in this environment, neither pass nor fail)

✅ READY FOR REVIEW.

Cleanup done: QA user `qa-web-0816@budgetqa.dev` and all its rows deleted
(cascade: 4 transactions, 9 receipts, 2 merchant-map rows, 1 category, profile),
9 objects removed from the `receipts` bucket, API server B (8011) and the vite dev
server stopped, `apps/web/.env.local` removed. The pre-existing no-key API on 8010
was reused, not started by me, and is left running.
