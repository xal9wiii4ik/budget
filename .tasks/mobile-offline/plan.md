# Implementation Plan: mobile-offline B-1 — transaction-create idempotency via `client_id`

Scope: **B-1 only** (backend). Grounded in files read at HEAD:
`apps/api/src/budget_api/routers/transactions.py` (`create_transaction`,
`_validate_category`, `_validate_receipt`, `_get_or_create_profile`,
`_auto_snapshot`, `_serialize`), `schemas/transaction.py`,
`models/transaction.py`, `models/base.py` (naming convention),
`alembic/versions/0004_*.py` + `0005_*.py` (house migration style),
`routers/categories.py` (conflict precedent), `routers/health.py` (the
`response: Response` status-override precedent), `db.py` (`get_session`),
`tests/conftest.py`, `tests/test_transactions.py`,
`tests/test_merchant_learning.py`, `tests/test_openapi_export.py`,
`packages/api-client/scripts/generate.mjs`, `apps/api/package.json`,
`.tasks/mobile-offline/architecture.md` (Decision 3 — BINDING),
`.tasks/stats-advisor/plan.md` (contract-regen ritual).

Binding upstream: architecture Decision 3. Nothing below overrides it; the two
places where it left a choice open (race mechanism; hit-vs-validation order) are
decided here with the argument.

---

## 1. Approach

A client-generated `client_id` UUID becomes a per-user idempotency key for
`POST /transactions`. The handler does a **select-first** on `(user_id,
client_id)`; a hit returns the STORED row with **200** and performs no writes at
all; a miss runs today's create path verbatim with `client_id` stamped on the
new row. A **partial unique index** `(user_id, client_id) WHERE client_id IS NOT
NULL` makes the invariant a database fact rather than an application hope, and
the lookup→insert race window is closed by catching the resulting
`IntegrityError`, rolling back, and re-selecting.

Why select-first + IntegrityError recovery, and not `ON CONFLICT DO NOTHING`:
today's create path is ORM-shaped (`session.add(tx)` → `commit()` → `refresh(tx)`,
with `created_at` from a server default). Converting it to a Core
`pg_insert(Transaction).on_conflict_do_nothing(index_elements=[...],
index_where=...).returning(...)` would rewrite the one code path the PM brief
requires to stay **byte-identical for callers without `client_id`** (web), and
would still need a re-select on the zero-rows arm — i.e. all of the risk, none of
the saving. The recovery arm is also provably reachable-only-once: Postgres makes
a conflicting INSERT *block* on the unique index until the winning transaction
commits or aborts, so when the loser sees the duplicate-key error the winner's
row is already committed and visible to a fresh read (READ COMMITTED). The
re-select therefore cannot legitimately come back empty.

Additive and optional end to end: `TransactionCreate.client_id` defaults to
`None`, `TransactionRead` gains nothing, the column is nullable with no backfill,
the index exempts NULLs. Web and every existing API caller keep today's exact
request/response bytes and today's 201.

---

## 2. Schema, model, migration

### 2.1 `apps/api/src/budget_api/schemas/transaction.py`

Add to `TransactionCreate` only (NOT to `TransactionUpdate`, NOT to
`TransactionRead` — architecture Decision 3: it is a write-side dedup token, not
a read-model fact):

```python
    # Client-generated idempotency key (mobile outbox replay). Optional and
    # additive: web sends nothing and keeps the pre-5.5 contract byte-for-byte.
    # FIRST WRITE WINS — a replay carrying the same key returns the stored row
    # unchanged, so the key must never be reused for a different body.
    client_id: uuid.UUID | None = None
```

No validator: Pydantic's UUID parsing is the whole contract (a malformed value is
a plain 422 — QA-curl-owned per the house split, no pytest).

### 2.2 `apps/api/src/budget_api/models/transaction.py`

Column (placed next to the other nullable write-side columns):

```python
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
```

Index, appended to `__table_args__` next to `ix_transactions_user_id_occurred_at`:

```python
        # Per-user idempotency key (5.5). PARTIAL: pre-5.5 rows and every
        # web-created row carry NULL and are exempt. Per-USER scoping means one
        # user's uuid can never collide with another's (no cross-user oracle).
        Index(
            "uq_transactions_user_id_client_id",
            "user_id",
            "client_id",
            unique=True,
            postgresql_where=text("client_id IS NOT NULL"),
        ),
```

