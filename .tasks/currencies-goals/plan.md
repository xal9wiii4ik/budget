# Implementation Plan (backend): currencies-goals (scope 3.1–3.4; 3.5 web is plan-web.md)

Scope-grooming plan. Structured **by subtask** following architecture D14, with
the D14 "conversion" block split in two (S2/S3 — see Approach). Each subtask is
one-engineer-run sized with explicit deps. Nothing is implemented in this run.
Senior-lead directives 1–4 (from the critical read of architecture.md) are folded
inline and marked **[SL-n]**.

**Order:** S1 → S2 → S3 → S4 → S5 → [web, plan-web.md]. S4 (pure domain) has no
code dependency on S2/S3 and could land any time after S1, but sequential
execution is the recommendation (single-engineer runs; S2/S3/S5 contract regens
would race on `openapi.json` — the receipts §5 argument verbatim).

**Actual project commands** (no `make`):
- tests: `cd apps/api && uv run pytest`
- migration check: `cd apps/api && uv run alembic upgrade head && uv run alembic check`
- contract regen (both artifacts, committed together — receipts rule):
  `cd apps/api && uv run python -m budget_api.openapi_export apps/api/openapi.json`
  then `pnpm --filter @budget/api-client generate`; commit `apps/api/openapi.json`
  + `packages/api-client/src/generated/schema.d.ts` together with the router change.

**Env:** tests hit PG on 5443 via `TEST_DATABASE_URL` (conftest default 5433 is
the fallback; the env var wins — do not touch compose/.env). API dev server on
8010. No pytest ever makes live HTTP (fetcher seam faked); exactly one real fetch
happens at /test per qa-checklist.

## Approach

Four backend subtasks build bottom-up: (S1) the `exchange_rates`/goals DDL in one
migration 0005 plus the whole fetch side (fetcher seam, scheduler, backfill) so
every later subtask finds both schema and rates infrastructure in place; (S2) the
pure conversion math + read-side rate lookup + the `/fx/convert` preview endpoint
+ the cross-layer exponent guard; (S3) the D5 snapshot pair on transactions with
the full create/PATCH decision table and the D9 multi-currency aggregates; (S4)
pure `domain/goals.py`; (S5) the goals API. S2/S3 are split (deviation from the
D14 single "conversion" block) because the PATCH decision table + aggregate
rework alone carry a receipts-S3-sized test matrix; splitting keeps each run
reviewable and puts the pure-math layer under review before the router layer that
consumes it. Trade-off: one extra regen/commit cycle — accepted.

Key cross-cutting rule reused everywhere: minor units end-to-end, every
minor↔major crossing via `currency_exponent()` (AM-5), `Decimal` never float,
one rounding mode (`ROUND_HALF_UP`), missing rate degrades (null/excluded+flag)
and never 500s.

## Dependency delta (`apps/api/pyproject.toml`) — in S1

Current `[project].dependencies` (verified): `httpx`, `anthropic`, `minio`
already main deps. Delta: add **`apscheduler>=3.10,<4`** (3.x `AsyncIOScheduler`
per D3 — 4.x is a rewrite with a different API, pin below it; exact floor from
current release at impl) to `[project].dependencies`; `uv lock` regenerated once.
No other dependency changes in the whole scope.

---

# S1 — rates-infra-and-migration   (tier: FULL)

**Depends on:** — · **Contract-touching:** no (no OpenAPI-visible route; regen not needed)

## Files

New:
- `apps/api/alembic/versions/0005_exchange_rates_goals_and_tx_snapshot.py` — ALL scope DDL (D14).
- `apps/api/src/budget_api/models/exchange_rate.py` — `ExchangeRate` (D2, verbatim).
- `apps/api/src/budget_api/models/goal.py` — `Goal` + `GoalContribution` (D10, verbatim; one file, one aggregate).
- `apps/api/src/budget_api/services/fx_rates.py` — `FxRateFetcher`, `FetchedRate`, `FxFetchError` (D3 seam).
- `apps/api/src/budget_api/services/fx_jobs.py` — `fetch_daily_rates`, `catch_up_needed` (D3/D4 orchestrator; first sanctioned DB-touching services module).
- `apps/api/tests/test_fx_rates.py` — fetcher payload/derivation unit tests.
- `apps/api/tests/test_fx_jobs.py` — job tests against real DB via fake fetcher.

Modified:
- `apps/api/src/budget_api/models/__init__.py` — re-export the three new models.
- `apps/api/src/budget_api/models/transaction.py` — add snapshot pair columns (model side of D5; used from S3, but the model must match 0005 for `alembic check`):
  ```python
  base_amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
  base_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
  # __table_args__ additions:
  CheckConstraint("(base_amount_minor IS NULL) = (base_currency IS NULL)", name="base_snapshot_pair"),
  CheckConstraint("base_amount_minor >= 0", name="base_amount_minor_non_negative"),
  CheckConstraint("base_currency ~ '^[A-Z]{3}$'", name="base_currency_format"),
  ```
  `>= 0`, not `>= 1`: an auto-computed snapshot of a tiny amount can legally
  quantize to 0 minor units (e.g. 1 minor RUB → USD); only *user-supplied*
  overrides are `ge=1` at the schema layer (S3).
- `apps/api/src/budget_api/config.py` — settings block:
  ```python
  fx_scheduler_enabled: bool = True          # D3 gate; tests construct apps with False
  fx_fetch_hour_utc: int = 17
  fx_fetch_minute_utc: int = 30
  fx_backfill_days: int = 400                # D4 (OQ-3 default)
  fx_http_timeout_seconds: int = 30
  frankfurter_base_url: str = "https://api.frankfurter.app"
  nbrb_base_url: str = "https://api.nbrb.by"
  ```
  All defaulted ⇒ existing explicit `Settings(...)` sites need no env. Base URLs
  as settings so /test can point at a local stub if ever needed.
- `apps/api/src/budget_api/app.py` — fetcher + scheduler wiring (below).
- `apps/api/pyproject.toml` — apscheduler; `uv lock`.
- `apps/api/tests/conftest.py` — two changes (below).

## Migration 0005 (exactly per D14: all DDL, additive, symmetric downgrade)

`revision="0005"`, `down_revision="0004"`; op-style mirrors 0004 (`op.f(...)` names).
`upgrade()` order:
1. `op.create_table("exchange_rates", ...)` — D2 columns verbatim: composite
   `PrimaryKeyConstraint("base", "quote", "as_of_date", name=op.f("pk_exchange_rates"))`,
   `rate` `sa.Numeric(18, 8)`, `provider` String(16), `fetched_at` tz-aware
   `server_default=sa.text("now()")`; CHECKs `ck_exchange_rates_rate_positive`
   (`rate > 0`), `ck_exchange_rates_base_format`, `ck_exchange_rates_quote_format`
   (`~ '^[A-Z]{3}$'`). No secondary index (the PK btree IS the lookup index, D2).
2. `op.create_table("goals", ...)` — D10 columns; CHECKs `ck_goals_target_minor_positive`
   (`target_minor > 0`), `ck_goals_currency_format`; `archived`
   `server_default=sa.false()`; FK `fk_goals_users_user_id` CASCADE;
   `op.create_index(op.f("ix_goals_user_id"), "goals", ["user_id"])`.
3. `op.create_table("goal_contributions", ...)` — D10; CHECK
   `ck_goal_contributions_amount_minor_nonzero` (`amount_minor <> 0`); FK
   `fk_goal_contributions_goals_goal_id` CASCADE;
   `op.create_index(op.f("ix_goal_contributions_goal_id_occurred_at"), ..., ["goal_id", "occurred_at"])`.
4. `op.add_column("transactions", ...)` × 2 (snapshot pair, nullable, NO backfill — D5)
   + the three CHECK constraints via `op.create_check_constraint` (paired-nullability,
   `>= 0`, format).

