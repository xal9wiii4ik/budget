# Implementation Plan (web): pdf-reconcile — PDF bank in the picker, the statement's own arithmetic, the balance line, the reconcile agent

## Approach

Four additions to ONE existing screen plus the upload modal. No new route, no new query root: the
reconciliation report is `['imports', importId, 'reconciliation']` — inside the session family, so
the cancel-time `removeQueries(['imports', id])` drops it and the apply/replace bare invalidation
refreshes it, with no new predicate to audit. Nothing here computes money: every figure
(`self_check_expected_minor`, `self_check_actual_minor`, `opening/closing_balance_minor`,
`app_balance_minor_at_end`, `balance_diff_minor`) is a server integer rendered by `formatMoney` at
`statement_currency`; the only derivation is a SIGN SPLIT of the single server integer
`balance_diff_minor` (`Math.abs` + a direction key) so the sentence can say "higher"/"lower"
instead of printing "−12.50" mid-copy. The client subtracts nothing, sums nothing, and asks the
server for no diff field it does not already send.

Three pure, language-free modules carry the decisions (the `aiStatusLine` precedent): which
sentence is true of a self-check, which of a balance check, and how the agent's items group. They
return dict KEYS + the minor integers to format; the components do the `t()` and the `formatMoney`.
That is where the tests go — the components stay thin.

**Sequencing is load-bearing.** Part A (bank picker, `accept`, AI hint, the new error copy, the
self-check block, the apply/replace gate, the balance line) touches only FIELDS of an existing
schema, so it can be written against a `TODO(S2)` type shim intersected onto the generated
`StatementImportRead` in `data/imports.ts` (the ai-layer precedent) and lands before regen.
Part B (the reconcile button and the report view) touches two NEW PATHS — and a path that is not
in the generated `paths` cannot be shimmed at all without hand-rolling a `fetch`, which the house
rules forbid. **Part B is blocked on the S2/S6 contract regen** and must be implemented after it.
No mock, no cast, no second HTTP client.

## Screens / components affected

- `apps/web/src/features/imports/ImportUploadModal.tsx` — `accept` gains `.pdf,application/pdf`;
  one hint line under the Bank select when the picked format is an AI one; the file label copy says
  CSV / Excel / PDF.
- `apps/web/src/features/imports/statementFormatLabel.ts` — `alfa_pdf_v1 → imports.formatAlfaPdfV1`
  in `LABEL_KEYS`; NEW `isAiFormat(format): boolean` over a frozen `AI_FORMATS = ['alfa_pdf_v1']`
  (decision + rationale below). Pure, same module, same test file.
- `apps/web/src/routes/ImportPage.tsx` — three new blocks between the counters and the filter bar
  (self-check, balance check, reconciliation), one new header action (Compare with the app), the
  apply/replace footer gated on a failed self-check.
- `apps/web/src/features/imports/ImportUploadModal.module.css`, `routes/ImportPage.module.css` —
  the new banner/line/section classes. Tokens only; no hex, no px font sizes.
- `apps/web/src/lib/errors.ts` — `describeImportError(error, lang, t)` gains a third parameter
  (`describeDebtError` precedent) and seven codes. The new copy lives in the WEB dict, NOT in
  `@budget/shared` ERROR_MESSAGES — mobile is frozen and would only gain dead entries. 8 call
  sites in 3 files already hold `t`.
- `apps/web/src/data/imports.ts` — the `TODO(S2)` field shim; `useReconciliation`,
  `useRunReconciliation` (part B).
- `apps/web/src/data/queryKeys.ts` — `importReconciliation(importId)`.
- `apps/web/src/i18n/dict.en.ts` (key set) + `dict.ru.ts` (mapped type).
- `docs/web.md` — the "Statement import" bullet and the `['imports', …]` key-family line, in the
  same pass.

## New components / hooks / pure modules

- `features/imports/selfCheckLine.ts` (pure) — in: `{self_check_status, self_check_failed,
  self_check_expected_minor, self_check_actual_minor}`; out:
  `{tone: 'none'|'ok'|'warning', key: SimpleKey|null, figures: {expected: number, actual: number}|null}`.
  `not_available` → `tone: 'none'` (Priorbank, Credo pre-S2 sessions: render NOTHING, not a green
  tick about a check that never ran). `passed` → `ok`. `failed` → `warning` + the key of the
  FAILED check (`balance|income_total|expense_total|date_range`), figures only when both integers
  are non-null — `date_range` carries nulls by design and gets a figure-free sentence.
