# Architecture: recurring-and-limits (roadmap 5.3 + 5.4, backend + web, mobile FROZEN)

Architect output for scope grooming. Binding inputs: `.tasks/recurring-and-limits/task.md`,
`budget-app-architecture.md` §Категории/§Мультивалютность/§2/§4, the currencies-goals
grooming-review (§6 OQ-1 snapshot ruling, §7 carry-forwards), the stats-advisor
architecture (D1 amended services definition, D6 index-verdict discipline), and the
working tree — every code claim below was verified in source (files cited inline).

Decisions are D1–D22; PM-facing forks are OQ-1..7, each with a recommendation
(veto-style: the recommendation ships unless vetoed before the owning subtask's
/implement). Inferred requirements are marked **[assumption]** with the minimal
interpretation taken.

---

## Part 0 — Module placement and layering (D1)

### D1. New modules, per the amended services definition (stats-advisor D1)

Dependency direction unchanged: routers → services → domain/models; `domain/`
imports stdlib + `domain/` only; services never import routers. New modules:

| Module | Layer | Contents |
|---|---|---|
| `models/recurring_template.py` | models | `RecurringTemplate` (D2) |
| `models/category_limit.py` | models | `CategoryLimit` (D13) |
| `domain/recurrence.py` | domain (PURE, stdlib only) | due-date math: `next_due`, `due_dates_between`, the day-clamp rule (D3) — the `domain/goals.py`/`domain/periods.py` template, unit-tested without a session |
| `services/recurring_jobs.py` | services | the materialization job — DB-writing orchestrator, the `services/fx_jobs.py` template (sanctioned home for scheduler consumers since 3.1) |
| `routers/recurring.py` | routers | template CRUD (D10), mounted `/recurring` |
| `routers/limits.py` | routers | limits upsert/delete/read (D15/D16), mounted `/limits` |
| `schemas/recurring.py`, `schemas/limit.py` | schemas | DTOs + `RecurringError`/`LimitError` (the `TransactionError` envelope pattern) |
| `enums.py` | shared | `+RecurrenceUnit` (D3) — definition-order-load-bearing comment convention carried over |

Both routers are auth-required, DB-only, **no rate limit, no `prime_rate_limit`
mount dependency** (the categories/fx/goals/stats precedent in app.py — no cost
driver). Both new tables' reads/writes are `user_id = me`-scoped at every query
(architecture §3 pillar).

The polish backlog items in the task brief (network-unreachable alerts, modal
discard confirm, ru string) have **no architectural impact** — senior-lead calls
per item, nothing here constrains them.

---

## Part 1 — 5.3 Recurring templates

### D2. Table `recurring_templates`

```
recurring_templates
  id                    Uuid PK default uuid4
  user_id               Uuid FK users.id ondelete=CASCADE, index=True   (goals precedent)
  name                  String(100) NOT NULL                            (goals precedent)
  amount_minor          BigInteger NOT NULL, CHECK amount_minor > 0
  kind                  String(16) NOT NULL, CHECK kind IN ('expense','income')
                        — rebuilt from TransactionKind, the byte-identical-SQL
                        convention of models/transaction.py
  currency              String(3) NOT NULL, CHECK ^[A-Z]{3}$
  category_id           Uuid NULL FK categories.id ondelete=SET NULL    (transactions precedent)
  merchant              String(255) NULL
  note                  Text NULL
  interval_unit         String(8) NOT NULL, CHECK IN ('month','week')   (D3)
  day_of_month          SmallInt NULL, CHECK 1..31                      (D3)
  weekday               SmallInt NULL, CHECK 0..6  (ISO: 0=Monday)      (D3)
  end_date              Date NULL                                       (D4)
  paused                Boolean NOT NULL default false, server_default false
  last_materialized_on  Date NOT NULL                                   (D6 watermark)
  created_at            DateTime(timezone=True) server_default now()
  CHECK anchor_matches_unit:
      (interval_unit = 'month') = (day_of_month IS NOT NULL)
  AND (interval_unit = 'week')  = (weekday IS NOT NULL)
      — the base_snapshot_pair both-or-neither style: an inconsistent
        unit/anchor pair is structurally unrepresentable, not review-guarded.
```

Field rationale:

- `amount_minor` CHECK `> 0` (not `>= 0` like transactions): the transactions
  `>= 0` exists only because an *auto-computed snapshot* can quantize to 0;
  template amounts are always user-supplied, so the goals `target_minor_positive`
  precedent applies. Schema layer adds `ge=1, le=MAX_MINOR_AMOUNT` (D21).
- `currency` NOT NULL in the DB; the create DTO accepts null/omitted → the server
  stamps `profile.base_currency` **at creation time** (the exact
  `TransactionCreate.currency` wire contract). A later base-currency change does
  NOT re-stamp templates — the template records the money as it will be spent,
  same stance as stored transactions.
- `category_id` ondelete=SET NULL for structural safety, but categories have no
  delete endpoint (verified: routers/categories.py — archive only), so in practice
  only archive can happen; see D11 for the archived-category rule.
- The template stores **NO base-snapshot pair** — confirmed. It is not a
  transaction; the snapshot is computed per materialized row at its own due date
  (D8). Storing one on the template would be a pre-computed guess that goes stale
  by construction.
- `last_materialized_on` is NOT NULL and initialized at creation to
  `creation_day − 1 day` (UTC date), so a template created on its own due day
  materializes that day's occurrence at the next run (D6/D9-timing).

### D3. Periodicity grammar: `interval_unit ∈ {month, week}` + one anchor column each. No custom intervals, no RRULE.

The mandated minimum is monthly-on-day-N. Three shapes considered:

- **(a) monthly-only** (`day_of_month` column, no unit): rejected — adding weekly
  later means a migration *plus* a wire-contract change to every DTO; the cost of
  carrying the unit enum now is one column and one CHECK.
- **(b) unit + anchor** (chosen): `interval_unit` enum with exactly the two units
  a personal budget has real instances of (rent/salary/subscriptions = monthly;
  cleaning/lessons = weekly). Every-N-weeks / every-N-months (`interval_count`)
  is **not** included — no motivating case in the task, and adding a count column
  later is purely additive to both DDL and grammar (nullable, default 1). This is
  the "minimal grammar that doesn't paint us into a corner": the corner-avoidance
  is the *unit enum existing*, not the breadth of units.
- **(c) RRULE string**: rejected as overkill — unqueryable in SQL, drags an
  iCal-parser dependency into `domain/`, makes the due-date math a library call
  instead of a 20-line pure function, and its expressive power (BYSETPOS,
  EXDATE...) is speculative flexibility nobody asked for.

**Day-31/Feb clamp rule (explicit, lives in `domain/recurrence.py`):** for a
monthly template with `day_of_month = N`, the due date in month M is
`min(N, days_in(M))` — day 31 → Jan 31, Feb 28 (29 in leap years), Apr 30. No
skipping, no rolling into the next month. Weekly: due every date whose
`isoweekday() - 1 == weekday`.

**Date basis:** "today" is `datetime.now(UTC).date()` — the same clock basis as
the fx cron (fx_jobs.py). `occurred_at` is a DATE and profiles carry no timezone
(verified: models/profile.py), so per-user-timezone dueness is unbuildable
honestly today. Recorded simplification: a user west of UTC sees the row stamped
with the correct due DATE, appearing up to a few hours into their local previous
evening or next morning depending on the run hour (D5). Re-arm trigger: a
timezone field lands on profiles.

### D4. End conditions: `none` (NULL end_date) and `end_date`. N-occurrences NOT built. (OQ-2)

Due dates strictly after `end_date` never materialize; an ended template stays
listed (the client derives "ended" from `end_date < today` — no server status
field, same stance as D17). "After N occurrences" is rejected: it needs a
persisted occurrence counter whose increment must stay atomic with each
materialized insert, it interacts with catch-up batches and template edits
(does editing the amount reset the count?), and the user can express any finite
plan as an `end_date` in one head-calculation. Adding a counter later is
additive. **[assumption: the task's "end conditions" does not mandate all three
forms — the minimal honest set is none/end_date.]**

### D5. Materialization job: second job on the SAME `AsyncIOScheduler`, own gate `recurring_scheduler_enabled`

- **Scheduler wiring (app.py lifespan):** the one `AsyncIOScheduler` is built if
  `fx_scheduler_enabled OR recurring_scheduler_enabled`; each feature adds its
  jobs only under its own gate. Teardown order unchanged (shutdown(wait=False)
  before engine dispose).
