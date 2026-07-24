# Grooming Review (Phase 4) — auth-email-password (roadmap 1.1)

Senior-lead critical review of verified-facts.md (F1–F8, my own source-level
spike), architecture.md (architect), plan.md (backend, spike-verified §13 +
S1/S2), qa-checklist.md (35 curl/command checks + backend's 15 pytest cases),
contract-review-web.md (frontend, zero objections). Verdict: **accepted with
the amendments below.** No artifact goes back for rewrite; amendments are
binding on the implementers and QA folds its deltas before /test.

## 1. Team selection (recorded)

architect (three new-table candidates, a token lifecycle the library does NOT
provide, the canonical `current_active_user` every later task imports) +
backend-engineer (all apps/api + root-file ownership per 0.1 §1.1) +
qa-engineer (security-critical endpoints; live-only reset flow) +
frontend-engineer in a NARROW review-only role (my ruling on the PM's open
point): the form-encoded login and single-use rotating refresh directly
constrain 1.5's client, and the review paid for itself — it caught the
openapi-fetch Content-Type hard-default (a silent 422 at 1.5) and produced the
429-envelope recommendation adopted below. mobile-engineer / web-qa /
mobile-qa NOT invoked: no client code, no UI journey until 1.5/1.8.
code-reviewer arrives at /review_senior.

Process note: the Phase 3.6 verification gate was run TWICE by design — my own
spike (verified-facts.md F1–F8: no refresh endpoint, form login, argon2
default, DatabaseStrategy primitive, mixin frictions, JWT-only Authenticator
guarantee) and backend's independent spike (§13.1–§13.8, S1, S2, slowapi
end-to-end). The architecture doc's claim that fastapi-users provides refresh
"out of the box" is factually wrong for 15.0.5 — the whole token-lifecycle
design (architecture §1) exists because we verified instead of trusting the
doc.

## 2. Cross-check results

