# Contract review (web / consumed at 1.6): transactions-api (roadmap 1.4)

Reviewer: frontend-engineer. Lean review-only role (same as 1.1 / 1.3). Scope: does
the planned `/transactions*` wire contract consume cleanly from the React SPA
(TanStack Query + openapi-fetch generated client in `packages/api-client`)? No code,
no plan edit — verdict per surface. The value here is the obligations list, not a
rubber stamp.

Verified against the actual toolchain and the current generated artifact:
- `openapi-fetch@0.17.0`, `openapi-typescript@7.13.0` (unchanged from 1.3).
- `packages/api-client/src/generated/schema.d.ts` — the LIVE post-1.3 shape: how a
  `StrEnum` renders (`CategoryKind: "expense" | "income"`, L263), how a query param
  renders (`list_categories … query?: { include_archived?: boolean }`, L676), how a
  Pydantic optional-nullable renders (`UserUpdate.email?: string | null`, L407), and
  how a `{detail: str}` error envelope renders (`CategoryError`, L255;
  `HTTPValidationError.detail?: ValidationError[]`, L303).
- `packages/shared/src/money.ts` — `formatMoney` accepts negatives (`assertSafeMinor`,
  L137/L109), `toInputString` rejects them (`assertNonNegativeMinor`, L119),
  `parseMoney`/`moneyAmountSchema` reject negatives (money.ts:47, schemas.ts:22).
- `packages/shared/src/dates.ts` — `formatApiDate` is date-only (`split('-')`,
  L29); no month-string or datetime helper exists.

Senior amendments AM-1/2/3 are not contract-facing. AM-4 (unknown body fields
silently ignored) is addressed in item 11 below.

---

## 1. List envelope `{items, total}` + `limit`(50/200)/`offset`

**ACCEPT.** `TransactionList` generates as `{ items: TransactionRead[]; total: number }`
— exactly enough to drive the 1.6 list and paging. `has_more` is not needed and would
be redundant: the client derives it as `offset + items.length < total`, and `total`
additionally powers "showing N of M" and a page count, which a bare `has_more` could
not. `limit`/`offset` render as `query?: { limit?: number; offset?: number }` (same
mechanism as `include_archived`), passed via openapi-fetch `params.query`.

One consumption note (obligation 1): the 1.6 **month view** filters by the month's
`from`/`to` and a heavy month is ~100–150 rows (plan decision b) — above the `limit=50`
default. The client either paginates by `offset` or requests `limit=200` (the cap) for
the month slice; `total` drives whichever control. No contract change — the envelope
supports both.

## 2. Query param `from` (FastAPI `alias="from"`)

**ACCEPT — verified mechanically.** `Query(None, alias="from")` sets the OpenAPI param
name to `from`, so openapi-typescript emits it as an object property key:
`query?: { from?: string; to?: string; category_id?: string; kind?: "expense" | "income"; limit?: number; offset?: number }`.
A reserved-ish word is a non-issue as a **property key** — it is only a hazard as a
bare identifier/variable, which never occurs here. `from`/`to` are `date` fields →
generated as `string` (openapi-typescript maps `format: date` to `string`, same as
`id: string` for uuids today).

HOW 1.6 passes it (obligation 2): build the query object literal and hand it to
openapi-fetch —
`client.GET('/transactions', { params: { query: { from: toApiDate(start), to: toApiDate(end), category_id, kind } } })`.
The `from`/`to` values come from `toApiDate` (shared, dates.ts:35) so the wire format
is `YYYY-MM-DD`. No destructuring of `from` as an identifier anywhere.

## 3. Summary shape (`by_category` reference-by-id, no embedded names)

**ACCEPT — the client-side join is workable, with three recorded obligations.**
`SummaryRead` generates as
`{ month: string; currency: string; income_minor: number; expense_minor: number; net_minor: number; by_category: CategorySummary[] }`
and `CategorySummary` as `{ category_id: string | null; kind: "expense" | "income"; total_minor: number }`.
Reference-by-id is the right call — embedding category names/colors would duplicate the
mutable `['categories']` cache from 1.3 and go stale after a rename. The breakdown
(`category_id` + `kind` + `total_minor`) is exactly enough for the headline chart:
the client joins to the cached category list for name/color/icon. Not over-shaped
(no per-category net needed — `kind` segments it) and not under-shaped.