- **New Settings (config.py house rules — every field defaulted so explicit
  `Settings(...)` sites need no new env):**
  - `recurring_scheduler_enabled: bool = True` — the gate. The pytest suite
    constructs apps with it **False** (conftest, same as `fx_scheduler_enabled`);
    test servers run `RECURRING_SCHEDULER_ENABLED=false` per the task env note.
    Job functions are tested by direct call, never via a live scheduler.
  - `recurring_materialize_hour_utc: int = 0`, `recurring_materialize_minute_utc:
    int = 30` — daily cron at 00:30 UTC: just after the UTC date rolls over, so a
    row due "today" exists before any user wakes up. (fx runs 17:30 UTC for
    provider-publication reasons that don't apply here.)
- **Cron job:** `CronTrigger(hour=.., minute=.., timezone="UTC")`,
  `misfire_grace_time=3600, coalesce=True` — byte-for-byte the fx rationale
  (default 1s grace silently skips a slept-through day).
- **Boot catch-up: an UNCONDITIONAL run-now job** (`next_run_time=now,
  misfire_grace_time=None`) — a deliberate, argued deviation from fx's
  probe-then-maybe-schedule. The fx probe exists so *startup never touches a
  provider*; materialization has no external dependency, and any probe
  ("is any template behind?") would execute the same tiny query the job itself
  starts with. Probing first would be duplicated work wearing a precedent's
  costume. The job never raises (D6), so boot cannot fail from it.

Job entry point: `materialize_due(sessionmaker, *, today: date) -> None` in
`services/recurring_jobs.py`. Like `fetch_daily_rates` it takes the sessionmaker
(not a session) and **never raises** — top-level try/except per template, warn
and continue, so one poisoned template cannot starve the rest (the per-provider
isolation argument).

### D6. Idempotency: the watermark IS the mechanism; atomicity comes from per-template commit. No UNIQUE backstop, no derived-from-data probe.

Per run, per template: enumerate due dates in
`(last_materialized_on, min(today, end_date)]` from the CURRENT definition,
insert one transaction per due date, advance `last_materialized_on` to the last
materialized date, **commit — inserts and watermark in ONE DB transaction per
template**. That single sentence is the whole idempotency story:

- **Crash mid-run:** the in-flight template's inserts and its watermark roll back
  together; already-committed templates are already past. Next run (or boot
  catch-up) redoes exactly the rolled-back template. No duplicate is
  representable, because the watermark can never say "done" without the rows
  that made it true being in the same commit.
- **Derived-from-data probe (query existing tx per (template_id, due_date)) —
  rejected:** materialized rows are ordinary transactions the user may legally
  edit (`occurred_at`) or delete. An edit breaks the probe key → duplicate on
  next catch-up; a deliberate user delete gets silently resurrected. Both are
  the mechanism fighting the user.
- **UNIQUE(template_id, occurred_at) backstop — rejected:** same editability
  problem (an edited `occurred_at` frees the slot for a resurrection), plus it
  would *forbid* a legitimate manual second transaction on the same day linked
  to nothing. A backstop that is both porous and over-restrictive guards
  nothing. The atomic-commit design needs no backstop.
- **Template edited between due date and catch-up:** catch-up enumerates from
  the CURRENT definition — the not-yet-materialized past dates follow the new
  amount/periodicity. This is the natural extension of edits-affect-future-only
  (D12): an unmaterialized date hasn't happened in ledger terms.
- **Paused templates:** skipped entirely by the run (`WHERE NOT paused`), and
  the watermark does NOT advance while paused. On PATCH `paused: true → false`
  the router sets `last_materialized_on = today(UTC)` — the paused period is
  **skipped forever**, never backfilled. Pause means "don't create these"; a
  resume that back-creates a month of skipped rent would be the job overruling
  the user's explicit instruction. Recorded alternative (backfill-on-resume)
  rejected on exactly that ground.

**Catch-up depth cap (OQ-5):** missed days materialize in full — a template IS a
standing order, and a server down for a month owes the user four rent rows with
correct dates; silently dropping them understates history (the honesty stance).
One safety valve: enumeration is capped at **366 due dates per template per
run** (module constant, not a Settings knob — no one tunes this): a pathological
clock jump or a years-forgotten weekly template mass-inserts at most one
bounded batch; the watermark advances only through what was inserted, so the
remainder (if genuinely wanted) arrives on subsequent runs, with a warning log.

### D7. Materialized-transaction relationship: FK `transactions.recurring_template_id`, nullable, ondelete=SET NULL; values otherwise COPIED

New column `recurring_template_id: Uuid NULL FK recurring_templates.id
ondelete=SET NULL` on `transactions` — the exact `receipt_id` construction
(verified: models/transaction.py). All other fields are **copied by value** at
materialization: `amount_minor, kind, currency, category_id, note, merchant`
from the template; `occurred_at = due date`; `receipt_id = NULL`. A later
template edit therefore cannot retro-write history (D12) — the FK is
attribution, never a live reference for display values.

**Delete semantics (OQ-3): hard DELETE + SET NULL — attribution dies with the
template.** The transaction rows (the money history) survive untouched; only
the "recurring" badge and template-name resolution disappear. Rationale:
categories are archived-not-deleted because the category *name is display data
for history* and old rows point at it for rendering; a template is machinery —
every display-relevant value was copied onto the transaction at materialization,
so nothing a ledger reader needs dies with it. `paused` already covers
"stop but keep"; DELETE means "get rid of it". The archived-flag alternative
(keeps badges + names on old rows) is the recorded veto path.

### D8. Snapshot semantics of materialized rows: stage-3 rules verbatim, rate ON THE DUE DATE

Confirmed as the coherent reading: the materialized transaction is a transaction
occurring on its due date, so its base pair follows the shipped create decision
table (routers/transactions.py D5) with `occurred_at = due date`:

- template currency == user's CURRENT base → `NULL/NULL` (a base-currency row
  carries no snapshot — bucket 1 by construction);
