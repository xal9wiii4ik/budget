# Implementation Plan: categories-api (roadmap 1.3)

## Approach

CRUD over the existing `categories` table (created live at 1.2 with 18 frozen
system seeds). This is a routes+schemas task on an existing table — no new
tables, no structural change — so no architect involvement is required. The
whole task follows the 1.1/1.2 patterns already in the tree: an authenticated
router mounted in `app.py`, lean Pydantic DTOs (`schemas/`), the `{"detail":
CODE}` error envelope, real-Postgres pytest, and paired OpenAPI/api-client
regeneration.

Two design pillars carry the whole task. **Authorization**: every read filters
`user_id = me OR user_id IS NULL`; every write forces `user_id = me` and never
reads `user_id` from the body. **Visibility policy (no-oracle, senior ruling
2)**: system categories are public, so mutating one is a `403
SYSTEM_CATEGORY_READONLY`; another user's category and a nonexistent id are both
`404 CATEGORY_NOT_FOUND` with a byte-identical body (existence stays secret).
The read/write filters make both properties structural rather than a check that
can be "forgotten" (architecture §3).

The lean answer everywhere: `archived` is the only removal semantic (no DELETE);
per-user hide/archive of system categories is out of scope (would need a new
table — a separate architect-involved task if a real need ever appears); archive
rides the general PATCH rather than a dedicated endpoint; no rate limiting.

## Files to modify

- `apps/api/src/budget_api/app.py` — mount the categories router. One line:
  `app.include_router(categories.router, prefix="/categories", tags=["categories"])`.
  **No `Depends(prime_rate_limit)`** on this router — verified below.
- `apps/api/src/budget_api/models/category.py` — reference the shared
  `CategoryKind` StrEnum when building the `kind` CHECK, so the enum is the
  single source for both model and schema (carry-forward). The emitted SQL must
  stay byte-identical to migration 0002 (`kind IN ('expense', 'income')`); the
  1.2 autogenerate probe / `alembic check` guards drift. No migration edit.
- `apps/api/openapi.json` — regenerated (new `/categories` paths + DTOs).
- `packages/api-client/src/generated/schema.d.ts` — regenerated from the above,
  committed in the same commit (standing rule).

## New files

- `apps/api/src/budget_api/enums.py` — `CategoryKind(StrEnum)`. Neutral module
  imported by both `models/category.py` and `schemas/category.py` (no circular
  dep: models never import schemas). Placement rationale: `models/` cannot own
  it (schemas would then import a model module for a pure enum) and `schemas/`
  cannot own it (models would import schemas). A top-level `enums.py` is the
  clean shared home. Named `CategoryKind` (1.4 may reuse for `transaction.kind`,
  whose values coincide but whose meaning is the sign authority — that rename/
  reuse is a 1.4 decision, not made here).
- `apps/api/src/budget_api/schemas/category.py` — `CategoryRead`,
  `CategoryCreate`, `CategoryUpdate`, and a small `CategoryError {detail: str}`
  for the 403/404/409 OpenAPI response declarations.
- `apps/api/src/budget_api/routers/categories.py` — the router.
- `apps/api/tests/test_categories.py` — pytest suite (see Test plan).

## Code skeletons

### `enums.py`
```python
from enum import StrEnum

class CategoryKind(StrEnum):
    expense = "expense"
    income = "income"
```

### `models/category.py` (delta only)
```python
from budget_api.enums import CategoryKind

_KIND_VALUES = ", ".join(f"'{k.value}'" for k in CategoryKind)  # 'expense', 'income'
__table_args__ = (CheckConstraint(f"kind IN ({_KIND_VALUES})", name="kind_valid"),)
```
`kind: Mapped[str]` stays `str` (DB column is `String(16)`); the enum is an
app-level constraint. Definition order (`expense`, `income`) must match 0002.

