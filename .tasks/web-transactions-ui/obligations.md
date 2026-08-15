# Consolidated obligations tick-list — web-transactions-ui (1.6)

22 items. Phase 4 senior gate: EACH item must map to a concrete step in plan-web.md
and (where testable) a check in qa-web-checklist.md or a vitest case. Ticked
individually at the implementation diff gate too. Sources:
[C] = .tasks/categories-api/contract-review-web.md (1.3)
[T] = .tasks/transactions-api/contract-review-web.md (1.4)
[A] = .tasks/web-auth-flow/meta-review.md carry-forwards (1.5)

## Categories [C]

- [ ] C1. PATCH-body builder for CategoryUpdate: only touched fields; cleared
      icon/color → `null` (never `""`/`undefined`); name/kind never `null`;
      RHF `""` → `null` bridge; wrapped once, not open-coded per call site.
- [ ] C2. Error helper: extend single-branch `getErrorCode`
      (`typeof detail === 'string'` narrow) with SYSTEM_CATEGORY_READONLY /
      CATEGORY_NOT_FOUND / CATEGORY_NAME_CONFLICT; 422 ValidationError[] arm
      (color pattern, name length/whitespace, invalid kind); 409 surfaced
      field-level ("name already exists in this kind") on rename OR kind-only
      PATCH, not a generic failure.
- [ ] C3. Locale-aware re-sort: `Intl.Collator(locale, {sensitivity:'base'})`
      within each kind group; server ORDER BY is determinism only; group by kind.
- [ ] C4. Gate edit/archive affordances on `is_system === true` (server 403 is
      backstop, not primary UX).
- [ ] C5. Query key `['categories', { includeArchived }]`; archived and default
      lists cache separately; update cache from mutation-returned CategoryRead or
      invalidate the key (no single-row GET exists).
- [ ] C6. Archive = PATCH `{archived: true}` behind a confirmation dialog;
      unarchive = `{archived: false}`; no DELETE.
- [ ] C7. Never assume canonical color casing; any color comparison is
      case-insensitive.
- [ ] C8. Do not reimplement dedup client-side as a hard gate; rely on server 409.

## Transactions [T]

- [ ] T1. Month paging: limit=200 for the month slice (senior ruling R4: single
      fetch + offset "Load more" only when total > loaded); derive
      `has_more = offset + items.length < total`; `total` drives "showing N of M".
- [ ] T2. Filters via openapi-fetch `params.query`; from/to via `toApiDate`
      (YYYY-MM-DD); `from` only ever an object key, never a destructured
      identifier; full filter set folded into query key `['transactions', filters]`.
- [ ] T3. Summary join targets the include_archived=true category set (lookup by
      id); `null` bucket rendered as "Uncategorized" label; breakdown rows keyed
      `${category_id ?? 'uncategorized'}:${kind}` (refund case repeats a
      category_id under both kinds).
- [ ] T4. Signed net via `formatMoney(net_minor, summary.currency)`; income/
      expense/total via formatMoney too; NEVER route summary values through
      `toInputString` (throws on negatives); no float/toFixed arithmetic; amount
      inputs via `moneyAmountSchema` (magnitude only; sign carried by kind).
- [ ] T5. No shared local `type Kind` alias spanning both enums; reference
      `components['schemas']['TransactionKind']` at tx sites,
      `['CategoryKind']` at category sites; default tx kind from picked
      `category.kind` by direct assignment (safe direction only).
- [ ] T6. Error helper: add TRANSACTION_NOT_FOUND (404), CATEGORY_NOT_FOUND /
      CATEGORY_ARCHIVED (422 → field-level category error), AMOUNT_REQUIRED /
      KIND_REQUIRED / OCCURRED_AT_REQUIRED (unexpected fallback); on POST/PATCH
      422 treat detail as `string | ValidationError[]` at runtime — do NOT trust
      the generated TransactionError type as exhaustive.
- [ ] T7. PATCH-body builder for TransactionUpdate: only touched fields;
      category_id/note cleared → `null`; amount_minor/kind/occurred_at NEVER
      `null`; RHF `""` → `null` bridge; wrapped once.
- [ ] T8. No currency collected in forms; every amount renders with the row's own
      `currency` / `summary.currency`; no hardcoded currency.