Naming: an explicit name is mandatory — a partial unique index cannot be a
`UniqueConstraint` in Postgres, and `Base`'s `"ix"` convention
(`ix_%(column_0_label)s`) would render `ix_transactions_user_id`, which is both
wrong and collision-prone. The explicit multi-column spelling follows the house
precedent (`ix_transactions_user_id_occurred_at`,
`ix_goal_contributions_goal_id_occurred_at`) with the `uq_` prefix carrying the
uniqueness. This spells out both columns where architecture Decision 3 wrote the
illustrative `uq_transactions_user_client`; same object, house-consistent name.

`text` must be imported from `sqlalchemy` in the model module.

### 2.3 Migration — `apps/api/alembic/versions/000N_client_id_idempotency.py`

**Revision number is assigned AT IMPLEMENT TIME**: this scope lands AFTER
`recurring-and-limits`, so `down_revision` is whatever that scope's migration
left as head (0005 is head at grooming time — do NOT hardcode 0006/`"0005"`
from this document; run `uv run alembic heads` in `apps/api` first).

Pure DDL, additive, no backfill, symmetric downgrade — the 0004/0005 style:

```python
def upgrade() -> None:
    op.add_column("transactions", sa.Column("client_id", sa.Uuid(), nullable=True))
    op.create_index(
        "uq_transactions_user_id_client_id",
        "transactions",
        ["user_id", "client_id"],
        unique=True,
        postgresql_where=sa.text("client_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_transactions_user_id_client_id", table_name="transactions")
    op.drop_column("transactions", "client_id")
```

Downgrade is fully reversible and lossless-by-design (it drops a column that
holds only client-side tokens; no derived data depends on it).