### `schemas/category.py`
```python
class CategoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    icon: str | None
    color: str | None
    kind: CategoryKind
    archived: bool
    is_system: bool          # derived from (user_id is None); set by the router

class CategoryCreate(BaseModel):          # extra fields ignored (R4 consistency);
    name: str                             # a stray `user_id` in the body is dropped
    kind: CategoryKind
    icon: str | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        v = v.strip()
        if not (1 <= len(v) <= 100):
            raise ValueError("name must be 1..100 chars after trimming")
        return v

    @field_validator("icon")
    @classmethod
    def _clean_icon(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if len(v) > 16:
            raise ValueError("icon must be at most 16 characters")
        return v

class CategoryUpdate(BaseModel):          # all optional; omitted vs explicit-null
    name: str | None = None               # distinguished via model_fields_set
    kind: CategoryKind | None = None
    icon: str | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    archived: bool | None = None
    # reuses the name/icon cleaning validators, each returning None untouched

class CategoryError(BaseModel):
    detail: str
```

### `routers/categories.py`
```python
router = APIRouter()
_ERRORS = {403: {"model": CategoryError}, 404: {"model": CategoryError}}

def _serialize(cat: Category) -> CategoryRead:
    return CategoryRead(
        id=cat.id, name=cat.name, icon=cat.icon, color=cat.color,
        kind=CategoryKind(cat.kind), archived=cat.archived,
        is_system=cat.user_id is None,
    )

@router.get("", response_model=list[CategoryRead])
async def list_categories(include_archived: bool = False, user=Depends(...), session=Depends(get_session)):
    stmt = select(Category).where(or_(Category.user_id == user.id, Category.user_id.is_(None)))
    if not include_archived:
        stmt = stmt.where(Category.archived.is_(False))
    stmt = stmt.order_by(Category.kind, Category.name)
    return [_serialize(c) for c in (await session.scalars(stmt)).all()]

@router.post("", response_model=CategoryRead, status_code=201, responses={409: {"model": CategoryError}})
async def create_category(payload: CategoryCreate, user=..., session=...):
    await _reject_duplicate(session, user.id, payload.name, payload.kind)
    cat = Category(user_id=user.id, name=payload.name, kind=payload.kind,
                   icon=payload.icon, color=payload.color)
    session.add(cat); await session.commit(); await session.refresh(cat)
    return _serialize(cat)

@router.patch("/{category_id}", response_model=CategoryRead, responses={**_ERRORS, 409: {"model": CategoryError}})
async def update_category(category_id: uuid.UUID, payload: CategoryUpdate, user=..., session=...):
    cat = await _load_visible(session, category_id, user.id)   # None -> 404 CATEGORY_NOT_FOUND
    if cat is None:
        raise HTTPException(404, "CATEGORY_NOT_FOUND")
    if cat.user_id is None:
        raise HTTPException(403, "SYSTEM_CATEGORY_READONLY")
    fields = payload.model_fields_set
    if "name" in fields:
        if payload.name is None:
            raise HTTPException(422, "CATEGORY_NAME_REQUIRED")
        # re-check dedup against the *new* name/kind (kind may also change in this PATCH)
    if "kind" in fields and payload.kind is None:
        raise HTTPException(422, "CATEGORY_KIND_REQUIRED")
    # apply name/kind (non-null), icon/color (explicit null clears), archived
    ...
    await session.commit(); await session.refresh(cat)
    return _serialize(cat)
```
`_load_visible` = `select(Category).where(Category.id == id, or_(user_id == me,
user_id.is_(None)))` — a cross-user id matches nothing → `None` → 404, identical
body to a nonexistent id (no-oracle). `_reject_duplicate` = see decision (d).

**PATCH nullable mechanics (decision e):** `payload.model_fields_set` names only
the keys the client actually sent. Omitted `icon`/`color` → absent from the set →
column untouched. Explicit `{"icon": null}` → present in the set with value
`None` → column set to NULL (clears — this is the desired behavior for nullable
columns, and is the deliberate difference from `UserUpdate`, which used
`exclude_none` because `email` is NOT NULL). `name`/`kind` present-but-null → 422
(cannot clear a NOT NULL column).

## Endpoints

| Method | Path | Success | Errors | Notes |
|---|---|---|---|---|
| GET | `/categories` | 200 `list[CategoryRead]` | 401 | `include_archived: bool = false`; system+own merged; `ORDER BY kind, name` |
| POST | `/categories` | 201 `CategoryRead` | 401, 409, 422 | `user_id` forced from token |
| PATCH | `/categories/{id}` | 200 `CategoryRead` | 401, 403, 404, 409, 422 | rename/icon/color/kind/archived |

