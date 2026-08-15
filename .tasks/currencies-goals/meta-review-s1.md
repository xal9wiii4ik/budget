# Meta-Review (senior-lead): S1 — rates-infra-and-migration

Reviewer verdict: APPROVE WITH COMMENTS (5 findings). My rulings:

- **Finding 1 (derive_nbrb outside BAD_PAYLOAD guard) — AGREE, fix before
  commit.** A zero `Cur_OfficialRate` is exactly the payload-corruption class
  the taxonomy exists for; a raw `DivisionByZero` reaching the job's blanket
  `except Exception` loses the provider/code attribution the D3 warning
  contract promises. Two-line move, no behavior change on good payloads.

- **Finding 2 (session held across provider HTTP) — AGREE, fix before
  commit.** Impact today is negligible (daily job, single instance), but S1
  is the codebase's first scheduler and sets the precedent; a minutes-long
  idle-in-transaction pattern must not be the template S2–S5 and future jobs
  copy. Restructure: short probe session → fetch with nothing held → fresh
  session for upsert+commit. Test suite must stay green unchanged (fake
  fetcher; assertions are on calls/rows, not session shape).

- **Finding 3 (min() of NBRB doc dates, warn on divergence) — PARTIALLY
  AGREE.** The min() tightening itself is right (concur with reviewer, keep
  it). The divergence warning is a one-line ops aid; folding it into the same
  fix round since the engineer is in the file anyway.

- **Finding 4 (backfill INFO invisible under uvicorn defaults) — AGREE with
  deferral, no change now.** The P2 QA gate depends on WARNINGs, which do
  surface (QA reproduced this). Backfill is not a warning; the right fix is a
  minimal app logging config, which belongs to the deploy work (1.7/1.8) —
  recorded as a carry-forward, not an S1 edit.

- **Finding 5 (_TODAY frozen at import in tests) — DISAGREE, no change.**
  The flake window is a single UTC-midnight-straddling run of a 23 s suite;
  per-test recomputation adds noise for negligible risk. If it ever flakes,
  the failure mode is obvious from the assertion. Declining.

- **Reviewer's ruling on the migration index name (plain string, matches
  0002 precedent) — ACCEPTED**; my original nit is withdrawn.

## Fix round

Findings 1 + 2 + the finding-3 one-liner implemented by backend-engineer and
verified by me in the diff: both parsers now derive inside the guard
(`FxFetchError` from `_finalize` still propagates), `fetch_daily_rates` uses
probe-session → fetch (nothing held) → fresh write session, divergent-date
warning added. Full gate re-ran green: pytest 123 passed, ruff check clean,
ruff format clean, pyright 0 errors.

No live QA re-run required: the fix round touched no wiring (app.py unchanged)
and no fetch/write semantics — the unchanged 11-test fx_jobs suite against real
PG re-proves the job behavior, and the live session's value (real provider
shapes, scheduler boot path) is untouched by these edits.

## Carry-forwards

- App logging config (surface INFO under uvicorn) → deploy task 1.7/1.8.
- Scheduler is in-process/single-instance — horizontal scaling needs a
  lock/leader (already recorded in grooming-review §7).