- else → `lookup_rate(session, currency, base, due_date)` (nearest-previous
  scan) + `convert_minor`; **rate miss → `NULL/NULL`**, honest as everywhere —
  never the run-date rate, never a guess. During catch-up the fx table already
  holds the historical dates (400-day backfill + daily cron), so due-date rates
  are the norm, not the exception.
- There is no user override arm — nobody is present to override; the override
  remains available afterwards via the ordinary PATCH.

**Extraction (second consumer fires the rule):** the conversion currently lives
as `routers/transactions._auto_snapshot` — "the ONE conversion site in this
router" (its own docstring). The materializer is its second consumer, so it is
EXTRACTED to `services/fx_lookup.py` as `auto_snapshot(session, amount_minor,
currency, base, on_date) -> tuple[int | None, str | None]` (fx_lookup already
owns rate resolution; this keeps ONE conversion-resolution site codebase-wide —
the tx_totals invariant). `routers/transactions.py` refactors onto it in this
scope; existing snapshot tests are the guard (the category_access-at-1.4
template). Base currency per user via `services/profile_reads.read_base_currency`
— the job is a read context and must NOT self-heal a missing profile (the
GET-never-writes rule extends naturally: only user-initiated writes self-heal).

The job does NOT touch `merchant_category_map` (no learning): learning fires on
user confirmation of new information (transactions D7); a template repeat adds
none — the pair was learnable when the template was created or its first
materialization confirmed nothing new.

### D9. Silent materialization is DELIBERATE — recorded contrast with the OCR rule