Three obligations fall out (see 3, 4, 5 below):
- **Join source must include archived categories.** A summary can reference a category
  that was archived *after* spend landed in it (decision e explicitly allows
  amount-only PATCH on a tx whose category was later archived; old txs keep pointing at
  it). The 1.3 default cache is `['categories', { includeArchived: false }]`. If 1.6
  joins against that, archived-category buckets render as "unknown". The join MUST use
  the `include_archived=true` category set (a dedicated lookup keyed by id).
- **The `null` bucket** (`category_id === null`) is the uncategorized total — rendered
  with a client-supplied "Uncategorized" label (i18n), not the raw null.
- **`(category_id, kind)` is the composite key.** The refund case (decision f) puts the
  **same** `category_id` in `by_category` twice — once `kind: "expense"`, once
  `kind: "income"`. React `key` and any client-side map MUST key on
  `${category_id ?? 'uncategorized'}:${kind}`, never `category_id` alone, or the two
  rows collide.

## 4. Negative `net_minor` formatting

**ACCEPT — the shared display path already handles it; verified in source.**
`net_minor` is signed (`income - expense`, can be negative). `formatMoney` guards with
`assertSafeMinor` (money.ts:109), NOT `assertNonNegativeMinor`, and the source comment
(L118) states the intent explicitly: "a negative net is a legitimate display value."
`Intl.NumberFormat` with `style: 'currency'` renders the locale-correct sign
("-$12.50", "-123,45 ₽"). So `formatMoney(net_minor, summary.currency)` is the whole
display path — no manual sign handling, no `toFixed`, no string surgery.
`income_minor`/`expense_minor`/`total_minor` are non-negative magnitudes and also format
via `formatMoney`. The trap to avoid (obligation 4): NEVER route a summary value through
`toInputString` — it throws on negatives (money.ts:119); it is edit-form prefill of a
magnitude only.

## 5. `TransactionKind` as a SEPARATE generated enum from `CategoryKind`

**ACCEPT — no client friction today, verified against the enum rendering.** Both will
generate as identical string-literal unions: `CategoryKind: "expense" | "income"`
(already at L263) and a new `TransactionKind: "expense" | "income"`. TypeScript is
structural, so `"expense" | "income"` (CategoryKind) is assignable to the identical
`TransactionKind` — the form flow that matters (**pick a category → default the tx kind
from `category.kind`**) is exactly this direction (`CategoryKind` value → `TransactionKind`
field) and compiles cleanly now AND after stage 5, when `TransactionKind` widens to
`"expense" | "income" | "transfer"` (a subset flows into a superset). The reverse
(`TransactionKind` → `CategoryKind`) would break at stage 5, but no flow does that — a
category never derives its kind from a transaction.

Obligation 5: do NOT introduce a shared local `type Kind` alias spanning both. Reference
`components['schemas']['TransactionKind']` at transaction sites and
`components['schemas']['CategoryKind']` at category sites; map `category.kind` → the tx
kind default by direct assignment (the safe direction). A hand-rolled shared alias would
silently break when the enums diverge at stage 5 — the precise breakage decision c
exists to prevent.

## 6. Error codes — string codes AND the Pydantic array now share status 422

**ACCEPT, with a mandatory client obligation and one non-blocking recommendation.**
The envelope is the familiar flat `TransactionError { detail: string }` (mirrors
`CategoryError`, L255). The new wrinkle the plan introduces: **422 carries two runtime
body shapes**, and — unlike 1.3, where custom codes lived on 403/404/409 and 422 was
always the pure-Pydantic array — here they collide on the same status:

- `POST`/`PATCH` custom codes: `{ detail: "CATEGORY_NOT_FOUND" | "CATEGORY_ARCHIVED" | "AMOUNT_REQUIRED" | "KIND_REQUIRED" | "OCCURRED_AT_REQUIRED" }` (422), plus `TRANSACTION_NOT_FOUND` (404).
- Pure-Pydantic validation on the SAME endpoints: `{ detail: ValidationError[] }` (422) for `amount_minor` `ge=1` (zero/negative), `note` > 500, bad `kind` enum, malformed `occurred_at`.

