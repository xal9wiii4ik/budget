# Meta-review: mcp-remote (senior-lead over review.md, 2026-10-08)

Reviewer verdict: no BLOCKER, no MAJOR; 4 MINOR, 2 NIT; every line of the owner's security
checklist OK with file:line evidence. My gate (B1, B2, W1 diffs read before QA) found the same
shape; the authoritative gate run is green (ruff, pyright 0/0/0, pytest 717, turbo 15/15).

## Findings, one ruling each

1. **MINOR #1 refresh grace window — DISAGREE on the premise, DEFERRED as a follow-up.**
   `authentication.txt:124` says Claude treats a refresh that takes >30 s as a failure; it does
   not say Claude re-sends the SAME refresh token afterwards (inferred). Our token endpoint is
   three indexed statements, milliseconds. The remaining case — the response is lost on the
   wire after rotation — ends in `invalid_grant` → Claude asks the user to reconnect, which is
   exactly OAuth 2.1's documented strictness for public clients and the architecture's §D3
   decision. A grace window re-issuing a pair to a token already marked used weakens the one
   property reuse-detection exists for. Revisit ONLY if the owner sees unexplained
   "reconnect" prompts; the reviewer's sketch (claim-and-void the successor inside N seconds)
   is the shape to use then. Follow-up recorded below.
2. **MINOR #2 prune only on failed lookups — AGREE, fixed.** The three expiry DELETEs now also
   run inside the rotation transaction (every healthy connector passes hourly). Indexes on
   `expires_at` NOT added: ~50 rows/day/grant, a sequential DELETE on a four-figure table is
   noise; add them if a deployment ever carries thousands of grants.
3. **MINOR #3 DCR limit keyed on claude.ai's egress — PARTIALLY AGREE, raised to 30/hour.**
   The keying is a fact of hosted Claude (Anthropic's egress range), so the bucket is per
   deployment. 60/hour (reviewer) is more than a single-domain app needs; 30 keeps anonymous
   row writes bounded and no longer caps onboarding at ten. Figure documented in
   `apps/api/MCP.md` §8 and `docs/mcp.md`. Refusals still count (R8) — the alternative
   (exempt successes) rewards the abusive shape.
4. **MINOR #4 untested branches — AGREE, fixed.** Three tests: `client_secret_basic`
   round-trip + wrong secret + no plaintext stored; access lifetime 0 → 401 on a data route
   and on `/mcp`; refresh lifetime 0 → `invalid_grant`. All three are mechanisms that break
   silently (CLAUDE.md rule), not duplicates.
5. **NIT #5 `/mcp/` served as SPA HTML — AGREE, fixed.** `location = /mcp/ { return 404; }`;
   not a redirect (a 3xx drops Authorization, troubleshooting.txt).
6. **NIT #6 Basic auth still needs `client_id` in the form — AGREE as a comment only.** The
   SDK's own request models require the body field; both sides change together or neither.

## Amendments to earlier artefacts
- qa-checklist P9: the live stand was built BEFORE fix #3, so its 429 arrives at the 11th
  registration; the committed figure is 30/hour. P8.2/P8.7 and P11 were amended at grooming
  close (RFC-redirected errors; `path`/`occurred_at`).
- plan.md §B1 said the Starlette routes go AFTER the allowlist line; the code follows
  architecture/R7 (BEFORE). plan.md's refresh "single UPDATE" became claim → insert → link
  (self-FK), stated in provider.py.

## Follow-ups (not in this scope)
- Refresh-rotation grace window (finding #1) — only on evidence of spurious reconnects.
- Orphan `oauth_clients` prune (architecture §D7, deferred): one SQL line in MCP.md.
- `expires_at` indexes on the three token tables — only at thousands of grants.
- Audit-log read endpoint (PLAN 5.6 phase 2 item) — unchanged by this scope.