The architecture doc forbids silent auto-write for OCR ("Молчаливая автозапись
запрещена") because *OCR guesses and guesses err* — an unconfirmed wrong amount
poisons trust in the statistics. A recurring template inverts every premise: the
amount, currency, category and schedule are exact values the user typed, and
creating the template IS the standing confirmation for every future occurrence.
No per-occurrence confirm, no notification gate (5.2 is out of scope). The
attribution field (D7/D10) is what keeps it honest: every auto-created row is
visibly machine-made and one tap from its template.

Timing corollary: a template created after today's 00:30 UTC run whose first due
date is today materializes at the NEXT daily run — up to ~24h later, with the
correct `occurred_at`. POST does not materialize inline and does not enqueue a
run-now job (OQ-6): the write path stays one INSERT, and the ledger date is
right either way.

### D10. CRUD surface `/recurring` (projection decided explicitly, Phase-3.5 rule 4)

- `POST /recurring` → 201 `RecurringTemplateRead`
- `GET /recurring` → `RecurringTemplateList {items: [...]}` — all templates, no
  pagination (personal scale, tens of rows; the goals list-envelope precedent,
  additive headroom). Ordered `created_at, id` for stability. Includes paused
  and ended templates — the list IS the management screen.
- `PATCH /recurring/{id}` → `RecurringTemplateRead`. **Pause is a PATCH field
  (`paused: bool`), not a separate endpoint** — the categories/goals `archived`
  precedent; a verb endpoint for one boolean is surface without semantics.
- `DELETE /recurring/{id}` → 204 (hard delete, D7).

`RecurringTemplateRead` projection:

```
{ id, name, amount_minor, kind, currency, category_id,
  merchant, note,
  interval_unit: "month"|"week",
  day_of_month: int|null, weekday: int|null,
  end_date: date|null, paused: bool,
  next_due_on: date|null,          # server-computed via domain/recurrence:
                                   # null when paused or ended — render-ready,
                                   # the client never reimplements clamp math
  created_at }
```

`last_materialized_on` stays OFF the wire (internal bookkeeping; lean-DTO rule).
Create DTO: name, amount_minor (ge=1 le=MAX, D21), kind (required — the client
defaults it from the picked category, the 1.2 sign-authority ruling), currency
optional (null → stamp base, D2), category_id optional, merchant/note optional
(reuse `clean_note`/merchant cleaning from schemas/transaction.py),
interval_unit + exactly the matching anchor (cross-field validator mirrors the
DB CHECK → 422 before the DB ever sees it), end_date optional, paused optional
default false. Update DTO: all-optional, `model_fields_set` discipline,
`*_REQUIRED` 422s for explicit nulls on NOT NULL fields — the house PATCH
pattern verbatim. Category refs validated via the existing
`load_visible_category` path: 422 `CATEGORY_NOT_FOUND` / `CATEGORY_ARCHIVED`
(one code path, no oracle). Path-id misses: 404 `RECURRING_TEMPLATE_NOT_FOUND`
via a `_load_own` clone. Changing `interval_unit` on PATCH must supply the new
anchor (the CHECK-mirroring validator runs against the effective post-patch
pair — the `eff_cur` pattern from the tx PATCH).

**Attribution in the tx list:** `TransactionRead` gains
`recurring_template_id: uuid | null` — **id-only, additive**. The template name
is NOT embedded: embedding means either a per-row join on every list page or a
denormalized name copy that drifts on rename — both real costs for a value the
web already knows (it holds `GET /recurring` in the query cache; the 1.6
category name-cache pattern, including the archived/deleted → badge-only
degradation). No `?recurring_template_id=` list filter in this scope (no screen
asks for it; additive later).

### D11. Archived category on a template: materialize AS STORED

If a template's category is archived after the template was created, the job
keeps stamping `category_id` as stored. NULLing it would silently unfile a
standing order; pausing the template would turn an unrelated category action
into a scheduler side effect. Archived categories already own and display their
history (the 1.6 include-archived rule) — new standing-order rows are more of
that history. The user edits the template if they want it refiled. (Creating or
PATCHing a template TO an archived category is still 422 `CATEGORY_ARCHIVED`,
D10 — same asymmetry the tx PATCH already has: references you set are
validated; references that rot underneath you keep working.)

### D12. Editing a template affects FUTURE materializations only — recorded

Already-materialized transactions are copies (D7) and are never touched by any
template edit, pause, or delete. "Future" includes past-but-unmaterialized due
dates (D6: catch-up reads the current definition). This is the write-side twin
of the stage-3 snapshot ruling: history is what was booked, not what today's
definitions would rebook.

### D13. Index/perf verdicts — 5.3 query shapes (written, per shape)

| Query shape | Verdict |
|---|---|
| due-templates scan (`WHERE NOT paused AND last_materialized_on < :today`, all users, daily + boot) | **no index** — full scan of a tens-of-rows table once a day; any index would be pure write overhead |
| per-template existing-tx probe | **query does not exist** in the watermark design (D6) — nothing to index |
| template CRUD list (`WHERE user_id = :me`) | covered by `user_id` index (declared in D2, the goals construction) |
| `transactions.recurring_template_id` (FK delete-side scan on template DELETE; no read filters by it) | **no index** — same verdict and argument as the discharged `category_id`/`receipt_id` FKs (stats-advisor D6): personal-scale seq scan on a rare delete. Re-arm trigger: a per-template tx-list endpoint, or a measured slow template delete |
| materializer's per-user base-currency + rate lookups | primary-key / existing `exchange_rates` PK lookups — covered |

---

## Part 2 — 5.4 Category limits

### D14. Storage: separate `category_limits` table — confirmed (a column on categories is structurally impossible)

System categories are SHARED rows (`user_id IS NULL`, verified:
models/category.py); a per-user monthly budget on "Продукты" cannot live on the
shared row without either forking system categories per user (copy-on-limit —
breaks the shared-seed model and every existing category_id reference) or a
JSON-per-user blob (unqueryable, unconstrainable). The separate table is the
only honest shape:

```
category_limits
  user_id       Uuid FK users.id      ondelete=CASCADE  ┐ composite PK
  category_id   Uuid FK categories.id ondelete=CASCADE  ┘ (= UNIQUE(user,cat))
  amount_minor  BigInteger NOT NULL, CHECK amount_minor > 0
  currency      String(3) NOT NULL, CHECK ^[A-Z]{3}$     (D15 / OQ-4)
  created_at    DateTime(timezone=True) server_default now()
  updated_at    DateTime(timezone=True) server_default now()   (upsert refreshes,
                the merchant_category_map construction)
```

Composite natural PK (the profiles precedent — no surrogate id for a
one-per-pair row): it IS the uniqueness constraint and the upsert conflict
target (`pg_insert ... on_conflict_do_update(index_elements=["user_id",
"category_id"])`, the merchant-map construction) and its leading column covers
the list-by-user read. `ondelete=CASCADE` on category_id is dead code today
(categories are never deleted) but correct if that ever changes — a limit on a
nonexistent category means nothing. A limit on an *archived* category persists
and is returned (D15); hiding it would silently eat a number the user set.

### D15. Currency semantics (OQ-4 — the PM fork): store `currency` stamped at set time; NO silent reinterpretation, NO auto-conversion of the limit

The limit is "monthly budget in base currency", but base currency is
display-only mutable (stage 3). The two options:

- **(a) amount only, no currency:** one column simpler, but on a base switch
  RUB→USD a `30 000 RUB` limit silently becomes `30 000 USD` — a number that
  changes meaning without anyone touching it. That is precisely the class of
  silent guess stage 3 exists to forbid.
- **(b) amount + currency stamped from `profile.base_currency` at set/upsert
  time (RECOMMENDED):** reads return the stored pair verbatim. While
  `limit.currency == current base` (the overwhelmingly normal case) the client
  compares spent-vs-limit directly. After a base switch the pair no longer
  matches: the API returns both honestly, the client renders the mismatch state
  ("лимит задан в RUB, база теперь USD — обновите лимит") and the user re-sets
  the limit, which re-stamps it. The server does NOT convert the limit at
  today's rate — a budget is a user-declared threshold, not an observed
  transaction; restating it at a floating rate would make the bar move daily
  without user intent. This is the `NULL/NULL`-not-a-guess stance applied to
  thresholds, and it mirrors the transaction snapshot pair (amount + currency,
  stamped at write time) structurally.

### D16. "Spent X of Y": new `GET /limits` read riding the SAME shared aggregate; stats endpoints unchanged

**Reuse-existing-operation gate, applied explicitly:** the per-category expense
sums already exist as `converted_totals(...).by_bucket` in `services/tx_totals`
(verified — the one three-bucket conversion site; stats-advisor D2's "one
conversion resolution in the codebase, ever"). The question is only which
ENDPOINT carries the join against limit rows:

- **Extend `GET /stats/summary`** — rejected: summary is period-generic
  (month/quarter/year/custom, routers/stats.py `resolve_period`) while a limit
  is calendar-month-only; bolting a month-only `limits[]` arm onto a
  quarter-capable endpoint makes the contract lie for three of four period
  units (null? empty? which month?). Also `by_category` there carries both
  kinds and prev-period baggage the limits screen doesn't want.
- **Extend `GET /categories`** — rejected: the categories list is a
  period-free settings read; giving it a month parameter and converted sums
  changes its nature for one consumer.
- **New `GET /limits?month=YYYY-MM` (CHOSEN):** month optional, default =
  current UTC calendar month; validated by the shipped `MONTH_PATTERN`
  (domain/periods.py) + `month_bounds` — any month is viewable for free since
  the aggregate takes a window anyway (past-month review is a natural screen).
  The handler: `read_base_currency` → ONE `converted_totals` call for the month
  → fold `by_bucket[(category_id, 'expense')]` against the user's limit rows.
  Zero new SQL aggregation, zero forked conversion logic.

Response (render-ready):

```
{ "month": "YYYY-MM",
  "currency": str,                       # current profile base — spent's currency
  "items": [ { "category_id": uuid,
               "limit_minor": int,
               "limit_currency": str,    # stored stamp (D15); client compares
                                         # only when == currency
               "spent_minor": int } ],   # base-currency month expense sum for
                                         # that category; 0 when no rows
  "unconverted_count": int }             # the month's excluded rows — period-
                                         # level, the standing stats honesty
                                         # pattern (per-category counts would
                                         # fork tx_totals' return shape for a
                                         # flag nobody renders per-bar)
```

`spent` = expense-kind buckets only; income rows in a limited category do not
offset spending **[assumption: a budget tracks outflow — netting refunds
against it is a policy nobody asked for]**. Items ordered by `category_id` for
determinism. Categories with spending but NO limit are absent — the stats
screens already show unlimited categories; this endpoint answers "how am I
doing against my budgets", not "what did I spend" (that is `/stats/summary`).

### D17. Limits CRUD: PUT-style upsert on the category-addressed path

- `PUT /limits/{category_id}` body `{amount_minor}` → 200 `LimitRead
  {category_id, limit_minor, limit_currency}` — **idempotent upsert** (create
  or replace; re-stamps `limit_currency` from the current base, refreshes
  `updated_at`). One limit per (user, category) is the table's PK; PUT's
  replace semantics match it exactly, while POST+PATCH would force the client
  through a 409/404 existence dance for zero expressiveness. `pg_insert
  on_conflict_do_update` — no read-modify-write race.
- `DELETE /limits/{category_id}` → 204; missing/foreign → 404
  `LIMIT_NOT_FOUND` (no-oracle, one code path).
- Category validation on PUT: the path category must be visible
  (`load_visible_category`) → else 404 `CATEGORY_NOT_FOUND` (it is the
  addressed resource here, hence 404 not 422 — the path-vs-body rule from
  routers/transactions.py's docstring); archived → 422 `CATEGORY_ARCHIVED`;
  **income-kind → 422 `CATEGORY_NOT_EXPENSE`** — a monthly spending cap on an
  income category is meaningless under D16's expense-only spent (OQ-7).
- No `GET /limits/{category_id}` single read — the list is the screen; additive
  later if a deep-link needs it.

### D18. Over-limit is a CLIENT visual state — confirmed, no server `status`/`exceeded` field

The API returns `spent_minor`, `limit_minor`, `limit_currency` — numbers. The
comparison is one subtraction the client performs on already-server-computed
values, which does not violate "клиент ничего не пересчитывает" (that rule
targets conversion/aggregation). A server-side status would bake display policy
(is 100% "over"? is 80% "warning"? what during a currency mismatch?) into the
contract and version every threshold tweak. No push, no notification hook —
5.2, explicitly out of scope.

---

## Part 3 — Cross-cutting

### D19. Migrations: ONE migration, `0006_recurring_templates_and_limits`

Contents: `recurring_templates`, `category_limits`, `transactions.
recurring_template_id` (nullable column + FK — pure ADD COLUMN, no backfill:
every existing row is correctly "not from a template" as NULL). One migration,
not two: the 0005 precedent bundled a scope's DDL into its first backend
subtask, and splitting DDL that no intermediate subtask ships between buys
ordering risk for nothing. Owned by the scope's FIRST backend subtask;
`alembic check` autogenerate-drift probe guards model↔migration parity as
usual. No data migration, no index beyond those declared in D2/D14.

### D20. Contract regen (standing gate: openapi.json + schema.d.ts regenerated and committed TOGETHER, in the same subtask as the route change)

- Recurring CRUD subtask: regen (new `/recurring` routes + DTOs + the
  `TransactionRead.recurring_template_id` additive field — the field rides THIS
  regen so the tx list attribution and the CRUD land as one contract change).
- Limits subtask: regen (new `/limits` routes + DTOs).
- Materialization-job subtask: NO regen (no contract surface — services/config
  only).
- Web subtasks consume, never regenerate.

### D21. Amount bounds: reuse `MAX_MINOR_AMOUNT`

`schemas/transaction.MAX_MINOR_AMOUNT` (= 999_999_999_999_999, the D14 landing
verified in source with goal.py already importing it) applies as
`Field(ge=1, le=MAX_MINOR_AMOUNT)` to `RecurringTemplateCreate/Update.
amount_minor` and the limits PUT `amount_minor`. Same import edge as
schemas/goal.py. No DB CHECK for the upper bound (the recorded schema-layer
split); the `> 0` DB CHECK per D2/D14 tables.

### D22. Web note (STANDARD tier — boundaries only, plan-web owns the rest)

- Templates screen: list/create/edit/pause/delete over `/recurring`; the form's
  periodicity control renders from `interval_unit` + anchor; `next_due_on` is
  displayed verbatim (never recomputed client-side).
- Tx list: "recurring" badge keyed on `recurring_template_id`, name resolved
  from the cached `/recurring` list; id-with-no-match (deleted template) →
  badge-only degradation (D10).
- Limits: "spent X of Y" bars from `GET /limits` verbatim; over-limit and
  currency-mismatch are client visual states (D15/D18); `unconverted_count`
  renders the standing honesty affordance the stats screens already have.
- AM-5 decode discipline extends to every new money decode
  (`limit_minor` at `limit_currency`'s exponent, never at the base's).

---

## File-inventory sketch (boundaries, not a plan)

- `models/recurring_template.py`, `models/category_limit.py` — NEW (D2/D14);
  `models/transaction.py` + `recurring_template_id` (D7); `models/__init__.py`
  exports.
- `domain/recurrence.py` — NEW pure module (D3).
- `services/recurring_jobs.py` — NEW job orchestrator (D5/D6);
  `services/fx_lookup.py` + extracted `auto_snapshot` (D8).
- `routers/recurring.py`, `routers/limits.py` — NEW (D10/D16/D17);
  `routers/transactions.py` — refactor onto `auto_snapshot` + serialize the new
  field.
- `schemas/recurring.py`, `schemas/limit.py` — NEW; `schemas/transaction.py` —
  additive read field.
- `enums.py` + `RecurrenceUnit`; `config.py` + 3 settings (D5); `app.py` —
  scheduler gate OR-condition, second cron job, unconditional boot run, two new
  unprimed router mounts.
- Migration `0006_recurring_templates_and_limits` (D19). Contract regen ×2 (D20).

Dependency check: routers → services (fx_lookup, profile_reads, tx_totals) →
domain (recurrence, fx, periods, money) → models; `recurring_jobs` → domain/
models/services only (fx_jobs template); no reverse edges introduced.

---

## Open questions for PM (veto-style; defaults = what ships)

| # | Fork | Recommendation |
|---|---|---|
| OQ-1 | Periodicity breadth | **month + week, single-interval, no custom every-N, no RRULE** (D3). Veto-narrow = monthly-only (grammar rework later); veto-wide = add `interval_count` (a column + validator, cheap but speculative today). |
| OQ-2 | End conditions | **none / end_date only; N-occurrences dropped** (D4). Veto = build the occurrence counter with its atomicity coupling to D6. |
| OQ-3 | Template delete semantics | **Hard DELETE + FK SET NULL — attribution (badge/name) dies, money history survives** (D7). Veto = `archived` flag (categories-style), keeping badges on old rows at the cost of a second liveness flag beside `paused`. |
| OQ-4 | Limit currency semantics | **Store amount + currency stamped at set time; mismatch after base switch is surfaced, never auto-converted, never reinterpreted** (D15). Veto = currency-less amount (simpler, silently changes meaning on base switch — against the stage-3 honesty stance). |
| OQ-5 | Catch-up depth | **Materialize ALL missed dates (365-day-outage honest), 366-per-template-per-run safety valve** (D6). Veto = skip-older-than-N-days cap (quieter after long outages, understates history). |
| OQ-6 | Same-day-due template creation | **Materializes at the next daily run (≤24h), correct occurred_at; POST stays a plain insert** (D9). Veto = inline/enqueued materialization on create (instant gratification, write-path complexity + a second materialization entry point). |
| OQ-7 | Limits on income categories | **Rejected: 422 CATEGORY_NOT_EXPENSE; spent = expense rows only** (D16/D17). Veto = allow limits on any kind (then "spent" needs an income semantics nobody has defined). |

Verify-at-implementation flags (not PM questions): APScheduler two-cron-jobs on
one AsyncIOScheduler with distinct kwargs (trivial, but pin with a lifespan
test at gate-on/gate-off combinations); the D6 per-template commit boundary
under the sessionmaker (one `async with` per template, never one session across
templates — the fx no-session-across-IO discipline applied to batch size);
`isoweekday()` off-by-one pinned by a domain test (weekday 0 = Monday, D3).
