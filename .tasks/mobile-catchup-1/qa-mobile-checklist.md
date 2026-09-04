# QA Mobile Checklist: mobile-catchup-1 (dictionary/language A + amount mirror B)

**Status: ✅ READY FOR REVIEW** — Section A 25/25 after the re-probe of
2026-09-04 (D-1 and D-2 fixed; see "Re-probe after D-1/D-2 fix" at the bottom).
The first pass's ❌ verdict below is kept as the record that found them.

## Scope

ONE end-to-end simulator pass over the diff in `git status --short apps/mobile
packages/shared apps/web/src/features/transfers`: the i18n provider/dictionary
(`src/i18n/`), `src/data/profile.ts`, `src/data/errors.ts`, `src/auth/errors.ts`,
the `useLocale()` re-wiring of every formatter, and the shared `mirrorDecision`
wired into `app/(app)/transfer-form.tsx`.

NOT covered here: API contracts and money math (qa-engineer), unit logic already
pinned by `packages/shared/src/amountMirror.test.ts`,
`apps/mobile/src/data/errors.test.ts`, `apps/mobile/src/auth/errors.test.ts`, and
the web client (redesign is being verified in parallel).

## Environment

- **Executed** 2026-09-04, iPhone 17 Pro / iOS 26.5, UDID `97EA8741-…`,
  Expo Go 57.0.9. Device locale left at **ru-RU** (infra.md), keyboard input modes
  left at `ru_RU@sw=Russian;hw=US` from the previous pass.
- **My API**: `uvicorn` on **:8021**, `FX_SCHEDULER_ENABLED=false
  RECURRING_SCHEDULER_ENABLED=false`, `JWT_SECRET` throwaway.
- **My DB**: `budget_mobile_catchup_1` on the project Postgres (:5443), created by
  me, `alembic upgrade head` → 0014.
- **My Metro**: **:8083**, `EXPO_PUBLIC_API_URL=http://127.0.0.1:8021`,
  app opened with `simctl openurl exp://127.0.0.1:8083`.
- The user's 8010 / 5173 / 5433 / 8000 / 8081 were never touched.
- User: `qa-catchup1@budgetqa.dev` / `Qa!Test1234`. Accounts: Main USD 1000.00,
  Savings USD 500.00, Euro EUR 200.00.
- Evidence dir: `/private/tmp/claude-501/-Users-nikitazaretski-work-budget/747ab211-bae8-459f-898e-7671d506058f/scratchpad/`
  (`api.log`, `metro.log`, `crash_accounts.png`, `ru_list.png`, `ru_edit_form.png`,
  `list_transfer.png`, `e2*.json`/`e3*.json` frame dumps).

### Deviations from the brief

- **Registration was done via `POST /auth/register`, not through the register
  screen.** The login screen was driven by hand (password field drops HID chars →
  `simctl pbcopy` + long-press → Paste, same workaround as the 1.8/accounts runs).
- **Device language stayed ru-RU**; instead of re-languaging the user's simulator
  I set `profile.language = "en"` before the first login. That is a stronger check
  of the same code (profile MUST outrank the device) and it is what the provider's
  precedence rule promises.
- **Accounts were created via `POST /accounts`, not through the accounts tab** —
  the accounts tab crashes (D-1) and there is no other way into the tab.
- Amounts were typed with a **comma** (`100,50`, `92,10`) — the character the ru-RU
  decimal-pad actually emits — not with a dot.

---

## Section A: simulator (run by mobile-qa)

### Language / dictionary

**A-1 — profile language outranks the device.** Device ru-RU, `profile.language=en`
→ after login every screen is English (`Transactions`, `INCOME/EXPENSE/NET`,
`RUB 0.00`, `Sep 4, 2026`, `September 2026`). The interface language, not the
device, drives `Intl` — the defect this scope exists to fix. **✅ pass**

