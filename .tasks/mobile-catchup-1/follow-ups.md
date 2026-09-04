# Follow-ups (mobile) — deferred out of mobile-catchup-1

Deliberately NOT fixed in the D-1/D-2 round. Each needs a behavioural change
beyond a few lines, or a decision that is not this scope's to make. Recorded here
so they are not re-discovered from scratch by the next QA pass.

## From this scope's simulator QA (`qa-mobile-checklist.md`, 2026-09-04)

- **D-3 — form inputs have no accessible name.** `src/components/LabeledInput.tsx`
  passes no `accessibilityLabel` to its `TextInput`; the label is a sibling
  `StaticText`, so VoiceOver announces the value and no name ("120.00", not
  "Amount sent"). Affects EVERY form on mobile, not just the transfer form —
  which is why it is not a one-liner here: the label text has to reach the input
  in every call site, including the ones that pass a `ReactNode` label. Manual
  confirmation is TC-M1.
- **D-4 — Save/Delete sit in the home-indicator strip.** On the transfer EDIT form
  at the initial scroll offset, `Save` occupies y 829–873 of an 874 pt screen;
  `idb` taps there were swallowed until the form was scrolled. `KeyboardAwareForm`
  already applies `paddingBottom: insets.bottom + spacing.xl`, so it is
  recoverable — but the primary action of the tallest form lands in the system
  gesture zone. May be an `idb` artefact; TC-M4 asks a human with a real finger
  before anyone changes layout.

## Carried from `plan-mobile.md` (originally `.tasks/accounts-and-transfers/`)

- **N-2 — submitting a scrolled form does not scroll the first error into view.**
  With the transaction form scrolled to Save, "Choose an account." rendered above
  the viewport (`y = -13`), so the tap looks like it did nothing. Needs a
  scroll-to-first-error mechanism in `KeyboardAwareForm` (measure + scrollTo),
  not a copy of web's `scrollIntoView`.
- **N-3 — a field error survives its own fix until the next submit.** RHF is in
  `onSubmit` mode, so "Pick a different account to transfer to." stayed after
  `From` was changed. Fixing means choosing a revalidation mode for every form on
  both clients (web has the same behaviour) — a cross-client UX decision.
- **N-5 — `toInputString` renders a dot on a ru keyboard.** Prefilled amounts show
  `120.00` / `92.10` in fields whose ru-RU decimal-pad can only emit `,`
  (re-confirmed on device this run, `ru_edit_form.png`). The helper is shared
  (`@budget/shared`), so making it locale-aware is a cross-package change that
  also touches web; the input side is already handled by
  `src/lib/amountInput.ts` (F-1).
- **N-6 — chips/buttons intermittently report as `GenericElement`.** Seen on the
  account form just after mount; this run's A-25 saw correct `Button` traits, so
  it is timing-dependent in the a11y tree rather than always wrong. Needs a
  VoiceOver look on a physical device (TC-M1) before any code change.

## Also open, recorded elsewhere, not defects

- zod messages in `@budget/shared/schemas.ts` are English in a Russian UI
  (`docs/mobile.md` KNOWN GAP) — cross-package call.
- Language change needs a COLD restart; no `['profile']` invalidation and no
  refetch on resume (A-4, TC-M5) — documented behaviour awaiting a product call.
