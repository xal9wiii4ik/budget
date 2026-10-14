# Meta-review — pdf-reconcile (senior-lead on code-reviewer's `review.md`, 2026-10-14)

Reviewer verdict was fix-first: 1 BLOCKER, 0 MAJOR, 5 MINOR, 5 NIT. Independently, qa-engineer
(DEF-1) and web-qa (D-1) hit the same BLOCKER live. One fix round followed; every gate re-run by me.

| # | Finding | Verdict | Reasoning / outcome |
|---|---|---|---|
| 1 | BLOCKER — second `POST /{id}/reconcile` on a session holding a report → 500 (claim set `running` but left the JSONB; CHECK `reconciliation_present`) | AGREE | Real, reproduced live by both QA lines and by the reviewer's probe. The claim now nulls `reconciliation`/`reconciled_at`/trio; new test proves a second run OVERWRITES with a changed report and fails with the fix reverted. Re-probed live on the fixed stand: two consecutive 200s, fresh `reconciled_at`. QA PR-10's SQL note corrected. |
| 2 | MINOR — tail regex' plain-space thousands grouping swallows a trailing digit of the description | AGREE | Deterministic `description` feeds the `alfa:v1` canon; a swallowed token would move fingerprints. Grouping restricted to NBSP/narrow NBSP in the tail only; probe line added to the text fixture. |
| 3 | MINOR — `_MAX_TOKENS_CEILING` below the allowed report size | AGREE | Raised to 40 000 (≥ 2×300×60 + floor); the router's `TOO_LARGE` gate is the real bound. |
| 4 | MINOR — a header balance figure could reach a log line via `_anchor`'s message | AGREE | Message now names the label only. Consistent with the "no values in logs" rule. |
| 5 | MINOR — `reconciled_at` stamped on `failed` runs | AGREE | D-R5 says `ok` only; fixed, test adjusted. |
| 6 | MINOR — docs stale (routes, codes) | AGREE | Done in my docs pass: backend.md (router bullet, services, 0019, codes), conventions.md, infra.md. |
| 7 | NIT — zero-token usage logged when the answer is structurally unusable | AGREE | Fixed: real usage with `outcome=error:invalid_output` — the cost line must say what was billed. |
| 8 | NIT — `open_line` survives a page footer | AGREE | Fixed; one assignment. |
| 9 | NIT — a continuation starting with `dd.mm.yyyy ` becomes a false operation | AGREE, docstring only | Correct under FLAG-2; documented as the known false-positive shape; the self-check catches it. |
| 10 | NIT — final outcome write unguarded (zombie past 2× budget may overwrite a live re-claim) | PARTIALLY AGREE, deferred | Edge case needs a run > 120 s AND a concurrent re-run; the stored report is self-consistent either way. Follow-up noted, not fixed in v1. |
| 11 | NIT (web) — one redundant GET after the POST seed | DISAGREE as a defect | Deliberate per the engineer's deviation 1: the declarative `enabled` + `staleTime: 0` replaces a status-transition effect; one cheap GET is the price of having no effect. Keep. |

QA findings outside the review: DEF-2 (new routes answer 401 to a PAT, older import routes 403) —
DECISION, not a defect: the routes follow the JWT-only family (`/push`, `/tokens`) by architecture
D-R5; the import family's 403 comes from the allowlist path those routes never enter. Documented in
backend.md.

Gates after the fix round (mine): API `ruff`/`format`/`pyright` clean, pytest 827 passed on
`budget_test_s1`; JS `turbo lint typecheck test --force` 12/12 incl. the drift test; contract pair
changed together.