No `DELETE` (archive is the only removal — old transactions reference
categories, architecture "Категории"). No `GET /categories/{id}` (list returns
all; PATCH returns the updated row; trivial to add at 1.6 if the client needs a
single fetch — omitted as lean surface).

## Reuse gate (Phase 3.6)

- **Authenticated router**: `routers/users.py` mounted with a prefix in
  `app.py` — same shape, minus the fastapi-users factory (we hand-write routes).
- **Auth dependency**: `current_active_user` from `auth.py` (the canonical dep
  every task imports; architecture §3). Never re-instantiated.
- **Session dependency**: `get_session` from `db.py`, via `Depends`.
- **Lean DTO pattern**: `schemas/user.py` — plain `BaseModel`,
  `ConfigDict(from_attributes=True)`, no privilege/leak fields; derive a
  presentation field (`is_system`) instead of exposing storage (`user_id`).
- **Error envelope + OpenAPI declaration**: `routers/auth.py` declares 429 via a
  `responses={status: {"model": RateLimitedError}}` dict with `RateLimitedError
  {detail: str}`. Mirrored here with `CategoryError {detail: str}` for 403/404/
  409. Every `HTTPException.detail` is a stable UPPER_SNAKE code (auth §7).
- **StrEnum**: none exists yet (`transaction.py`/`category.py` hardcode the
  values). This task introduces the shared one — the 1.3 carry-forward.
- **Test harness**: `conftest.py` fixtures `make_client`, `client`, `db_session`
  (names verified). Register+login helper pattern from `tests/test_users.py`.

## Decisions / Open questions (each with a recommendation)

**a. List endpoint.**
- *archived param shape*: `include_archived: bool = false` **(recommend)** vs a
  filter enum. Recommend the bool — the architecture only asks "excluded by
  default"; there is no third state, so an enum is speculative surface.
- *default sort*: `ORDER BY kind, name` **(recommend)** vs none. Recommend a
  deterministic order — the 1.6 client groups expense/income and a stable order
  makes list tests deterministic without a client-side sort. (System-first vs
  user-first not encoded; `is_system` lets the client segment if it wants.)
- *index/performance verdict (Phase 3.5 step 3)*: `WHERE user_id = :u OR user_id
  IS NULL` over a table of 18 system rows + a personal handful of user rows. At
  this cardinality Postgres will **seq-scan regardless** of `ix_categories_user_id`
  (the planner ignores an index on a tiny relation; a BitmapOr of two index
  scans costs more than the scan). **Verdict: no new index; `ix_categories_user_id`
  (already present) is sufficient and largely irrelevant at personal scale.**
  Recorded, consistent with 1.2's no-index verdicts.

**b. Response shape (`CategoryRead`).**
- *`is_system: bool` (derived) vs raw `user_id`*: **recommend `is_system`, drop
  `user_id`.** The 1.6 client needs exactly "editable or not"; raw `user_id` is
  either the caller's own id or NULL (queries guarantee it) — uninformative and
  invites the client to reimplement the derivation. `is_system = user_id is
  None`, computed in `_serialize`.
- *full vs lean list projection*: **same single DTO.** Category rows carry no
  heavy/expensive fields; a separate list projection would add a type for zero
  benefit.
- *include `archived`*: **yes.** Required so the client can render/segment
  archived rows when `include_archived=true`; confirmed.

**c. Create validation.**
- *name 1..100 after trim*: **trim-then-store; reject empty/whitespace-only
  (422).** Storing trimmed avoids invisible-whitespace duplicates and trailing-
  space surprises.
- *color regex*: `^#[0-9A-Fa-f]{6}$` **(recommend)**; `#RGB` short form
  **rejected** (recommend — one canonical width matches the `String(7)` column
  and the seed format). *Case normalization*: **store as-given (validate only),
  do not lowercase.** Reason: the 18 seeds are uppercase (`#4CAF50`);
  lowercasing user input would make responses inconsistently cased against the
  seeds and surprise a user who typed `#ABC123`. Least-surprise + consistency
  both favor as-given.
