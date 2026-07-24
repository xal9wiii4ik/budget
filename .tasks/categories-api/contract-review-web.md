# Contract review (web / consumed at 1.6): categories-api (roadmap 1.3)

Reviewer: frontend-engineer. Lean review-only role (same as 1.1). Scope: does the
planned `/categories` wire contract consume cleanly from the React SPA (TanStack
Query + openapi-fetch generated client in `packages/api-client`)? No code, no plan
edit — verdict per checklist item.

Verified against the actual toolchain and the current generated artifact:
- `openapi-fetch@0.17.0`, `openapi-typescript@7.13.0` (per `packages/api-client/package.json`).
- `packages/api-client/src/generated/schema.d.ts` — inspected for live precedent
  (the 1.1 auth era: `UserUpdate`, `HealthResponse`, `ErrorModel`,
  `HTTPValidationError`).
- openapi-fetch source `node_modules/.pnpm/openapi-fetch@0.17.0/.../src/index.js`:
  default `bodySerializer` = `JSON.stringify(body)` (L632); `serializePrimitiveParam`
  (L422) encodes booleans as `name=true`/`name=false`.

Senior amendments folded in: PATCH dedup triggers on name OR kind change and
excludes the target row itself; 409 is therefore reachable from a **kind-only**
PATCH. Factored into item 4 and the 1.6 obligations.

---

## 1. CategoryRead: derived `is_system: bool` instead of raw `user_id`

**ACCEPT.** This is exactly the shape the 1.6 picker/management UI needs. The one
question the UI asks of each row is "can the user edit/archive this?" and
`is_system` answers it directly (`is_system === true` → render read-only,
no edit/archive affordance; the server backstops with 403). Raw `user_id` would be
strictly worse: the visibility filter guarantees it is only ever the caller's own
id or `null`, so it carries no information the client can act on, and exposing it
would invite the client to re-derive `user_id === null` (leaking a storage detail
into UI logic) or, worse, compare ids needlessly. Precedent is consistent —
`UserRead` in the current schema exposes `is_active` (a derived presentation flag),
not internal columns. openapi-typescript will emit `is_system: boolean` (required,
non-nullable). No objection.

## 2. `kind` as an enum → string-literal union

**ACCEPT — verified against live precedent.** A Pydantic `StrEnum` renders in
OpenAPI as `{"type": "string", "enum": [...]}`, and openapi-typescript@7.13.0 emits
a string-literal union for exactly that. This is already proven in the committed
`schema.d.ts`: `HealthResponse.database: "ok" | "unavailable"` and
`status: "ok" | "degraded"` are StrEnum-derived unions today. `CategoryKind` will
therefore generate `kind: "expense" | "income"` — precisely what the picker wants
to segment expense vs income sections without stringly-typed guesswork. It appears
three ways, all correct: `CategoryRead.kind` required union; `CategoryCreate.kind`
required union; `CategoryUpdate.kind?: "expense" | "income" | null` (item 3). No
objection.

## 3. PATCH omitted-vs-explicit-null (the subtle one)

**ACCEPT the wire shape — with a mandatory 1.6 client discipline, recorded below.**

The contract *can* express both intents, and the generated type is right. Live
precedent removes all doubt: `UserUpdate.email` in the current `schema.d.ts` is a
Pydantic `str | None = None` optional and generates as:

```ts
UserUpdate: { email?: string | null; password?: string | null; }
```

i.e. **optional (`?`) AND nullable (`| null`)** — not collapsed. So the four
`CategoryUpdate` nullable fields will generate as:

```ts
CategoryUpdate: {
  name?: string | null;
  kind?: ("expense" | "income") | null;
  icon?: string | null;
  color?: string | null;
  archived?: boolean | null;
}
```

The wire intents map cleanly through openapi-fetch's default
`bodySerializer = JSON.stringify(body)` (verified L632):

- **omit the key** → `JSON.stringify({})` emits no key → server sees it absent →
  `model_fields_set` excludes it → column preserved. ✅
- **send `null`** → `JSON.stringify({ icon: null })` → `{"icon":null}` → key present
  with null → server clears the column. ✅

So both intents are byte-distinct on the wire and the server's `model_fields_set`
logic reads them correctly.

**The catch 1.6 must own** (this is why it is ACCEPT-with-discipline, not a bare
ACCEPT): TypeScript's optional `?` widens each field to `string | null | undefined`,
and `JSON.stringify` **drops keys whose value is `undefined`**. So at the type level
`undefined` and "absent" are indistinguishable, and both mean *preserve*. The type
alone will NOT stop a careless 1.6 author from conflating "clear" and "preserve" —
the type permits `undefined`, `null`, and absent all at once. Two concrete traps:

1. Setting `icon: undefined` thinking it clears the field — it does not; `undefined`
   is dropped and the column is preserved. To clear, the client MUST send `null`.
2. react-hook-form empty inputs typically yield `""`, not `null`. Sending
   `color: ""` is neither preserve nor clear — it is an explicit empty string that
   fails the server's `^#[0-9A-Fa-f]{6}$` pattern → **422**. The client must map a
   cleared optional field to `null`, never `""`.

The 1.6 obligation (below) is a small explicit PATCH-body builder that emits only
touched fields, uses `null` for user-cleared nullable fields, and never emits `""`
or `undefined` as a "clear" signal. No contract change needed — the shape is
correct; the discipline is client-side.

## 4. Error surface (three stable detail codes + 422 validation shape)

**ACCEPT — the 1.1 single-branch `getErrorCode` approach still holds.** The
`CategoryError {detail: str}` model generates as `{ detail: string }`, so the
403/404/409 bodies are `{ "detail": "CODE" }` — the same flat envelope the whole API
already speaks (429 `RATE_LIMITED` was normalized to `detail` at 1.1, AM-I). The
three codes (`SYSTEM_CATEGORY_READONLY` 403, `CATEGORY_NOT_FOUND` 404,
`CATEGORY_NAME_CONFLICT` 409) are stable UPPER_SNAKE map keys — ideal for i18n
message lookup and mutation error routing.

The only shape that differs is 422, which is FastAPI's `HTTPValidationError`
(`detail?: ValidationError[]`) — already in the schema, already handled by the 1.1
helper. The helper stays single-branch via the same `typeof detail === "string"`
narrowing the 1.1 review established: string arm → stable code; non-string
(array/object) → validation/structured error. Note `ErrorModel.detail` is already
typed `string | { [key: string]: string }` in the schema, so the narrowing guard is
pre-existing, not new work.

What 1.6's error helper MUST handle (recorded as obligation): the three category
detail-codes on the string arm; the `HTTPValidationError` array arm for 422 (color
pattern, name length/whitespace, empty-string-instead-of-null from item 3, invalid
`kind` enum value); and — because of the senior amendment — it must be prepared for
**409 `CATEGORY_NAME_CONFLICT` on a kind-only PATCH**, not just on rename. A user
who flips a category's kind into a group where a same-name sibling already exists
gets a 409; the management-UI mutation error path must surface that (e.g. a field-
level "a category with this name already exists in {kind}" message), not swallow it
as an unexpected error. This is a UX note, not a contract objection.

## 5. `include_archived` boolean query param

**ACCEPT.** openapi-fetch serializes it correctly: `serializePrimitiveParam`
(verified L422) emits `include_archived=true` / `include_archived=false` via
`encodeURIComponent(value)` on the boolean, which FastAPI parses natively. The bool
(vs a filter enum) is the right lean surface — there is no third state. The 1.6
client passes it through `params.query` and folds it into the TanStack Query key so
the archived and non-archived lists cache as distinct entries. No objection.

## 6. List sort `ORDER BY kind, name` server-side

**ACCEPT — but recorded as determinism only; the client WILL re-sort names.** The
server sort is welcome for test determinism and a sane default, and grouping by
`kind` first aligns with how the picker segments. However, Postgres `ORDER BY name`
uses the database collation, which is not the user's locale-aware ordering for
Cyrillic (Russian category names like "Продукты", "Кафе"). The 1.6 client will
re-sort the display order within each kind group using
`Intl.Collator('ru', { sensitivity: 'base' })` (or the active locale) so ordering
matches user expectation and is stable across environments regardless of the DB's
`LC_COLLATE`. This means the server's `name` ordering is effectively cosmetic for
the client — that is fine; the `kind` grouping and overall determinism are the
useful part. Recording it so nobody later assumes the client renders in raw server
order. No contract change; no objection.

## 7. No `GET /categories/{id}`

**ACCEPT.** The list is small (18 system + a personal handful), fetched once and
held in the TanStack Query cache; the picker and management screens both read from
that cached list. POST returns the created row and PATCH returns the updated row, so
mutations can update the cache in place (or invalidate `['categories', ...]`) without
a follow-up single-row GET. There is no 1.6 flow that needs to fetch one category in
isolation. If a deep-link-to-one-category need ever appears, the plan notes it is
trivial to add — cheap to defer. No objection.

## 8. No DELETE — archive via PATCH `archived`

**ACCEPT.** Archive-as-field-mutation is the right model for the client: unarchive
comes free (`archived: false`), and there is exactly one mutation hook to write.
Referential integrity (old transactions keep pointing at the category) is preserved,
which the UI wants anyway — a hard delete would orphan historical data the 1.6+
stats screens rely on. The destructive-action confirmation the UX baseline requires
attaches to the archive action (a confirm dialog before `archived: true`); this is a
client concern, not a contract one. No objection.