**A-2 — pre-login language follows the DEVICE.** Login/register screens render ru
(`Войти`, `С возвращением в Budget.`) because `useProfile()` is disabled while
logged out. Deliberate (plan-mobile.md "No local language cache"). **✅ pass
(documented behaviour)**

**A-3 — auth error copy comes from the mobile dictionary, in the resolved
language.** Wrong password → `Неверная почта или пароль.` at the form root; no
raw code, no English fallback. `auth/errors.ts` returning a key and the screen
rendering it with `t()` works end to end. **✅ pass**

**A-4 — language change needs a COLD restart.** `PATCH /profile {"language":"ru"}`
with the app in the foreground → UI unchanged (no `['profile']` invalidation).
Home → relaunch (background-resume) → still English, and `api.log` shows **no**
`GET /profile` on resume. Kill + relaunch → the whole app is ru. Matches the
documented gap exactly; recorded here so nobody reads it as a defect later.
**✅ pass (documented behaviour)**

**A-5 — ru copy + ru formatting after the cold restart.** Tabs `Операции /
Категории / Счета`; month `сентябрь 2026 г.`; day header `4 сент. 2026 г.`;
summary `0,00 ₽`; rows `-50,00 $` / `92,10 €`; `Показано 2 из 2`; form title
`Изменить перевод`, labels `Откуда / Куда / Сумма отправления (USD) / Сумма
зачисления (EUR) / Заметка (необязательно)`, buttons `Сохранить / Удалить /
Отмена`. Money, dates and month names are all ru-RU, i.e. they follow the
INTERFACE language on a ru device — and would follow it on an en device too, which
is the half A-1 already proved. **✅ pass**

