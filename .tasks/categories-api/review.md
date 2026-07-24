# Senior Code Review — categories-api (roadmap 1.3)

Reviewer: code-reviewer (/review_senior full-diff pass)
Scope: working tree vs HEAD 3b1fedd. First user-scoped CRUD router; precedent for
transactions-api (1.4), reviewed with that weight.

Gates run locally (all green):
- `pytest tests/test_categories.py` → 16 passed
- `pytest` (full API suite) → 47 passed, no regressions from the router mount / model change
- `pytest tests/test_openapi_export.py::…schema_matches_current_app` → passed (contract regen gate)
- `pyright --strict` on the four new/changed src files → 0 errors, 0 warnings
- CHECK byte-identity: enum rebuild renders exactly `kind IN ('expense', 'income')`, matching migration 0002 (both occurrences)

---

## Findings

### 1. MINOR — deprecated `HTTP_422_UNPROCESSABLE_ENTITY` constant sets a bad precedent
`routers/categories.py:167,172,177` (three custom 422s).
This router is the **only** code in the tree using `status.HTTP_422_*` (auth.py
uses 400/401). Under the pinned Starlette 1.3.1 the `HTTP_422_UNPROCESSABLE_ENTITY`
alias is deprecated in favor of `HTTP_422_UNPROCESSABLE_CONTENT`, and every custom
422 path emits a `StarletteDeprecationWarning` at runtime (visible in the test run).
Because 1.4 will hand-roll many more custom 422s and will copy this router, the
spelling chosen here propagates. Not a behavior bug (the numeric value is
unchanged).
Recommendation: switch the three references to
`status.HTTP_422_UNPROCESSABLE_CONTENT` so the precedent is warning-free. Trivial,
no test change (tests assert `422` numerically).

### 2. MINOR — dedup archived-exclusion branch has no regression pin
`routers/categories.py:90` (`Category.archived.is_(False)` in `_reject_duplicate`).
Decision (d) deliberately allows reusing a name freed by archiving. No test
exercises that branch on the create path: nothing creates a category whose name
matches an **archived** own same-kind row and asserts 201. `test_patch_archive_
then_unarchive` archives/unarchives but never re-creates the name. If a refactor
drops the `.archived.is_(False)` filter, a user would wrongly get a 409 when
recreating a category they archived — a real, silent UX regression that CI would
not catch.
Recommendation: add one small test (create "Foo" → archive it → create "Foo"
again expecting 201). This is a genuinely-breakable branch, not a vacuous
re-assert, so it is inside the project test policy. Optional if the team judges
QA-curl coverage sufficient, but the pin is cheap and load-bearing for 1.4's copy.

---

## Verified correct (priority items)

**1. Authorization — structural, no leak/mutation path.**
- `list_categories` filters `or_(user_id == me, user_id IS NULL)` + archived
  filter (`:106-111`). ✓
- `_load_visible` filters `id == cid AND (user_id == me OR user_id IS NULL)`
  (`:64-68`) — cross-user id and missing id both resolve to `None` → identical 404
  code path. Structurally indistinguishable, confirmed by
  `test_patch_cross_user_and_missing_both_404` asserting equal JSON bodies. ✓
- `create_category` forces `user_id=user.id` (`:129`); `CategoryCreate` has no
  `user_id` field and ignores extras, so a body `user_id` is dropped — pinned by
  `test_create_forces_owner_and_ignores_body_user_id` (checks stored `user_id`
  against the token, not just the wire). ✓
- Dedup scoped `user_id == me` only (`:87`); system `user_id IS NULL` rows never
  match (copyable), verified by `test_can_copy_system_category_name`. ✓
- Pydantic body-validation 422 runs before the endpoint body, so an invalid PATCH
  body against a cross-user vs nonexistent id is identically 422 — the no-oracle
  property holds even for malformed requests. ✓

