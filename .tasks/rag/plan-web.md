# Implementation Plan (web): rag — "by meaning" search on /transactions, cited Q&A on /advisor

## Approach
Two surfaces, one new contract family, zero new money math. On /transactions a MODE toggle beside the existing search
field flips `?mode=meaning`; in that mode the screen reads `GET /transactions/search` instead of `GET /transactions`,
renders the hits through the SAME `TransactionRow` (one opinion about which amount leads) with a quiet score badge, and
replaces `SummaryHeader` with the SERVER `total`. On /advisor a second `<section>` under the shipped streaming chat
holds a one-shot Q&A form: question → answer verbatim → citations as links to the operation → the server `total`; the
chat stays byte-identical. The URL remains the single source of truth on /transactions (`parseTxFilters` grows `mode`),
so a semantic search is shareable, F5-proof and undone by the back button like every other filter; the Q&A holds NO
transcript — `useMutation.data` IS the last answer, derived during render (D-Q2 gives v1 no history).

**Sequencing (A1/A5/A6).** Everything except the two request functions is written against ONE shim file
`data/ragContract.ts` with hand-declared `TODO(S2)` types mirroring §6/§7 (the embedded row is the GENERATED
`components['schemas']['TransactionRead']` — no server type is redeclared by hand). A new PATH cannot be shimmed
(pdf-reconcile part B), so the hooks come LAST: **A1** = shim + pure modules + components + copy + tests (unblocked);
**A2** = hooks + wiring + shim removal (~25 min, after the S2 regen). No hand-rolled fetch, no `as`, no mock; if A1
finishes before regen, stop and report. **Switch step:** (1) `pnpm --filter @budget/api-client test` green = regen
landed; (2) replace each hand-declared body in `ragContract.ts` with `components['schemas'][…]` and typecheck — every
disagreement between my reading of §6/§7 and the real schema surfaces at the consumers; (3) move those `export type`
lines into `data/txSearch.ts` / `data/advisorQa.ts` (`data/imports.ts` convention), delete the shim, re-point imports;
(4) lint + typecheck + test. Shim deletion is a GATE, not a cleanup wish.

## Screens / components affected · new modules
- `routes/TransactionsPage.tsx` — mode in `selection`; the search query mounted when it is on; the list query gets
  `enabled: !meaningMode` (new optional 2nd arg on `useTransactions`, default true) so two reads never run for one
  screen; `SummaryHeader` → `SearchTotals`, `TransactionList` → `TxSearchResults`; Export is HIDDEN in meaning mode (no
  semantic export on the wire, and one that silently exports the text-matched set is a lie — f-up `rag-search-export`).
- `features/transactions/TxSearchField.tsx` — new `commitOn: 'debounce' | 'submit'` plus the mode toggle inside its form
  (A5). In `submit` mode the timer is never armed; Enter and the "Найти" button commit; typed text survives a mode flip.
- `features/transactions/TxFiltersPopover.tsx` — the SORT select is hidden in meaning mode with the reason as TEXT
  (`tx.sortNotInMeaning`: results are ranked by closeness), never a disabled control with no explanation. `?sort=` stays
  in the URL and applies again on the way back to text mode. `txFilters.ts` — `mode` in the selection + the parser.
- `routes/AdvisorPage.tsx` — `<h2>` on the chat section, `<AdvisorQa />` BELOW it: the chat is the shipped entry point
  and a returning user's muscle memory, the Q&A is a tool. One-line swap if senior-lead disagrees.
- `lib/errors.ts` — `describeSearchError(error, lang, t)`, `describeQaError(error, lang, t)` (the `describeImportError`
  precedent: the new copy lives in the WEB dict; `@budget/shared` ERROR_MESSAGES stays untouched — mobile is frozen and
  would gain dead entries). `data/queryKeys.ts` — `qk.txSearch(params)`. Dicts, 3 CSS modules, `docs/web.md` same pass.
