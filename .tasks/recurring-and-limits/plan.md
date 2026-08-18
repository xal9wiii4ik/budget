# Implementation Plan (backend): recurring-and-limits (roadmap 5.3 + 5.4)

Scope-grooming plan. Structured **by subtask**, each sized for one engineer run,
with explicit dependencies. Nothing is implemented in this run. Architecture
decisions are cited as **Dn** (architecture.md), senior-lead amendments as
**SL-A/B/C**; every code claim below was verified against the working tree
(files cited inline). Web (plan-web.md) and mobile (FROZEN) are not mine.

**Order:** B1a → B1b → B2 → B3. Strictly sequential. B1b needs B1a's DDL/domain;
B2 needs B1b's `auto_snapshot` + the job (its attribution tests call
`materialize_due`); B2 and B3 each end in a contract regen and two regens must
never race on `openapi.json` (the receipts §5 argument, reused at
currencies-goals and stats-advisor).

## Approach

Four subtasks, bottom-up. **B1a** is structure with no runtime behaviour:
migration `0006`, the two new models + the `transactions.recurring_template_id`
column, `RecurrenceUnit`, and the pure `domain/recurrence.py` due-date math with
its unit tests. **B1b** is runtime with no DDL: the `auto_snapshot` extraction to
`services/fx_lookup.py` (+ the `routers/transactions.py` refactor onto it), the
materialization job `services/recurring_jobs.py`, the three settings, and the
`app.py` lifespan rewire (OR-gate + second cron + unconditional boot run-now).
**B2** is the `/recurring` CRUD, the additive `TransactionRead.
recurring_template_id`, and regen #1. **B3** is `/limits` (PUT upsert / DELETE /
GET ?month=) and regen #2.

**Why B1 is split (senior-lead invited the argument — see OQ-3).** The merged B1
is one migration + three model changes + a pure domain module + a shipped-router
refactor + a scheduler rewire + a new job carrying the whole idempotency/atomicity
story + ~18 tests. That is two distinct review surfaces: "is the schema right"
(irreversible once migrated, guarded by `alembic check` and CHECK-constraint
tests) and "is the runtime right" (watermark, atomicity, snapshot date, gates —
guarded by behavioural tests). A reviewer reading them in one diff reads neither
well, and the domain math would be co-designed with its only consumer instead of
being pinned first. Cost: one extra run and one extra diff gate. Merged is still
viable if the senior-lead prefers throughput — the file lists below concatenate
cleanly, no test moves.

**Cross-cutting rules reused everywhere:** ONE conversion resolution codebase-wide
(`services/fx_lookup.auto_snapshot` after B1b — the tx_totals invariant); minor
units end-to-end; snapshot honesty (`NULL/NULL`, never a guessed rate); no-oracle
user scoping on every new query; `model_fields_set` PATCH discipline; every new
error a stable UPPER_SNAKE code in `{"detail": ...}`.

**Actual project commands** (there is no `make` in this repo — verified: no
Makefile at the root or in `apps/api`):

- tests: `cd apps/api && uv run pytest`
- lint: `pnpm --filter @budget/api lint` (= `ruff check . && ruff format --check .`)
- types: `pnpm --filter @budget/api typecheck` (= `pyright`, strict)
- migration gate: `cd apps/api && uv run alembic upgrade head && uv run alembic check`
  (+ `uv run alembic downgrade -1 && uv run alembic upgrade head` — the conftest
  tears the session down with `downgrade base`, so an asymmetric 0006 breaks the
  whole suite, not just one test)
- contract regen, BOTH artifacts in one command: **`pnpm openapi`** from the repo
  root; commit `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts`
  **in the same commit** as the route change.
- client gates after a regen: `pnpm --filter @budget/api-client typecheck` and
  `pnpm --filter @budget/api-client test`.

---

# Standing infrastructure (applies to EVERY subtask — not repeated below)

- **Postgres on 5443** via `TEST_DATABASE_URL`; API on 8010 for /test (QA-owned).
- **`FX_SCHEDULER_ENABLED=false` AND `RECURRING_SCHEDULER_ENABLED=false`** on test
  servers. In pytest, `recurring_scheduler_enabled=False` must be forced at EVERY
  app-construction site, not just `conftest.make_client` — verified there are
  four: `tests/conftest.py:153`, `tests/test_receipts.py:196`,
  `tests/test_advisor.py:105`, `tests/test_health.py:30` (the last one builds an
  app against an intentionally DEAD database; a boot run-now materialization job
  there would fire against it). See O-3.
- **Full lint gate on every fix round**, not just at the end: `ruff check .` +
  `ruff format --check .` + `pyright` (strict) + `uv run pytest`. Green pytest
  with red pyright is not a passing subtask.
- **Root-file ownership**: `PLAN.md`, `README.md`, `budget-app-architecture.md`,
  `docker-compose.yml`, `.env*`, `turbo.json` are NOT mine → stop and escalate.
- **`pyproject.toml` dependencies: no delta.** `apscheduler` (3.x, pinned <4),
  SQLAlchemy, Pydantic already present; `calendar`/`datetime` are stdlib.
- **No new index anywhere** without a written D13-style verdict (O-5).
- The task brief's polish-backlog items (network-unreachable alert, modal
  backdrop confirm, ru double-terminator) are **web-only** — no backend surface,
  not planned here (D1 agrees).

---

# B1a — DDL + models + pure recurrence math (tier proposal: **FULL**)

**Depends on:** — · **Contract-touching:** NO (no route, no DTO; `pnpm openapi`
must produce a ZERO diff — that is itself an acceptance check)

## Files

New:
- `apps/api/alembic/versions/0006_recurring_templates_and_limits.py` — ALL scope
  DDL (D19): `recurring_templates`, `category_limits`,
  `transactions.recurring_template_id` (+FK). Symmetric downgrade, `op.f()` names
  (the 0005 construction).
- `apps/api/src/budget_api/models/recurring_template.py` — `RecurringTemplate` (D2).
- `apps/api/src/budget_api/models/category_limit.py` — `CategoryLimit` (D14).
- `apps/api/src/budget_api/domain/recurrence.py` — pure due-date math (D3).
- `apps/api/tests/test_recurrence.py` — pure unit tests (no DB, no fixtures).
- `apps/api/tests/test_recurring_model.py` — the DDL CHECK arms (the
  `tests/test_receipts_model.py` precedent).

Modified:
- `apps/api/src/budget_api/enums.py` — `+RecurrenceUnit` (D1/D3), with the
  definition-order-is-load-bearing comment convention (`month`, `week`).
- `apps/api/src/budget_api/models/transaction.py` — `+recurring_template_id`
  (D7, the exact `receipt_id` construction).
- `apps/api/src/budget_api/models/__init__.py` — export both new models (alembic
  autogenerate sees only what this package imports).

## `enums.py`

