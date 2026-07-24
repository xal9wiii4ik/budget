# Grooming Review (Phase 4) — web-auth-flow (roadmap 1.5)

Senior-lead critical review of plan-web.md (frontend-engineer, spike-verified),
qa-web-checklist.md (web-qa's FIRST checklist, 27 TCs), coordinator-review-mobile.md
(mobile-engineer narrow review: ACCEPT ×5, 2 constraints, 7-item 1.8 obligations).
Verdict: **accepted with the amendments below.** No artifact goes back for rewrite;
amendments are binding on the implementer and QA folds its deltas before /test.

## 1. Team selection (recorded)

frontend-engineer (implements; all apps/web + hand-written modules in
packages/api-client + shared zod additions) + web-qa (first invocation — browser
journeys) + mobile-engineer in a NARROW review-only role (coordinator portability
for 1.8 — the review paid for itself: two load-bearing constraints and a 7-item 1.8
obligations list now on durable record). NOT invoked: backend-engineer (zero API
changes — asserted at grooming start: HEAD d9e39f1 clean, generated contract covers
every auth surface; the gate is that `schema.d.ts` ends the task byte-identical);
qa-engineer (no endpoint changes; API pinned at 1.1 by pytest + 35 live checks;
web-qa's journeys exercise the live API anyway); architect (the design center — the
refresh coordinator — was designed and recorded as binding at 1.1 §7.2; remaining
structure is apps/web-internal, gated by this review; architect charter is backend).
code-reviewer arrives at /review_senior.

Ownership ruling (recorded): frontend-engineer's "don't change packages/api-client
by hand" rule covers the GENERATED contract. Hand-written modules alongside the
existing hand-written `client.ts` are frontend scope — and 1.1 §7.1 mandates the
`login()` helper live there.

## 2. Senior-lead's own verification (not delegated)

1. **openapi-fetch spike spot-checked against source**: lines 2–4/20
   (requestInitExt guard → browser wrapper signature is `(input, init)`), line 32
   (per-call bodySerializer precedence), line 123 (`await fetch(request,
   requestInitExt)` — wrapper receives a fully-built Request). All four citations
   accurate. The S1 rejection (onResponse cannot retry bodied requests — body
   consumed at line 123 before onResponse runs) is sound web-platform semantics;
   the fetch-wrapper choice is correct and future-proofs 1.6's POST/PATCH.
2. **Logout contract verified in schema.d.ts**: `POST /auth/logout` takes JSON
   `LogoutRequest {refresh_token}`, returns 204, no bearer declared — plan D14's
   claim holds.
3. **ErrorModel verified**: `detail: string | {[key: string]: string}` (schema
   L357–361) — getErrorCode's two-arm narrow (string → code; object →
   `detail.code`) matches the generated union; a Pydantic ValidationError[] array
   falls through to `undefined` safely (`detail.code` non-string).
4. **packages/shared/src/schemas.ts read in full**: contains ONLY
   currencyCodeSchema + moneyAmountSchema (currency/money). See §3 (E16 ruling).
5. **App.test.tsx read**: asserts the formatMoney scaffold demo (`$123.45`) via
   renderToStaticMarkup — breaks when App.tsx is replaced; plan omitted it → AM-4.
6. **Registry check (plan open Q1)**: react-router latest is 8.3.0 with v8.0.0
   published 2026-06-17 (five weeks old); v7 line current at 7.18.1. Peer deps
   verified: @tanstack/react-query 5.101.4 (`react ^18||^19` — ok with 19.2.8),
   @hookform/resolvers 5.4.0 (`react-hook-form ^7.55.0` — ok with 7.82.0). → AM-5.

## 3. PM point 1 — the E16 "discrepancy": RULED NOT A DISCREPANCY (with a precision amendment)

The mobile review's flag ("plan claims shared zod schemas don't exist, but
schemas.ts exists with tests") is a MISREAD of E16, and I verified against the file
itself: `packages/shared/src/schemas.ts` contains only currency/money schemas
(currencyCodeSchema, moneyAmountSchema). There are NO email/password/auth schemas
anywhere in shared. Plan E16 already says "add to packages/shared/src/schemas.ts"
— it extends the existing file; it does not re-invent anything that exists. The
plan does NOT get sent back for this, and "consume the existing shared schemas" is
unsatisfiable for auth — there is nothing to consume.