- NEW: `data/ragContract.ts` (TEMPORARY shim) · `data/txSearch.ts` (`useTxSearch`) · `data/advisorQa.ts` (`useAskQa`) ·
  `features/transactions/txSearchMode.ts` (PURE, tested: `TX_SEARCH_LIMIT = 20` / `…_MORE = 50`, `parseSearchMode`,
  `searchModeActive` = mode on AND `q !== null`, `txSearchFilters(selection, limit)` omit-not-undefined like
  `txListFilters` with `sort` structurally absent — the wire has no such parameter, `roundScore` → 2 dp as a NUMBER
  since `t` interpolates through `Intl.NumberFormat`; no `toFixed`, no percent) · `TxSearchResults.tsx` ·
  `SearchTotals.tsx` (server total card, reused by BOTH screens) · `features/advisor/{AdvisorQa,QaCitation}.tsx` ·
  `features/advisor/qaCitationHref.ts` (PURE, tested).

## Data layer
`GET /transactions/search` → key **`['transactions','search', {q, limit, …filters}]`**. Everything the request carries
is in the key (the `fx/convert` rule): another phrase or filter IS another entry, never an invalidation of the previous
answer. The shipped tx-write predicate (`key[0]==='transactions' && key[1] !== 'summary'`) already covers it, because
key[1] is the literal `'search'` — so every create/edit/delete and `invalidateAfterBulkTxWrite` refresh the results with
no new predicate to audit, and the search-time refresh (D-I3c) means the refetched answer re-embeds the row that just
changed or reports it in `pending_count`. Options: `enabled: searchModeActive`, `staleTime: 5 min` (the answer moves
only through writes, which invalidate; a remount must not re-embed the same phrase), **`retry: false`** — the global
policy retries 5xx twice, every attempt is an embedding call plus one of the 30/min tokens, and the 503 is deterministic.

`POST /advisor/qa` is a **mutation with no key, no cache entry, no invalidation** — the `data/advisor.ts` comment
applies verbatim: the server is stateless, no GET could re-fill such an entry, an answer is a one-shot side effect, and
asking changes nothing server-side. It is also why it must not be a query: query retry would double an LLM spend
(mutations carry no retry by default — leave it). No optimistic updates anywhere in this scope.

## UI states
**/transactions, meaning mode.** *Loading* — the existing skeleton card (stable height). *Error* — `QueryStateNotice` +
Retry; 503 `EMBEDDINGS_NOT_AVAILABLE` gets its own arm (the toggle stays visible, the panel says semantic search is
unavailable on this server, the button "искать по словам" flips the mode keeping `q`). The toggle is NEVER pre-disabled
from a guess — the 503 is authoritative (`ai_available` precedent). 429 → "too many searches, wait a minute" (no
Retry-After on the wire, so no delay is named). 422 `SEARCH_QUERY_BLANK` is unreachable from the UI (blank never
commits) → generic bug-signal copy. *Empty* — "ничего похожего" + what to do next: other words, a wider period, clear
the filters (`clearSearchAndFilters`), or switch to text search. *Ready* — a results header (`{count}` found + the
relative-score note ONCE, not per row), `SearchTotals`, rows, and a footer with ONE "показать больше" (re-asks with
`limit: 50`, its own cache entry; no infinite scroll — the wire has no pagination). `pending_count > 0` → one quiet
`role="status"` line: N recent operations are still being indexed and may be missing. `candidates` / `model` are not
rendered; both deadline widgets stay hidden (`isNarrowed` is already true whenever `q` is set).
**Score** — a muted `tnum` badge per row: `tx.searchScore` = "близость 0,83" / "match 0.83", 2 dp, spelled-out
`aria-label`. Never a percentage, never a bar, never "confidence"; the header note says it is relative and comparable
only inside this list. **Totals** — `SearchTotals` renders income / expense / net with `formatMoney` at `total.currency`
plus the existing `unconverted.totals` line when `unconverted_count > 0`, under a label saying "итог по найденным
операциям" so it can never read as the month's. Rows are NEVER summed client-side; `SummaryHeader` is hidden in meaning
mode (two totals on one screen read as one claim).

