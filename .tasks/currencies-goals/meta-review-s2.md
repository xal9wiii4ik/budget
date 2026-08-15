# Meta-Review (senior-lead): S2 — fx-domain-and-preview

Reviewer verdict: APPROVE (2 nits, no blockers/majors/minors). My rulings:

- **Finding 1 (default 28-digit Decimal context bounds the "single rounding"
  claim in `convert_minor`) — PARTIALLY AGREE, no change.** Technically true,
  practically unreachable: `amount_minor` arrives from bigint-bounded storage
  (≤ ~9.2e18), so the `major * rate` product stays within 28 significant
  digits for any rate below ~1e10 — orders of magnitude beyond every real
  currency pair. A `localcontext` would be defensive noise guarding a value
  no client can send. Declining; the docstring's claim holds for the
  representable input domain.

- **Finding 2 (omitted-`date` → UTC-today branch unpinned by any test) —
  AGREE, and it is ALREADY COVERED live.** TC-S2-3's curl deliberately omits
  `date` (`?amount_minor=100000&from=USD&to=RUB`) and asserts
  `rate_as_of` ≤ today ∧ ≥ today−7 — the default-date branch was exercised on
  the wire against real rates and passed. No pytest addition warranted
  (asserting "server used today" in pytest reduces to re-testing
  `datetime.now`, which is config-echo territory). No action.

## Fix round

None required — zero actionable findings.

## Verification trail

- My diff gate (pre-QA): purity (domain/fx.py imports decimal +
  domain.money only), Decimal-never-float, one explicit ROUND_HALF_UP,
  unquantized inverse with the contrasting drift test, 200-null degradation,
  401 wall, guard test FAIL-not-skip with exact private-table equality,
  contract pair additive and regenerated together, literal `from` in both
  artifacts. Gates re-run by me: pytest 136 passed, ruff check/format clean,
  pyright 0 errors.
- QA (TC-S2-1..5 + TC-Z1): all green, no STOP; recompute-from-echoed-rate
  diff 0; live openapi deep-equals committed; rates table 2282 rows
  untouched. Bonus live pin: the S1 BYN→EUR hole confirmed nearest-previous
  disclosure (`date=2026-08-13` → `rate_as_of=2026-08-11`).

## Carry-forward rows ticked (grooming-review §4)

- [SL-1] literal `from` un-mangled in regenerated schema.d.ts — ✅ (regen
  line in /implement report + TC-S2-5 + exact-dict pytest assertion).
- Exponent guard test FAIL-not-skip — ✅ (diff gate).
- Contract regen+commit together — regenerated together in this tree ✅;
  the single S2 commit must include both artifacts (PM commit step).

Accepted deviations (recorded): identity/display rate echoed as
`"1.00000000"` (8-dp display rule, pinned in test); two
`reportPrivateUsage` pyright ignores in the guard test (public-accessor
comparison would hide one drift direction).

AM-3 note: both AM-3 arms are S3-owned per grooming-review §4 — nothing was
owed by S2.
