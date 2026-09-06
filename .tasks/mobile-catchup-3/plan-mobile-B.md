# Line B — decisions (recurring, "More"/settings, form tails, O-1)

Written after implementation; only what a reader cannot get from the code comments.

## 1. Recurring

- `data/recurring.ts` is web's module verbatim (queries, writes, invalidation
  matrix). `qk.recurringList` / `qk.recurringUpcoming` SHARE the `['recurring']`
  root on purpose, so one bare invalidation covers the list and the widget;
  DELETE additionally calls the now-exported `invalidateTxLists` (the server
  SET NULLs the attribution on rows the template already created).
- The four pure modules (`periodicity`, `templateStatus`, `firstCharge`,
  `upcomingRows`) are VERBATIM copies of web's, marked as such in their headers.
  No tests copied: web's vitest files pin exactly the same rules, and a second
  identical suite would only re-assert them. Nothing was moved to a package —
  that is a cross-package call, and this line's scope ends at `apps/mobile`.
- **Deviation from web (deliberate): the form has NO currency picker.** The
  server keeps a template's currency equal to its account's (`routers/recurring.py`
  → `ACCOUNT_CURRENCY_MISMATCH` on create, and the stamp follows the account on
  PATCH), so web's `CurrencySelect` can only ever produce a 422. On mobile the
  `currency` field follows the picked account and is shown inside the amount
  label. The account itself stays create-only (`buildRecurringTemplatePatch`
  emits no `account_id` key), exactly as on web.
- `paused` is not part of `recurringTemplateFormSchema`, so the form's switch is
  local state diffed EXPLICITLY in `onSubmit` (the `merchant` precedent in the tx
  form). Rows keep their own one-field pause/resume PATCH.
- Row shows `start_date` only when it is still ahead (`todayApiDateUtc` compare —
  the server decides these dates in UTC). New key `recurring.startsOn`; every
  other sentence is web's, verbatim.
- Day-of-month is a 1..31 chip grid (44pt targets) rather than a `<select>`;
  weekday chips come from `weekdayLabels(locale)` — ISO 0 = Monday, the wire
  order, never `Date.getDay()`.
- The widget takes NO props: line A mounts `<UpcomingCharges />` and owns nothing
  about it. No book-now "+" (separate scope).

## 2. "More" tab

- New 5th tab, LAST (platform convention for an overflow destination). Log out
  stays in the header.
- ONE `useProfile()` feeds base currency + income, so a failed read is one notice.
  The language section does not wait for it (the language is already resolved for
  the whole app; the picker writes, it does not read back).
- **Deviation from web: EVERY base-currency switch is confirmed**, not only the
  one that clears a declared income. A chip row has no "are you sure" affordance
  and a thumb lands next to what it meant; the dialog names the OLD currency
  either way (two message keys: with / without a declared income).
- The income suggestion after a confirmed switch is the SERVER's
  (`GET /fx/convert` through the shared `fxConvertQueryOptions`, which came back
  into `data/fx.ts` for this) — editable, saved only by Save, empty when no rate.
- `useUpdateProfile`: base change → summaries + bare `['goals']` + `['stats']`
  (lines C and A own those families; invalidating an unfetched key is a no-op);
  income-only change → `['goals','list']`. The trigger stays cached-vs-response
  per field.
- **The "language needs a cold restart" gap is CLOSED for a change made on the
  phone** (device-confirmed: the UI flipped ru→en with no reload). A language
  changed on WEB still needs a cold start — nothing invalidates `['profile']`
  from outside and there is no focus refetch. `docs/mobile.md` now says exactly
  that.

## 3. Form tails

- **N-1/N-2 scroll-to-first-error** is in `KeyboardAwareForm`, but NOT as "the
  form passes its ordered field names": every rendered `FieldError` registers
  itself with the wrapper, and a NEW registration is the trigger. That is
  strictly better than a declared order (it measures where the errors actually
  are, so it cannot drift from the JSX), and it needed ZERO edits in the four
  form screens — which matters when three lines share those files. A server
  `setError` is covered for free. An error already inside the viewport is left
  alone: after the first submit RHF revalidates on change, and yanking the view
  while the user types into that very field is worse than the defect.
- **N-3**: `transfer-form` revalidates the OTHER account field when either is
  picked (`pickAccount`). Mobile-only; web unchanged (its fix is a revalidation-
  mode decision for both clients).
- **N-5**: `lib/amountInput.ts` gained `localizeAmountString` /
  `toLocalInputString` / `toLocalSignedInputString` — the exact inverse of
  `normalizeAmountInput`, ru only, applied at every prefill site (transaction,
  transfer, account, recurring, income). `@budget/shared` untouched. One test.
- **Dead key `photo.attach`: NOTHING TO REMOVE.** It does not exist in either
  dict at HEAD (checked `git show HEAD:…dict.en.ts`); the follow-up item is
  stale. A scan for dead keys over the whole dictionary found none.

## 4. O-1 — root cause

Reproduced on the simulator with a state dump in the guard (probes removed
afterwards). Logging out renders the guard TWICE:

1. the live tree → `(app) -> (tabs) -> categories` → `/categories`, correct;
2. one render later the group's children are gone and the `(app)` route is left
   with only its OWN `params`: `{screen:'(tabs)', params:{screen:'accounts'}}` —
   the payload of the navigate that CREATED the route (the `--/accounts` deep
   link, one login earlier). React Navigation never rewrites them when the user
   switches tabs inside the group.

That shape is IDENTICAL to the cold-start arm, where the same params ARE the
answer, so no walk can separate them — which is why the fix is in the latch, not
in `intendedRouteFromNavigationState`. The latch is now FIRST-wins per EPISODE,
an episode being one mount of the guard (`app/(app)/_layout.tsx` hands in a
per-mount token from a `useState` initializer; a ref would be a render-time ref
read, which the lint rule rejects). The warm-deep-link arm still wins over a
route captured at logout because the `(app)` group is unmounted while the user
sits on login — that navigation MOUNTS the layout, i.e. opens a new episode.

Both device captures are verbatim fixtures in `intendedRoute.test.ts`; removing
the fix fails exactly one test. It also explains the second symptom (logout
landing on Transactions in a session with no deep link at all): there the stale
params say `transactions`.

Verified on device after the fix: deep link → login → Accounts; Categories →
logout → login → **Categories**; logout from Accounts → login → Accounts.