- `features/imports/balanceCheckLine.ts` (pure) — in: `{status, balance_check,
  app_balance_minor_at_end, balance_diff_minor, closing_balance_minor}`; out
  `{tone: 'none'|'ok'|'warning'|'quiet', key, appBalance, closing, diffAbs}`. Session `status ===
  'parsed'` → `none` (the check runs AT apply; a "not available" line before apply would describe
  a ledger nothing has touched yet). applied/replaced + `not_available` → `quiet` +
  `imports.balanceNoClosing`. `match` → `ok` with the closing figure. `mismatch` → `warning` +
  `imports.balanceAppHigher` / `imports.balanceAppLower` picked from the SIGN of
  `balance_diff_minor` (server field = app − closing), magnitude `Math.abs(...)`, and BOTH figures
  carried so the user can audit against the statement.
- `features/imports/reconciliationGroups.ts` (pure) — items → ordered groups
  `[{kind, items}]` in a fixed kind order (`missing_in_app, extra_in_app, amount_differs,
  date_differs, fx_difference`), empty groups dropped, an UNKNOWN kind from a newer server kept in
  a tail group rendered with its raw string (the `statementFormatLabel` rule: never hide what the
  server said). Counts come from the server `counts`, never recounted from the items.
- `features/imports/ImportSelfCheck.tsx` — the ✓ line / the warning banner + the opening→closing
  pair (shown whenever both anchors are present, failed or not: they are what the user compares).
- `features/imports/ImportBalanceCheck.tsx` — the one-line arm from `balanceCheckLine`.
- `features/imports/ImportReconciliation.tsx` (part B) — the section: an EXHAUSTIVE switch over a
  discriminated UI state (below), the counts strip, the model's `summary` verbatim, the groups.
- `features/imports/ReconciliationItem.tsx` (part B) — one item: the kind's explanation key, the
  embedded statement-row mini-view and/or the app-transaction mini-view, and the model's
  `explanation` VERBATIM on its own quiet line (the advisor-answer rule — never translated, never
  run through `bankPhrases`).

## Data layer

**Reads.** `GET /statement-imports/{id}` (existing key `['imports', id, 'session']`) carries all
the self-check / balance / reconciliation-status fields, so the three new blocks are F5-proof and
need no new request. `GET /{id}/reconciliation` → NEW key `['imports', id, 'reconciliation']`,
`enabled: session?.reconciliation_status === 'ok'` — D-R5 makes a never-reconciled session answer
200 with `status:'none'`, and firing a request that can only return an empty shell is a request for
nothing; the headline (counts + summary, A4) is on the session read. `staleTime` 5 min: a stored
report changes only through this client's own POST.

**Write.** `POST /{id}/reconcile` → `onSuccess`: `setQueryData(qk.importReconciliation(id), report)`
(the POST answers the same full read, D-R5 — so the section renders with no second round trip) +
`invalidateQueries(qk.importSession(id))` (status, `reconciled_at`, counts and summary moved).
Deliberately NOT `invalidateAfterBulkTxWrite`: the agent writes no money. On error: invalidate the
session only (the server stamped `failed` + the provider trio, and the screen must show that).
`onError` for 409 also invalidates the session — the `running` status is what the user needs to see.

No optimistic update anywhere in this scope. No polling: a `running` status is rendered as an arm
with a Refresh button that invalidates the session (the receipts-poll machinery would be a second
lifecycle for a one-shot action the server already claims).

Apply/replace invalidation is UNCHANGED — the existing bare `['imports', id]` already refreshes the
session, which is what makes the balance line appear right after an apply.

## UI states

**Upload modal.** Unchanged loading/error/empty arms for the formats query. New: the AI hint line
under the Bank select (`imports.uploadFormatAiHint`) when `isAiFormat(format)`. New failures, all
in the modal's existing single `role="alert"` slot: 503 `AI_NOT_CONFIGURED` →
"this bank's statement is read by AI, and this server has no AI provider configured — a CSV/Excel
bank still works"; 503 `AI_UNAVAILABLE` → "the AI service did not answer; the file is fine, try
again in a minute" (explicitly NOT "bad file"); 422 `STATEMENT_EXTRACTION_FAILED` → "the AI could
not read this statement end to end; nothing was imported" + the hint to send the PDF as-is (a
re-upload is the only user action). `RATE_LIMITED` keeps its existing copy (now also the line
quota). `STATEMENT_TOO_LARGE` keeps its copy (now also the line cap).

