# Architecture: currencies-goals (roadmap 3.1–3.5, WEB-ONLY)

Architect output for scope grooming. Binding inputs: `.tasks/currencies-goals/task.md`
(verbatim user requirements), `budget-app-architecture.md` §§ Цели накоплений /
Мультивалютность / Статистика + data-model table, PLAN.md 3.1–3.5, and the
receipts-ocr carry-forwards (`.tasks/receipts-ocr/grooming-review.md` §4 AM-5, §7:
foreign-currency confirm gap D8, exponent twin-table single-sourcing).

Conventions used below: a **pair** `A→B` means base=A, quote=B, and
`rate` = quote units per 1 base unit (`amount_B = amount_A × rate`). "Supported set"
= {USD, EUR, RUB, BYN} — the closure of the six required pairs. All rates are
`Decimal`, never float (architecture doc, binding). All amounts are integer minor
units end-to-end; every minor↔major crossing goes through the exponent table
(AM-5 discipline).

Open questions for the PM are marked **OQ-n** inline and collected in §Open
questions at the end. Everything not marked OQ is a decision — PM may veto, but
these are the defaults that ship.

---

## Part 1 — FX rates (3.1)

### D1. Provider decomposition: NBRB for everything touching BYN/RUB, frankfurter (ECB) for EUR→USD

No single free provider covers the six required pairs:

- **frankfurter.app** serves ECB reference rates. It has **no BYN** (ECB never
  published a BYN reference rate) and **no RUB since 2022-03-01** (ECB suspended
  the RUB reference rate in March 2022 — high confidence from my knowledge, but
  the implementing engineer must verify with one live probe at /test and STOP if
  wrong, since 5 of 6 pairs ride on this assumption's complement).
- **api.nbrb.by** (Belarus National Bank) publishes official daily rates as
  *BYN per `Cur_Scale` units of X* for USD, EUR, RUB (RUB is typically scale 100 —
  the fetcher MUST honor `Cur_Scale` from the payload, never assume 1).

Decomposition (canonical derivations, exactly one way per pair):

| Pair | Source | Derivation |
|---|---|---|
| EUR→USD | frankfurter, direct | `GET /latest?base=EUR&symbols=USD` |
| BYN→USD | NBRB, inversion | `1 / b(USD)` |
| BYN→EUR | NBRB, inversion | `1 / b(EUR)` |
| BYN→RUB | NBRB, inversion | `1 / b(RUB)` |
| RUB→USD | NBRB, cross via BYN | `b(RUB) / b(USD)` |
| RUB→EUR | NBRB, cross via BYN | `b(RUB) / b(EUR)` |

where `b(X) = Decimal(Cur_OfficialRate) / Decimal(Cur_Scale)` = BYN per 1 unit
of X. All divisions run in the default Decimal context (28 significant digits) —
**intermediates are never quantized**; only the final stored rate is quantized to
8 decimal places (`Decimal("1E-8")`), rounding `ROUND_HALF_UP` (one rounding mode
for the whole scope — see D6). 8 dp comfortably holds the smallest required rate
(RUB→USD ≈ 0.011) with sub-basis-point resolution; rate error at 1E-8 is orders
of magnitude below one minor unit on personal-budget amounts.

Why EUR→USD from frankfurter and not the NBRB cross `b(EUR)/b(USD)`: ECB is the
issuing-side authority for EUR and the market-standard reference; the NBRB cross
is a Belarus-centric synthetic. The cost is that the FX triangle
(RUB→USD vs RUB→EUR × EUR→USD) is not exactly consistent across providers — for
a personal budget app this is noise, and each pair having exactly one canonical
derivation means no ambiguity in code or tests.

**OQ-2 (fork):** NBRB-only alternative — derive EUR→USD as `b(EUR)/b(USD)` too.
One provider, one failure mode, internally consistent triangles, one fewer HTTP
dependency. I still recommend the two-provider split above (ECB canonicality for
the one pair it can serve, and the task text explicitly warns against
one-provider assumptions), but NBRB-only is a legitimate simplification the PM
may prefer. Veto cost before implementation: trivial (delete one provider call).

### D2. `exchange_rates` schema: composite natural PK, store only the 6 canonical pairs, nearest-previous-date lookup

```python
class ExchangeRate(Base):
    __tablename__ = "exchange_rates"
    base: Mapped[str] = mapped_column(String(3), primary_key=True)
    quote: Mapped[str] = mapped_column(String(3), primary_key=True)
    as_of_date: Mapped[date] = mapped_column(Date, primary_key=True)
    rate: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    provider: Mapped[str] = mapped_column(String(16))   # "nbrb" | "frankfurter"
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 server_default=func.now())
    __table_args__ = (
        CheckConstraint("rate > 0", name="rate_positive"),
        CheckConstraint("base ~ '^[A-Z]{3}$'", name="base_format"),
        CheckConstraint("quote ~ '^[A-Z]{3}$'", name="quote_format"),
    )
```

- **PK = (base, quote, as_of_date).** Natural key; `ON CONFLICT` upsert target for
  the idempotent job (D3); and the PK btree *is* the lookup index — the hot query
  is `WHERE base=:b AND quote=:q AND as_of_date <= :d ORDER BY as_of_date DESC
  LIMIT 1`, a leftmost-prefix range scan on exactly this index. No secondary
  index needed.
- **Only the 6 directed canonical pairs are stored.** With 4 currencies there are
  12 ordered pairs = exactly the 6 required + their 6 inverses. The rate-lookup
  service derives an inverse at read time (`1/rate`, default Decimal context, no
  intermediate quantization) when `(base, quote)` is not stored but
  `(quote, base)` is. Storing inverse rows would double the table and create a
  second copy that can drift from its twin; inversion is exact-enough (28 sig
  digits) and single-sourced. This matters immediately: the default base currency
  is RUB, so converting a USD transaction needs USD→RUB = `1/rate(RUB→USD)` on
  day one.
- **Missing dates (weekends, holidays, provider lag): nearest-previous-date
  lookup, NO backfill rows.** Synthesizing weekend rows materializes a guess and
  makes "which rate was used" unanswerable; nearest-previous is the standard
  convention, costs one range-scan, and keeps the table an honest record of what
  providers published. The lookup result carries `rate_as_of` so responses can
  disclose the actual rate date (D8). No staleness cap: a stale rate beats no
  rate for a personal budget; the disclosed `rate_as_of` is the honesty
  mechanism. If NO row exists at or before the date → "no rate", handled per
  D7/D9 (never a 500).

### D3. Scheduler: lifespan-managed AsyncIOScheduler, one daily job + boot catch-up, injectable fetcher seam

First APScheduler use in the codebase — precedent-setting. `apscheduler` (3.x,
`AsyncIOScheduler`) is added to `apps/api` dependencies (blessed by the stack
section of the architecture doc).

- **Placement:** built and started inside `create_app`'s lifespan (after engine/
  sessionmaker construction), stored on `app.state.scheduler`, `shutdown(wait=False)`
  in the lifespan `finally` before `engine.dispose()`. This is the only seam that
  owns both the running loop and the sessionmaker — matches the engine precedent
  exactly.
