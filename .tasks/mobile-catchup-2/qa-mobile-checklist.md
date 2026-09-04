# QA Mobile Checklist: mobile-catchup-2 (transaction form — spend currency, country, photo, merchant, income)

**Status: ✅ READY FOR REVIEW** (updated 2026-09-04 after the D-1/D-2 fixes).
First pass: Section A 27 TCs — 25 passed, 2 failed (**D-1** copy, **D-2** layout).
Re-probe after the fixes: **R-1…R-5 all ✅** — D-1 and D-2 are closed, no
regression in the expense wording. Section B (8 items) still awaits a human.

## Scope

ONE end-to-end simulator pass over the diff of this scope in `apps/mobile`
(`app/(app)/transaction-form.tsx`, `AttachPhotoField` / `SpendCurrencyPicker` /
`CountryField` / `kindCopy` / `chargePreview`, `data/receipts.ts`, `data/fx.ts`,
`lib/countryLabel.ts`, plus the D-3 `LabeledInput` and D-4 `KeyboardAwareForm`
tails). NOT covered: API contracts and money math (qa-engineer), unit logic
already pinned by `chargePreview.test.ts` / `countryLabel.test.ts` /
`packages/shared/src/originalPair.test.ts` / `packages/api-client` `createBody`
tests, and the transactions LIST (not touched by this scope).

## Environment

- **Executed** 2026-09-04, iPhone 17 Pro / iOS 26.5, UDID `97EA8741-…`,
  Expo Go 57.0.9, device locale **ru-RU**, driver `idb`.
- **My API**: `uvicorn` on **:8022** — `FX_SCHEDULER_ENABLED=false
  RECURRING_SCHEDULER_ENABLED=false RATE_LIMIT_ENABLED=false`, throwaway
  `JWT_SECRET`, `S3_BUCKET=qa-receipts-catchup2`.
- **My DB**: `budget_mobile_catchup_2` on the project Postgres (:5443), created by
  me, `alembic upgrade head` → 0014.
- **My bucket**: `qa-receipts-catchup2` on MinIO :9010, created by me with
  minio-py (the app does NOT auto-create buckets — `services/storage.py` only
  presigns). `receipts` and every other bucket untouched.
- **My Metro**: **:8084**, `EXPO_PUBLIC_API_URL=http://127.0.0.1:8022`, app opened
  with `simctl openurl exp://127.0.0.1:8084`.
- The user's **8010 / 5173 / 5433 / 8000 / 8081** were never touched.
- User `qa-catchup2@budgetqa.dev` / `Qa!Test1234`; accounts Main USD 1000.00,
  Euro EUR 200.00 (created via `POST /accounts`). Logged in ONCE in the app; the
  session survived every restart in the run.
- **FX seed**: one row `EUR→USD @ 1.17250000` for 2026-09-04, provider `qa-seed`.
  GEL deliberately unseeded, so the no-rate path is real.
- **Metro probe (device truth)**:
  `[probe:W11] Collator available = true | PluralRules = undefined |
  DisplayNames = undefined` → `countryLabel` runs its **flag+code fallback arm**
  ("🇬🇪 GE"), exactly as plan-mobile.md predicted.
- Evidence dir:
  `/private/tmp/claude-501/-Users-nikitazaretski-work-budget/747ab211-bae8-459f-898e-7671d506058f/scratchpad/`
  — `c2_api.log`, `c2_metro.log`, `c2_photo_attached.png`, `c2_remove_confirm.png`,
  `c2_picker.png`, `c2_after_login.png`, `c2_edit_dump.txt`, `c2_form*.json`,
  `c2_country*.json`, `c2_ui*.json`, driver `c2_drv.py`.

### Deviations from the brief

- **`RATE_LIMIT_ENABLED=false`** on my API (repeated logins during the login-screen
  workaround would trip `login_rate_limit`). No rate-limit behaviour was under test.
- Registration, both accounts and the profile-language flips were done via the
  **API**, not through the app (register screen and settings are out of scope; there
  is no language picker on mobile by design).
- **The login screen was driven by pasteboard + long-press → Paste** for the
  password: `idb ui text` drops characters at speed (the same workaround as the
  1.8 / catch-up-1 runs). Text elsewhere was typed one character at a time.
- Amounts were typed with a **comma** (`50,00`), the character the ru-RU
  decimal-pad emits.
