# QA Mobile Checklist: accounts-and-transfers (subtask MOB)

## Scope

Simulator verification of the mobile client for accounts and transfers: the third
"Accounts" tab (list + create/edit/archive form), the required account picker on the
transaction form, the transfer form (own modal route), the transfer row in the list,
the account filter, and balance-cache invalidation. Plus the regression surface the
scope touches: TC-8 deep-linked `next` across login **with a third tab present**,
categories tab, F-1 comma decimal input.

Not covered here (owned elsewhere): API contracts and money math (qa-engineer,
`qa-checklist.md`), `pickDefaultAccount` / error-routing unit logic
(`src/data/accountLookup.test.ts`, `src/data/errors.test.ts`), web client.

**Executed**: 2026-08-19, iPhone 17 Pro / iOS 26.5 (ru-RU) UDID `97EA8741-…`,
Expo Go 57.0.9, Metro `:8082`, API `:8010`, user `qa-sim-main@budgetqa.dev`
(zero accounts / zero transactions at start).

### Harness notes (environment, not product)

- `idb ui text` types through the device's hardware input source. With the ru-RU
  keyboard active, `.` → `ю`, `,` → `б`, Latin → Cyrillic. Fixed for this run by
  setting the input modes to `hw=US` (`AppleKeyboards = ru_RU@sw=Russian;hw=US`,
  device locale left at ru-RU). Account names typed as ASCII therefore land as
  typed; `,` and `-` reach the fields verbatim, which is exactly the character the
  real ru-RU decimal-pad emits — so F-1 is exercised faithfully, but the *physical
  presence of the `,` and `-` keys on the on-screen keyboard* stays a Section B item
  (the simulator runs with a connected hardware keyboard, the soft keyboard never
  renders and is invisible to `describe-ui`).
- The password field (`secureTextEntry`) drops HID characters; every login in this
  run used `simctl pbcopy` + long-press → Paste (same workaround as the 1.8 run).
- "Offline" arms were produced without touching shared infra: Metro restarted with
  `EXPO_PUBLIC_API_URL=http://127.0.0.1:8011` and a local TCP forwarder 8011→8010
  started/stopped to simulate loss and restoration of connectivity.
- Evidence dir: `/private/tmp/claude-501/-Users-nikitazaretski-work-budget/747ab211-bae8-459f-898e-7671d506058f/scratchpad/`
  (`accounts_tab.png`, `filter_target.png`, `transfer_form.png`, `login.png`,
  `paste_menu.png`, `after_login.png`, `kb_punct.png`, `metro.log`).

---

## Section A: simulator (run by mobile-qa)

### Accounts tab

**A-1 — third tab exists and is reachable.** Tab bar reports `Accounts, tab, 3 of 3`;
Transactions and Categories keep their positions. **✅ pass**

**A-2 — empty state.** Zero accounts → `0 accounts`, "Add your first account — every
transaction is recorded on one." + "Add account" button. **✅ pass**

**A-3 — create card / USD / starting balance typed with a comma.** Name "Card usd",
Card, USD, `1000,50` → server `starting_balance_minor=100050`; row shows `1 000,50 $`.
F-1 normalisation on the signed field confirmed. **✅ pass**

**A-4 — create cash / BYN / empty starting balance.** Row `Cash · BYN 0,00 BYN`,
server `starting_balance_minor=0`. **✅ pass**

**A-5 — negative starting balance.** `-50,25` accepted (minus + comma), row shows
`-50,25 $` in red; server `-5025`. **✅ pass**

**A-6 — balances are server values.** All three rows byte-match `GET /accounts`
`balance_minor` at every checkpoint of this run, each in its OWN currency; no total
across accounts is rendered. **✅ pass**

**A-7 — name required.** Save with an empty name → "Enter a name.", no request.
Invalid amount (`1000б50`, the ru-layout artefact) → "Enter a valid amount." **✅ pass**

**A-8 — edit name + type.** "Card usd two" → "Card usd two edited", Card → Cash;
list and server both updated, balance unchanged. **✅ pass**

**A-9 — currency read-only on edit.** Edit form shows `USD` as text (no chips) plus
"An account's currency can't change. Archive this one and create a new account in the
currency you need." **✅ pass**

