# QA Web Checklist: currencies-goals (W1–W4)

Tier: **STANDARD** (grooming-review §5) → lightweight format: check name,
one-line scenario, expected outcome. No pre-written command blocks.

## Scope

Browser journeys through `apps/web` for the four web subtasks of scope
`currencies-goals`: W1 tx-form currency picker + converted section, W2 list/
summary multi-currency display, W3 goals screen core, W4 contributions +
progress chart. Binding behaviour: `plan-web.md` (W1–W4, WD-1..WD-6) and
`grooming-review.md` §3 R3 (create omits an untouched auto value; edit shows the
stored snapshot + a recompute hint, never live autofill).

NOT covered here: API contracts (qa-engineer, `qa-checklist.md`), pure logic
already pinned by vitest (`convertedSection.test.ts`, `rowDisplay.test.ts`,
`realism.test.ts`, `patch.test.ts`, shared `schemas.test.ts`), receipts flows
(out of scope), mobile (frozen).

## Environment (as executed 2026-08-15)

- Postgres `localhost:5443` (docker compose, pre-existing), `exchange_rates`
  seeded from the S-subtask QA session: 6 pairs (BYN→EUR/RUB/USD, EUR→USD,
  RUB→EUR/USD), ~400 rows each, coverage 2025-07-11 … 2026-08-15.
- API `localhost:8010`, started with `FX_SCHEDULER_ENABLED=false` (R5/P3).
- Web: vite dev server `localhost:5173`, `.env` `VITE_API_URL=http://localhost:8010`.
- User: freshly registered `qa-web-cg-1@budgetqa.dev` (base currency RUB),
  synthetic fixture data only. Working tree tested as-is (uncommitted).

---

## W1 — tx form: currency picker + converted section

### TC-1: currency picker offers exactly the supported set
Open the tx create form as an RUB-base user; inspect the currency select.
**Expected**: options = USD, EUR, RUB, BYN (WD-1); default = base RUB.
**Status**: ✅ PASS — select renders exactly `USD, EUR, RUB, BYN`, RUB preselected.

### TC-2: converted section appears only for a foreign currency
Toggle currency between RUB and USD in the create form.
**Expected**: "Amount in RUB" fieldset renders for USD, absent for RUB (D8).
**Status**: ✅ PASS — fieldset absent with RUB selected (not in a11y tree),
appears immediately on switching to USD/EUR.

### TC-3: debounced preview autofills + rate honesty line
Create form, currency USD, amount 25.00, today's date.
**Expected**: one debounced `GET /fx/convert`; base field autofills; "Rate … as
of …" rendered from server values.
**Status**: ✅ PASS — exactly one request
`GET /fx/convert?amount_minor=2500&from=USD&to=RUB&date=2026-08-15` for the
whole "25.00" keystroke sequence (no per-keystroke storm); field autofilled
`2074.91`; line "Rate 82.99643696 as of 15 авг. 2026 г.. ≈ Estimate — the exact
amount is computed when you save." Re-entering the same inputs served from
cache (no second request) — staleTime works.

### TC-4: submit untouched → server-computed snapshot is stored
Submit TC-3's form without touching the converted field.
**Expected**: server auto-computes; row shows the ≈ line; list + summary update
without reload.
**Status**: ✅ PASS — POST 201, stored `base_amount_minor=207491 / RUB`
(= server recompute at the same rate); row `-25,00 $` / `≈ -2 074,91 ₽`;
summary EXPENSE went 0 → 2 074,91 ₽ with no reload.
*Wire-level omit verified indirectly by TC-9 (below), which is the discriminating
case; request bodies are not observable through the browser tooling.*

### TC-5: user-edited converted amount is stored as the override
Create a EUR 10.00 tx, overwrite the converted value (auto 957.29) with 1500.00.
**Expected**: the typed value is stored, not the auto one.
**Status**: ✅ PASS — row shows `-10,00 €` / `≈ -1 500,00 ₽`; DB row
`base_amount_minor=150000`; summary uses the override. The "≈ Estimate…" note
disappears once the field is edited (the value is no longer an estimate).

### TC-6: edit mode shows the stored snapshot and never live-autofills
Reopen the TC-5 row; change the amount 10.00 → 20.00.
**Expected**: prefill from the stored snapshot; no overwrite on amount change;
"Will be recalculated…" hint (R3 / Disagreement 2).
**Status**: ✅ PASS — field prefilled `1500.00` with hint "Leave this empty to
have the RUB amount calculated for you."; after changing the amount the field
still reads `1500.00` and the hint became "Will be recalculated at the
15 авг. 2026 г. rate when you save." On save the row became `≈ -1 914,58 ₽`
(= 20 × 95.72886522) — exactly what the hint promised (PATCH row 6).

