# Implementation Plan (web): ai-layer — the AI flag, the reason and the AI status on the import preview

## Approach
Three additions to an existing screen, no new route, no new query root. The row grows one badge
plus one quiet line; the filter bar grows one INDEPENDENT toggle chip that goes into the rows key
as data (`{match_status, needs_review}`); the header grows one sentence built by a language-free
pure helper from `ai_status` + the two session counts. Nothing is computed from `ai_confidence`
and no money is touched.

The confidence NUMBER is deliberately not rendered. A percentage next to a shop name invites
false precision over a figure the user cannot act on; `needs_review` IS the server's decision
(threshold lives in settings, server-side) and the badge is that decision. `ai_confidence` stays
on the wire for QA/evals, unread by the UI.

Until backend S2 lands, the new fields are typed by a 6-line `TODO(S2)` shim intersected onto the
generated row/session types in `data/imports.ts` (no `as`, no hand-edited generated code); it is
DELETED at regen and the `packages/api-client` drift test is the gate that proves regen happened.

## Insertion points
- `apps/web/src/data/queryKeys.ts` — `importRows(importId, filters)` key object becomes
  `{ match_status, needs_review }`. Same root, same shape of entry; every bare
  `['imports', id, 'rows']` predicate (PATCH in-place write, bulk invalidate) keeps working.
- `apps/web/src/data/imports.ts` — `useImportRows(importId, filters: ImportRowFilters)` passes
  `needs_review` (null dropped by the serializer, like `match_status`). Plus the `TODO(S2)` shim:
  `StatementRowRead = Omit<generated, 'suggestion_source'> & { suggestion_source: … | 'llm' | null }
  & { ai_confidence: number | null; ai_reason: string | null; needs_review: boolean }` and
  `StatementImportRead = generated & { ai_status: …; ai_provider … ai_rows_flagged: number }`.
  `Omit` is needed because an intersection cannot WIDEN the `suggestion_source` union.
  Session invalidation on row PATCH: already there (`qk.importSession`) — CONFIRMED, the chip
  count and the header line refresh from the server after every category pick. No change.
- `apps/web/src/features/imports/aiStatusLine.ts` — NEW, pure, language-free. Input: a structural
  `{ ai_status, ai_rows_suggested, ai_rows_flagged }`. Output:
  `{ tone: 'quiet' | 'warning'; parts: ({ key: SimpleKey } | { key: PluralKey; count: number })[] }`
  — `parts` empty means render nothing. The component maps parts through `t()` and joins; the
  helper never holds a sentence (`period.unitLabelKey()` rule).
- `apps/web/src/features/imports/ImportRow.tsx` — `SUGGESTION_KEY` gains `llm: 'imports.suggestedByAi'`
  (the `satisfies Record<…>` keeps it exhaustive once the enum widens). When
  `suggestion_source === 'llm' && !category_user_set && ai_reason !== null` → one `.aiReason` line
  with the SERVER text verbatim (model's own sentence; the advisor-answer rule, not translated,
  not run through `translateBankText`). When `needs_review` → `<Badge tone="warning">` in the
  existing badge strip (the `badgeUntranslated` precedent: a badge, never a tooltip — it is the
  metric). An unsure row has no category, so it already shows `imports.categoryNone` + the badge,
  and `suggestionSource` stays null there — no extra branch.
  PROPS SHAPE UNCHANGED (all three fields ride on `row`), so the `memo` stays effective.
- `apps/web/src/features/imports/ImportFilterBar.tsx` — props `needsReview: boolean`,
  `flaggedCount: number`, `onToggleNeedsReview(next: boolean)`. A second chip group after the
  status chips, `aria-pressed`, label `imports.filterNeedsReview · N`. Hidden when
  `flaggedCount === 0 && !needsReview` (so turning it off on a now-clean statement is still
  possible). The bulk-decision block is HIDDEN while `needsReview` is on: the endpoint is keyed by
  `match_status` alone and would move rows the user cannot see — `countOf(matchStatus)` would be a
  lie. Hint `imports.needsReviewHint` under the chip when active (the `similarHint` precedent).
- `apps/web/src/features/imports/ImportRowList.tsx` — `needsReview: boolean` beside `filtered`;
  empty state picks `imports.rowsEmptyNeedsReview` ("nothing left to check…") over the generic
  `rowsEmptyFiltered`, so the empty state says what happened, not just "no data".
- `apps/web/src/routes/ImportPage.tsx` — `const [needsReview, setNeedsReview] = useState(false)`
  (screen state, not server state), passed to `useImportRows(importId, { matchStatus, needsReview })`
  and to both children; header renders `aiStatusLine(session)` as one `<p className={styles.aiStatus}>`
  under `.period` (`role="status"` only for the warning tone — `failed`/`partial` are news).
