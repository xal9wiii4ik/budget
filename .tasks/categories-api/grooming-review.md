# Grooming Review (Phase 4) — categories-api (roadmap 1.3)

Senior-lead critical review of plan.md (backend, 3 endpoints, decisions a–g),
qa-checklist.md (qa-engineer, 22 checks + 3 preconditions, written against the
AM-1/AM-2 amended state), contract-review-web.md (frontend, ACCEPT with zero
objections, 8 durable 1.6 obligations). Verdict: **accepted with the rulings
and amendments below.** No artifact goes back for rewrite; plan deltas fold at
/implement, checklist is already amended-state-native.

## 1. Team selection (recorded)

backend-engineer (all apps/api changes: router, schemas, enums.py, tests,
contract regeneration) + qa-engineer (endpoints → curl checklist mandatory) +
frontend-engineer in the NARROW review-only role proven at 1.1 (the wire shape
is exactly what 1.6 consumes; the review returned zero objections but produced
the load-bearing PATCH-body discipline obligation and verified the
omitted-vs-null generated-type precedent against the live schema.d.ts — it paid
for itself again). **architect NOT invoked**, justified: CRUD on an existing
table — no new tables, no new modules, no dependency-direction change; the
structural decisions were already pinned by the 1.2 grooming (sign model,
mutation guard, extraction rule). The one potentially structural fork —
per-user hide/archive of SYSTEM categories, which would require a new
per-user-prefs table — was resolved with the lean answer (out of 1.3 scope,
system rows globally immutable to users, 403; trigger recorded in §7). If the
PM vetoes toward per-user hide, architect is invoked for that as a separate
task BEFORE any implementation. mobile-engineer / web-qa / mobile-qa NOT
invoked: no client code, no UI. code-reviewer arrives at /review_senior.

