# Meta-review — mobile-mvp (1.8)

Author: senior-lead, over code-reviewer's review.md (APPROVE-WITH-FIXES:
1 MAJOR / 5 MINOR / 7 NIT). Per-finding rulings below. Fix-round scope at the end.

## Gate-miss acknowledgment (senior-lead, on the record)

Finding 1 is a defect my own diff gate should have caught, and its root cause is
an interaction of two of MY rulings: R3 (resume-timeout abandonment of a stranded
flight) re-created the in-process concurrent-flight scenario that O3's deletion of
web's adopt/identity guard assumed could not exist ("one runtime, one process").
Each ruling was individually sound; I did not re-examine O3's assumption after
issuing R3 — and at the gate I ticked O5/R3 on the strength of a test whose
never-settling promise structurally cannot exercise the late-settle arm. The
reviewer's re-derivation from `git show HEAD` of the web coordinator (finding the
deleted `stored.refresh_token !== triggeringRefreshToken` branch) is exactly the
depth the gate pass lacked. Recorded per precedent; the process correction is in
the fix-round requirements (a regression test for the INTERACTION, not just each
ruling separately).

## Rulings

1. **MAJOR (stale-flight race / single-flight breach) — AGREE. Fix required
   before anything ships.** The reviewer's two-part fix is correct and I adopt it
   verbatim in direction: (a) token-identity check in `runRefresh` immediately
   after the awaited helper, guarding BOTH the success and terminal-failure arms
   (`current?.refresh_token !== triggeringRefreshToken` → return `current !== null`
   without applying); (b) identity-guarded finally (`if (inFlight === flight)
   inFlight = null`). Required regression tests: abandoned F1 settles LATE (one
   case success, one case terminal failure) after F2 succeeded — assert tokens
   remain F2's, `wasSessionExpired()` stays false, and F2's registration is not
   clobbered; plus the double-spend arm: after abandonment, a new refresh() must
   spend the CURRENT mirror token, and F1's late settle must not disturb it.
   NIT 13 (hydrate clobber guard: `if (current === null) current = pair`) folds
   into this patch — same invariant family (no stale writer may clobber newer
   auth state), one line.

2. **MINOR (guard `next` drops query params) — AGREE, with a calibrated fix
   variant.** Reopening the EDIT modal after re-login cannot actually restore the
   edit: caches are cold post-login and there is no `GET /transactions/{id}`, so
   a full-href `next` would land on the "unavailable" state — better than the
   silent CREATE-mode switch (which invites a duplicate entry), but still not the
   user's edit. Ruling: for MODAL routes, encode the PARENT TAB as `next`
   (transaction-form → /transactions, category-form → /categories); tab routes
   keep pathname (they carry no params — month is local state). Document why in
   the guard. This closes the silent-mode-switch hazard honestly instead of
   pretending the edit context is recoverable. (O6.)

3. **MINOR (`safeNextRoute` throws on `string[]`) — AGREE.** First-line
   `typeof next !== 'string' → default route` + a repeated-param test. The O6
   validator must be the most paranoid function in the app, not the crashable one.

4. **MINOR (icon field error never rendered) — AGREE.** `error={errors.icon?.
   message}` on the icon LabeledInput. One-prop fix, O7-adjacent discipline.

5. **MINOR (`refetchOnReconnect` inert on RN) — AGREE with the comment-fix
   variant.** NetInfo is a new native dependency — NOT approved in this task
   (R2's list is closed). Keep the flag (harmless; becomes live if NetInfo is
   ever wired) but rewrite the comment to state plainly: inert without a NetInfo-
   wired onlineManager; recovery today = mutation retry policy + manual retry
   affordances. Record NetInfo wiring as a future task trigger. Honesty of
   claims is a review standard here, not a nicety.

6. **MINOR (rebuild drops `signal`) — AGREE.** Pass `signal: input.signal ??
   undefined` on BOTH legs (an aborted screen must not have its retry replayed
   either), and extend the O4 comment with the explicit dropped-fields contract
   of the rebuild (what carries over: url/method/headers/body/signal; what does
   not: everything else). Latent today, load-bearing the day Query cancellation
   arrives.

7. **NIT (timer never cleared / dead `clearTimeout` surface) — FIX** (fold into
   the finding-1 coordinator patch): clear the resume timer when the pending
   flight settles. An injectable API nobody calls misleads; the coordinator is
   open for edits anyway.

8. **NIT (memo defeated by inline closures) — FIX.** `useCallback` the row
   handlers at the four call sites. Cheap, and the alternative (deleting the
   memo + comments) gives up a real win on the 250-row month.

9. **NIT (unlocalized month label) — FIX.** Pass `{ locale: APP_LOCALE }` at the
   one missed `formatMonthLabel` call site.

10. **NIT (stale web errors.ts header comment) — FIX, with explicit senior
    authorization for the zone touch.** Comment-only edit in `apps/web/src/lib/
    errors.ts` mirroring the mobile copy's wording. Mobile-engineer may apply it
    in the fix round under this authorization (declared in their report);
    spawning a separate frontend round for a 3-line comment is process waste.

11. **NIT (system-category deep-linked form editable) — DEFER, recorded.**
    Reachable only via a crafted in-app href; row-level gate is the real W9
    barrier and the server 403 + copy backstop it (both verified). Trigger to
    reopen: any real deep-link source into modals (same trigger as R4).

12. **NIT (`router.back()` on empty stack) — DEFER, recorded.** Same R4
    carve-out and the same reopen trigger as 11. `canGoBack()` hardening is the
    documented cheap fix when the trigger fires.

13. **NIT (hydration clobber) — FIX**, folded into finding 1 (ruling 1).

## Fix-round scope (mobile-engineer)

Findings 1, 2, 3, 4, 5, 6 + NITs 7, 8, 9, 10 (authorized web comment), 13.
Deferred with recorded triggers: 11, 12. Required new tests: the finding-1
late-settle pair + double-spend arm; the finding-3 repeated-param case. Gate:
full four-workspace turbo re-run + mobile tsc + Metro export smoke. Senior
verifies every fix diff by read before the final bundle. NO commits.

## On the reviewer

The "Verified correct" section is the right shape — the lossless errors.test
split check, the byte-diff of promoted modules against HEAD, and the re-derived
web-coordinator comparison are exactly what the formal pass exists for. Verdict
calibration (1 MAJOR, rest minor/nit) matches my own read of severity.