**/advisor Q&A.** *Idle* — `EmptyState` with three example questions that FILL the field (composer precedent).
*Pending* — skeleton lines + `role="status"`, Ask disabled. *Error* — one alert slot, five distinct sentences because
they call for five different actions: 503 `AI_NOT_CONFIGURED` (no provider; search on /transactions still works), 503
`AI_UNAVAILABLE`, 503 `EMBEDDINGS_NOT_AVAILABLE` (nothing to search over), 422 `QA_FAILED`, 429, plus network.
*Nothing retrieved* (`answer: null`, zero citations) — not an error: "ничего похожего не нашлось" + try other words /
the operations may not be indexed yet. *Answer* — the text VERBATIM, `white-space: pre-wrap`, React-escaped, never
translated, no markdown dependency (the advisor rule); then the citations; then `SearchTotals` over the retrieved set;
then, when `dropped_citations > 0`, one quiet line that N of the model's references did not match the retrieved
operations and were dropped — it is the groundedness metric, so it is text, never a tooltip. `retrieved_count` appears
in the citations heading; `provider` / `model` / `prompt_version` are not rendered.

**Citations → the operation.** Each citation is a mini view (date, `rowTitle`, category, `primaryAmount` — the pure
`rowDisplay` helpers, the `ReconciliationItem` precedent) wrapped in a `<Link>` to
`txWindowHref({kind:'account', accountId}, {kind:'custom', from: occurred_at, to: occurred_at})` — a one-day window of
that account on /transactions, where the row is visible AND editable. Chosen over opening the edit modal in place:
there is no single-transaction route; inventing `?tx=<id>` adds a URL grammar plus a resolve-by-id the cache cannot
answer; a modal over /advisor would need the category/account indices and a form inside a read-only answer; and
`txWindowHref` is an already-pinned grammar (pdf-reconcile decision 5). `account_id` is required non-null, so the link
always resolves. **Q&A form** — rhf + `zodResolver` over `z.object({question: advisorAskSchema})` from
`@budget/shared`: the SAME schema and 2000 cap the chat composer and mobile use; the zod issue `type` maps onto the
existing `advisor.questionRequired|questionTooLong` keys; keyboard grammar mirrors the composer's. No filters in v1
(the body's `from`/`to`/`account_id`/`kind` go unsent; narrowing is the search mode's job) — follow-up `rag-qa-filters`.

## i18n (≈30 keys × 2 dicts; pure modules return KEYS, never sentences)
`tx.searchModeLabel|searchModeText|searchModeMeaning|searchMeaningPlaceholder|searchSubmit` · `tx.searchScore {score}` ·
`tx.searchScoreNote` · `tx.searchResults` (pl) · `tx.searchTotalLabel` · `tx.searchPending` (pl) ·
`tx.searchEmpty|searchEmptyCta|searchToText|searchMore|searchShowing` (pl) · `tx.sortNotInMeaning` ·
`tx.searchUnavailable` · `search.embeddingsUnavailable|rateLimited` ·
`qa.aiNotConfigured|aiUnavailable|embeddingsUnavailable|failed|rateLimited` ·
`advisor.qaTitle|qaLede|qaQuestionLabel|qaPlaceholder|qaAsk|qaAsking|qaEmptyTitle|qaEmptyBody|qaExample1..3|qaNoResults|qaNoResultsCta|qaAnswerLabel|qaCitations`
(pl) `|qaRetrieved` (pl) `|qaDropped` (pl) `|qaTotalLabel|qaOpenRow {date}`. Reused as-is: `unconverted.totals`,
`common.income|expense|net|retry|loading`, `advisor.questionRequired|questionTooLong`. RU plurals in 4 forms where marked.

