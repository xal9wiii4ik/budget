# Meta-review (senior-lead) — web-transactions-ui (1.6)

Under meta-review: review.md (code-reviewer, full uncommitted diff, verdict
APPROVE-WITH-FIXES: 0 MAJOR / 4 MINOR / 5 NIT). Independent verification
performed before ruling: I re-read the delete `catch` (TransactionFormModal
confirmDelete — no invalidation, finding 1 confirmed), `MONTH_PATTERN`
(`/^\d{4}-\d{2}$/` at TransactionsPage.tsx:20 — accepts "2026-13", finding 2
confirmed), the four open-coded `''→null` create-path bridges (findings 4
confirmed at TransactionFormModal.tsx:129,131 + CategoryFormModal), and
`schemas.test.ts` (only pre-existing money/currency suites — the new form
schemas have zero tests, sharpening finding 9's tail). Finding 3's mechanism
(React `onKeyDown` fires only while focus is inside the subtree; Safari does not
focus buttons on click; disabled elements drop focus to `<body>`) is standard
documented behavior — no reproduction needed. The reviewer's "Verified correct"
section overlaps my diff-gate reads (patch builders, invalidation completeness,
composite keys, RHF resolver freshness, shared-schemas boundary) with no
contradictions — two independent reads agreeing.

## Ruling per finding

1. **MINOR — delete-path 404 leaves the stale row. AGREE; fix required.** The
   edit path proves the team knew the failure mode; the delete path shows the
   user "This transaction no longer exists. Refresh and try again." while
   refusing to do exactly that. The proposed hoist (404-triggered
   `invalidateTxLists` into `onError` of BOTH `useUpdateTransaction` and
   `useDeleteTransaction`, inline copy in the modal deleted) is the right shape:
   it fixes the bug AND removes the duplicated predicate (subsumes finding 5).
2. **MINOR — `MONTH_PATTERN` accepts impossible months. AGREE; fix required.**
   Verified the failure chain: `2026-13` → `monthBounds` emits `2026-13-01` →
   server 422 → permanent error with a Retry that cannot succeed, while the
   header labels "January 2027" (label/data disagreement). One-line regex
   `/^\d{4}-(0[1-9]|1[0-2])$/`; the existing `currentMonth()` fallback does the
   rest. Cheap, user-visible, required.
3. **MINOR — Modal Esc/trap subtree scoping. AGREE; fix required.** The plan
   itself named the focus trap "the a11y-fragile part"; a trap that depends on
   where the last click landed is not a trap. Document-level keydown for the
   modal's lifetime with re-entry (`first.focus()`) when `activeElement` has
   escaped. TC-29's keyboard journey stays the regression check.
4. **MINOR — "single `''`-interpretation place" claim false on create paths.
   AGREE; fix required — and specifically the STRONGER option.** Export
   `emptyToNull` from `patch.ts` and use it at the four create call sites. I
   reject the comment-softening alternative: C1/T7's value is the discipline,
   not the comment — a future create-path edit needs the guard, not a footnote.
   This keeps the header claim true instead of retreating from it.
5. **NIT — duplicated not-`'summary'` predicate. AGREE; subsumed by fix 1**
   (the modal's inline copy is deleted when the invalidation hoists into the
   mutation layer).
6. **NIT — Modal × enabled-but-dead while pending. AGREE; UPGRADED to included.**
   The reviewer offered "accept as-is for MVP"; I include it because fix 3
   already has `Modal.tsx` open and the cost is a `closeDisabled` prop —
   marginal effort near zero for real disabled semantics (screen readers
   currently perceive a live button that does nothing).
7. **NIT — color preview applies arbitrary CSS pre-validation. AGREE; included.**
   Not exploitable (CSSOM, own input, server re-validates) but `url(…)` issuing
   a network fetch from a "color" field is exactly the kind of looseness that
   outlives MVPs. One-line guard: render the swatch only when
   `HEX_COLOR_PATTERN.test(colorPreview)`.
8. **NIT — duplicated kind-radio handler. AGREE; included** (file already open
   for fixes 1/4; extract `onKindChange`, behavior unchanged — reviewer verified
   no stale closure).
9. **NIT — comment inaccuracy + missing form-schema test. AGREE; both included,
   calibrated.** Fix the "(local midday)" comment word. On tests: the reviewer
   marked the `categoryFormSchema` empty-color refine arm optional; I REQUIRE it,
   for two reasons the reviewer under-weighted — (a) the plan's build order
   explicitly promised `schemas.test.ts` additions that never landed (an
   undeclared plan gap, caught here rather than at my diff gate — noted as my
   miss too), and (b) the `v === '' || HEX_PATTERN.test(v)` empty-allowed arm is
   genuinely breakable and mobile 1.8 inherits it. ONE contrast test (empty
   accepted / bad hex rejected / good hex accepted). No `transactionFormSchema`
   tests — the amount transform is `moneyAmountSchema` (already covered) and
   `note.max(500)` is a zod builtin; testing those would violate the
   no-vacuous-tests rule.

## Disagreements with the reviewer

None on substance; all nine findings are real and correctly graded (no
manufactured findings, no softened ones — the 0-MAJOR call is honest: nothing
found breaks a core flow or an obligation). Calibration deltas, all in the
stricter direction: finding 4 pinned to the stronger fix variant; finding 6
upgraded from discretionary to included; finding 9's optional test made
required with a vacuity boundary drawn around it.

## Ruling on the QA-reported picker deviation (PM item 3)

**ACCEPT the kind-SEGMENTED picker; recorded as amendment AM-1.6-c.** Root
cause is a checklist-vs-plan wording mismatch, not an engineer deviation: the
ACCEPTED plan never promised kind-filtering — it specified exactly what shipped
(non-archived options, picking a category sets tx kind by direct assignment,
manual kind flip clears an incompatible selection). TC-10's "only expense
categories are offered" was the checklist author's stronger reading. The
shipped behavior satisfies every binding constraint: T5 (safe-direction
assignment only), Q4 (flip clears incompatible), C3 (grouped segmentation), and
it forestalls a dead-end the filtered variant has (kind with zero categories →
empty picker). AM-1.6-c: the segmented-picker interaction (both kinds visible
in kind groups; pick sets kind; flip clears incompatible) is the sanctioned
pattern; mobile 1.8 should match it, and the mobile checklist should not
inherit TC-10's "filtered" wording.

## Fix round (frontend-engineer) — scope

Required: findings 1+5 (hoist 404 invalidation to mutation `onError`, delete
inline copy), 2 (regex), 3 (document-level keydown + re-entry), 4
(`emptyToNull` export + 4 call sites), 6 (`closeDisabled`), 7 (swatch guard),
8 (extract handler), 9 (comment word + one `categoryFormSchema` refine test).
Constraints unchanged: full gate re-run (typecheck/lint/vitest web+shared), A4
coordinator suite untouched and green, G1 `schema.d.ts` byte-identical, no
commits, deviations declared. Files touched are exclusively:
`data/transactions.ts`, `features/transactions/TransactionFormModal.tsx`,
`features/categories/CategoryFormModal.tsx`, `components/Modal.tsx`,
`components/ConfirmDialog.tsx`, `routes/TransactionsPage.tsx`, `lib/patch.ts`,
`packages/shared/src/dates.ts` (comment), `packages/shared/src/schemas.test.ts`.

## QA outcome noted for the final bundle

29 PASS / 0 FAIL / 2 BLOCKED + 1 PARTIAL — blocked/partial are tooling-only
(browser pane lacks request interception; TC-2's path additionally verified by
code read). All load-bearing journeys passed live: TC-31 predicate proof
(months A/B refetched, C untouched), TC-17 refund double-bucket without key
warnings, TC-13 archived-cat amount-only edit, TC-26 Cyrillic collation, TC-32
reserved-TLD field routing. QA's env note that `@test.local` itself was
rejected by the server validator is the A3 feature working as designed — the
switch to `@budgetqa.dev` seed emails was correct.