**Drift gate:** `uv run alembic check` must be clean. Partial indexes are the one
place alembic autogenerate is known to report phantom drift when the model's
`postgresql_where` text does not match Postgres' normalized rendering. If it
reports drift, change the model expression form (`Transaction.client_id.isnot(None)`
instead of `text(...)`, or match PG's `(client_id IS NOT NULL)` parenthesization)
— never silence the check.

---

## 3. Create-path restructure — `routers/transactions.py::create_transaction`

### 3.1 New module-level helper (next to `_load_own`)

```python
async def _load_by_client_id(
    session: AsyncSession, user_id: uuid.UUID, client_id: uuid.UUID
) -> Transaction | None:
    """user_id-scoped idempotency lookup — the ONE query both arms share."""
```

Mirrors `_load_own`'s shape and its no-oracle property: the filter carries
`Transaction.user_id == user_id`, so a hit can only ever be the caller's own row.

### 3.2 Placement ruling — the hit short-circuits BEFORE every validation

The lookup is the **first statement of the handler**, ahead of
`_validate_category`. Argument (this is the load-bearing ruling of B-1):

1. **The row already exists and was validated when it was booked.** Today's order
   is `_validate_category` → `_validate_receipt` → `_get_or_create_profile` →
   currency decision table → `_auto_snapshot` → insert. Placing the hit after
   `_validate_category` would let a category archived *since* the original create
   turn a replay into `422 CATEGORY_ARCHIVED` — rejecting a transaction that IS in
   the ledger. The mobile outbox (architecture Decision 5 case 1) treats a
   deterministic 4xx as PARKED and prompts the user to discard and re-add, so the
   user would be told a booked transaction failed, and could double-book it by
   hand. That is exactly the divergence idempotency exists to prevent.
2. **A replay must be a pure read.** Before the hit, today's path performs a WRITE
   (`_get_or_create_profile` self-heals a missing profile with a `flush`) and a
   rate query (`_auto_snapshot` → `lookup_rate`). Neither has any business running
   for a request that creates nothing.
3. **No oracle is opened.** On a hit the body is not consulted at all, so a client
   sending a hit `client_id` alongside a foreign/nonexistent `category_id` gets its
   own stored row — a response that is identical regardless of what the body's
   refs point at, leaking nothing about another user's data. The lookup itself is
   `user_id`-scoped, so a guessed foreign uuid is a miss, indistinguishable from a
   fresh key.
4. **Body-mismatch detection is deliberately NOT implemented.** First write wins.
   The client mints the uuid once at form submit and never mutates a queued item
   (architecture Decision 2 / Q2); detecting a changed body would need a stored
   payload fingerprint (extra column) plus a new error code for a case the client
   contract already forbids. The docstring must state the rule instead.

### 3.3 Shape of the handler

```python
@router.post(
    "",
    response_model=TransactionRead,
    status_code=status.HTTP_201_CREATED,
    responses={**_IDEMPOTENT_REPLAY, **_UNPROCESSABLE},
)
async def create_transaction(
    payload: TransactionCreate,
    response: Response,                      # status override, health.py precedent
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> TransactionRead:
    # Idempotency hit — FIRST, before any validation or write (see §3.2).
    if payload.client_id is not None:
        existing = await _load_by_client_id(session, user.id, payload.client_id)
        if existing is not None:
            response.status_code = status.HTTP_200_OK
            return _serialize(existing)

    ... today's path, unchanged, with `client_id=payload.client_id` added to the
        Transaction(...) constructor ...

    try:
        await session.commit()
    except IntegrityError:
        replayed = await _recover_replay_race(session, user.id, payload.client_id)
        if replayed is None:
            raise                            # not our conflict — 500 as today
        response.status_code = status.HTTP_200_OK
        return _serialize(replayed)
    await session.refresh(tx)
    return _serialize(tx)
```

`Response` is injected as a plain parameter (FastAPI mutates the real response
object) — the exact pattern already used by `routers/health.py::health` for its
declared 503 arm. `response_model=TransactionRead` still owns serialization, so
both arms emit the identical body shape.

Note the `client_id is not None` guard on the lookup: **without it a
NULL-`client_id` create would match an earlier NULL row** (`client_id IS NULL`
semantics differ, but a naive `== None` comparison or a missing guard is the
realistic bug) and silently turn every web create into a replay. Test §5.4 pins
this.

### 3.4 Side effects SKIPPED on a hit — enumerated from the real code

Everything between the hit and `return` in today's body is skipped. Explicitly:

| # | Skipped on a replay hit | Why it matters |
|---|---|---|
| 1 | `_validate_category` (422 `CATEGORY_NOT_FOUND` / `CATEGORY_ARCHIVED`) | §3.2(1) — would reject a booked row |
| 2 | `_validate_receipt` (422 `RECEIPT_NOT_FOUND`) | same class; the link is already stored |
| 3 | `_get_or_create_profile` — a **write** (`session.add(Profile)` + `flush`) | a replay must not write; a later real write self-heals |
| 4 | currency stamping (`payload.currency or base`) and the D5 create decision table, incl. the 422 `BASE_AMOUNT_WITHOUT_CURRENCY` arm | the stored row already carries the stamped currency |
| 5 | `_auto_snapshot` → `lookup_rate` + `convert_minor` | the STORED snapshot is returned; recomputing at today's rate would silently restate history (the export's stored-snapshot rule, same router) |
| 6 | `Transaction(...)` + `session.add(tx)` | the no-duplicate-row invariant itself |
| 7 | the merchant→category learning upsert (`pg_insert(MerchantCategoryMap).on_conflict_do_update`, incl. `updated_at = now()`) | the observable one: a late replay would clobber a category the user manually re-mapped since, and bump `updated_at`. Test §5.5 pins it |
| 8 | `session.commit()` / `session.refresh(tx)` | the hit arm performs **zero** writes |

Unchanged and NOT skipped: authentication (`current_active_user`) — a replay is a
normal authenticated request. `POST /transactions` carries no slowapi limit
(grep-confirmed: no `@limiter.limit` in this router), so there is no rate-limit
interaction to reason about.

### 3.5 The declared 200 arm

```python
#: A replay of a create that already landed (5.5 client_id): the STORED row,
#: nothing created. Declared so the contract — and the generated client — carry
#: both success arms honestly (the health.py 503 precedent).
_IDEMPOTENT_REPLAY: dict[int | str, dict[str, object]] = {
    status.HTTP_200_OK: {
        "model": TransactionRead,
        "description": "Idempotent replay — the existing transaction, not created",
    }
}
```

---

## 4. Race handling — exact mechanics against this project's session management