Process note: backend planned first (plan.md is the oracle for both other
artifacts); QA and frontend then ran in parallel against the amended plan —
safe because they consume the contract, not each other. My own gate review of
plan.md happened BEFORE the parallel fan-out and produced AM-1/AM-2, so both
downstream artifacts were written against the amended state (verified: QA
TC-18/TC-19 and the contract review's kind-only-409 note both exist).

## 2. Cross-check results

- **plan ↔ qa-checklist**: every endpoint, error code, and decision a–g has a
  live check; the division-of-labor section correctly declines to duplicate
  pytest (whitespace-name, model_fields_set internals, list read isolation)
  while owning the Pydantic-layer wire rejections backend's pytest deliberately
  excludes (name>100, icon>16, invalid kind — TC-8/9/10; the right split). The
  string-vs-array `detail` envelope contrast is called out as itself the
  contract — good catch, consistent with the contract review's item 4. QA's
  hard-pinned seed expectations (TC-4 `Продукты`/🛒/`#4CAF50`, 13+5 kind split;
  TC-15 seed UUID `ce814749-2554-40be-8952-3a63d505694f`) were re-verified by
  me against migration 0003 — all exact. The three QA-flagged uncertainties are
  ruled in §3 (R1–R3). No gaps found.
- **plan ↔ contract review**: zero objections; all nine items ACCEPT. The
  omitted-vs-explicit-null mechanics (plan decision e) are confirmed
  consumable with live precedent (`UserUpdate.email?: string | null` in the
  committed schema.d.ts) — the plan's subtlest decision is validated by its
  actual consumer. The review's 8 obligations are recorded as durable 1.6
  carry-forwards in §7 (PM instruction 2 — done).
- **qa-checklist ↔ contract review**: consistent on every shared surface
  (envelope shapes, 409-on-kind-only-PATCH reachability, no user_id on the
  wire, boolean query param).
- **Conflicts**: none requiring arbitration.

## 3. Rulings (PM-requested + my gate findings)

### R1 — 401 body expectation (QA uncertainty a). RULED: status-only contract.

TC-1's note stands: the assertion is the **401 status**; the body string
(`{"detail":"Unauthorized"}`) is fastapi-users' transport internals, not our
code. Pinning the exact string would couple QA to a library detail that can
change on a pin bump with zero product meaning — precisely the kind of vacuous
assertion the project test policy forbids. The 1.6 client's error helper keys
off status + the string-vs-array `detail` narrowing, never off the 401 prose.
QA deletes the uncertainty flag; TC-1/2/3 assert status only. (AM-3)

### R2 — PATCH path-param name (QA uncertainty b). RULED: pinned `/categories/{category_id}`.

The plan's skeleton already uses `category_id: uuid.UUID`; it is now the
binding contract, matching the OpenAPI path `/categories/{category_id}` that
TC-20 asserts and the generated client will carry into 1.6. Implementation may
not rename it (a rename would be a silent contract diff in schema.d.ts).
TC-20's expectation is now hard, the "adjust if it differs" caveat is deleted.
(AM-4)

### R3 — Dedup raciness (QA uncertainty c). RULED: accepted in writing.

The API-level `SELECT EXISTS` dedup check is racy under concurrent creates.
**Accepted as a single-user-app tradeoff** — the race requires two concurrent
category writes by the same user, unreachable in practice for a personal app.
This is a conscious decision, not an oversight. Revisit trigger recorded: if
the app ever gains real multi-user concurrency, replace with a partial unique
index `(user_id, lower(name), kind) WHERE NOT archived AND user_id IS NOT
NULL` — machinery deliberately not built now (Phase 3.6). QA's out-of-scope
note stands. (AM-5)

### R4 — (my gate, pre-fan-out) PATCH dedup fires on name OR kind change. AM-1.

The plan's skeleton re-checked dedup only when `name` was in the field set. A
kind-only PATCH can create a duplicate pair (own "Foo" expense + "Foo" income;
flip one → two "Foo" income). The check runs against the **effective new
(name, kind) pair** whenever either changes. Pinned by QA TC-18 and one new
pytest (update-path dedup).

### R5 — (my gate, pre-fan-out) Update dedup excludes the target row. AM-2.

Case-only self-rename ("Foo" → "foo") must be 200, not a self-collision 409:
the dedup query excludes `id = category_id`. Pinned by QA TC-19 and the same
new pytest.

### R6 — `test_color_pattern_rejected` stays. RULED: keep.

Backend flagged it as close to the pure-Pydantic line. It stays: it is the
regression pin for the color validation **explicitly deferred from 1.2 to this
task** — a deliberate contract guard with a named provenance, not a vacuous
re-assert. If the regex is ever loosened, CI goes red, not just a one-time
curl.

## 4. Amendments (binding)

- **AM-1** — PATCH dedup triggers on the effective new (name, kind) pair (name
  OR kind change), not rename-only. Plan folds at /implement; pytest list
  gains one update-path dedup test (rename-to-collision 409 + self-rename 200);
  QA TC-18 is the live pin.
- **AM-2** — update dedup query excludes the target row itself. Same pytest;
  QA TC-19 is the live pin.
- **AM-3** — 401 body is a status-only contract (R1); QA TC-1/2/3 assert
  status, uncertainty note deleted.
- **AM-4** — path param pinned `category_id` → OpenAPI path
  `/categories/{category_id}` (R2); TC-20 expectation now hard.
- **AM-5** — dedup raciness accepted in writing with the multi-user revisit
  trigger (R3); recorded, not built.

## 5. Per-amendment / carry-forward checklist (Phase 4 obligation)

| Binding item | Source | In plan.md | In qa-checklist.md | Verdict |
|---|---|---|---|---|
| system-category mutation guard (`user_id IS NULL` → 403) | 1.2 §7 | ✓ PATCH guard + `test_patch_system_category_403` | ✓ TC-15 (incl. archive attempt + DB no-mutation check) | covered |
| one `CategoryKind` StrEnum shared models+schemas | 1.2 §7 | ✓ `enums.py`, model CHECK rebuilt from enum (byte-identity risk → my diff gate + `alembic check`) | ✓ TC-10 (Pydantic enum layer) | covered |
| color format validation (API-level, no DB CHECK) | 1.2 §7 (deferred from 1.2) | ✓ `pattern=^#[0-9A-Fa-f]{6}$` + pytest (R6 keep) | ✓ TC-7 | covered |
| icon length policy + ZWJ verdict | 1.2 §7 / §6.5 | ✓ max_length=16; 16 code points covers single-emoji ZWJ (verdict recorded) | ✓ TC-9 | covered |
| duplicate-name softness | 1.2 §7 | ✓ decision d: soft 409, own+same-kind+non-archived, case-insens + AM-1/AM-2 | ✓ TC-11/12/13/18/19 | covered |
| extraction rule: visible-categories query inline (1.3 = FIRST consumer; 1.4 extracts) | 1.2 §7 | ✓ recorded, query stays inline | n/a | covered |
| contract artifacts regenerate/commit together | standing | ✓ exact commands, drift test gate | ✓ TC-20/TC-21 (incl. same-commit git check) | covered |
| local PG 5443 via TEST_DATABASE_URL (committed 5433 foreign) | standing | ✓ standing-infra section | ✓ preconditions (5443 live DB + STOP rules) | covered |
| root-file ownership = backend; no root edits expected | standing | ✓ stop-and-escalate clause if one appears | n/a | covered |
| per-amendment checklist in /implement report | standing | ✓ obligation restated | ✓ summary gates table | covered; /implement ticks AM-1…AM-5 + this table row by row |
| AM-1/AM-2 (my gate) | this review | → fold at /implement (+1 pytest) | ✓ TC-18/TC-19 already written | fold at /implement |
| AM-3/AM-4/AM-5 (rulings) | this review | AM-4 already matches skeleton; AM-5 already recorded in Risks | ✓ minor note deletions (TC-1, TC-20) | fold before /test |

## 6. Risky spots — my own verification (not delegated)

1. **`prime_rate_limit` not needed on the categories router** — backend's grep
   claim re-verified by me: referenced only in `rate_limit.py` and
   `routers/auth.py` (router-level dependency there); the categories router
   never calls `limiter.limit`, so mounting without priming cannot 500.
2. **CHECK byte-identity**: `"kind IN ('expense', 'income')"` is identical
   today in `models/category.py` and migration 0002 (both occurrences). The
   enum-rebuilt f-string reproduces it exactly given definition order
   (`expense`, `income`). Diff-gate item: I compare the rendered string at
   review; `alembic check` is the mechanical backstop.
3. **Fixtures exist as named**: `make_client`, `client`, `db_session` verified
   in conftest.py.
4. **Error-declaration pattern**: `responses={... {"model": RateLimitedError}}`
   verified in routers/auth.py — `CategoryError` mirrors an existing pattern,
   not a new idiom.
5. **QA's hard seed pins verified against migration 0003**: Продукты =
   `ce814749-2554-40be-8952-3a63d505694f`, expense, 🛒, `#4CAF50`; seed split
   13 expense + 5 income. TC-4/TC-15 expectations are exact, not inferred.
6. **404 indistinguishability is structural**: `_load_visible` filters by
   `(id = :id AND (user_id = me OR user_id IS NULL))` — cross-user and missing
   ids take the same code path, so the byte-identical bodies (TC-14) hold by
   construction, with the test as the regression guard.
7. **Icon "" → None normalization** (create/update validator): explicit
   `{"icon": ""}` clears like `null`. Acceptable normalization, noted so the
   reviewer doesn't mistake it for a bug; the 1.6 body-builder sends `null`
   anyway (obligation 1).

## 7. Carry-forwards to future tasks (durable record; each grooming reads this)

- **1.4 (transactions API)**: SECOND consumer of the visible-categories query
  (`user_id = :u OR user_id IS NULL`) → EXTRACT it per the 1.2 rule (write-path
  category authorization: load category, require system-or-own, pytest-covered
  there). Decide whether `CategoryKind` in `enums.py` is reused for
  `transaction.kind` (values coincide; meaning differs — tx.kind is the sign
  authority). Cross-kind re-categorization UX ownership (1.2 §7).
- **1.6 (web: categories UI)** — from contract-review-web.md, all eight are 1.6
  scope, not 1.3 changes (1.6 grooming MUST read that file's obligations
  section in full):
  1. PATCH-body builder: only touched fields; user-cleared nullables → `null`,
     never `""`/`undefined` (JSON.stringify drops undefined = preserve; `""`
     fails the color pattern → 422); never `null` for name/kind.
  2. Error helper: 1.1 single-branch `getErrorCode`; map the three category
     codes; handle the 422 array arm; surface 409 on rename OR kind-change as
     a field-level message.
  3. Locale-aware re-sort per kind group (`Intl.Collator`); server
     `ORDER BY kind, name` is determinism, not display order.
  4. Gate edit/archive affordances on `is_system` (server 403 is backstop).
  5. TanStack Query key `['categories', { includeArchived }]`; update cache
     from returned CategoryRead; no single-row GET exists.
  6. Archive = PATCH `{archived: true}` + confirmation dialog; no DELETE.
  7. No canonical color casing assumption (stored as-given).
  8. Do not reimplement dedup client-side as a hard gate; rely on the server
     409.
- **Future trigger — per-user hide of system categories**: needs a new
  per-user-prefs table → separate, architect-involved task if real need
  appears. NOT 1.3.
- **Future trigger — dedup unique index**: on real multi-user concurrency,
  partial unique index `(user_id, lower(name), kind) WHERE NOT archived` (AM-5).
- **Future trigger — icon column widening**: `String(16)` covers single-emoji
  ZWJ; "emoji + text label" would need a migration (plan decision c).

## 8. Decisions made this grooming (PM may veto, no answer required)

403 `SYSTEM_CATEGORY_READONLY` for system rows (public existence — no oracle
leak) vs 404 `CATEGORY_NOT_FOUND` for cross-user/missing (secret existence,
byte-identical bodies); `user_id` never read from the body, forced from the
token; derived `is_system` on the wire, raw `user_id` dropped; single DTO for
list and mutations; `include_archived: bool = false`; `ORDER BY kind, name`;
no new index (seq-scan verdict at personal cardinality, recorded); trim-then-
store names, 1..100; color `^#[0-9A-Fa-f]{6}$`, no `#RGB`, stored as-given;
icon ≤ 16 code points; `CategoryKind` StrEnum in new `budget_api/enums.py`,
model CHECK rebuilt from it; soft 409 dedup (own + same-kind + non-archived,
case-insensitive, system names copyable, cross-kind allowed) with AM-1/AM-2
update semantics and AM-5 race acceptance; kind change allowed (prefill hint,
not sign authority); explicit-null clears icon/color, omitted preserves, null
name/kind → 422; archive via PATCH `archived` (no dedicated endpoint, no
DELETE, no GET /{id}); no rate limiting on category CRUD (JWT-gated, no
expensive downstream; slowapi stays on auth + future AI routes); no root-file
edits; contract artifacts regenerate and commit together.

## 9. Open questions for the PM (veto-style; defaults = recommendations, none blocking)

1. **Dedup: soft 409 vs allow duplicates entirely?** Recommend **soft 409**
   (own + same-kind + non-archived, case-insensitive) — duplicates muddle the
   1.6 picker and stats; the guard is cheap. Veto = drop the check and
   TC-11/18/19 + two pytests.
2. **Kind change on an existing category: allow vs forbid?** Recommend
   **allow** — tx.kind is the sign authority (1.2), so a flip corrupts no
   aggregate; forbidding adds surface for zero integrity gain. Veto = 409/422
   on kind in PATCH.
3. **System categories globally immutable (403) vs per-user hide (new
   table)?** Recommend **immutable, lean answer** — per-user hide is a new
   prefs table and an architect task; no evidence of need yet. This is the
   PM's veto point on the architect-skip.
4. **No DELETE and no GET /{id} at all?** Recommend **yes to both
   omissions** — archive preserves referential history (architecture); the
   list is small and cached, PATCH/POST return full rows. Either is cheap to
   add later if a real client need appears.
5. **Color stored as-given (validate-only) vs normalized to one case?**
   Recommend **as-given** — seeds are uppercase; normalizing user input would
   make responses inconsistently cased. Client compares case-insensitively
   (1.6 obligation 7).
6. **404-not-403 for cross-user ids, byte-identical with missing?** Recommend
   **yes** (no-oracle, consistent with 1.1) — TC-14 diff-pins it. Veto =
   distinct messages, reopening the existence oracle.

No blocking questions. Ready for /implement on PM's go: backend implements
plan.md + AM-1…AM-5 (test suite gains one update-dedup test); QA folds the
AM-3/AM-4 note deletions before /test; /implement report ticks §5 row by row.