**A-6 — server-error copy comes from the SHARED dictionary, in ru.** New transfer
onto Euro; Euro archived via the API behind the app's back; Save → `POST
/transactions 422` and the form root shows, verbatim from
`packages/shared/src/i18n/errors.ts:267`:
`Счёт в архиве — новые операции по нему записать нельзя. Выберите другой счёт и
сохраните ещё раз.` Recoverable — the form stays filled. **✅ pass**

**A-7 — back to English.** `PATCH {"language":"en"}` + cold restart → English
everywhere again, same rows. **✅ pass**

**A-8 — logout.** Log out → login screen, ru (device). Session cleared. Kill +
relaunch mid-run (5×) always came back **logged in** on the transactions tab —
the secure-store token survives. **✅ pass**

### Accounts tab

**A-9 — accounts tab opens.** ❌ **FAIL — see D-1.** Red screen
`Render Error: undefined cannot be used as a constructor.` at `t.ts:62`,
`new Intl.PluralRules(locale)`. Reproduced 3/3 (en ×1, ru ×1, plus the first en
run), deterministic, not a race.

**A-10 — categories tab opens.** ❌ **FAIL — same D-1**, from
`categories.tsx:43` `t('categoryCount', …)`.

**A-11 — N-4: no count while pending/errored.** ⏸ **blocked by D-1** — the toolbar
is unreachable. Code-verified only: `accounts.tsx:46-51` and `categories.tsx`
render `<View />` while `isPending || isError`, and the count only afterwards.
The fix is correct in the source; it has never rendered on a device.

**A-12 — ru plural `N счетов`.** ⏸ **blocked by D-1.** The CLDR plural that N-1
was upgraded to is exactly what kills the screen; the ru forms have never been
displayed.

### Transfer form — the mirror (B)

**A-13 — same-currency mirror, raw string.** From=Main(USD), To=Savings(USD), type
`100,50` in Amount sent → Amount received becomes `100,50` **verbatim**, comma and
all; both labels read `(USD)`. **✅ pass**

**A-14 — currency switch takes the mirror's figure back.** To := Euro → Amount
received cleared to empty, label becomes `(EUR)`; Amount sent untouched.
**✅ pass**

**A-15 — the user's figure is never overwritten.** Type `92,10` in received, then
change sent `100,50` → (cleared) → `120`. Received stayed `92,10` through every
keystroke, including while sent was empty. **✅ pass**

**A-16 — save.** One row: `⇄ Transfer: Main → Euro, -$120.00, €92.10, 0.7675 EUR /
USD`; server `amount_minor=12000 USD`, `counter_amount_minor=9210 EUR`,
`transfer_rate="0.7675"`. Source leg negative/red, target leg positive/green.
**✅ pass**

**A-17 — EDIT keeps the stored received amount (the 0e872de defect).** Reopen →
`120.00` / `92.10` present, and still present after the form settles. Timing-
sensitive by nature, so run **3×** per the racing-defect policy, sampling the a11y
tree at ~0.3 s / 1.5 s / 4 s after the tap:
- run 1, warm: `['120.00','92.10']` at 0.4 s and settled — pass
- run 2, warm: `['120.00','92.10','Note edit one']` × 3 frames — pass
- run 3, **cold start** (app killed, relaunched, cache cold): `['120.00','92.10',
  'Note edit one']` × 4 frames — pass

3/3 identical. **✅ pass**

**A-18 — note-only edit.** Change only the note → `PATCH /transactions/<id> 200`,
server still `12000 / 9210 / 0.7675`, list still `-$120.00 / €92.10`. The patch
diff did not touch the amounts. **✅ pass**

**A-19 — "Rate at the time" is the server's string.** Edit form shows
`Rate at the time: 0.7675 EUR per 1 USD` / `Курс на тот момент: 0.7675 EUR за 1
USD` — byte-equal to `transfer_rate` in the API response, never recomputed.
**✅ pass**

**A-20 — same-currency EDIT does not auto-follow.** Create Main→Savings `50` → `50`
(mirrored), save (`-$50.00 / $50.00`, no rate line in the row). Reopen edit
(`50.00 / 50.00`), change sent to `60` → received **stays `50.00`**. The stored
figure is not the mirror's, so the ownership rule leaves it alone — the intended
behaviour, and the one the web defect got wrong. **✅ pass**

**A-21 — the mirror reclaims a field the user empties.** Same form, clear the
received field by hand → it refills with `60`. Ownership is returned with the
value, not held forever. **✅ pass**

**A-22 — currencies becoming equal mid-edit does not overwrite a stored figure.**
On the EUR transfer's edit form, switching To from Euro to Main made both legs USD;
`92.10` was **not** replaced by `120.00`. **✅ pass** (found by accident, kept —
it is the ownership rule's hardest case).

**A-23 — archived accounts are not offered.** After Euro was archived, the transfer
form's pickers stopped offering it, while the edit form of the existing row keeps
it selectable (`currentId`). **✅ pass**

### Cross-cutting

**A-24 — visual sanity (ru, `ru_list.png`).** Notch and home indicator clear, tab
bar above the indicator, no clipped or truncated ru text, amounts red/green,
account-filter chips scroll horizontally. **✅ pass**

**A-25 — a11y traits of the controls this scope touched.** Filter chips, tab bar
and account chips all report `Button` + `Selected` on the chosen one; transfer rows
report `Button` with a full sentence label including both legs and the rate; form
errors carry `accessibilityRole="alert"`. **✅ pass, with D-3** (text inputs are
unlabelled).

---

## Defects

### D-1 — BLOCKER (functional): Accounts and Categories tabs red-screen on `Intl.PluralRules`

Hermes in Expo Go 57.0.9 / iOS 26.5 does **not** implement `Intl.PluralRules`
(`Intl.Collator` and `Intl.NumberFormat` work — the probe `[probe:W11]` and the
money/date formatting on the transactions tab prove it). `t.ts:62` constructs one
unconditionally, so **every** call to a plural key throws.

```
Render Error
undefined cannot be used as a constructor.
  t.ts (62:33)          rules = new Intl.PluralRules(locale);
  accounts.tsx (20:17)  const t = useT();
  Call Stack: pluralRules → selectForm → translate → bound → AccountsScreen:49