Facts read, not assumed: `db.get_session` yields a session from
`async_sessionmaker(engine, expire_on_commit=False)` inside `async with`; there is
no autocommit and no explicit `begin()` — SQLAlchemy autobegins on first use and
`create_transaction` owns exactly one `await session.commit()`. No router in this
codebase currently catches `IntegrityError` (grep-confirmed: `IntegrityError`
appears only in tests); `categories.py::_reject_duplicate` is a pure select-first
409 that its own docstring admits is racy ("accepted for a single-user app").
B-1 cannot accept that, because concurrent replays are the *normal* outbox case
(app foreground + reconnect firing the same run twice). So B-1 introduces the
house's first IntegrityError recovery — deliberately, in one place, documented.

Recovery helper (new, next to `_load_by_client_id`):

```python
async def _recover_replay_race(
    session: AsyncSession, user_id: uuid.UUID, client_id: uuid.UUID | None
) -> Transaction | None:
    """Post-IntegrityError re-select; None means 'not our conflict — re-raise'."""
```

Mechanics, in order:

1. **No savepoint / nested transaction is needed.** The failure surfaces on
   `commit()`, which leaves the session in a rolled-back-pending state; the fix is
   `await session.rollback()`, after which the session is fully usable and the next
   statement autobegins a NEW transaction. (A `begin_nested()` savepoint would be
   required only to keep *earlier* work in the same transaction — here there is no
   earlier work worth keeping: the profile self-heal and the merchant upsert were
   both already performed, identically, by the request that won the race.)
2. Re-select via `_load_by_client_id` on the fresh transaction. Under READ
   COMMITTED the winner is guaranteed committed by the time the duplicate-key
   error is raised (Postgres blocks the conflicting INSERT on the index until the
   other transaction resolves), so a hit here is the expected outcome.
3. **Never swallow a foreign IntegrityError.** `client_id is None` ⇒ return `None`
   immediately (a NULL-key create can never violate this index; whatever failed is
   a different constraint). A miss on the re-select ⇒ also `None`. The caller then
   re-raises the original exception with a bare `raise`, preserving today's
   behaviour for unrelated integrity failures. Deciding by re-select rather than by
   sniffing `exc.orig.constraint_name` is deliberate: the asyncpg-through-SQLAlchemy
   wrapping of the constraint name is driver-plumbing we would be guessing at, while
   "is the idempotent row there now?" is the question we actually care about.
4. Log the recovery once with context before returning it —
   `logger = logging.getLogger(__name__)` at module level (house pattern:
   `routers/receipts.py`, `routers/health.py`; this router has no logger yet), e.g.
   `logger.info("idempotent replay recovered from insert race user=%s", user_id)`.
   No `print`, and the log must not carry the amount or the note.
5. Accepted, documented edge: if the losing request self-healed a missing profile
   in the same transaction, the rollback discards it. Harmless — the winner's
   transaction created that same profile row, or the next write self-heals again.

---

## 5. Test plan (pytest)

**Placement:** a new file `apps/api/tests/test_transaction_idempotency.py`,
following the `test_merchant_learning.py` precedent (a feature layered on the
transactions router gets its own file, docstring stating exactly what it does and
does not cover). Reuse that file's local `_register_and_login` / `_create_category`
/ `_post_tx` helper shape — the house keeps these per-file rather than in
`conftest.py`; `conftest.py` gains nothing. Class-based, real Postgres, no mocks
except §5.7. Pure-Pydantic rejections (malformed uuid) are QA-curl-owned, not
pytest — matching the transactions-router split.

Exactly seven tests; each one contrasts a behaviour that a plausible
implementation gets wrong:

1. **`test_replay_returns_200_with_the_stored_row`** — POST with `client_id` X
   ⇒ 201; POST the identical body again ⇒ 200 and `resp.json()` **equal to the
   first response's json** (same `id`, same `created_at`); `SELECT count(*)` over
   the user's transactions == 1. Contrast: a missing lookup ⇒ two rows / new id.
2. **`test_replay_ignores_a_changed_body`** — same `client_id`, second POST with a
   different `amount_minor` (and `note`) ⇒ 200 carrying the **original** values,
   and the stored row is unchanged. Contrast: an "upsert on replay" implementation
   would rewrite the row; pins the first-write-wins ruling (§3.2(4)).
3. **`test_same_client_id_for_two_users_creates_two_rows`** — users A and B POST
   the same uuid ⇒ both 201, two distinct ids, one row each. Contrast: a
   globally-unique index or an unscoped lookup would 500 / cross-user 200 — this
   is the security assertion of B-1.