- *icon max 16, ZWJ check*: `String(16)` counts **code points** (PG varchar
  semantics), not grapheme clusters. Worst-case single emoji glyphs — family
  `👨‍👩‍👧‍👦` (7 cp), couple-with-skin-tones-and-heart `👩🏾‍❤️‍💋‍👨🏻` (~10 cp), tag-sequence
  flags `🏴󠁧󠁢󠁥󠁮󠁧󠁿` (~8 cp), and the existing `🧑‍💻` seed (3 cp) — all fit under 16.
  **Verdict: 16 is sufficient for any single-emoji icon policy.** It is *not*
  enough for "emoji + text label"; if that need ever appears, widen the column
  (a separate migration) — recorded. `max_length=16` in the schema matches the
  column exactly.
- *kind via shared StrEnum*: `CategoryKind` in `enums.py`, used by the schema
  (validation + wire enum) and referenced by the model's CHECK. **Module
  placement decided: top-level `budget_api/enums.py`** (rationale above).

**d. Dedup policy.** **Recommend: enforce a soft 409.**
- *scope*: caller's own (`user_id = me`), **same kind**, **non-archived** rows.
- *case*: case-insensitive (`lower(name)`).
- *system names*: **allowed** — colliding with a system category name is
  intentional (user making an editable copy); the check ignores `user_id IS
  NULL` rows.
- *cross-kind*: **allowed** — the seeds themselves have "Подарки" in both
  expense and income; same name across kinds is legitimate.
- *archived*: **not blocked** — a name freed by archiving can be reused. (Edge:
  dedup is checked on create and on rename, *not* on unarchive; a personal-app
  edge accepted, recorded.)
- *error*: `409 CATEGORY_NAME_CONFLICT`.
- *DB constraint vs API check*: **API-level `SELECT ... EXISTS` check.** It is
  racy (two concurrent creates could both pass), but this is a single-user
  personal app with no concurrent category creation — the race is unreachable in
  practice. A DB partial unique index would have to encode `lower(name)` per
  user per kind **excluding archived and NULL user_id** — awkward and rigid.
  Raciness explicitly accepted and recorded.
- *Alternative to weigh*: allow duplicates entirely (softest, zero code). I
  recommend against — duplicate same-kind categories genuinely muddle the 1.6
  category picker and stats, and the guard is cheap.

**e. Update semantics.**
- *kind change*: **allow.** `transaction.kind` is the sign/aggregation authority
  (1.2 §1); `category.kind` is only a prefill hint and a UI expense/income
  grouping key. Flipping it corrupts no stored data: past transactions keep their
  own `kind`, so every aggregate is unaffected; only future prefills and which
  list the category appears in change. Forbidding it would add surface for no
  integrity gain.
- *nullable omitted vs explicit-null*: `model_fields_set` + per-field handling
  (mechanics detailed above). Explicit null clears `icon`/`color`; omitted leaves
  them; null on `name`/`kind` → 422.
- *archived in the same PATCH*: **yes** (see f).

**f. Archive endpoint shape.** **Recommend `archived: bool` on the general
PATCH.** Unarchive comes free (`archived=false`); no new endpoints; matches the
"archive is a field mutation, not a lifecycle verb" model. A dedicated
`POST /categories/{id}/archive` (+ unarchive) would double the surface for zero
capability. Note: the system-category 403 guard covers archive too — a user
cannot archive a shared `user_id IS NULL` row (it is global; per-user hide is the
out-of-scope new-table question).

**g. Additional items surfaced.**
- *`user_id` never in the body*: `CategoryCreate` has no `user_id` field and
  ignores extras (R4 consistency), so a stray body `user_id` is silently dropped;
  the row always takes `user_id = current_user.id`. Pinned by a test.
- *empty PATCH (no fields set)*: treated as a 200 no-op returning the current row
  (idempotent). Not separately tested.
- *`archived` on create*: not accepted on `CategoryCreate`; always starts
  `false` (create-then-archive if needed). Lean.
- *no `GET /{id}`*: decided above.

## Rate limiting — written decision (senior ruling 4)