### TC-7: "Reset to auto" clears the override
Set an override (5000.00 → row `≈ -5 000,00 ₽`), reopen, press "Reset to auto",
save.
**Expected**: field clears; PATCH sends null; server recomputes.
**Status**: ✅ PASS — field cleared to empty with the "Leave this empty…" hint;
after save the row returned to `≈ -1 914,58 ₽` (recomputed, not the 5000
override) and the summary followed.

---

## W2 — list + summary display

### TC-8: foreign rows show the muted ≈ base line, base rows don't
List with RUB, USD and EUR rows.
**Expected**: foreign row = own-currency primary + `≈ …RUB` secondary; base rows
have no secondary line (T8′/AM-5).
**Status**: ✅ PASS — `-1 000,00 ₽` row has no secondary line; `-20,00 €` and
`-25,00 $` rows each carry their own ≈ RUB line decoded with the stored
`base_currency`.

### TC-9: unconverted_count banner + totals exclusion
Produced through the UI: USD 25.00 dated 2024-01-15 (before the seeded rate
history) → preview returns the null triple.
**Expected**: no-rate UX in the form; `role="status"` notice in the summary;
totals exclude the row.
**Status**: ✅ PASS — form showed "No exchange rate available for USD→RUB. You
can enter the RUB amount yourself." (field stays enabled, submit not blocked).
Stored row has `base_amount_minor = NULL / base_currency = NULL`. In
`/transactions?month=2024-01` the summary renders
`status` "1 transaction has no exchange rate and is not included in these
totals.", EXPENSE stays `0,00 ₽`, and the row shows no ≈ line.
**This is also the discriminating arm for R3 / Disagreement 1**: the form still
displayed the stale autofill `2074.91` at submit time, and the stored row is
NULL — i.e. the untouched value was omitted, not shipped as an override. See
observation O1.

---

## W3 — goals screen core

### TC-10: nav link + empty state
Sign in as a fresh user, click "Goals".
**Status**: ✅ PASS — "Goals" nav link present, `/goals` renders; free-balance
line "Over the last 3 full months you had about **60 000,00 ₽** a month left
over…" (matches the fixture: one 180 000 ₽ July income / 3 months); empty state
"No goals yet." + CTA, not a spinner.

