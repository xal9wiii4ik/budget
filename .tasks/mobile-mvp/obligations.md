# mobile-mvp (1.8) — consolidated obligations register

Owner: senior-lead. This file consolidates EVERY carry-forward targeted at 1.8 from
prior task artifacts. It is the Phase-4 gate skeleton: plan-mobile.md must address
every item by ID; qa-mobile-checklist.md must cover every observable item; the
implementation diff will be ticked against this table.

Sources:
- `.tasks/web-auth-flow/coordinator-review-mobile.md` (O1–O7, the 1.8 obligations list)
- `.tasks/web-transactions-ui/final-report.md` (AM-1.6-a/b/c + carry-forwards)
- `.tasks/categories-api/contract-review-web.md` and
  `.tasks/transactions-api/contract-review-web.md` (wire-contract disciplines; written
  for web 1.6 but they describe the CONTRACT, so every client-side discipline below
  applies verbatim to mobile — marked W-*)
- `.tasks/auth-email-password/contract-review-web.md` (login encoding note, A-1)
- Standing rules (S-*)

Repo facts verified by senior-lead at HEAD ed51ea0 (grounding, not opinion):
- `packages/api-client/src/index.ts` exports `createApiClient`, `login/refresh/
  logout/register`, `getErrorCode`, `TokenPair` — platform-free (constraint held).
- `apps/web/src/lib/patch.ts` imports ONLY `@budget/api-client` types +
  `@budget/shared` types — no web globals. Candidate for physical promotion.
- `apps/web/src/lib/errors.ts` — `getValidationIssues`/`locTailField` are
  platform-free; `describe*Error` couple to web's `ApiError` (lib/query.ts).
- `apps/web/src/data/queryKeys.ts` — platform-free, imports api-client types only.
- `HEX_COLOR_PATTERN` exists twice: private in `packages/shared/src/schemas.ts:75`
  (not exported) and a local copy in `apps/web/.../CategoryFormModal.tsx:36`.
- Mobile scaffold: plain vitest + `src/wiring.test.ts` (formatMoney via Node/V8);
  the Hermes/Intl canary is the running screen, not the test.
- Dev services: API on :8010 (uvicorn manual), Postgres on localhost:5443.

---

## O — Auth coordinator obligations (binding, from coordinator-review-mobile.md)

- **O1** Copy the coordinator pattern, do NOT share it. Re-implement single-flight
  refresh + reactive-only 401→refresh→retry in `apps/mobile/src/auth/`. Reuse only:
  `login/refresh/logout/register` helpers, `getErrorCode`, shared zod schemas
  (`loginFormSchema`/`registerFormSchema`). No `auth-core` package.
- **O2** Storage: async-hydrate-once from `expo-secure-store` into an in-memory
  mirror behind a splash/hydrating gate; after that `getAccessToken()`/
  `getSnapshot()` are sync. Writes: memory sync + `await SecureStore.setItemAsync`
  inside the already-async login/refresh/logout. Tokens in expo-secure-store ONLY,
  never AsyncStorage.
- **O3** Single-flight `inFlight` promise is the ENTIRE concurrency story. No
  navigator.locks analogue, no storage events, no cross-tab logout, no
  adopt-stored-pair double-spend guard. `useSyncExternalStore` over the memory
  mirror for reactivity.
- **O4** VERIFY-don't-assert RN Request/body semantics (spike, findings recorded in
  plan): (a) does openapi-fetch hand the injected fetch a `Request` under RN;
  (b) does RN `Request.clone()` preserve an un-sent JSON body; (c) captured-`init`
  rebuild is the sanctioned fallback and probable default. Re-verify against the
  installed openapi-fetch version (0.17.0 at web; pin check for mobile).
- **O5** Reactive-only refresh (no proactive exp-decode timer). Design the
  background/foreground case: re-evaluate `inFlight` + token freshness on
  `AppState` resume (JS thread may have been suspended mid-refresh).