```python
class RecurrenceUnit(StrEnum):
    # Definition order (month, week) is load-bearing: models/recurring_template.py
    # rebuilds its interval_unit CHECK from this iteration order and must emit SQL
    # byte-identical to migration 0006 (interval_unit IN ('month', 'week')).
    month = "month"
    week = "week"
```

## `models/recurring_template.py` (D2 verbatim, CHECK names spelled out)

```python
class RecurringTemplate(Base):
    __tablename__ = "recurring_templates"
    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="amount_minor_positive"),
        CheckConstraint(f"kind IN ({_KIND_VALUES})", name="kind_valid"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
        CheckConstraint(f"interval_unit IN ({_UNIT_VALUES})", name="interval_unit_valid"),
        CheckConstraint("day_of_month BETWEEN 1 AND 31", name="day_of_month_range"),
        CheckConstraint("weekday BETWEEN 0 AND 6", name="weekday_range"),
        # Both-or-neither, per unit: an inconsistent pair is UNREPRESENTABLE, not
        # review-guarded (the base_snapshot_pair style).
        CheckConstraint(
            "(interval_unit = 'month') = (day_of_month IS NOT NULL) "
            "AND (interval_unit = 'week') = (weekday IS NOT NULL)",
            name="anchor_matches_unit",
        ),
    )
    id, user_id (FK users CASCADE, index=True), name String(100),
    amount_minor BigInteger, kind String(16), currency String(3),
    category_id (FK categories SET NULL, nullable), merchant String(255) | None,
    note Text | None, interval_unit String(8), day_of_month SmallInteger | None,
    weekday SmallInteger | None, end_date Date | None,
    paused Boolean default False server_default false(),
    last_materialized_on Date NOT NULL,          # D6 watermark, never on the wire
    created_at DateTime(timezone=True) server_default now()
```

`_KIND_VALUES` / `_UNIT_VALUES` are rebuilt from `TransactionKind` /
`RecurrenceUnit` exactly as `models/transaction.py` does, so the enum stays the
one source and `alembic check` guards drift.

## `models/category_limit.py` (D14)

```python
class CategoryLimit(Base):
    __tablename__ = "category_limits"
    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="amount_minor_positive"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
    )
    user_id      = FK users.id CASCADE, primary_key=True     # composite natural PK
    category_id  = FK categories.id CASCADE, primary_key=True # = the upsert conflict target
    amount_minor BigInteger; currency String(3)
    created_at / updated_at DateTime(timezone=True) server_default now()
```

No surrogate id (the `profiles` / `merchant_category_map` precedent); the PK's
leading `user_id` covers the list-by-user read, so no secondary index (D13/O-5).

## `models/transaction.py`

```python
recurring_template_id: Mapped[uuid.UUID | None] = mapped_column(
    Uuid, ForeignKey("recurring_templates.id", ondelete="SET NULL"), nullable=True
)
```

Pure ADD COLUMN, no backfill: every existing row is correctly "not from a
template" as NULL (D19). No index (D13).

## `domain/recurrence.py` (PURE — stdlib `calendar`/`datetime` + `budget_api.enums`)

```python
#: Safety valve (D6): a pathological clock jump or a years-forgotten weekly
#: template mass-inserts at most this many rows per template per run; the
#: watermark advances only through what was inserted, so the remainder arrives on
#: subsequent runs. A module constant, not a Settings knob — no one tunes this.
MAX_OCCURRENCES = 366

def monthly_due(year: int, month: int, day_of_month: int) -> date
    """min(day_of_month, days_in(month)) — day 31 clamps to Feb 28/29, Apr 30 (D3)."""

def next_due(unit: RecurrenceUnit, *, day_of_month: int | None,
             weekday: int | None, after: date) -> date
    """The first due date STRICTLY after ``after``. Never skips, never rolls over.

    weekly: delta = (weekday - after.weekday()) % 7 or 7  -> after + delta days.
    ``weekday`` is 0=Monday (== date.weekday() == isoweekday() - 1).
    """

def due_dates_between(unit: RecurrenceUnit, *, day_of_month: int | None,
                      weekday: int | None, after: date, through: date,
                      limit: int = MAX_OCCURRENCES) -> list[date]
    """Ascending due dates in the HALF-OPEN-LEFT window ``(after, through]``.

    Empty when ``through <= after`` (an ended or already-caught-up template).
    Truncated at ``limit`` — the caller (the job) logs when the cap is hit.
    """
```

The anchor for the unit is guaranteed non-NULL by the DB CHECK and the schema
validators; a `None` anchor for its own unit is a `ValueError` (programming
error, not a user path) — pinned by a domain test arm.

**Layering note (recorded refinement, see Disagreement 3):** `domain/recurrence.py`
imports `budget_api.enums` — a top-level module with ZERO internal imports and
stdlib-only content, so no cycle is possible and the domain stays framework-free.
D1 put `RecurrenceUnit` in `enums.py` precisely so models and schemas can share
it; the alternative (define it in `domain/` like `PeriodUnit`) would make
`models/` import `domain/`, a strictly heavier new edge.

## Migration `0006` (D19)

One migration, three DDL items, symmetric downgrade. `alembic check` after
`upgrade head` must report no autogenerate diff (O-2).

## Tests (B1a)

`tests/test_recurrence.py` (pure, no DB):

1. `test_monthly_day_clamps_to_short_months` — parametrized `day_of_month=31`
   across Jan (→31), Feb 2026 (→28), **Feb 2028 (→29, leap)**, Apr (→30), plus
   `day_of_month=15` in Feb (→15, the no-clamp contrast). The leap arm and the
   non-clamping arm are what make it non-vacuous.
2. `test_next_due_is_strictly_after_the_anchor` — monthly `dom=15`:
   `after=2026-03-15` → `2026-04-15` (NOT the same day), `after=2026-03-14` →
   `2026-03-15`. Two arms in one test: this is the whole watermark contract
   (`(last_materialized_on, ...]`), and an `>=` bug passes the second arm alone.
3. `test_weekly_weekday_is_monday_zero_and_strictly_after` — parametrized
   `weekday=0..6` from a fixed Wednesday: asserts `result.weekday() == weekday`
   **and** `result.isoweekday() - 1 == weekday` (the off-by-one pin, both
   spellings), and that `weekday == after.weekday()` yields `after + 7 days`.
4. `test_due_dates_between_catch_up_window` — monthly `dom=1`,
   `after=2025-12-15`, `through=2026-03-10` → exactly `[2026-01-01, 2026-02-01,
   2026-03-01]`, ascending, each once. Contrast arms in the same test:
   `through=2026-03-01` (exactly ON a due date) still includes it;
   `through=2026-02-28` excludes March.