**No rate limiting on category CRUD.** These are JWT-authenticated endpoints in a
personal app with no expensive downstream calls; slowapi stays reserved for the
unauthenticated `/auth` routes (1.1) and AI endpoints (4.4). **Verified no
priming needed**: `prime_rate_limit` and the rate-limit contextvar are read
*only* by routes post-decorated with `@limiter.limit` (grep confirms
`prime_rate_limit` is referenced solely in `auth.py`). The categories router
never calls `limiter.limit`, so it never touches the contextvar — mounting it in
`app.py` **without** `Depends(prime_rate_limit)` cannot 500. `_key_func`'s
`getattr(..., "default")` fallback is irrelevant here (never reached).

## Carry-forward mapping (core-data-model §7 → this plan)

| Carry-forward (1.3) | Addressed by |
|---|---|
| system-category mutation guard (reject rename/icon/color/archive where `user_id IS NULL`; `archived` is global) | PATCH → `403 SYSTEM_CATEGORY_READONLY` when `cat.user_id is None`; archive is a PATCH field so it is guarded identically. Test `test_patch_system_category_403`. |
| one Python `StrEnum` for kind shared by models+schemas | `enums.py::CategoryKind`, referenced by `models/category.py` CHECK and used by `CategoryCreate/Update/Read`. |
| color format validation, no DB CHECK | `Field(pattern=r"^#[0-9A-Fa-f]{6}$")` on `color` in create/update schemas (API-level only). Test `test_color_pattern_rejected`. |
| icon length policy | `max_length=16` in schema matching `String(16)`; ZWJ verdict recorded (decision c). |
| optional duplicate-name softness | decision (d): soft `409` within own+same-kind+non-archived, case-insensitive. |
| extraction rule: visible-categories query `user_id = :u OR user_id IS NULL` extracted by the SECOND consumer | **1.3 is the FIRST consumer → the query stays INLINE** in `routers/categories.py`. 1.4 (transactions write-path category load) is the second consumer and extracts it then. Recorded. |
| (§6.5) `icon String(16)` ZWJ note | resolved in decision (c): 16 code points covers all single-emoji ZWJ sequences. |

## Contract regeneration (senior ruling 6)

Both artifacts regenerate from one command and commit together:
```
cd /Users/nikitazaretski/work/budget
pnpm openapi          # turbo run generate: @budget/api#openapi -> openapi.json,
                      # then @budget/api-client#generate -> generated/schema.d.ts
git add apps/api/openapi.json packages/api-client/src/generated/schema.d.ts
```
`tests/test_openapi_export.py::test_committed_schema_matches_current_app` fails
red until `openapi.json` is regenerated, gating the commit. `turbo.json` already
lists `openapi.json` in `@budget/api#test` inputs and wires
`api-client#generate` → `api#openapi` — **no root-file edit expected.**

## Test plan (`tests/test_categories.py`)

Real Postgres, class-based, `make_client`/`db_session` fixtures. Register+login
helper reused from `test_users.py` shape.

**Writing (each pins behavior that can genuinely break and is not otherwise
covered):**

`TestListCategories`
- `test_lists_system_and_own_excludes_archived_by_default` — pins the merge
  (18 system + own active), the default `archived` exclusion, and `is_system`
  flags.
- `test_include_archived_returns_archived` — contrasts the param branch (the
  archived own row appears only here).
- `test_does_not_leak_other_users_categories` — userB's list omits userA's
  category (cross-user read isolation; security).

`TestCreateCategory`
- `test_create_forces_owner_and_ignores_body_user_id` — POST with a bogus body
  `user_id`; 201, `is_system=false`, stored `user_id` = caller (forced-ownership
  + body `user_id` ignored + DTO shape, one test).
- `test_whitespace_name_rejected` — `"   "` → 422 (custom trim validator).
- `test_color_pattern_rejected` — e.g. `"red"`/`"#123"` → 422 (the color
  validation *deferred from 1.2* — this is its load-bearing contract pin; if the
  regex is ever loosened/dropped, this catches it).
- `test_duplicate_same_kind_conflict` — `"Foo"` expense, then `"foo"` expense →
  409 `CATEGORY_NAME_CONFLICT` (custom dedup: existence + same-kind + case-insens).
- `test_same_name_different_kind_allowed` — `"Foo"` expense then `"Foo"` income →
  both 201 (contrasts the dedup branch; genuinely different path).