`downgrade()` fully symmetric, reverse order: drop tx CHECKs + columns; drop
`goal_contributions`; drop `goals` (index then table); drop `exchange_rates`.
Drift guard: `alembic upgrade head && alembic check` after writing models.

## services/fx_rates.py (D1/D3 — stateless, Settings-only, NO models/DB)

```python
@dataclass(frozen=True)
class FetchedRate:
    base: str; quote: str; rate: Decimal; as_of_date: date; provider: str

class FxFetchError(Exception):
    def __init__(self, provider: str, code: str) -> None:  # HTTP_ERROR | TIMEOUT | BAD_PAYLOAD
        ...

class FxRateFetcher:
    def __init__(self, settings: Settings) -> None: ...
    async def fetch_frankfurter_latest(self) -> list[FetchedRate]          # 1 pair: EUR→USD
    async def fetch_frankfurter_history(self, start: date, end: date) -> list[FetchedRate]
    async def fetch_nbrb_latest(self) -> list[FetchedRate]                 # 5 pairs (D1 table)
    async def fetch_nbrb_history(self, start: date, end: date) -> list[FetchedRate]
```

Per-provider granularity is deliberate: the job owns per-provider try/except
isolation (D3). HTTP via httpx inside; payload interpretation extracted into
**pure module-level helpers** so the math is unit-testable without HTTP mocks:

```python
def _parse_frankfurter(payload: dict) -> list[FetchedRate]     # reads payload["date"] (provider's own as-of, D3)
def _parse_nbrb(payloads: dict[str, dict]) -> list[FetchedRate]  # USD/EUR/RUB raw docs → 5 canonical pairs
def _derive_nbrb(b: dict[str, Decimal], as_of: date) -> list[FetchedRate]
    # b(X) = Decimal(Cur_OfficialRate) / Decimal(Cur_Scale)  — Cur_Scale HONORED, never assumed 1 (D1)
    # BYN→X = 1/b(X);  RUB→USD = b(RUB)/b(USD);  RUB→EUR = b(RUB)/b(EUR)
    # default Decimal context throughout; ONLY the final rate quantized to
    # Decimal("1E-8"), ROUND_HALF_UP (D1/D6 — one rounding mode)
```

Missing/malformed keys → `FxFetchError(provider, "BAD_PAYLOAD")`; httpx timeout →
`TIMEOUT`; non-2xx → `HTTP_ERROR`. NBRB as-of comes from `Cur_Date` per document.