Metro:  ERROR  [TypeError: undefined cannot be used as a constructor.]
```

Repro (deterministic, 3/3, both languages):
1. Log in, tap the **Accounts** tab (or the **Categories** tab) → red screen.
2. Dismiss the red box → the app is a **blank white screen** and only a reload
   brings it back. In a release build there is no red box at all — the user gets
   the blank screen.

Only two plural keys exist (`accountCount` in `accounts.tsx:49`, `categoryCount`
in `categories.tsx:43`) and both are on a tab root, so two of the three tabs are
completely unreachable. Evidence: `crash_accounts.png`, `metro.log`.

This is a regression introduced by this scope: N-1's upgrade from an `=== 1` branch
to a real CLDR plural is what added the `Intl.PluralRules` call. `apps/mobile` has
no RN component tests and `t.ts` is not covered by a mobile test (plan-mobile.md:
"No `t.test.ts`: mobile's `t.ts` is a byte-copy of web's"), so the vitest gates —
which run under Node, where `Intl.PluralRules` exists — cannot see it. The
byte-copy assumption is the hole: web runs in JSC/V8, mobile runs in Hermes.

### D-2 — cosmetic: "Rate at the time: 1 USD per 1 USD" on a same-currency transfer

`transfer-form.tsx` renders the rate line whenever `isEdit && transfer.transfer_rate`
is truthy, and the server sends `"1"` for a same-currency transfer. The edit form of
the Main→Savings 50→50 transfer therefore reads `Rate at the time: 1 USD per 1 USD`
/ `Курс на тот момент: 1 USD за 1 USD`. The list row correctly omits it. Repro:
open any same-currency transfer for edit.

### D-3 — a11y nit: form inputs have no accessible name

`src/components/LabeledInput.tsx` passes no `accessibilityLabel` /
`accessibilityLabelledBy` to its `TextInput`; the label is a sibling `StaticText`.
Every dump in this run shows `TextField | AXLabel=None | val='120.00'`. With
VoiceOver on, focusing the amount field announces the value and no name — the user
cannot tell "Amount sent" from "Amount received". Affects every form on mobile, not
just this scope; confirm with TC-M1.

### D-4 — nit (harness-flavoured): Save/Delete sit in the home-indicator strip

On the EDIT transfer form at the initial scroll offset, `Save` occupies y 829–873
and `Delete` y 889–933 of an 874 pt screen. Two `idb` taps on the centre of `Save`
produced nothing (no request in `api.log`, no navigation); after one scroll the
same tap worked immediately. `KeyboardAwareForm` does apply
`paddingBottom: insets.bottom + spacing.xl`, so the form is scrollable and this is
recoverable — but the primary action of the form's tallest variant lands in the
system's bottom-edge gesture zone. A finger may behave differently from `idb`;
TC-M4 asks a human to check.

## Known gaps re-confirmed on device (declared in plan-mobile.md, NOT new defects)

- **zod messages stay English.** With the whole UI in ru, submitting an empty
  password shows `Enter your password.`
  (`packages/shared/src/schemas.ts:52`). Same for the transfer amounts.
- **N-5: `toInputString` renders a dot.** The ru edit form shows `120.00` / `92.10`
  in fields whose decimal-pad can only produce `,`. `ru_edit_form.png`.
- **No local language cache** → an English-profile user on a Russian phone gets a
  Russian login screen after logging out (A-2, A-8).
- **N-2 / N-3** were not exercised: not fixed by this scope, no behaviour to check.

---

## Section B: manual device checklist (run by the user, NOT executed here)

### TC-M1 — VoiceOver on the transfer form (covers N-6 and D-3)
- **Device**: physical iPhone, Settings → Accessibility → VoiceOver ON.
- **Steps**: open Transactions → "Add transfer". Swipe right through every element
  from the title to Save.
- **Expected**: each account chip announces its name, "button", and "selected" for
  the chosen one; **each amount field announces its label** ("Amount sent, US
  dollars") before its value; the hint under Amount received is reachable; a
  validation error is announced automatically when Save fails.
- **Known**: the amount fields currently announce no name (D-3). Confirm and say
  whether it is acceptable to ship.
- **Status**: ⏸ needs human

### TC-M2 — ru decimal-pad really types `,` (covers N-5)
- **Device**: physical iPhone, system language **Русский**, no hardware keyboard.
- **Steps**: profile language ru. New transfer, Main → Savings. Tap Amount sent —
  look at the on-screen keyboard. Type `100,50`. Then open a SAVED transfer for edit
  and look at the amount fields.
- **Expected**: the soft decimal-pad shows a `,` key and no `.` key; the typed
  `100,50` mirrors into Amount received verbatim; saving stores 10050 minor.
  On the edit form the stored amount renders as `100.00` with a **dot** — a
  separator this keyboard cannot type. Confirm how bad it looks in practice.
- **Status**: ⏸ needs human (the simulator runs with a hardware keyboard; the soft
  keyboard never renders and is invisible to the accessibility tree)

### TC-M3 — Dynamic Type
- **Device**: physical iPhone. Settings → Display & Brightness → Text Size at max,
  then Accessibility → Larger Text → Larger Accessibility Sizes at max.
- **Steps**: visit Transactions, the transfer form (create and edit), and — once
  D-1 is fixed — Accounts and Categories.
- **Expected**: no clipped or overlapping text; `Rate at the time: …` and the
  received-amount hint wrap instead of truncating; Save/Delete stay reachable;
  the ru strings (which are longer) still fit.
- **Status**: ⏸ needs human

### TC-M4 — Save/Delete reachability at the bottom of the edit form (D-4)
- **Device**: physical iPhone (home-indicator model).
- **Steps**: open a transfer for edit, do NOT scroll, tap Save once with a finger.
- **Expected**: it saves on the first tap. If the first tap is swallowed and only
  the second works, D-4 is a real defect and not a harness artefact.
- **Status**: ⏸ needs human

### TC-M5 — language switch, backgrounded vs killed
- **Device**: physical iPhone + the web app on a laptop, same account.
- **Steps**: (a) with the app in the FOREGROUND, change the language in web
  settings; (b) background the app for 5 min, reopen; (c) force-quit (swipe up) and
  relaunch.
- **Expected**: (a) and (b) keep the old language — there is no `['profile']`
  invalidation and no refetch on resume; only (c) switches. Confirm this is
  acceptable product behaviour or file it.
- **Status**: ⏸ needs human

### TC-M6 — flaky network on the transfer form
- **Device**: physical iPhone, real cellular with poor signal, or airplane mode
  toggled mid-flow.
- **Steps**: fill a transfer, enable airplane mode, tap Save; then disable airplane
  mode and tap Save again.
- **Expected**: a network sentence in the interface language at the form root (from
  `networkMessage(lang)`), the form keeps every value, and the second Save creates
  exactly ONE transfer — no duplicate.
- **Status**: ⏸ needs human

### TC-M7 — D-1 after the fix, on a real device
- **Device**: physical iPhone, Expo Go and a release/TestFlight build.
- **Steps**: open the Accounts tab with 0, 1, 2, 5 and 21 accounts; repeat with the
  profile language ru.
- **Expected**: `1 account` / `2 accounts`; `1 счёт` / `2 счёта` / `5 счетов` /
  `21 счёт`. No red screen, no blank screen. Same for Categories.
- **Status**: ⏸ needs human (and blocked until D-1 is fixed)

---

## Summary

**Section A: 25 TCs — 21 passed, 2 failed, 2 blocked.**

- Failed: **A-9** (accounts tab), **A-10** (categories tab) — both D-1.
- Blocked: **A-11** (N-4 toolbar count, code-verified only), **A-12** (ru
  `N счетов` plural) — both unreachable because of D-1.

**Defects**: D-1 blocker/functional; D-2 cosmetic; D-3 a11y nit; D-4 nit.
Plus three previously-declared gaps re-confirmed on device (English zod messages,
N-5 dot rendering, device-language login screen) — recorded, not counted as new.

**Section B: 7 items awaiting manual verification** (TC-M1…TC-M7). None of them is
a blocker unless senior-lead says so; TC-M7 is blocked behind D-1.

### ❌ FAIL OVERALL — senior-lead must handle D-1.

> **SUPERSEDED 2026-09-04 by "Re-probe after D-1/D-2 fix" at the bottom of this
> file: D-1 and D-2 are fixed, Section A is 25/25 and the verdict is now
> ✅ READY FOR REVIEW.** The paragraphs above are kept as the record of the run
> that found the defects.

Part B (the amount mirror) is clean: 11/11 of its TCs pass, including the edit-mode
ownership rule at 3/3 runs. Part A's dictionary, error routing and locale wiring are
clean too. The single blocker is one line — `new Intl.PluralRules(locale)` in a file
that was copied from web on the assumption that the two engines are equivalent.

## Cleanup

Done by me:
- Dropped my throwaway DB `budget_mobile_catchup_1` (all `qa-catchup1@budgetqa.dev`
  data went with it — user, 3 accounts, 3 transactions).
- Stopped my `uvicorn` on :8021 and my Metro on :8083. Nothing else was stopped.
- Reverted `apps/mobile/tsconfig.json`: `expo start` rewrites the `include` array,
  dropping `.expo/types/**/*.ts` and `expo-env.d.ts`. It is a harness artefact, not
  part of the diff under test — but note that **any** `expo start` re-does it, so
  check `git status` after running the app.

Left for the orchestrator:
- The user's containers (`budget-api-1` :8010, `budget-web-1` :5173,
  `budget-postgres-1` :5443, MinIO) — untouched, still running.
- The simulator is left booted with Expo Go on the login screen, logged out. Its
  keyboard input modes are still `ru_RU@sw=Russian;hw=US` from the previous pass.

---

## Re-probe after D-1/D-2 fix

Targeted 5-check pass, 2026-09-04, over the uncommitted fix
(`src/i18n/plural.ts` + `t.ts::selectForm` + the rate-line condition in
`transfer-form.tsx`). NOT a re-run of the 25 TCs above.

**Environment (same recipe as the first pass).** Own API `uvicorn` on **:8021**,
own DB `budget_mobile_catchup_1` (:5443, `alembic upgrade head` → 0014), own Metro
on **:8083** with `EXPO_PUBLIC_API_URL=http://127.0.0.1:8021`, Expo Go opened via
`simctl openurl exp://127.0.0.1:8083`. Device locale still ru-RU; profile language
driven with `PATCH /profile`. User **`qa-catchup1b@budgetqa.dev`** / `Qa!Test1234`
(new, so the plural counts start from an empty account list); logged in ONCE,
the token reused for every setup call. The user's 8010/5173/5443/8000/8081 were
not touched. Evidence: `rp_metro.log`, `reprobe_api.log`, `rp_s1.png` in the
scratchpad (`…/747ab211-…/scratchpad/`).

