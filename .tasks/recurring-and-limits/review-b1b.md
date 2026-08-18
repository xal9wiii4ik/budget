# Code review — B1b (auto_snapshot extraction + materialization job + scheduler wiring)

Reviewer: code-reviewer. Scope: uncommitted working-tree changes under `apps/api`
only (`app.py`, `config.py`, `routers/transactions.py`, `services/fx_lookup.py`,
`tests/conftest.py`, `tests/test_{advisor,health,receipts}.py` + the three new
files). Gates were NOT re-run (the senior lead's re-run stands); the probes below
are targeted only.

**Headline:** the money-critical core is sound. The watermark is advanced only to a
materialized date, the inserts and the watermark share one transaction, the
`FOR UPDATE` re-read under the lock makes the loser of a race land on the empty-
`dates` arm, the cap resumes rather than drops, and the snapshot uses the DUE date.
I found no path that books an occurrence twice or skips one forever. The three
majors below are one real contract violation in production code (cheap fix) and two
tests that pass under the exact bug they are written to catch (proved by mutation).

---

## 1. MAJOR — `materialize_due` CAN raise: the probe session is outside the `try`

`src/budget_api/services/recurring_jobs.py:78-79`

```python
    run_date = today if today is not None else datetime.now(UTC).date()
    async with sessionmaker() as probe_session:          # <- no try
        template_ids = await _due_template_ids(probe_session, run_date)
```

Everything from `sessionmaker()` through the probe's `__aexit__` is outside the
per-template `try`. A DB that is down (or a pool/connect timeout) at that moment
propagates straight out of the coroutine.

**Evidence** (scratchpad probe, sessionmaker pointed at a closed port):

```
RESULT: RAISED ConnectionRefusedError: ConnectionRefusedError(61, "Connect call failed ('127.0.0.1', 1)")
```

This contradicts three load-bearing claims in this diff:

- `recurring_jobs.py:69` — `"""Materialize every due occurrence ... NEVER raises (D5)."""`
- `recurring_jobs.py:23` — "The job never raises: an APScheduler job that raises is
  swallowed as an error event..."
- `app.py:139-141` — the justification for having NO boot probe on the recurring
  branch: *"any probe would run the same tiny query the job itself starts with, and
  the job never raises — so a probe could only add a second way to be wrong."*

The fx branch immediately above guards exactly this scenario with
`except (SQLAlchemyError, TimeoutError, OSError)` and a one-line
`logger.warning("fx catch-up probe failed: %r", exc)` (`app.py:100-107`), because a
DB that is down at boot must not turn into noise. The recurring boot run-now job is
UNCONDITIONAL, so on a DB-down boot it produces an APScheduler ERROR event with a
full traceback instead of the intended warning — and the same every day at 00:30
UTC for as long as the DB is unreachable.

Money impact: none (nothing is materialized; the next run re-derives everything).
Contract impact: the docstring is false and the app.py comment that leans on it is
therefore false too. Same shape also applies during `test_scheduler_wiring.py`'s
teardown, where the run-now job can still be in flight when `engine.dispose()` runs.

**Fix:** wrap the probe in the same defensive boundary as the loop, e.g.

```python
    try:
        async with sessionmaker() as probe_session:
            template_ids = await _due_template_ids(probe_session, run_date)
    except Exception as exc:
        logger.warning("recurring probe failed: %r", exc)
        return
```

(or the fx catch tuple, if a narrower boundary is preferred here — but then the
"NEVER raises" wording must be softened to match).

## 2. MAJOR — B1b-10 passes with the branch it exists to pin DELETED

`tests/test_recurring_jobs.py:621-664` (`test_template_deleted_between_probe_and_lock_is_skipped`)

The test asserts only "no rows were written" and "`materialize_due` returned
`None`". Both hold whether the job takes the intended `if tpl is None: continue`
arm **or** blows up on `None.paused` and has the AttributeError swallowed by the
broad `except Exception` at `recurring_jobs.py:146`. The broad except is precisely
what makes the two outcomes observationally identical, so the test cannot see the
difference.

**Evidence** — mutated `recurring_jobs.py:89` from `if tpl is None or tpl.paused:`
to `if tpl.paused:` (file restored byte-identical afterwards, md5 verified):

```
mutated
.                                                                        [100%]
1 passed, 14 deselected in 1.30s
```

The test's own docstring says "A job that must never raise cannot be left to
discover this branch in production" — but it does not detect the branch's absence.

**Fix:** add a log assertion, e.g. take `caplog` at `WARNING` for
`budget_api.services.recurring_jobs` and assert `caplog.records == []` (the clean
`continue` logs nothing; the swallowed AttributeError logs
`"recurring materialization failed for %s"`). One extra line, and it also gives the
test a positive statement about which arm ran.

## 3. MAJOR — B1b-9 does not pin the per-template `except` boundary (only the rollback half)

`tests/test_recurring_jobs.py:544-619` (`test_failure_mid_batch_rolls_back_that_template_only`)

The rollback half IS solidly pinned (B has zero rows and an unchanged watermark, in
a fresh session, both fault positions — AM-4 satisfied). The *other* half — "one
template's bad data must not cost every other template its run"
(`recurring_jobs.py:147-148`), and the module docstring's "leaves every other
template alone" — is not pinned, because the surviving template is the one created
FIRST and `_due_template_ids` has no `ORDER BY`: in practice the seq scan returns
insertion order, so the survivor is already committed before the fault fires. A
regression that aborts the whole run on the first failure keeps every assertion
true.

**Evidence** — mutated the handler at `recurring_jobs.py:150-152` to `break` out of
the loop after logging (file restored byte-identical afterwards, md5 verified):

```
mutated: except now aborts the loop
..                                                                       [100%]
2 passed, 13 deselected in 1.46s
```

Both parametrized arms (`mid-batch`, `last-date`) pass under the mutant.

**Fix:** add a third template created AFTER the failing one and assert it also
committed its rows and watermark. Because the probe is unordered, a survivor on
*both* sides of the failing template is the only order-independent form; a bare
"swap the creation order" fix would just move the blind spot. (Alternatively add a
deterministic `ORDER BY` to `_due_template_ids` and then order the fixtures — but
the extra template is cheaper and does not touch production SQL.)

## 4. MINOR — `_due_template_ids`' docstring overclaims the ended-template exclusion

`src/budget_api/services/recurring_jobs.py:48-51`

> The ``end_date > last_materialized_on`` clause keeps forever-ended templates out
> of the loop for free — without it every template ever ended would be locked and
> re-evaluated daily until deleted.

True only when `end_date` falls exactly ON a due date (which is what B1b-4 tests,
`end_date=2026-07-01` for a `dom=1` template). For the ordinary case — a monthly
template ended mid-month — the watermark stops at the last due date strictly before
`end_date`, so `end_date > last_materialized_on` stays true forever and the row is
re-selected, `FOR UPDATE`-locked and re-evaluated every single day until deleted:
exactly the outcome the comment says the clause prevents.

**Evidence** (scratchpad probe against budget_test, schema applied and torn back
down afterwards; template `dom=1`, watermark 2026-05-20, `end_date=2026-07-15`):

```
watermark=2026-07-01 rows=2
probe on 2026-09-05 still selects the ENDED template: True
probe on 2030-01-01 still selects the ENDED template: True
```

Behaviour is CORRECT (`through = end_date` → `dates` empty → `continue`, no rows,
no watermark move); only the claim and the "for free" efficiency argument are
overstated. A tighter clause would need the recurrence math the probe deliberately
does not have, so this is a comment fix, not a code fix — say that the clause
excludes templates whose watermark has reached `end_date`, and that a template ended
between due dates stays a (no-op) candidate until deleted.

## 5. MINOR — "the ONE conversion site codebase-wide" is not true

`src/budget_api/services/fx_lookup.py:90` and `routers/transactions.py:28-31`

The extraction is otherwise clean: the body is verbatim, the placement after
`lookup_rate` is right, `services` importing `routers` is correctly avoided, both
call sites renamed (`transactions.py:345`, `:625` — the plan's "three call sites" is
a plan-side miscount; the two PATCH arms always shared one call), no `_auto_snapshot`
residue, and `tests/test_transactions.py` is untouched.

But `lookup_rate` + `convert_minor` are also paired directly in `routers/fx.py:47,59`,
`services/goal_reads.py:141,151,166` and `services/tx_totals.py:156,161 / 236,243 /
331,335`. The accurate claim is that it is the one **base-currency snapshot-write**
conversion site (the others are read-side preview/aggregate conversions). Worth
tightening in both places, since this codebase treats comments as load-bearing and
the next reader will grep and find five counter-examples.

## 6. NIT — the cap warning cannot distinguish "capped" from "exactly 366 due"

`src/budget_api/services/recurring_jobs.py:136` — `if len(dates) == MAX_OCCURRENCES`
fires a WARNING even when exactly `MAX_OCCURRENCES` dates were genuinely due and
nothing was truncated. Log-only, no behavioural consequence; noted because the
message says "capped".

## 7. NIT — both recurring jobs share one `recurring_kwargs` dict object

`src/budget_api/app.py:122-124` — the same dict instance is handed to the cron and
to the run-now job (APScheduler keeps the reference). Harmless, and it matches the
fx `job_kwargs` precedent. Side effect on the test: AM-6's "BOTH jobs' kwargs keys"
loop (`test_scheduler_wiring.py:164-165`) is inspecting the same object twice, so it
is one assertion, not two.

## 8. NIT — the lock-phase `tpl.paused` arm is untested

`recurring_jobs.py:89`. `test_paused_template_is_skipped_and_watermark_frozen`
exercises the *probe's* `paused.is_(False)` filter (a paused template never reaches
the lock at all); the re-paused-between-probe-and-lock arm has no coverage. Cheap
defensive code, low value to test — flagged only for completeness.

