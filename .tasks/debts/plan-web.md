# Implementation Plan (web): debts — кому должен я и кто должен мне

## Approach

The screen is the /deposits screen's shape, not /accounts': a debt is an object
with its own figures and four things you can do to it, so the row is an
`<article>` with a heading and its own actions, and the whole page is one
archived-inclusive cache entry (`GET /debts` has no `?status=`) that the view
splits into three groups. Every number on screen is a SERVER field
(`principal_minor`, `repaid_minor`, `remaining_minor`, the two summary figures) —
the client neither sums nor converts, which is why the summary ships as fields on
the list response and why the two unconverted counters are rendered as honest
notes beside the figures they are missing from (the `SummaryHeader` /
`UnconvertedNotice` pattern).

The cross-currency case follows the TRANSFER precedent exactly, as amended by
senior-lead: two amounts, the second one the user's own figure, `/fx/convert`
only as a PREFILL into an untouched field. The mirror-receipt rule
(`packages/shared/src/amountMirror.ts`) does NOT fit here — the two amounts are
in different currencies by construction whenever the second field exists at all,
so `mirrorDecision` would only ever clear it. A documented prefill-once ref
(the `TransactionFormModal` charge-preview rule: write only while the field is
untouched, never in edit mode) is used instead.

Contract timing: `schema.d.ts` has no `/debts` at the time of writing. The data
layer is therefore typed against a LOCAL transcription of architecture.md's read
models (`features/debts/types.ts`) behind exactly ONE documented cast of
`apiClient` in `data/debts.ts`; everything above the data layer is typed against
that mirror and will not change when the generated client lands (the swap is
mechanical: delete the mirror, re-point five type aliases at
`components['schemas']`). The two places where a DEBT field lands on an EXISTING
contract type (`TransactionRead.debt_id`, the replace preview's
`debt_movements_kept`) need no cast at all: they are read through accessors whose
parameter declares the field OPTIONAL, which typechecks both before and after
B1 regenerates the contract.

## Screens / components affected

- `apps/web/src/App.tsx` — `/debts` route.
- `apps/web/src/routes/ProtectedLayout.tsx` — nav item in the Money group, after
  `/deposits` (senior-lead amendment 3).
- `apps/web/src/routes/NavIcon.tsx` — `debts` icon (one path, same stroke set).
- `apps/web/src/routes/TransactionsPage.tsx` — reads `['debts','list']` for two
  jobs: the deadline-widget rows and the row badge's name index; routes a
  `debt_id` row to `/debts` instead of the tx form.
- `apps/web/src/features/transactions/TransactionRow.tsx` — the debt arm: badge
  instead of the category line, row shell becomes a `<Link to="/debts">`.
- `apps/web/src/features/transactions/TransactionList.tsx` — passes `debtIndex`
  through (the `recurringIndex` precedent).
- `apps/web/src/features/goals/plan/GoalDeadlines.tsx` — third row kind.
- `apps/web/src/features/imports/ReplaceFlow.tsx` — `debt_movements_kept` figure.
- `apps/web/src/lib/errors.ts` — `describeDebtError` (seven new codes).
- `apps/web/src/data/queryKeys.ts`, `apps/web/src/data/transactions.ts` —
  `qk.debtsList()` / `qk.debt(id)`; `invalidateAccounts` exported.
- `apps/web/src/i18n/dict.en.ts` / `dict.ru.ts` — the new key set; the deadline
  widget's title/empty copy now names debts too.

## New components / hooks

- `routes/DebtsPage.tsx` (+ `.module.css`) — summary header, two open groups, a
  `<details>` "Closed" section, modal switchboard (ONE modal at a time: a
  ConfirmDialog or a form inside an open Modal would be two focus traps).
- `features/debts/DebtSummaryHeader.tsx` — two base-currency figures + the two
  unconverted notes; own loading arm.
- `features/debts/DebtList.tsx`, `DebtRow.tsx` (+ `DebtList.module.css`).
- `features/debts/DebtFormModal.tsx` — create/edit.
- `features/debts/RepaymentModal.tsx` — record AND correct one repayment.
- `features/debts/DebtHistoryModal.tsx` — the embedded `repayments` from
  `GET /debts/{id}`, each row with edit/delete.
- `features/debts/types.ts` — the temporary contract mirror (see Approach).
- `features/debts/debtGroups.ts` (**tested**) — `groupDebts` + `debtRowState`.
- `features/debts/debtDeadlines.ts` (**tested**) — the `depositDeadlines` twin.
- `features/debts/debtPatch.ts` (**tested**) — the PATCH diff.
- `features/debts/debtFormSchema.ts` — BOTH web-local zod factories (debt and
  repayment) over `t`, in one file: they mirror the same two currency rules on
  the same two fields and share the money reader, and two copies of that rule is
  how one of them would drift (the `depositFormSchema` ruling applies to both:
  no mobile consumer, so not in `@budget/shared`).
- `features/debts/debtMovement.ts` — `debtIdOf` / `debtBadgeName` /
  `debtMovementsKept`: the optional-field accessors described above.
- `data/debts.ts` — the whole data layer.

## Data layer

Endpoints (architecture.md §Endpoints): `GET /debts` → `DebtList
{items, summary}`; `POST /debts`; `GET /debts/{id}` → `DebtDetailRead` (the
embedded `repayments`); `PATCH /debts/{id}`; `DELETE /debts/{id}` (204);
`POST /debts/{id}/repayments`; `PATCH|DELETE /debts/{id}/repayments/{rid}`.
No `/debts/upcoming` and no `?debt_id=` tx filter — both deliberate.