- One accidental extra `POST /transactions` happened mid-run (an `idb` tap at
  y=798 landed on the pinned footer's Save); the row was deleted via the API and
  the flow restarted. It is the origin of the D-2 observation.
- Photo permission was exercised **denied first, then granted** (a stronger check
  than the brief's order); the grant needed `simctl privacy grant photos` +
  relaunch, which doubled as the cold-start/lifecycle check.

---

## Section A: simulator (run by mobile-qa)

### The form's skeleton

**A-1 — session and data.** Login once → transactions tab, English UI on a ru-RU
device (profile.language=en outranks the device). ✅ pass

**A-2 — kind segment FIRST, direction-worded labels.** Order on a fresh form:
`Type` [Expense|Income] (y=145) → `Paid from` (y=206) → `Amount` (y=279) →
`Currency spent` → `Category` → `Date` → `Name / place` → `Note` → `Photo` →
`More options`. With no account picked the amount label is the bare `Amount`
(deliberate — the code branches on `selectedAccountId === ''`); picking
Main · USD turns it into **`Amount, USD`**. ✅ pass

**A-3 — spend-currency chip → pair mode.** Tapping `EUR` replaces the single field
with **`Spent, EUR`** + **`Charged to the account, USD (optional)`** and the
default hint "Leave this empty and we'll use the day's rate…". ✅ pass

**A-4 — the estimate is the SERVER's number and never touches the field.** Typing
`50,00` → hint `≈ $58.63 at rate 1.17250000 — the exact amount is computed when
you save.` `c2_api.log` shows
`GET /fx/convert?amount_minor=5000&from=EUR&to=USD&date=2026-09-04 200`, whose body
is `{"converted_minor":5863,"rate":"1.17250000"}` — the hint is byte-identical to
the server's rate string and the charged field stays **empty**. ✅ pass

**A-5 — a typed charge kills the preview.** Typing `59,10` into the charged field:
`fx/convert` call count 3 → **3** (no request while typing there) and the hint
falls back to the default sentence. ✅ pass

**A-6 — clearing it brings the estimate back** (from cache, still no new request).
✅ pass

**A-7 — country lives in a folded section and uses the fallback arm.**
`▸ More options, Country: Not set` expands to a filter input + chips rendered as
**`🇦🇩 AD`, `🇬🇪 GE`…** (no `Intl.DisplayNames` in Hermes, per the probe). Filtering
`GE` narrows to one chip; picking it updates the fold summary to
`▾ More options, Country: 🇬🇪 GE`. ✅ pass

**A-8 — merchant input.** `Name / place (optional)` accepts `Cafe Tbilisi`. ✅ pass

### Photo

**A-9 — permission DENIED is graceful and recoverable.** "Choose a photo" →
system prompt → *Не разрешать* → the field renders
`Budget has no access to your photos. You can turn it on in Settings.` + an
**Open Settings** button; the whole form keeps its values, no crash. Tapping
Open Settings foregrounds the **Settings** app (root level — Expo Go has no own
pane on the simulator; a standalone build lands on its own pane → TC-M4).
✅ pass

**A-10 — pick → upload → thumbnail.** After granting, the picker opens, and
choosing an image produces `POST /receipts 201` + `GET /receipts/{id} 200` in
`c2_api.log` and the object
`cf446672-…/a27ed546-4034-4763-8be7-fa50f7c5493a.jpg` (2 078 262 B) **in my
bucket** — i.e. the RAW presigned PUT from the simulator to MinIO works, the seam
the plan flagged as risky. The field shows the local-asset thumbnail plus
"Photo attached / It stays with this operation…" (`c2_photo_attached.png`).
Metro logs only the harmless `Response.blob() is using React Native's Blob` warn.
✅ pass

### Create

**A-11 — the wire body.** Save → `POST /transactions 201`; the stored row is
`original_amount_minor 5000 / original_currency EUR / country "GE" / merchant
"Cafe Tbilisi" / receipt_id a27ed546-… / amount_minor 5863 / original_rate
"1.1726"`. The `5863` is the SERVER's conversion (it equals `/fx/convert`'s
`converted_minor`), and A-15 below proves the client sends **no** `amount_minor`
when the charge field is empty — a body carrying one could not have produced a
`FX_RATE_UNAVAILABLE` 422 there. The row appears in the list without a reload
(`🍽️, Кафе и рестораны, -$58.63`). ✅ pass

### Income

**A-12 — labels flip.** Income segment → `Received to` / `Received, USD` /
`Currency received` / hint "Paid to you in another currency?…" / income categories
/ (further down) `Source` with its hint. ✅ pass

**A-13 — "Other…" → 3-letter code.** `Other…` reveals `Currency code, 3 letters`
prefilled with the account currency; typing `GEL` switches to pair mode with
**`Received, GEL`** + **`Credited to the account, USD (optional)`**. ✅ pass

**A-14 — the no-rate warning arrives BEFORE the save… in expense wording.**
Typing `100` fires `GET /fx/convert?from=GEL&to=USD` (200, null triple) and the
hint appears ahead of the save — correct behaviour, **wrong direction of copy**.
❌ **FAIL — see D-1.**

**A-15 — 422 FX_RATE_UNAVAILABLE switches the form to manual charge.** Save with
the credited field empty → `POST /transactions 422`; the field label loses
`(optional)` (`Credited to the account, USD`) and the income-worded manual
sentence appears ("…write in what actually landed on the account"). No crash,
every value preserved. ✅ pass

**A-16 — manual amount saves.** Credited `37` → `POST /transactions 201`;
row `amount_minor 3700 USD`, `original_amount_minor 10000 GEL`,
`original_rate "0.37"`; list shows `💼, Зарплата, $37.00`. ✅ pass

### View / edit

**A-17 — prefill.** Reopening the expense: `Spent, EUR = 50.00`,
`Charged to the account, USD = 58.63` (the server's value, decoded at the USD
exponent), category and merchant restored, fold summary
`▸ More options, Country: 🇬🇪 GE`, and the photo renders the **text line**
"Photo attached / The photo is attached; it can be shown here after it has been
scanned on the web." — the documented server limitation, **no broken image**.
Evidence `c2_edit_dump.txt`. ✅ pass

**A-18 — D-4: the pinned footer is reachable at the initial scroll offset.**
`Save` sits at y 732–776 and `Delete` at y 784–828 of an 874 pt screen (was
829–873/889–933 before the fix). One `idb` tap on Save at the INITIAL offset,
with no scrolling, saved and closed the form — **3/3 runs**, identical geometry
each time. ✅ pass

**A-19 — an unchanged save issues no PATCH.** Across those same 3 runs the
`PATCH /transactions` count stayed at **0**. ✅ pass

**A-20 — detach → `receipt_id: null`.** Confirming the removal and saving sends
one `PATCH /transactions/{id}`; the row comes back `receipt_id: null` with
amount, pair, country and merchant untouched. Bonus: that PATCH first got a
**401 → refresh → retry 200** in `c2_api.log` — the coordinator's reactive
refresh working on a real screen. ✅ pass

**A-21 — the photo-removal confirm renders UNDER the pinned footer.**
❌ **FAIL — see D-2** (`c2_remove_confirm.png`).

### Cross-cutting

**A-22 — D-3: every text input has an accessible name.** Every `TextField` /
`TextArea` in every dump of this run reports a name equal to its visible label:
`Spent, EUR`, `Charged to the account, USD (optional)`, `Received, GEL`,
`Name / place (optional)`, `Note (optional)`, plus the two inputs with no visible
label carrying explicit ones (`Currency code, 3 letters` in
`SpendCurrencyPicker.tsx:86`, `Country` in `CountryField.tsx:108`). The login
screen's `Почта` / `Пароль` too. The catch-up-1 symptom (`AXLabel=None`) is gone.
✅ pass

**A-23 — language ru after a COLD restart.** `PATCH /profile {"language":"ru"}` +
terminate + relaunch → the form is ru: `Тип`, `С какого счёта списано`,
**`Потрачено, EUR`**, **`Валюта траты`**, **`Списано со счёта, USD
(необязательно)`**, **`Название / место (необязательно)`**, `Фото
(необязательно)`, `Сделать фото` / `Выбрать фото`, **`▸ Ещё, Страна: Не
указана`**, `Сохранить`. Money follows the interface language:
hint `≈ 58,63 $ по курсу 1.17250000 …`, list `-58,63 $`, date `4 сент. 2026 г.`
Switched back to `en` at the end. ✅ pass

**A-24 — offline mid-flow, then recovery.** API killed → Save on the edit form →
`Can't reach the server. Check your connection and try again.` at the form root,
every field preserved, no crash. API restarted → one more tap on Save → the PATCH
lands and the list is correct: **no duplicate row** (total stayed 2). ✅ pass
(with N-1 below).

**A-25 — double-tap on Save creates ONE row.** Two taps ~50 ms apart on a create
form → `POST /transactions` count 4 → **5**, one new row. ✅ pass

**A-26 — lifecycle.** Expo Go terminated and relaunched three times during the
run (permission grant, language switch): every time the app came back **logged
in** on the transactions tab — the secure-store token survives. Form state is not
restored across a kill, which is expected. ✅ pass

**A-27 — visual sanity.** `c2_photo_attached.png` / `c2_remove_confirm.png`: modal
header clear of the notch, the pinned footer sits above the home-indicator strip
with the safe-area band below it, no clipped or overlapping text in either
language, the photo thumbnail is not distorted. ✅ pass

---

## Defects

### D-1 — copy (minor): the pre-save "no rate" sentence is expense-worded on an income

On the INCOME form, with a currency that has no stored rate, the hint reads:

> We keep exchange rates for six currency pairs, and we have none for GEL → USD on
> this date. **Just write in what your bank actually took from the account.**

Money is being *received*; nothing was taken. `kindCopy.ts` deliberately keeps
rate strings out of the table ("exchange rates have no direction"), but this key
is not about the rate — its second sentence gives a DIRECTIONAL instruction.
`chargeManual` / `chargeDefault` / `manualChargeRequired` all have `…Income`
twins; `chargeNoRateAhead` is the one that does not
(`src/i18n/dict.en.ts:194-197`, `dict.ru.ts:175-177` — ru has the same problem:
"сколько банк на самом деле списал со счёта"). Suspected fix: add
`txForm.chargeNoRateAheadIncome` + a `chargeNoRateAhead` entry in `KIND_COPY`.

**Repro**: New transaction → Income → Other… → `GEL` → type `100` in
`Received, GEL` → read the hint under the credited field.
**Evidence**: `c2_api.log` (`GET /fx/convert?from=GEL&to=USD`), the A-14 dump.

### D-2 — layout (minor, with a destructive neighbour): the photo-removal confirm renders behind the pinned footer

Tapping **Remove** on the photo field expands an inline confirm ("Remove it from
this operation?" + `Remove` + `Keep it`) **in place**, with no scroll-into-view.
On the edit form at the offset where Remove itself was tappable, the confirm's
buttons land at y 700–744 and y 752–796 — i.e. under the footer band that starts
at ~y 712 and holds `Save` (732–776) and **`Delete` (784–828)**. In
`c2_remove_confirm.png` the red `Remove` is a clipped sliver and `Keep it` is
invisible; a finger aiming at the confirm hits Save or Delete instead. Taps on
the covered button are swallowed by the footer (reproduced: one `idb` tap on
Remove under the footer did nothing, the same tap after scrolling worked).

Recoverable — scrolling 150 pt reveals both buttons and the removal then works
normally (A-20) — and Delete has its own confirmation, so nothing is lost in one
tap. But a destructive confirm whose "no" button is hidden under a destructive
button is worth one fix.

**Repro**: open a transaction with a photo → scroll so the photo field's Remove
button is just above the footer → tap Remove → the confirm is unreachable.
**Suspected files**: `src/features/transactions/AttachPhotoField.tsx` (inline
confirm, no `scrollTo`) + `src/components/KeyboardAwareForm.tsx` (the footer
overlays the scroll content).

## Nits and observations (not counted as failures)

- **N-1 — a form-root error can appear off-screen.** Now that Save lives in a
  pinned footer, you can submit from the bottom of a long form; the failure
  message renders at the TOP of the scroll view (measured at y = −434 during
  A-24), so the visible result of a failed save is "nothing happened". Consider
  scrolling the root error into view.
- **N-2 — the transactions LIST never shows the original pair.** A €50.00 spend
  reads only `-$58.63`; nothing in `src/features/transactions/*` renders
  `original_amount_minor`. Out of this scope (the form was the scope), but the
  data the form now collects is invisible until you reopen the row.
- **N-3 — `toInputString` renders a dot** in the edit form's amount fields
  (`50.00`) on a keyboard that can only type a comma. Known from catch-up-1 (N-5),
  re-confirmed here.
- **N-4 — the month summary read `RUB 0.00 / No spend yet this month.`** with two
  transactions present. This is honest server output (`unconverted_count: 1`,
  no USD→RUB rate in my seeded DB) rendered by an out-of-scope component; recorded
  so nobody reads it as a form defect.
- **N-5 — Expo Go substitutes its own permission usage strings** ("Give Expo
  projects permission to access your photos"). The `app.json` strings added by
  this scope can only be seen in a standalone build → TC-M3.

---

## Section B: manual device checklist (run by the user, NOT executed here)

### TC-M1 — camera capture end to end
- **Device**: physical iPhone. **Simulator status**: the camera arm opens the
  system capture UI, but the shutter produces nothing (no camera hardware), so the
  whole "take → compress → upload" path is UNVERIFIED.
- **Steps**: New transaction → Photo → *Take a photo* → allow → shoot a real
  receipt → confirm. Watch the field through `creating → uploading → attached`.
  Repeat once in a dark room (a big, noisy JPEG).
- **Expected**: the shot appears as the thumbnail within a few seconds; the
  transaction saves with a `receipt_id`; a phone photo at `quality: 0.6` stays
  under 5 MB, so the "larger than 5 MB" copy should NOT appear. If it does, the
  quality/size pre-check needs re-tuning.
- **Status**: ⏸ needs human

### TC-M2 — killing the app mid-upload
- **Device**: physical iPhone, real (slow) cellular.
- **Steps**: attach a photo and force-quit the app while the field says
  "Uploading…". Relaunch, reopen the form.
- **Expected**: no crash on relaunch, no half-attached photo claimed on the
  transaction; the orphaned `receipts` row is server-side garbage, not something
  the user sees. Report what the field shows.
- **Status**: ⏸ needs human

### TC-M3 — permission denial and re-grant on a standalone build
- **Device**: physical iPhone, TestFlight/dev build (NOT Expo Go — it overrides
  the usage strings, N-5).
- **Steps**: deny camera and photos at first ask. Read the two prompts' texts.
  Tap **Open Settings** from the field, flip the toggle, come back, retry.
- **Expected**: the prompts show the app's own `app.json` usage strings; Settings
  opens on **Budget's own pane**; after re-granting, the very next tap opens the
  picker without a relaunch.
- **Status**: ⏸ needs human

### TC-M4 — the pinned footer under a real finger (D-4 and D-2)
- **Device**: physical iPhone with a home indicator.
- **Steps**: (a) open a transaction for edit, do not scroll, tap **Save** once;
  (b) on a transaction with a photo, tap **Remove** and try to tap **Keep it**
  without scrolling; (c) swipe up from the very bottom edge over the Delete button.
- **Expected**: (a) saves on the first tap; (b) confirms D-2 — say whether the
  hidden "Keep it" is as bad on a real device; (c) the home-indicator gesture wins
  over Delete rather than deleting anything.
- **Status**: ⏸ needs human

### TC-M5 — soft keyboard on the two amount fields
- **Device**: physical iPhone, system language Русский, no hardware keyboard
  (the simulator's soft keyboard never renders, so this is invisible to `idb`).
- **Steps**: pair mode (Main USD + EUR). Tap `Spent, EUR`, then
  `Charged to the account, USD`. Type `50,00`. Then tap `Name / place` and
  `Country` filter.
- **Expected**: a **decimal pad with a comma key** for both amounts, a normal
  keyboard for merchant/country; the keyboard never covers the field being typed
  in nor the footer's Save; the charge hint stays readable above the keyboard.
- **Status**: ⏸ needs human

### TC-M6 — VoiceOver over the new controls (the other half of D-3)
- **Device**: physical iPhone, VoiceOver ON.
- **Steps**: swipe through the whole form: kind segment, account chips, both
  amount fields, currency chips + "Other…", the country fold, photo buttons and
  the attached-photo block, footer.
- **Expected**: each field announces its LABEL before its value (the fix is in the
  tree; only a real screen reader proves the spoken order); the country chips
  announce something usable — with `Intl.DisplayNames` absent they are flag emoji
  plus a code, so verify VoiceOver does not read "🇬🇪" as a pile of letters; the
  fold announces expanded/collapsed; the photo confirm is reachable.
- **Status**: ⏸ needs human

### TC-M7 — receipt photographed with no signal
- **Device**: physical iPhone, airplane mode.
- **Steps**: fill a transaction, attach a photo with the network OFF; then turn it
  on and retry; then Save.
- **Expected**: the field shows its recoverable "The photo didn't upload." arm with
  a retry, never a spinner that never ends and never a silent loss of the form;
  after reconnecting, one retry attaches it and the transaction saves once.
- **Status**: ⏸ needs human

### TC-M8 — Dynamic Type and long country/merchant strings
- **Device**: physical iPhone, Larger Accessibility Sizes at max, ru interface.
- **Steps**: open the form in pair mode with the estimate hint visible, expand
  More options, attach a photo.
- **Expected**: `Списано со счёта, USD (необязательно)` and the three-line rate
  hints wrap instead of clipping; the currency chips and the country grid stay
  usable; the footer does not eat half the screen.
- **Status**: ⏸ needs human

---

## Summary

**Section A: 27 TCs — 25 passed, 2 failed, 0 blocked.**

- Failed: **A-14** (D-1, income no-rate copy is expense-worded, en and ru),
  **A-21** (D-2, photo-removal confirm renders behind the pinned footer).
- Nits recorded, not failed: N-1 (off-screen form-root error), N-2 (list hides the
  original pair), N-3 (dot in a comma keyboard), N-4 (summary/unconverted), N-5
  (Expo Go usage strings).

**Section B: 8 items awaiting manual verification** (TC-M1…TC-M8). None is a
blocker unless senior-lead says so; TC-M1 (real camera) is the biggest genuinely
unverified area of this scope.

### ❌ FAIL OVERALL — senior-lead handles D-1 and D-2.

Everything this scope is actually about works on device: the pair mode and its
server-authored estimate, the 422 → manual-charge fallback, country with the
Hermes fallback arm, merchant, the presigned upload from the simulator into
MinIO, the ru dictionary, and both tails (D-3 names, D-4 footer, 3/3).

## Cleanup

Done by me:
- Stopped my `uvicorn` (:8022) and my Metro (:8084). Nothing else was stopped.
- Reverted `apps/mobile/tsconfig.json` — `expo start` rewrites its `include`
  array; check `git status` after any run of the app.

Left for the orchestrator (deliberately NOT removed):
- DB `budget_mobile_catchup_2` on :5443 (3 transactions, 2 accounts, 1 seeded FX
  row) — drop it when the scope closes.
- MinIO bucket `qa-receipts-catchup2` with ONE object
  (`cf446672-…/a27ed546-….jpg`, 2.0 MB). I do not delete buckets.
- The simulator is left booted, Expo Go logged in as `qa-catchup2@budgetqa.dev`
  with photo + camera permissions granted and the profile language back at `en`.

---

## Re-probe after D-1/D-2 fix (2026-09-04, second run)

Targeted, 5 checks — not a full pass. Same environment as above: my uvicorn on
**:8022** (`budget_mobile_catchup_2` @ :5443, `S3_BUCKET=qa-receipts-catchup2`,
schedulers + rate limit off), my Metro on **:8084**, same simulator
(`97EA8741-…`), same user `qa-catchup2@budgetqa.dev`. **No re-login was needed**:
the stored refresh token survived the new `JWT_SECRET` — cold start logged
`401 → POST /auth/refresh 200 → GET /profile 200` (`rp2_api.log:19-30`), the
coordinator's reactive refresh again. Evidence files carry the `rp2_` prefix in
the same scratchpad dir.

**R-1 — income + GEL pre-save hint is income-worded.** New transaction → Income →
Main · USD → `Other…` → `GEL` → `Received, GEL = 100` →
`GET /fx/convert?amount_minor=10000&from=GEL&to=USD` 200 (null triple) → the hint
under `Credited to the account, USD (optional)` reads
*"We keep exchange rates for six currency pairs, and we have none for GEL → USD on
this date. **Just write in what actually landed on the account.**"* — the
`txForm.chargeNoRateAheadIncome` string, no "took from the account" anywhere on the
screen. `rp2_r1_income_hint.png` also confirms the layout is unchanged (labels not
clipped, footer clear of the home indicator). ✅ pass

**R-2 — the 422 message is income-worded, and the manual amount saves.** Save with
the credited field empty → `POST /transactions 422`; the label drops `(optional)`
and BOTH messages are income copy: `chargeManualIncome`
*"…so this amount is yours to fill in — write in what actually landed on the
account."* plus the red no-rate sentence, and after an empty submit the field-level
*"Enter the amount that actually landed on the account in USD."* Typing `37` →
`POST /transactions 201`; the row is `amount_minor 3700 USD / original 10000 GEL /
original_rate 0.37` (id `16a08d94-…`). Evidence `rp2_r2_422.png`,
`rp2_api.log`. ✅ pass

**R-3 — ru, cold restart.** `PATCH /profile {"language":"ru"}` → terminate +
relaunch → same flow in Russian. Pre-save hint: *«Мы храним курсы по шести
валютным парам, и на эту дату курса для GEL → USD нет. Просто впишите, **сколько
на самом деле пришло на счёт**.»*; after the 422: *«…поэтому эту сумму заполняете
вы — впишите, **сколько на самом деле пришло на счёт**.»* Neither string contains
«списал со счёта». Form cancelled (no junk row), profile switched back to `en`.
✅ pass

**R-4 — Remove opens a NATIVE alert, above the pinned footer.** Attached a photo to
the existing expense `82046eb3-…` (`POST /receipts 201` + `GET /receipts/{id} 200`,
`PATCH …` 200), reopened it, scrolled so `Remove` sat at y 526 — inside the old
D-2 danger zone — and tapped it. The accessibility tree collapses to the alert
alone: `Remove photo?` / `Remove it from this operation?` / `Cancel` (57–197) /
destructive `Remove` (205–345), all at y 397–511, i.e. ~200 pt above the footer
band (Save 732, Delete 784) that used to swallow the inline confirm.
`rp2_r4_alert.png` shows the red `Remove` over the dimmed form. **Cancel keeps the
photo** (the `Photo attached` line is still there); confirming detaches it — the
field falls back to `Take a photo` / `Choose a photo`. Save → one
`PATCH /transactions/82046eb3-…` 200 and the row comes back **`receipt_id: null`**
with `amount_minor 5863 / 5000 EUR / merchant "Cafe Tbilisi 2" / country GE`
untouched — a PATCH that merely omitted the key could not have nulled it.
**D-2 closed.** ✅ pass

**R-5 — expense wording not regressed (KIND_COPY routing guard).** Same form as
expense: Main · USD + `EUR` + `Spent, EUR = 50` → *"≈ $58.63 at rate 1.17250000 —
the exact amount is computed when you save."* (unchanged, server's rate string);
then switching to `Other… → GEL` on the SAME expense form gives
*"…Just write in what **your bank actually took from the account**."* So the new
key is routed by kind, not applied globally. ✅ pass

### New observation from this run (not a failure)

- **N-6 — after the 422 the credited field lands UNDER the modal header.** When the
  form auto-scrolls to the invalid field, `Credited to the account, USD` sits at
  y 24–88 while the sheet header (`Cancel` / `Edit transaction`) occupies y ~55–100
  (`rp2_r2_422.png`): the user sees the red message but the input it points at is
  behind the header until they scroll. Same family as N-1; cosmetic, recoverable,
  reported for the record.

### Re-probe summary

**5 checks — 5 passed, 0 failed.** D-1 (income no-rate copy, en + ru) and D-2
(native removal alert) are both **closed**; the expense path is unregressed.
Section A of the first pass therefore stands at **27/27**, and the scope is
**✅ READY FOR REVIEW** with Section B's 8 manual items still pending a human.

### Re-probe cleanup

- Stopped my `uvicorn` (:8022) and my Metro (:8084). 8010 / 5173 / 5433 / 8000 /
  8081 untouched, nothing deleted.
- DB `budget_mobile_catchup_2` now holds **4** transactions (R-2 added one income
  row) and the MinIO bucket `qa-receipts-catchup2` holds **2** objects (the R-4
  receipt is orphaned by design after the detach). Still for the orchestrator to
  drop at scope close.
- `apps/mobile/tsconfig.json` was rewritten by `expo start` again — check
  `git status` after any run of the app.
- Profile language left at `en`; the simulator is left booted and logged in.