- CSS: `.aiReason` + `.badgeNeedsReview` in `ImportRowList.module.css`, `.aiStatus` (+ warning
  variant) in `ImportPage.module.css`, `.chipFlagged` in `ImportFilterBar.module.css`. Tokens
  only, no hex/px literals.
- `apps/web/src/i18n/dict.en.ts` (key set) + `dict.ru.ts` (mapped type) — keys below.
- `docs/web.md` — the "Statement import" bullet (AI flag/reason/status, the AND semantics, the
  bulk-hidden rule) and the `['imports', …]` key-family line (`rows` now carries
  `{match_status, needs_review}`), in the same pass.

## i18n keys (EN is the key set; RU intent in parentheses)
- `imports.suggestedByAi` — "suggested by AI" (подсказка ИИ) — the existing quiet source line.
- `imports.badgeNeedsReview` — "Check category" (Проверьте категорию) — warning badge.
- `imports.filterNeedsReview` — "Check category" (На проверку) — chip label, count appended by
  the bar's existing `· {n}` rendering.
- `imports.needsReviewHint` — "AI was not sure about these lines. Pick a category, or leave them
  as they are — nothing is blocked." (ИИ не был уверен в этих строках…).
- `imports.rowsEmptyNeedsReview` — "Nothing left to check — every AI suggestion has been looked
  at." (Проверять нечего…).
- `imports.aiOff` — "AI categorisation is off on this server." (ИИ-категоризация на этом сервере
  выключена.) — quiet tone, NOT an error.
- `imports.aiSkipped` — "Nothing for AI to do here: the rules covered every line." (ИИ здесь
  нечего было делать…).
- `imports.aiSuggested` (plural on `count`) — "AI suggested a category for {count} line(s)"
  (ИИ подсказал категорию для {count} строк/и/ок — 4 RU forms).
- `imports.aiFlagged` (plural on `count`) — "{count} to check" ({count} на проверку — 4 RU forms);
  omitted by the helper when the count is 0.
- `imports.aiPartial` — "Some lines were not processed." (Часть строк не обработана.).
- `imports.aiFailed` — "AI categorisation failed; these lines were left without a category."
  (ИИ-категоризация не сработала…).
No key for the reason text itself: it is the model's sentence, shown verbatim.

## How the chips combine — AND
`match_status` stays single-select (null/similar/new/exact); `needs_review` is a separate boolean
toggle. Both are members of ONE key object and both go on the request, so the server ANDs them:
"new AND needs a look" is a legitimate, reachable, cacheable view. Each combination is its own
cache entry (the existing `match_status` behaviour, unchanged). `ai_rows_flagged` is the chip's
count and is NEVER intersected client-side with `by_match_status` — the unfiltered flagged total
is the honest "how many still need a look"; the list shows the intersection.

## Risky spots
- The chip + in-place PATCH write: under `needs_review=true`, picking a category clears the flag
  server-side, but the PATCH response is written IN PLACE and the rows query is not invalidated —
  so the row STAYS in the list, badge gone, until the filter is re-entered. Deliberate (a row
  vanishing under the cursor is worse, and `qk.importSession` invalidation keeps the chip count
  truthful). Must be in docs/web.md and in the QA checklist, or QA will file it.
- `suggestion_source` widening: pre-S2 the `Omit`-based shim is what keeps `satisfies Record<…>`
  exhaustive; forget the `Omit` and the `llm` entry is an excess-property error. Shim deletion at
  regen is a gate, not a cleanup wish.
- `readOnly` sessions (applied/cancelled) must still render the AI line and the flag — they are
  the record of what happened; only the bulk/chip actions are gated.

## Tests
1 new file, `aiStatusLine.test.ts`, 8 cases (pure, node vitest): the five statuses; `ok` with
`ai_rows_flagged === 0` (no "to check" part); `partial` carrying counts AND the note; the
plural-count payload shape for RU (`count` is passed, not pre-formatted). No test for the key
builder — it would re-assert the literal it builds.

## Estimate (agent-minutes)
Write 50 · gates 10 (`pnpm --filter @budget/web lint typecheck test`) · verification 10 (shim
removal + api-client drift test after S2 regen, visual pass on the five `ai_status` arms via a
`fake` provider stand). Total ≈70.

## Open question — RESOLVED by senior-lead (grooming)
`imports.aiSkipped`: render it (one quiet line; a server with AI that said nothing should say why).
Tests: keep the pure helper's cases to the arms that differ in SHAPE (≤6) — five-statuses-plus-
variants re-asserts the same structure. The in-place PATCH under the `needs_review` filter (row
stays, badge gone) and the hidden bulk block are accepted and go into the QA checklist as expected
behaviour, not defects.