**Generated-type consequence (verified against how the plan pins responses):** the plan
declares `_UNPROCESSABLE = {422: {model: TransactionError}}` on POST/PATCH only. FastAPI
does not add its automatic `HTTPValidationError` for a status already present in
`responses=`, so **POST/PATCH 422 will generate as `TransactionError` (`{detail: string}`)**,
while **GET list / GET summary 422 stay `HTTPValidationError` (`{detail: ValidationError[]}`)**
(those declare no custom 422). So on POST/PATCH the generated 422 type says
`detail: string`, but the runtime ALSO produces the `ValidationError[]` array shape — the
type under-describes one runtime arm.

This is not a blocker because the 1.6 error helper narrows at runtime (the 1.1/1.3
`getErrorCode` pattern: `typeof detail === 'string'` → stable code; non-string → structured
validation). A runtime array hits the non-string arm correctly regardless of what the
generated type claims. Obligation 6: the 422 handler on create/update MUST treat `detail`
as `string | ValidationError[]` and NOT trust the generated `TransactionError` type as
exhaustive — string → map the stable code to a user message
(`CATEGORY_NOT_FOUND`/`CATEGORY_ARCHIVED` → field-level category error;
`AMOUNT_REQUIRED`/`KIND_REQUIRED`/`OCCURRED_AT_REQUIRED` → these only fire from a
malformed PATCH body the client shouldn't send, so treat as an unexpected-error fallback,
see obligation 7); array → generic validation (client-side zod already guards the fields,
so this is a backstop). Extend the 1.3 `getErrorCode` map with the five transaction codes;
keep the single-branch narrow.

**Non-blocking recommendation to backend (via senior-lead):** if the team wants the
generated POST/PATCH 422 type to be honest about both arms, pin the 422 response to a
union (`anyOf: [TransactionError, HTTPValidationError]`) rather than `TransactionError`
alone. Purely a type-accuracy improvement — the client is robust either way via the
runtime narrow, so I do not object to shipping the plan as written.

## 7. PATCH body discipline for `TransactionUpdate`

**ACCEPT the wire shape — with the 1.3-obligation-1 discipline restated for transactions.**
`TransactionUpdate` generates (mirroring `UserUpdate`/`CategoryUpdate`, all optional +
nullable):
```ts
TransactionUpdate: {
  amount_minor?: number | null;
  kind?: ("expense" | "income") | null;
  category_id?: string | null;
  occurred_at?: string | null;
  note?: string | null;
}
```
`JSON.stringify` (openapi-fetch default bodySerializer, verified at 1.3) drops
`undefined` keys → "preserve"; sends `null` → "clear". Obligation 7 (a transaction-shaped
mirror of 1.3 obligation 1): build the PATCH body with ONLY user-touched fields;
`category_id` and `note` cleared → send `null` (never `""`, never `undefined`);
`amount_minor`/`kind`/`occurred_at` NEVER sent as `null` (server returns
`AMOUNT_REQUIRED`/`KIND_REQUIRED`/`OCCURRED_AT_REQUIRED` 422 — you cannot clear a NOT NULL
column). react-hook-form empty inputs (`""`) for `note` are safe (the server normalizes
`""`/whitespace → null, decision i) but the client should still map a cleared note to
`null` for intent clarity; `occurred_at` is required and never cleared. Wrap once; do not
open-code per call site.

## 8. No currency on create; `currency` present in `TransactionRead`

**ACCEPT.** `TransactionCreate` has no `currency` field, so the closed generated type
makes it structurally impossible to send one — the client cannot even accidentally
submit currency (this also subsumes AM-4 for currency specifically). `TransactionRead`
returns `currency: string`. Obligation 8: the create/edit form collects NO currency;
every amount render uses the row's own `currency` (`formatMoney(tx.amount_minor, tx.currency)`)
and the summary uses `summary.currency` — the client never assumes a hardcoded currency.
Stage 3.2 adds an optional create `currency` additively (non-breaking); nothing to
pre-build now.

## 9. No `GET /transactions/{id}` — edit form sources rows from cache / mutation responses

