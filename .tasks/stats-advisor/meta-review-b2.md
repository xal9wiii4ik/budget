# Meta-review — B2a + B2b (advisor plumbing/context + SSE /advisor/ask)

Senior-lead verdicts on review-b2.md findings, plus the deviations recorded at my
two diff gates. AM-10 condition discharged: the reviewer diffed the B2a extraction
bodies programmatically against `HEAD:routers/goals.py` and approved them
explicitly (review-b2.md §AM-10).

## Reviewer findings

- **Finding 1 (MINOR, `test_rl_namespaces_are_isolated` vacuous vs its stated
  failure mode): AGREE — fixed.** The reviewer verified against the installed
  slowapi that counters are endpoint-scoped regardless of the key string, so the
  namespace-collision failure mode the test (and plan B2b-6) claims to pin cannot
  occur through it — the standing policy's "names a branch it never exercises"
  class. The grooming-time premise was wrong, not the implementation; behaviour is
  doubly isolated. Fix round: e2e test kept but recaptioned as integration sanity;
  new pure unit arm pins the factory itself (`user_rl_key("receipt")(req) !=
  user_rl_key("advisor")(req)`, same stashed user, both keys embed the user id);
  `rate_limit.py` docstring softened to "defence in depth alongside slowapi's
  per-endpoint scope". No behaviour change.
- **Finding 2 (NIT, tie-break comment says "name" but key is `str(uuid)`):
  AGREE — fixed** (comment corrected to what the code does: deterministic
  UUID-string tie-break). Sorting by resolved name was deliberately NOT adopted —
  determinism is the requirement; a name sort would be behaviour churn with no
  consumer asking for it.
- **Finding 3 (NIT, duplicated comment lines in test): AGREE — fixed** (one line
  deleted).
- **Finding 4 (NIT, prompt prose "три полных календарных месяца" can go stale
  against `ADVISOR_WINDOW_MONTHS`): PARTIALLY AGREE — fixed via staleness pin,
  not derivation.** Deriving a declined Russian numeral from the int for one word
  is machinery nobody needs (the constant is a design decision, not a knob).
  Fix round: cross-reference comments at both sites + one assertion arm tying
  `ADVISOR_WINDOW_MONTHS == 3` to the pinned prose in the render-prompt test, so
  changing the constant fails a test that points at the wording.

## Deviations accepted at my diff gates (recorded)

1. **B2a scope extension (PM directive):** the pure context layer
   (`services/advisor.py` dataclasses, `services/advisor_context.py` builder +
   `advisor_window`, 5 unit tests) pulled forward from B2b into B2a, superseding
   the plan's "no advisor_context.py" D7-YAGNI line. B2b then extended
   `services/advisor.py` with the seam.
2. **Disagreement-2 import rule refined:** `services/advisor.py` = stdlib +
   config + `domain.money` (pure, needed for major-unit rendering) + SDKs;
   still NO models/schemas/services/db. The no-raw-transactions property remains
   an import-graph property; reviewer verified structurally.
3. **Scoped RUF001/RUF003 per-file ignores** for the two Cyrillic-prose files —
   homoglyph lint on deliberate Russian copy is noise; package-wide detection
   retained.
4. **`response_class=StreamingResponse`** — the plan's own sanctioned O-8 fix
   applied pre-emptively; artifact verified honest (200 = text/event-stream only).
5. **Extra assertion arms** incl. the 401-before-422 pin (B1 carry-forward
   pattern) — strengthening only.
6. **Advisor context sees non-archived goals only**, documented at the call site;
   correctly contrasted with include-archived category naming.
7. **Stale plan line resolved:** `goal_reads.base_currency` not duplicated — B1's
   `profile_reads.read_base_currency` reused (OQ-1 as confirmed at R2).
8. **`_window_unconverted_count` = max-not-sum** across the three overlapping
   views of one row set — reviewer verified correct.

## QA (live, CFG-U + CFG-D)

READY FOR REVIEW — TC-Z1 (249 passed) + CT-B2a-1..6 + TC-B2b-1..7 all green,
incl. the mandatory 429-contrast arm (unkeyed 503×3 never 429; dummy-key 200→429)
and byte-identical 503s across receipts/advisor. TC-B2b-8 🚫 blocked-non-gating
(no key exists — PM waiver, R6/Q2). Zero metered calls. Clean teardown.
Carry-forward to B3's /test: use `GOAL_ID` not `GID` in zsh snippets.

## Obligations discharged

- O-4: guard suites unmodified and green (reviewer + my gate both verified).
- O-5: B2a produced zero contract diff (verified at my B2a gate before B2b's
  regen landed on top; reviewer confirmed the combined contract delta is
  exactly the advisor's, purely additive).
- O-6: no models import in `services/advisor.py` (grep at my gate; reviewer
  verified the whole import graph).
- O-7: no `AsyncAnthropic`/`ANTHROPIC_API_KEY` in tests/.
- O-8: `/advisor/ask` 200 = `text/event-stream` only; 422 `HTTPValidationError`
  only (Disagreement 3); 429/503 `AdvisorError`.
- AM-4/5/7/8: each discharged by a named, non-vacuous test arm (reviewer
  verified individually).
- O-9 half 1: CFG-K arm waived non-gating per PM; the unkeyed-503 live arm
  (its mandatory half) passed.

## Fix round

Findings 1–4 fixed by backend-engineer; full gates re-run green
(pytest 250 passed / ruff / format / pyright / api-client typecheck+test);
contract pair unchanged by the fix round (test/comment-only changes).

## Final state

B2a + B2b DONE pending PM commit: 250 pytest green, all gates green, QA green,
review APPROVE-WITH-NITS with all four findings resolved, AM-10 discharged.
No commits made from this pipeline.