4. **`test_creates_without_client_id_are_never_deduplicated`** — two identical
   bodies with no `client_id` ⇒ two 201s, two rows. Contrast: the missing
   `is not None` guard of §3.3 would make the second a 200 replay and silently
   break every web create.
5. **`test_replay_does_not_relearn_the_merchant_map`** — create with merchant M +
   category A under `client_id` X (map ⇒ A); create with merchant M + category B
   under a different `client_id` (map ⇒ B — the existing override-wins path);
   replay X ⇒ 200 and the map still points at **B** with an unchanged
   `updated_at`. Contrast: running the learning upsert on the hit flips the map
   back to A — skip-list item 7, and the only side effect with a user-visible
   consequence.
6. **`test_replay_after_the_category_was_archived_still_returns_200`** — create
   with category C under `client_id` X; archive C via `PATCH /categories/{id}`;
   replay X ⇒ 200 with the original body (NOT 422 `CATEGORY_ARCHIVED`). Contrast:
   this is precisely the assertion that fails if the hit is placed after
   `_validate_category` — it pins the §3.2 ruling into the suite.
7. **`test_concurrent_replays_create_exactly_one_row`** — `asyncio.gather` of two
   identical POSTs on the same client (the ASGI transport + asyncpg pool give each
   request its own session and connection, so this is genuine DB concurrency).
   Assert: both responses successful, statuses are exactly one 201 and one 200, the
   two bodies carry the same `id`, and `count == 1`. **Honesty note for the
   report:** this test proves the *invariant* under real concurrency but does NOT
   deterministically exercise the IntegrityError arm — the loser may simply
   observe the committed row in its select-first. It is the end-to-end guard; §5.7
   is the arm-specific one.

**§5.7 — the IntegrityError recovery arm, deterministically.** The window between
select-first and insert cannot be scheduled from a test. Cover it with a single
`@patch` of `budget_api.routers.transactions._load_by_client_id` whose
`side_effect` returns `None` on the first call and delegates to the real helper
afterwards, with the row already created by a prior POST: the handler then reaches
the INSERT against an existing key, hits the unique index, and must return 200
with the stored row and leave `count == 1`. This is the documented rare exception
to "never mock internals" (it simulates a scheduling window, not behaviour); the
reason goes in a comment on the test. Rolled into test 7's class as
`test_insert_race_recovers_and_returns_the_existing_row`.

**Not written, deliberately:** no test that `TransactionRead` lacks `client_id`
(a Pydantic model shape, vacuous); no test that the column/index exist (migrations
+ `alembic check`, per the house rule in `test_receipts_model.py`); no re-test of
today's create semantics (`test_transactions.py` owns them — test 4 is the only
no-`client_id` assertion added, and it exists to pin the new guard).

**Existing suite:** `tests/test_openapi_export.py` will fail until the contract is
regenerated (§6). That is the intended signal, not a new test.

---

## 6. Contract + client regeneration

- The 200 arm reaches the schema purely from the route decorator (`responses`),
  never from a hand edit of `openapi.json` — the O-8 rule from
  `.tasks/stats-advisor/plan.md`.
- Regenerate BOTH artifacts with one command from the repo root: **`pnpm openapi`**
  (turbo → `@budget/api#openapi` writes `apps/api/openapi.json`, then
  `packages/api-client/scripts/generate.mjs` writes
  `packages/api-client/src/generated/schema.d.ts`). Commit both WITH the code.
- Verify by eye in `openapi.json` that `POST /transactions` now carries **both** a
  201 and a 200 arm, each `$ref`-ing `TransactionRead`, that `TransactionCreate`
  gained an optional nullable `client_id` (`format: uuid`), and that
  `TransactionRead` did **not**. Paste that fragment in the implementation report.
- Acceptance: re-running `pnpm openapi` after the commit produces a ZERO diff
  (`git status --porcelain apps/api/openapi.json
  packages/api-client/src/generated/schema.d.ts` empty).
- **Web is untouched.** `client_id` is optional on the generated
  `TransactionCreate` type, so no web call site needs a change and no web file is
  edited in B-1. The generated union now types the POST response as 200|200-ish
  arms of the same model — both are `TransactionRead`, so callers that read
  `data` are unaffected; if `openapi-fetch`'s generated types surface a narrowed
  success union that breaks `pnpm typecheck` in `apps/web`, that is the ONE
  discovery that would justify touching web — stop and tell senior-lead rather
  than reshaping the contract.