- [ ] T9. Query keys: list `['transactions', filters]`; summary
      `['transactions', 'summary', month]`. Edit form sources row from list cache
      or router state (no GET /{id}); cold deep-link → refetch containing list or
      redirect. After ANY tx mutation invalidate BOTH list AND affected month's
      summary (summary is not locally recomputable).
- [ ] T10. Month string YYYY-MM + month from/to bounds: senior ruling R5 — add
      shared `monthParam`/`monthBounds` helpers to packages/shared WITH vitest
      (Dec rollover, leap Feb); `formatApiDate` for occurred_at only, never for
      created_at (datetime).

## Auth carry-forwards [A]

- [ ] A1. Protected-shell error affordance for a terminally-errored me-query
      (1.5 finding 6).
- [ ] A2. Bounce authenticated visitors off /login and /register (1.5 finding 8).
- [ ] A3. Email-TLD validation mismatch (shared zod accepts reserved TLDs the
      server 422s): fold into the error-helper field-level ValidationError[]
      mapping so it surfaces on the field, not as a generic form error.
- [ ] A4. AM-7 body-preservation vitest (coordinator suite) is the inviolable
      tripwire for 1.6 mutation retries — it exists and MUST stay green;
      do not weaken it.

## Amendments from later scopes (durable trail)

### 3.2 currencies-goals — recorded by W1/W2 (2026-08-15)

Source: `.tasks/currencies-goals/plan-web.md` §Obligations + grooming-review §4
(carry-forward row "T8→T8′ supersession recorded in obligations trail"). The items
above are NOT rewritten — they stand as the 1.6 record; these are their successors.

- **T8 — PARTIALLY SUPERSEDED. Successor: T8′.** The first clause ("no currency
  collected in forms") is DEAD: the transaction form (W1), the goal form (W3), and
  the receipts confirm form (S6, when it runs) collect the currency via
  `CurrencySelect` over `SUPPORTED_CURRENCIES` (`packages/shared`, D7). Clauses two
  and three survive and are extended:
  **T8′ — every amount renders/decodes with ITS OWN field's currency:
  `amount_minor` with `tx.currency`; `base_amount_minor` with its PAIRED
  `base_currency`; a `/fx/convert` result with the `to` currency the server echoed;
  goal amounts with `goal.currency`; free-balance/allocations with the profile base
  currency. No hardcoded currency, and no `?? baseCurrency` (or any other fallback)
  at ANY minor-unit decode site — receipts §4 AM-5, binding.**
  Pinned by `apps/web/src/features/transactions/rowDisplay.test.ts` (the 100×
  contrast case: a `(5000,'JPY')` snapshot renders ¥5,000, not 50.00) and
  `convertedSection.test.ts` (`editPrefillBaseAmount` decodes with the pair).
- **T7 — EXTENDED, not superseded.** `buildTransactionPatch` now also covers
  `currency` (non-nullable: changed → emit, unchanged → omit) and
  `base_amount_minor` (the omitted / null / value trichotomy off the ""-as-auto
  sentinel, plus the effective-currency drop rule that keeps a
  `BASE_AMOUNT_WITHOUT_CURRENCY` body unbuildable). Still exactly ONE builder: the
  pre-3.2 two-argument call is an overload, so the frozen mobile form keeps
  compiling and can never reach the multi-currency arm.
- **T4 — EXTENDED.** Mixed currencies now occur inside ONE screen and (from W3) one
  card: formatting is per FIELD via `formatMoney`, never per screen.
- **T9 — EXTENDED.** `qk.fxConvert(params)` embeds every conversion input and is
  never invalidated (rates are daily; a changed input is a different key). From W3
  the tx mutations additionally invalidate `['goals','list']`. The 1.6 list/summary
  invalidation matrix is otherwise unchanged.
- **T1/T2/T3/T5/T6/T10 — unchanged.** T6's "unexpected-error fallback" family gained
  `BASE_AMOUNT_WITHOUT_CURRENCY` and `CURRENCY_REQUIRED` (form-level, never routed
  to a field: the schema + builder make both unreachable, so they are bug signals).
- **A4 — untouched.** No auth/coordinator change in 3.2; the AM-7 body-preservation
  vitest stayed green and unmodified through W1/W2.

## Standing gates

- [ ] G1. `packages/api-client/src/generated/schema.d.ts` byte-identical (no API
      change ruled).
- [ ] G2. Lint + typecheck + full vitest gate every round.
- [ ] G3. Root ownership rules respected.