Keys — a NEW disjoint root:
- `['debts','list']` (`qk.debtsList()`, staleTime 60s) — ONE entry feeding the
  /debts screen, the /transactions deadline widget and the tx-row badge's name
  index. `key[1] = 'list'` is the usual disambiguation so the detail sub-family
  cannot collide.
- `['debts', debtId]` (`qk.debt(id)`) — the history modal's detail read.

Invalidation after EVERY debt/repayment write: bare `['debts']` (remaining,
status, closed_on and the summary are all server-derived), bare `['accounts']`
(a movement moved a balance — `invalidateAccounts`, exported from
data/transactions.ts so the key grammar keeps one home) and the tx LISTS
(`invalidateTxLists` — a movement IS a transaction row). A 404 invalidates the
same set (the row is gone elsewhere; the T6/T9 precedent).

Deliberately NOT invalidated, and why: `['transactions','summary']`, `['stats']`,
`['limits']` — debt movements are excluded server-side at the single `tx_totals`
point, so no aggregate moved; `['deposits']` — a debt movement cannot land on a
deposit ledger (`DEPOSIT_ACCOUNT_TRANSFER_ONLY`); `['goals']` — a debt row
carries no `goal_item_id` by CHECK. In the other direction, tx mutations do NOT
invalidate `['debts']`: `/transactions` refuses PATCH/DELETE on a debt row
(422 `DEBT_MOVEMENT_READONLY`) and `TransactionCreate` carries no debt field, so
no tx write can move a debt figure. Both directions are facts about the
contract, not opinions held here.

No optimistic updates and no `setQueryData` patching: every write answers the
whole `DebtDetailRead`, and the LIST entry also carries the cross-currency
`summary`, which the client must not recompute.

## UI states

**/debts** — loading: three fixed-height skeleton rows + a skeleton summary card
(no jump). unreachable/error: `QueryStateNotice` with Retry (the summary card is
not rendered at all — a figure we do not have must not be drawn as 0). empty (no
debts at all): `EmptyState` saying what a debt IS good for here plus the Add
button. ready-but-nothing-open (only closed debts): a muted line "ничего
открытого" above the Closed section, which is itself a collapsed `<details>` so
history never pushes the live rows off screen. Per figure: `summary` renders two
labelled numbers; each side's `*_unconverted_count > 0` adds a `role="status"`
note naming the count — never a silent sum.

**DebtFormModal** — submit pending: Save `loading`, close disabled, dirty-guard
on all three close channels (shared Modal). Account list loading/failed/empty:
all four arms inside `AccountField`, and Save is blocked by
`accountFieldBlocked` while the list is unusable (an account id cannot be
guessed). Cross-currency: the second amount appears the moment the two
currencies differ, with the `/fx/convert` prefill as a hint line and its
no-rate arm saying so in words (a missing rate is a degraded state, not an
error — the user types the figure). Field errors from the server land on the
control that can fix them; the immutable pair (direction, currency) is read-only
TEXT on edit, never a disabled control.

**RepaymentModal** — the same arms; `DEBT_REPAYMENT_EXCEEDS_REMAINING` renders
as an error ON the amount field, with the remaining formatted at the debt
currency inside the sentence (the one refusal a user will actually hit).

**DebtHistoryModal** — loading: placeholder rows; error: notice + Retry; empty:
"возвратов пока нет" plus the Record-repayment affordance; each row: date,
amount in the debt currency, the account figure when it differs, note, Edit and
Delete. Deleting goes through a destructive ConfirmDialog that says the movement
goes and the account balance reverts.

**Delete a debt** — destructive ConfirmDialog naming the counterparty and saying
out loud that the movements are deleted and the balances revert (architecture:
real DELETE + cascade).

**/transactions** — the widget keeps its existing four arms and its `narrowed`
gate; a debt row in the list is a Link, so it is still focusable and still
announces itself, it simply cannot open a form the server would 422.

## Open questions

None blocking. Two things I decided rather than asked, both recorded above:
(1) the mirror rule does not apply to the second amount (different currencies by
construction) — a prefill-once ref is used; (2) the deadline widget's title and
empty copy now name debts, since the widget is the one place all three families
are merged.

## Risks

- **The contract lands differently.** One cast + one mirror file is the whole
  blast radius; field-name drift surfaces as a typecheck failure in
  `features/debts/types.ts` and nowhere else.
- **Currency defaulting.** The debt currency follows the picked account only
  while the user has not chosen one themselves (ref receipt). Getting this wrong
  silently changes what currency a debt is denominated in — it is commented in
  place and deliberately not a `useEffect` over `dirtyFields` (the shipped
  transfer-form defect).
- **PATCH of a cross-currency movement.** `account_amount_minor` must be sent
  whenever the account changed to one in another currency, even if the number
  itself did not change — the one non-obvious rule in `debtPatch.ts`, and the
  reason that module is tested.
- **Overdue styling.** Coloured by MEANING (a date in the past on an open debt),
  never by the sign of a number, and always with a text badge beside it.
- **Tests**: 3 files, 19 cases — `debtDeadlines` (inclusive window, open-only,
  order, figures carried verbatim), `debtPatch` (omit/null/value, never
  direction/currency, and the three account-amount cases), `debtGroups` (split,
  both orders, overdue vs settled row state). No DOM tests.

## Post-B1 amendment (senior-lead, fix round)
The §Approach/§Risks paragraphs about the contract mirror (`features/debts/types.ts`)
and the single `apiClient` cast are HISTORICAL: once B1 regenerated the contract the
mirror was deleted and `data/debts.ts` types everything from `components['schemas']`.
Also fixed in the same round: `debtPatch.ts` emitted `account_amount_minor: null` on a
move onto a same-currency account — the server refuses an explicit null
(`DEBT_ACCOUNT_AMOUNT_REQUIRED`) and copies the amount itself; the key is now OMITTED.
