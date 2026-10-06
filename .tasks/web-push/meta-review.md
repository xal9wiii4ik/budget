# Meta-review: web-push B1 (senior-lead over review.md, 2026-10-06)

Reviewer: 1 MAJOR, 3 MINOR, 3 NIT, no BLOCKER. Verified-clean list (scoping, claim-before-send,
pywebpush 2.5 exception shape, privacy by construction, migration names, recurring extraction,
wiring, contract, NEVER_PAT) matches my own gate read — no disagreement there.

| # | Finding | Verdict | Reasoning / action |
|---|---|---|---|
| MAJOR-1 | `requests` follows 30x → `endpoint_allowed` binds only the first hop; `/push/test` is a 3-way status oracle | **AGREE** | Real and exploitable with any attacker-controlled https name. Fixed: `_NoRedirects` shim (`allow_redirects=False`) passed as `requests_session=` at the single call site; 3xx → `failed`, row kept. One assertion added to the existing sender stub so a pywebpush upgrade that stops honouring `requests_session` is caught. |
| MINOR-1 | bare-label hosts (`https://minio/`) pass; docstring overclaims | **AGREE** | Compose service names are exactly the hosts this container can reach. `"." not in host` refused; docstring now claims only what it does. Goes beyond grooming decision 1 but stays "minimal, no DNS, no vendor allowlist". |
| MINOR-2 | non-ASCII hosts pass (not exploitable with installed urllib3) | **AGREE** | One `isascii()` line; browsers hand out punycode endpoints, nothing legitimate lost. |
| MINOR-3 | keyless test never contrasts a PARTIAL trio | **AGREE** | Exactly the "names a branch it does not exercise" rule. Keyless app now blanks `vapid_subject` only. |
| NIT-1 | concurrent-claim test docstring overstates its race arm | **AGREE** (docstring) | Assertions hold either way; the rerun arm is the deterministic one — now said so. |
| NIT-2 | `make_push_client` foldable into `make_client` | **DEFER** | Cosmetic; a fixture refactor touching five test files is not worth a cycle. |
| NIT-3 | `push_reminder_horizon_days` unbounded | **PARTIALLY AGREE** | Bounded with `ge=0`, NOT `ge=1`: 0 = "today only" is a legitimate knob the architecture named (goal reminders on their reminder date); the comment states that the charges family is then always empty. Negative was the bug. |

Also closed in this round (web-qa finding, outside the reviewer's scope): focus fell to `<body>`
after an arm change in the Notifications section — focus now moves to a stable in-section element
after a user action changes the arm (never on mount / re-sync).

Gate after the round: see the final report (ruff/format/pyright, targeted + full pytest, turbo web).
