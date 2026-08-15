# Code Review — S2 (fx-domain-and-preview), scope currencies-goals

Reviewer: code-reviewer (rigorous pass per plan.md S2 spec + grooming-review §4)
Base: uncommitted working tree on HEAD e0e2280
Verified live: `uv run pytest` full suite (136 passed, PG 5443), `ruff check` clean.

## Verdict: APPROVE

The implementation matches the binding S2 spec essentially line-for-line, and the
three §4 carry-forward rows are all satisfied:

- **[SL-1]** literal `from` key confirmed un-mangled in BOTH regenerated
  artifacts: `openapi.json` emits `{"name": "from", "in": "query"}` and the
  `FxConvertRead.from` property; `schema.d.ts` shows `query: { ... from: string; ... }`
  and `FxConvertRead: { ... from: string; ... }`. The endpoint test additionally
  pins the wire key with an exact-dict assertion.
- **Exponent guard FAIL-not-skip**: `test_currency_exponents_sync.py:34-41` calls
  `pytest.fail` on a missing `currencies.ts`, with the required message shape.
- **Contract pair regenerated together**: `openapi.json` + `schema.d.ts` both in
  the diff, additive-only, and `test_openapi_export.py` drift test passes against
  the working tree.

Spot-checks that came back clean (recorded so they aren't re-litigated):

- Money math is Decimal-only end to end (grep for `float` across all seven new
  files: zero hits outside a docstring). Exactly one quantize in `convert_minor`,
  explicit `ROUND_HALF_UP`; `invert` is unquantized default-context division;
  the 1E-8 quantize in the router touches a display copy only, after
  `convert_minor` has consumed the full-precision rate. Exponents applied on both
  sides (source division, target scaling) via the new shared `currency_exponent`.
- `DivisionByZero` in `invert` is unreachable from stored data: `rate > 0` CHECK
  exists both in migration 0005 (`ck_exchange_rates_rate_positive`) and on the
  `ExchangeRate` model.
- Layering: `domain/fx.py` imports only `decimal` + `domain.money`; `schemas/fx.py`
  only Pydantic + stdlib; the lookup service returns `None` on miss and cannot
  raise; router is thin (lookup → domain → schema).
- Semantics: identity short-circuit, direct-before-inverse order, `<= date DESC
  LIMIT 1` on the composite-PK prefix, miss → 200 null triple, honest
  `rate_as_of` disclosure — all present and each pinned by a non-vacuous test
  with both arms (nearest-previous tests both the newer and older row; the
  rounding test has .5-up and .49-down; the invert test contrasts full-precision
  vs pre-quantized on a 3e8 amount where they differ by exactly 1 minor unit).
- Guard-test regex rot fails loudly, not vacuously: any plausible reformatting of
  `currencies.ts` (quoted keys, spacing, dropped trailing comma) drops entries,
  which trips either `len(parsed) >= 20` or the exact two-way dict equality.
  Comparing against the private `_CURRENCY_EXPONENTS` (not the accessor) is the
  right call and the comment explains why.
- `to_minor_units` refactor is behavior-preserving (receipts tests green) and
  `FxError` correctly omitted with rationale (no business 4xx exists).
- UTC "today" default matches the `datetime.now(UTC)` house precedent
  (`services/storage.py`); future `on_date` degrades naturally via
  nearest-previous. `amount_minor=0` is legal (`ge=0`) and the zero-result
  domain test pins the adjacent behavior.

## Findings

1. **[nit]** `apps/api/src/budget_api/domain/fx.py:33-36` — "rounding happens
   exactly once" is technically bounded by the default Decimal context
   (28 significant digits): `major * rate` silently rounds when
   digits(amount) + digits(rate) exceeds 28. With an 18-sig-digit stored rate the
   product loses exactness around amount_minor ≈ 1e11, though the loss can only
   flip the final minor unit at product magnitudes ≈ 1e27 — astronomically
   outside any real budget. No action required; if you ever want the guarantee
   literal, wrap the multiply in `localcontext(prec=...)` or add an `le=` bound
   on `amount_minor`. Not worth blocking or even changing now.

2. **[nit]** `apps/api/src/budget_api/routers/fx.py:46` — the `on_date is None →
   today` branch is the only router behavior no test exercises (every test passes
   an explicit `date`). The plan's test list deliberately omits it and the branch
   is one `or`, so this is consistent with the spec and the no-vacuous-tests
   policy; noting only so QA's curl checklist covers an omitted-`date` call once.

No blockers, no majors, no minors. Ship it.