**[SL-4] Verify-at-implementation steps (explicit, owned by S1):**
1. **frankfurter RUB absence probe (D1)** — at /test (not pytest): one live
   `GET {frankfurter}/latest?base=EUR&symbols=USD` must succeed AND a probe for
   RUB must confirm ECB publishes no RUB. If frankfurter DOES serve RUB, **STOP
   and re-groom D1** (5 of 6 pairs ride on this assumption's complement).
2. **NBRB `Cur_Scale`** — the implementing engineer verifies against a real NBRB
   payload at /test that RUB arrives with scale ≠ 1 (typically 100) and the
   stored BYN→RUB rate is plausible (≈ 0.02–0.05 range, not 100× off).
3. **NBRB dynamics range limit (D4)** — verify the `/exrates/rates/dynamics/{cur_id}`
   ≤365-day-per-request limit at implementation; `fetch_nbrb_history` chunks the
   400-day window into ≤365-day requests unconditionally (2 windows) so the code
   is correct whichever way the limit reads.

## services/fx_jobs.py (D3/D4 — the DB-writing orchestrator)

```python
CANONICAL_PAIRS: tuple[tuple[str, str], ...] = (("EUR","USD"), ("BYN","USD"),
    ("BYN","EUR"), ("BYN","RUB"), ("RUB","USD"), ("RUB","EUR"))

async def fetch_daily_rates(sessionmaker: async_sessionmaker[AsyncSession],
                            fetcher: FxRateFetcher, *, backfill_days: int) -> None:
    # 1. emptiness probe: SELECT EXISTS on exchange_rates → empty ⇒ history mode
    #    (last `backfill_days` days, D4), else latest mode.
    # 2. per provider, in its OWN try/except (FxFetchError + Exception):
    #    log warning with provider name, continue — one provider failing never
    #    skips the other (D3), and the job NEVER raises.
    # 3. upsert every FetchedRate: pg_insert(ExchangeRate).on_conflict_do_update(
    #       index_elements=["base","quote","as_of_date"],
    #       set_={"rate": ..., "provider": ..., "fetched_at": func.now()})  # D3 idempotency

async def catch_up_needed(session: AsyncSession, *, today: date) -> bool:
    # True iff any canonical pair lacks a row with as_of_date >= today - 3 days
    # (D3 boot catch-up trigger). One query: count distinct (base, quote) with
    # recent rows, compare against len(CANONICAL_PAIRS).
```

## app.py wiring (D3 — lifespan-managed, the engine precedent)

In `create_app`: `app.state.fx_fetcher = FxRateFetcher(resolved)` (constructed
once, next to `receipt_parser` — the seam pytest swaps). In the lifespan, after
sessionmaker construction, when `resolved.fx_scheduler_enabled`:

```python
scheduler = AsyncIOScheduler()
scheduler.add_job(fetch_daily_rates, CronTrigger(hour=resolved.fx_fetch_hour_utc,
                  minute=resolved.fx_fetch_minute_utc, timezone="UTC"),
                  kwargs=dict(sessionmaker=..., fetcher=app.state.fx_fetcher,
                              backfill_days=resolved.fx_backfill_days))
async with app.state.sessionmaker() as session:          # one local DB read; NO external HTTP at boot
    if await catch_up_needed(session, today=date.today()):
        scheduler.add_job(fetch_daily_rates, next_run_time=datetime.now(UTC), kwargs=...)
scheduler.start()
app.state.scheduler = scheduler
# finally-block: scheduler.shutdown(wait=False) BEFORE engine.dispose()
```

When disabled: no scheduler object, no jobs, no boot DB read.

## conftest.py changes (D3 testability)

1. In `make_client._make`: `overrides.setdefault("fx_scheduler_enabled", False)`
   (mirrors the `rate_limit_enabled` line) — the multi-app pattern must never
   spawn background jobs or make boot HTTP.
2. In `_clean_tables`: add `await conn.execute(text("DELETE FROM exchange_rates"))`
   after the users delete. **This is load-bearing:** `exchange_rates` has NO user
   FK, so the existing per-row user cascade does not touch it — without this, one
   test's seeded rates leak into another test's no-rate assertions. `goals` /
   `goal_contributions` cascade via the user FK chain and need nothing.

No pytest constructs an app with `fx_scheduler_enabled=True`: the APScheduler
wiring itself (cron registration, boot catch-up firing) is verified live at /test
(qa-checklist's one real fetch); pytest covers `fetch_daily_rates` and
`catch_up_needed` directly at the seam.

## Tests (S1)

`tests/test_fx_rates.py` (pure parse/derive helpers — the merchant.py precedent
for internal pure branchy logic; no HTTP mocking):
1. `test_nbrb_derivation_honors_cur_scale` — canned NBRB docs with RUB at
   `Cur_Scale=100` vs a doctored `Cur_Scale=1`: the two produce BYN→RUB rates
   100× apart with exact expected `Decimal`s (both arms contrasted — the
   assume-scale-1 bug cannot pass).
2. `test_nbrb_inversion_and_cross_exact` — from fixed `b(USD)/b(EUR)/b(RUB)`,
   assert all 5 pairs against hand-computed values quantized to 1E-8, including
   that RUB→USD is the cross `b(RUB)/b(USD)` (not an inversion).
3. `test_frankfurter_parse_uses_payload_date` — `as_of_date` comes from the
   payload `date` field, not today (a lag day is the contrast).
4. `test_bad_payload_raises` — parametrized missing-key payloads per provider →
   `FxFetchError(code="BAD_PAYLOAD")`.

`tests/test_fx_jobs.py` (fake fetcher at the seam; REAL DB upserts through the
sessionmaker built on `TEST_DATABASE_URL`):
5. `test_fetch_daily_rates_upserts_idempotent` — fake returns 6 pairs; run,
   re-run with one changed rate → still 6 rows, changed pair carries the new
   rate + refreshed `fetched_at` (proves the ON CONFLICT target).
6. `test_provider_isolation` — fake NBRB method raises, frankfurter returns →
   EUR→USD row present, 5 NBRB pairs absent, no exception escapes (both arms).
7. `test_backfill_triggers_on_empty_only` — recording fake: empty table → history
   methods called with a ~`backfill_days` window; table with one row → only
   latest methods called (both arms).
8. `test_catch_up_needed` — all 6 pairs recent → False; one pair stale (only old
   rows) → True; empty table → True.
9. `test_snapshot_pair_check` (in `test_fx_jobs.py` or a small DDL test) — raw
   insert of a transaction with `base_amount_minor` set and `base_currency` NULL
   → `IntegrityError` (the paired CHECK is live); `rate > 0` CHECK reject on
   `exchange_rates`.

Excluded: no column-existence smoke tests; no APScheduler-internals tests; no
test of the cron schedule value (config echo — vacuous).

---

# S2 — fx-domain-and-preview   (tier: FULL)

**Depends on:** S1 · **Contract-touching:** YES (GET /fx/convert)

## Files

New:
- `apps/api/src/budget_api/domain/fx.py` — `convert_minor`, `invert` (D6, pure).
- `apps/api/src/budget_api/services/fx_lookup.py` — read-side rate resolution
  (nearest-previous + inversion). **Addition to D13's module list** (recorded in
  Disagreements §4): D2 specifies "the rate-lookup service" but D13 names no
  home; it is DB-reading (so not `domain/`) and shared by three routers
  (fx, transactions, goals), so a dedicated small services module is warranted.
- `apps/api/src/budget_api/schemas/fx.py` — `FxConvertRead`, `FxError`.
- `apps/api/src/budget_api/routers/fx.py` — thin router, mounted at `/fx`.
- `apps/api/tests/test_fx_domain.py` — pure conversion unit tests.
- `apps/api/tests/test_fx_convert.py` — endpoint tests (rates seeded via `db_session`).
- `apps/api/tests/test_currency_exponents_sync.py` — the D9 cross-layer guard.

Modified:
- `apps/api/src/budget_api/domain/money.py` — public accessor (D6):
  ```python
  def currency_exponent(currency: str | None) -> int:
      """Minor-unit exponent; unknown/None → 2 (AM-5). Single source for domain/fx.py."""
      return _CURRENCY_EXPONENTS.get((currency or "").upper(), _DEFAULT_CURRENCY_EXPONENT)
  ```
  (`to_minor_units` refactored to call it — one lookup path.)
- `apps/api/src/budget_api/app.py` — mount `fx.router` (`prefix="/fx"`,
  `tags=["fx"]`, no `prime_rate_limit` — no `limiter.limit` route, categories-mount construction).
- `apps/api/openapi.json` + generated `schema.d.ts` — regen, committed together.

## domain/fx.py (D6 verbatim — stdlib + decimal only)

`convert_minor(amount_minor, from_currency, to_currency, rate)` exactly per the
D6 listing (minor→Decimal major→× rate→quantize to target minor, ROUND_HALF_UP;
exponents via `currency_exponent`), plus `invert(rate: Decimal) -> Decimal`
(`Decimal(1) / rate`, default context, NO quantization — D2 intermediates rule).
Cross-referenced ROUND_HALF_UP comment in both `money.py` and `fx.py` (D6).

## services/fx_lookup.py

```python
@dataclass(frozen=True)
class RateLookup:
    rate: Decimal        # to-per-one-from, full precision (inverse NOT quantized)
    rate_as_of: date     # the actual stored row's date (D2 honesty disclosure)

async def lookup_rate(session: AsyncSession, base: str, quote: str,
                      on_date: date) -> RateLookup | None:
    # 1. base == quote → RateLookup(Decimal(1), on_date)  (identity; keeps callers branch-free)
    # 2. direct: WHERE base=:b AND quote=:q AND as_of_date <= :d
    #            ORDER BY as_of_date DESC LIMIT 1   (PK leftmost-prefix range scan, D2)
    # 3. else inverse: same query on (quote, base) → invert(rate)
    # 4. else None  (caller degrades per D7/D9 — never raises)
```

## routers/fx.py — GET /fx/convert (D8)

```python
@router.get("/convert", response_model=FxConvertRead)
async def convert(
    amount_minor: int = Query(ge=0),
    from_currency: str = Query(alias="from", pattern="^[A-Z]{3}$"),   # [SL-1]
    to: str = Query(pattern="^[A-Z]{3}$"),
    on_date: date | None = Query(default=None, alias="date"),
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_session),
) -> FxConvertRead:
    # lookup_rate(session, from, to, on_date or today)
    # hit  → converted_minor = convert_minor(...); rate echoed as str, quantized
    #        to 1E-8 for DISPLAY only (stored/derived precision used for math)
    # miss → 200 {"converted_minor": null, "rate": null, "rate_as_of": null, ...} (D7/D8)
```

**[SL-1] `from` is a Python reserved word — handled exactly as the existing
`list_transactions` precedent** (`from_: date | None = Query(alias="from")`):
the Python parameter is `from_currency`, the wire query param stays `from`.
OpenAPI emits `{"name": "from", "in": "query"}`; openapi-typescript generates
`query: { from: string; to: string; ... }` — `from` is a legal TS property name
(reserved words are fine as object keys), so the generated client is clean.
**Regen verification line (R7 precedent):** the S2 /implement report confirms the
generated `schema.d.ts` shows the `/fx/convert` query type with a literal `from`
key, un-mangled; anything else is STOP-and-report, not a client-side cast.

Schema: `FxConvertRead(converted_minor: int | None, rate: str | None,
rate_as_of: date | None, from_currency: str (serialization_alias="from"), to: str,
amount_minor: int)` — echo fields per the D8 response sketch. `FxError` mirrors
`TransactionError` (unused by routes today — declared only if a business 4xx
appears; auto `HTTPValidationError` covers malformed params, no responses=
override needed on a GET, DELETE-precedent).

Auth-required, no rate limit (DB-only read, transactions precedent). Route is
`/convert` — no path params, no ordering concerns.

## tests/test_currency_exponents_sync.py — the D9 cross-layer guard

Location: `apps/api/tests/` (runs in every backend CI/pytest run — the layer
that owns `domain/money.py`). Path resolution, monorepo-relative:

```python
_SHARED_TS = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "currencies.ts"
```

(`parents[3]` of `apps/api/tests/<file>` = repo root; no reliance on cwd.)

**FAIL, not skip, when the file is absent** — concurring with the senior lead:
a skip would turn a moved/renamed `currencies.ts` into a permanently-green dead
guard, which is exactly the drift scenario the test exists to kill. A loud
`pytest.fail("currencies.ts not found at <path> — the exponent guard is dead; fix the path")`
forces the path to be updated the moment the layout changes.

Parsing: regex over the literal object — entries `^\s*([A-Z]{3}): (\d+),` between
`CURRENCY_EXPONENTS` and the closing `};`, plus `DEFAULT_CURRENCY_EXPONENT = (\d+)`.
Assertions (non-vacuous by construction):
- parsed dict `== money._CURRENCY_EXPONENTS` exactly (both directions of drift caught);
- parsed default `== money._DEFAULT_CURRENCY_EXPONENT`;
- `len(parsed) >= 20` — regex-rot guard: an extraction bug that returns an empty
  dict must fail loudly, not vacuously pass against an accidentally-empty twin.

## Contract regen (S2)

New path `GET /fx/convert` + `FxConvertRead`. Regen + commit both artifacts;
`test_openapi_export.py` drift test enforces.

## Tests (S2)

`tests/test_fx_domain.py` (pure):
1. `test_cross_exponent_conversion` — parametrized, hand-computed expectations:
   RUB→JPY (exp 2→0), USD→BHD (exp 2→3), USD→EUR (2→2); same rate, three
   different scalings — the "plain multiply" bug fails all non-2→2 rows.
2. `test_round_half_up_boundary` — a conversion landing exactly on .5 minor
   rounds up; contrast .49 rounding down (both arms of the mode).
3. `test_converts_to_zero_minor` — 1 minor RUB at a small rate → 0 (legal
   output; S3 stores it — pins the `>= 0` CHECK decision).
4. `test_invert_full_precision` — `invert(rate) * rate` round-trips to 1 within
   default-context precision; contrast that quantizing the inverse first would
   not (documents WHY no intermediate quantization).

`tests/test_fx_convert.py` (endpoint; rates seeded as `ExchangeRate` rows via
`db_session` — no fetcher involved):
5. `test_convert_direct_rate` — seeded EUR→USD row; response `converted_minor`,
   `rate` string, `rate_as_of` == seeded date.
6. `test_convert_inverse_rate` — only RUB→USD seeded; `?from=USD&to=RUB` succeeds
   via inversion (the day-one RUB-base path, D2).
7. `test_convert_nearest_previous` — rows dated d-5 and d-1; query at d →
   uses d-1 and DISCLOSES `rate_as_of = d-1`; query at d-3 → uses d-5 (both arms
   of the range scan).
8. `test_convert_no_rate_degrades` — unseeded pair → 200 with all-null triple
   (never 404/500, D7).
9. `test_convert_identity` — `from == to` → `converted_minor == amount_minor`, rate "1".
10. `test_convert_requires_auth` — 401 without token (one auth test for the router).

Excluded: malformed-param 422s (auto-Pydantic, QA-curl-owned per grooming split).

---

# S3 — tx-snapshot-and-aggregates   (tier: FULL)

**Depends on:** S2 · **Contract-touching:** YES (TransactionCreate/Update/Read, SummaryRead)

## Files

New:
- `apps/api/src/budget_api/services/tx_totals.py` — snapshot-aware converted
  aggregation (D9 buckets), shared by summary (S3) and the goals free-balance
  window (S5). **Addition to D13's module list** (Disagreements §4): the
  codebase rule is "aggregate SQL sits with its router at the first consumer;
  the second extracts" — but this scope KNOWS its second consumer (S5) at
  grooming time, so building it extracted avoids S5 refactoring S3 code.

Modified:
- `apps/api/src/budget_api/schemas/transaction.py` — D5 contract fields (below).
- `apps/api/src/budget_api/routers/transactions.py` — create/PATCH decision
  table + summary rewired through `tx_totals`.
- `apps/api/tests/test_transactions.py` — extended (snapshot + summary cases).
- `apps/api/openapi.json` + generated `schema.d.ts` — regen.

## schemas/transaction.py (D5 contract, additive/backward-compatible)

```python
# TransactionCreate: + currency: str | None = Field(default=None, pattern="^[A-Z]{3}$")
#                      (null/omitted → server stamps profile.base_currency — existing behavior)
#                    + base_amount_minor: int | None = Field(default=None, ge=1)
# TransactionUpdate: + currency: str | None = Field(default=None, pattern="^[A-Z]{3}$")
#                    + base_amount_minor: int | None = Field(default=None, ge=1)
# TransactionRead:   + base_amount_minor: int | None
#                    + base_currency: str | None
# SummaryRead:       + unconverted_count: int          (D9 — REQUIRED field, see web ripple)
```

Format-only validation (D7): the API accepts any `^[A-Z]{3}$` code (the receipts
D8 exotic-currency gap closure); the supported-set restriction is the WEB
picker's job (plan-web).

## Create decision table (D5)

Let `base` = `profile.base_currency` at capture (the existing
`_get_or_create_profile` read); `cur` = payload currency or `base` when
null/omitted.

| payload | behavior |
|---|---|
| `currency` null/omitted | stamp `base`; snapshot `NULL/NULL` (existing behavior, byte-compatible) |
| `currency == base` (sent explicitly), no `base_amount_minor` | same as above |
| `currency == base` + `base_amount_minor` non-null | **422 `BASE_AMOUNT_WITHOUT_CURRENCY`** (D5) |
| `currency != base` + `base_amount_minor` non-null | store the override: `base_amount_minor` as sent, `base_currency = base` |
| `currency != base`, `base_amount_minor` omitted/null | auto-compute: `lookup_rate(base=cur, quote=base, on=occurred_at)`; hit → `convert_minor(...)` stored + `base_currency = base`; miss → snapshot `NULL/NULL` (D7 no-rate) |

(On create, omitted and explicit-null `base_amount_minor` are equivalent — there
is no pre-existing override to discard.)

## PATCH decision table (D5, **[SL-2]** — exhaustive)

Definitions: `fields = payload.model_fields_set`; *conversion inputs* =
`{amount_minor, currency, occurred_at}`; `eff_cur` = payload currency if
`"currency" in fields` else `tx.currency`; `base` = `profile.base_currency` at
PATCH time (loaded via the same `_get_or_create_profile`); *recompute* =
auto-convert `eff_amount` at `eff_occurred_at` rate via `lookup_rate` →
store result + `base_currency = base`, or `NULL/NULL` on rate miss.

| # | field combo | outcome |
|---|---|---|
| 1 | `"currency" in fields`, explicit null | **422 `CURRENCY_REQUIRED`** (NOT NULL column — the `*_REQUIRED` house pattern) |
| 2 | `eff_cur == base` (incl. PATCH changing currency TO base) and `base_amount_minor` absent or explicit null | snapshot **cleared to `NULL/NULL`** — never recomputed into a redundant self-copy (D5 nullability rationale: a base-currency row's `amount_minor` IS its base amount; a copy would go silently stale on base change) **[SL-2 headline case]** |
| 3 | `eff_cur == base` and `base_amount_minor` sent non-null | **422 `BASE_AMOUNT_WITHOUT_CURRENCY`** (same rule as create; checked against `eff_cur`, so "PATCH currency→base + override" in one payload is rejected, not half-applied) |
| 4 | `eff_cur != base`, `base_amount_minor` sent non-null | **honor explicit override**: store as sent + `base_currency = base` (override wins by being the stored value — regardless of whether conversion inputs also changed) |
| 5 | `eff_cur != base`, `base_amount_minor` sent explicit null | **discard override → recompute** (the "un-override" affordance; see Disagreements §2 — deliberate deviation from nullable-clears, because a bare clear would misrepresent "no rate existed" and D5's invariant is snapshot-present-when-rate-exists) |
| 6 | `eff_cur != base`, `base_amount_minor` absent, ≥1 conversion input in `fields` | **recompute** (no stale snapshot survives an edit unnoticed — D5; covers base→foreign currency change, which POPULATES a previously-NULL snapshot) |
| 7 | `eff_cur != base`, `base_amount_minor` absent, no conversion input touched (note/category/merchant-only PATCH) | **keep** the stored snapshot untouched |

Rows 2/3 use `eff_cur`, so every combination of {currency changed to base,
currency changed to foreign, currency untouched} × {override sent, null sent,
absent} is covered by exactly one row. Stale-base snapshots (`base_currency !=`
current profile base) need no PATCH handling: they are a READ-time concern
(bucket 3 below) until any conversion-input PATCH recomputes them against the
current base via row 5/6.

`_serialize` adds the two snapshot fields.

## services/tx_totals.py + summary rework (D9)

```python
@dataclass(frozen=True)
class ConvertedTotals:
    income_minor: int
    expense_minor: int
    by_bucket: dict[tuple[uuid.UUID | None, str], int]   # (category_id, kind) → total
    unconverted_count: int

async def converted_totals(session, user_id: uuid.UUID, base: str,
                           date_from: date, date_to_exclusive: date) -> ConvertedTotals:
```

Implementation shape (D9 verbatim — SQL hot path + Python fold-in):
- **SQL pass (buckets 1+2):** one grouped query over the period with
  `effective = CASE WHEN currency = :base THEN amount_minor
               WHEN base_currency = :base THEN base_amount_minor END`
  (ELSE NULL — excluded from SUM). CASE order is load-bearing: after a base
  change RUB→EUR, a row `currency=EUR, base_currency=RUB` hits arm 1 (its native
  amount IS the base amount now) — the D5 stale-snapshot bypass for free.
  `GROUP BY category_id, kind` — one query serves totals AND by_category.
- **Python pass (bucket 3):** fetch rows
  `WHERE currency != :base AND (base_currency IS NULL OR base_currency != :base)`
  (structurally rare); per row `lookup_rate(row.currency, base, row.occurred_at)`
  → hit: `convert_minor` and fold into the matching (category_id, kind) bucket;
  miss: `unconverted_count += 1`, row excluded from every sum (exclude+flag,
  never error, never mix currencies — D9).

`summary()` in the router becomes a thin consumer: month-window computation and
`SummaryRead` assembly stay; the CASE/fold logic moves into `converted_totals`.
`SummaryRead.unconverted_count` surfaces the flag. The list endpoint's semantics
are UNCHANGED (native rows + the two new read fields).

**Web contract ripple (flag for plan-web, T3/T4 obligations):**
`SummaryRead.unconverted_count` is a new REQUIRED field and `TransactionRead`
gains two nullable fields — the regen changes the keyed response shapes that
T3/T4 query-key/PATCH-builder disciplines depend on. plan-web must consume the
regen'd `schema.d.ts` (render "N операций не сконвертированы — нет курса" off
the flag) and keep AM-5 discipline on the new nullable `base_currency` (a null
NEVER decodes at the base currency's exponent). Handoff point: after S3's
regen commit.

## Contract regen (S3) — TransactionCreate/Update/Read + SummaryRead deltas. Commit both artifacts.

## Tests (S3) — extend `tests/test_transactions.py`

Rates seeded directly as `ExchangeRate` rows via `db_session` (profile base is
RUB by default; USD tests ride the stored-RUB→USD-inverted path naturally).

Create:
1. `test_create_foreign_currency_auto_snapshot` — seed RUB→USD; POST
   `currency="USD"` → row stores `currency="USD"`, `base_currency="RUB"`,
   `base_amount_minor == convert_minor(amount, USD, RUB, 1/rate)` hand-computed;
   response echoes both.
2. `test_create_override_wins` — same POST + explicit `base_amount_minor` →
   stored byte-for-byte as sent, NOT the auto value (contrast with test 1's
   auto value — both arms).
3. `test_create_no_rate_null_snapshot` — unseeded exotic currency → 201,
   snapshot `NULL/NULL` (D7 degradation; contrast: with an explicit override it
   stores even without a rate).
4. `test_create_base_amount_without_currency_422` — base-currency create +
   `base_amount_minor` → 422 `BASE_AMOUNT_WITHOUT_CURRENCY`.
5. `test_create_null_currency_backward_compatible` — omitted currency behaves
   exactly as before (stamped base, `NULL/NULL`) — the pre-3.2 wire contract.

PATCH (the decision table, one test per row where non-trivial):
6. `test_patch_currency_to_base_clears_snapshot` — foreign tx WITH snapshot;
   PATCH `currency=<base>` → snapshot `NULL/NULL`, `amount_minor` untouched
   (**[SL-2]**: cleared, never a redundant recompute; the contrast is test 7
   where a foreign target recomputes).
7. `test_patch_conversion_input_recomputes` — PATCH `amount_minor` (snapshot
   stale) → recomputed from stored rate; also PATCH `occurred_at` across a rate
   boundary (two seeded dates) → recomputed at the NEW date's rate (proves
   `eff_occurred_at` is used, not the old one).
8. `test_patch_override_survives_and_wins` — PATCH `amount_minor` +
   `base_amount_minor` together → override stored, no recompute (row 4 beats row 6).
9. `test_patch_explicit_null_discards_override` — tx with user override; PATCH
   `base_amount_minor: null` → recomputed auto value replaces it (contrast with
   test 10 where absence keeps it — the omitted-vs-null fork, both arms).
10. `test_patch_untouched_keeps_snapshot` — note-only PATCH on an overridden tx
    → snapshot byte-identical (row 7).
11. `test_patch_base_to_foreign_populates` — base-currency tx; PATCH
    `currency="USD"` → snapshot populated (row 6's populate arm).
12. `test_patch_currency_explicit_null_422` — `CURRENCY_REQUIRED`.
13. `test_patch_currency_to_base_with_override_422` — one payload:
    `currency=<base>` + `base_amount_minor` → 422 (row 3's eff_cur subtlety).

Summary (D9):
14. `test_summary_buckets_and_flag` — one user, four rows in one month:
    (a) base-currency row [bucket 1], (b) foreign row with valid snapshot
    [bucket 2 — the OVERRIDE value must be what's summed, not a recompute],
    (c) foreign row with no snapshot + seeded rate [bucket 3 folded, per-category
    too], (d) foreign row, no rate [excluded, `unconverted_count == 1`].
    Assert exact `income/expense/net` and `by_category` totals hand-computed;
    the same fixture asserts all four buckets so every arm contrasts the others.
15. `test_summary_stale_base_snapshot_falls_back` — row with
    `base_currency != profile base` (seeded via db_session to simulate a past
    base change) + rate available → summed via display-time conversion of the
    NATIVE amount (bucket 3), NOT the stale snapshot value (both values differ
    in the fixture — non-vacuous).
16. `test_summary_no_foreign_rows_unchanged` — all-base month → totals identical
    to the pre-3.2 semantics, `unconverted_count == 0` (backward-compat pin).

Excluded: re-tests of ownership/no-oracle (unchanged code paths), pure-Pydantic
pattern rejections (QA-curl).

---

# S4 — goals-domain   (tier: FULL — PM guidance, money math)

**Depends on:** S1 only nominally (pure module; no imports beyond stdlib +
`decimal`/`datetime`) · **Contract-touching:** no

## Files

New:
- `apps/api/src/budget_api/domain/goals.py` — the six D11 functions, signatures verbatim.
- `apps/api/tests/test_goals_domain.py` — pure unit tests.

## Semantics resolutions (D11 gaps the plan must pin)

**free_balance floor direction [directive: resolve precisely].** D11 says "floor
toward zero conservatism" — imprecise for negatives. Resolution: **floor toward
−∞** (plain Python `//`), computed as ONE division on the difference of sums:

```python
def free_balance_minor(monthly_income_minor, monthly_expense_minor) -> int:
    # len(income) == len(expense) == n (caller invariant; assert). n == 0 → 0.
    # return (sum(income) - sum(expense)) // n
```

Reasoning: conservatism here means "never overstate the money available for
goals". For positive averages, floor-toward-−∞ == truncation (both understate).
For negative averages they diverge: avg = −100.33 → toward-zero gives −100
(overstates available by 0.33), toward-−∞ gives −101 (understates). Toward-−∞ is
the conservative direction on BOTH signs; single-division avoids compounding two
floors (⌊i/n⌋−⌊e/n⌋ ≠ ⌊(i−e)/n⌋ in general). Recorded as Disagreement §1
(wording correction, not a design change).

**is_realistic on a reached target.** D11's literal `needed <= available` returns
False for `needed == 0, available < 0` — an already-reached goal labeled
unrealistic. Resolution: `needed <= 0 → True` short-circuit ("nothing needed is
always realistic"), else the D11 formula. Disagreement §2; pinned by a
contrasting test.

**split_by_priority with insufficient free balance.** "Fill each fully before the
next" leaves the partial-fill case implicit. Resolution: sequential
`alloc = min(monthly_needed, remaining)` — the first unfilled goal receives the
partial remainder, later goals 0. (All-or-nothing rejected: it would leave free
money unallocated, which no waterfall description survives explaining.)

**ceil implementation:** integer ceil via `-(-remaining // divisor)` — no float,
no `math.ceil` on Decimals.

## Tests (S4) — every D11 edge pinned, each with a contrasting arm

`months_until`: (a) deadline past → 0 and same-month → 0 (floor-at-0 both);
(b) day-of-month ignored — `today=Jan 31, deadline=Feb 1` → 1 (the doc'd
"by May" semantics; contrast a naive day-diff which would give 0).
`monthly_needed`: (c) target reached → 0; (d) `months_left <= 0` → full
remaining (deadline-passed honesty); (e) ceil at EXACT division vs one-off
(300/3 → 100, 301/3 → 101 — both arms, never-under-asks).
`free_balance_minor`: (f) empty → 0; (g) positive non-exact avg floors down
(301 diff/3 → 100); (h) **negative non-exact avg floors toward −∞**
((0−301)/3 → −101, NOT −100 — the resolution's pin, contrasting (g));
(i) single-month history works (n=1 caller-truncation case).
`is_realistic`: (j) `needed == available` → True (boundary);
(k) `available <= 0, needed > 0` → False; (l) `needed == 0, available < 0` →
True (the Disagreement §2 pin, contrasting (k)).
`months_to_target`: (m) reached → 0; (n) `available <= 0` → None (the honest
"unreachable"); (o) ceil parity with (e).
`suggested_deadline`: (p) Jan 31 + 1 → Feb 28 and, in a leap year, Feb 29
(month-end clamp both arms); (q) + 12 months crosses the year.
`split_by_priority`: (r) two goals, free covers first + half of second →
{full, partial} (partial-fill resolution pin); (s) tie on priority → caller
order (created_at) decides, asserted by swapping input order and getting swapped
winners (non-vacuous tie test); (t) `free <= 0` → all zeros; (u) a zero-needed
goal takes 0 and does NOT block later goals.

No IO, no fixtures, no DB — plain sync test functions.

---

# S5 — goals-api   (tier: **FULL** — my proposal, reasoning below)

**Depends on:** S1 (tables), S3 (`tx_totals`, `fx_lookup`), S4 (domain) ·
**Contract-touching:** YES (entire /goals surface)

**Tier reasoning.** PM left this tier to the plan. The receipts-R8 STANDARD
rationale was "no external integration, no new auth surface, no money math" —
S5 fails two of three: it is a NEW auth surface (fresh router with its own
`_load_own` + a nested resource whose cross-user matrix — foreign goal, foreign
contribution, contribution under the wrong goal — is new code, not a reused
validated load path), and the realism/waterfall glue is money-adjacent
computation feeding user-facing numbers (the 3-full-month window, goal↔base
conversion at latest rate, per-goal degradation semantics) where subtle bugs
live precisely OUTSIDE the pure functions S4 proved. The R8 escalation clause
would fire on this content anyway; proposing FULL up front is cheaper than
escalating mid-flight. → **FULL**.

## Files

New:
- `apps/api/src/budget_api/schemas/goal.py` — DTOs below.
- `apps/api/src/budget_api/routers/goals.py` — router, mounted at `/goals`.
- `apps/api/tests/test_goals_api.py` — router tests.

Modified:
- `apps/api/src/budget_api/app.py` — mount (`prefix="/goals"`, `tags=["goals"]`,
  no rate limit / no priming — categories-mount construction, D12).
- `apps/api/openapi.json` + generated `schema.d.ts` — regen.

## schemas/goal.py

```python
class GoalCreate(BaseModel):
    name: str                      # trim, 1..100 (validator; _clean_note-style)
    target_minor: int = Field(ge=1)
    currency: str = Field(pattern="^[A-Z]{3}$")     # format-only (D7)
    deadline: date | None = None
    priority: int | None = None                     # None → appended last (max+1)
    initial_saved_minor: int | None = Field(default=None, ge=1)   # → first contribution row (D10/OQ-5)

class GoalUpdate(BaseModel):       # model_fields_set discipline (transactions precedent)
    name: str | None = None                         # explicit null → 422 NAME_REQUIRED
    target_minor: int | None = Field(default=None, ge=1)   # null → TARGET_REQUIRED
    currency: str | None = Field(default=None, pattern="^[A-Z]{3}$")  # null → CURRENCY_REQUIRED
    deadline: date | None = None                    # explicit null CLEARS (nullable)
    priority: int | None = None                     # null → PRIORITY_REQUIRED
    archived: bool | None = None                    # null → ARCHIVED_REQUIRED

class GoalRead(BaseModel):         # D12 list-item shape + per-goal degradation [SL-3]
    id, name, target_minor, currency, deadline, priority, archived, created_at
    saved_minor: int               # SUM(contributions) — computed, OQ-5
    completed: bool                # derived: saved >= target (D10)
    monthly_needed_minor: int      # in GOAL currency (pure D11 — always computable)
    realistic: bool | None         # null iff realism_unavailable
    months_to_target: int | None   # null: unreachable OR unavailable
    suggested_deadline: date | None
    allocated_monthly_minor: int   # waterfall share, in PROFILE BASE currency (see note)
    realism_unavailable: bool      # PER-GOAL: no goal→base rate (D-List below)

class GoalListRead(BaseModel):
    items: list[GoalRead]          # ordered (priority, created_at)
    free_balance_minor: int        # base currency; computed over convertible rows
    realism_unavailable: bool      # TOP-LEVEL: free-balance window degraded (D-List)

class ContributionCreate(BaseModel):
    amount_minor: int              # validator: != 0 (signed, D10)
    occurred_at: date | None = None    # None → today (server-side default)
    note: str | None = None            # _clean_note reuse

class ContributionRead(...);  ContributionList(items, total)   # transactions envelope
class ProgressPoint(month: str, contributed_minor: int, saved_end_minor: int)
class GoalError(detail: str)       # mirrors TransactionError
```

`allocated_monthly_minor` is in the **profile base currency** — it is a share of
the base-currency free balance ("how much of your free money goes here monthly");
`monthly_needed_minor` stays in the goal's currency. Both documented in field
descriptions; flagged to plan-web (mixed-currency card rendering, AM-5/T4
formatMoney-with-row-currency discipline applies per-field).

## D-List: missing-rate semantics for the list endpoint (**[SL-3]** — adopting the senior recommendation, argued)

Per-goal vs top-level, defined precisely:

- **Per-goal `realism_unavailable = true`** iff `lookup_rate(goal.currency, base,
  today)` misses (latest-rate lookup, D10). Consequences for THAT goal only:
  `realistic = null`, `months_to_target = null`, `suggested_deadline = null`,
  `allocated_monthly_minor = 0`, and the goal is **excluded from the waterfall
  input** (its unconvertible need must not consume or distort other goals'
  allocations). `monthly_needed_minor`, `saved_minor`, `completed` still
  computed (goal-currency math, no conversion needed).
- **Top-level `realism_unavailable = true`** iff the free-balance computation
  itself was degraded — i.e. `converted_totals` over the 3-full-month window
  reported `unconverted_count > 0` (D9 rows excluded from the sums). The number
  shown is then a lower-confidence free balance; every per-goal figure derived
  from it inherits that caveat via the top-level flag.
- Base-currency goals can never be per-goal-unavailable (identity lookup).

Why this and not the architecture's single top-level flag: one exotic-currency
goal must not null the whole screen — every other goal's math is perfectly
computable, and collapsing them all punishes the common case to simplify the
rare one. The two flags answer two different user questions ("can I trust THIS
goal's numbers" vs "can I trust the free-balance baseline") and cost one boolean
per item. Recorded as Disagreement §3 (schema refinement of D10/D12's flag).

## routers/goals.py

Error style per D12: `GoalError` UPPER_SNAKE codes, user-scoped `_load_own_goal`
(foreign == missing → 404 `GOAL_NOT_FOUND`, no-oracle), `_UNPROCESSABLE` anyOf
union (`GoalError` + `HTTPValidationError`) — transactions `_UNPROCESSABLE`
construction copied verbatim (V2/AM-5: never suppress the auto arm).

Computed-math helper (private to the router — it is presentation assembly, not
domain):

```python
async def _assemble_goal_reads(session, user_id, goals, *, today: date) -> tuple[list[GoalRead], int, bool]:
    # 1. profile base ← _get_or_create-style read (read-only fallback on GET, summary precedent)
    # 2. saved per goal: one grouped SUM over goal_contributions (single query, all goals)
    # 3. free balance: 3 FULL calendar months window [first_of(month-3), first_of(month));
    #    converted_totals(...) per month (3 calls or one grouped variant) →
    #    free = free_balance_minor([incomes], [expenses]); top_flag = any unconverted_count > 0
    # 4. per goal: monthly_needed (goal currency, pure); rate = lookup_rate(goal.currency, base, today)
    #    rate miss → per-goal degradation (D-List); hit → needed_base = convert_minor(needed, goal.cur, base, rate);
    #    available_in_goal_cur = convert_minor(free, base, goal.cur, invert(rate)) for
    #    is_realistic/months_to_target/suggested_deadline (callers convert — D11's one-currency rule)
    # 5. waterfall: split_by_priority(free, [(id, needed_base, priority)] for convertible,
    #    non-archived, non-completed goals, in (priority, created_at) order)
```

Endpoints (D12 surface, verbatim):
- `POST /goals` → 201; default priority = user's `max(priority) + 1` (one
  scalar query, 0 rows → 0); `initial_saved_minor` creates the first
  contribution (`occurred_at = today`) in the SAME session/commit (atomic, D10).
- `GET /goals?include_archived=false` → `GoalListRead` via `_assemble_goal_reads`.
- `GET /goals/{id}` → single `GoalRead` — computed via the SAME assembler over
  the user's full active goal set (allocated_monthly is a whole-portfolio
  number; computing it against one goal would lie), then the one item returned.
- `PATCH /goals/{id}` — `model_fields_set` discipline; `*_REQUIRED` 422s per
  schema block; `deadline` explicit-null clears; currency change relabels the
  ledger only (D12 — no contribution rewrite; web warns).
- `DELETE /goals/{id}` → 204; contributions CASCADE (D12).
- `POST /goals/{id}/contributions` → 201. Goal loaded **`with_for_update()`**
  (row lock) so the SUM-invariant check serializes against concurrent
  contribution writes to the same goal; then when `amount_minor < 0`:
  `SUM(existing) + amount < 0` → 422 `CONTRIBUTION_EXCEEDS_SAVED` (D10 —
  boundary: exactly-to-zero is allowed).
- `GET /goals/{id}/contributions?limit&offset` → `{items, total}`, ordered
  `occurred_at DESC, created_at DESC` (transactions pagination precedent;
  same limit bounds `ge=1 le=200`).
- `DELETE /goals/{id}/contributions/{contribution_id}` → 204; contribution
  loaded scoped by BOTH `goal_id` (path, own-goal-checked first) and id →
  404 `CONTRIBUTION_NOT_FOUND` for foreign/missing/wrong-goal alike (no-oracle);
  same FOR-UPDATE + SUM guard (deleting a positive row may not push SUM < 0).
- `GET /goals/{id}/progress?months=12` (`ge=1 le=60`) → `date_trunc('month', occurred_at)`
  grouped `SUM` for the window + one pre-window base SUM; `saved_end_minor` =
  Python cumulative (base + running). Empty months emitted with
  `contributed_minor = 0` (chart-ready — the client renders, never computes).

## Contract regen (S5) — full /goals surface. Commit both artifacts. Handoff point for plan-web's goals UI.

## Tests (S5) — `tests/test_goals_api.py`

Fixtures reuse `_register_and_login`/`_create_tx` helpers; rates seeded via
`db_session` as in S3.

CRUD/auth:
1. `test_create_with_initial_saved_atomic` — POST with `initial_saved_minor` →
   goal + exactly one contribution row; `saved_minor` echoed; contrast: without
   it → zero contributions.
2. `test_default_priority_appends` — two creates → priorities 1, 2 (or 0,1 —
   pinned); explicit priority honored.
3. `test_list_order_and_archived_filter` — three goals (priority tie broken by
   created_at, asserted); archived goal absent by default, present with
   `include_archived=true` (both arms).
4. `test_goal_no_oracle_404` — foreign goal on GET/PATCH/DELETE and on
   POST contributions → 404 `GOAL_NOT_FOUND`, byte-identical to missing.
5. `test_patch_mechanics` — deadline explicit-null clears; `TARGET_REQUIRED` on
   explicit null; currency change leaves contribution rows untouched.
6. `test_delete_cascades_contributions` — row-count assertion.

Money/computed (the FULL-tier meat):
7. `test_computed_math_happy` — seeded 3 full months of base-currency tx
   history + one base-currency goal with deadline → exact `free_balance_minor`,
   `monthly_needed_minor`, `realistic`, `allocated_monthly_minor` hand-computed.
8. `test_partial_current_month_excluded` — heavy income tx in the CURRENT month
   must not move `free_balance_minor` (contrast: same tx dated last month does).
9. `test_waterfall_allocation` — two goals, priorities 1/2, free covers first +
   part of second → {full, partial}; a third completed goal allocated 0 and
   excluded (assembler filter).
10. `test_foreign_currency_goal_converts` — USD goal under RUB base with seeded
    RUB→USD rate → `monthly_needed_minor` in USD, `realistic` computed against
    converted free balance, allocation in base (hand-computed via the inverse
    rate — pins the [SL-3] happy path AND the allocated-in-base decision).
11. `test_per_goal_realism_unavailable_isolated` — **the [SL-3] pin**: two
    goals, one in an unseeded exotic currency → that goal:
    `realism_unavailable=true`, null realism fields, `allocated_monthly_minor=0`;
    the OTHER goal: fully computed, receives the full waterfall as if the
    exotic goal didn't exist; top-level flag stays FALSE (per-goal vs top-level
    contrast in one fixture).
12. `test_top_level_flag_on_degraded_window` — an unconvertible foreign tx
    inside the 3-month window → top-level `realism_unavailable=true`, per-goal
    flags unaffected (the other direction of the same contrast).

Contributions:
13. `test_contribution_invariant` — withdrawals: to exactly zero → 201;
    one minor unit beyond → 422 `CONTRIBUTION_EXCEEDS_SAVED` (boundary, both
    arms); zero amount → 422 (validator).
14. `test_delete_contribution_guarded` — deleting a positive row that would push
    SUM negative → 422; deleting-to-zero → 204 (both arms).
15. `test_contribution_no_oracle` — contribution id under the WRONG own goal →
    404 `CONTRIBUTION_NOT_FOUND` (the wrong-goal path is the fresh code).
16. `test_progress_series` — contributions across 3 months incl. a pre-window
    one → buckets + `saved_end_minor` cumulative includes the pre-window base;
    empty middle month present with 0.

Excluded: concurrency race test on the FOR-UPDATE lock (would need two
interleaved sessions for a personal-scale invariant — the lock is one line,
review-verified; a flaky race test adds no coverage), Pydantic pattern 422s
(QA-curl).

---

# Web handoff (plan-web.md's scope — contract points only)

Backend obligations, in landing order:
- **after S2:** `GET /fx/convert` in `schema.d.ts` (verified `from` key, [SL-1])
  — enables the debounced preview call in the tx form.
- **after S3:** `TransactionCreate/Update` currency + `base_amount_minor`,
  `TransactionRead` snapshot pair, `SummaryRead.unconverted_count` — enables the
  currency picker + editable converted section + the summary degradation banner.
  AM-5 binding on all new money decode paths; `SUPPORTED_CURRENCIES` constant in
  `packages/shared` is frontend-owned (R3 precedent) — plan-web adds it next to
  `CURRENCY_EXPONENTS` (D7).
- **after S5:** the /goals surface — enables the goals screen (server-side
  calculator only; the web renders, never computes — D8/D12 stance).
- Receipts S6 retirement item: the foreign-currency warning banner is replaced
  by real currency pass-through (D5 contract closure) — plan-web owns.

---

## Existing patterns reused (per subtask, consolidated)

- `Query(alias="from")` — `list_transactions` precedent → `/fx/convert` [SL-1].
- `model_fields_set` omitted-vs-null + `*_REQUIRED` 422 — transactions PATCH → tx snapshot PATCH, goals PATCH.
- `_UNPROCESSABLE` anyOf union + `_NOT_FOUND` — transactions → fx (n/a), goals (verbatim).
- User-scoped `_load_own` no-oracle — transactions/receipts → goals (+ nested contribution variant).
- `app.state` seam + pytest fake — `receipt_parser` → `fx_fetcher`.
- Lifespan-owned resource with `finally` teardown — engine → scheduler.
- `pg_insert(...).on_conflict_do_update` — merchant map → rate upsert.
- `{items, total}` envelope + limit/offset bounds — transactions list → contributions list.
- `_get_or_create_profile` (POST) / read-only fallback (GET) — reused as-is for base-currency reads.
- ROUND_HALF_UP — `to_minor_units` → all conversion/quantization (D6).
- Migration style: `op.f()` names, symmetric downgrade, `alembic check` gate — 0004 → 0005.

## Disagreements with architecture (numbered — none silent)

1. **D11 `free_balance_minor` "floor toward zero" is the wrong direction for
   negatives** (wording correction). Conservatism = never overstate available
   money; toward-zero OVERSTATES a negative average (−100.33 → −100). Shipped
   semantics: floor toward −∞ via one integer division on the difference of
   sums (also avoids compounding two per-average floors). Pinned by S4 tests
   (g)/(h). Design intent (conservatism) unchanged — only the rounding
   direction for the negative branch is corrected.
2. **D5 PATCH `base_amount_minor: null` = discard-override-and-recompute, not
   clear-to-NULL** (gap fill, deliberate deviation from the nullable-clears
   house rule). A bare clear would store "no snapshot", which reads as "no rate
   existed" (D7's null) and silently downgrades the row to bucket-3 read-time
   conversion; recompute preserves D5's snapshot-present-when-rate-exists
   invariant AND gives users the only possible "un-override" affordance. The
   nullable-clears rule is about user-owned nullable data; the snapshot pair is
   server-managed. PATCH table row 5; pinned by S3 test 9.
3. **Per-goal `realism_unavailable` added to `GoalRead`** ([SL-3], schema
   refinement of D10/D12 which carried the flag top-level only). One exotic
   goal must not null the whole response; the top-level flag is reserved for a
   degraded free-balance window (D9 unconverted rows). Argued in D-List; pinned
   by S5 tests 11/12.
4. **Two services modules beyond D13's list** (additions, not conflicts):
   `services/fx_lookup.py` (D2 names the lookup behavior but D13 gives it no
   home; DB-reading, three router consumers) and `services/tx_totals.py` (the
   codebase's "second consumer extracts" rule — both consumers are IN this
   scope, so it is born extracted rather than refactored two subtasks later).
5. **`is_realistic(needed=0, available<0)` → True** (D11 literal formula gives
   False, labeling a reached goal unrealistic). `needed <= 0` short-circuits
   True. Pinned by S4 test (l).

## Open questions (for senior-lead — recommendation = default that ships)

1. **PATCH row 5 semantics (Disagreement 2):** confirm explicit-null-recomputes
   over explicit-null-clears. Veto cost before S3: one table row + one test.
2. **`allocated_monthly_minor` currency = profile base** (not goal currency).
   Recommended: it is a share of the base-currency free balance; converting it
   per-goal would compound roundings and confuse the "sum of allocations ≤ free
   balance" invariant the UI can otherwise display. Web renders it with the
   base currency code (per-field currency, T4 discipline). Veto cost: one
   convert call in the assembler.
3. **`is_realistic` reached-goal short-circuit (Disagreement 5)** — rubber-stamp
   requested since it touches a D11 signature's documented contract.

(OQ-1..7 from architecture.md are PM-level and not re-litigated here; this plan
implements their recommendations — notably (b) snapshot storage, two providers,
400-day backfill, format-only validation, no `saved_minor` column, test-time
exponent guard, waterfall split.)

## Risks

- **Scheduler on the event loop (first APScheduler use):** a hung provider call
  inside the job blocks nothing (async httpx with `fx_http_timeout_seconds`),
  but a bug in job wiring only surfaces live — mitigated by the /test catch-up
  observation (empty table → rows appear) in the qa-checklist; pytest cannot
  cover `AsyncIOScheduler.start()` semantics honestly.
- **Provider assumptions (D1):** the frankfurter-RUB probe is a STOP gate [SL-4];
  NBRB payload shape (`Cur_OfficialRate`/`Cur_Scale`/`Cur_Date` casing) verified
  at implementation against the live API before the parse helpers freeze.
- **`from` param in generated client [SL-1]:** low risk (legal TS key), but the
  regen verification line is a hard STOP-and-report if the generator mangles it.
- **Summary performance:** the summary now runs 2 queries + per-bucket-3-row
  lookups; structurally rare rows keep it flat at personal scale — 4.1 revisits
  with EXPLAIN (D9's recorded stance).
- **Backward compatibility:** S3's create with omitted `currency` is
  byte-compatible with the pre-3.2 contract (test 5 pins it); `SummaryRead`
  gains a required field — a BREAKING read-shape change for the web, gated by
  the regen-and-commit-together rule (web builds against the new type).
- **Base-currency change UX:** stale snapshots silently fall back to
  display-time conversion (D5) — correct but subtle; the web must not present
  the override as active after a base change (plan-web concern, flagged).
- **Migration ordering:** single 0005 means S1 must land first — enforced by the
  dependency chain; downgrade symmetry exercised by every pytest session
  teardown (conftest `downgrade base`).

## Test guidance for QA (qa-checklist inputs)

- Live-layer strategy per task.md: mock at the `app.state.fx_fetcher` seam in
  ALL pytest; exactly ONE real fetch at /test — recommended shape: start the
  API with an empty `exchange_rates` table, observe boot catch-up populate ≥6
  canonical-pair rows within the backfill window, then curl `GET /fx/convert`
  against a real stored rate. The [SL-4] frankfurter-RUB probe rides the same
  /test session.
- Curl-owned (not pytest): Pydantic pattern 422s (`from=us`, bad month, limit
  bounds), 401s on the new routers, the `/fx/convert` response shape against
  the committed openapi.json.
- STOP-rule split (receipts R2 style): conversion returning WRONG numbers or a
  500 on any no-rate path = STOP; a provider being down at /test (catch-up logs
  a warning, table stays empty) = recorded degradation, re-run when reachable —
  the app surviving it IS the D3 design working.
- Per-subtask tier pipeline per §5 of receipts grooming-review: FULL =
  implement → diff gate → QA → code-reviewer → meta-review for S1/S2/S3/S4/S5
  (all FULL per this plan; senior-lead may downgrade S5 against my reasoning).