**ACCEPT — workable with TanStack Query, with a stated cache obligation.** The list is
the read path; POST/PATCH return the full `TransactionRead`; DELETE is 204. The 1.6 edit
form gets its row from the list-query cache (or from navigation state when the user clicks
a list row). Obligation 9:
- **Query keys:** list under `['transactions', filters]` (filters = `{ from, to, category_id, kind, limit, offset }`); summary under `['transactions', 'summary', month]`.
- **Edit-form sourcing:** read the row from the `['transactions', filters]` cache or pass it via router state on row-click. On a **cold deep-link/refresh** with no cached list, there is no single-row GET — the edit route must refetch the containing list (by the month/filters it belongs to) and locate the row, OR redirect to the list. If the id is in no fetched page, it cannot be shown (acceptable per decision m; escalate for a real `GET /{id}` only if a genuine deep-link-to-one-tx need appears).
- **Cache updates after mutation (important):** POST/PATCH/DELETE all change BOTH the list AND the month summary (totals shift). After any transaction mutation, invalidate `['transactions']` (list) **and** `['transactions', 'summary', <affected month>]`. Update the list cache in place from the returned `TransactionRead` where cheap; always invalidate the summary — the client cannot recompute the aggregate locally.

## 10. `month` param `"YYYY-MM"` string

**ACCEPT for the month picker.** `GET /transactions/summary` generates
`query: { month: string }` (required). The client builds `"YYYY-MM"` from the picker's
year+month: `${y}-${String(m).padStart(2, '0')}`. Note (obligation 10): shared has NO
month-string helper and NO datetime formatter — `formatApiDate` (dates.ts:29) is
date-only (`split('-')`) and would produce `NaN` on a `"YYYY-MM"` or a `created_at`
datetime. 1.6 builds the `month` string inline (and derives the month's `from`/`to`
bounds for the list: `${month}-01` → last day). If this month math is reused across the
list filter and the summary, consider a small shared `monthParam`/`monthBounds` helper —
NOT blocking, and not this task's scope (defer to 1.6 grooming or a shared-package
follow-up via senior-lead; do not add it speculatively here). Also: `TransactionRead.created_at`
is a `datetime` → generated `string` but is NOT consumable by `formatApiDate`; 1.6 almost
certainly displays only `occurred_at` (date-only, `formatApiDate`-safe). If a `created_at`
timestamp is ever surfaced, it needs a datetime formatter that shared does not yet provide.

## 11. AM-4 — unknown body fields silently ignored

**AGREE, invisible to 1.6.** The generated request types are closed object literals; the
client physically cannot emit a field the schema doesn't declare (e.g. `currency` on
create, item 8). So the server's "ignore unknown fields" leniency is unreachable from the
typed client and requires nothing from 1.6. Confirmed.

---

## 1.6 obligations (durable carry-forwards — 1.6 grooming MUST read this)

Following the 1.1 §7 / 1.3 pattern. These are web-client tasks scoped into 1.6, not
contract changes. They compose with the 1.3 category obligations (still in force).

1. **Month-list paging (item 1).** A heavy month exceeds the `limit=50` default; for the
   month view either page by `offset` or request `limit=200` (the cap). Derive `has_more`
   as `offset + items.length < total`; use `total` for "showing N of M" / page count. Do
   not ask for a `has_more` field — it's derivable.

2. **List filter params (item 2).** Pass `from`/`to`/`category_id`/`kind`/`limit`/`offset`
   via openapi-fetch `params.query`. `from`/`to` come from `toApiDate` (`YYYY-MM-DD`).
   Never destructure `from` as a bare identifier; it is only ever an object key. Fold the
   full filter set into the query key `['transactions', filters]`.

3. **Summary → category join against the ARCHIVED-inclusive set (item 3).** Join
   `by_category[].category_id` to the categories cached with `include_archived=true`
   (a lookup by id) — a summary can reference a since-archived category, and the default
   1.3 cache (`includeArchived: false`) would render those buckets as "unknown". Render the
   `null` bucket as an "Uncategorized" label. **Key each breakdown row on
   `${category_id ?? 'uncategorized'}:${kind}`** — the refund case repeats a `category_id`
   under both kinds; `category_id` alone collides.