- **Settings gate:** `fx_scheduler_enabled: bool = True` in `Settings`; the test
  suite constructs apps with it `False` (the multi-app test pattern must not spawn
  background jobs). Also `fx_fetch_hour_utc: int = 17`, `fx_fetch_minute_utc: int = 30`.
- **Seam split (storage.py / receipt_parser.py precedent, and the receipts §7
  D13 carry-forward made real):**
  - `services/fx_rates.py` — `FxRateFetcher(settings)`: stateless, Settings-only,
    **no models, no DB**. Async httpx calls to the two providers, returns a list of
    `FetchedRate(base, quote, rate, as_of_date, provider)` frozen dataclasses.
    Constructed once onto `app.state.fx_fetcher`; **pytest swaps a fake at this
    seam** — no test ever makes a live HTTP call (receipt_parser precedent, and
    the qa-checklist live-layer strategy hangs off this seam: mock in pytest, one
    real fetch at /test).
  - `services/fx_jobs.py` — `async def fetch_daily_rates(sessionmaker, fetcher)`:
    the DB-writing orchestrator. This is deliberately the FIRST services-level
    module that imports models/touches the DB — sanctioned by the receipts §7
    carry-forward ("second pipeline consumer (scheduler/batch): extract the
    background task to a services-level orchestrator"). The scheduler job and the
    boot catch-up both call this one function.
- **One job, per-provider isolation inside.** Providers publish at different
  times (ECB ≈ 16:00 CET; NBRB in the Minsk afternoon for the next effective
  date), but chasing publish times with two cron entries buys nothing: each
  provider response is stored under the provider's OWN as-of date (frankfurter's
  `date` field, NBRB's `Cur_Date`), and the nearest-previous lookup (D2) absorbs
  any lag. So: one cron job daily at 17:30 UTC (both providers have published
  their current rates by then on business days), with each provider fetched in
  its own `try/except` so one provider failing never skips the other.
- **Idempotency:** upsert `ON CONFLICT (base, quote, as_of_date) DO UPDATE SET
  rate=…, provider=…, fetched_at=now()`. Re-running the job any number of times
  converges; a provider correcting a same-day rate is absorbed.
- **Boot catch-up:** on startup (when the scheduler is enabled), if there is no
  row with `as_of_date >= today - 3 days` for any canonical pair, schedule
  `fetch_daily_rates` to run once immediately (`scheduler.add_job(..., next_run_time=now)`),
  i.e. in the background — **startup never blocks on external HTTP** and a
  provider outage at boot cannot delay or fail app start.
- **Failure behavior:** the job catches ALL exceptions per provider, logs a
  warning with the provider name and error, and returns. Stale rates stay; the
  app never crashes; **no request handler ever calls a provider** — conversion
  reads only `exchange_rates` (architecture doc, binding).

### D4. Initial backfill: one-shot 400-day historical backfill when the table is empty

Transactions with past dates already exist, and "rate on the date of the
transaction" is the doc's core conversion semantic — with no history, every
pre-existing transaction in a foreign currency would hit the no-rate path and the
main new feature would look broken on day one for its earliest data.

Minimal viable answer: when `fetch_daily_rates` runs and the `exchange_rates`
table is **empty**, fetch history for the last **400 days** (covers "a year ago"
plus lookup slack) instead of just the latest day:

- frankfurter supports range queries (`/2025-07-01..2026-08-15?base=EUR&symbols=USD`) — one call.
- NBRB supports per-currency period queries (`/exrates/rates/dynamics/{cur_id}` with
  `startDate`/`endDate`) — three calls (USD, EUR, RUB). Verify the ≤365-day-per-request
  limit at implementation; chunk into two windows if needed.

Emptiness of the table is the trigger (not a settings flag, not a marker row):
it is self-describing, idempotent, and can be re-armed manually by truncating the
table. The backfill writes through the same upsert as the daily path. This stays
inside `fetch_daily_rates` — no separate management command (YAGNI; a CLI can be
extracted if a second consumer appears). **OQ-3:** depth is a taste call — 400
days recommended; PM may shrink to 90 (cheaper, covers the 3-month realism
window and recent statistics) or veto backfill entirely (accepting no-rate flags
on all pre-3.1 dates).

---

## Part 2 — Conversion + editable override (3.2, requirement 3)

### D5. THE CENTRAL FORK — storage model for the converted amount. Recommendation: (b) nullable base-snapshot pair on `transactions`

The requirement "auto-convert, display in a separate editable section, **their
override wins**" is incompatible with pure display-time conversion: an override
that wins must be *stored somewhere*. The honest decomposition:

**(a) Pure display-time conversion** (the architecture doc's original stance).
- Base-currency change: trivially correct — every read re-converts natively. ✓
- Aggregates: convert per transaction at `occurred_at` rate at read time. ✓
- Editable override: **impossible — there is nowhere to put it.** ✗ Fails the
  binding requirement outright. Rejected.

**(b) Store a base-amount snapshot: `base_amount_minor: BigInteger | None` +
`base_currency: String(3) | None` on `transactions`** (populated only when the
transaction currency differs from the profile base at capture time).
- Create in foreign currency: server auto-converts (D6/D8), the form shows the
  result in the editable section, the POSTed value (auto or user-edited) is
  stored in the snapshot pair. Override wins because the override IS the stored
  value. ✓
- Aggregates: `currency == profile.base` → `amount_minor`;
  `base_currency == profile.base` → `base_amount_minor` (the override, honored);
  else → display-time fallback (below). ✓
- Base-currency change (doc: display-only, no recalculation): snapshots pinned
  to the OLD base become stale — detectable, because the stored `base_currency`
  no longer matches the profile. Behavior: such rows **fall back to display-time
  conversion from the native amount** at the `occurred_at` rate; the override is
  effectively bypassed while the base differs (and honored again if the user
  switches back — nothing is destroyed, nothing recalculated in storage, which
  is exactly the doc's "no recalculation" stance). An override expressed in RUB
  is meaningless in a EUR world; silently converting the override RUB→EUR would
  compound two conversions and honor neither. Documented, honest, cheap. ✓
- PATCH staleness: any PATCH that changes `amount_minor`, `currency`, or
  `occurred_at` invalidates the snapshot → the server **recomputes** it from the
  stored rate (fresh auto-convert; null if no rate), UNLESS the same PATCH
  carries an explicit `base_amount_minor` (override wins, again by being the
  stored value). A PATCH may also send `base_amount_minor` alone (re-editing
  just the converted figure). Explicit rule — no stale snapshot can survive an
  edit unnoticed. ✓
- Nullability: base-currency transactions store `NULL/NULL` (their `amount_minor`
  IS the base amount; a redundant copy would go stale on base change in the
  worst possible way — silently). CHECK constraint
  `(base_amount_minor IS NULL) = (base_currency IS NULL)` keeps the pair atomic.
- Migration/backfill: every existing row was server-stamped with the base
  currency (decision d of 1.4), so all existing rows are `NULL/NULL` — additive
  columns, **no data backfill**. ✓

**(c) Store only the rate (or rate override) per transaction.**
- Users edit an *amount*, not a rate; storing a derived rate loses the exact
  minor value they typed (round-trip through the rate re-rounds — the override
  no longer wins byte-for-byte). ✗
- Same stale-on-base-change problem as (b), with none of its directness. ✗
- Reconstructing amounts at read time re-runs rounding on every read. ✗ Rejected.

**Recommendation: (b).** It is the smallest storage that makes "override wins"
true, degrades exactly like (a) for every row that has no snapshot, needs no
backfill, and keeps the doc's base-change stance coherent. **OQ-1 (the scope's
central open question):** PM must confirm (b), or veto back to (a) — which
requires renegotiating requirement 3 with the product owner, since the editable
override cannot ship on (a).

Contract changes (closes the receipts D8 foreign-currency confirm gap):
`TransactionCreate` gains `currency: str | None = None` (null → server stamps
`profile.base_currency`, the existing behavior — fully backward compatible) and
`base_amount_minor: int | None = None` (`ge=1`; meaningful only when `currency`
is present and differs from base; if omitted the server auto-computes; 422
`BASE_AMOUNT_WITHOUT_CURRENCY` if sent with a base-currency create).
`TransactionUpdate` gains `currency` and `base_amount_minor` with the PATCH
semantics above. `TransactionRead` gains `currency` (already there), plus
`base_amount_minor: int | None` and `base_currency: str | None`. The receipt
confirm form (S6 of receipts) passes `parsed.currency` through — the web warning
banner for foreign-currency receipts is retired in this scope's web subtask.

### D6. Conversion math: pure `domain/fx.py`, minor→Decimal→rate→quantize→minor, ROUND_HALF_UP

Cross-exponent minor→minor is NOT a plain multiply (RUB exp 2 → JPY exp 0 would
be off by 100×). Canonical algorithm, pure function in `domain/fx.py` (stdlib +
`decimal` only, no IO — the money.py/merchant.py precedent):

```python
def convert_minor(amount_minor: int, from_currency: str, to_currency: str,
                  rate: Decimal) -> int:
    """amount_minor is in from_currency minor units; rate is to-per-one-from
    (major units). Returns to_currency minor units."""
    from_exp = currency_exponent(from_currency)   # exposed from domain/money.py
    to_exp = currency_exponent(to_currency)
    major = Decimal(amount_minor) / (Decimal(10) ** from_exp)   # exact
    converted = major * rate                                     # exact (Decimal)
    return int((converted * (Decimal(10) ** to_exp))
               .quantize(Decimal(1), rounding=ROUND_HALF_UP))
```

`domain/money.py` exposes `currency_exponent(currency: str | None) -> int` (a
one-line public wrapper over the existing table + default) so `domain/fx.py`
never duplicates the table. Rate *lookup* is IO and lives in the service layer
(the router/service passes the resolved `Decimal` rate in); the domain function
stays pure and unit-testable, including the inversion helper
`invert(rate) -> Decimal` (`1/rate`, default context).

**Rounding mode: `ROUND_HALF_UP`, everywhere in this scope** (conversion results,
stored-rate quantization). Justification: `domain/money.py:to_minor_units`
already established ROUND_HALF_UP as the codebase's money-rounding mode — two
modes in one small codebase is a bug factory; HALF_UP matches lay user
expectation ("0.5 rounds up") for displayed money; HALF_EVEN's bias advantage is
statistical and irrelevant at single-conversion, personal-budget scale. One mode,
one constant, cross-referenced comment in both modules.

### D7. Currency set: picker offers exactly {USD, EUR, RUB, BYN}; API validates format only; no-rate degrades, never errors

- **Web picker (tx form): exactly the supported set**, exported as
  `SUPPORTED_CURRENCIES` from `packages/shared` (next to `CURRENCY_EXPONENTS`).
  Every currency the form offers is convertible — no dead-end UX. Full-ISO-list
  rejected: 170 unconvertible options for which we could only show "no rate".
- **API: format-only validation** (the existing `^[A-Z]{3}$` model CHECK +
  schema pattern), NOT restricted to the supported set. Reason: the receipt
  confirm flow must be able to store the truth — a JPY receipt confirms as JPY
  (the whole point of the D8 gap closure), and hard-restricting the server would
  force a data lie or a dead end. In confirm mode the web picker additionally
  shows the parsed currency when it is outside the supported set.
- **No-rate behavior, defined once and reused:**
  - Conversion preview (D8): 200 with `converted_minor: null, rate: null,
    rate_as_of: null` — the form says "no rate available" and the user may type
    the base amount manually into the override field (which then stores as the
    snapshot — the system stays fully usable for unsupported currencies).
  - Create/PATCH auto-compute: snapshot stays `NULL` when no rate exists (unless
    the user supplied `base_amount_minor` explicitly).
  - Aggregates (D9): exclude + flag, never error, never silently mix currencies.

**OQ-4 (minor fork):** hard-restrict the API to the supported set instead
(422 `CURRENCY_NOT_SUPPORTED`). Cleaner invariants, but it re-opens the receipt
D8 gap for exotic-currency receipts and forecloses nothing dangerous — the
degradation path must exist anyway for rate-lag days. Recommend format-only as
above.

### D8. Conversion preview: server endpoint `GET /fx/convert`, no client-side rate math

```
GET /fx/convert?amount_minor=1250&from=USD&to=RUB&date=2026-08-10
→ 200 {"converted_minor": 99875, "rate": "79.90000000",
       "rate_as_of": "2026-08-08", "from": "USD", "to": "RUB"}
→ 200 {"converted_minor": null, "rate": null, "rate_as_of": null, ...}  # no rate
```

(`date` optional, default today; malformed params are the auto Pydantic 422;
`from`/`to` validated as 3-letter codes. Router: new thin `routers/fx.py`,
mounted at `/fx`, auth-required like everything else, no rate limit — DB-only
read, no cost driver, matching the transactions-router precedent.)

The alternative — `GET /fx/rates` shipping rates for the client to multiply —
is rejected: the client would re-implement rate lookup (nearest-previous
semantics) AND cross-exponent conversion, creating a second money-math
implementation whose drift is exactly the class of bug AM-5 exists to kill. With
the server endpoint there is ONE conversion implementation (`domain/fx.py`), the
client only decodes minor units with the row's currency via the existing shared
helpers (AM-5: a null/absent currency decodes at exponent 2, never the base
currency's exponent). Debounced calls from the form are cheap (indexed PK
lookup). The form auto-fills the editable override section from
`converted_minor` and marks it dirty once the user edits — after which previews
stop overwriting it.

### D9. Aggregates in multi-currency + exponent single-sourcing (act now, minimally)

`GET /transactions/summary` (and the list endpoint's semantics) under
multi-currency, per the doc: everything converts to the profile base at the
`occurred_at`-date rate, using the stored snapshot when it exists (D5).

Per-row resolution order (one CASE, then a small Python fallback):

1. `currency == base` → `amount_minor` (covers 100% of pre-3.2 rows).
2. `base_currency == base` (snapshot valid for the current base) → `base_amount_minor`.
3. else (foreign currency, no snapshot or stale-base snapshot) → convert
   `amount_minor` at nearest-previous `occurred_at` rate in Python via
   `domain/fx.py`; if no rate → **excluded from sums and counted**.

Implementation shape: the SQL aggregate keeps summing buckets 1+2 (the hot path
stays one indexed query — Статистика's "SQL-агрегаты на лету" stance); bucket-3
rows are fetched (they are structurally rare: only foreign-currency rows without
a usable snapshot) and folded in per category/kind in Python, where the domain
function is unit-testable. This is deliberate: a LATERAL-join rate lookup in SQL
would move money math out of `domain/` into SQL, untestable against the pure
functions, for no measurable win at personal scale. 4.1 (statistics) may revisit
with EXPLAIN evidence.

**Missing-rate policy in aggregates: exclude + flag.** `SummaryRead` gains
`unconverted_count: int` (and `unconverted_minor` is NOT summed — mixed-currency
sums are meaningless). Erroring rejected (a provider lag must never 500 the
dashboard); silently including native amounts rejected (corrupts the total by up
to orders of magnitude). The web shows the flag ("N operations not converted —
no rate"). This is the honest-degradation twin of D7.

**Exponent single-sourcing (receipts AM-1/§7 carry-forward) — ACT NOW, minimal
form.** Multi-currency makes the twin table load-bearing on every request, not
just the receipts path — the trigger recorded in receipts §7 has fired. Acting
minimally means: a **pytest cross-layer guard test** that parses
`packages/shared/src/currencies.ts` (a stable literal object; regex extraction
of `CODE: exponent` entries + the default) and asserts exact equality with
`domain/money.py`'s `_CURRENCY_EXPONENTS` + default. Drift becomes a red test on
every CI run instead of a recorded risk. Full build-time codegen (one JSON source
generating both files) is rejected FOR NOW: it adds a build step to two
ecosystems to prevent a drift the guard test already makes impossible to miss;
recorded trigger — a THIRD consumer of the table (e.g. mobile unfreeze with its
own copy, or a codegen pipeline appearing for other reasons). The runtime API
image cannot read `packages/shared` (Docker context), so any runtime
single-sourcing is a non-starter anyway; test-time is the right layer. **OQ-6**
records this as vetoable (PM may insist on full codegen or on deferring again).

---

## Part 3 — Goals (3.3 / 3.4)

### D10. Schema: `goals` + `goal_contributions`; drop `saved_minor` (computed), signed contributions, non-unique priority

```python
class Goal(Base):
    __tablename__ = "goals"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(100))
    target_minor: Mapped[int] = mapped_column(BigInteger)         # CHECK > 0
    currency: Mapped[str] = mapped_column(String(3))              # CHECK ^[A-Z]{3}$
    deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    priority: Mapped[int] = mapped_column()                       # lower = higher priority
    archived: Mapped[bool] = mapped_column(default=False, server_default=sa.false())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (Index("ix_goals_user_id", "user_id"), ...)

class GoalContribution(Base):
    __tablename__ = "goal_contributions"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    goal_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("goals.id", ondelete="CASCADE"))
    amount_minor: Mapped[int] = mapped_column(BigInteger)         # SIGNED; CHECK <> 0
    occurred_at: Mapped[date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (Index("ix_goal_contributions_goal_id_occurred_at",
                            "goal_id", "occurred_at"),)
```

- **`saved_minor` is DROPPED — computed as `SUM(goal_contributions.amount_minor)`.**
  The doc's table lists BOTH a `saved_minor` column and a contributions ledger —
  that redundancy is a classic update anomaly (every write must touch two places
  atomically forever, and any drift is silent data corruption in money). The
  ledger is already required for "прогресс по месяцам", the sum is one indexed
  aggregate over a personal-scale table, and "initial amount already saved" is
  modeled as the goal's first contribution row (created in the same transaction
  as the goal when `initial_saved_minor` is passed on create). **OQ-5:** this is
  a deliberate deviation from the doc's data-model table — PM sign-off requested;
  veto = keep the column, maintained in the same DB transaction as every
  contribution write, recomputed by a repair query if ever suspected.
- **Contribution sign: signed `amount_minor`, withdrawals are negative rows,
  `CHECK (amount_minor <> 0)`.** Withdrawals are real ("took 200 out of the
  vacation fund"). The transactions magnitude+kind precedent (1.2 verdict b) is
  NOT copied here deliberately: kind there carries expense/income *semantics*
  used in CASE aggregates and the client picker; a contribution has no third
  semantic — sign IS the semantics, and progress math is a bare SUM. The API
  guards the invariant `SUM >= 0` per goal: a withdrawal that would push the
  total negative → 422 `CONTRIBUTION_EXCEEDS_SAVED` (checked in the router
  within the write transaction).
- **Goal currency vs base for realism math (rate-date decision):** targets and
  contributions live in the goal's currency; free balance (D11) is computed in
  the profile base. The comparison converts `monthly_needed` goal→base at the
  **latest available rate** — realism is a forward-looking projection, so a
  historical `occurred_at`-style rate has no meaning here (there is no
  transaction date). No rate available → realism fields are `null` + a
  `realism_unavailable` flag (never a guess, never a 500) — same honesty policy
  as D9. Goal currency is validated format-only, picker offers the supported set
  (D7 applies unchanged).
- **Status/archive:** no status column — "completed" is DERIVED
  (`saved >= target`) and returned as a computed field; storing it would be a
  second denormalized truth. `archived` bool (categories precedent) hides a goal
  from the default list and from the priority split; archiving is manual (user
  intent, e.g. after completion), not automatic.
- **Priority:** integer, lower = higher priority, **no DB uniqueness**. A unique
  constraint would force deferred-constraint gymnastics on every reorder;
  duplicates are tolerated and tie-broken deterministically by `created_at` in
  the split math (D11). Reorder = PATCH per goal (no bulk endpoint until the UI
  proves drag-reorder needs one — YAGNI, recorded trigger).

### D11. `domain/goals.py` — pure function signatures and edge-case semantics

Pure, stdlib+decimal+datetime only, no IO, no models (merchant.py/money.py
precedent). All amounts are minor units in ONE currency per call — currency
conversion happens BEFORE these functions (callers convert; the domain never
sees two currencies). `today` is always an explicit parameter (testability).

```python
def months_until(today: date, deadline: date) -> int
    # Whole calendar months: (deadline.year - today.year) * 12
    #  + (deadline.month - today.month), floored at 0. Day-of-month ignored —
    # a deadline "May 2027" means "by May"; documenting this beats fake precision.

def monthly_needed(target_minor: int, saved_minor: int, months_left: int) -> int
    # remaining = max(target_minor - saved_minor, 0); 0 → 0 (already reached).
    # months_left <= 0 → remaining (deadline passed/this month: need it all now;
    # the realism check will call it unrealistic — honest, not an error).
    # Else ceil(remaining / months_left) (integer ceil; never under-asks).

def free_balance_minor(monthly_income_minor: Sequence[int],
                       monthly_expense_minor: Sequence[int]) -> int
    # Inputs: per-month base-currency sums for the last 3 FULL calendar months
    # (current partial month EXCLUDED — it always under-states both sides).
    # avg(income) - avg(expense), floor-rounded toward zero conservatism
    # (int division). Fewer than 3 months of history: caller passes what exists
    # (>=1 month); empty → 0. May be negative (spending exceeds income).

def is_realistic(monthly_needed_minor: int, available_monthly_minor: int) -> bool
    # needed <= available. available <= 0 and needed > 0 → False.

def months_to_target(target_minor: int, saved_minor: int,
                     available_monthly_minor: int) -> int | None
    # Reverse calc for "сдвинуть дедлайн": remaining <= 0 → 0;
    # available <= 0 → None (unreachable — the UI's honest message);
    # else ceil(remaining / available).

def suggested_deadline(today: date, months: int) -> date
    # today + months calendar months, clamped to the last day of the target
    # month (Jan 31 + 1 month → Feb 28/29).

def split_by_priority(free_minor: int,
                      needs: Sequence[tuple[uuid.UUID, int, int]],  # (goal_id, monthly_needed_minor, priority)
                      ) -> dict[uuid.UUID, int]
    # WATERFALL: sort by (priority, caller-provided order = created_at); fill
    # each goal's monthly_needed fully before the next; remainder 0 for the
    # rest; free_minor <= 0 → all zeros. Proportional split rejected: the doc
    # says priorities decide, and a proportional scheme makes every priority
    # edit reshuffle every goal's number — waterfall is explainable in one
    # sentence, which IS the product's honesty stance. (OQ-7 records the fork.)
```

Edge cases pinned by unit tests (FULL tier per PM guidance): deadline in the
past / current month; target already reached (0 everywhere, realistic); zero and
negative free balance (unrealistic + `months_to_target = None`); no transaction
history (free balance 0); ceil behavior at exact division; waterfall with ties
and with `free < first need`.

### D12. Goals API surface — CRUD + contributions + computed progress; lean DTOs; house error taxonomy

`routers/goals.py`, mounted at `/goals`, auth-required, no rate limits (DB-only
CRUD, no cost driver — transactions precedent). Error style: stable UPPER_SNAKE
codes in `detail` (`GoalError` model mirroring `TransactionError`), 404 for the
addressed resource via user-scoped `_load_own` (foreign == missing,
`GOAL_NOT_FOUND`, no-oracle), 422 for body-reference/business rejections, the
anyOf 422 union declared exactly per the transactions `_UNPROCESSABLE` precedent
(V2/AM-5 of receipts: never suppress the auto `HTTPValidationError` arm).

- `POST /goals` — create; optional `initial_saved_minor` (>0) creates the first
  contribution atomically (D10). `priority` optional, default = (user's max
  priority + 1) i.e. appended last.
- `GET /goals?include_archived=false` — list, ordered `(priority, created_at)`.
  **Response embeds computed money fields but NOT contribution rows** (lean-DTO
  rule; contributions are unbounded and have their own paginated endpoint). Each
  item: goal columns + `saved_minor` (SUM), `completed: bool`, `monthly_needed_minor`,
  `realistic: bool | null`, `months_to_target: int | null`,
  `suggested_deadline: date | null`, `allocated_monthly_minor` (this goal's
  waterfall share), and top-level `free_balance_minor: int | null` +
  `realism_unavailable: bool` (D10 no-rate case). One endpoint powers the whole
  goals screen — the calculator is server-side ONLY (the D8 stance again: no
  client re-implementation of money math; the web renders, it never computes).
- `GET /goals/{id}` — same item shape.
- `PATCH /goals/{id}` — partial via `model_fields_set` (transactions precedent):
  name, target_minor, currency, deadline (explicit null clears), priority,
  archived. NOT-NULL fields reject explicit null with `*_REQUIRED` 422.
  Currency change does NOT touch contribution rows (they are amounts in the
  goal's currency context; changing currency re-labels the ledger — the UI warns;
  re-converting history would be silent rewriting of user-entered numbers).
- `DELETE /goals/{id}` — real delete, contributions CASCADE (owned leaf subtree;
  archive covers "keep for history").
- `POST /goals/{id}/contributions` — signed `amount_minor` (`!= 0`),
  `occurred_at` (default today), optional note; 422
  `CONTRIBUTION_EXCEEDS_SAVED` when a negative row would push SUM < 0.
- `GET /goals/{id}/contributions?limit&offset` — `{items, total}` envelope
  (transactions pagination precedent), ordered `occurred_at DESC, created_at DESC`.
- `DELETE /goals/{id}/contributions/{contribution_id}` — undo path; guarded by
  the same SUM >= 0 invariant. No PATCH on contributions (edit = delete + re-add;
  a ledger row is simpler immutable).
- `GET /goals/{id}/progress?months=12` — monthly series for the chart:
  `[{month: "2026-08", contributed_minor, saved_end_minor}]` — SQL
  `date_trunc`-grouped, ready-to-render (Статистика stance: client draws, never
  recomputes).

Goal contributions and the free-balance inputs: the router computes the
3-full-month income/expense sums via the SAME conversion resolution as D9
(snapshot-aware, missing rates excluded and surfaced through
`realism_unavailable`) and feeds pure D11 functions. No goal money math in SQL
beyond SUM/GROUP BY.

---

## Part 4 — Structure, migration, decomposition

### D13. Layering and dependency direction (unchanged rules, two sanctioned firsts)

- `domain/` stays pure: `fx.py`, `goals.py` import stdlib/decimal/datetime only.
  `money.py` gains the public `currency_exponent()` accessor (D6).
- `services/` : `fx_rates.py` (fetcher — httpx, Settings-only, NO models/DB,
  injectable at `app.state.fx_fetcher`; error taxonomy: single
  `FxFetchError(provider, code)` with codes `HTTP_ERROR | TIMEOUT | BAD_PAYLOAD`,
  logged by the job, never raised past it) and `fx_jobs.py` (orchestrator —
  the first DB-touching services module, sanctioned by the receipts §7 D13
  carry-forward; the scheduler and boot catch-up are its only callers).
- `routers/` stay thin: `fx.py` (preview), `goals.py`; `transactions.py` gains
  the currency/snapshot handling and the D9 aggregate changes.
- Dependency direction: routers → services/domain/models; services(fetcher) →
  config only; services(jobs) → models + fetcher; domain → nothing internal
  except `domain/money.py`. Scheduler wiring lives in `app.py` lifespan only.
- Contract regen (`openapi.json` → `packages/api-client`) follows the receipts
  regen-and-commit-together rule for every router-touching subtask.

### D14. Migration: single 0005 for the whole scope, shipped in the first backend subtask

One migration `0005_exchange_rates_goals_and_tx_snapshot.py`: `exchange_rates`,
`goals`, `goal_contributions`, and the two `transactions` snapshot columns +
paired CHECK. Precedent: 0004 bundled the entire receipts scope's DDL in its
first subtask (S1), and every later subtask found the schema already in place —
the same shape fits here because all DDL is additive, the columns are
nullable-with-no-backfill (D5), and a single symmetric downgrade stays writable.
Per-subtask migrations rejected: three tiny interdependent migrations create
ordering coupling between subtasks for zero isolation benefit at this scale.

**Decomposition hint for backend-engineer** (the detailed subtask breakdown is
plan.md's job, not mine): rates infra (migration 0005 + models + fetcher +
scheduler + backfill; FULL) → conversion (domain/fx + tx currency/snapshot +
preview endpoint + aggregates + exponent guard test; FULL) → goals domain
(domain/goals.py + unit tests; FULL) → goals API (routers/goals.py + progress;
tier per senior-lead, money-adjacent) → web (tx-form currency picker + editable
converted section, goals UI with the honest unrealistic messaging; STANDARD;
AM-5 and the web-transactions-ui obligations T4/T8 binding). Each backend
subtask regenerates and commits the contract with its router changes.

---

## Open questions for PM (recommendation = default that ships)

| # | Fork | Recommendation |
|---|---|---|
| **OQ-1** | **Storage of the editable conversion (THE central fork):** (a) display-time only / (b) nullable base-snapshot pair on transactions / (c) rate override | **(b)** — only option that honors "override wins"; null for base-currency rows; no backfill; stale-base snapshots fall back to display-time conversion (D5) |
| OQ-2 | FX providers: frankfurter(EUR→USD) + NBRB(rest) vs NBRB-only (derive EUR→USD as a cross) | Two providers — ECB is canonical for the one pair it can serve; per-pair table in D1 |
| OQ-3 | Historical backfill depth on empty table | 400 days one-shot inside the daily job (D4); PM may shrink to 90 or drop |
| OQ-4 | Currency restriction: picker-only (API format-only) vs hard server restriction to {USD, EUR, RUB, BYN} | Picker-only — hard restriction re-opens the receipts D8 gap for exotic-currency receipts (D7) |
| OQ-5 | `goals.saved_minor`: doc lists both the column and the ledger | Drop the column, compute SUM; initial amount = first contribution row (D10) — explicit deviation from the doc's table |
| OQ-6 | Exponent twin-table single-sourcing | Act now, minimally: pytest cross-layer equality guard parsing currencies.ts; full codegen deferred to a third-consumer trigger (D9) |
| OQ-7 | Priority split of free balance | Waterfall by priority (fill in order), not proportional (D11) |

Verify-at-implementation flags (not PM questions): frankfurter's RUB absence
post-2022 (D1 — one live probe, STOP if wrong), NBRB `Cur_Scale` handling and
the dynamics-endpoint date-range limit (D4), NBRB weekend-date response
semantics (D2's nearest-previous lookup absorbs either answer).