- **architecture ↔ plan**: one real conflict found by my gate review, fixed by
  AM-A (below): the plan's `UserUpdate(BaseUserUpdate)` subclass could NOT
  deliver architecture §5's "escalation fields structurally absent" — Pydantic
  keeps inherited fields (the plan's own S1 finding, applied inconsistently).
  Everything else implements the architecture with zero silent deviations; the
  three recorded clarifications (rate knobs, stock-route limiting mechanism,
  `created_at` Python default) are legitimate engineer latitude under §14.
- **plan ↔ qa-checklist**: every plan feature has a live check; QA's coverage
  note correctly declines to duplicate pytest (inactive-user, expired-token,
  case-dedup are unreachable or valueless over live HTTP); the
  rotation-happy-path overlap (pytest + TC-A4/A5) is documented and justified.
  QA wrote against the amended state (AM-A/AM-D) as instructed. Two QA
  expectations change under today's rulings: TC-D3 flips envelope (AM-I),
  TC-E2's constraint list was wrong (AM-J, my finding). One check gap closed
  by AM-E (revocation-on-reset live check).
- **plan ↔ web review**: consistent; web raised zero objections; its 429
  normalization NOTE is adopted (AM-I); its two 1.5 obligations are recorded
  as carry-forwards (AM-K).
- **verified-facts ↔ both spikes**: no contradictions between my F1–F8 and
  backend's §13/S1/S2; backend's spike extended mine (slowapi, case-insensitive
  get_by_email, /{id} superuser gating, adapter commits) without overturning
  anything.

## 3. Rulings requested by the PM (each explicit, with reasoning)

### R1 — Password reset AND password change REVOKE all refresh tokens (QA gap 2). RULED: revoke on both.

I agree with the PM's lean, now confirmed against the plan's mechanics:

- **Why**: a reset happens because the password is forgotten or compromised;
  leaving 30-day refresh tokens alive defeats the reset — an attacker holding
  a refresh token survives the victim's recovery. "Password changed → logged
  out everywhere" is the universal expectation, and this is the task where the
  session model is being built — retrofitting it later means a second pass
  over security code.
- **How (cheap, confirmed feasible)**: `UserManager.on_after_reset_password`
  and `on_after_update` hooks exist (F7). In the hooks: if the password
  changed, `DELETE FROM refresh_tokens WHERE user_id = user.id` via the
  adapter's session. ~6 lines + tests. No carve-out for the "current" token —
  the possession-based model has no session binding to identify it, and
  re-login after a password change is standard. The in-flight access JWT stays
  valid ≤15 min (accepted; that IS the access/refresh split).
- **Implement-time verification (30s in the spike venv)**: exact
  `on_after_update` signature (does it receive `update_dict` to detect a
  password change?) and `SQLAlchemyUserDatabase.session` attribute access.
  Neither is in F1–F8 — verify, don't assume.
- **Tests**: pytest `TestUsersMe::test_patch_me_password_change` — PATCH
  /users/me with new password → 200 lean body, new password logs in, and the
  user's pre-change refresh token now → 401 (revocation contrast). This one
  test also closes QA gap 1 (R2). Pytest
  `TestResetPassword::test_reset_revokes_refresh_tokens` — forgot-password →
  capture reset token from the WARNING log via `caplog` → reset-password →
  old refresh token 401 (mechanism latitude to backend; if caplog capture is
  awkward, generating the token via the manager directly is acceptable — the
  assertion that matters is the 401). QA adds live TC-C5: after TC-C2's
  reset, the refresh token obtained in TC-C1's era → 401.

### R2 — PATCH /users/me happy-path pytest (QA gap 1). RULED: add, merged with R1's test.

Agreed — a mounted endpoint with zero positive coverage, exercising the safe
update dict + password re-hash path, is genuinely breakable. One test (above)
pins: 200, lean response, new password authenticates, revocation fired. A
separate email-change test is NOT added — same safe-update code path, shape
already pinned by register/me tests; a second test would re-assert the same
branch (pytest-conventions).

### R3 — Password strength (QA gap 3). RULED: min length 8 via `validate_password`, nothing fancier — and the "nothing fancier" is a written accept.

- `UserManager.validate_password` (F7) raising `InvalidPasswordException` →
  400 `REGISTER_INVALID_PASSWORD` — an error code ALREADY in the stock
  register contract (architecture §5 table), so the wire contract does not
  change; we merely make the declared error reachable.
- Policy: `len(password) >= 8`. Explicitly REJECTED: complexity classes,
  zxcvbn, breach lists — single-user app, argon2 (F3) + rate limiting are the
  real defenses; composition rules mostly tax the one legitimate user (and
  NIST 800-63 agrees: length over composition).
- fastapi-users routes `validate_password` through register, reset AND update
  flows (believed; implement-time verify) — one definition guards all three
  password-entry points.
- Test: `TestRegister::test_short_password_400` — 400,
  `REGISTER_INVALID_PASSWORD` in detail. One test; the reset/update paths
  reuse the same validator and are not re-tested (conventions).

### R4 — UserUpdate extra-field behavior (QA ambiguity 1). RULED: 200-ignored (Pydantic default), NOT 422-forbid.

Reasoning: (a) contract consistency — every other schema in this API ignores
unknown fields (Pydantic default); making one endpoint uniquely strict is a
trap for clients and reviewers; (b) `extra="forbid"` makes future additive
client-before-server deploys order-sensitive for zero security gain — the
security property comes from AM-A's structural absence, and it is PINNED by
TC-B7's DB assertion (`is_superuser` stays false) plus §13.5's verified
safe-update layer underneath. Two independent layers, either sufficient.
TC-B7's expectation (200, ignored, DB unchanged) is now the ruled contract —
QA deletes the inline ambiguity note. plan.md needs no change.

### R5 — Normalize slowapi 429 to `{"detail": "RATE_LIMITED"}` (QA ambiguity 2 + web review Q4). RULED: adopt.

The web review is right and the fix is ~5 lines at exactly the layer we
already touch: the plan already registers a `RateLimitExceeded` exception
handler — it becomes a custom handler returning
`JSONResponse({"detail": "RATE_LIMITED"}, status_code=429)` instead of
slowapi's stock `{"error": ...}`. Result: ONE error envelope (`detail`)
across the entire API; the declared 429 response schema and the live body
finally match (they diverged in the plan — QA TC-D3 existed to document the
wart; now it verifies the cure). Keep slowapi's `Retry-After`/rate-limit
headers if trivially preserved (`limiter._inject_headers` or equivalent) —
nice-to-have, not a gate. Deltas: backend declares the 429 response model as
`{detail: str}` on limited routes; QA TC-D1/TC-D3 flip to expect `detail` and
NO `error` key; plan's 1.5 client notes drop the "one-off 429 shape" caveat;
web's `getErrorCode` helper stays single-branch.

### R6 — Durable 1.5 obligations (web review carry-forwards). RULED: recorded in §7 below.

Grooming reviews are this project's carry-forward vehicle (0.1's ownership
rule and 0.2's amendments reached this task exactly that way — quoted by the
PM in the task brief). §7 is the durable record; 1.5's grooming MUST read it.