- `test_can_copy_system_category_name` — create `"Продукты"` expense → 201 (pins
  the deliberate "system names don't block user creates / editable copy"
  decision).

`TestUpdateCategory`
- `test_patch_cross_user_and_missing_both_404` — userB PATCH of userA's id, and a
  random uuid, both → 404 with the **identical body** (no-oracle indistinguish-
  ability; the headline security test).
- `test_patch_system_category_403` — PATCH a seed id → 403
  `SYSTEM_CATEGORY_READONLY` (system guard carry-forward).
- `test_patch_null_clears_and_omitted_preserves` — `{"icon": null}` clears icon;
  omitting `color` leaves it (the `model_fields_set` mechanics — custom logic).
- `test_patch_kind_change_allowed` — create expense, PATCH `kind=income` → 200,
  kind updated (pins decision e; regresses if someone adds a forbid).
- `test_patch_archive_then_unarchive` — `archived=true` → row leaves the default
  list; `archived=false` → returns (archive-via-PATCH semantics, decision f).

`TestAuth`
- `test_requires_auth` — GET `/categories` without a token → 401 (once per
  router, per conventions).

**NOT writing (and why):**
- Pydantic `max_length` on name (>100) / icon (>16), and invalid `kind` enum
  value — pure Pydantic rejection, no custom logic on top (conventions);
  QA curl covers the wire behavior.
- 401 on every method — asserted once per router.
- `kind`/currency DB CHECK enforcement — already pinned in
  `test_core_model.py` (1.2); not re-asserted.
- color case normalization — none applied (store as-given), nothing to contrast.
- empty-PATCH no-op — trivial framework behavior.
- `GET /{id}` — endpoint not built.

**Deviation note discipline**: `test_color_pattern_rejected` sits close to the
pure-Pydantic line (a bare `pattern=`). It is kept as the single regression pin
for the "color validation deferred to 1.3" carry-forward — a deliberate contract
guard, not a vacuous re-assert. Flagged here for senior visibility; drop it only
if you prefer QA-curl-only coverage of the color contract.

## Standing infra

- **Test Postgres on :5443 via `TEST_DATABASE_URL`.** The committed
  `docker-compose.yml` maps `5433:5432` (foreign to the 5443 convention) and
  `conftest.DEFAULT_TEST_DATABASE_URL` also defaults to 5433 — so `make test`
  must run with `TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test`
  pointed at the standing local PG. No conftest/compose edit in this task.
- **No root-file edits expected.** `turbo.json` already globs `src/**`/`tests/**`
  and wires the contract regen; `env: ["TEST_DATABASE_URL"]` on `@budget/api#test`
  is already present (1.2). If implementation reveals any root file must change,
  stop and escalate — root files are backend-owned but require explicit
  justification.

## Risks

- **Model CHECK ↔ migration drift**: rebuilding the CHECK string from the enum
  must emit byte-identical SQL to 0002 (`kind IN ('expense', 'income')`, in that
  order). Guarded by `alembic check` / the 1.2 autogenerate probe; verify at the
  diff gate. If it ever diverges, autogenerate would want a spurious migration —
  a loud signal.
- **404/403 body indistinguishability**: the not-found and not-yours paths must
  return the *same* `detail` code and status. Pinned by
  `test_patch_cross_user_and_missing_both_404`. Any future refactor that adds a
  distinct "not yours" message reopens the oracle — the test is the guard.
- **PATCH null semantics**: the `model_fields_set` handling is the subtle part —
  omitted vs explicit-null must not collapse. Pinned by
  `test_patch_null_clears_and_omitted_preserves`.
- **Dedup raciness**: accepted for a single-user app (decision d). If the app
  ever goes multi-user with concurrent writers, revisit toward a partial unique
  index — recorded, not built (Phase 3.6).

## Pushback on rulings

None. All six rulings are implementable with no code-level contradiction:
- Ruling 4's "no priming" claim is **confirmed** by grep — `prime_rate_limit` is
  read only by `@limiter.limit`-decorated routes, which categories are not.
- Ruling 2's 403-vs-404 policy is clean: system rows are public so the 403 leaks
  nothing; the visible-categories filter makes the 404 paths structurally
  identical.
- Rulings 1/5 (no new table, no DELETE) are stated explicitly above, not merely
  omitted.