4. **Money formatting — signed net via `formatMoney` (item 4).** Render `net_minor` (signed)
   with `formatMoney(net_minor, summary.currency)` — it handles negatives and locale sign.
   Render `income_minor`/`expense_minor`/`total_minor` (non-negative) the same way. NEVER
   pass a summary value through `toInputString` (throws on negatives) or do float/`toFixed`
   arithmetic. Amount inputs go through `moneyAmountSchema(currency)` (magnitude only; sign
   is carried by `kind`, never typed into the amount field).

5. **Do not alias the two Kind enums (item 5).** Reference
   `components['schemas']['TransactionKind']` at tx sites and `['CategoryKind']` at category
   sites. Default a new tx's `kind` from the picked `category.kind` by direct assignment
   (the safe, stage-5-proof direction). No shared local `type Kind`.

6. **Error helper — extend `getErrorCode`, narrow 422 as `string | ValidationError[]`
   (item 6).** Reuse the single-branch `typeof detail === 'string'` narrow. Add the five
   transaction codes: `TRANSACTION_NOT_FOUND` (404 → row gone, refetch/toast),
   `CATEGORY_NOT_FOUND`/`CATEGORY_ARCHIVED` (422 → field-level category error on the form),
   `AMOUNT_REQUIRED`/`KIND_REQUIRED`/`OCCURRED_AT_REQUIRED` (422 → these fire only from a
   malformed PATCH body the client should never send; treat as unexpected fallback). On
   POST/PATCH 422 the generated type is `{detail: string}` but the runtime ALSO yields the
   Pydantic `ValidationError[]`; do not trust the generated 422 type as exhaustive — handle
   both arms at runtime. (Client-side zod is the primary field guard; the array arm is a
   backstop.)

7. **PATCH-body builder for transactions (item 7).** Send ONLY touched fields.
   `category_id`/`note` cleared → `null` (never `""`/`undefined`).
   `amount_minor`/`kind`/`occurred_at` NEVER `null` (server `*_REQUIRED` 422). Bridge
   react-hook-form `""` → `null` for `category_id`/`note`; `occurred_at` is required and
   never cleared. Wrap once; do not open-code.

8. **No currency in forms; render from data (item 8).** The create/edit form collects no
   currency. Every amount renders with the row's `currency` / `summary.currency`. The
   closed generated create type makes sending currency impossible — nothing to guard
   client-side.

9. **Query keys + cross-cache invalidation (item 9).** List `['transactions', filters]`;
   summary `['transactions', 'summary', month]`. Edit form sources its row from the list
   cache or router state (no `GET /{id}`); on a cold deep-link refetch the containing list
   or redirect to it. After ANY transaction mutation, invalidate BOTH the list AND the
   affected month's summary — the client cannot recompute the aggregate locally.

10. **Month string + date formatting gaps (item 10).** Build the `month` param
    (`YYYY-MM`) and the month's `from`/`to` bounds client-side; shared has no month or
    datetime helper. `formatApiDate` is date-only — use it for `occurred_at`, not for
    `created_at` (a datetime). If month math or a datetime display is reused, propose a
    shared helper via senior-lead rather than open-coding — do not add it speculatively in
    this task.

---

## Overall verdict

**ACCEPT — no blocking objection. The contract is consumable as-is at 1.6.** All ten
surfaces pass. Two points carry real substance the 1.6 build must own, both recorded as
obligations, neither a contract change:
- **Item 3** — the summary join must target the `include_archived=true` category set and
  key breakdown rows on `(category_id, kind)`, because a since-archived category and the
  refund case both break a naive `category_id`-keyed join.
- **Item 6** — status 422 now carries BOTH stable string codes and the Pydantic array on
  POST/PATCH, and the generated `TransactionError` type under-describes the array arm; the
  client's `getErrorCode` must runtime-narrow `detail` as `string | ValidationError[]`. I
  raise a non-blocking recommendation (pin POST/PATCH 422 to a `TransactionError |
  HTTPValidationError` union for type honesty) but do not require it — the existing runtime
  narrow makes the client robust either way.

No new or changed endpoint is required for 1.6 to function. `GET /transactions/{id}` stays
correctly omitted (item 9) with a recorded future trigger. Nothing here blocks
implementation of transactions-api.