5. `test_due_dates_between_is_capped_and_resumable` — weekly template over a
   3-year window → exactly `MAX_OCCURRENCES` dates, first == the first due after
   `after`; re-enumerating from the returned last date yields the NEXT dates
   (nothing is dropped). Contrast: a 4-week window returns 4, so the cap is not
   a constant-length answer.
6. `test_empty_window_yields_no_dates` — `through <= after` → `[]` (monthly and
   weekly arms): the "already caught up" and "ended before the watermark" paths.
7. `test_missing_anchor_for_its_unit_raises` — `unit=month, day_of_month=None`
   and `unit=week, weekday=None` → `ValueError`; the matching pairs return a
   date. Pins the domain's precondition that the DB CHECK enforces.

`tests/test_recurring_model.py` (real DB, direct session):

8. `test_anchor_must_match_unit` — three arms via `db_session`:
   `unit='month', weekday=3, day_of_month=NULL` → `IntegrityError`;
   `unit='month', day_of_month=NULL` → `IntegrityError`;
   `unit='month', day_of_month=15` → row persists (the accept contrast, without
   which both rejections could pass against a CHECK of `false`). The DDL is what
   makes an inconsistent pair unrepresentable, and the job/domain rely on it.

*(No column-existence tests, no `category_limits` DDL test: its PK is exercised
as the ON CONFLICT target by B3's upsert tests, which is the real failure mode.)*

## Gates (B1a)

`alembic upgrade head && alembic check` (paste output, O-2) + the downgrade
round-trip; full lint gate; `pnpm openapi` → **zero diff** (O-1 negative arm).

---

# B1b — auto_snapshot extraction + materialization job + scheduler wiring (tier proposal: **FULL**)

**Depends on:** B1a · **Contract-touching:** NO (services/config/app only; the
`pnpm openapi` diff must be zero)

## Files

New:
- `apps/api/src/budget_api/services/recurring_jobs.py` — `materialize_due` (D5/D6).
- `apps/api/tests/test_recurring_jobs.py` — job behaviour against a real DB.
- `apps/api/tests/test_scheduler_wiring.py` — the lifespan gate combinations.

Modified:
- `apps/api/src/budget_api/services/fx_lookup.py` — **+`auto_snapshot`** (D8),
  moved verbatim from `routers/transactions._auto_snapshot` (body byte-identical,
  docstring rehomed).
- `apps/api/src/budget_api/routers/transactions.py` — delete `_auto_snapshot`,
  import `auto_snapshot`; three call sites (create + the two PATCH arms) change
  name only. Existing `tests/test_transactions.py` snapshot suite is the guard,
  untouched (O-6).
- `apps/api/src/budget_api/config.py` — three defaulted settings (below).
- `apps/api/src/budget_api/app.py` — scheduler OR-gate, the recurring cron, the
  unconditional boot run-now, teardown unchanged.
- `apps/api/tests/conftest.py`, `tests/test_receipts.py`, `tests/test_advisor.py`,
  `tests/test_health.py` — force `recurring_scheduler_enabled=False` (O-3).

## Settings (config.py house rule: every field defaulted, no new env at any explicit `Settings(...)` site)

```python
# Recurring materialization (D5). Same gate construction as fx_scheduler_enabled:
# the whole pytest suite constructs apps with it False, test servers run
# RECURRING_SCHEDULER_ENABLED=false, and the job function is exercised by direct
# call — never via a live scheduler.
recurring_scheduler_enabled: bool = True
# Daily cron just after the UTC date rolls over, so a row due "today" exists
# before any user wakes up. (fx runs 17:30 UTC for provider-publication reasons
# that do not apply to a local-only job.)
recurring_materialize_hour_utc: int = 0
recurring_materialize_minute_utc: int = 30
```

## `services/recurring_jobs.py`

```python
async def materialize_due(
    sessionmaker: async_sessionmaker[AsyncSession], *, today: date | None = None
) -> None:
    """Materialize every due occurrence of every live template. NEVER raises (D5).

    ``today`` defaults to ``datetime.now(UTC).date()`` and is a parameter ONLY for
    tests. It is deliberately NOT bound in the scheduler's job kwargs: kwargs are
    frozen at schedule time, so a bound ``today`` would freeze the job's idea of
    the date until the next process restart (the fx job computes its own ``today``
    for the same reason).
    """
```

Shape (decided, not latitude):

1. **One short probe session**, ids only:
   `SELECT id FROM recurring_templates WHERE NOT paused AND last_materialized_on < :today AND (end_date IS NULL OR end_date > last_materialized_on)` —
   the ended-template clause keeps forever-ended rows out of the loop for free
   (no index, D13: tens of rows, once a day). The session is CLOSED before the
   per-template work (the fx no-session-across-work discipline).
2. **Per template, its own session and its own commit** (D6 — the atomicity unit):

```python
for template_id in ids:
    try:
        async with sessionmaker() as session:
            tpl = await session.scalar(
                select(RecurringTemplate)
                .where(RecurringTemplate.id == template_id)
                .with_for_update()          # see Disagreement 2
            )
            if tpl is None or tpl.paused:
                continue                     # deleted/paused between probe and lock
            through = tpl.end_date if tpl.end_date and tpl.end_date < today else today
            dates = due_dates_between(
                RecurrenceUnit(tpl.interval_unit),
                day_of_month=tpl.day_of_month, weekday=tpl.weekday,
                after=tpl.last_materialized_on, through=through,
            )
            if not dates:
                continue                     # watermark advances ONLY to a materialized date
            base = await read_base_currency(session, tpl.user_id)   # read-only, never self-heals
            for due in dates:
                base_amount_minor, base_currency = (
                    (None, None) if tpl.currency == base
                    else await auto_snapshot(session, tpl.amount_minor, tpl.currency, base, due)
                )
                session.add(Transaction(..., occurred_at=due,
                                        recurring_template_id=tpl.id, receipt_id=None))
            tpl.last_materialized_on = dates[-1]
            if len(dates) == MAX_OCCURRENCES:
                logger.warning("recurring: template %s capped at %s dates", tpl.id, MAX_OCCURRENCES)
            await session.commit()           # inserts + watermark: ONE transaction
    except Exception as exc:                 # deliberately broad, PER TEMPLATE (the fx per-provider argument)
        logger.warning("recurring materialization failed for %s: %r", template_id, exc)
```

Copied by value (D7): `amount_minor, kind, currency, category_id, note,
merchant`; `occurred_at = due`; `receipt_id = NULL`. Category is stamped AS
STORED even if archived (D11). No `merchant_category_map` learning (D8). No
notification of any kind (D9 — 5.2 is out of scope).

## `services/fx_lookup.auto_snapshot` (D8 — the extraction)

```python
async def auto_snapshot(
    session: AsyncSession, amount_minor: int, currency: str, base: str, on_date: date
) -> tuple[int | None, str | None]:
    """Base-currency snapshot pair, or (None, None) on a rate miss."""
```

Body moved verbatim (`lookup_rate` + `convert_minor`). `fx_lookup` already owns
rate resolution, so this keeps ONE conversion-resolution site codebase-wide. The
job calls it with `on_date = the DUE date` — never the run date (D8): during a
catch-up the fx table already holds the historical rows.

## `app.py` lifespan (D5)

```python
scheduler: AsyncIOScheduler | None = None
if resolved.fx_scheduler_enabled or resolved.recurring_scheduler_enabled:
    scheduler = AsyncIOScheduler()
    if resolved.fx_scheduler_enabled:
        ...unchanged fx cron + probe-then-maybe-schedule catch-up...
    if resolved.recurring_scheduler_enabled:
        recurring_kwargs: dict[str, Any] = {"sessionmaker": app.state.sessionmaker}
        scheduler.add_job(materialize_due, CronTrigger(hour=..., minute=..., timezone="UTC"),
                          kwargs=recurring_kwargs, misfire_grace_time=3600, coalesce=True)
        # UNCONDITIONAL boot catch-up (D5): no probe — any probe would run the same
        # tiny query the job itself starts with, and the job never raises.
        scheduler.add_job(materialize_due, next_run_time=datetime.now(UTC),
                          kwargs=recurring_kwargs, misfire_grace_time=None)
    scheduler.start()
```

Teardown unchanged (`shutdown(wait=False)` before `engine.dispose()`).

## Tests (B1b)

`tests/test_recurring_jobs.py` — real Postgres, own sessionmaker (the
`tests/test_fx_jobs.py::fx_sessionmaker` fixture construction), job called
directly with an explicit `today`. No app, no scheduler.

1. `test_catch_up_materializes_each_missed_date_once` — monthly `dom=1`,
   watermark 2.5 months back → exactly 3 rows with `occurred_at` = the 3 due
   dates, every copied field equal to the template's (amount/kind/currency/
   category/note/merchant), `recurring_template_id` set, `receipt_id` NULL,
   watermark == the last due date.
