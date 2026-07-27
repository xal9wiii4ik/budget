# Meta-review (senior-lead): combined S1+S2+S3 code review — receipts-ocr

Reviewer output: review.md (combined arc pass per PM token policy, replacing three
per-subtask reviews). Reviewer verdict: APPROVE-WITH-FIXES, zero MAJOR, 4 MINOR,
4 NIT, plus the referred currency-coercion item ruled SOUND.

First: the reviewer independently re-ran the gates (pytest 94, alembic
upgrade/check/downgrade round-trip, entry-by-entry exponent-table diff against
currencies.ts, contract spot-checks) instead of trusting prior reports — exactly
the right posture. The findings below are edge-hardening at the external seams;
nothing touches the core claim/money/auth design, which matches my own gate
conclusions.

## Per-finding rulings

1. **MINOR — receipt_max_bytes 10 MiB > Anthropic's 5 MB image limit. AGREE — fix
   with the S3 commit.** A 6 MB upload passes our gate, burns a metered call, and
   fails as ANTHROPIC_ERROR ("try again in a moment") when the truthful answer is
   IMAGE_TOO_LARGE ("pick a smaller photo") — the exact wrong branch of the web
   plan's R5 retry split. Real-world exposure is low (the web client downscales to
   ~1500px JPEG), but the fix is a one-line default (5_000_000 to dodge MB/MiB
   ambiguity) + comment. FOLDED (fix round F1).

2. **MINOR — unhandled httpx.ConnectError on the HEAD probe → raw 500. AGREE —
   fix with the S3 commit.** MinIO-down should be an honest, declared service
   condition, not an undeclared 500. Ruling: try/except httpx.HTTPError + explicit
   HEAD timeout → 503 `STORAGE_UNAVAILABLE` (new request-time-only code; the 503
   responses= arm already exists, no schema change). **NIT 6 folded into the same
   fix**: any non-200/404 HEAD status (403/5xx) also → 503 instead of falling
   through the size gate, claiming, and dying later as DOWNLOAD_FAILED — fail
   honestly before spending the claim. One new pytest pins the ConnectError arm.
   FOLDED (fix round F2). The web S5 error table gains the code at implementation
   (S5 is unimplemented — zero rework cost).

3. **MINOR — last-resort guard can call _finish_failed on a dirty session
   (PendingRollbackError swallowed → receipt stuck `processing` for the stale
   window). AGREE — fix with the S3 commit.** The self-healing stale takeover
   would eventually recover it, but 300 s of a stuck receipt for a one-line
   guarded rollback is a bad trade. FOLDED (fix round F3).

4. **MINOR — the stale-takeover CLAIM branch has no permanent test. AGREE — fix
   with the S3 commit.** Partially mitigated: QA's live TC-S3-7 proved the branch
   (202 on stale, 409 on fresh) — but that is a run-once gate, not regression
   coverage; an inverted comparison would ship green through pytest. The branch is
   genuinely breakable and uncovered — passes the project's no-vacuous-tests bar.
   One endpoint-level test, both arms. FOLDED (fix round F4).

5. **NIT — catch-all writes ANTHROPIC_ERROR for non-Anthropic origins. DECLINE.**
   Renaming the taxonomy (e.g. PIPELINE_ERROR) costs a contract-prose change and a
   web error-table row for a code whose user-facing message would be identical
   ("reading failed — try again"). The log line carries the true origin. Recorded;
   revisit only if debugging ever actually suffers.

6. Folded into ruling 2 (above).

7. **NIT — pre-check failures (503/404/409/422) burn the 100/day parse quota.
   DECLINE — by design.** slowapi counts before the handler; exempting pre-check
   rejections would require moving the limiter inside the handler and hand-rolling
   its accounting. 409/422 loops are client bugs, 100/day is generous, and the
   minute window recovers fast. Recorded.

8. **NIT — S6 decode invariant for null currency. AGREE, and UPGRADE: this is a
   real cross-layer catch, recorded as a BINDING S6 obligation (AM-5).** plan-web's
   `buildConfirmDefaults` currently sketches
   `toInputString(parsed.total_minor, parsed.currency ?? baseCurrency)` — but the
   server encodes a null-currency total at exponent 2, so decoding with the BASE
   currency's exponent breaks whenever base is a non-exponent-2 currency (JPY base:
   100x). The invariant: **total_minor decodes with the PARSED currency's exponent,
   null → exponent 2 — never the base currency's.** Frontend fix at S6 (e.g. decode
   via an explicit exponent-2 path when currency is null); unit test in
   confirmDefaults.test.ts must contrast a null-currency receipt under a
   non-exponent-2 base. Appended to grooming-review.md §4 as AM-5.

## Referred item — currency coerce-to-None: reviewer says SOUND, I CONCUR.

The reviewer's argument is the one that matters: the post-coercion value is the
single stored truth, and BOTH layers default unknown/None to exponent 2, so
encode/decode cannot disagree asymmetrically. Hard-failing validation would nuke a
whole parse over a cosmetic field while buying no protection against the only
dangerous class ("YEN"-style plausible-but-wrong codes pass the regex under either
posture). The one residual footgun is exactly finding 8 — now bound as AM-5.

## Reviewer-quality notes

- Re-verification instead of trust: good. Finding 1 required checking an external
  API constraint against our config default — the kind of cross-boundary check
  per-subtask reviews often miss; the combined-arc format earned its keep here.
- Finding 4 correctly distinguished live-gate coverage from regression coverage.
- Side effect to flag to the PM: the reviewer started the compose `postgres`
  container (the committed 5433 one) to run the suite and left it up — harmless
  but it now runs alongside budget-postgres-1 (5443). PM may want to stop it
  (`docker compose stop postgres`) to keep the 5433-is-foreign convention tidy.

## Outcome

- Fix round (F1–F4 = findings 1, 2+6, 3, 4) folded into the S3 working tree;
  gates re-run; all fixes land in the held S3 commit.
- Findings 5, 7 declined with reasoning (recorded).
- Finding 8 upgraded to binding S6 obligation AM-5 (grooming-review.md §4).
- S3 commit remains HELD on the TC-S3-1 live-call gate (user-supplied
  ANTHROPIC_API_KEY) or the user's explicit deferral — unchanged by this review.
- STOP before S4 per PM standing instruction.