**R-1 — the two tabs render; PluralRules is still absent. ✅ pass.** Metro, every
one of the 8 launches, verbatim:

```
LOG  [probe:W11] Collator available = true | PluralRules = undefined | compare(Ё,Е) = 0 | sort = a,Z,Ё,Е
```

`Intl.PluralRules` is `undefined` in Hermes — the fix does not depend on it. Both
tabs render: Accounts → `'Счета'` heading + toolbar + rows, Categories → heading +
`'18 categories'` + the 18 system rows. **No red screen, no blank screen, and the
whole `rp_metro.log` (51 lines, 8 launches) contains zero `ERROR` and zero
`undefined cannot be used as a constructor`.** D-1 is fixed; A-9 and A-10 above
flip to pass.

**R-2 — en counts. ✅ pass.** Accessibility tree, accounts toolbar:
`StaticText | '0 accounts'` (empty state) → after creating Main USD through the
account form, `StaticText | '1 account'` → after Savings USD,
`StaticText | '2 accounts'`. Categories toolbar in the same session:
`StaticText | '18 categories'`. `one` and `other` both correct.

**R-3 — ru counts after a cold restart. ✅ pass.** `PATCH /profile
{"language":"ru"}` + kill/relaunch → the whole UI is ru (`Операции / Категории /
Счета`, `сентябрь 2026 г.`, `1 000,00 $`). Accounts toolbar, by count:

| accounts | tree text | CLDR category |
|---|---|---|
| 1 | `'1 счёт'` | one |
| 2 | `'2 счёта'` | few |
| 5 | `'5 счетов'` | many |

Categories toolbar with 18: `'18 категорий'` (many). All four forms are the ones
`dict.ru.ts` declares — the `n === 1` bug the hand-written rule replaces would have
produced `1 счёт / 2 счёт / 5 счёт`. The 5- and 1-account states were reached by
changing the data behind the app's back and cold-restarting, because the count
only re-renders on a refetch (documented A-4 behaviour, not a new finding).

**R-4 — N-4, no count while pending or errored. ✅ pass, 3/3.** Network-shaped, so
run three times per the racing-defect policy. My API stopped (`:8021` no longer
listening), app killed and relaunched, Accounts tab opened, a11y tree sampled at
~0/2.5/5/7.5/10/12.5 s:
- frames 1–2 (**pending**): toolbar holds `Button | 'Добавить счёт'` and nothing
  else — no `счёт/счёта/счетов` node anywhere in the tree;
- frames 3–6 (**error**): `StaticText | 'Не удалось загрузить счета.'` +
  `Button | 'Повторить'` (both in the toolbar and the state box), still no count.

Identical in runs 1, 2 and 3. A-11 is no longer code-verified-only: it has now
rendered on a device.