What the flag DOES earn is AM-1: the new schemas join the existing file under its
established conventions (error MESSAGES are not contractual — clients key on
codes/params for i18n, mirroring the non-exported MONEY_ERROR_MESSAGES pattern;
barrel export from src/index.ts), and E16's wording "None exist today" folds to
"no AUTH schemas exist today" at implement so no later reader trips on it.

## 4. PM point 3 — plan ↔ qa-web-checklist cross-check

Every coordinator edge case the plan claims is covered by a journey:

| Plan claim | Checklist coverage |
|---|---|
| 401 → single silent refresh → replay once (D11/S2) | TC-10 (tamper access token; assert exactly ONE /auth/refresh + one replay), TC-21 (no duplicate refresh) |
| Terminal refresh failure → clear → redirect `?next=…&reason=expired` (D13) | TC-11 (+ banner + return-to after re-login), TC-25.4 (banner survives F5) |
| Return-to-intended-route survives reload (A3) | TC-14; open-redirect guard TC-15 |
| Multi-tab: one refresh across tabs, login/logout propagation (D12/D14) | TC-18/TC-19 (honestly marked manual/best-effort) |
| Form-encoded login 200-not-422 (S3, 1.1 §7.1) | TC-16 (wire-level assert in network log) |
| Register auto-chain + partial failure (E17) | TC-3, TC-20 (honestly marked covered-by-design + vitest) |
| Guard on token presence, warm/cold deep-link (B6) | TC-12, TC-13 |
| me-query disabled when logged out; no storms; StrictMode (B5/risks) | TC-21 |
| Logout revoke+clear+cache-clear (D14) | TC-17 |
| login min(1) vs register min(8) (E16) | TC-7 — a genuinely sharp TC |
| Error copy table (E18) | TC-4, TC-6, TC-8, TC-22 |
| UI states, 404, F5-everywhere, 375px, keyboard a11y | TC-23–TC-27 |

Gaps found: **none blocking.** Two notes: (a) REGISTER_INVALID_PASSWORD's
server-side 400 is unreachable through the UI (client zod gates min-8 first, TC-2
asserts no network call) — correct; the server backstop stays pinned by 1.1
pytest, the client copy exists as dead-man fallback; not a TC gap. (b) The suite
registers many throwaway users — the register rate-limit can trip mid-suite; run
note added in AM-6.

## 5. PM point 4 — web-qa conventions audit (first invocation)

PASS. Template followed (Scope / numbered TCs with precondition-steps-expected-
status / final report skeleton). The vitest-vs-browser split is explicit and
justified in Scope (F20 unit logic not duplicated; observable wire/UI effects
only), the qa-engineer boundary is respected (the one wire assert, TC-16, is a
browser-network-log check — exactly the F21 handoff), evidence requirements are
concrete (network-log counts, console-zero, localStorage state), and — the thing I
most wanted from a first invocation — honesty markers: TC-18/19 "manual/
best-effort, do not fake it", TC-20 "do not fabricate a pass". Coverage map ties
all 10 mandatory categories, with category 6 (money/dates) correctly n/a for a
stub-only task. This checklist is the template for future web tasks.

## 6. Rulings on web-qa's open questions

- **Q1 (banner)**: show it; exact copy pinned for assertion: "Your session
  expired — please sign in again." (AM-6; also resolves plan open Q2.)
- **Q2 (two-tab tooling)**: accepted — vitest single-flight/adopt tests are the
  PRIMARY evidence for cross-tab serialization; TC-18/19 are best-effort browser
  confirmation and ⏸ blocked(tooling) is an acceptable terminal state for them,
  NOT a fail. The real-locks guarantee then rests on F20 + design review — a
  recorded, eyes-open accept.
- **Q3 (interception for TC-20)**: do not build interception infra for one TC.
  covered-by-design + vitest is the accepted terminal state; if Playwright turns
  out trivially available at run time, blocking the second /auth/login is welcome
  but optional.
- **Q4 (provisioning)**: no email-verification wall exists — 1.1 §8 records the
  verify router as skipped; register→auto-login works immediately. Limiter
  windows: the 1.1 limiter uses in-memory storage — restarting the API resets it
  (see AM-6 run note). TC-22 stays last.

## 7. Amendments (binding)

