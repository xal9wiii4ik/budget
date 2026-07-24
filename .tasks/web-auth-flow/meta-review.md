# Meta-review (senior-lead) — web-auth-flow (roadmap 1.5)

Review under meta-review: review.md (code-reviewer, full uncommitted diff,
verdict APPROVE-WITH-FIXES). My independent verification: I re-ran the finding-3
URL resolution myself (`new URL("/\\evil.com", "http://localhost:5173")` →
`http://evil.com/` — confirmed) and re-checked finding 5's mechanism against
openapi-fetch 0.17.0 source (per-call init is spread into `new Request` at
dist/index.mjs L73/79; `FetchOptions` = `Omit<RequestInit, "body"|"headers">`,
so `keepalive: true` typechecks and reaches the wire — confirmed). The
verified-correct section overlaps my own diff-gate findings (AM-2/AM-3 grep,
AM-7 order, single-flight lifecycle, register() forced fields) with no
contradictions — two independent reads agreeing.

## Ruling per finding

1. **MAJOR — runRefresh stored===null arm (cross-tab logout race). AGREE;
   fix required.** I flagged this same race at my diff gate as "cosmetic"; the
   reviewer is right to grade it harder — it violates the coordinator's own
   documented `sessionExpired` contract ("terminal refresh failure, NOT an
   intentional logout"), spends a deliberately revoked token server-side, and
   it is the single wrong arm in the otherwise-faithful implementation of the
   binding 1.1 re-read design. Design-center correctness plus a 3-line fix =
   required. The proposed fix (null → sync mirror, return false, no server
   call, no expiry flag) is minimal and does not disturb TC-11 or existing
   tests; the contrasting vitest case comes with it.
2. **MINOR — sessionExpired never reset on cross-tab login. AGREE; fold into
   fix 1.** Same lifecycle hole, same edit site. The invariant the reviewer
   states — "a live token pair means the session is not expired" — is the
   right formulation; implement it at the shared spot (storage-subscribe /
   adopt) rather than scattering resets.
3. **MINOR — safeNextPath backslash bypass. AGREE; fix required.**
   Independently verified. No exploitable open redirect in target browsers
   (pushState same-origin throws), but the reviewer's framing is exactly
   right: the validator is the security boundary and must not lean on
   pushState as a backstop — and the current failure mode strands a
   logged-in user on /login with a false network-error message. One-line
   reject of `\\`. MY ADDITION: safeNextPath gains a small unit test
   (backslash, `//host`, absolute-scheme, valid-path cases) — the finding
   itself proves this pure security-boundary function can silently regress,
   which meets the repo's bar for a non-vacuous test.
4. **MINOR — two uncovered breakable paths in the coordinator suite. AGREE;
   required in this pass (upgrading from "strongly recommended").** Reasoning
   for the upgrade: (a) the body-preservation test is the ONLY thing standing
   between a future refactor and silently breaking every 1.6 mutation retry —
   the reviewer's observation that a body-consuming `withBearer` refactor
   would pass today's entire suite is the exact "need to be 100% sure" case
   the repo test rule names; (b) the refresh-rejection test pins lead 2b's
   traced-but-unverified degradation semantics (joiners reject, tokens
   preserved, inFlight cleared). Both are cheap now, expensive to retrofit.
5. **MINOR — logout keepalive. AGREE; required in this pass.** The reviewer's
   trace resolves QA's TC-17 observation credibly (openapi-fetch's 204
   early-return leaves the body stream unread; Chrome logs ERR_ABORTED on GC —
   cosmetic, revoke not lost intra-SPA) and identifies the genuine residual
   gap (tab-close mid-flight leaves a live refresh token server-side).
   `keepalive: true` is a one-word standard RequestInit field: AM-2-safe (no
   web global; RN ignores it), verified to pass through openapi-fetch's init
   spread. Trivial cost, real hardening.
6. **NIT — no error affordance for a terminally-errored me-query. AGREE,
   DEFER to 1.6.** The stub-era shell degrades safely (no crash, no bogus
   redirect, recovers on refetch); 1.6 rebuilds this shell around real
   content anyway. Recorded as a 1.6 note below.
7. **NIT — FakeLocks.maxConcurrent dead infra. AGREE; fold into the fix
   round** as the reviewer's cheaper option (assert `maxConcurrent() === 1`
   in the single-flight test — it adds one line of real signal to an
   existing test; deleting working instrumentation to satisfy a nit would be
   churn).
8. **NIT — /login and /register don't bounce authenticated visitors. AGREE,
   DEFER.** Not in plan A2's scope; harmless today (and finding 3's fix
   removes the one path that made it sting). 1.6 candidate.

## Disagreements with the reviewer

None on substance. Two calibration deltas, both in the stricter direction:
finding 4 upgraded from recommended to required (rationale above), and
finding 3 gains a unit test the reviewer didn't ask for. I also confirm the
reviewer's decision NOT to demand a shared-package restructuring or new
abstractions anywhere — consistent with the mobile review's mandate limits.

## Fix round (frontend-engineer)

Required: findings 1+2 (one edit + contrasting vitest case), finding 3
(+ safeNextPath unit test), finding 4 (two vitest cases), finding 5
(keepalive), finding 7 (one-line assert). Full gate re-run (typecheck, lint,
vitest across apps/web + both packages), AM-2 grep re-run (keepalive edit
touches auth.ts), schema.d.ts remains byte-identical. Deferred to 1.6:
findings 6 and 8 (recorded in §"Carry-forwards" below).

## Carry-forwards recorded for 1.6

- Protected-shell error affordance for a failed me-query (finding 6).
- Consider bouncing authenticated visitors off /login and /register
  (finding 8).
- Client/server email-validation mismatch: shared zod accepts reserved TLDs
  (user@example.test) that the server's validator 422s; surfaces as a generic
  form error today. Fold into 1.6's error-helper field-level work (which
  already owes ValidationError[] mapping per the 1.4 obligations).
- 1.6 mutation retries lean on AM-7 body preservation — the new
  body-preservation vitest case is the regression tripwire; do not weaken it.