## 9. Anything else that would force a 1.6 workaround

Surfacing now while the contract is cheap:

- **No `Location`/echo issue** — POST returns the full `CategoryRead` (201), so the
  create mutation gets the server-assigned `id` and `is_system: false` directly for
  cache insertion. Good; nothing needed.
- **Empty PATCH is a 200 no-op** returning the current row (plan g). Harmless for the
  client; the PATCH-body builder (item 3) naturally avoids sending empty PATCHes, but
  if one slips through it is idempotent. No issue.
- **Color casing stored as-given** (plan c, not lowercased) — the client must NOT
  assume canonical-case `color` values in the response (seeds are uppercase
  `#4CAF50`; a user may store `#abc123`). Any client-side color comparison must be
  case-insensitive. Minor; recorded as an obligation, not an objection.
- **Dedup is case-insensitive and same-kind + non-archived scoped** (plan d): the
  409 can fire on create AND on rename AND (per the senior amendment) on a kind-only
  PATCH. The client cannot fully predict it (it does not hold the archived set unless
  `include_archived=true`), so it must rely on the server 409 rather than pre-
  validating locally. Recorded in obligations.
- **`icon` max 16 code points** — the client should keep any icon input constrained
  to a single emoji/short token; longer input 422s. A soft client-side length hint
  improves UX but the server is authoritative. Minor.

No item forces a contract change. No blocking objection.

---

## 1.6 obligations (durable carry-forwards — 1.6 grooming MUST read this)

Following the 1.1 §7 pattern. These are web-client tasks scoped into 1.6, not
contract changes:

1. **PATCH-body builder for omitted-vs-null (item 3, the load-bearing one).** Build
   the `CategoryUpdate` body to include ONLY fields the user actually touched.
   User-cleared nullable fields (`icon`, `color`) must be sent as `null`, never `""`
   and never `undefined` (JSON.stringify drops `undefined` → preserve, and `""`
   fails the color pattern → 422). `name`/`kind` are never sent as `null` (server
   422s — cannot clear NOT NULL). Bridge react-hook-form empty inputs (`""`) → `null`
   for optionals explicitly. Wrap once; do not open-code per call site.

2. **Error helper (item 4).** Reuse the 1.1 single-branch `getErrorCode`
   (`typeof detail === "string"` narrowing). Map the three category codes
   (`SYSTEM_CATEGORY_READONLY`, `CATEGORY_NOT_FOUND`, `CATEGORY_NAME_CONFLICT`) to
   user messages. Handle the 422 `HTTPValidationError` array arm for color pattern /
   name length+whitespace / invalid kind. Surface **409 on rename OR kind-change**
   (senior amendment) as a field-level "name already exists in this kind" message,
   not a generic failure.

3. **Locale-aware re-sort (item 6).** Render each kind group sorted with
   `Intl.Collator(locale)`; treat server `ORDER BY kind, name` as determinism only,
   not display order. Group by `kind` (`"expense" | "income"`) for the picker/manage
   segmentation.

4. **Read-only rows from `is_system` (item 1).** Gate edit/archive affordances on
   `is_system === true`; the server 403 (`SYSTEM_CATEGORY_READONLY`) is the backstop,
   not the primary UX gate. Do not attempt to archive/edit system rows client-side.

5. **TanStack Query cache shape.** Key `['categories', { includeArchived }]` so the
   archived and default lists cache separately (item 5). Invalidate/update on
   create/patch mutations; no single-row GET exists (item 7) — update the cached list
   from the mutation's returned `CategoryRead` or invalidate the key.

6. **Archive UX (item 8).** Archive is `PATCH { archived: true }`; unarchive is
   `{ archived: false }`. Archive requires a confirmation dialog (destructive-action
   baseline). No DELETE.

7. **Do not assume canonical color casing (item 9).** `color` is stored as-entered;
   any client color comparison/dedupe is case-insensitive.

8. **Cannot fully pre-validate dedup (items 4, 9).** The 409 depends on server-side
   same-kind/non-archived state the client may not hold; rely on the server 409, do
   not reimplement the dedup rule client-side as a hard gate.

---

## Overall verdict

**ACCEPT — no objections. The contract is consumable as-is at 1.6.** All nine items
pass. The one subtle point (item 3, PATCH omitted-vs-null) is a correct wire shape
with a proven live precedent (`UserUpdate.email?: string | null`); the only work it
implies is a small client-side PATCH-body discipline, recorded as obligation 1. No
new/changed endpoint is required for 1.6 to function. Nothing here blocks
implementation of categories-api.