**2. AM-1/AM-2 dedup semantics** (`:184-197`). Dedup runs when name OR kind is in
`model_fields_set`, against the **effective** `(name, kind)` pair, with
`exclude_id=category_id`. Create path passes no `exclude_id`. Kind-only collision,
rename-to-collision, and case-only self-rename are all pinned by
`test_patch_dedup_rename_collision_self_rename_and_kind_only`. Archived rows
excluded from the check; system rows excluded (scope = own). Unarchive does NOT
re-check dedup (neither name nor kind in the field set → branch skipped) — the
accepted, recorded edge. ✓

**3. PATCH null semantics** (`:163-213`). `model_fields_set` drives per-field
handling: omitted preserves (field absent), explicit null clears icon/color
(nullable columns), null name/kind/**archived** → 422 with `CATEGORY_NAME_REQUIRED`
/ `CATEGORY_KIND_REQUIRED` / `CATEGORY_ARCHIVED_REQUIRED`. The archived guard added
at the senior gate (`:175-179`) is byte-parallel to the name/kind guards and is
pinned alongside name in `test_patch_null_clears_and_omitted_preserves`. ✓

**4. Model CHECK rebuilt from `CategoryKind`** (`models/category.py:19,25`).
`_KIND_VALUES` renders `'expense', 'income'`; full constraint
`kind IN ('expense', 'income')` is byte-identical to migration 0002. Definition-
order dependence documented in both `enums.py` and the model comment. No migration
edited. ✓

**5. Contract artifacts.** openapi.json + schema.d.ts regenerated together. Paths
`/categories` and `/categories/{category_id}` (param name `category_id` per AM-4);
`CategoryKind` enum `["expense","income"]`; `CategoryRead` carries `is_system` and
**no** `user_id`; `CategoryError` declared on POST 409 and PATCH 403/404/409. TS
mirror consistent (`CategoryKind: "expense" | "income"`, `is_system: boolean`,
`CategoryUpdate.kind?: … | null`). ✓

**6. Test quality.** Each test pins a genuinely breakable path (read merge/archive
filter, forced ownership via DB read, custom name/color validators, dedup create
+update, no-oracle 404 vs 403, null/omit mechanics, kind-change, archive cycle,
auth-once). Deliberate exclusions match the docstring: name>100 / icon>16 / invalid
kind are pure-Pydantic (bare `max_length`/enum, no custom logic layered on) →
correctly QA-curl-owned. One genuine gap noted as Finding 2.

**7. Code quality.** `assert` uses are pyright-narrowing helpers after the 422
guards that do the real work (payload fields are `T | None`); behavior is
unaffected under `-O` because the 422 guards remain — acceptable. Error-declaration
dicts mirror auth.py's `RateLimitedError` pattern. `_serialize` derives `is_system`
centrally. commit→refresh pattern is standard async SQLAlchemy. Docstrings accurate
(the "1.4 extracts it" inline-query note matches the extraction rule). pyright-strict
clean. ✓

**8. Accepted warts — verified as recorded (not re-litigated).**
- Dedup raciness (AM-5): `SELECT … EXISTS`, documented in `_reject_duplicate`. ✓
- Custom 422 string detail vs declared `HTTPValidationError` schema: openapi 422 is
  `#/components/schemas/HTTPValidationError` while the runtime body is
  `{"detail": "CATEGORY_*_REQUIRED"}` — senior-accepted, 1.6 helper narrows on
  typeof. ✓
- icon `""` → None normalization (`_clean_icon`): explicit `""` clears like null. ✓
- Empty PATCH no-op: no fields set → no guards/dedup/apply → 200 current row. ✓

---

## Verdict: APPROVE WITH NITS

No blockers, no majors. Authorization is structurally correct and the no-oracle
property holds by construction (verified, not just asserted). Both findings are
minor and non-blocking; Finding 1 (deprecated 422 constant) is worth fixing before
1.4 copies this router, and Finding 2 is a cheap load-bearing test to add. Ship-able
as-is; address the two minors at the team's discretion.