**Self-check block** (header area, under the AI status line). `not_available` → nothing. `passed`
→ one quiet ✓ line, `role` absent (a standing fact). `failed` → a warning banner, `role="status"`,
naming WHICH check failed and both figures ("the statement's closing balance says X; the lines add
up to Y"); the apply AND replace buttons are `disabled` with the SAME reason rendered as text next
to them (`imports.applyBlockedSelfCheck`) — never a tooltip, never a disabled button with no
explanation. Cancel stays enabled. 422 `STATEMENT_BALANCE_MISMATCH` copy is the fallback for the
stale-screen/second-tab path.

**Balance line** (under the counters, directly above the apply/replace report). Four arms per
`balanceCheckLine`; `parsed` renders nothing at all. After an apply the session invalidation makes
the line appear beside the fresh `ImportReport` — ONE component serves both "the result" and "the
record", because the figures are stored on the session and a second copy inside the report block
would be the same sentence twice.

**Reconciliation section.** Discriminated UI state derived during render from
`session.reconciliation_status` + the mutation: `off` (the button is disabled + copy, see the
decision below) · `idle` (button + one lede line saying what the agent does) · `running` (the
mutation is pending OR the stored status is `running` — pending label, and in the stored case a
Refresh button + "already running" copy) · `failed` (the server stamped `failed`: the arm says so
and offers Retry) · `ok`. In `ok`: the counts strip (five server integers, zero kinds omitted), the
model's `summary`, then the groups. Empty report (`ok` with zero items) is a real and GOOD outcome
— `imports.reconcileClean` ("the agent found no discrepancies"), not an empty list. The items GET
has its own loading (skeleton lines, stable height) / error (`QueryStateNotice` + retry) arms.
Errors: 409 `RECONCILIATION_RUNNING` → "already running — refresh"; 422 `RECONCILIATION_TOO_LARGE`
→ "too many lines to compare at once"; 422 `RECONCILIATION_FAILED` → "the agent did not finish";
503 ×2 → the AI copy family above.

Read-only (applied/replaced) sessions render ALL of it: the self-check, the balance line and the
report are the record of what happened — only apply/replace/bulk stay gated, as in ai-layer.

## Decisions the brief asked for

1. **How the client knows a format is AI-read: a frozen client-side set** (`AI_FORMATS` in
   `statementFormatLabel.ts`), NOT a server flag. `GET /formats` is a plain string list and
   `EXTRACTORS` membership is the server's own truth; publishing it would be a contract change to a
   schema nothing else needs. The failure mode of the client set is a MISSING hint on a newer
   server (graceful: the upload still works and the 503 copy still fires), never a wrong one — the
   same trade-off `statementFormatLabel` already makes for the names. The hint is worded as a fact
   about the FORMAT ("this bank's statement is read by AI — it needs an AI provider on the
   server"), so it is true without the client knowing whether a provider exists; the authoritative
   answer is the 503 at upload.
2. **Self-check difference: show BOTH numbers, ask for no `self_check_diff_minor`.** Expected and
   actual are the two figures the user can literally find — one in the PDF's balance line, one in
   the preview — and a lone diff hides which side is bigger in a way nothing on screen can audit.
   No subtraction happens client-side either way. No backend ask.
3. **Reconcile availability: `session.ai_status === 'not_configured'` → the button is rendered
   DISABLED with the copy** (`imports.reconcileAiOff`). A3 makes the categorize pass run on every
   upload, so `ai_status` is an honest per-session record of whether the server had a provider.
   Known limitation (goes to the QA checklist, not a defect): a provider configured AFTER the
   upload leaves the button disabled on that stored session, because `ai_status` is stored. The
   optional one-field fix is an ask below.
4. **Item → row/transaction resolution: the report must EMBED a mini view per item.** Required ask
   below. Client-side resolution is not available: the rows cache is paged AND filtered by two
   chips, so a `row_id` may live on a page that was never fetched, and a `transaction_id` is in no
   cache this screen holds. A `GET /rows?ids=` endpoint would be an N+1 of its own.
5. **`transaction_id` link: the existing account+period transactions href**, not a per-transaction
   deep link. There is no single-transaction route and inventing one for this is out of scope; the
   embedded mini view (date, merchant/note, amount) is what lets the user find the row there.

## Asks to backend

1. **REQUIRED — embed a mini view per discrepancy item.** `StatementDiscrepancy` carries only ids
   (§7). Add, nullable per kind: `row: {id, txn_date, description, merchant, amount_minor,
   currency, kind} | null` and `transaction: {id, occurred_at, merchant, note, amount_minor,
   currency, kind} | null`. Without this the report cannot render a single readable line — see
   decision 4. (If the shape must be reused, `StatementRowRead` / a trimmed tx read are both fine;
   the web reads only those fields.)
2. **REQUIRED — `reconciliation_summary: string | null` on `StatementImportRead`.** A4 promises it,
   §7's field list omits it. The section's headline ("ok" arm) is built from `counts` + `summary`
   on the session read; without it the second GET becomes mandatory just to print one paragraph.
3. **CONFIRM — `POST /{id}/reconcile` answers the full `StatementReconciliationRead`** (D-R5 says
   so). The web seeds `['imports', id, 'reconciliation']` from the POST body; if the POST answers
   something smaller, that seed goes away and the section needs a follow-up GET.
4. **CONFIRM — a never-reconciled session answers `GET /{id}/reconciliation` 200 with
   `status:'none'`, items `[]`** (D-R5), and `GET /{id}` keeps `reconciliation_status` and
   `reconciled_at`. The web's `enabled` gate and the `running`/`failed` arms are built on those
   three fields.
5. **STATE THE LANGUAGE CONTRACT for `explanation` and `summary`.** The advisor prompt is
   Russian-only and its answers are rendered verbatim; if `reconcile-v1` does the same, an EN-UI
   user gets Russian sentences. The web will NOT translate them (the advisor rule). Say in the
   backend plan which language the prompt fixes; a `language` hint on the POST is out of scope for
   v1 unless the backend wants it.
6. **OPTIONAL (one field) — `ai_available: boolean` on `StatementImportRead`**, computed live from
   `app.state.llm is not None`. It removes the stale-`ai_status` limitation in decision 3. Not a
   blocker; the web ships the `ai_status` gate either way.
7. **SEQUENCING — the reconcile paths must be in `openapi.json` + `schema.d.ts` before the web's
   part B.** Field additions can be shimmed; a new PATH cannot.

## i18n keys (EN is the key set; RU intent in brackets)

Upload: `imports.formatAlfaPdfV1` "Alfa-Bank — PDF statement" [Альфа-Банк — выписка PDF] ·
`imports.uploadFormatAiHint` [эту выписку читает ИИ; нужен настроенный ИИ-провайдер] ·
`imports.uploadFile` COPY CHANGE (CSV, Excel or PDF).
Errors: `imports.error.aiNotConfigured`, `imports.error.aiUnavailable`,
`imports.error.extractionFailed`, `imports.error.balanceMismatch`,
`imports.error.reconcileRunning`, `imports.error.reconcileFailed`,
`imports.error.reconcileTooLarge`.
Self-check: `imports.selfCheckPassed` · `imports.selfCheckBalance` ·
`imports.selfCheckIncomeTotal` · `imports.selfCheckExpenseTotal` (three take `{expected, actual}`
as already-formatted strings) · `imports.selfCheckDateRange` (no figures) ·
`imports.selfCheckAnchors` `{opening, closing}` · `imports.applyBlockedSelfCheck`.
Balance: `imports.balanceMatches` `{closing}` · `imports.balanceAppHigher` /
`imports.balanceAppLower` `{amount, app, closing}` · `imports.balanceNoClosing`.
Reconcile: `imports.reconcileRun` · `imports.reconcileLede` · `imports.reconcilePending` ·
`imports.reconcileAiOff` · `imports.reconcileRunningStored` · `imports.reconcileRefresh` ·
`imports.reconcileFailedArm` · `imports.reconcileRetry` · `imports.reconcileClean` ·
`imports.reconcileSummaryLabel` · `imports.reconcileAt` `{when}` ·
`imports.reconcileSettled` (plural) · `imports.reconcileUnmentioned` (plural, shown only > 0) ·
five kind titles `imports.kindMissingInApp|ExtraInApp|AmountDiffers|DateDiffers|FxDifference` and
five one-line explanations `imports.kindMissingInAppHint|…` · `imports.reconcileRowLabel` /
`imports.reconcileTxLabel` · `imports.reconcileOpenTx`.
≈35 keys × 2 dictionaries; ru plurals in 4 forms where marked.

## Risky spots

- **`balance_check === 'not_available'` is ambiguous on the wire** — it means both "not computed
  yet" (parsed) and "the statement has no closing balance". Disambiguated ONLY by session
  `status`; get that backwards and a parsed preview grows a line about a ledger nothing touched.
  Pinned by `balanceCheckLine.test.ts`.
- **The sign of `balance_diff_minor`.** `app − closing`: positive = the APP is higher. Flipping it
  inverts a sentence about the user's money. One test per direction, and the copy names both
  figures so the mistake would be visible on screen.
- **The 60-second POST.** A navigation away loses the mutation, and the claim answers 409 to a
  re-click. The `running` arm must be derived from the SESSION field, not from mutation state only,
  or a returning user sees an idle button for a loop that is still burning tokens.
- **Part B's typing.** A new path cannot be shimmed. If part B is attempted pre-regen the only
  routes are a hand-rolled fetch or an `as` cast on the client — both forbidden. STOP and report
  instead.
- **Shim deletion is a gate, not a cleanup wish** (ai-layer precedent): the `packages/api-client`
  drift test is what proves regen happened; the `TODO(S2)` block goes out in the same pass.
- **`describeImportError` signature change** touches 8 call sites; a missed one is a typecheck
  error, not a silent bug — low risk, listed so the diff size is not a surprise.
- **`explanation` / `summary` are model text.** Verbatim, React-escaped, never through
  `bankPhrases`, never translated, no `dangerouslySetInnerHTML`. Long paragraphs need
  `overflow-wrap: anywhere` like `.subtitle`.
- **Statement currency, not account currency**, for every self-check figure; the balance figures
  are the ACCOUNT's ledger — and the upload already refuses a currency mismatch, so the two agree
  by construction. Still: pass `session.statement_currency` explicitly at every `formatMoney` call,
  with `{ locale }`.

## Tests

Three new node-only test files plus two cases on an existing one; ~17 cases, all on pure modules —
no component tests (the components are a `switch` over a tested helper plus `t()`/`formatMoney`,
and a test there would re-assert the dictionary).

1. `selfCheckLine.test.ts` — 6: `not_available` → `tone:'none'` (nothing rendered, not a tick);
   `passed`; each of `balance` / `income_total` / `expense_total` carrying both figures; and
   `date_range` with null integers → the figure-free arm (the one branch that differs in SHAPE).
2. `balanceCheckLine.test.ts` — 5: `parsed` + `not_available` → nothing; applied +
   `not_available` → the no-closing line; `match`; `mismatch` with a POSITIVE diff → app-higher key
   + absolute magnitude; `mismatch` with a NEGATIVE diff → app-lower key + the same magnitude (the
   two contrast, which is the point).
3. `reconciliationGroups.test.ts` — 4: the fixed kind order is honoured regardless of item order;
   empty kinds are dropped; item order WITHIN a kind is preserved; an unknown kind from a newer
   server lands in the tail group instead of vanishing.
4. `statementFormatLabel.test.ts` — +2: `alfa_pdf_v1` → `{kind:'known'}`; `isAiFormat` true for
   `alfa_pdf_v1`, false for `priorbank_csv_v1` and for an unknown id.

## Estimate (agent-minutes)

Part A: write 55 · Part B: write 65 · gates 15 (`pnpm --filter @budget/web lint typecheck test`) ·
verification 20 (shim removal + api-client drift test after regen; a visual pass over the arms on a
`LLM_PROVIDER=fake` stand — passed/failed self-check, the three balance arms, and the fake's
all-missing/all-extra report). **Total ≈155**, of which ≈85 cannot start before the S2/S6 contract
regen.