**R-5 — D-2, the rate line. ✅ pass.** Same-currency USD→USD transfer created
through the form (Main → Savings, typed `50`, mirror filled `50` verbatim), saved;
the server row is `amount_minor=5000 / counter_amount_minor=5000 /
transfer_rate="1"` — i.e. the exact input that used to print `Курс на тот момент:
1 USD за 1 USD`. Its EDIT form now contains **no `Курс` node at all**; the only
`курс` substring in the tree is the received-amount hint (`…по реальному курсу
банка, с комиссиями.`), which is a different string. The cross-currency control
still shows it: the Main→Euro `120 / 92,10` transfer's edit form has
`StaticText | 'Курс на тот момент: 0.7675 EUR за 1 USD'`, byte-equal to
`transfer_rate` in the API response. D-2 is fixed without losing A-19.

### Section A status after the re-probe

**25 TCs — 25 passed, 0 failed, 0 blocked.** A-9 and A-10 (D-1) now pass; A-11 and
A-12, previously blocked, are verified on device by R-4 and R-3 respectively.

**Defects**: D-1 **fixed**, D-2 **fixed**. D-3 (a11y: inputs have no accessible
name — re-confirmed in every tree dump of this pass, e.g. `TextField | None |
val='50.00'`) and D-4 stand, both nits, neither re-tested here. No new defect
found.

### ✅ READY FOR REVIEW

Section B's 7 items (TC-M1…TC-M7) remain pending human verification; TC-M7 is now
unblocked and is the one worth running first — it asks a real device for the
counts R-3 checked in the simulator, plus the `21 счёт` case this pass did not
reach.

### Cleanup (re-probe)

Dropped `budget_mobile_catchup_1` again (with `qa-catchup1b@budgetqa.dev` and its
3 accounts / 2 transfers), stopped my `uvicorn` :8021 and my Metro :8083, reverted
the `apps/mobile/tsconfig.json` rewrite `expo start` performs. Nothing else
stopped; the user's containers untouched.