---

## 7. Rollout / sequencing

- Implementation is sequenced **after `recurring-and-limits`**. Assign the
  revision id and `down_revision` from `uv run alembic heads` at implement time;
  do not carry a number from this document.
- No data migration, no backfill: every pre-existing row keeps `client_id = NULL`
  and is exempt from the partial index. The column is additive and nullable, so an
  older API instance running against the migrated schema is unaffected — the
  migration can be applied before the code ships.
- Downgrade drops index then column, symmetric with `0004`/`0005`.
- Deploy order irrelevant in both directions; the mobile client only starts
  sending `client_id` at M-4, which depends on B-1.

---

## 8. Open questions

- **Q1 (architecture, PM-owned): 200 vs always-201 on a replay.** This plan
  implements 200 per the architecture's recommendation. If PM rules 201, the only
  deltas are the dropped `_IDEMPOTENT_REPLAY` arm, the dropped `response` injection,
  and the status assertions in tests 1/2/6/7 — no structural change.
- **Index name spelling** (`uq_transactions_user_id_client_id` here vs the
  architecture's illustrative `uq_transactions_user_client`). Flagging, not asking:
  the longer form matches the house convention. Say the word to revert.
- Nothing else is open; §3.2 and §4 resolve the two choices the architecture left
  to the implementer.

## 9. Risks

- **Partial-index drift in `alembic check`** (§2.3) — the single most likely
  friction point. Resolve by matching the expression form, never by suppressing.
- **Wrong hit placement** silently reintroduces the 422-on-replay bug; test 6 is
  the only thing standing between the ruling and a regression — do not weaken it.
- **Over-broad `except IntegrityError`** would convert an unrelated constraint
  failure into a bogus 200. The `None`-means-re-raise contract in §4(3) is
  mandatory, and the `client_id is None` early-out is part of it.
- **Missing `is not None` guard on the lookup** turns every web create into a
  replay of the first-ever NULL row — catastrophic and quiet; test 4 pins it.
- **Contract regen forgotten** ⇒ `test_openapi_export` fails loudly. Good failure
  mode; no mitigation needed beyond running `pnpm openapi`.
- Replay ignores a changed body by design (§3.2(4)); if a future client ever
  reuses a key for different data it will get the old row back. Documented in the
  schema docstring — the client contract must keep keys single-use.

---

## 10. Obligations checklist (implementer ticks each)

| # | Obligation | Evidence |
|---|---|---|
| O-1 | `TransactionCreate.client_id: uuid.UUID \| None = None` added; `TransactionRead` and `TransactionUpdate` untouched | diff |
| O-2 | Model column + partial unique index `uq_transactions_user_id_client_id`; migration numbered from `alembic heads` at implement time, additive, symmetric downgrade | diff |
| O-3 | `uv run alembic check` clean (no phantom partial-index drift) | command output in report |
| O-4 | Idempotency lookup is the FIRST statement of `create_transaction`, guarded by `client_id is not None`, ahead of `_validate_category` | diff + test 6 |
| O-5 | All eight skip-list items (§3.4) genuinely skipped on a hit — zero writes on the replay path | diff + test 5 |
| O-6 | IntegrityError recovery: `rollback` → re-select → 200, with bare `raise` on `None`; module logger, no `print` | diff + §5.7 test |
| O-7 | Miss path byte-identical to today for callers with no `client_id` (201, same body, same side effects) | diff + test 4 |
| O-8 | 200 arm declared on the route; `openapi.json` shows both 201 and 200 arms with `TransactionRead`; `client_id` absent from `TransactionRead` | schema fragment pasted in report |
| O-9 | `pnpm openapi` run; both artifacts committed; re-run gives zero diff | `git status --porcelain` line pasted |
| O-10 | Exactly the seven tests of §5 (+§5.7 arm) — no extras without telling senior-lead why | test file |
| O-11 | Full `uv run pytest` green in `apps/api` (`pnpm --filter @budget/api test`) | command output |
| O-12 | Test 7's probabilistic-coverage honesty note repeated in the implementation report | report |
| O-13 | No web file edited; if `pnpm typecheck` fails in `apps/web` from the response-union change, STOP and escalate | report |
| O-14 | Self-review via `/review-pr` if this subtask runs without a formal code-reviewer stage (it is FULL tier — expect the reviewer instead) | report |