## Tests (node-only vitest, ~18 cases)
1. `txSearchMode.test.ts` (7) — junk `?mode=` → text; `searchModeActive` false when `q` is null even with
   `mode=meaning`; `txSearchFilters` carries from/to/category/account/country + limit and OMITS what is unset; `sort`
   absent even when the URL sets one (contrast with `txListFilters`, which keeps it — the branch that would silently
   422); `roundScore(0.8312)=0.83`, `roundScore(0.8)=0.8`.
2. `txFilters.test.ts` (+2) — the parser reports the mode; a meaning search is still `isNarrowed` (widgets stay hidden).
3. `qaCitationHref.test.ts` (3) — the href is the account + one-day window; equals `txWindowHref` for the same inputs;
   `txListFilters(parseTxFilters(href))` yields a window CONTAINING the cited row (the `txWindow.test.ts` idiom — a link
   landing on a list without the row is the failure).
4. `errors.test.ts` (+6) — the five new codes map to five DISTINCT messages (not one AI family); unknown code →
   generic; non-`ApiError` → network.

**No component tests, deliberately**: `apps/web` vitest runs `environment: 'node'` with no jsdom / testing-library, and
adding them is a dependency + config decision for senior-lead, not mine (house convention: pure modules instead of DOM
tests). Every breakable decision above lives in a pure module; the components are a switch over one plus `t()`.

## Asks to backend (ASK-n)
- **ASK-1 CONFIRM** `limit` (not `k`) on BOTH routes, 1..50, default 20 (A6).
- **ASK-2 CONFIRM** the hit is literally the same schema in both responses (`AdvisorQaRead.citations:
  TransactionSearchHit[]`) — one web component renders both.
- **ASK-3 CONFIRM** the Q&A `total` is over the RETRIEVED set (not the cited subset) and `total.currency` is the
  profile base currency. The web labels it accordingly and converts nothing.
- **ASK-4 RULE NEEDED** — `answer: null` ⇔ zero citations and no LLM call (D-Q3) is assumed. Is a non-null `answer`
  with ZERO citations reachable, and what should the web say then?
- **ASK-5 CONFIRM** `/advisor/qa` declares all three 503 codes on the `anyOf` so the generated client types them.
- **ASK-6 CLARIFY** `pending_count` — stale rows for the user overall, or within the request's filters? The sentence
  the user reads differs.
- **ASK-7 OPTIONAL, non-blocking** — nothing tells the client that semantic search exists before the first query; the
  web will not pre-disable the toggle (the 503 is authoritative), a boolean on an existing read would only improve the
  first-use explanation. **ASK-8 SEQUENCING** — new PATHS cannot be shimmed: A2 lands only after the S2 regen.

## Risks
- A tx write in meaning mode invalidates the search entry → one refetch = one embedding call + one of the 30/min
  tokens. Bounded at one per write; `retry: false` keeps a failure from tripling it.
- Reusing `TxSearchField`'s debounce path in meaning mode would spend ~5 queries per typed sentence and can 429
  mid-typing. The `commitOn` prop is the guard; it is why submit is explicit.
- Summing the rows on screen instead of printing `total` (a project invariant); rendering a 0.78–0.87 cosine as a
  percentage or a bar (false precision over a RELATIVE number); forgetting to hide `SummaryHeader` in month + meaning
  mode (two totals read as one claim).
- Transfers/debts are not indexed (D-T4), so `?kind=transfer` + meaning mode is an honest empty list — the empty copy
  must not promise rows that cannot exist. The shim: deleting it is part of A2, proved by the drift test, not by eye.

## Estimate (agent-minutes)
A1 write 110 · A2 write + shim swap 25 · gates 15 (`pnpm --filter @budget/web lint typecheck test`) · verification 20
(both 503 arms on stand 8022, real scores on 8021, the pending line after a bulk import). **≈170**, of which ≈45 cannot
start before the S2 regen.