2. `test_second_run_is_a_no_op` — running (1) again on the same `today` adds no
   rows and does not move the watermark (the watermark IS the idempotency
   mechanism, D6).
3. `test_paused_template_is_skipped_and_watermark_frozen` — a paused template
   with pending due dates produces nothing and keeps its watermark, while an
   unpaused sibling in the SAME run materializes (the contrast is what proves the
   run happened at all).
4. `test_end_date_boundary` — `end_date` set exactly ON a due date: that date
   materializes, the next one does not, watermark == `end_date`; a later run
   after `end_date` adds nothing.
5. `test_snapshot_uses_the_due_date_rate_not_the_run_date` — foreign-currency
   template, USD→RUB rates seeded with DIFFERENT values on the due date and on
   the (later) run date → `base_amount_minor` equals the DUE-date conversion.
   Contrast arms in the same class: no rate at or before the due date →
   `NULL/NULL`; a base-currency template → `NULL/NULL` (never a self-copy).
6. `test_snapshot_uses_each_owners_base_currency` — two users, same template
   currency, different profile base currencies → two different snapshot pairs,
   each row under its own `user_id`. (A `read_base_currency(session, wrong_user)`
   bug is invisible in a single-user fixture.)
7. `test_archived_category_still_materializes` — the category is archived AFTER
   template creation → the row is stamped with the stored `category_id`, not NULL
   (D11), and the template is not paused as a side effect.
8. `test_cap_truncates_and_resumes` — weekly template with a 3-year-old watermark
   → exactly `MAX_OCCURRENCES` rows in run 1, watermark == the 366th date; a
   second run continues from there and adds the next batch. Pins "capped, not
   dropped".
9. `test_failure_mid_batch_rolls_back_that_template_only` — **crash-atomicity
   pin.** `@patch("budget_api.services.recurring_jobs.auto_snapshot")` with a
   `side_effect` that raises on the 3rd call, against two templates (A base-
   currency so it commits; B foreign with 4 due dates): after the run, A's rows
   and watermark are committed, B has ZERO rows and an UNCHANGED watermark, and
   `materialize_due` did not raise. Then un-patch, re-run: B's 4 dates
   materialize exactly once each. *Internal mocking is deliberate here and
   documented in the test:* an injected fault is the only way to reach the
   mid-batch rollback path, and it is the one property the whole no-UNIQUE-
   backstop design rests on.
10. `test_template_deleted_between_probe_and_lock_is_skipped` — delete the row
    after seeding but before the run (via a second session), run the job → no
    rows, no exception. Guards the `tpl is None` branch that the two-phase
    (probe, then lock) shape introduces. *(Cheap; the alternative is a 500-class
    crash in a job that must never raise.)*

`tests/test_scheduler_wiring.py` — the ONE place a pytest app may start a
scheduler (see OQ-2; the job is DB-local, never raises, and runs against a
template-free DB):