## 4. Amendments (binding)

Issued at my plan gate review (QA already wrote against A and D):

- **AM-A — `UserUpdate` is an independent lean `BaseModel {email?: EmailStr, password?: str}`**, NOT a `BaseUserUpdate` subclass (which cannot drop inherited
  privilege fields — the plan's own S1 finding). Delivers architecture §5's
  structural guarantee. Cost: a third documented `# type: ignore[arg-type]`
  at users-router registration (S1 pattern). Plan's "two suppressions" becomes
  **three** — pyright-strict carry-forward row updated accordingly.
- **AM-B — every explicit `Settings(...)` construction site gains a dummy/real
  `jwt_secret`**: `openapi_export.build_export_app` (which today documents
  "database_url is Settings' only field" — comment now stale, rewrite it;
  hermeticity holds: the secret never appears in the schema),
  `tests/conftest.py` client fixture, `tests/test_health.py:23`. Verified by
  me against the actual files — the plan listed conftest but missed the export
  module and test_health.
- **AM-C — limiter wiring must be per-app-safe for the multi-app test
  pattern.** The plan sketches a module-level decorator limiter AND a
  per-app `rate_limit_enabled` Setting — but tests build a fresh app per test
  (conftest `client` fixture); a module-level limiter mutated in `create_app`
  is cross-app shared state (enabled flag AND in-memory hit storage).
  /implement must make this conscious and safe: acceptable resolutions include
  a per-app `Limiter` built inside `create_app` with limits applied there, or
  a shared instance with per-test isolation explicitly argued. Reviewer
  checkpoint at my diff review — I will ask for the argument.
- **AM-D — register-429 pytest** (`TestRateLimit::test_register_429`, tight
  limit) so the fragile post-decoration of stock routes is CI-gated, not
  QA-curl-gated-once. This is my CONDITION for accepting plan Open Q2 option
  (a) (limit all three routes): the internals coupling
  (`route.dependant.call`) is acceptable only while a silent post-decoration
  failure turns a build red. With AM-D, architect's §7 and backend's
  recommendation stand — all three unauthenticated routes limited.

Issued this review (R-rulings + new findings):

- **AM-E — revocation on password reset AND password change** (R1): hook
  implementation + the two pytest cases + QA TC-C5. Implement-time
  verification: `on_after_update` signature, adapter session access.
- **AM-F — PATCH /users/me happy path** (R2): folded into AM-E's
  `test_patch_me_password_change`.
- **AM-G — password min length 8** (R3): `validate_password` +
  `test_short_password_400`; no other policy (written accept).
- **AM-H — `UserUpdate` extras ignored, 200** (R4): TC-B7 note resolved; no
  `extra="forbid"`.
- **AM-I — 429 envelope `{"detail": "RATE_LIMITED"}`** (R5): custom handler;
  declared 429 schema matches live body; QA flips TC-D1/TC-D3 expectations;
  plan's 1.5 notes lose the one-off-shape caveat.
- **AM-J — unique-index expectation corrected** (my cross-check finding).
  With `unique=True, index=True` SQLAlchemy emits a single UNIQUE INDEX
  `ix_users_email` — there will be NO `uq_users_email` constraint, and
  TC-E2's `pg_constraint` query cannot see indexes. Plan's expected-names
  list drops `uq_users_email`; TC-E2 queries `pg_indexes` (expect
  `ix_users_email` with UNIQUE, `ix_refresh_tokens_user_id`,
  `pk_users`/`pk_refresh_tokens`/`fk_refresh_tokens_users_user_id` via
  pg_constraint). Migration 0001's hand-review checklist updates to match —
  this prevents a correct migration "failing" QA.
- **AM-K — carry-forwards to future tasks recorded in §7** (R6).

## 5. Per-amendment / carry-forward checklist (Phase 4 obligation)

| Binding item | Source | In plan.md | In qa-checklist.md | Verdict |
|---|---|---|---|---|
| Root-file ownership = backend-engineer | 0.1 §1.1 | ✓ reviewed root files, no changes needed (verified claim myself: turbo inputs already glob alembic/**, pyproject, openapi.json) | n/a | covered |
| Both contract artifacts committed together | 0.2/0.3 | ✓ Contract regeneration section | ✓ TC-F1 (implement-time red→green), TC-F2–F5, TC-H1–H2 | covered |
| Per-amendment checklist in /implement report | 0.1 retro | ✓ table present + obligation restated | ✓ Summary gates | covered; /implement ticks AM-A…AM-K individually |
| Exact-pin + uv.lock convention | 0.1 | ✓ `>=` floors + lock regen | n/a | covered |
| Local test PG :5443 via TEST_DATABASE_URL (committed :5433) | task brief | ✓ conftest + subprocess env | ✓ Preconditions table | covered |
| pyright strict / ruff scope | 0.2 | ✓ (suppression count now THREE per AM-A) | n/a | covered after AM-A note |
| AM-A lean UserUpdate | gate review | → folds into schemas step | ✓ TC-B7, TC-F5 already amended | QA done; plan folds at /implement |
| AM-B Settings sites + export hermeticity comment | gate review | → new: openapi_export.py, test_health.py join files-to-modify | indirectly TC-F1 (export must run) | fold at /implement |
| AM-C limiter per-app safety | gate review | → app.py/auth wiring step + explicit argument at diff review | ✓ TC-D1 order-dependency note already documents shared-storage behavior live | fold at /implement; senior gate |
| AM-D register-429 pytest | gate review | → Test plan gains `test_register_429` | ✓ TC-D2 restated as one-time proof, not CI gate | fold at /implement |
| AM-E/F revocation + PATCH happy path | R1/R2 | → hooks + 2 pytest cases | → QA adds TC-C5 (revoked-after-reset 401) | fold at /implement + /test |
| AM-G min-length 8 | R3 | → validate_password + `test_short_password_400` | n/a (curl adds nothing over pytest here) | fold at /implement |
| AM-H extras ignored | R4 | ✓ no plan change (Pydantic default) | → TC-B7 ambiguity note deleted, 200 stays | resolved |
| AM-I 429 detail envelope | R5 | → handler swap + 429 response model + 1.5 note edit | → TC-D1/TC-D3 flip to `detail`, no `error` | fold at /implement + /test |
| AM-J unique-index expectation | my finding | → migration hand-review list: drop `uq_users_email` | → TC-E2 switches to pg_indexes | fold at /implement + /test |
| AM-K future-task carry-forwards | R6 | §7 below | n/a | recorded |

/implement's report MUST tick every row above individually — standing process
rule from the 0.1 retro.

## 6. Risky spots — senior-lead's own verification (not delegated)

1. **Refresh-token-as-Bearer rejection is structural, and stays structural
   only by construction discipline**: `FastAPIUsers` built with the JWT
   backend ONLY (F6). Pinned three ways: plan pytest
   `test_refresh_token_rejected_as_bearer`, QA TC-B1, and my diff review
   checking the constructor argument. This is the single highest-value
   assertion in the task.
2. **Rotation + adapter-commit semantics**: refresh = destroy + write = two
   commits on the request session (backend's §13.4 finding). No partial-write
   risk in 1.1's single-purpose routes; flagged for any future
   route composing more work around a token operation. Accepted.
3. **DatabaseStrategy does NOT check `is_active`** (backend §13.4) — both
   custom routes re-check explicitly; pinned by `test_inactive_user_400` and
   the refresh-path equivalent. Verified the plan's skeletons contain the
   re-check.
4. **Reset-token-in-logs** is an accepted personal-app tradeoff, recorded with
   its trigger ("real second user" → email delivery). The token is
   short-lived (3600s default) and single-purpose; log access ≈ host access ≈
   game-over anyway. QA exercises the full live flow (Area C).
5. **Plaintext refresh tokens at rest** — DatabaseStrategy behavior (F4),
   explicitly recorded in architecture §3 with the same threat-model argument.
   Not silently inherited: it is a written decision the PM can veto.
6. **Post-decoration internals coupling** (`route.dependant.call`) — the one
   genuinely fragile mechanism in the task. Contained by AM-D (CI pytest) +
   TC-D2 (live proof) + recorded fallback (login-only limiting). Accepted
   with eyes open.
7. **Subprocess alembic in tests** — sound: schema-under-test IS migration
   output (0001 continuously validated), and the subprocess sidesteps the
   `asyncio.run` loop clash in env.py. TRUNCATE-per-test is appropriate at
   this table count.

## 7. Carry-forwards to future tasks (AM-K — durable record; each grooming reads this)

- **1.2 (models/migrations)**: create `profiles`; extend `on_after_register`
  to create the profile row; BACKFILL profiles for pre-existing users in the
  1.2 migration (architecture §4 obligation).
- **1.5 (web auth flow)** — from contract-review-web.md, all three are 1.5
  scope, not 1.1 changes:
  1. `/auth/login` call needs BOTH a urlencoded `bodySerializer` AND an
     explicit `Content-Type: application/x-www-form-urlencoded` header —
     openapi-fetch 0.17.0 hard-defaults JSON Content-Type and the call 422s
     without the override. Wrap once in an api-client `login()` helper
     (maps email→`username`).
  2. Refresh coordinator: in-tab shared in-flight promise +
     `navigator.locks` cross-tab serialization + localStorage as single token
     source RE-READ after lock acquisition; propagate new pairs via storage
     events. Single-use rotating refresh makes this mandatory, scoped into
     1.5's grooming.
  3. One error envelope: `detail` everywhere incl. 429 `RATE_LIMITED`
     (AM-I) — client error helper is single-branch. Register-input schema
     carries ignored optional privilege fields (stock BaseUserCreate) — use
     email+password only.
- **3.1 (scheduler)**: daily expired-refresh-token purge job
  (`DELETE WHERE created_at < now() - lifetime`) — architecture §6 decision,
  APScheduler arrives at 3.1. Until then expired rows are inert (max-age
  enforced on read).
- **5.1 (OAuth)**: create `oauth_accounts` then (deferred from 1.1 —
  architecture §4, PM question 1); CASCADE ondelete; accounts merge by email
  per the architecture doc.
- **Multi-user trigger** (architecture §6): revisit reset-token log delivery
  (→ email), refresh reuse-detection/token families, per-token grace window,
  Redis rate-limit storage (second worker/instance), email verification.

## 8. Decisions made this grooming (PM may veto, no answer required)

Consolidated from architecture §12 + plan + my rulings: custom slim
login/refresh/logout on library primitives; JWT-backend-only Authenticator;
rotation on every refresh, no reuse detection (trigger recorded); revocation
on password reset/change (R1); own models `users`/`refresh_tokens`, native
Uuid, migration 0001 = exactly these two tables; lean `UserRead`/`UserUpdate`
with three documented type-ignores; form-encoded login kept; body-pair token
transport; verify router skipped, reset router mounted with log delivery,
users router mounted full (verified /{id} superuser-gated); slowapi on all
three unauthenticated routes with `{"detail":"RATE_LIMITED"}` 429s (R5) and
per-app-safe wiring (AM-C); min-length-8 password policy only (R3); UserUpdate
extras ignored (R4); `jwt_secret` required Setting (also reset-token secret);
subprocess-alembic + TRUNCATE test story; no purge job until 3.1.

## 9. Open questions for the PM (veto-style; defaults = recommendations, non-blocking)

1. **`oauth_accounts` deferred to 5.1** despite the architecture doc's "схема
   базы уже это учитывает" — the doc's intent (same user PK, merge-by-email)
   is preserved by design, not by an empty table frozen against a moving
   library. **Recommendation: defer** (architecture §11 Q1).
2. **`profiles` deferred to 1.2** with the backfill obligation recorded.
   **Recommendation: defer** (architecture §11 Q2).
3. **Form-encoded login kept** (web review: ACCEPT, one wrapper at 1.5).
   **Recommendation: keep** — last cheap moment to veto to JSON has now
   passed review by the consumer who'd pay for it.
4. **Lean schemas cost three documented `# type: ignore[arg-type]`** under
   pyright strict (S1 + AM-A). **Recommendation: accept**; veto = stock
   5-field shapes, zero suppressions, privilege-field noise in the TS types.
5. **All three unauthenticated routes rate-limited via post-decoration**
   (fragile internals, CI-gated by AM-D). **Recommendation: accept**; veto =
   login-only limiting, zero internals coupling.
6. **Revoke-all on password change with no current-session carve-out** (R1) —
   changing your password logs out ALL devices including the one making the
   change (access JWT survives ≤15 min). **Recommendation: accept** — the
   possession model has no session identity to carve out, and this is the
   conservative default for the security-critical task.

No blocking questions. Ready for /implement on PM's go: backend implements
plan.md + AM-A…AM-J; QA folds TC deltas (TC-B7 note, TC-C5, TC-D1/D3, TC-E2)
before /test; /implement report ticks §5 row by row.