- **O6** Navigation reaction stays in React via the expo-router guard subscribed
  through `useSyncExternalStore`. The fetch wrapper only clears the mirror +
  notifies — NEVER navigates imperatively. Preserve intended route via typed route
  params (RN analogue of web's `?next=`); login screens deep-link-safe.
- **O7** Error copy table is app-owned, over shared `getErrorCode`. MUST include the
  network-failure arm (flaky mobile networks); every auth mutation shows a visible,
  retryable error affordance.

## AM — Binding amendments from 1.6 (final-report.md)

- **AM-1.6-a** `offset` is the useInfiniteQuery `pageParam`, NOT a query-key member.
  Key = the STABLE filter slice (`{from, to, category_id?, kind?, limit}`).
- **AM-1.6-b** Single archived-inclusive categories cache
  (`['categories', {includeArchived: true}]`) is the ONE source; non-archived views
  are client-derived. No second categories query.
- **AM-1.6-c** Category picker is kind-SEGMENTED (sanctioned pattern). Plans and QA
  checklists MUST NOT use "filtered" wording for the picker.
- **AM-schemas** Reuse shared `transactionFormSchema`/`categoryFormSchema` + month
  helpers (`monthParam`/`monthBounds`/`shiftMonth`/`currentMonth`/`formatMonthLabel`)
  — do not fork form validation or month math.
- **AM-hex** Second-consumer rule: if mobile's color preview guard needs the hex
  pattern (web's does — CategoryFormModal preview), `HEX_COLOR_PATTERN` gets
  EXPORTED from `@budget/shared` NOW and web's local copy dies in the same task.
  frontend-engineer owns the web side of that move.

## W — Wire-contract client disciplines (from 1.3/1.4 contract reviews; contract
## facts, so mobile-binding)

- **W1** PATCH-body discipline, both resources: emit ONLY touched fields; cleared
  nullable fields (`icon`/`color`/`category_id`/`note`) → `null`, never `""`, never
  `undefined`; non-nullable (`name`/`kind`/`amount_minor`/`occurred_at`) never
  `null`. One builder, not open-coded per call site.
- **W2** Error narrow: 422 on POST/PATCH carries `string | ValidationError[]` at
  runtime regardless of the generated type; narrow at runtime. Codes:
  `SYSTEM_CATEGORY_READONLY`, `CATEGORY_NOT_FOUND`, `CATEGORY_NAME_CONFLICT` (fires
  on rename OR kind-only PATCH → field-level name message), `CATEGORY_ARCHIVED`,
  `TRANSACTION_NOT_FOUND`, `*_REQUIRED` (unexpected-fallback arm).
- **W3** Summary join: archived-INCLUSIVE category lookup (consequence of AM-1.6-b);
  `null` bucket renders as "Uncategorized"; composite React/map key
  `${category_id ?? 'uncategorized'}:${kind}` (refund case repeats a category_id
  under both kinds).
- **W4** Money: `formatMoney` for every render incl. signed `net_minor`; NEVER
  `toInputString` on a signed value (throws); amount inputs through
  `moneyAmountSchema` (magnitude only, sign carried by kind); no float math.
- **W5** No `type Kind` alias spanning the two generated enums; default tx kind from
  picked `category.kind` by direct assignment (the stage-5-safe direction).
- **W6** Month list: `limit=200` slice (or offset paging); `has_more` derived as
  `offset + items.length < total`; filters via `params.query` with
  `toApiDate`-formatted `from`/`to`.
- **W7** No currency collected in any form; render from `tx.currency` /
  `summary.currency`.
- **W8** Cache invalidation: after ANY tx mutation invalidate the list AND the
  affected month's summary; a date-move across months invalidates BOTH months'
  summaries; list-only invalidation must not blanket-refetch cached summaries
  (web's `key[1] !== 'summary'` predicate pattern).
- **W9** `is_system` gates edit/archive affordances client-side; server 403 is
  backstop. Archive = PATCH `{archived}` behind a confirm dialog; unarchive free;
  NO DELETE for categories. No client-side dedup pre-gate — rely on server 409.
- **W10** Color casing: stored as-entered; any client color comparison is
  case-insensitive.
- **W11** Locale-aware re-sort of category names within each kind group
  (web uses `Intl.Collator`). MOBILE VERIFY: confirm `Intl.Collator` behavior under
  Hermes on the installed RN 0.86/Expo 57 pair (the 0.1 canary proved
  `Intl.NumberFormat`, not Collator); record fallback if unsupported.
- **A-1** Login is form-encoded with `username`=email — already encapsulated inside
  the shared `login()` helper. Mobile MUST go through the helper, never re-derive
  the encoding.

## S — Standing rules for this task

- **S1** (AMENDED by senior-lead ruling, 2026-07-25, on architect's flagged
  question — PM may veto): Contract untouched means `packages/api-client/src/generated/**`
  byte-identical, NO schema regeneration, `apps/api` untouched, and every EXISTING
  api-client export unchanged. Additive hand-written modules in api-client
  (patch.ts, error-narrow helpers, ApiError/throwOnError per architecture.md) are
  ALLOWED — precedent: auth.ts/getErrorCode landed there at 1.5 under the same
  regime. New `api-client → shared` edge must be `import type` only (grepped at
  diff review). Backend not on the team — this gate is asserted by senior-lead
  diff review (G1 pattern).
- **S2** Root-file ownership = backend → this task writes `plan-mobile.md`, not
  `plan.md`.
- **S3** Full lint gate every round: turbo typecheck+lint+test across touched
  workspaces (`@budget/mobile` + `@budget/shared` + `@budget/web` if AM-hex or any
  promotion touches them), plus web's suite green as the regression gate for any
  promoted module.
- **S4** Test runner decided NOW: jest-expo was deferred to exactly this task at
  0.1. Scaffold-lifetime rule: `src/wiring.test.ts` dies here if superseded by a
  real runner story.
- **S5** No speculative shared packages: only code both clients genuinely consume
  moves; each module gets an explicit verdict (promote where / copy-with-
  conformance) with dependency-direction justification.
- **S6** Dev env: API :8010, PG localhost:5443, iOS simulator via xcrun simctl,
  Expo Go boot proven at 0.1.
