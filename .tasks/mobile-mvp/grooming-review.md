# Grooming review (Phase 4) — mobile-mvp (1.8)

Reviewer: senior-lead. Artifacts reviewed: architecture.md, plan-mobile.md,
plan-web.md, obligations.md (own), qa-mobile-checklist.md (§6, appended after
mobile-qa's first run).

## 1. Verdict summary

- **architecture.md — ACCEPTED** (all six verdicts). Grounded in real files, one
  honest flagged question (S1) instead of a buried default.
- **plan-web.md — ACCEPTED, no send-back.** Import-site inventory independently
  verified by senior-lead grep: patch importers = exactly the 2 form modals;
  narrow-helper importers = auth/errors.ts + lib/errors.ts (+ errors.test.ts,
  covered by the plan's test split); ALL ApiError/throwOnError consumers import
  via `lib/query` (10 files), so the re-export shim covers every site; direct
  `new ApiError` sites all inside shim-covered modules. The dependencies-not-dev
  ruling (shared types in api-client's public signatures) is correct.
- **plan-mobile.md — ACCEPTED with two recorded notes (R3, R4 below), no
  send-back.** Obligation coverage table complete: every ID in obligations.md is
  mapped, none marked n/a, and I cross-checked each mapping against the section
  text (spot-checks: W8 dual-month Set, W3 composite key literal, AM-1.6-c
  segmented wording — all present and correctly stated).

## 2. Senior-lead rulings

**R1 — S1 amendment STANDS; promotions land IN THIS TASK; copy contingency is
dead.** PM confirmed the expectation. Implementation sequencing: the
frontend-engineer's plan-web.md moves are LAYER 1 of /implement (api-client
additions + shared export + web re-pointing, S3 gate green), and mobile layers
build on the promoted imports. plan-mobile.md's copy-contingency clause (its open
question 1) remains in the file as written but is EXPECTED DEAD — invoking it now
requires a new PM decision, not an engineer's discretion.

**R2 — native-module list APPROVED, all four** (PM concurred):
`expo-secure-store` (O2, mandatory), `@react-native-community/datetimepicker`
(native picker UX over a masked input; Expo-Go compatible),
`expo-haptics` (confirmation haptics, Expo-first, trivial weight),
`expo-localization` (explicit locale for formatMoney/date — Hermes-on-Android
host-locale unreliability is a real defect class). Also approved:
`@tanstack/react-query` (pin to web's version), `react-hook-form` +
`@hookform/resolvers`, `zod` pinned to shared's version, `@budget/api-client`
workspace dep. NOT approved (correctly absent): AsyncStorage, any UI kit,
jest-expo (see R5).

**R3 — O5 accepted WITH NOTE (the one place I push on plan-mobile).** The plan's
resume handling ("if `inFlight` non-null, don't start a second refresh; awaiters
resolve when the suspended promise settles") is the right single-flight
discipline, but it silently assumes a suspended in-flight fetch always SETTLES on
resume. On iOS the OS can kill the underlying native request during suspension;
RN's fetch usually rejects on resume ("Network request failed" → terminal path,
fine), but a never-settling promise would strand every awaiter with no recovery
path. REQUIRED at implementation: the resume handler must treat this as a
possibility — cheapest honest form: on `active` resume with `inFlight` non-null,
race the existing promise against a short timeout; on timeout, clear `inFlight`
and let the next 401 start a fresh refresh (single-flight preserved; worst case
is one extra refresh attempt, not a spent-token double-use, since the rebuilt
request replays only after the fresh refresh resolves). mobile-qa Section B must
include the background-mid-refresh journey (it is in their brief). This is a
plan note, not a bounce — design is otherwise per O5.

**R4 — cold deep-link "transaction unavailable" state accepted.** The 1.4
contract review allowed refetch-containing-list OR redirect; the plan's
unavailable-state-with-back is materially the redirect arm. Accepted because
mobile MVP has no external deep-link source into the edit modal. The `month`
typed param makes the refetch-and-locate upgrade cheap if a real source appears
— recorded as the future trigger.

**R5 — test-runner ruling: vitest-only ACCEPTED; `src/wiring.test.ts` DELETED
(scaffold-lifetime rule discharged).** The decision is properly load-bearing on
the DI architecture: `coordinator.ts` must never statically import
`expo-secure-store`/`react-native`/`expo-*` — at diff review I will grep
`apps/mobile/src/auth/coordinator.ts` (and everything vitest imports) for those
specifiers, same gate as api-client's web-globals grep. jest-expo stays out with
a recorded re-entry trigger (complex in-component logic in a later task).

**R6 — api-client file naming accepted as proposed** (single `src/errors.ts` for
carrier + narrow; `src/patch.ts`). No split required.

## 3. Cross-plan seam check (mobile imports vs plan-web exports)

plan-mobile consumes from `@budget/api-client`: `ApiError`, `throwOnError`,
`buildCategoryPatch`, `buildTransactionPatch`, `emptyToNull`, `getErrorCode`,
`getValidationIssues`, `locTailField`, `routeIssue`, `ValidationIssue`,
`FieldError`, plus pre-existing `createApiClient`, `login/refresh/logout/
register`, `TokenPair`, `components`. plan-web's barrel additions + existing
exports cover EXACTLY this set — no gap, no extra. From `@budget/shared`:
`HEX_COLOR_PATTERN` (plan-web item 4) + the pre-existing schemas/money/dates
surface. **Seam closed.** `FetchResult<T>` stays unexported — correct; mobile's
204-delete unwrap copies the inline pattern and does not need it.

## 4. Per-obligation gate (plans)

- O1–O7: plan-mobile §A (+§B for O6). O4's spike has a committed default
  (captured-init rebuild) and a code-grounded finding (openapi-fetch 0.17.0
  builds `new Request` and passes it to the injected fetch — library code, so
  (a) holds structurally; only clone-body semantics remain on-device). O5 per R3.
- AM-1.6-a/b: plan-mobile §D (copied qk; offset=pageParam; single
  archived-inclusive cache). AM-1.6-c: §E, segmented wording used throughout —
  the word "filtered" does not appear in a picker context in either plan.
  AM-schemas: §E (RHF + zodResolver over the SAME shared schemas + month
  helpers). AM-hex: plan-web item 4 + plan-mobile HexSwatch.
- W1–W11, A-1: all mapped in plan-mobile §I and verified present in body text.
  W11 has a real verification procedure + isolated fallback.
- S1 (amended): plan-web bounds (generated/** byte-identical, additive barrel,
  type-only edge — grepped at diff review). S2: satisfied (plan-mobile.md /
  plan-web.md, no plan.md). S3: both plans state the full turbo gate incl. web's
  suite as the promotion regression gate. S4: R5. S5: no new packages. S6:
  plan-mobile §C with honest device failure modes.

## 5. Conflicts between artifacts

None blocking. Two wording deltas, both immaterial: (1) plan-mobile derives
`has_more` as `loaded < total` vs the obligation's `offset + items.length <
total` — equivalent under accumulated infinite-query pages; (2) plan-mobile's
create-form currency comes from the month summary (web's R2 workaround) — 
consistent with W7 and the recorded 3.2 trigger for a real profile endpoint.

## 6. QA checklist review — ACCEPTED with rulings (mobile-qa's first delivery)

Structure conforms to their conventions: Section A = simulator journeys
(TC-1..TC-35, TC-21 merged), Section B = 9 manual device items (TC-36..TC-44)
that mobile-qa never self-marks passed. Every expected result traces to an
obligation ID; the coverage map correctly routes structural items (S1–S5, O1,
A-1 encoding, AM-hex web-copy deletion, W1 builder internals) to the senior
diff gate. AM-1.6-c wording verified: the picker is "kind-SEGMENTED"
throughout; "filtered" appears only in the prohibition statement. The
wire-observation split (uvicorn access log for request counts/paths;
proxy-or-code-read for literal bodies, deferred to my gate by default) is
honest and matches web QA precedent.

**Rulings on the flagged blockers:**

- **R7 — environment (no full Xcode → no `xcrun simctl`): PM ruled DO NOT
  BLOCK.** Implementation proceeds fully. At run time Section A degrades
  honestly to what this machine can do: Metro bundle boot + content checks
  (0.1 precedent), Expo-served bundle inspection, the vitest coordinator
  suite, uvicorn access-log wire observation, and code-reads for flagged
  structural items. Every simulator-only TC is marked ⏸ blocked-environment —
  NEVER passed. The full Section A+B manual checklist ships in the final
  bundle for the user, with the Xcode-install / physical-device option
  surfaced prominently. mobile-qa's "any Section A failure → FAIL OVERALL"
  rule applies to what actually runs; blocked-environment is a distinct state.
- **R8 — TC-7/TC-10 TTL setup is UNBLOCKED**: the API's access-token TTL is
  configurable (`access_token_lifetime_seconds` in Settings, from 1.1). A
  dev-only short TTL wired through app config/env for the run is legitimate,
  provided committed defaults are unchanged (my diff gate checks that no
  default changes land).
- **R9 — minor gap, run-phase addition (no re-groom round):** add a
  register-duplicate step to TC-1 (attempt to register the SAME email again →
  field-level `REGISTER_USER_ALREADY_EXISTS` copy, retryable, no crash). This
  exercises the register arm of the O7 copy table, currently untested.
  mobile-qa executes it as TC-1b at run time.
- Numbering nit (not actionable): the Section A summary says 33 TCs; TC-1..35
  minus the merged TC-21 is 34.

## 7. Gate outcome

All grooming artifacts ACCEPTED. Pipeline (PM-confirmed): (1) frontend-engineer
lands the 4 promotions + AM-hex first with the full S3 gate; (2) senior diff
gate on that layer; (3) mobile-engineer implements plan-mobile.md; (4) senior
diff gate incl. all structural obligations; (5) mobile-qa degraded-honest run
per R7; (6) /review_senior → review.md + meta-review.md; (7) final bundle.
NO commits at any stage.