- **AM-1 — auth schemas extend the existing schemas.ts under its conventions**
  (§3): emailSchema + loginFormSchema (min 1) + registerFormSchema (min 8, exact
  server R3 alignment) added to the EXISTING packages/shared/src/schemas.ts;
  messages non-contractual (clients key on codes, MONEY_ERROR_MESSAGES pattern);
  barrel export; E16 wording precision-folded at implement. No vacuous schema
  tests (plan F20 already skips them — correct per repo test rules).
- **AM-2 — platform-free shared auth surface (mobile constraint 1) with a
  DIFF-GATE**: `packages/api-client/src/auth.ts` and `getErrorCode` must not
  reference window/document/localStorage/sessionStorage/navigator/DOM globals —
  they operate only on the passed ApiClient, plain args, return values. Gate: at
  my diff review I grep those identifiers across packages/api-client/src
  (generated excluded); ANY hit = send-back, no discussion. A header comment in
  auth.ts states the constraint for future editors.
- **AM-3 — no synchronous storage signature on shared surfaces (mobile
  constraint 2)**: TokenStorage/LockManager interfaces and every sync token-read
  live ONLY in apps/web/src/auth/. Exporting `TokenPair` as a plain data type
  from packages/api-client is allowed; exporting a `read(): TokenPair | null`
  style sync interface is not. Same diff-gate pass as AM-2.
- **AM-4 — App.test.tsx handled (my finding, plan gap)**: delete
  apps/web/src/App.test.tsx (asserts the formatMoney demo; its scaffold-wiring
  purpose is obsolete). Do NOT write a vacuous replacement render-test; coverage
  comes from F20 coordinator tests + web-qa journeys.
- **AM-5 — exact version pins (resolves plan open Q1)**: react-router **7.18.1**
  (NOT 8.3.0 — v8.0.0 shipped 2026-06-17; a five-week-old major has no place in
  the foundational task, and the plan's declarative-mode reasoning was written
  against v7; v8 upgrade is a cheap mechanical follow-up), @tanstack/react-query
  **5.101.4**, react-hook-form **7.82.0**, @hookform/resolvers **5.4.0**. Zod-4
  bridge latitude: zod resolver if it typechecks against zod 4.4.3, else
  `standardSchemaResolver` (zod 4 implements Standard Schema) — implementer
  proves via typecheck. Zustand **not installed** (B5 accepted). Exact pins, no
  `^` (project convention).
- **AM-6 — QA checklist deltas (fold before /test)**: pin the banner string
  "Your session expired — please sign in again." in TC-11/TC-25; record §6 Q2/Q3
  terminal-state rulings inline in the TCs; add run note: in-memory rate limiter
  resets on API restart — if register/login 429s stall the suite mid-run, restart
  the API; TC-22 remains last.