---

## Things I checked and found correct (no action)

- **Watermark rules.** `tpl.last_materialized_on = dates[-1]` only on a non-empty
  `dates`, inside the same commit as the inserts; the empty-`dates` `continue`
  never moves it. No skip-forever path.
- **Race.** Fresh session + `SELECT ... FOR UPDATE` per template means the loser of
  a race re-reads the committed watermark under READ COMMITTED and lands on the
  empty-`dates` arm. AM-5's barrier rendezvous is the right seam (a bare `gather`
  serialises on connect); the lead's lock-deletion mutation confirms it bites.
- **`through` vs the probe clause.** `through = end_date if end_date < run_date else
  run_date`, and `due_dates_between` is `(after, through]`, so a due date landing ON
  `end_date` materialises and the next one never can. Consistent with B1b-4.
- **Cap resume.** `dates[-1]` after truncation; B1b-8's 366 + 54 + 0 across three
  runs is real (AM-1's ≥8-year re-basing makes run 1 genuinely hit the cap).
- **Snapshot.** `on_date = due`, `base` read once per template via
  `read_base_currency` (per owner — B1b-6 has two users with different bases, and
  AM-12's profile-less arm asserts no self-heal). `currency == base` short-circuits
  to `(None, None)` and B1b-5's contrast seeds a RUB→RUB identity rate so the
  short-circuit, not a rate miss, is what is being proved. AM-2's three different
  rates would catch a hoisted lookup; AM-3's run-date-only rate stays NULL/NULL.
- **Lifespan.** The fx branch is a pure re-indent (comment rewrap only); `job_kwargs`
  and `needs_catch_up` stay within the branch that uses them; `app.state.scheduler`
  is set on both arms; teardown (`shutdown(wait=False)` before `engine.dispose()`)
  unchanged. `test_scheduler_wiring.py`'s recording-subclass rationale is honest —
  a `next_run_time=now` job really is gone from the jobstore by the time the test
  looks — and it asserts by trigger type, not func identity (AM-6).
- **Gate propagation.** All four app-construction sites (conftest `make_client`,
  test_advisor, test_receipts, test_health) set `recurring_scheduler_enabled=False`;
  `test_scheduler_wiring.py` is the sole gated-on file (R2/OQ-2), and the autouse
  `_clean_tables` fixture guarantees the template-free DB its docstring claims.
- **Config.** All three settings defaulted; no new env at any explicit `Settings(...)`
  site outside the wiring test's own overrides.

---

# Verdict: **SHIP-WITH-FIXES**

Nothing here can double-book or lose money, and no fix requires re-design. Before
merge:

- **#1** (probe inside the exception boundary) — production code, the only finding
  that changes runtime behaviour. Should not ship as-is while three comments assert
  the opposite.
- **#2** and **#3** — two test edits (one `caplog` assertion; one extra template).
  Both tests currently certify properties they do not test, in the one subtask whose
  whole design rests on having no UNIQUE backstop.
- **#4** and **#5** — comment truthfulness; land them with the above.