### TC-11: create a EUR goal with a deadline
EUR 2000.00 target, deadline 2027-02-28, already saved 200.00.
**Status**: ✅ PASS — card: `200,00 € of 2 000,00 €` + progress bar, "Deadline
28 февр. 2027 г.", "On track: 300,00 € a month gets you there." and
"28 718,66 ₽ a month of your free balance is going here." — goal currency and
base currency each formatted with their own currency on one card (T4/AM-5).
Create-form hint tracked the currency ("Recorded as this goal's first
contribution, in EUR.").

### TC-12: obviously unrealistic goal → honest messaging, no invented numbers
RUB 5 000 000 target, deadline 2026-10-31.
**Status**: ✅ PASS — amber block: "Not realistic at your current pace — this
deadline needs 2 500 000,00 ₽ a month." + "At your free balance it takes about
84 months — move the deadline to 15 авг. 2033 г.?" Both figures are the server's
(`monthly_needed`, `months_to_target`, `suggested_deadline`); nothing invented.
Waterfall visible and consistent: 28 718,66 + 31 281,34 = 60 000,00 ₽.

### TC-13: goal with no deadline
RUB 100 000 target, deadline blank.
**Status**: ✅ PASS — "No deadline" + "No deadline set, so there's no monthly
target — add one to see whether you're on pace." (NOT "Need 0/month. On track"),
and "None of your free balance is going here right now." (priority 3, surplus
already allocated).

### TC-14: edit — currency change warning
Edit the RUB goal, switch currency to USD, save.
**Status**: ✅ PASS — ConfirmDialog "Change currency / Changing the currency
relabels every saved amount in USD. Nothing is recalculated or converted."; on
confirm the card reads `0,00 $ of 100 000,00 $` — relabelled, magnitudes
untouched (D12). Edit form correctly omits the create-only "Already saved" field.

### TC-15: archive / unarchive and delete
**Status**: ✅ PASS — Archive behind a confirm ("Its history is kept, but it
stops taking a share of your free balance."); archived card hidden by default,
shown with "Show archived" (`GET /goals?include_archived=true`) with an
"Archived" badge, no allocation line and an "Unarchive" action; unarchive
restored it. Delete confirm is destructive and explicit ("Every contribution
recorded against it is deleted too. This can't be undone — archive it instead if
you want to keep the history."); list updated without reload after each.

---

## W4 — contributions + progress chart

### TC-16: add a contribution updates saved + progress
Add 350.00 EUR to the Lisbon goal.
**Status**: ✅ PASS — saved 200,00 € → 550,00 €, bar grew, monthly needed
recomputed 300,00 € → 241,67 €, and the *other* goal's allocation changed too
(31 281,34 → 36 865,21 ₽) — the list-level invalidation of WD-4 works.

### TC-17: over-withdraw → field-level error
Withdraw 1000.00 EUR from a goal holding 550.00.
**Status**: ✅ PASS — POST → 422; message "That's more than this goal has
saved." rendered under the **amount field** with the field outlined red; modal
stayed open, saved total unchanged. Direction toggle also swaps the helper text
("Enter how much to take out — no minus sign needed.") and the submit label.

### TC-18: valid withdrawal + history list
Withdraw 100.00; expand "History & progress".
**Status**: ✅ PASS — saved 550,00 → 450,00 €; history rows
`15 авг. 2026 г. · -100,00 € · TC18 withdraw` (negative rendered red), the
`350,00 €` add and the `200,00 €` initial contribution; per-row Delete.

### TC-19: delete a contribution
Delete the back-dated withdrawal row.
**Status**: ✅ PASS — confirm "Delete -300,00 € from 15 июн. 2026 г.? This can't
be undone."; row removed, saved total recomputed 270,00 → 570,00 €, chart и both
goals' allocations refreshed without reload.

### TC-20: progress chart renders verbatim
**Status**: ✅ PASS — Recharts area chart: 12 months on X (окт. 25 г. … авг.
26 г.), Y axis in the goal currency (0,00 … 2 000,00), dashed green `Target`
reference line at 2 000,00, contribution bars + area series. Empty months render
flat at 0 (server-emitted), no client gap-filling.

### TC-21: future-dated contribution → accepted + chart mismatch note
Add 120.00 EUR dated 2026-12-01.
**Status**: ✅ PASS — accepted, listed first (`1 дек. 2026 г. · 120,00 €`),
saved total 450 → 570,00 €, and the note appears: "The chart stops at this month
— anything dated later counts toward the saved total (570,00 €) but not toward
the line."

### TC-22: past-dated withdrawal dipping an intermediate month below zero
Withdraw 300.00 EUR dated 2026-06-15 (total stays ≥ 0, running total goes
negative in June/July).
**Status**: ✅ PASS — Y axis re-scaled to -700,00 … 2 100,00 and the series
visibly dips to ≈ -300 across June–July before rising in August. Not clamped at
zero — the server series is rendered verbatim.

---

## Cross-cutting

### TC-23: console + network hygiene
**Status**: ✅ PASS (with expected entries) — zero app-thrown console errors
across all journeys. Console shows only three browser network-level entries:
one 422 (the deliberate TC-17 over-withdraw) and two 401s that were immediately
followed by `POST /auth/refresh → 200` and successful retries of
`/goals/{id}/progress` and `/goals/{id}/contributions` — access-token expiry
handled by the existing refresh interceptor, no user-visible failure.
No request storms: fx previews debounced+cached, mutations followed by exactly
the invalidations WD-4 specifies. (`DELETE … 204 [net::ERR_ABORTED]` entries in
the network log are the devtools artifact for 204 responses; both deletes
succeeded.)

### TC-24: responsive + refresh/deep-link sanity
**Status**: ✅ PASS after the fix round (see "Re-verification" below).
Original run — ❌ FAIL (responsive part) / ✅ PASS (deep-link part):
- Deep-link/refresh: PASS — direct `GET /goals`, `/transactions` and
  `/transactions?month=2024-01` all restore correctly, session persists, no
  wrong redirect.
- Responsive at 375 px: FAIL — the app header overflows horizontally. The nav
  (Transactions / Categories / **Goals**) plus the user email and "Log out"
  exceed the viewport; the email is clipped mid-string and **"Log out" is only
  reachable by scrolling the page sideways**, which also pushes the content
  column off-screen. Repro: resize to 375 px, open any screen.
  Evidence: `apps/web/src/routes/ProtectedLayout.module.css` `.header` is a
  single flex row with no `flex-wrap` and no media query.
  Attribution (honest): the overflow is **pre-existing** layout (email + Log out
  alone already exceed 375 px), *aggravated* by this scope's one-line addition of
  the "Goals" NavLink. Goal cards, the transaction list, the ≈ lines and the
  realism block themselves all reflow correctly at 375 px.

### TC-25 (added during execution): tx form modal at 375 px
**Status**: ✅ PASS after the fix round (see "Re-verification" below).
Original run — ⏸ BLOCKED — the browser automation pane became unresponsive to
clicks (`computer` timed out repeatedly, "Browser pane is currently hidden")
after the mobile-viewport switch; the modal could not be opened at narrow width.
Not an application symptom — the same button worked repeatedly at desktop width
minutes earlier and the page kept rendering fine. Re-run needed to close.

---

## Observations (non-blocking, reported for senior-lead's judgement)

- **O1 — stale converted value stays on screen when a later preview returns
  "no rate".** Repro (TC-9): USD 25.00 with today's date → field autofills
  `2074.91`; change the date to 2024-01-15 → hint switches to "No exchange rate
  available…" but the field keeps showing `2074.91`. Submitting stores NULL
  (correct per R3 — the value was never touched by the user), so what the user
  sees in "Amount in RUB" and what gets stored diverge. Spec-compliant, but the
  displayed number is neither a live estimate nor a stored override. Candidate
  fix: clear the field when an untouched autofill is invalidated by a null
  preview.
- **O2 — clicking the modal backdrop closes the tx form and discards input**
  with no unsaved-changes prompt (pre-existing 1.6 behaviour, not introduced
  here; hit accidentally during testing and lost a filled form).
- **O3 — cosmetic double period** in the rate line: "as of 15 авг. 2026 г.." —
  the localized date already ends in "г." and a sentence period is appended.
  *(O1 and O3 fixed and re-verified in the fix round below; O2 still open.)*
- **O4 (new, minor) — converted fieldset overflows the modal by ~10 px at
  375 px**: the right border of "Reset to auto" is clipped inside the tx form
  modal at exactly 375 px (label and most of the hit area remain visible; fits
  from ~414 px up). The fieldset's min-content width — amount input + nowrap
  button — doesn't shrink with the modal.

---

## Re-verification (fix round) — 2026-08-15, same env/user, working tree as-is

1. **TC-24 → ✅ PASS.** At 375 px the header now wraps into two rows (brand + nav
   on line 1; email + "Log out" on line 2). "Log out" is fully visible, not
   clipped, and keyboard-reachable (Tab focus ring confirmed). Verified on
   `/transactions` and `/goals`: every element sits inside the 375 px column
   (goal cards, action-button rows, realism block, summary, tx rows) — no
   horizontal scrolling needed on either page.
2. **TC-25 → ✅ PASS (with one nit).** The tx form modal at 375 px: all fields
   and the Save button fit without horizontal scroll, and with USD selected the
   "Amount in RUB" section is visible with its autofill (2074.91) and rate line.
   Nit (new, minor): at exactly 375 px the converted fieldset is ~10 px wider
   than the modal body, so the right border of "Reset to auto" is clipped (the
   label and most of its hit area stay visible/clickable). At 414 px it fits
   exactly. Filed as observation O4, not a TC failure.
3. **O1 → fixed.** Create mode, USD 25.00 + today's date → field autofills
   `2074.91`. Changing only the date to 2024-01-15 (no rate) with the field
   untouched now **clears it to empty** and shows "No exchange rate available for
   USD→RUB. You can enter the RUB amount yourself." Typing `3333.33` and then
   switching the date back to 2026-08-15 (rate exists) keeps the typed value —
   the preview never overwrites a user-owned value, and the "≈ Estimate" note
   correctly disappears once the field is edited.
4. **O3 → fixed.** The rate line now reads `Rate 82.99643696 as of 15 авг.
   2026 г.` — a single trailing period (the locale's own), no doubled one.

Console: zero errors across the re-run (only vite connect + React DevTools
notices). Network: exactly two `GET /fx/convert` calls for the whole O1
sequence (2026-08-15 and 2024-01-15); the return to 2026-08-15 was served from
cache — no storm.

Tooling note (unchanged, not an app symptom): after switching a tab to a
sub-768 px viewport the automation pane stops accepting `computer` clicks/scrolls
in that tab (screenshots and `key` still work). Worked around by opening the
modal at desktop width in a fresh tab and then resizing to 375/414 px.

## Summary

- **Total**: 25 (24 planned + TC-25 added during execution)
- ✅ **Pass**: 25 (TC-1 … TC-25; TC-24 and TC-25 on re-verification)
- ❌ **Fail**: 0
- ⏸ **Blocked**: 0

**Overall: ✅ READY FOR REVIEW.** Both fix-round items (header wrap at 375 px,
stale-autofill clearing) verified in the browser, plus the cosmetic rate-line
period. Open, non-blocking: O2 (backdrop click discards the tx form — pre-existing
1.6 behaviour) and O4 (converted fieldset clips "Reset to auto" by ~10 px at
375 px) — for senior-lead's judgement, neither breaks a journey.
