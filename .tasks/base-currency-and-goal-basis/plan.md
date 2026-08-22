# Implementation Plan: base currency editable + free-balance basis (backend B1)

Scope `base-currency-and-goal-basis`, API half. Binding: `task.md` D1/D2 and its
rejected-options list. **Review tier: FULL** (contract change + money math) →
code-reviewer runs; no `/review-pr` substitute needed.

**Sequencing dependency (hard):** start only after the in-flight
`recurring-dates-and-income` B1 contract pair is COMMITTED. `openapi.json` +
`schema.d.ts` are currently dirty in the working tree; regenerating on top of an
uncommitted pair mixes two scopes into one contract diff. Nothing else in this
plan touches recurring files.

## Approach

- **D1 (editable base currency)** — two fields join `ProfileUpdate`; the router
  stays the same omit/null/value machine it already is. No snapshot recompute,
  no migration, no data touched: `tx_totals.py` bucket order already handles a
  post-switch stale snapshot (arm 1 wins over arm 2), so a base switch is a
  DISPLAY change by construction. New server-side supported-currency twin lands
  next to the exponent twin in `domain/money.py` (same TS file is the source),
  pinned by a second test class in the existing sync test.
- **D2 (basis resolution)** — the "months WITH data" rule is MONTH SELECTION,
  i.e. domain math, so it goes into `domain/goals.py` (the assembler "computes
  no math itself" charter). One new pure predicate/counter is shared by
  `free_balance_minor` and by the assembler's basis decision, so the two can
  never disagree about what a month with data is. Numerator is unchanged (sum of
  all months = sum of data months); only the DENOMINATOR changes from hard 3 to
  the data-month count.
- **Return shape** — `assemble_goal_reads` currently returns a 4-tuple; adding
  the basis makes it a 5-tuple whose last two elements are both `str`
  (`base`, `basis`). Positional swap there would be silent (the router passes
  by keyword into the response model). Replace the tuple with a frozen
  dataclass `GoalPortfolio`. Three call sites only (goals router ×2, advisor
  router ×1), and one of them already unpacks `_, _, _, _`.

## Files to modify

- `apps/api/src/budget_api/domain/money.py` — `SUPPORTED_CURRENCIES: frozenset[str]`
  = {USD, EUR, RUB, BYN}, twin of `SUPPORTED_CURRENCIES` in
  `packages/shared/src/currencies.ts`, with the "edit together" docstring note the
  exponent table already carries. Lives here, NOT in a new module: one TS file ↔
  one python module keeps the sync test single-file. No behaviour change to the
  exponent path.
- `packages/shared/src/currencies.ts` — comment-only fix: the block above
  `SUPPORTED_CURRENCIES` currently states "No server twin exists to sync with …
  so no cross-layer guard test applies here". That becomes FALSE with this diff;
  same-commit correction (docs-lie rule).
- `apps/api/src/budget_api/schemas/profile.py`
  - `base_currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)`.
    Nullable in the TYPE only, to keep `model_fields_set` semantics; the explicit
    null is refused in the router with the `*_REQUIRED` house code (GoalUpdate
    precedent), NOT by making the field non-optional. Membership is NOT a
    `Literal`: a Literal yields an HTTPValidationError array instead of the
    fixed `CURRENCY_NOT_SUPPORTED` string code.
  - `monthly_income_minor: int | None = Field(default=None, ge=0, le=MAX_MINOR_AMOUNT)`
    — nullable for real (null CLEARS, the country/language rule); `ge=0` mirrors
    the `monthly_income_minor_non_negative` CHECK so a negative is a 422 and not
    an IntegrityError 500; `le=MAX_MINOR_AMOUNT` is the app-wide D14 bound
    (imported from `schemas/transaction.py`, already the precedent import).
  - New `class ProfileError(BaseModel): detail: str` (the GoalError/LimitError
    shape) — the router has never declared an error body before.
  - Module docstring: the "base_currency is absent because it is its own scope"
    paragraph is now stale → rewrite to state the D1 decision (display-only
    switch, snapshots untouched, supported-set validation).
- `apps/api/src/budget_api/routers/profile.py`
  - `_UNPROCESSABLE` anyOf block (`ProfileError` + `HTTPValidationError`), copied
    from `routers/goals.py`; declared on PATCH only.
  - PATCH: explicit-null guard for `base_currency` → 422 `BASE_CURRENCY_REQUIRED`;
    membership check against `SUPPORTED_CURRENCIES` → 422 `CURRENCY_NOT_SUPPORTED`
    (case-sensitive, no normalization — the COUNTRY_PATTERN house rule); then
    assign. `monthly_income_minor` assigns straight through (null clears).
  - Docstring: drop "base_currency and monthly_income_minor are not writable here".
- `apps/api/src/budget_api/domain/goals.py`
  - `months_with_data(...) -> int` (new, pure) — a month counts when
    `income > 0 or expense > 0 or unconverted > 0` (D2 verbatim).
  - `free_balance_minor(...)` gains a third REQUIRED sequence
    (`monthly_unconverted_count`); denominator becomes `months_with_data(...)`;
    0 when that is 0. No default value on the new parameter — a default would be
    exactly the drift trap that lets a caller keep the old /3 behaviour silently.
    Single floor-toward-−∞ division preserved (module docstring §rounding stays
    true); docstring updated to spell the new denominator.
- `apps/api/src/budget_api/services/profile_reads.py` — `read_profile_settings()`
  returning a frozen `ProfileSettings(base_currency, monthly_income_minor)`, still
  non-writing; `read_base_currency` re-expressed through it (its 5 existing
  callers keep their signature). Rationale: the assembler needs the declared
  income and the base in ONE `session.get`, not two.
- `apps/api/src/budget_api/services/goal_reads.py`
  - collect `unconverted_counts` per window month (already have
    `totals.unconverted_count` in the loop — currently only OR-ed into the flag);
  - basis resolution: `months_with_data > 0` → `"average"`; else declared income
    not None → `"declared"` with `free = monthly_income_minor` (interpreted in
    base, no conversion — D2 / rejected-options §3); else `"none"`, `free = 0`;
  - return `GoalPortfolio(items, free_balance_minor, realism_unavailable, base_currency, free_balance_basis)`.
  - **Degraded × basis interaction (answer to the brief's question): no
    special-casing needed and none must be added.** `unconverted_count > 0`
    IMPLIES the month has data, so `window_degraded=True` forces basis
    `"average"`; conversely basis `declared`/`none` can only occur with every
    count 0, i.e. `realism_unavailable=False` by construction. Record this as an
    invariant comment; it is the reason the top-level flag stays meaningful.
- `apps/api/src/budget_api/schemas/goal.py`
  - `FreeBalanceBasis = Literal["average", "declared", "none"]`;
  - `GoalListRead.free_balance_basis: FreeBalanceBasis` (NOT optional, no
    default — an absent basis on the wire would make the web guess). NB: the
    brief calls this class `GoalsListResponse`; the real name is `GoalListRead`.
  - `free_balance_minor` field comment updated (average over data months /
    declared income).
- `apps/api/src/budget_api/routers/goals.py` — 2 call sites to the dataclass;
  `free_balance_basis=portfolio.basis` into `GoalListRead`.
- `apps/api/src/budget_api/routers/advisor.py` — 1 call site (`portfolio.items`).
  No advisor context/prompt change: the advisor already reads
  `monthly_income_minor` separately.
- `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` —
  `pnpm openapi`, same commit, AFTER the recurring B1 commit. `schema.d.ts` never
  hand-edited.
- `docs/backend.md` — `/profile` line (currently implicit) + `/goals` basis
  field; `docs/conventions.md` — the "TWO twins" money bullet gains the supported
  set. (senior-lead owns docs at scope close; flag if he prefers to do it.)

## New files

- None. (`ProfileSettings`, `GoalPortfolio`, `SUPPORTED_CURRENCIES` all land in
  existing modules next to their siblings.)

## Code skeletons

```python
# domain/goals.py
def months_with_data(
    monthly_income_minor: Sequence[int],
    monthly_expense_minor: Sequence[int],
    monthly_unconverted_count: Sequence[int],
) -> int: ...

def free_balance_minor(
    monthly_income_minor: Sequence[int],
    monthly_expense_minor: Sequence[int],
    monthly_unconverted_count: Sequence[int],
) -> int:
    # n = months_with_data(...); 0 -> 0; else (sum(inc) - sum(exp)) // n
    ...
```

```python
# services/goal_reads.py
@dataclass(frozen=True)
class GoalPortfolio:
    items: list[GoalRead]
    free_balance_minor: int
    realism_unavailable: bool
    base_currency: str
    free_balance_basis: FreeBalanceBasis

async def assemble_goal_reads(
    session: AsyncSession, user_id: uuid.UUID, goals: list[Goal], *, today: date
) -> GoalPortfolio: ...
```

```python
# routers/profile.py (PATCH body, relevant arm only)
if "base_currency" in fields:
    if payload.base_currency is None:
        raise HTTPException(422, detail="BASE_CURRENCY_REQUIRED")
    if payload.base_currency not in SUPPORTED_CURRENCIES:
        raise HTTPException(422, detail="CURRENCY_NOT_SUPPORTED")
    profile.base_currency = payload.base_currency
```

## Tests (pytest — agreed list, nothing beyond it)

Kept — each one names behaviour that can break and is not already covered:

1. `tests/test_currency_exponents_sync.py` — NEW class parsing
   `SUPPORTED_CURRENCIES = ['USD', …] as const` and comparing to the python
   frozenset, both directions, with the same "file missing → fail, not skip" and
   "non-empty parse" guards as the exponent class. (Guards the whole point of a
   hand-written twin.)
2. `tests/test_profile.py::test_base_currency_switch_persists_and_snapshots_stay`
   — PATCH RUB→USD returns 200 with USD, GET echoes it, and a pre-existing
   transaction's `base_amount_minor`/`base_currency` are byte-identical
   afterwards (the D1 no-recompute promise; also the anti-regression for a future
   "helpful" recompute).
3. `tests/test_profile.py` parametrized 422s: `{"base_currency": "JPY"}` →
   `CURRENCY_NOT_SUPPORTED`; `{"base_currency": "usd"}` → not normalized;
   `{"base_currency": None}` → `BASE_CURRENCY_REQUIRED`; asserting the string
   codes, not just the status.
4. `tests/test_profile.py::test_monthly_income_set_and_cleared` — value → echo,
   explicit null → null (clears), `-1` → 422 (the CHECK would otherwise be a 500).
5. `tests/test_goals_domain.py` — averaging contrast: 3 months of data vs the
   SAME numerator in 1 data month (`[300,0,0]/[0,0,0]` with counts `[0,0,0]` →
   300, not 100); plus a zero-sums month with `unconverted_count=1` counting as
   data (the D2 clause that has no other witness). The 3 existing
   `free_balance_minor` tests get the third argument added.
6. `tests/test_goals_api.py::test_basis_declared_without_history` — fresh user,
   no transactions, `PATCH /profile {"monthly_income_minor": N}` →
   `free_balance_basis == "declared"`, `free_balance_minor == N`,
   `realism_unavailable is False`, and a goal's `allocated_monthly_minor` is
   non-zero (i.e. the declared number really drives the waterfall — a basis label
   alone would be a cosmetic pass).
7. `tests/test_goals_api.py::test_basis_none_without_history_or_income` — 0 / `"none"`.
8. `tests/test_goals_api.py` — the known edge from `task.md`: ONE row in one of
   the three months → basis `"average"` over 1 month (contrast against the
   existing 3-month `_seed_three_months` figure). This is the live defect's own
   regression test.

Existing test that MUST be rewritten (not deleted):
`test_profile.py::test_base_currency_is_not_writable_here` asserts the exact
behaviour D1 reverses — it becomes test 2/3 above. Call it out in the report.

Dropped as vacuous: a "declared income is not converted on base switch" test
(no conversion code exists to break); a separate `"average"`-basis happy test
(the existing `test_computed_math_happy` already pins 3-month averaging and will
now also assert the basis label — one added assertion, not a new test).

Handed to QA (live server, `qa-*@budgetqa.dev`): base switch seen end-to-end in
the goals/summary screens with a stale-snapshot row rendering as unconverted.

## Open questions

1. `BASE_CURRENCY_REQUIRED` vs reusing `CURRENCY_NOT_SUPPORTED` for the explicit
   null. Plan picks the house `*_REQUIRED` pattern (GoalUpdate precedent); if
   senior-lead prefers one code for "the client sent something unusable", say so
   before implementation — it is a one-line change but a contract-visible one.
2. `SUPPORTED_CURRENCIES` in `domain/money.py` vs a new `domain/currencies.py`.
   Plan picks money.py (single TS ↔ single py mapping); a reviewer may find the
   module name misleading since the set is not about minor units.
3. Does `docs/` get updated here or by senior-lead at scope close? Plan assumes
   the latter and lists the lines to touch.

## Risks

- **Denominator regression on the with-history user** — the whole reason to keep
  the numerator untouched and pin it with the existing `_seed_three_months`
  assertions. If any of them move, the change is wrong.
- **Silent basis for the degraded window** — if someone later adds a
  `basis="declared"` fallback for a degraded window, the top-level
  `realism_unavailable` becomes unreadable. Guarded by the invariant comment plus
  test 6's `realism_unavailable is False` assertion.
- **Contract collision** with the uncommitted recurring pair (see sequencing).
- **Base switch mid-history** is display-only by design; a reviewer expecting
  recompute will flag it — task.md D1 is the answer, no code change.
- `MAX_MINOR_AMOUNT` on income is a schema bound with no DB CHECK behind it;
  matches the app-wide D14 stance, not a new invariant.

## Estimates (AGENT-MINUTES — write / gates / review-fix)

- **Write:** 45 (schemas+router 12, domain+goal_reads+3 call sites 15, tests 15,
  contract regen 3).
- **Gates** (`pnpm lint` + `pyright` + `pytest` full suite, incl. reruns): 15.
- **Review-fix circles:** 2 circles × 8 min = 16 (FULL tier; likely findings =
  the two open questions above and docstring accuracy).

## AMENDMENT A1 (senior-lead, 2026-08-22, post-QA ruling — task.md D1)

The plan above predates the ruling on QA flag 1: a base-currency SWITCH CLEARS
`monthly_income_minor` server-side (a stored number silently re-denominated
RUB→BYN is a ~30x-wrong "declared" basis; honest empty state wins). Router arm
grows one clause, with three edges pinned:

- Clear ONLY when the new base differs from the STORED one (a no-op
  `RUB→RUB` PATCH must not wipe income).
- If the SAME PATCH sets both `base_currency` and `monthly_income_minor`, the
  sent income WINS (user re-declares in the new currency in one request):
  process the base arm first, income arm second — existing arm order already
  gives this, add the invariant comment.
- The PATCH response (= whole profile) then carries `monthly_income_minor:
  null` — the web seeds its cache from it, no extra endpoint work.

Tests: the dropped "not converted on base switch" test is REPLACED (not
restored) by: (a) switch clears income; (b) switch + income in same PATCH keeps
the sent value; (c) same-value switch keeps income. (a) and (b) are genuinely
breakable arm-order behaviour; (c) guards the no-op edge.

PM approvals recorded 2026-08-22: `BASE_CURRENCY_REQUIRED` for explicit null;
twin list lives in `domain/money.py` next to the exponent table; `GoalPortfolio`
dataclass replaces the tuple; `currencies.ts` stale comment fixed same commit;
old read-only test REWRITTEN into the new trio, not deleted. docs/ lines are
senior-lead's at scope close — plan's file list stands as the pointer.

## AMENDMENT A2 (senior-lead, 2026-08-22 — OQ-2 resolution from plan-web.md)

`GoalListRead` additionally carries `free_balance_months_with_data: int`
(0..3 — the `months_with_data` count over the window; the assembler already
computes it for the denominator, so this is exposure, not new math). Purpose:
the web `average` copy must not present a 1-data-month figure as a 3-month
average; with the count on the wire the copy can say "по N из 3 месяцев с
активностью" and keep the familiar sentence when N == 3. Field is NOT
optional, no default; 0 whenever basis != "average" is fine and expected.
Contract regen covers it in the same pass. Tests: assert it in the existing
TC-8 known-edge test (count == 1) — no separate test.