**A-10 — archive.** Archive → confirm alert ("Its past operations stay exactly as they
are…") → account moves to a separate `ARCHIVED` section, meta `· Archived`, balance
still shown. No Delete control anywhere. **✅ pass**

**A-11 — unarchive.** Unarchive → confirm → back to the live section, `ARCHIVED`
header gone. **✅ pass**

**A-12 — accounts load error + Retry + recovery.** With the API unreachable:
"Couldn't load your accounts." + Retry. Connectivity restored → Retry loads the three
accounts with correct balances. **✅ pass**

**A-13 — display order.** Live accounts first (locale-aware by name), archived last.
**✅ pass**

### Transaction form

**A-14 — zero accounts.** Picker shows "You have no account to record this on — add one
on the Accounts tab first."; Save reports `NotEnabled`. **✅ pass**

**A-15 — default account, single-account rule.** With exactly one account it is
preselected and the amount is labelled `Amount (USD)`. **✅ pass**

**A-16 — default account, most-recent-cached-transaction rule.** With three accounts
the form opens on the account of the newest cached row. **✅ pass**

**A-17 — default skips archived / empty cache.** After archiving the newest row's
account the form falls back to the next usable one. Opening the form on a month whose
cached list is empty with 3 accounts → nothing preselected, label is plain `Amount`.
**✅ pass**

**A-18 — account required.** Submit unpicked (amount + category filled) → "Choose an
account." and `GET /transactions` total unchanged (no request fired). **✅ pass**

**A-19 — currency follows the selected account.** Typed `10,00` on a USD account, then
switched to the BYN account → label becomes `Amount (BYN)`, the typed text is kept.
**✅ pass**

**A-20 — F-1 comma on the amount.** `25,30` on a USD account → server `2530 USD`;
`10,00` on the BYN account → `1000 BYN`. **✅ pass**

**A-21 — archived accounts in the picker.** Not offered for a new transaction (only the
2 live chips). Editing a row stored on the archived account keeps its chip visible,
selected, labelled `(archived)`. **✅ pass**

**A-22 — accounts error arm on the form.** API unreachable → "Couldn't load your
accounts." + Retry inside the picker, Save `NotEnabled`. Same on the transfer form.
**✅ pass**

**A-23 — double tap on Save.** Two taps ~50 ms apart → exactly one transaction created
(total 4 → 5). **✅ pass**

**A-24 — delete transaction.** Confirm alert → row gone, and the Accounts tab shows the
recomputed server balances (including 120 rows seeded out-of-band). **✅ pass**

### Transfer

**A-25 — fewer than two usable accounts.** Zero accounts and one account both show
"A transfer moves money between two accounts — create a second one on the Accounts tab
first." with Save `NotEnabled`; with one account the From picker is prefilled.
**✅ pass**

**A-26 — create USD→BYN.** From "Card usd" `100,00` → To "Cash byn" `330,00` (both
amounts typed with a comma — F-1 on BOTH fields), labels `Amount sent (USD)` /
`Amount received (BYN)`. **✅ pass**

**A-27 — one row, two legs, rate.** List shows a single row
`⇄ Transfer: Card usd → Cash byn, -100,00 $, 330,00 BYN, 3.3 BYN / USD` — never two
rows, no category. Month summary stayed `2 421,41 ₽` expense (transfer is not spending).
**✅ pass**

**A-28 — same-currency transfer.** Card usd → Card usd two, `20,00` → `20,00`: row
renders both legs and NO rate line. **✅ pass**

**A-29 — edit a transfer.** Row tap → "Edit transfer" prefilled with both legs in their
own currencies plus "Rate at the time: 3.3 BYN per 1 USD". Received changed to
`340,00` → row now reads `340,00 BYN, 3.4 BYN / USD` (server value) and both balances
moved. **✅ pass**

**A-30 — same account both sides.** From = To → pre-submit schema error "Pick a
different account to transfer to." on the **To** picker, no request. **✅ pass**

**A-31 — delete a transfer.** Delete → confirm alert "…Both sides of it go, and both
account balances go back."; Cancel is a no-op; Delete removes the ONE row and restores
both balances (Card usd 855,20 → 875,20; Card usd two −70,25 → −50,25). **✅ pass**

**A-32 — routing by kind.** Transfer row opens the transfer form. A hand-made deep link
`transaction-form?id=<transfer>` shows "This operation is a transfer between accounts —
it is edited on its own screen." and "Open transfer" lands on the loaded transfer form.
**✅ pass**

**A-33 — deep link with an unknown id.** `transfer-form?id=<random>` → "This transfer is
unavailable." + Go back. `account-form?id=<random>` → "This account is unavailable." +
Go back. No form-in-disguise, no crash. **✅ pass**

### Account filter

**A-34 — filter by the source account.** Transfer collapses to its `-100,00 $` leg;
notice reads "Showing Card usd only — the totals above cover every account."; the BYN
expense disappears; counter `Showing 2 of 2`. **✅ pass**

**A-35 — filter by the target account.** Same transfer shows `330,00 BYN` (green,
income colour) with the rate; notice names Cash byn. **✅ pass**

**A-36 — All accounts restores.** Both legs render again, notice gone, count back to the
unfiltered total; unfiltered list identical to before filtering. **✅ pass**

**A-37 — archived accounts in the filter.** Listed with an `(archived)` suffix and
filter correctly (2 rows for the archived account). **✅ pass**

### Balances / cache

**A-38 — balances refresh after every mutation.** Verified against `GET /accounts` after:
expense create (1000,50 → 975,20), transfer create (→ 875,20 / 320,00), transfer edit
(→ 330,00), transfer delete (restored), transaction delete (→ 683,80, which also
absorbed 120 out-of-band rows). No stale value survived a mutation. **✅ pass**

### Regressions, lifecycle, scale

**A-39 — TC-8: deep-linked `next` across login, with the third tab present.**
Triple-run (race-sensitive): (1) warm, logged out from Transactions, deep link
`--/accounts` → landed **Accounts**; (2) cold (Expo Go terminated, launched by the deep
link) → landed **Accounts**; (3) warm, adversarially logged out from **Categories**,
deep link `--/accounts` → landed **Accounts**. Extra arm: deep link `--/categories`
after logging out from Accounts → landed **Categories**. 4/4 consistent, no flapping.
**✅ pass** (see O-1 for a pre-existing, out-of-scope finding met along the way)

**A-40 — categories tab regression.** List renders 31 categories grouped by kind with
System badges; the category form opens and cancels. **✅ pass**

**A-41 — lifecycle.** Backgrounding (HOME) with a half-filled transaction form and
returning preserves account selection + typed amount. Cold start — including two full
simulator reboots — keeps the session (secure store) and lands on Transactions.
**✅ pass**

**A-42 — modal dismiss.** The forms are `presentation: 'modal'`: the iOS pull-down
gesture dismisses them (edge swipe-back correctly does not apply), unsaved input is
discarded, no crash and no stray write. **✅ pass**

**A-43 — mid-flow connectivity loss.** Connectivity dropped with a filled transaction
form open → Save shows "Can't reach the server. Check your connection and try again.",
the form stays open with the account and `77,77` intact. Connectivity restored → Save
again succeeds and the server holds exactly ONE `7777` row (no duplicate, no silent
loss). **✅ pass**

**A-44 — list at scale.** 126 rows in one month: pull-to-refresh brings the list to
`Showing 125 of 125`, windowed rendering yields 33 populated rows with 0 blank ones,
scrolling to the end and back is clean, and the account filter still returns the right
2 rows. **✅ pass**

**A-45 — visual sanity.** `accounts_tab.png`, `filter_target.png`, `transfer_form.png`:
safe areas respected (notch + home indicator), no clipped text, negative balance red,
received leg green, chips wrap correctly, ru-RU money/date formatting throughout.
**✅ pass with defect D-1 below** (spacing, not clipping) — D-1 has since been fixed and
re-verified, see below.

---

## Defects

### D-1 — the account filter row eats ~200 pt of vertical space (visual, medium) — ✅ FIXED, re-verified 2026-08-19

- **Where**: `src/features/accounts/AccountFilter.tsx` rendered inside
  `app/(app)/(tabs)/transactions.tsx`.
- **Observed** (`describe-ui` frames, iPhone 17 Pro): the chips are 36 pt tall
  (`y 251.7–287.7`) but the band between the month toolbar (~150 pt) and the summary
  header (`INCOME` at `y 403.7`) is ~240 pt — i.e. roughly 100 pt of empty space above
  and 100 pt below the chip row. Without accounts (no filter row) `INCOME` sits at
  `y 185`.
- **Effect**: on a 874 pt screen about a quarter of the viewport is blank; the summary
  and the first transactions are pushed below the fold on every load.
- **Likely cause**: a horizontal `FlatList` as a flex child of the column
  `SafeAreaView` stretches to the remaining height (no `flexGrow: 0` / fixed height).
- **Evidence**: `filter_target.png`, frame dump above.
- **Severity**: medium — cosmetic/UX only, nothing is unreadable or unreachable.

**Fix**: `AccountFilter` wraps the `FlatList` in a non-flexing `View` and pins both
with `flexGrow: 0` / `flexShrink: 0`, so the control measures exactly one chip row.

**Re-verification** (targeted probe, 2026-08-19, same build/simulator/user, 3 accounts
seeded, `describe-ui` frames):

- **Layout** — chip row `y 160.7`, height **36.0** (one chip row, no stretch);
  `INCOME` now at **`y = 221.7`** vs `403.7` before the fix — i.e. baseline `185` plus
  the chip row's own ~36.7 pt, exactly the natural cost of the control and nowhere near
  `~400`. The summary card (INCOME/EXPENSE/NET + 4 category lines) and the first
  6 transaction rows are all above the fold on the 874 pt screen (first row `y 425`).
  Height and `y` stayed identical across four independent frames — initial, filtered,
  after horizontal scroll, and after a full remount (tab to Accounts and back).
  **✅ pass**
- **Filter still functions** — tapping `Card usd · USD` applies the filter (banner
  "Showing Card usd only — the totals above cover every account."); tapping
  `Cash byn · BYN` narrows to **`Showing 2 of 2`** with the transfer rendered as the
  single received leg `⇄ Transfer: Card usd → Cash byn, 340,00 BYN, 3.4 BYN / USD`;
  `All accounts` restores the unfiltered month (banner gone, bulk rows back).
  The chip row height never changed while filtering. **✅ pass**
- **Horizontal scroll** — the 4 chips lay out to `x ≈ 597` on a 402 pt screen, so they
  overflow. Swiping the row left shifts content ~210 pt and brings `Cash byn · BYN`
  fully on screen (`x 260`, w 126); swiping right restores `All accounts` to `x 16`.
  Row `y`/height unchanged throughout. **✅ pass**
- **Visual** — `d1_refix.png`: chip row sits tight between the month toolbar and the
  summary card, no dead band, safe areas (notch + home indicator) respected, no clipped
  text; the last chip is cut by the right edge, which is the correct affordance for a
  scrollable row. **✅ pass**
- **Logs** — no app-level errors in the device log during the probe (only UIKit/Security
  framework noise), no red screen.
- **Not a race**: deterministic flex layout, and the measurement repeated identically on
  a cold remount — no triple-run required per the flaky-defect policy.

### Cosmetic nits (recorded, not blockers)

- **N-1** — ✅ **FIXED** (code-verified 2026-08-19, no simulator check needed): the
  accounts toolbar pluralises —
  `apps/mobile/app/(app)/(tabs)/accounts.tsx:40` now reads
  ``sorted.length === 1 ? '1 account' : `${sorted.length} accounts` ``. The live toolbar
  with 3 accounts correctly shows "3 accounts"; the singular branch is code-verified
  only, since the probe user has 3 accounts.
  ~~accounts toolbar always says "N accounts", so a single account reads
  "1 accounts".~~
- **N-2** — submitting a scrolled form does not scroll the first error into view: with
  the transaction form scrolled to Save, "Choose an account." appeared above the
  viewport (`y = -13`), so the tap looks like it did nothing.
- **N-3** — a field error stays visible after its cause is fixed until the next submit
  (RHF onSubmit mode): "Pick a different account to transfer to." remained after From
  was changed to another account.
- **N-4** — while the accounts query is in error the toolbar still shows "0 accounts"
  next to "Couldn't load your accounts.", i.e. it states a count for data we do not
  have.
- **N-5** — prefilled amounts render with a dot (`100.00`, `-50.25`) on a ru-RU device
  whose numeric keyboard types `,`; harmless (shared `toInputString`), but the field
  shows a separator the user cannot type.
- **N-6** — the Type/Save/Archive chips and buttons intermittently report as
  `GenericElement` instead of `Button` in the accessibility tree (seen on the account
  form after mount); worth a VoiceOver look on device (B-8).

### O-1 — pre-existing, OUT OF SCOPE (1.8 auth machinery, not MOB)

A deep-linked `next` leaks into a LATER login: after a session that was entered via
`--/accounts`, logging out from the Categories tab and logging in with no deep link
landed on **Accounts** again. Reproduced identically with the 1.8 route
`--/categories` (logout from Transactions → login → Categories), so it is not caused by
the third tab. In a session with no deep link at all, logout from Categories → login
lands on **Transactions** — which also contradicts the "logout returns you to the screen
you were on" side effect documented in `docs/mobile.md`. Reported for senior-lead to
triage against 1.8; MOB does not touch `intendedRoute.ts` (only `MODAL_PARENT_TAB`
gained the two new form routes).

---

## Section B: manual device (run by the user) — NOT verified here

**TC-M1 — decimal-pad comma on a real ru-RU device.** Transaction amount and BOTH
transfer amounts: type `12,34` using the on-screen keyboard. Expected: the field shows
`12,34`, saving stores 1234 minor. (Simulator ran with a connected hardware keyboard;
the soft keyboard never rendered.) **⏸ needs human**

**TC-M2 — minus on the starting-balance keyboard.** Account form → Starting balance.
Expected: iOS shows the *numbers-and-punctuation* keyboard and a `-` key is reachable
without switching planes; typing `-50,25` yields a negative balance. **⏸ needs human**

**TC-M3 — keyboard occlusion.** With the soft keyboard up on the account, transaction
and transfer forms: every input and the Save button stay reachable (scroll/inset), and
the transfer form's second amount is not hidden behind the keyboard. **⏸ needs human**

**TC-M4 — real airplane mode mid-save.** Fill a transfer, enable airplane mode, tap
Save, disable it, tap Save again. Expected: error message, no duplicate transfer,
balances correct afterwards. **⏸ needs human**

**TC-M5 — Android.** Hardware/gesture Back closes the modal forms without saving; the
numeric keyboard on the starting balance carries `-`; the three-tab bar renders with the
system navigation bar. **⏸ needs human** (no Android emulator on this machine)

**TC-M6 — haptics** on save/delete/archive confirmations, if any are expected.
**⏸ needs human**

**TC-M7 — low-end device performance.** The 126-row month with the filter row: scrolling
stays at 60 fps, no blank cells while flinging. **⏸ needs human**

**TC-M8 — VoiceOver.** Account rows, currency/type/account chips and the filter chips
announce role + selected state (see N-6). **⏸ needs human**

**TC-M9 — dark mode / large text.** The palette is fixed-light; check Dynamic Type
(XXL) does not clip the account row's balance or the transfer row's two legs.
**⏸ needs human**

**TC-M10 — password entry / AutoFill on device.** Logging in with the iOS keychain and a
real keyboard (this environment cannot type into `secureTextEntry` reliably).
**⏸ needs human**

---

## Summary

**Section A**: total 45 — **passed 45**, failed 0, blocked 0.
(The only defect found, D-1, is visual spacing inside an otherwise passing TC A-45; it
is recorded above rather than as a functional failure.)

**Section B**: 10 items awaiting manual verification (TC-M1 … TC-M10) — none of them a
blocker unless senior-lead decides otherwise.

**Verdict: ✅ READY FOR REVIEW** — no functional Section A failure. Outstanding for
senior-lead: nits **N-2…N-6** and **O-1** (pre-existing `next` leak, 1.8 scope).
**D-1** (filter row spacing) and **N-1** (toolbar pluralisation) are **fixed** —
D-1 re-verified on the simulator (`INCOME` back at `y 221.7`, filter + horizontal
scroll intact), N-1 code-verified.

### Re-verification probe — 2026-08-19 (targeted, not a full re-run)

3 checks against the D-1 fix, all **✅ pass**; 1 screenshot (`d1_refix.png`),
~6 `describe-ui` calls, **0 logins** (the existing `qa-sim-main@budgetqa.dev` session
was still alive). Details under D-1 above. No new defects, no regressions observed on
the surfaces touched (filter, summary, list, transfer row, accounts toolbar).

**Run statistics**: 45 Section A test cases, ~110 `idb ui describe-all` calls,
**7 screenshots** (cap 15), 8 in-app logins (7 of them inside the TC-8 triple-run
arms, which are ABOUT auth), 1 simulator-side data seed of 120 rows via API.