11. `test_scheduler_gate_combinations` — parametrized over
    (fx, recurring) ∈ {(F,F), (T,F), (F,T), (T,T)}: `app.state.scheduler is None`
    only for (F,F); the recurring cron job is present iff `recurring` is on and
    the fx cron iff `fx` is on (asserted by job func identity). Same test asserts
    the recurring cron's `kwargs.keys() == {"sessionmaker"}` — **no `today` key**
    (a bound `today` would freeze the job's date until restart) — and that its
    trigger is a UTC `CronTrigger` at the configured hour/minute with
    `misfire_grace_time=3600`.

**No new tests for the `auto_snapshot` extraction** (O-6): the shipped
`tests/test_transactions.py` snapshot suite asserts every arm of the decision
table and is the guard; a new test would re-assert what it proves.

## Gates (B1b)

Full lint gate; `pnpm openapi` → zero diff; `tests/test_transactions.py`
unmodified and green (paste the `git status` line).

---

# B2 — /recurring CRUD + tx attribution (tier proposal: **FULL**)

**Depends on:** B1b · **Contract-touching:** YES (new `/recurring` routes + DTOs
+ the additive `TransactionRead.recurring_template_id` — both ride THIS regen so
the tx-list attribution and the CRUD land as one contract change, D20)

## Files

New:
- `apps/api/src/budget_api/routers/recurring.py`
- `apps/api/src/budget_api/schemas/recurring.py`
- `apps/api/tests/test_recurring_api.py`

Modified:
- `apps/api/src/budget_api/schemas/transaction.py` — `TransactionRead` +
  `recurring_template_id: uuid.UUID | None`; `_clean_merchant` → public
  `clean_merchant` (second consumer fires the rule; the two in-file usages
  follow the rename — the `clean_note` precedent).
- `apps/api/src/budget_api/schemas/goal.py` — `_clean_name` → public `clean_name`
  (second consumer; goal.py stays the definer, exactly as transaction.py stayed
  `clean_note`'s definer).
- `apps/api/src/budget_api/routers/transactions.py` — `_serialize` carries the
  new field. Nothing else.
- `apps/api/src/budget_api/app.py` — mount `recurring.router` at `/recurring`,
  `tags=["recurring"]`, **no** `Depends(prime_rate_limit)` (D1 — the
  categories/fx/goals/stats mount construction; no cost driver).
- `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` — regen.

## `schemas/recurring.py` — exact wire contract

```python
class RecurringTemplateCreate(BaseModel):
    name: str                                        # clean_name (trim, 1..100, blank = error)
    amount_minor: int = Field(ge=1, le=MAX_MINOR_AMOUNT)          # D21
    kind: TransactionKind                            # REQUIRED (1.2 sign-authority)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")  # null -> stamp base (D2)
    category_id: uuid.UUID | None = None
    merchant: str | None = None                      # clean_merchant
    note: str | None = None                          # clean_note
    interval_unit: RecurrenceUnit
    day_of_month: int | None = Field(default=None, ge=1, le=31)
    weekday: int | None = Field(default=None, ge=0, le=6)         # 0 = Monday
    end_date: date | None = None
    paused: bool = False

    @model_validator(mode="after")                   # mirrors the DB CHECK (D10)
    def _anchor_matches_unit(self) -> Self: ...      # exactly the matching anchor, the other NULL

class RecurringTemplateUpdate(BaseModel):            # all-optional, model_fields_set discipline
    ... same fields, every one `| None = None` ...

class RecurringTemplateRead(BaseModel):
    id, name, amount_minor, kind, currency, category_id, merchant, note,
    interval_unit: RecurrenceUnit, day_of_month: int | None, weekday: int | None,
    end_date: date | None, paused: bool,
    next_due_on: date | None,          # server-computed; null when paused or ended
    created_at: datetime

class RecurringTemplateList(BaseModel):
    items: list[RecurringTemplateRead]               # goals list-envelope precedent

class RecurringError(BaseModel):
    detail: str
```

`last_materialized_on` stays OFF the wire (D10, lean-DTO rule).

## `routers/recurring.py`

Endpoints (all `async def`, `Depends(current_active_user)` + `Depends(get_session)`,
`responses` = the house `_NOT_FOUND` / anyOf `_UNPROCESSABLE` union copied from
`routers/goals.py`):

| Method | Path | Status | Response |
|---|---|---|---|
| POST | `/recurring` | 201 | `RecurringTemplateRead` |
| GET | `/recurring` | 200 | `RecurringTemplateList` (all, incl. paused/ended; `ORDER BY created_at, id`) |
| PATCH | `/recurring/{id}` | 200 | `RecurringTemplateRead` |
| DELETE | `/recurring/{id}` | 204 | — (hard delete, D7/SL-C) |

Error codes:

| Code | Status | When |
|---|---|---|
| `RECURRING_TEMPLATE_NOT_FOUND` | 404 | path id foreign OR missing (`_load_own`, one code path) |
| `CATEGORY_NOT_FOUND` / `CATEGORY_ARCHIVED` | 422 | body category ref (`load_visible_category`, the tx `_validate_category` path) |
| `NAME_REQUIRED`, `AMOUNT_REQUIRED`, `KIND_REQUIRED`, `CURRENCY_REQUIRED`, `INTERVAL_UNIT_REQUIRED`, `PAUSED_REQUIRED` | 422 | explicit null on a NOT NULL field (house PATCH pattern) |
| `ANCHOR_REQUIRED` | 422 | PATCH leaves the effective unit without its own anchor |
| `ANCHOR_MISMATCH` | 422 | PATCH explicitly sets the OTHER unit's anchor to non-null |

Create-side anchor errors surface as Pydantic `HTTPValidationError` (the payload
alone decides — AM-6 says validate at the boundary); PATCH-side ones are business
codes because they need the STORED row. Both arms are already declared by the
anyOf union, so the client's error handling is unchanged either way.

**Watermark on create (D2/D6):** `last_materialized_on = today_utc - 1 day` — a
template created on its own due day materializes that day at the next run (D9).

**Unpause (SL-A, binding):** on PATCH `paused: true → false`,
`last_materialized_on = max(last_materialized_on, today_utc - 1 day)`. The
unpause DAY is live; everything strictly before stays skipped forever; `max()`
prevents re-materialization after a same-day pause/unpause cycle. Pausing
(`false → true`) touches the watermark not at all.

**Effective-pair validation on PATCH** (the `eff_cur` pattern from the tx PATCH):

```python
eff_unit    = payload.interval_unit if "interval_unit" in fields else tpl.interval_unit
eff_dom     = payload.day_of_month  if "day_of_month"  in fields else tpl.day_of_month
eff_weekday = payload.weekday       if "weekday"       in fields else tpl.weekday
# unit=month: eff_dom required (else ANCHOR_REQUIRED); an explicitly-sent non-null
# weekday is ANCHOR_MISMATCH; a merely-STORED stale weekday is cleared server-side
# (nothing the client sent is silently discarded). Mirror-image for unit=week.
```

**`next_due_on`** (decision, see OQ-1):

```python
def _next_due_on(tpl, *, today) -> date | None:
    if tpl.paused: return None
    nxt = next_due(..., after=max(tpl.last_materialized_on, today - timedelta(days=1)))
    return None if tpl.end_date is not None and nxt > tpl.end_date else nxt
```

The `max(...)` floor means a pending catch-up never renders as a PAST "next"
date; the value is exactly the next date the job will book on or after today.

**`recurring_template_id` is SERVER-MANAGED (SL-B):** present on
`TransactionRead`, absent from `TransactionCreate`/`TransactionUpdate`. No DTO in
this codebase sets `extra="forbid"` (verified: `grep extra= src/budget_api/schemas/`
is empty — only `config.py`'s `SettingsConfigDict`), so Pydantic's default
`extra="ignore"` applies and a client-supplied value on POST/PATCH is **ignored**,
not rejected. That is the house policy and it is what the test pins; making this
one field a 422 would mean turning on `extra="forbid"` for the whole DTO, which
would break every client that sends an unknown field (a contract narrowing far
beyond this scope). Attribution can therefore only ever be set by the job.

## Tests (B2) — `tests/test_recurring_api.py` (real DB; helpers mirrored from `test_stats.py`)

1. `test_create_defaults_and_projection` — currency omitted → stamped with the
   profile base; `paused` false; `last_materialized_on` NOT in the response body;
   `next_due_on` present; the row's stored watermark == today−1 (read via
   `db_session`, since it is deliberately off the wire).
2. `test_create_validation_matrix` — parametrized 422s: `month` without
   `day_of_month`; `month` WITH `weekday`; `week` without `weekday`; `weekday=7`;
   `day_of_month=0`; `day_of_month=32`; `amount_minor=0`; `amount_minor=MAX+1`;
   blank `name`. Accept arms in the same test: `amount_minor=MAX` → 201 and a
   valid `week`+`weekday=6` → 201 (without them every rejection would pass
   against a route that 422s everything).
3. `test_create_category_refs` — foreign/missing `category_id` → 422
   `CATEGORY_NOT_FOUND`; archived → 422 `CATEGORY_ARCHIVED`; own visible → 201.
4. `test_list_is_own_only_and_includes_paused_and_ended` — user B's templates
   absent; a paused one and one with a past `end_date` are both listed (the list
   IS the management screen); order is `created_at, id`.
5. `test_patch_partial_and_required_nulls` — an amount-only PATCH leaves every
   other field intact; parametrized explicit nulls on `name`/`amount_minor`/
   `kind`/`currency`/`interval_unit`/`paused` → the matching `*_REQUIRED` 422;
   explicit null on `end_date` CLEARS it (nullable-clears contrast).
6. `test_patch_unit_switch_rules` — `month → week` with `weekday` supplied → 200,
   `weekday` set and `day_of_month` cleared to null; `month → week` with no
   `weekday` → 422 `ANCHOR_REQUIRED`; `interval_unit` unchanged (`month`) with an
   explicit `weekday` → 422 `ANCHOR_MISMATCH`.
7. `test_next_due_on_semantics` — a template whose `day_of_month` is today's day
   → `next_due_on == today` (created today, not yet materialized); one whose day
   already passed this month → the clamped next month (`dom=31` in a February
   fixture proves the server does the clamping, not the client); paused → null;
   `end_date` in the past → null.
8. `test_unpause_makes_the_unpause_day_live_but_never_backfills` — **SL-A pin.**
   Daily-ish (weekly) template paused across ≥2 due dates; unpause on a day that
   IS a due date; run `materialize_due(today=unpause_day)` → exactly ONE row,
   dated the unpause day; none of the skipped due dates exist.
9. `test_same_day_pause_unpause_does_not_duplicate` — **SL-A `max()` pin.**
   Materialize today's occurrence, then PATCH `paused: true` and immediately
   `paused: false` on the same day, then re-run the job → still exactly one row
   (a bare `= today - 1 day` assignment would rewind the watermark and duplicate
   the day; this arm is the whole reason `max()` is in the rule).
10. `test_delete_keeps_history_and_drops_attribution` — **SL-C pin.**
    Materialize a row, DELETE the template → 204; the transaction still exists
    with every money field intact and `recurring_template_id` NULL; a second
    DELETE of the same id → 404 (and a foreign template's id → the same 404 body,
    no-oracle).
11. `test_transaction_read_carries_attribution` — a materialized row exposes
    `recurring_template_id` in `GET /transactions` and after a PATCH of that row;
    a manually created row exposes `null` (the contrast).
12. `test_client_supplied_template_id_is_ignored` — **SL-B pin.** `POST
    /transactions` with `recurring_template_id` in the body → 201 with `null` in
    the response AND null in the DB; the same on `PATCH` of a materialized row →
    the stored id is unchanged (a client can neither forge nor re-point
    attribution).
13. `test_recurring_requires_auth` — one unauthenticated call per method on the
    new router → 401 (once per router, per the conventions).

## Regen + gates (B2)

`pnpm openapi`; commit both artifacts with the code. **Verification line for the
report:** `schema.d.ts` shows `recurring_template_id?: string | null` on
`TransactionRead` and a `RecurringTemplateRead` with `next_due_on` — anything
mangled is STOP-and-report, never a hand-edit or a client-side cast. Then
`pnpm --filter @budget/api-client typecheck && ... test`; full lint gate.

---

# B3 — /limits (tier proposal: **FULL** — argued; senior-lead decides)

**Depends on:** B1a (the `category_limits` table) — independent of B1b/B2 in
code, sequenced after B2 only to keep the two regens off each other
· **Contract-touching:** YES

## Files

New:
- `apps/api/src/budget_api/routers/limits.py`
- `apps/api/src/budget_api/schemas/limit.py`
- `apps/api/tests/test_limits.py`

Modified:
- `apps/api/src/budget_api/app.py` — mount `limits.router` at `/limits`,
  `tags=["limits"]`, no `prime_rate_limit` (D1).
- `apps/api/openapi.json` + `schema.d.ts` — regen.

**No migration** (0006 already shipped the table in B1a) — if this subtask finds
itself writing `alembic/versions/*`, that is a stop-and-escalate signal.

## `schemas/limit.py`

```python
class LimitUpsert(BaseModel):
    amount_minor: int = Field(ge=1, le=MAX_MINOR_AMOUNT)     # D21

class LimitRead(BaseModel):            # PUT response — no period context, so no spent
    category_id: uuid.UUID
    limit_minor: int
    limit_currency: str                # the STORED stamp (D15)

class LimitItem(BaseModel):
    category_id: uuid.UUID
    limit_minor: int
    limit_currency: str
    spent_minor: int                   # base-currency month expense sum; 0 when no rows

class LimitsRead(BaseModel):
    month: str                         # echoed "YYYY-MM"
    currency: str                      # CURRENT profile base — spent's currency
    items: list[LimitItem]             # ordered by category_id
    unconverted_count: int             # period-level honesty flag

class LimitError(BaseModel):
    detail: str
```

## `routers/limits.py`

| Method | Path | Status | Response | Notes |
|---|---|---|---|---|
| GET | `/limits?month=YYYY-MM` | 200 | `LimitsRead` | `month` optional, default = current UTC month; `Query(pattern=MONTH_PATTERN)` (D16) |
| PUT | `/limits/{category_id}` | 200 | `LimitRead` | idempotent upsert, re-stamps `currency` + `updated_at` |
| DELETE | `/limits/{category_id}` | 204 | — | |

Error codes: 404 `CATEGORY_NOT_FOUND` (PUT — the category is the ADDRESSED
resource here, hence 404 not 422, per the path-vs-body rule); 422
`CATEGORY_ARCHIVED`; 422 `CATEGORY_NOT_EXPENSE` (D17/OQ-7); 404 `LIMIT_NOT_FOUND`
(DELETE, missing or foreign — one code path).

PUT body → `pg_insert(CategoryLimit).values(...).on_conflict_do_update(
index_elements=["user_id", "category_id"], set_={amount_minor, currency,
updated_at: func.now()})` — the `merchant_category_map` construction; no
read-modify-write race. `currency` is stamped from `read_base_currency` at set
time and NEVER converted afterwards (D15).

GET handler (computes no aggregation of its own — D16's reuse gate):

```python
base = await read_base_currency(session, user.id)
first, next_first = month_bounds(month)                 # domain/periods, shipped
totals = await converted_totals(session, user.id, base, first, next_first)
rows = await session.scalars(select(CategoryLimit).where(CategoryLimit.user_id == user.id))
items = [LimitItem(category_id=r.category_id, limit_minor=r.amount_minor,
                   limit_currency=r.currency,
                   spent_minor=totals.by_bucket.get((r.category_id, TransactionKind.expense.value), 0))
         for r in sorted(rows, key=lambda r: str(r.category_id))]
```

`spent` reads the **expense** bucket only — income rows in a limited category do
not offset spending (D16). Categories with spending but no limit are absent; a
limit whose category was archived after the fact is still returned (D14/D15).
Over-limit is a client visual state — no server `status`/`exceeded` field (D18).

## Tests (B3) — `tests/test_limits.py`

1. `test_put_creates_then_replaces` — PUT → 200 with `limit_currency` == base;
   PUT again with a different amount → 200 and `GET /limits` shows exactly ONE
   item carrying the new amount (upsert, not a second row — the PK/conflict
   target is what this pins).
2. `test_base_switch_surfaces_a_mismatch_and_re_stamps_on_rewrite` — **D15 pin.**
   Set a limit while base = RUB, switch the profile base to USD → GET returns
   `currency: "USD"` with `limit_currency: "RUB"` and the limit amount UNCHANGED
   (never converted, never reinterpreted); PUT again → `limit_currency: "USD"`.
   The two halves contrast each other in one test.
3. `test_put_category_rules` — missing/foreign category → 404
   `CATEGORY_NOT_FOUND`; archived → 422 `CATEGORY_ARCHIVED`; an INCOME category →
   422 `CATEGORY_NOT_EXPENSE` (OQ-7); an own visible expense category → 200.
4. `test_put_amount_bounds` — `0` → 422; `MAX+1` → 422; `MAX` → 200 (the accept
   arm; without it both rejections would pass against a bound of 1).
5. `test_delete_removes_and_is_no_oracle` — DELETE → 204 and the item is gone
   from GET; DELETE again → 404 `LIMIT_NOT_FOUND`; another user's limit → the
   byte-identical 404.
6. `test_get_folds_spent_from_expense_rows_only` — in ONE fixture month: two
   expense rows in the limited category (summed), an INCOME row in the same
   category (does NOT offset), an expense row in a DIFFERENT limited category
   (own bucket), a limited category with no rows (`spent_minor == 0`, still
   listed), a category with spending but NO limit (absent), and a limit whose
   category was archived after being set (still listed). Every arm contrasts a
   different way the fold can lie.
7. `test_get_excludes_and_flags_unconverted_rows` — a rateless foreign expense
   row in the month → excluded from `spent_minor` and `unconverted_count == 1`
   (period-level, not per item); a rated foreign row in the same month IS
   included (the contrast that proves the flag is not just "any foreign row").
8. `test_get_month_window_and_default` — `month=2026-02` counts a Feb row and not
   a Mar one; with NO `month` param the response echoes the current UTC month and
   a today-dated row is counted; `month=2026-13` → 422.
9. `test_limits_are_user_scoped_and_require_auth` — user B's limits AND user B's
   spending never appear for user A (two separate scoping mistakes are possible:
   the limit read and the aggregate); no token → 401.

## Regen + gates (B3)

`pnpm openapi` + both client gates; full lint gate. Report line: `/limits` GET's
200 renders `items[].limit_currency` and `unconverted_count` as required fields.

---

# Tier proposals (senior-lead decides)

| # | Subtask | Proposed tier | Argument |
|---|---|---|---|
| B1a | DDL + models + recurrence math | **FULL** | irreversible DDL (migration 0006 is the scope's only schema change) + the pure math every materialized row's DATE depends on |
| B1b | extraction + job + scheduler | **FULL** | money writes with no human present, snapshot semantics, atomicity, a refactor of a shipped router, and the first second-job-on-one-scheduler wiring |
| B2 | /recurring CRUD + attribution | **FULL** | per task.md (template CRUD = FULL); new contract surface + the SL-A/B/C semantics |
| B3 | /limits | **FULL** (argued) | task.md leaves this to the senior-lead. My view: the CRUD half (PUT/DELETE) is STANDARD-shaped, but `GET /limits` is a money-honesty surface — an expense/income fold error, a swallowed `unconverted_count`, or a silently reinterpreted `limit_currency` all produce a budget bar that is confidently wrong, which is exactly the failure class FULL exists for. Since both halves ship in ONE subtask, the riskier half sets the tier. If throughput matters more, the honest split is B3a (PUT/DELETE, STANDARD) + B3b (GET fold, FULL) — I do NOT recommend it: an extra run for ~40 lines. |

If any subtask lands as STANDARD, its engineer runs `/review-pr` over the diff
before reporting (PM policy 2026-07-26).

---

# Obligations carried into /implement reports

| # | Obligation | Owner | Evidence required |
|---|---|---|---|
| O-1 | **Contract regen + commit together**: `openapi.json` + `schema.d.ts` regenerated by `pnpm openapi` and committed in the SAME commit as the route change; B1a/B1b produce a ZERO diff | B2, B3 (positive); B1a, B1b (zero-diff) | `git status --porcelain` on the two artifacts, pasted |
| O-2 | **Alembic drift probe**: `alembic upgrade head && alembic check` reports no autogenerate diff, AND `downgrade -1 && upgrade head` round-trips (the conftest tears down with `downgrade base`) | B1a | both command outputs pasted |
| O-3 | **Conftest/scheduler gate**: `recurring_scheduler_enabled=False` forced at ALL FOUR app-construction sites (`conftest.py:153`, `test_receipts.py:196`, `test_advisor.py:105`, `test_health.py:30`) | B1b | grep output listing every `create_app(`/`Settings(` site in `tests/` with the flag |
| O-4 | **Full lint gate every round**: `ruff check` + `ruff format --check` + `pyright` strict + `uv run pytest` | all | the four command results |
| O-5 | **No new index without a D13-style written verdict**; the scope adds NONE beyond `recurring_templates.user_id` (declared in D2) and the two composite PKs | all | statement in the report; any proposed index → stop and write the verdict first |
| O-6 | **`auto_snapshot` extraction is behaviour-preserving**: `tests/test_transactions.py` untouched and green | B1b | statement that the file was not modified + the suite result |
| O-7 | **Atomicity + cap are pinned by tests, not comments** (D6) | B1b | test names B1b-8 / B1b-9 + their key assertions |
| O-8 | **SL-A / SL-B / SL-C each pinned by a named test** | B2 | test names B2-8, B2-9, B2-12, B2-10 |
| O-9 | **No external I/O in the new job** — it never calls a provider, never touches Anthropic, never self-heals a profile | B1b | grep: `services/recurring_jobs.py` imports no `fx_rates`/`anthropic`; `read_base_currency` is the only profile read |
| O-10 | **No notification/push surface** (D9; 5.2 explicitly out of scope) | B1b, B2 | statement in the report |
| O-11 | **Live verification at /test** (QA-owned, flagged from here): the recurring cron + boot run-now actually fire on 8010 with `RECURRING_SCHEDULER_ENABLED=true` and a template due today; and the two-cron-jobs-on-one-scheduler wiring with FX also on | QA | qa-checklist |

---

# Disagreements with the architecture / the suggested skeleton (numbered — none silent)

1. **The `auto_snapshot` extraction must land in B1b (with the job), not B2.**
   The senior-lead's skeleton places it in B2, but the materialization job is
   what *fires* the extraction rule (D8) and the job ships in B1. With the
   extraction in B2, B1's job would have to either import
   `routers.transactions._auto_snapshot` — a `services → routers` edge, which
   D1's dependency direction forbids outright — or duplicate the conversion for
   one subtask, which is the exact "two conversion sites" failure the extraction
   exists to prevent. Moving it into B1b costs nothing (it is contract-neutral
   and guarded by the shipped tx suite) and keeps the layer graph acyclic at
   every commit.
2. **D6 says the watermark alone is the mechanism; I add a per-template
   `SELECT ... FOR UPDATE`** inside the same transaction that does the inserts.
   Not a contradiction — a completion. Two runs CAN overlap today: the
   unconditional boot run-now job (D5) and the 00:30 cron can coincide on a
   restart at 00:30, and the deploy carry-forward already records that the
   in-process scheduler assumes a single instance. Without the lock, two
   concurrent runs both read the pre-run watermark and both insert the same
   dates — the one duplicate the design claims is unrepresentable. With it, the
   second run blocks, re-reads the advanced watermark, enumerates an empty
   window, and commits nothing. Cost: one clause on a query that already loads
   the row.
3. **`domain/recurrence.py` imports `budget_api.enums`** (for `RecurrenceUnit`),
   which is a hair outside D1's "domain imports stdlib + domain only". `enums.py`
   imports NOTHING internal and contains only `StrEnum` definitions, so no cycle
   is possible and the domain stays framework-free; the rule's purpose is intact.
   The alternative that satisfies the letter — define `RecurrenceUnit` in
   `domain/` (the `PeriodUnit` precedent) — forces `models/` to import `domain/`,
   a new and heavier edge, and D1 explicitly put the enum in `enums.py` so the
   model's CHECK and the schema can share it. Veto cost: move the enum, add the
   `models → domain` edge, one import line per file.
4. **D6's "on unpause set `last_materialized_on = today`"** is superseded by SL-A
   (`max(last_materialized_on, today - 1 day)`) — recorded so the two documents
   are not read as conflicting. SL-A is what I plan and test.
5. **PATCH anchor errors get TWO codes, not one** (`ANCHOR_REQUIRED` +
   `ANCHOR_MISMATCH`) where D10 describes only "must supply the new anchor". A
   client that explicitly sends `weekday` on a monthly template has made a
   different mistake from one that forgot `day_of_month`, and silently discarding
   an explicitly-sent field is what the house `model_fields_set` discipline
   exists to avoid. A merely-STORED stale anchor IS cleared server-side (nothing
   the client sent is discarded). Cost to collapse to one code: delete one branch
   and one test arm.

---

# Open questions for senior-lead (recommendation = what ships if unanswered)

1. **`next_due_on` while a catch-up is pending.** D10 says "server-computed, null
   when paused or ended" but not what to render when the job owes the template a
   PAST date (server was down, or the template was created before its own due
   date passed). **Recommendation: floor it at today** —
   `next_due(after=max(last_materialized_on, today - 1 day))` — so the UI never
   shows "next: 5 Aug" on 18 Aug; the value is the next date the job will book on
   or after today. **Veto cost:** drop the `max()`, one test arm (B2-7) flips,
   and the web must handle a past `next_due_on`.
2. **May pytest ever start a scheduler?** The standing rule (conftest, fx D3) is
   no — but it exists so no test calls a PROVIDER. The recurring gate has no
   external dependency, and D5's boot run-now is unconditional, so a lifespan
   gate test necessarily executes one local, template-free, never-raising job.
   **Recommendation: allow exactly one such test** (`test_scheduler_wiring.py`,
   B1b-11), asserting job identity/kwargs/trigger and nothing behavioural, with
   every other app in the suite still gated off. **Veto:** delete that test and
   verify the wiring only live at /test (the fx precedent) — the cost is that a
   mis-wired gate or a `today`-frozen kwarg reaches /test undetected.
3. **B1 split (you invited the argument).** **Recommendation: split into B1a
   (DDL + models + pure math, no runtime) and B1b (extraction + job + wiring, no
   DDL)** for the reasons in §Approach: two unrelated review surfaces, and the
   domain API gets pinned before its consumer is written. **Veto cost:** one
   merged FULL run; the file and test lists concatenate with no changes.

---

# Risks

- **`today` bound at schedule time.** If `job_kwargs` for the cron carries
  `today=datetime.now(UTC).date()`, the job's idea of the date freezes until the
  process restarts and materialization silently stops the next day. The signature
  defaults `today=None` and the lifespan passes ONLY the sessionmaker; test
  B1b-11 asserts the kwargs keys. This is the single most dangerous line in the
  scope.
- **Weekday convention across the wire.** `weekday` is 0=Monday
  (`date.weekday()`), while JavaScript's `Date.getDay()` is 0=**Sunday**. A web
  form that passes `getDay()` straight through is off by one for six of seven
  values and correct-looking for the seventh. Flagged for plan-web; the server
  side is pinned by B1a-3.
- **Catch-up × rate history.** Due-date snapshots rely on the fx table holding
  historical rows (400-day backfill + daily cron). A long outage that also
  starved the fx job produces honest `NULL/NULL` pairs on materialized rows —
  correct, but the user sees unconverted rows in stats. No code fixes this; a
  later PATCH of the row does.
- **First multi-job scheduler.** Two cron jobs plus a run-now on one
  `AsyncIOScheduler` with distinct kwargs is trivial in APScheduler 3.x but
  untried here; the gate-combination test plus QA's live /test run are the guard
  (O-11).
- **Silent auto-write is deliberate** (D9) and inverts the OCR rule. If the
  attribution field or the web badge is not shipped, users get money appearing
  with no visible cause — B2's contract field and plan-web's badge are the
  honesty mechanism, not a nice-to-have.
- **Template DELETE is hard** (D7/SL-C): the badge and the template name vanish
  from historic rows. Recorded and intended; `paused` is the "stop but keep"
  affordance, and the web degrades to a badge-only state for a NULL id.
- **`GET /limits` reuses `converted_totals`** — a whole-month fold including the
  per-row bucket-3 scan. At personal scale this is the same cost as the shipped
  `/transactions/summary`; if a limits screen ever measures > 100 ms, that is the
  re-arm trigger for the D13 verdicts, not a silent index.