- **AM-7 — clone-before-mutate discipline in authFetch (diff-review
  checkpoint)**: `const retry = original.clone()` MUST precede any bearer-attach
  that constructs a new Request from the original (`new Request(original, …)`
  consumes the original's body). The plan's D11 pseudocode order is already
  correct — this amendment pins the ORDER as load-bearing so implement doesn't
  reorder; mutating `request.headers.set('Authorization', …)` in place is
  acceptable latitude. Covered by the F20 retry-once test; I re-check the order
  at diff review.
- **AM-8 — E17 prefill mechanics**: the register-partial-failure email prefill
  travels via router location state (best-effort, lost on reload — acceptable),
  NEVER a `?email=` query param (PII in URL/history).

## 8. Per-amendment / carry-forward checklist (Phase 4 obligation)

| Binding item | Source | In plan-web.md | In qa-web-checklist.md | Verdict |
|---|---|---|---|---|
| 1.1 §7.1 form login: bodySerializer + Content-Type + api-client login() (email→username) | 1.1 carry-forward 1 | ✓ S3 + C8 (both set, defensive) | ✓ TC-16 wire assert | covered |
| 1.1 §7.2 coordinator: in-tab promise + navigator.locks + re-read-after-lock + storage events | 1.1 carry-forward 2 | ✓ D11/D12/D14, seams for vitest | ✓ TC-10/11/18/19 + F20 primary | covered |
| 1.1 §7.3 single detail envelope; register = email+password only | 1.1 carry-forward 3 | ✓ C9 getErrorCode (narrow matches verified ErrorModel union) + E16 | ✓ TC-4/6/22 copy asserts | covered |
| 1.3/1.4 obligation lists checked for 1.5-relevant items | task brief | ✓ only C9 extensibility is 1.5-relevant (getErrorCode must extend by map, not restructure — satisfied: raw-code return, app-owned copy table; 1.4's string\|ValidationError[] arm falls through safely) — all else is 1.6 scope, still in force there | n/a | covered |
| Contract artifacts untouched (schema.d.ts byte-identical) | standing rule | ✓ asserted + Files-touched | n/a (no curl) | I diff at review |
| Root-file ownership: no root changes; conditional turbo/eslint heads-up only | 0.1 §1.1 | ✓ verified .gitignore covers apps/web/.env; no request needed | n/a | covered |
| Exact-pin convention | 0.1 | ✓ → AM-5 pins concrete versions | n/a | fold at /implement |
| Full lint gate every fix round | standing rule | ✓ (typecheck+lint before done) | n/a | /implement gate |
| AM-1 schemas extend existing file | §3 | → fold at /implement | n/a | fold |
| AM-2/AM-3 platform-free shared surface (mobile constraints) | mobile review | → auth.ts header comment + placement | n/a | fold; MY GREP GATE at diff review |
| AM-4 App.test.tsx deleted | my finding | → files-touched addition | n/a | fold |
| AM-5 pins + resolver latitude + no Zustand | my ruling | → package.json step | n/a | fold |
| AM-6 QA deltas (banner string, terminal states, limiter-reset note) | §6 rulings | n/a | → fold before /test | fold |
| AM-7 clone-order pinned | my review | ✓ pseudocode already ordered; pinned as load-bearing | ✓ TC-10 observable | senior gate |
| AM-8 prefill via location state, no ?email= | my review | → E17 fold | ✓ TC-20 expected text unchanged | fold |
| Mobile 1.8 obligations recorded durably | mobile review | n/a — lives in coordinator-review-mobile.md §"1.8 obligations"; 1.8 grooming MUST read it | n/a | recorded |

/implement's report MUST tick every row individually (standing 0.1 retro rule).

## 9. Risky spots — accepted with eyes open

1. **localStorage JWT pair (XSS exposure)** — settled at architecture/1.1
   (rotation limits blast radius; personal app); restated here as a written
   accept, not silently inherited. PM veto = memory+refresh-cookie redesign (not
   recommended; contradicts the recorded 1.1 coordinator design).
2. **Cross-tab serialization evidence is vitest-primary** (§6 Q2) if the browser
   pane can't drive two tabs. Residual risk: real navigator.locks behavior only
   design-reviewed, not machine-verified. Accepted; revisit if a real double-spend
   401 ever shows in the field.
3. **Undeclared error statuses** (login 400 LOGIN_BAD_CREDENTIALS, refresh
   non-200s absent from the generated response types) — runtime-read by
   getErrorCode/coordinator; no schema change permitted this task. Recorded so
   nobody "fixes" it client-side by trusting generated response types. A future
   backend task MAY declare them (contract change, backend-owned, not 1.5).
4. **StrictMode double-invoke** — plan risk noted; TC-21 observes; F20 asserts
   idempotent subscribe. Watched, not blocking.
5. **openapi-fetch version coupling** — the wrapper mechanism is pinned to
   0.17.0's line-123 behavior; any bump must re-run the S1/S2 spike (plan risk
   note stands; add to review checklist whenever api-client deps change).

## 10. Open questions for the PM (veto-style; defaults = recommendations, non-blocking)

1. **react-router 7.18.1 over 8.3.0** (AM-5). Recommendation: v7 now, mechanical
   v8 follow-up later. Veto = absorb a 5-week-old major in the foundation task.
2. **Session-expiry banner shown, copy pinned** ("Your session expired — please
   sign in again."). Recommendation: show it. Veto = drop banner, QA folds TC-11/25.
3. **Zustand not installed this task** despite the architecture doc naming it.
   Recommendation: accept (no genuine client state yet; useSyncExternalStore
   covers reactivity; revisit at 1.6 when real UI prefs appear).
4. **Cross-tab guarantee at vitest-primary evidence level** (§6 Q2 / risky spot
   2). Recommendation: accept.
5. **localStorage token storage restated** (risky spot 1). Recommendation: accept
   (already the recorded 1.1/architecture decision).

No blocking questions. **Ready for /implement on PM's go**: frontend implements
plan-web.md + AM-1…AM-8; web-qa folds AM-6 before /test; /implement report ticks
§8 row by row; my diff review runs the AM-2/AM-3 grep gate, the AM-7 order check,
and the schema.d.ts byte-identical diff.

---

## 11. Implementation-phase addendum (recorded post-pipeline)

- **AM-9 (issued mid-implement) — CORS middleware in apps/api.** Web-qa run 1
  proved the app non-functional in a browser: no CORS headers anywhere, preflight
  OPTIONS → 405. This was a GROOMING GAP owned by senior-lead: the "backend-engineer
  NOT needed" assertion held for the contract but missed integration wiring (nobody
  asked who answers the preflight). Ruling: CORS middleware in the API (architecture
  §3 prescribes it; production is cross-origin by design at 1.7) over a vite proxy
  (would mask the gap until deploy). backend-engineer joined for the narrow fix:
  `cors_origins: list[str]` Setting (default `["http://localhost:5173"]`, env
  `CORS_ORIGINS` as JSON array for 1.7), CORSMiddleware with allow_credentials=False
  (bearer-in-header, not cookies), one non-vacuous both-branch preflight pytest.
  Contract artifacts confirmed byte-identical (drift test green; SHA-256 unchanged).
- **Diff-gate rulings**: client.ts fetch-seam widening to openapi-fetch's own
  declared type ACCEPTED (verified dist/index.d.ts L8); register()'s explicit
  default privilege flags NOT a carry-forward-3 violation (generated UserCreate
  marks them required); PLAN.md ⬜→🔄 flip accepted with a process note (roadmap
  bookkeeping belongs to the orchestrator, not the implementer).
- **QA outcome**: run 1 FAIL OVERALL (CORS, 8/4/15) → fix → run 2 READY FOR
  REVIEW (22 passed / 0 failed / 5 blocked, all blocked = pre-accepted terminal
  states per AM-6: TC-10/11-e2e tamper unreachable by tooling — vitest-primary;
  TC-18/19 two-tab tooling; TC-20 covered-by-design).
- **Review round**: review.md APPROVE-WITH-FIXES (1 MAJOR, 4 MINOR, 3 NIT) →
  meta-review.md (all findings agreed; finding 4 upgraded to required; safeNextPath
  unit test added by senior; findings 6/8 deferred to 1.6) → fix round landed
  (coordinator stored===null arm + sessionExpired invariant, backslash reject +
  6-case validator test, body-preservation + refresh-rejection + cross-tab-logout
  vitest cases, logout keepalive, maxConcurrent assert). Senior re-gate: 16/16
  web tests, tsc/eslint clean (independently run), AM-2 grep clean post-edit.
- **Recorded for 1.6** (also in meta-review.md): me-query error affordance;
  bounce authed visitors off /login; client/server email-TLD validation mismatch
  (fold into the ValidationError[] field-mapping work); the body-preservation
  test is the AM-7 regression tripwire — do not weaken.

### Final per-amendment status

| Item | Status |
|---|---|
| AM-1 schemas extend existing file, conventions kept | ✅ done, reviewed |
| AM-2 platform-free auth.ts/getErrorCode | ✅ grep clean ×3 runs (post-implement, review, post-keepalive) |
| AM-3 no sync storage on shared surfaces | ✅ verified (TokenPair plain type only) |
| AM-4 App.test.tsx deleted, no vacuous replacement | ✅ |
| AM-5 pins 7.18.1 / 5.101.4 / 7.82.0 / 5.4.0, no Zustand | ✅ verified in package.json |
| AM-6 QA deltas folded, banner copy asserted | ✅ (run 2) |
| AM-7 clone-order | ✅ verified in code + now pinned by body-preservation test |
| AM-8 prefill via location state | ✅ verified (LoginLocationState; no ?email=) |
| AM-9 CORS (mid-implement) | ✅ implemented, gated, QA-verified live |
| 1.1 §7 carry-forwards 1/2/3 | ✅ consumed (TC-16 wire-proof; coordinator per design; single-branch helper) |
| Contract byte-identical | ✅ 0 diff lines, drift test green |
| Root files | PLAN.md status flip only (accepted with process note) |
