# QA Mobile Checklist: mobile-mvp (roadmap 1.8)

## Scope

Simulator + manual-device user-journey verification for the Expo mobile client
reaching MVP parity with web (task 1.8): auth (register/login/logout + the
coordinator's storage/refresh/resume model), the transactions month screen
(list + summary header + paging + CRUD), the categories screen (grouped list +
CRUD + archive + is_system gating), navigation/protected-route gating, and the
two on-device platform verifications (`Request.clone()` spike outcome,
`Intl.Collator` under Hermes). All on the existing API — **contract untouched
(S1)**: no API changes, `packages/api-client/src/generated/**` byte-identical.

This checklist is the **mobile** half of the split. It does NOT re-verify pure
logic owned by mobile-engineer's vitest suite (the auth coordinator core:
hydrate-once, single-flight dedup, 401→refresh→retry, terminal-clear; the
copy-table error narrowing; `safeNextRoute`; `groupByDay`) — those are unit
tests (plan Section F). Here I verify the same obligations **manifest correctly
in a running app** through real user journeys: what the user sees on the phone,
what the API actually receives (via uvicorn access log / an optional intercept
proxy), and that caches invalidate to server truth.

Out of scope (belongs to qa-engineer, not here): API contract testing with
curl, HTTP status-code assertions in isolation, DB-level checks.

**Every expected result below traces to an obligation id** (O1–O7 / AM-* /
W1–W11 / A-1 / S-* from `obligations.md`); the trace is cited per TC. Nothing
here invents API behavior.

The category picker is **kind-SEGMENTED** everywhere in this document
(sanctioned pattern, AM-1.6-c) — never "filtered".

---

## ⚠ Run-phase environment prerequisite (RESOLVED 2026-08-18 — full Xcode + iOS 26.5 simulator now present; Section A executed, see "RUN 2" below. Text kept for history.)

Read-only environment probe run during grooming:

- `xcrun simctl` is **NOT available** on this machine right now:
  `xcrun: error: unable to find utility "simctl", not a developer tool or in PATH`.
- `xcode-select -p` → `/Library/Developer/CommandLineTools` (Command Line Tools
  only). `simctl` and the iOS Simulator ship with the **full Xcode.app**, which
  is not installed.

**Consequence:** Section A as written (iOS Simulator via `xcrun simctl` +
`npx expo run:ios`) **cannot be executed in the environment's current state.**
This is a toolchain gap, not a product defect, and it is a run-phase blocker to
resolve BEFORE Section A can run. Two resolutions for the run phase:

1. **Install full Xcode** (App Store or `xcodes`), then
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` and accept
   the license — this restores `xcrun simctl` and lets `npx expo run:ios` boot a
   simulator. This is the assumed path (the task brief states a simulator is
   available on this Mac; that must be made true before the run).
2. **Fall back to Expo Go on a physical device** for the run — but a physical
   device makes several Section A "offline = kill the API" / screenshot /
   Metro-log steps behave as Section B device conditions. If Section A is run on
   a device instead of a booted simulator, note it in the results and treat the
   device-only caveats (real radio for airplane mode, real suspend for O5)
   as satisfied by that hardware.

Every Section A TC below is written to be executable **once a booted simulator
exists**. If the run phase still has no simulator and no device, Section A is
BLOCKED-by-tooling in whole, and the obligations fall to the vitest suite +
senior diff gate — state that explicitly in the final summary if it happens.

---

## Environment / setup preamble (for the run phase, not grooming)

### Bring up the stack

- **Postgres**: dev DB on `localhost:5443` (S6). Ensure it is up and migrated to
  head — migration `0003_seed_and_backfill` seeds the **18 system categories**
  (`user_id IS NULL`, frozen UUIDs, Russian names, RUB profiles). These are the
  `is_system` rows TC-31 checks and the base of the RUB/Russian-locale rendering.
- **API**: dev server on `:8010` (S6). Run convention from
  `apps/api/package.json`:
  `pnpm --filter @budget/api dev` → `uv run uvicorn budget_api.app:create_app
  --factory --reload`. **Bind to `0.0.0.0`** (add `--host 0.0.0.0`) if a physical
  device will reach it (Section B, TC-36); `127.0.0.1` is fine for the simulator
  (shares the Mac's loopback).
- **Mobile app**: from `apps/mobile`,
  `EXPO_PUBLIC_API_URL=http://localhost:8010 npx expo run:ios` to build+boot on
  the simulator, or `npx expo start` then press `i`. Setting
  `EXPO_PUBLIC_API_URL` explicitly is the always-works simulator baseline (plan
  Section C step 1 override; the `hostUri`-derivation is exercised for real in
  Section B/TC-36). Keep the **Metro terminal visible** — it is the device-log
  source for red-screens, `console.*`, and React key warnings.

### Wire-observation methods (which TCs need which)

- **uvicorn access log** (default `--log-level info`) prints one request LINE per
  call: `METHOD /path?query → status`. This PROVES *which* endpoints were hit and
  *how many times* — enough for: single-flight refresh count (TC-10: exactly one
  `POST /auth/refresh`), no per-row GET (`/transactions/{id}` must NOT appear on
  edit), and the dual-vs-scoped summary refetch (TC-18: summary refetches fire for
  the affected months only). It does **NOT** show request **bodies**.
- **Request-body inspection** (W1 omit-vs-null: TC-17/TC-20/TC-29) needs one of:
  - **(a) Intercept proxy (sanctioned wire-capture):** run `mitmproxy`/Charles on
    the Mac, then boot the app with `EXPO_PUBLIC_API_URL=http://<mac-ip>:<proxy>`
    forwarding to `:8010`, and read the captured PATCH/POST JSON. This is the only
    way to read the literal body on-device.
  - **(b) Fallback (default if no proxy):** prove the discipline **behaviorally**
    (server outcome + kill-relaunch persistence, exactly as web QA did — see
    `qa-web-checklist.md` TC-13/14/21 notes) **plus** code-read of
    `buildTransactionPatch`/`buildCategoryPatch`, and **defer the literal-body
    assertion to the senior diff gate.** TCs that rely on this fallback are
    flagged `[wire: proxy-or-code-read]` below.

### Seed data plan (dedicated test users, never real data)

All seeding via the **existing API POST endpoints** as a test user (no API
changes). Login is **form-encoded** with `username`=email (A-1) — the seed
script must POST the token endpoint form-encoded (confirm the exact path from the
generated client / the shared `login()` helper; do NOT re-derive the encoding).
Use `@budgetqa.dev` emails — the `.local`/`.test` reserved TLDs are rejected by
the server (that rejection is real behavior web QA hit).

**Accounts**
- `qa-mobile-main@budgetqa.dev` (pw `Qa!Test1234`) — the primary seeded user.
- `qa-mobile-empty@budgetqa.dev` (pw `Qa!Test1234`) — fresh: zero user
  categories, zero transactions (18 system cats only) — the empty-state user
  (TC-23) and the register-flow target if you register a brand-new one live.

Create fresh `qa-mobile-*` users rather than reusing web QA's leftover
`qa-web-main@budgetqa.dev` (which carries run-mutations) to avoid cross-suite
interference on the shared DB.

**Categories** (POST /categories as qa-mobile-main)
- User expense: "Groceries", "Food", "Rent", "Subscriptions", "Bonus"(expense).
- User income: "Salary", "Bonus"(income) — the two "Bonus" rows power the
  kind-flip 409 (TC-29).
- **Cyrillic set** (one kind, names where DB byte order ≠ ru collation, incl. an
  Ё/Е pair): "Ёлка", "Еда", "Кафе", "Продукты" (expense); "Зарплата" (income) —
  for TC-26.
- **Archived**: "Subscriptions" and "Rent" — assign transactions to them FIRST
  (below), THEN archive via PATCH `{archived:true}` — powers TC-31/TC-32.
- Leave the 18 system categories untouched (TC-31 read-only check).

**Transaction sets** (POST /transactions as qa-mobile-main)
1. **Current month, mixed & multi-day**: ~6 tx across ≥2 days, mixed
   expense/income, some uncategorized — TC-12/13/15 baseline.
2. **Previous month + year-rollover month**: a few tx in the previous month and
   in December-of-prior-year (so "prev" crosses the year boundary) — TC-12.
3. **Empty month**: leave one month deliberately with no tx — TC-23.
4. **Crafted negative-net + refund month**: one month where total expense >
   income (negative net) AND a **refund pair** — the SAME category (e.g.
   "Groceries") with one expense tx and one income tx (so `by_category` returns
   that category_id twice, once per kind) — PLUS at least one **uncategorized**
   tx — TC-13, TC-20.
5. **Heavy month (SEEDING-HEAVY)**: script a loop creating **250** tx all within a
   single target month (vary occurred_at day + amount; reuse a couple of
   categories). Auth once, then a throttled `for` loop of POST /transactions with
   the bearer token — TC-14.
6. **Archived-category tx**: ≥1 tx assigned to "Subscriptions" and one to "Rent"
   BEFORE archiving those categories — TC-31, TC-32.
7. **Cross-month set (months A/B/C)**: three DISTINCT months (kept apart from the
   rollover set §2) each with a handful of KNOWN-amount tx so each month's
   summary is hand-verifiable. Month A holds ONE clearly-identified target tx
   that TC-18 moves into month B by editing only `occurred_at`. Month C exists
   only to be pre-cached and observed to receive **no** summary refetch — TC-18.

### General run rules

- Sign in as the dedicated test user only; never real data.
- Screenshot at each key step: `xcrun simctl io booted screenshot <path>.png`,
  then Read the image to verify the actual rendered result.
- Watch the Metro terminal throughout; a red-screen, an uncaught error, or a
  React "two children with the same key" warning is a FAIL for the TC it appears
  under (except in the deliberate-failure TCs 3/4/23/24, where the *handled*
  error is the expected outcome).
- Status legend: ⏸ pending · ✅ pass · ❌ fail (with screenshot + Metro-log
  evidence) · ⏸ blocked (with reason + fallback).

---

---

## ✅ RUN 2 — executed 2026-08-18 on a REAL BOOTED SIMULATOR (supersedes the 2026-07-25 blocked-environment run below)

The R7 toolchain gap is CLOSED: full Xcode is installed, `xcode-select -p` →
`/Applications/Xcode.app/Contents/Developer`, iOS 26.5 runtime present. Every
Section A TC was executed against the app actually rendered on a device.

**Environment (run 2)**

- Device: **iPhone 17 Pro, iOS 26.5** (`97EA8741-3A57-4056-89BA-A88651C0EFD0`),
  system language **ru-RU** (this is what makes the RUB/Russian rendering real).
- App: **Expo Go 57.0.9** (simulator build installed manually — `npx expo start --ios`
  could not fetch it) loading `exp://127.0.0.1:8082` from a Metro dev server started as
  `EXPO_PUBLIC_API_URL=http://localhost:8010 npx expo start --port 8082`
  (8081 was occupied by an unrelated Cloud Datastore emulator).
- API: `uv run uvicorn budget_api.app:create_app --factory --port 8010` with
  `FX_SCHEDULER_ENABLED=false`, `LOGIN_RATE_LIMIT=1000/minute`,
  `REGISTER_RATE_LIMIT=1000/hour` (rate limits widened only so repeated QA logins
  don't 429 — deviation recorded), Postgres :5443 / MinIO as found.
  TC-7/TC-10 ran a second time with `ACCESS_TOKEN_LIFETIME_SECONDS=60` on this
  uvicorn only; TC-11 revoked `refresh_tokens` rows for the QA user directly in the
  dev DB. No ANTHROPIC key (irrelevant to these TCs).
- Test users: **`qa-sim-main@budgetqa.dev`**, **`qa-sim-empty@budgetqa.dev`**,
  plus a live-registered `qa-sim-reg-<ts>@budgetqa.dev` (pw `Qa!Test1234`).
  The 2026-07-25 `qa-mobile-*` users were left untouched.
- Driving/observation harness: **`idb` (fb-idb 1.1.7 + idb-companion 1.5.0.b2,
  installed via Homebrew for this run)** for taps/swipes/text and for reading the
  live accessibility tree, `xcrun simctl io … screenshot` for pixels, the uvicorn
  access log for the wire, the Metro terminal for device logs. (macOS Accessibility/
  Screen-Recording TCC is not granted to this shell, so CGEvent/AppleScript-based
  automation was not available — idb talks to CoreSimulator directly and needs no TCC.)
- Artifacts (screenshots + logs) live in
  `/private/tmp/claude-501/-Users-nikitazaretski-work-budget/747ab211-bae8-459f-898e-7671d506058f/scratchpad/qa/`
  (`api.log`, `metro.log`, `tc*.png`). They are scratch — copy anything you want to keep.

### Run-2 result table

| TC | Run 2 status |
|---|---|
| TC-1 Register→auto-login | ✅ pass |
| TC-1b Register duplicate | ✅ pass |
| TC-2 Login happy | ✅ pass |
| TC-3 Bad-creds copy | ✅ pass |
| TC-4 Auth network arm | ✅ pass |
| TC-5 Logout clears | ✅ pass |
| TC-6 Cold-start splash gate | ✅ pass |
| TC-7 Expired→reactive refresh | ✅ pass (short-TTL run) |
| TC-8 `next` preserved | ❌ **FAIL** — see below |
| TC-9 Logged-out deep link unreachable | ✅ pass |
| TC-10 Concurrent 401 → 1 refresh | ✅ pass |
| TC-11 Terminal refresh → reason=expired | ✅ pass |
| TC-12 Month nav + year rollover | ✅ pass |
| TC-13 Negative net | ✅ pass |
| TC-14 Heavy paging 250 tx | ✅ pass |
| TC-15 12.34 round-trip | ✅ pass (see F-1) |
| TC-16 Numeric kbd + double-tap dedup | ✅ pass (see F-1) |
| TC-17 Amount-only PATCH omits | ✅ pass |
| TC-18 Cross-month both summaries | ✅ pass (load-bearing) |
| TC-19 Delete confirm + summary | ✅ pass |
| TC-20 note→null + refund double-bucket | ✅ pass |
| TC-22 Kind-SEGMENTED picker | ✅ pass |
| TC-23 UI states | ✅ pass (see F-4) |
| TC-24 Offline mutation retryable | ✅ pass |
| TC-25 Categories single fetch | ✅ pass |
| TC-26 Cyrillic sort | ✅ pass (⚠ probe-consistency nuance) |
| TC-27 Hex swatch guard | ✅ pass |
| TC-28 Rename immediate | ✅ pass |
| TC-29 Kind-flip 409 field-level | ✅ pass |
| TC-30 Archive/unarchive, no DELETE | ✅ pass |
| TC-31 is_system non-editable | ✅ pass |
| TC-32 Archived still labels | ✅ pass |
| TC-33 `Request.clone()` probe | ✅ pass (recorded) |
| TC-34 `Intl.Collator` probe | ✅ pass (recorded) |
| TC-35 Metro/console hygiene | ✅ pass |

**Totals: 35 executed · 34 ✅ · 1 ❌ (TC-8) · 0 ⏸.**

### ❌ Defect — TC-8: deep-linked return route is lost across login

Logged out, opening `exp://…/--/categories` correctly bounces to Sign in with no
content leak (TC-9 ✅), but after a successful login the app lands on **Transactions**,
not Categories — reproduced on both a cold start and a warm one. Isolating controls:

- `exp://…/--/login?next=%2Fcategories` + login → lands on **Categories** ⇒
  `safeNextRoute` + `router.replace` on the login screen are correct.
- `exp://…/--/categories` while authenticated → opens Categories ⇒ the route/URL match
  is correct.

⇒ the `next` the `(app)` guard captures for a deep-linked protected route is not the
deep-link target (it behaves like the default `/transactions`). User impact: any deep
link into Categories (and, once notifications/receipt links exist, any link at all)
drops the user on the wrong screen after re-auth. Evidence: `tc08-after-login.png`,
`tc08-warm.png`, `tc08-explicit-next.png`. **Not fixed by QA — for senior-lead.**

### Findings (not TC failures, recorded for senior-lead)

- **F-1 (functional, ru-locale, HIGH-ish) — fractional amounts cannot be typed with the
  on-screen keyboard.** The amount field correctly opens a decimal-pad, but on this
  ru-RU device the pad's only separator key is `,`; entering `7,77` fails form
  validation with **"Enter a valid amount."** and no request is sent. `12.34` (dot,
  hardware keyboard) is accepted. A Russian-locale user therefore has no way to enter
  kopecks from the numeric keyboard. Evidence: `tc16-keyboard.png` (pad with `,`),
  `tc16-comma-invalid.png`. This is outside TC-15/TC-16's literal assertions, so neither
  is failed on it — but it is a real user-facing gap.
- **F-2 (hygiene)** — `WARN Require cycle: src/auth/useAuth.ts -> src/auth/useMe.ts ->
  src/auth/useAuth.ts` on every launch.
- **F-3 (hygiene)** — `WARN DateTimePicker: 'onChange' is deprecated. Use
  'onValueChange', 'onDismiss', and 'onNeutralButtonPress' instead.` (fires when the
  date picker opens, TC-18).
- **F-4 (cosmetic)** — empty-state copy renders a double period:
  "No transactions in **август 2026 г..** Add your first one." (month label already ends
  with a period).
- **Observation (not a defect)** — the transaction-form Save button sits below the fold
  on a 402×874 screen; it is reachable by scrolling (with the keyboard up too), which is
  what TC-39 will judge on hardware.

### Later-scope API drift touching these TCs (expectations still held)

`TransactionCreate/Update` now carry `currency`, `base_amount_minor`, `merchant`,
`receipt_id` (multi-currency + receipts scopes, added after 1.8). The 1.8 mobile client
sends none of them and the server defaults to RUB, so **TC-13 / TC-15 / TC-17 / TC-20**
(and W7's "no currency collected") were judged against the shipped app and still pass
exactly as written — no premise-drift ruling was needed for any TC. The only
premise nuance found is the TC-26 ⇄ TC-34 "probe order must equal screen order" clause,
flagged ⚠ inline under TC-26 (different resolved locales, both correct).

### Verdict (run 2)

**❌ FAIL OVERALL for Section A** on the strength of one defect (TC-8); everything else
is green, including all five load-bearing assertions (TC-18 dual-month invalidation,
TC-10/TC-7 single-flight refresh, TC-20 composite key / no duplicate-key warning, TC-17
omit-vs-null, TC-14 no duplicate rows). Senior-lead owns the TC-8 fix + F-1 triage.
**Section B (TC-36..TC-44) remains 9 items ⏸ needs human** — untouched by this run.

## RUN RESULTS — executed 2026-07-25 (degraded-honest per R7; NO full Xcode → NO simulator)

**Environment ruling in force (R7):** `xcrun simctl` unavailable (Command Line
Tools only). Section A cannot render the app on a booted simulator. Per PM ruling
R7 every simulator-rendered TC is **⏸ blocked-environment** (NOT passed, NOT
failed), each annotated with the fallback evidence actually gathered. Nothing here
is faked, and no server-side curl turns a simulator TC green — server results are
labelled SERVER-side.

### What ran (global evidence, reused across TCs)

- **G-VITEST — mobile vitest suite: ✅ 4 files / 28 tests passed**
  (`pnpm --filter @budget/mobile test`; 179ms). Maps the coordinator/error/next
  logic behind TC-3/4/5/6/7/8/10/11/29/33.
- **G-EXPORT — Metro iOS bundle export: ✅ clean**
  (`EXPO_PUBLIC_API_URL=… npx expo export --platform ios`): `iOS Bundled … (1818
  modules)`, Hermes bytecode `entry-*.hbc` (4.8MB) emitted, exit 0. Bundler-level
  proof the whole app graph (all screens/data layer) compiles and links — the
  degraded stand-in for TC-35 boot hygiene. NOT a runtime-render check.
- **G-API — server-side wire journeys vs `:8010`** (curl, dedicated
  `qa-mobile-main@budgetqa.dev` / `qa-mobile-empty@budgetqa.dev`). SERVER contract
  + seed integrity only; app-render/app-wire assertions stay blocked.
- **G-CODE — code-reads** at cited file:line for `[wire: proxy-or-code-read]` and
  structural fallbacks.

### Per-TC disposition

| TC | Status | Evidence gathered (fallback) |
|---|---|---|
| TC-1 Register→auto-login | ⏸ blocked-env | SERVER: register 201; login form-encoded (`username`=email) 200 → `{access,refresh}`. CODE: A-1 helpers `coordinator.ts:235–242`. App-chain render blocked. |
| TC-1b Register-duplicate (R9) | ⏸ blocked-env (server ✅) | SERVER: re-register same email → **400 `REGISTER_USER_ALREADY_EXISTS`**. CODE: `describeAuthError` routes that code to the **email** field, `auth/errors.ts:41`; vitest `errors.test.ts` "routes a duplicate registration to the email field" ✅. App-field-render half blocked. |
| TC-2 Login happy | ⏸ blocked-env | SERVER: login 200. Landing-render blocked. |
| TC-3 Bad-creds copy | ⏸ blocked-env | SERVER: wrong pw → **400 `LOGIN_BAD_CREDENTIALS`**. VITEST: "routes bad credentials to a non-specific form message" ✅. CODE `auth/errors.ts:39`. |
| TC-4 Auth network arm | ⏸ blocked-env | VITEST: "NETWORK ARM: non-ApiError → retryable connection message" ✅. CODE `auth/errors.ts:30–35`. |
| TC-5 Logout clears | ⏸ blocked-env | SERVER: `/auth/logout` exists. VITEST: coordinator.logout "revokes then clears, not flagged expired" ✅. |
| TC-6 Cold-start splash gate | ⏸ blocked-env | VITEST: hydration "SYNC snapshot after hydration resolves" ✅; splash-gate `ready` promise `coordinator.ts:137–147`. No-login-flash render blocked. |
| TC-7 Expired→reactive refresh | ⏸ blocked-env | VITEST: authFetch "retries once with rotated bearer after a single refresh" ✅. SERVER: refresh single-use confirmed (below). Wire-on-device blocked (TTL). |
| TC-8 `next` preserved | ⏸ blocked-env | VITEST: `next.test.ts` safeNextRoute (5 cases incl. `//host`, scheme, `/\` bypass) ✅. |
| TC-9 Logged-out deep link unreachable | ⏸ blocked-env | CODE: `(app)/_layout.tsx` guard `<Redirect>` on false snapshot. Render blocked. |
| TC-10 Concurrent 401 → 1 refresh | ⏸ blocked-env | VITEST: "collapses N concurrent refreshes into exactly one server call" ✅ + "clears inFlight so a later refresh starts a NEW flight" ✅. SERVER: refresh reuse → **401 `REFRESH_TOKEN_INVALID`** (no double-spend). Wire-burst on-device blocked. |
| TC-11 Terminal refresh → reason=expired | ⏸ blocked-env | VITEST: "clears pair, flips snapshot, sets wasSessionExpired, notifies" ✅. CODE: guard appends `reason=expired`; authFetch never navigates `coordinator.ts:168–172,187–233`. |
| TC-12 Month nav + year rollover | ⏸ blocked-env | SERVER: per-month list `from/to` + `summary?month=` returned correct bounded data across 2025-11 / 2025-12 / 2026-01/02 (no NaN/off-by-one). Chevron render blocked. |
| TC-13 Negative net (W4) | ⏸ blocked-env | SERVER (2026-04): RUB, income 120000, expense 184200, **net_minor −64200 (<0)**. CODE: SummaryHeader renders all three via `formatMoney(minor, summary.currency)` incl. signed net `SummaryHeader.tsx:59,74`; currency from data (W7). |
| TC-14 Heavy paging (W6/AM-1.6-a) | ⏸ blocked-env | SERVER (2026-03, 250 tx): `limit=200&offset=0`→total 250/items 200; `offset=200`→items 50; **0 id-overlap, 250 unique** (no dup rows). CODE: footer "Showing N of total" `TransactionList.tsx:117`; offset is pageParam `transactions.ts:44–59`. Scroll-smoothness render blocked. |
| TC-15 12.34→1234 round-trip (W4) | ⏸ blocked-env | SERVER: POST `amount_minor:1234` → stored/returned 1234, RUB, no currency collected. CODE: no currency field (W7) `transaction-form.tsx`; W8 invalidation `transactions.ts:75–81`. Render-back blocked. |
| TC-16 Numeric kbd + double-tap dedup | ⏸ blocked-env | CODE: `keyboardType="decimal-pad"` `transaction-form.tsx:252`; submit `pending`-guarded `:239,336–341`. Keyboard render + rapid-tap timing blocked. |
| TC-17 Amount-only PATCH omits (W1) | ⏸ blocked-env (server ✅ strong) | SERVER: control re-sending archived `category_id` → **422 `CATEGORY_ARCHIVED`**; the real **amount-only PATCH → 200** (row kept category+note) — behavioral proof the builder OMITS untouched fields. CODE: `buildTransactionPatch` diffs touched-only `patch.ts:62–80`; no per-row GET (edit reads list cache `transaction-form.tsx:63–68`). |
| TC-18 Cross-month both summaries (W8) — LOAD-BEARING | ⏸ blocked-env (server ✅ strong) | SERVER: occurred_at-only move A(2026-01)→B(2026-02): **A expense 7500→0 (shrinks), B expense 3000→10500 (grows), C(2025-11) 5000→5000 UNCHANGED**; row left A list, now in B list. CODE: dual-month `Set` + list-only predicate `key[1] !== 'summary'` `transactions.ts:36–41,103–114`. App refetch-count for C blocked (predicate code-read is the fallback). |
| TC-19 Delete confirm + summary (W8) | ⏸ blocked-env | SERVER: DELETE returns 204. CODE: `confirmAction({destructive})` gate `transaction-form.tsx:220–237`; scoped invalidation `transactions.ts:139–144`. Dialog render blocked. |
| TC-20 note→null + refund double-bucket + no key warn (W1/W3) | ⏸ blocked-env (server ✅ strong) | SERVER: PATCH `note:null` → GET shows `note = None` (not `""`); 2026-04 `by_category` returns **Groceries TWICE — expense 50000 AND income 20000** (same id, both kinds) + a `category_id:null` (uncategorized) bucket. CODE: composite key `${category_id ?? 'uncategorized'}:${kind}` `SummaryHeader.tsx:27,89`; null→"Uncategorized" `:85–86`. React key-warning check (needs render) blocked — composite-key code-read is the fallback. |
| TC-22 Kind-SEGMENTED picker (AM-1.6-c/W5) | ⏸ blocked-env | CODE: picker shows active-segment kind `transaction-form.tsx:165–167`; `onKindChange` clears mismatched category `:169–174`; `onPickCategory` sets kind by direct assignment (W5) `:176–180`. Segment render blocked. |
| TC-23 UI states (empty/loading/error) | ⏸ blocked-env | SERVER: `qa-mobile-empty` → 18 system cats, 0 user cats, 0 tx; a seeded empty month (2026-05) exists. CODE: TransactionList handles loading/empty/error `TransactionList.tsx:3`. State render blocked. |
| TC-24 Offline mutation retryable | ⏸ blocked-env | CODE: QueryClient retry policy `lib/queryClient.ts`; mutation error → `describeTransactionError` network arm (vitest ✅). Cached-stays-visible render blocked. |
| TC-25 Categories grouped, single fetch (AM-1.6-b) | ⏸ blocked-env | SERVER: `GET /categories?include_archived=true` → 30 rows (18 system + 12 user) in one call. CODE: single `include_archived:true` source `data/categories.ts:18–24`; SectionList grouped by kind. |
| TC-26 Cyrillic sort (W11) | ⏸ blocked-env | SERVER: Cyrillic set present (Ёлка/Еда/Кафе/Продукты/Зарплата). CODE: `sortForDisplay`→`Intl.Collator(locale,{sensitivity:'base'})` within kind, fallback isolated to `localeCompare` `categoryLookup.ts:26–44`. Rendered order + TC-34 probe match blocked. |
| TC-27 Hex swatch guard (AM-hex/W10) | ⏸ blocked-env | CODE: `HexSwatch` guards on `HEX_COLOR_PATTERN` (shared, web copy deleted — diff-gate Layer 1); create stores color as-entered via `emptyToNull` `category-form.tsx:97–102`, patch case-insensitive compare `patch.ts:55`. Live-swatch render blocked. |
| TC-28 Rename immediate | ⏸ blocked-env | CODE: `useUpdateCategory` PATCH updates archived-inclusive cache in place. SERVER: category PATCH 200. Render blocked. |
| TC-29 Kind-flip 409 field-level (W2/W9) | ⏸ blocked-env (server ✅) | SERVER: expense "Bonus" `{kind:income}` → **409 `CATEGORY_NAME_CONFLICT`** (income "Bonus" collides), request reached server (no client pre-gate, W9). VITEST: "routes a 409 name conflict to the name field" ✅. Field-render blocked. |
| TC-30 Archive/unarchive, NO DELETE (W9) | ⏸ blocked-env (server ✅) | SERVER: PATCH `{archived:true}` on Subscriptions+Rent → 200; **categories expose no DELETE route** (openapi has only POST/PATCH for categories). CODE: `confirmAction` archive gate `category-form.tsx:111–134`. Dialog render blocked. |
| TC-31 is_system non-editable (W9) | ⏸ blocked-env (server ✅) | SERVER: 18 rows `is_system:true` (Russian system cats). CODE: `CategoryRow` renders system rows as non-interactive View + "System" tag, no `onEdit` press `CategoryRow.tsx:28,33–40`. Visual-distinct render blocked. |
| TC-32 Archived still labels (W3/AM-1.6-b) | ⏸ blocked-env | SERVER: archived Subscriptions still returned under `include_archived`; its tx (TX_SUBS) keeps `category_id`. CODE: `buildCategoryIndex` over archived-inclusive set `categoryLookup.ts:15–19`; new-tx picker excludes archived `transaction-form.tsx:160–167`. Row/label render blocked. |
| TC-33 Request.clone() probe (O4) | ⏸ blocked-env | Probe SHIPPED `lib/probes.ts:39–83` (`probe:O4a/O4b/O4c`); spike records **captured-init rebuild is the DEFAULT and in force** (`spike-request-clone.md`). VITEST: O4 "BODY PRESERVATION" + "RN POLYFILL TRIPWIRE (body reaches wire on send AND 401-replay even when input.body undefined)" ✅ — the replay-correctness the probe protects. On-device console verdict not captured (no device). |
| TC-34 Intl.Collator probe (W11) | ⏸ blocked-env | Probe SHIPPED `lib/probes.ts:87–102`. CODE: fallback isolated `categoryLookup.ts:26–32`. On-device console verdict + TC-26 consistency not captured (no device). |
| TC-35 Metro/console hygiene | ⏸ blocked-env | G-EXPORT ✅ (1818 modules, exit 0) proves the graph compiles with no bundler error; per-flow red-screen / key-warning watch requires a rendered app (Metro dev server) → blocked. Note: TC-20 composite-key + TC-14 no-dup-rows (both code-read/server-verified) are the specific warning sources, and both check out. |

**Server contract findings (all healthy, SERVER-side):** register 201 / dup 400
`REGISTER_USER_ALREADY_EXISTS`; login form-encoded 200; bad-creds 400
`LOGIN_BAD_CREDENTIALS`; **refresh single-use** (1st 200 rotates, reuse →
401 `REFRESH_TOKEN_INVALID` — the no-double-spend backstop TC-10 relies on);
amount-only PATCH 200 vs archived-category re-send 422; occurred_at-only move
updates both months' summaries and leaves the third untouched; kind-flip 409;
`note:null` persists as null; `amount_minor` stored verbatim; `include_archived`
is the one categories source (30 rows); no DELETE route for categories. No 5xx, no
unexpected error across the journeys.

---

## Section A: simulator (run by mobile-qa)

### TC-1: Register → auto-login chain lands in the app
- **Verifies**: task auth scope (register 201 auto-chains into login, plan
  `(auth)/register.tsx`), A-1 (login via shared helper), O2 (post-auth the app
  shell renders on the sync snapshot).
- **Precondition**: Fresh install, logged out. Use a NEW unique email
  (`qa-mobile-reg-<ts>@budgetqa.dev`) so registration succeeds.
- **Steps**:
  1. Launch the app; the auth Stack shows the login screen. Go to Register.
  2. Enter the new email + a valid password; submit.
  3. Wait for the chain to complete.
- **Expected**: Register succeeds (201) and **auto-chains into login** without a
  second manual step; the app lands on the Transactions tab (default authed
  route), NOT back on the login form. uvicorn log shows a register call then a
  login (token) call. No red-screen, no Metro errors.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — register 201 → auto-chained POST /auth/login 200 → landed on Transactions tab (fresh empty state), no second manual step, no red-screen. Evidence: uvicorn `POST /auth/register 201` + `POST /auth/login 200` + `GET /users/me|/categories|/transactions|/summary 200`; screenshot `tc01-after-register.png`.

### TC-1b: Register with an already-registered email → field-level error (R9)
- **Verifies**: O7 / W2 (`REGISTER_USER_ALREADY_EXISTS` narrowed to the **email**
  field, not a generic banner), added under PM ruling R9.
- **Precondition**: Logged out; the email registered in TC-1 exists.
- **Steps**: Register again with the SAME email + a valid password; submit.
- **Expected**: 400 `REGISTER_USER_ALREADY_EXISTS` surfaced as a field-level message
  under Email; submit stays usable; no crash. Deliberate-failure TC.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — re-register same email → `POST /auth/register 400`; message rendered as a FIELD-level error under Email: "An account with this email already exists." Submit stayed enabled. Screenshot `tc01b-duplicate.png`.

### TC-2: Login happy path
- **Verifies**: task auth scope, A-1 (form-encoded login via shared helper), O2.
- **Precondition**: Logged out; `qa-mobile-main@budgetqa.dev` exists.
- **Steps**:
  1. On the login screen enter the seeded email + password; submit.
- **Expected**: Lands on the Transactions tab; the month header + summary + list
  render. uvicorn shows one token (login) call. No login-form flash afterward, no
  Metro errors.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — login 200 → Transactions tab with month header, summary (9 150,00 ₽ / 6 279,00 ₽ / 2 871,00 ₽ = seeded truth) and grouped list; one token call, no login-form flash, no Metro errors. Screenshot `tc02-login.png`.

### TC-3: Login with bad credentials shows a specific, retryable message
- **Verifies**: O7 (app-owned copy over `getErrorCode`; visible, retryable error;
  submit stays usable), W2-adjacent (`LOGIN_BAD_CREDENTIALS`).
- **Precondition**: Logged out.
- **Steps**:
  1. Enter the seeded email with a WRONG password; submit.
  2. Read the error; then correct the password and submit again.
- **Expected**: A clear field/form-level message (e.g. "Incorrect email or
  password."), NOT raw JSON, NOT a generic "something went wrong", NOT a crash.
  The submit button re-enables (the error is **retryable** — O7); correcting the
  password and resubmitting succeeds. uvicorn shows a 400/401 then a 200. This is
  a deliberate-failure TC — the handled error is the pass condition.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — wrong password → `POST /auth/login 400` → form-level copy "Incorrect email or password." (not raw JSON, not generic), submit re-enabled; corrected password → 200 and app entered. Screenshot `tc03-badcreds.png`.

### TC-4: Auth network-failure arm — API down → visible retryable error (O7)
- **Verifies**: O7 (mandatory **network arm**: `!(error instanceof ApiError)` →
  "Can't reach the server…"; every auth mutation surfaces a visible retry).
- **Precondition**: Logged out. **Stop the uvicorn API** (Ctrl-C) so the host is
  unreachable.
- **Steps**:
  1. With the API down, enter valid credentials and submit login.
  2. Read the error affordance.
  3. Restart the API; tap submit again.
- **Expected**: A **network-failure** message distinct from bad-credentials copy
  ("Can't reach the server. Check your connection and try again."), the submit
  button stays enabled (retryable — O7), NO crash / NO red-screen / NO dead-end
  spinner. After the API is back, the retry logs in. Deliberate-failure TC.
- **Note**: on the simulator, "no network" is faithfully simulated by stopping
  the API (host refused). True radio-off airplane mode is TC-39/Section B.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — API stopped → login shows the NETWORK arm "Can't reach the server. Check your connection and try again." (distinct from bad-creds copy), submit stayed enabled, no crash/dead spinner; API restarted → same button retried and logged in (`POST /auth/login 200`). Screenshot `tc04-network-arm.png`.

### TC-5: Logout clears the session and returns to login
- **Verifies**: O2 (logout writes memory-clear + `SecureStore.deleteItemAsync`),
  plan `useAuthListener` (Query cache cleared on signed-in→out), O6 (guard
  reacts, redirects).
- **Precondition**: Logged in as qa-mobile-main.
- **Steps**:
  1. Trigger logout (from the app's logout affordance).
  2. Observe the redirect.
  3. **Kill and relaunch** the app.
- **Expected**: Immediately returns to the login screen (guard reacts on the sync
  snapshot). After kill+relaunch the app **stays logged out** (lands on login,
  not the tabs) — proving the token was cleared from secure-store, not just
  memory. uvicorn shows a logout/revoke call. No Metro errors.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — logout → `POST /auth/logout 204` and immediate redirect to Sign in; app killed + relaunched → still logged out (secure-store cleared, not just memory). Screenshot `tc05-logout.png`.

### TC-6: Cold-start with stored tokens skips login — splash gate, NO login flash (O2)
- **Verifies**: O2 (async-hydrate-once behind the splash gate; sync snapshot
  after; guard never awaits → no flash of login).
- **Precondition**: Logged in as qa-mobile-main with a **valid, unexpired** access
  token. Fully **kill** the app.
- **Steps**:
  1. Relaunch the app from a cold start.
  2. Watch the very first frames (screenshot immediately after the splash).
- **Expected**: The Expo **splash stays visible until hydration resolves**, then
  the app opens **directly on the Transactions tab**. There is **NO flash of the
  login screen** first (the O2 gate is the whole point). No Metro errors, no
  double-mount thrash in the log.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — cold start with a valid stored pair: 200 ms-interval AX polling of the first frames recorded splash → Expo Go load → splash → Transactions, and NEVER a login frame; no `POST /auth/login`, only the hydrated-token queries (`/users/me`, `/categories`, list, summary) 200. Also survived a full device reboot still signed in. (Sub-200 ms flash cannot be excluded by this sampling method.)

### TC-7: Cold-start with an EXPIRED access token → reactive refresh on first 401 (O3/O5)
- **Verifies**: O3 (reactive-only 401→refresh→retry, single-flight), O5
  (reactive-only, no proactive timer), O2 (hydrate admits on token presence),
  A-1/shared refresh helper.
- **Precondition**: Logged in as qa-mobile-main, then let the **access token
  expire while the refresh token is still valid**. This requires the dev API's
  access-token TTL to be short enough to wait out (state the TTL / set a short
  `ACCESS_TOKEN_TTL`-style env for the run if configurable). Do NOT rotate the
  JWT signing secret — that invalidates the refresh token too and is TC-11
  instead. Kill the app after the access token has expired.
- **Steps**:
  1. Cold-launch. Hydration finds a stored pair (access expired), the guard
     admits on token presence, the Transactions screen mounts and fires its
     queries.
  2. Watch the uvicorn log and the screen.
- **Expected**: The first protected query returns **401**, the coordinator fires
  **exactly one** `POST /auth/refresh` (200), and the original request is retried
  (200) — the Transactions data loads without the user ever seeing the login
  screen. uvicorn log shows the `401 → POST /auth/refresh 200 → retried GET 200`
  sequence. No login flash, no red-screen.
- **Blocked-risk**: depends on a wait-out-able access TTL. If the dev TTL is long
  and not configurable for the run, mark ⏸ blocked and note the invariant is
  covered by the vitest coordinator suite (plan Section F) + code-read; do not
  fake it.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — run with `ACCESS_TOKEN_LIFETIME_SECONDS=60` on the QA uvicorn only. After an 80 s idle wait NO request at all was made (no proactive timer — O5). Cold launch then produced: 4× 401 → **one** `POST /auth/refresh 200` → all four originals retried 200; data rendered with no login flash, no red-screen.

### TC-8: Protected redirect preserves the intended return route (`next`) (O6)
- **Verifies**: O6 (React guard `<Redirect>` with typed `next` param; login
  screen deep-link-safe reads `next`; `safeNextRoute` validation).
- **Precondition**: Logged **out**.
- **Steps**:
  1. Deep-link / navigate directly to a protected route, e.g. the Categories tab
     (`/(app)/(tabs)/categories`) via `npx uri-scheme open <scheme>://…` or an
     `expo-linking` URL.
  2. Observe the redirect to login (note the `next` param carried in the route).
  3. Log in.
- **Expected**: The guard redirects to `login?next=<encoded categories route>`
  with NO protected content flashing through; after login the app lands on the
  **Categories** tab (the preserved `next`), not the default Transactions tab and
  not a redirect loop. `safeNextRoute` accepts the in-app href.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ❌ FAIL — deep link to a protected route while logged out does NOT preserve the intended return route. `exp://…/--/categories` (both cold-start and warm, app already on Sign in) correctly redirects to login with no content leak, but after a successful login the app lands on **Transactions**, not Categories. Isolated: the login-side handling is correct — `exp://…/--/login?next=%2Fcategories` + login lands on **Categories** (`tc08-explicit-next.png`), and the same `/--/categories` link routes correctly while authenticated. So the `next` captured by the `(app)` guard on a deep-linked protected route is not the deep-link target. Evidence: `tc08-after-login.png` (cold), `tc08-warm.png` (warm), `tc08-explicit-next.png` (control).

### TC-9: Deep link to a protected route while logged out is not reachable (O6)
- **Verifies**: O6 (protected group unreachable when the snapshot is false; guard
  never leaks content), companion to TC-8.
- **Precondition**: Logged out.
- **Steps**:
  1. Deep-link straight to the transaction-form modal
     (`/(app)/transaction-form?month=…`) and to the Transactions tab while logged
     out.
- **Expected**: Both redirect to login (with `next`) — NO modal, NO list, NO
  protected content flashes through before the redirect. No crash on a cold deep
  link into a modal route.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — logged out, `exp://…/--/categories` and `exp://…/--/transaction-form?month=2026-08` both stayed on Sign in; 150 ms-interval sampling saw NO modal, NO list, no protected content and no crash on a cold deep link into a modal route.

### TC-10: Concurrent 401s → exactly ONE `/auth/refresh` on the wire; no double-spend (O3)
- **Verifies**: O3 (single-flight `inFlight` is the ENTIRE concurrency story; no
  adopt-stored-pair double-spend; refresh-token rotation double-spend absence).
- **Precondition**: Logged in; access token about to be (or just) expired, refresh
  valid (same TTL setup as TC-7). The Transactions tab fires **multiple queries
  at once** on mount (list + summary + categories + `me`) — the natural fan-out
  that produces simultaneous 401s.
- **Steps**:
  1. With an expired access token, navigate so several protected queries fire in
     the same tick (e.g. cold-open Transactions, which mounts list+summary+me, or
     switch to a tab that triggers a batch).
  2. Read the uvicorn access log for the burst.
- **Expected**: Across the batch of 401s there is **exactly one** `POST
  /auth/refresh` — the single-flight promise deduped the rest; each original
  request is then retried once and succeeds. The refresh token is consumed **once**
  (no second refresh with a stale/rotated token — no double-spend). No 401 storm,
  no repeated refresh loop in the log.
- **Blocked-risk / fallback**: reliably inducing *simultaneous* 401s on-device is
  timing-sensitive and TTL-dependent. If the burst can't be induced, the
  definitive single-flight-dedup proof lives in the **vitest coordinator suite**
  (plan Section F — "single-flight dedup of concurrent 401s"); mark this ⏸ blocked
  with that fallback + code-read, do not fake the wire count.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — same short-TTL cold-launch burst as TC-7: 4 simultaneous 401s (`/users/me`, `/transactions`, `/summary`, `/categories`) collapsed into **exactly one** `POST /auth/refresh 200`, each original retried once → 200. No refresh loop, no double-spend. Reconfirmed in the failure path (TC-11): 4× 401 → one refresh (401).

### TC-11: Terminal refresh failure → redirect to login with `reason=expired` (O3/O5/O6)
- **Verifies**: O3 (terminal failure clears the mirror + sets
  `wasSessionExpired`), O6 (guard redirects with `reason=expired`; authFetch never
  navigates imperatively — the React guard does).
- **Precondition**: Logged in. Force the **refresh** to fail terminally: restart
  uvicorn with a **rotated JWT signing secret** (invalidates the stored refresh
  token) — OR revoke/expire the refresh server-side. Then trigger a protected call.
- **Steps**:
  1. With the refresh token now invalid, cause a protected query to fire (e.g.
     pull-to-refresh the list, or cold-open).
  2. The first 401 triggers a refresh, which itself fails terminally.
  3. Observe the redirect and any surfaced reason copy.
- **Expected**: The coordinator clears the in-memory mirror + secure-store, and
  the React guard redirects to **login with `reason=expired`** (a
  "your session expired, sign in again" affordance — not a silent bounce, not a
  crash). uvicorn shows `401 → POST /auth/refresh 401/4xx` then no retry storm.
  The fetch wrapper did NOT navigate imperatively (redirect came from the guard).
  Deliberate-failure TC.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — refresh tokens revoked server-side (DELETE 4 rows from `refresh_tokens`) + access token expired: cold launch → 4× 401 → one `POST /auth/refresh 401` → NO retry storm → guard redirected to login rendering **"Your session expired — please sign in again."** (reason=expired). Screenshot `tc11-expired.png`.

### TC-12: Month navigation prev/next including year rollover
- **Verifies**: W6 (month filter `from`/`to` via `toApiDate`; summary per month),
  AM-schemas (`shiftMonth`/`monthBounds`/`formatMonthLabel` — no forked math).
- **Precondition**: qa-mobile-main with tx in the current month, the previous
  month, AND December-of-prior-year (seed §2).
- **Steps**:
  1. Open Transactions (defaults to current month via `currentMonth()`).
  2. Tap the prev chevron repeatedly down to a January, then once more to cross
     into **December of the prior year**.
  3. Tap next back up to the current month.
- **Steps observability**: uvicorn shows list `from`/`to` and summary `month`
  per navigation.
- **Expected**: Each navigation refetches; the list shows only that month's tx.
  Network: `from=YYYY-MM-01`, `to=`month-end (Dec = 31, no off-by-one/NaN),
  `month=YYYY-MM`. The Jan→Dec-prior-year rollover computes correct bounds and
  shows the prior-year data. The month label + summary header move in lockstep
  with the list. No Metro errors.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — walked август 2026 → декабрь 2025 and back. Wire params exact and bound-correct: `from=2026-06-01&to=2026-06-30`, `…2026-02-28` (non-leap), `from=2025-12-01&to=2025-12-31`, `summary?month=YYYY-MM`; no NaN/off-by-one. Label, summary and list moved in lockstep with seeded truth every month; re-visiting a cached month issued no refetch storm.

### TC-13: Summary header — income/expense/net correct, NEGATIVE net rendered with minus (W4)
- **Verifies**: W4 (`formatMoney` for income/expense/**signed net_minor**; never
  `toInputString` on a signed value → no throw), W7 (currency from
  `summary.currency`, none collected).
- **Precondition**: The crafted negative-net month (seed §4): total expense >
  income, round hand-verifiable numbers, RUB.
- **Steps**:
  1. Navigate to the crafted month.
  2. Read income, expense, net in the header (screenshot + Read).
- **Expected**: Income/expense show correct non-negative magnitudes; **net =
  income − expense renders with a locale minus** (e.g. `-130,00 ₽`) via
  `formatMoney` — no crash, no NaN, no swallowed value. Currency is ₽ sourced from
  `summary.currency`. No Metro error/red-screen.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — crafted negative-net month (апрель 2026): INCOME 2 000,00 ₽ / EXPENSE 5 762,00 ₽ / **NET -3 762,00 ₽** rendered with the locale minus and ₽ from `summary.currency`; no NaN, no throw. Screenshot `tc13-april-negative-net.png`.

### TC-14: Heavy month load-more — "Showing N of total" (W6)
- **Verifies**: W6 (`limit=200` slice; `has_more` derived `offset + items.length
  < total`; total drives the count), AM-1.6-a (`offset` is the `pageParam`, not a
  key member — observable as no key thrash / no dup rows).
- **Precondition**: The heavy month seeded with **250** tx (seed §5).
- **Steps**:
  1. Open the heavy month. Read the footer count.
  2. Scroll to the end so `onEndReached` fires (or tap Load-more).
  3. Read the count after loading; scroll for smoothness / blank rows.
  4. Open a light month (≤200) and confirm no load-more control appears.
- **Steps observability**: uvicorn shows first `limit=200&offset=0`, then exactly
  one `offset=200` on load-more.
- **Expected**: First fetch `limit=200`; footer "Showing 200 of 250"; load-more
  fires exactly **one** additional request (offset=200) → "Showing 250 of 250"
  and the control disappears. **No duplicate rows, no blank/placeholder rows,
  smooth scroll** on the FlatList/SectionList. Light month shows no control. No
  Metro warnings.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — heavy month март 2026 (250 tx): first fetch `limit=200&offset=0`, footer "Showing 200 of 250"; scrolling to the end fired **exactly one** `offset=200` request → "Showing 250 of 250" and the control disappeared. A 50-frame scroll pass collected 119 distinct rows: **zero duplicate amounts, zero blank/placeholder rows**; light months show no load-more control. Screenshot `tc14-heavy-month.png`.

### TC-15: Create transaction — minor-units round-trip (12.34 → 12.34, not 1234.00) (W4)
- **Verifies**: W4 (`moneyAmountSchema` magnitude input, `parseMoney` **minor
  units**, `formatMoney` render; no float math), W7 (no currency collected).
- **Precondition**: Logged in; know the current month's summary totals.
- **Steps**:
  1. Open Transactions → "＋" (transaction-form modal).
  2. Confirm NO currency field is present (W7).
  3. Enter amount `12.34` (major units), leave category empty, pick expense,
     accept the default (today) date; submit.
- **Steps observability**: uvicorn shows POST /transactions; wire body via
  proxy-or-code-read for `amount_minor`.
- **Expected**: The stored amount renders back as **`12,34 ₽`** in the new row and
  in the summary delta — NOT `1234,00 ₽` and NOT `0,12 ₽` (correct major→minor
  1234 conversion). The row appears without a manual reload; the summary totals
  update to **server truth** (dual list + affected-month summary invalidation,
  W8). The row shows "Uncategorized" treatment. No Metro errors.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — no currency field in the form (only the `Amount (RUB)` label). `12.34` → row renders **-12,34 ₽** and the month summary moved 6 279,00 → 6 291,34 ₽ (+12,34, not 1 234,00 / 0,12); row appeared with no manual reload, "Uncategorized" treatment, scoped list+summary invalidation. See also finding F-1 (comma separator).

### TC-16: Forms & keyboard (simulator-observable) — numeric keyboard + double-tap submit no-dup
- **Verifies**: mandatory forms category (numeric keyboard for amounts;
  double-tap submit doesn't duplicate), plan `keyboardType:'decimal-pad'`.
- **Precondition**: Transaction-form modal open. Enable the **soft keyboard** on
  the simulator (I/O → Keyboard → uncheck "Connect Hardware Keyboard") so the
  on-screen keyboard is visible for the screenshot.
- **Steps**:
  1. Focus the amount field; screenshot the keyboard.
  2. Fill a valid transaction; **double-tap Submit rapidly**.
  3. Watch uvicorn for the number of POSTs and the list for duplicate rows.
- **Expected**: The amount field brings up a **numeric/decimal keyboard**
  (decimal-pad — digits + decimal separator, not a full QWERTY). The rapid
  double-tap results in **exactly one** POST /transactions (uvicorn) and **one**
  new row (submitting-state disables the button / mutation guards the second tap)
  — no duplicate transaction. No Metro errors.
- **Note**: keyboard *avoidance* (not covering the field/submit) on a small
  screen is device-dependent → TC-39/Section B; only the keyboard-TYPE and
  double-submit-guard are asserted here.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — the amount field brings up the **decimal-pad** (digits + a single separator key + delete, no QWERTY; `tc16-keyboard.png`); with the keyboard up the Save button is reachable by scrolling. Rapid double-tap on Save produced **exactly one** `POST /transactions 201` and one new row. NOTE finding F-1: on this ru-locale device the pad's separator key is `,` and the form rejects `7,77` with "Enter a valid amount." (`tc16-comma-invalid.png`).

### TC-17: Edit transaction — amount-only PATCH omits untouched fields (W1)
- **Verifies**: W1 (PATCH emits ONLY touched fields; untouched = absent, not
  null/"" — single `buildTransactionPatch`), plan edit-loads-from-cache
  (no GET `/transactions/{id}`).
- **Precondition**: An existing tx whose category is **archived** after the fact
  (seed §6 — reuses the archived "Subscriptions"/"Rent" tx).
- **Steps**:
  1. From the list, open Edit on that tx. Confirm prefill: amount shows the
     **magnitude** (no minus in the field; sign carried by the kind segment).
  2. Change **only the amount**; leave the (archived) category untouched; submit.
- **Steps observability**: `[wire: proxy-or-code-read]` for the PATCH body;
  uvicorn confirms no GET `/transactions/{id}` fired and the PATCH status.
- **Expected**: The edit **succeeds (200), NOT a `CATEGORY_ARCHIVED` 422** — which
  is the behavioral proof that `category_id` was **omitted** (had it been
  re-sent, the archived category would 422). The row + summary update to server
  truth. uvicorn shows **no** per-row GET on edit (row sourced from list cache).
  If the intercept proxy is available, the PATCH body contains **only**
  `amount_minor`. No Metro errors.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — edited a tx whose category ("Rent") was archived after the fact, changing ONLY the amount → `PATCH /transactions/{id}` **200, not 422 CATEGORY_ARCHIVED** (behavioural proof `category_id` was omitted). Prefill showed the magnitude `2500.00` (no minus). uvicorn shows **no** `GET /transactions/{id}` on edit (row came from the list cache); row and summary moved to server truth (+250,00).

### TC-18: Cross-month date change → BOTH months' summaries update (W8) — LOAD-BEARING
- **Verifies**: W8 (a date-move across months invalidates **BOTH** old and new
  months' summaries via a Set; the list-only predicate `key[1] !== 'summary'`
  must NOT blanket-refetch every cached month's summary), `affectedMonth =
  occurred_at.slice(0,7)`.
- **Precondition**: The A/B/C cross-month set (seed §7). **Warm all three
  summaries in cache first**: visit month C, then A, then B, noting each header's
  totals against the seeded truth. One target tx of known amount+kind lives in
  month A.
- **Steps**:
  1. Navigate to month A; open Edit on the target tx.
  2. Change **only its date** (`occurred_at`) to a day inside **month B**; touch
     nothing else; submit.
  3. Read month A's header, then month B's header; watch uvicorn for summary
     refetches.
- **Expected**:
  - (a) The row **leaves month A's list and appears in month B's list** (no manual
    reload).
  - (b) **Month A's summary SHRINKS to server truth** (income/expense/net drop by
    the moved tx) — the load-bearing assertion; a forgotten old-month
    invalidation would leave A's header stale.
  - (c) **Month B's summary GROWS** by the moved tx's contribution.
  - (d) uvicorn shows summary refetches for **month A and month B ONLY** — **no**
    `/transactions/summary?month=` request for **month C** (already cached),
    proving the list predicate doesn't sweep every cached month's summary.
  - No Metro errors, no request storm.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS (load-bearing) — with месяцы C=2025-11, A=2026-01, B=2026-02 all warm in cache, an `occurred_at`-only move of the 750,00 ₽ row from A into B gave: (a) row left A's list and appears in B's; (b) **A's summary shrank 950,00 → 200,00 ₽**; (c) **B's summary grew 300,00 → 1 050,00 ₽**; (d) **no `/transactions/summary?month=2025-11` request anywhere** in the mutation aftermath (B's summary refetched on revisit, i.e. invalidated-not-swept). Screenshots `tc18-monthA-after.png`, `tc18-monthB-after.png`.

### TC-19: Delete transaction — confirm dialog, row gone, summary updates, cancel path (W8)
- **Verifies**: W8 (delete invalidates list + affected-month summary),
  destructive-action confirmation baseline (`Alert.alert`), plan haptics on
  confirm (feel is device-only — TC-42).
- **Precondition**: A month with a known tx and known summary totals.
- **Steps**:
  1. Trigger delete on a row → an `Alert.alert` confirm appears.
  2. **Cancel**; confirm the row + totals are unchanged (no request in uvicorn).
  3. Trigger delete again; **confirm**.
- **Expected**: Delete is gated behind a confirm (no one-tap destructive delete);
  cancel is a no-op. Confirm → one DELETE (204), the row disappears without
  reload, the summary updates to server truth. Kill+relaunch (or pull-to-refresh)
  shows the row still gone. uvicorn: one DELETE + scoped invalidation refetches,
  no storm. No Metro errors.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — Delete is gated by an `Alert.alert` confirm ("Delete transaction / This can't be undone", `tc19-confirm.png`); **Cancel issued no request at all**; confirm → one `DELETE …/{id} 204` + scoped list/summary refetch, row gone with no reload, summary down by the deleted amount.

### TC-20: Note clear → null; refund double-bucket + Uncategorized; no React key warning (W1/W3)
- **Verifies**: W1 (cleared nullable `note` → `null`, never `""`), W3
  (archived-inclusive join; `null` bucket → "Uncategorized"; composite key
  `${category_id ?? 'uncategorized'}:${kind}` — refund repeats a category_id
  under BOTH kinds).
- **Precondition**: The crafted refund month (seed §4): a refund pair (same
  category as one expense + one income), an uncategorized tx, and one tx that HAS
  a note.
- **Steps**:
  1. Open the refund month; open the by-category **breakdown** in the summary
     header (screenshot + Read).
  2. **Watch the Metro log** for React key warnings during the breakdown render.
  3. Open Edit on the noted tx; **clear the note**; submit. Kill+relaunch and
     re-open the row.
- **Steps observability**: `[wire: proxy-or-code-read]` for the note-clear PATCH
  (`note: null`).
- **Expected**:
  - The refund category appears as **TWO distinct breakdown rows** (one expense,
    one income), neither collapsing/overwriting the other; the `null` bucket
    renders labeled **"Uncategorized"** (not raw null/blank).
  - **Metro shows NO "Encountered two children with the same key" warning** — the
    load-bearing assertion (proves the composite `id:kind` key). 
  - After the note-clear + relaunch, the note reads as **cleared** (persisted as
    `null`, not `""` or a no-op). Proxy (if available) shows `note: null`.
  - No red-screen.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — refund month апрель 2026 renders Groceries as **two distinct buckets** (5 000,00 ₽ expense AND 2 000,00 ₽ income, neither collapsing) plus a **"Uncategorized"** bucket; **Metro shows zero "two children with the same key" warnings** across the whole run. Note cleared → `PATCH 200`, row lost its note, and a server read-back shows `note = None` (null, not "").

### TC-21: (reserved — merged into TC-22) 

### TC-22: Transaction form — category picker is kind-SEGMENTED; kind default from picked category (AM-1.6-c, W5)
- **Verifies**: **AM-1.6-c** (the category picker is **kind-SEGMENTED** — a
  segmented control chooses the kind, and the picker shows the selected segment's
  categories; NEVER described as "filtered"), W5 (tx kind defaults from
  `category.kind` by **direct assignment**; no cross-enum `Kind` alias), plan
  `onKindChange` (flipping the segment clears an incompatible selected category).
- **Precondition**: qa-mobile-main has ≥1 user expense category and ≥1 user income
  category.
- **Steps**:
  1. Open the transaction-form modal. Confirm the kind control is a **SEGMENTED**
     control (Expense | Income).
  2. With the **Expense** segment active, open the category picker — confirm it
     presents the **expense** categories.
  3. Switch to the **Income** segment — confirm the picker now presents the
     **income** categories.
  4. Set Expense, pick an expense category "Food" — confirm the form's kind is/stays
     Expense (kind set from `category.kind`, W5).
  5. Flip the segment to **Income** while "Food" (expense) is selected.
- **Expected**:
  - The picker is **segmented by kind** (the active segment's categories are the
    ones offered) — a valid AM-1.6-c pattern; wording here is "segmented", never
    "filtered".
  - Picking "Food" (expense) results in kind = Expense (W5 direct assignment).
  - Flipping the segment to Income **clears the now-incompatible category
    selection** (no mismatched category can be submitted). No Metro error, no way
    to submit a category whose kind contradicts the tx kind.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — kind control is a **SEGMENTED** Expense|Income; with Expense active the picker offers expense categories, with Income active it offers only income categories (Зарплата/Bonus/Salary/…); picking "Food" keeps kind = Expense (`tc22-food-selected.png`); flipping the segment to Income **clears** the now-incompatible selection back to Uncategorized (`tc22-after-flip.png`). Archived categories are absent from the picker.

### TC-23: Transaction list/summary UI states — loading, empty (fresh + empty month), error
- **Verifies**: mandatory UI-states category (loading/empty/error), plan Section
  "UI states" (skeletons; empty tells the user what to do; error is recoverable).
- **Precondition**: (a) `qa-mobile-empty` (zero tx); (b) qa-mobile-main navigated
  to a known-empty month; (c) list slow-load; (d) list error (API down mid-load).
- **Steps**:
  1. **Empty fresh account**: log in as qa-mobile-empty; open Transactions — read
     the empty state.
  2. **Empty month**: as qa-mobile-main, navigate to the seeded empty month.
  3. **Loading**: cold-open a month and screenshot the interim before data lands
     (skeleton), watching that "empty" does NOT flash while pending.
  4. **Error**: stop the API, then trigger a list load; read the error affordance;
     restart the API and use the retry.
- **Expected**:
  - Empty states show a **helpful message telling the user what to do** (e.g. "No
    transactions in {month}. Add your first one." + an Add affordance), not a bare
    blank panel; both the fresh-account and empty-month states render (not crash).
  - Loading shows a **skeleton/spinner**, not a flash of the empty state.
  - Error shows a **recoverable** affordance (Retry / message), the stale/empty
    view doesn't crash, and Retry recovers once the API is back. Metro shows only
    the intended failed request. Deliberate-failure substates (c/d).
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — (a) fresh account after registration: "No transactions in <month>. Add your first one." + an Add affordance (`tc01-after-register.png`); (b) seeded empty month июнь 2026 same helpful state, no blank panel (`tc23-empty-month.png`); (c) with the API frozen (SIGSTOP) the screen shows **skeleton placeholders**, never a flash of the empty state (`tc23-loading.png`); (d) API down → header shows a **"Retry account"** affordance which recovered (`GET /users/me 200`) once the API returned. Cosmetic nit F-4 (double period in the empty-month copy).

### TC-24: Offline / flaky network mid-flow — cached data stays, mutation fails retryable
- **Verifies**: mandatory offline category + plan QueryClient policy (cached data
  renders while a refetch is in flight; network errors **retry** up to 2×; 4xx
  never; `refetchOnReconnect`; O7 flaky-network stance — no crash, no silent loss).
- **Precondition**: Logged in; a month already **loaded and cached** in this
  session.
- **Steps**:
  1. With the month cached and visible, **stop the API** (simulator offline
     proxy: killing the API is the faithful simulator stand-in for a dead
     network; true airplane radio is TC-39).
  2. Confirm the already-loaded list/summary **stays visible** (cached), not
     blanked.
  3. Attempt a **mutation** (create a tx) while the API is down; read the result.
  4. Restart the API; use the retry affordance (or `refetchOnReconnect`).
- **Expected**: Cached month **stays rendered** with an in-flight/refetch
  indicator, not a blank screen. The mutation **fails with a visible, retryable
  error** (not a crash, not a silent success that a refresh would contradict — no
  optimistic lie). After the API returns, the retry/reconnect **recovers** and the
  tx persists to server truth. Metro shows the failed request handled, no
  red-screen. Deliberate-failure TC.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — with the month cached and the API killed, list + summary **stayed rendered** (9 rows, correct totals, `tc24-offline-cached.png`); a create attempt failed with the visible retryable "Can't reach the server. Check your connection and try again." (no crash, no optimistic lie — `tc24-offline-error.png`); after the API came back the same Save retried → `POST /transactions 201` and the summary moved to server truth.

### TC-25: Categories screen — merged list grouped by kind (AM-1.6-b)
- **Verifies**: AM-1.6-b (single archived-inclusive categories cache is the one
  source; grouped views client-derived), plan `CategoryList` SectionList grouped
  by kind.
- **Precondition**: qa-mobile-main with system + user categories per kind.
- **Steps**:
  1. Open the Categories tab; read the structure (screenshot + Read).
  2. Watch uvicorn: confirm a **single** categories fetch (`include_archived=true`)
     — not a second non-archived query.
- **Expected**: One merged list **grouped by kind** (Expense group, Income group).
  Exactly **one** GET /categories with `include_archived=true` powers the screen
  (AM-1.6-b — the ONE source; non-archived views are client-derived). No Metro
  errors.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — Categories tab is one merged list grouped **EXPENSE / INCOME** ("30 categories"), powered by a **single** `GET /categories?include_archived=true` — no second non-archived query.

### TC-26: Categories — Cyrillic names sort per Intl.Collator within kind groups (W11)
- **Verifies**: W11 (locale-aware re-sort within each kind group; DB byte order is
  determinism only), and matches the TC-34 `Intl.Collator` probe outcome.
- **Precondition**: The Cyrillic set (seed): "Ёлка", "Еда", "Кафе", "Продукты"
  (expense) chosen so DB byte order ≠ ru collation (incl. the Ё/Е pair).
- **Steps**:
  1. Open Categories; read the order within the expense group (screenshot + Read).
  2. Compare against `Intl.Collator(undefined,{sensitivity:'base'})` order
     (the outcome recorded in TC-34).
- **Expected**: Within each kind group the Cyrillic names appear in **locale
  collation order** (Е/Ё adjacency handled), **not raw server byte order**. The
  observed order matches the TC-34 probe result (if the probe recorded a
  `localeCompare`/code-point **fallback** because Collator was unavailable under
  Hermes, the list must match THAT fallback order — the two TCs must be
  consistent). No Metro error.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — within the expense group the Cyrillic set renders **Еда, Ёлка, …, Кафе, …, Продукты** — i.e. locale collation with correct Е/Ё adjacency, NOT DB/byte order (code-point order would put Ё U+0401 before Е U+0415). ⚠ Consistency nuance vs TC-34: the shipped probe calls `Intl.Collator(undefined,…)` and prints `sort = a,Z,Ё,Е` (Latin-first), while `sortForDisplay(categories, locale)` is called with the device locale (ru) whose CLDR collation reorders Cyrillic first — both are locale-correct, the two just resolve different locales, so the literal "probe order == screen order" clause of this TC does not hold by design.

### TC-27: Category create — color preview guard on valid/invalid hex (AM-hex)
- **Verifies**: AM-hex (the color-preview guard uses the **shared**
  `HEX_COLOR_PATTERN` exported from `@budget/shared`; web's local copy dies), W10
  (color stored as-entered; case-insensitive compare), plan `HexSwatch`.
- **Precondition**: Categories tab, create modal.
- **Steps**:
  1. Open the category-form modal. Enter a **valid lowercase** hex `#abc123` in
     the color field — watch the live swatch.
  2. Enter an **invalid** value `notacolor` (or `#12 zz`) — watch the swatch /
     validation.
  3. Correct it to `#ABC123` (uppercase) and submit with a name + kind.
- **Expected**: The live **swatch renders for the valid hex** and is
  **suppressed/guarded (no crash, no garbage swatch) for the invalid value**, with
  a clear field-level hint (e.g. "Enter a 6-digit hex color"). The created
  category stores the color **as entered** (case preserved — W10) and appears in
  the correct kind group without reload. No Metro error.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — live swatch renders for `#abc123` (`tc27-valid-hex.png`); for `notacolor` the swatch is suppressed to a neutral placeholder with no crash/garbage (`tc27-invalid-hex.png`) and Save is blocked client-side with the field hint **"Enter a 6-digit hex color like #3366FF."** (no request issued); corrected to `#ABC123` → `POST /categories 201`, category appears in the right kind group at the right sort position, and a server read-back shows the colour stored **as entered: `#ABC123`** (case preserved).

### TC-28: Category rename reflects immediately
- **Verifies**: plan `useUpdateCategory` updating the archived-inclusive cache
  in-place by id (AM-1.6-b), W2-adjacent success path.
- **Precondition**: A user category exists.
- **Steps**:
  1. Open Edit on a user category; change the name; submit.
- **Expected**: The new name appears immediately in the correct kind group at the
  locale-correct sort position (no reload). uvicorn shows one PATCH. No Metro
  error.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — renaming a user category → one `PATCH /categories/{id} 200`; the new name appears immediately (no reload) at the locale-correct sort position within its kind group.

### TC-29: Category kind-flip into a same-name sibling → field-level 409 (W2)
- **Verifies**: W2 (`CATEGORY_NAME_CONFLICT` fires on a **kind-only** PATCH →
  field-level name message; runtime-narrow `string | ValidationError[]`), W9 (no
  client-side dedup pre-gate — rely on server 409).
- **Precondition**: An **expense** "Bonus" AND an **income** "Bonus" both exist
  (legal — dedup is same-kind scoped).
- **Steps**:
  1. Edit the **expense** "Bonus"; flip its **kind to Income** (name untouched);
     submit.
- **Steps observability**: `[wire: proxy-or-code-read]` that only `kind` is in the
  body; uvicorn shows the 409.
- **Expected**: The server returns **409 CATEGORY_NAME_CONFLICT** (income "Bonus"
  collides), surfaced as a **field-level** message on the name/kind area — NOT a
  generic banner, NOT raw JSON, NOT a crash. The request reached the server (no
  client pre-gate, W9). Deliberate-failure TC.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — kind-only flip of the expense "Bonus" to Income → `PATCH /categories/{id}` **409** and the message surfaces as a **field-level** error under Name: "A category with this name already exists in this type." No generic banner, no raw JSON, no crash; the request reached the server (no client pre-gate). Screenshot `tc29-409.png`.

### TC-30: Categories — archive behind confirm + unarchive (W9)
- **Verifies**: W9 (archive = PATCH `{archived}` behind a confirm; unarchive free;
  **NO DELETE** for categories), plan `Alert.alert` confirm.
- **Precondition**: A user category "Subscriptions" (with a historical tx).
- **Steps**:
  1. Trigger archive on "Subscriptions" → confirm dialog appears; **cancel** →
     no change (no request in uvicorn).
  2. Trigger archive again; **confirm**.
  3. Confirm it shows an Archived treatment; then **unarchive** it.
- **Steps observability**: uvicorn shows PATCH `{archived:true}` then
  `{archived:false}` — **never a DELETE**.
- **Expected**: Archive is confirm-gated (cancel = no-op). Confirm → PATCH
  `archived:true`; unarchive → PATCH `archived:false`. **No DELETE request is ever
  issued** (W9). No Metro error.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — Archive is confirm-gated ("Archive category … It stays on past transactions but won't be selectable for new ones", `tc30-archive-confirm.png`); **Cancel issued no request**; confirm → `PATCH 200` and the row gains an "Archived" tag; Unarchive (also confirm-gated) → `PATCH 200` and the tag is gone. **Zero `DELETE /categories` requests in the entire session** (`grep -c` = 0).

### TC-31: is_system rows are non-editable (W9)
- **Verifies**: W9 (`is_system` gates edit/archive affordances client-side; server
  403 is the backstop).
- **Precondition**: The 18 seeded system categories are present.
- **Steps**:
  1. Open Categories; locate a **system** category (e.g. "Продукты") and a user
     category.
  2. Attempt to open edit/archive on each (tap the row).
- **Expected**: System categories are **visually distinct** (badge/style) and
  expose **no** edit/archive controls — the row is non-interactive (no press opens
  a form); user categories DO open the edit form. No Metro error.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — the 18 system rows render as non-interactive rows with a **"System"** tag (they are not Buttons in the accessibility tree); tapping one opens nothing, while user categories open the edit form on tap.

### TC-32: Archived category still labels old transactions and summary buckets (W3/AM-1.6-b)
- **Verifies**: W3 (list/summary join targets the **archived-inclusive** set),
  AM-1.6-b (the one archived-inclusive cache), plan `buildCategoryIndex`.
- **Precondition**: A tx assigned "Subscriptions" (or "Rent") that was archived
  **after** the tx existed (seed §6 + archived in TC-30).
- **Steps**:
  1. Open the month containing that tx; read the row's category name/icon.
  2. Open the summary breakdown; confirm the archived category's bucket still
     labels correctly.
  3. Open a NEW transaction-form modal; confirm the archived category is **absent**
     from the (kind-segmented) picker's selectable options.
- **Expected**: The historical row + the summary bucket still render the archived
  category's **name and icon** (not "unknown"/blank) — the join uses the
  archived-inclusive set (W3). The archived category does **not** appear as a
  selectable option for a NEW transaction. No failed-lookup Metro error.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — after archiving "Subscriptions" (and with "Rent" archived at seed) the август 2026 list rows and the summary buckets still render both names ("Rent", "Subscriptions" — the breakdown even italicises the archived ones), no "unknown"/blank, no failed-lookup error; and **neither appears as a selectable option in a NEW transaction's picker**. Screenshot `tc32-archived-labels.png`.

### TC-33: Platform probe — `Request.clone()` __DEV__ spike outcome recorded (O4)
- **Verifies**: O4 (VERIFY-don't-assert RN `Request`/body semantics; the finding
  drives clone-vs-captured-init-rebuild). This is a **record-the-outcome** TC.
- **Precondition**: Dev build/`__DEV__`, app pointed at the local API. The
  implementation ships the O4 probe (plan Section A step 1–3) that logs to the
  Metro console.
- **Steps**:
  1. Launch the app in dev; trigger the first protected call.
  2. Read the Metro console for the probe output: (a) `input instanceof Request`
     under RN; (b) whether `Request.clone()` preserves an un-sent JSON body across
     a send.
  3. **Record both results verbatim** in this TC's result.
- **Expected**: The probe logs a definitive result. Record it. The app must work
  regardless — the plan commits to the **captured-init rebuild as the DEFAULT**
  unless clone is proven sound, so the pass condition is "the probe ran and the
  auth-fetch replay path (retry after refresh) works end-to-end (TC-7/TC-10
  succeed)", not a particular clone verdict. Note the recorded outcome for the
  senior diff gate.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS (outcome recorded) — Metro console, verbatim, on every launch: `[probe:O4a] input instanceof Request = true | url = http://probe.local/users/me | method = GET`; `[probe:O4c] 'body' in Request.prototype = false | typeof probeRequest.body = undefined | text() reads = true`; `[probe:O4b] clone preserves body = true | sent.len = 11`. The replay path it protects works end-to-end on device (TC-7/TC-10 retried four requests after one refresh).

### TC-34: Platform probe — `Intl.Collator` under Hermes recorded (W11)
- **Verifies**: W11 (confirm `Intl.Collator` behavior under Hermes on RN
  0.86/Expo 57; record the fallback if unsupported). Record-the-outcome TC.
- **Precondition**: Dev build; the implementation ships the W11 `__DEV__` probe
  (plan Section E: `new Intl.Collator(undefined,{sensitivity:'base'}).compare('Ё','Е')`
  + a sort of `['Z','a','Ё','Е']`).
- **Steps**:
  1. Launch in dev; read the Metro console for the probe output.
  2. **Record** the compare result and the sorted array verbatim.
- **Expected**: The probe logs a result. Record whether `Intl.Collator` is
  available and its order, OR that `sortForDisplay` fell back to
  `localeCompare`/code-point. **TC-26's observed category order must match this
  recorded outcome** (consistency check). No crash from the probe.
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS (outcome recorded) — Metro console, verbatim: `[probe:W11] Collator available = true | compare(Ё,Е) = 0 | sort = a,Z,Ё,Е`. No crash. Consistency with TC-26 is discussed there (probe uses `undefined` locale, the app passes the device locale).

### TC-35: Metro / console hygiene across every tested flow
- **Verifies**: cross-cutting hygiene (mandatory category), W8 (no request storms
  from over-invalidation / render loops).
- **Precondition**: Run alongside TC-1..TC-32.
- **Steps**:
  1. With the Metro terminal visible, execute each happy-path flow (login, list
     load, month nav, create, edit, delete, categories CRUD, archive/unarchive,
     paging).
  2. Watch for red-screens, `console.error`/warnings, and the uvicorn request
     stream.
- **Expected**: **Zero red-screens and zero React key/act warnings** on the happy
  paths (errors are acceptable only in the deliberate-failure TCs 3/4/11/23/24/29).
  No duplicate/looping API requests — each mutation fires exactly its request +
  the intended scoped invalidation refetches (list + affected-month summary), not
  a storm; month navigation does not re-fire prior months' requests; no render
  loop hammering `/transactions` or `/categories`.

---
- **Status (run 2 — 2026-08-18, simulator iPhone 17 Pro / iOS 26.5, Expo Go 57.0.9)**: ✅ PASS — across every flow above: **zero red-screens, zero uncaught errors, zero React key/act warnings** (36 LOG / 10 WARN lines total in Metro). No request storms: each mutation fired its own request plus the intended scoped invalidations only; month navigation never re-fired prior months. Two non-blocking WARNs recorded as findings F-2 (`Require cycle: src/auth/useAuth.ts -> src/auth/useMe.ts -> src/auth/useAuth.ts`, once per launch) and F-3 (`DateTimePicker: onChange is deprecated…`).

## Section B: manual device (run by the user)

These genuinely need a **physical device** (Expo Go, same Wi-Fi as the Mac) or a
human judgment the simulator cannot fake. mobile-qa writes the steps + expected
results; the USER executes. **mobile-qa NEVER marks a Section B item as passed.**

### TC-36: Base-URL reachability from a physical device (same Wi-Fi, API on 0.0.0.0)
- **Device**: iPhone (physical), Expo Go, on the **same Wi-Fi** as the Mac.
- **Verifies**: plan Section C (host derived from Expo `hostUri` +
  `EXPO_PUBLIC_API_URL` override) and its **honest failure modes** (device on a
  different network can't reach the LAN host; API must bind `0.0.0.0`).
- **Steps**:
  1. Start the API bound to `0.0.0.0:8010` (`--host 0.0.0.0`); start
     `npx expo start` on the Mac; open the project in **Expo Go** on the phone.
  2. Without setting `EXPO_PUBLIC_API_URL`, attempt to log in — this exercises the
     `hostUri`-derived `http://<mac-lan-ip>:8010` path.
  3. Then repeat with the phone on a **different network** (cellular / guest
     Wi-Fi) to observe the documented failure.
- **Expected**: On the same Wi-Fi with a `0.0.0.0` bind, login + list load work
  over the derived LAN host. On a different network, the app shows the O7 **network
  error affordance** (not a crash); setting `EXPO_PUBLIC_API_URL` to a reachable
  host recovers it. Confirms the plan's honest dev-reachability contract.
- **Status**: ⏸ needs human

### TC-37: Android hardware back button on auth/protected boundaries
- **Device**: Android (physical or emulator if one is available), Expo Go.
- **Verifies**: plan Section A/B (Android hardware back must not escape the auth
  screen into the protected group; the `(app)` guard's `<Redirect>` handles the
  reverse).
- **Steps**:
  1. Logged out on the login screen: press the **hardware back button**.
  2. Log in; on a protected tab press back; navigate into a modal form and press
     back.
  3. Log out; try to press back into the protected area.
- **Expected**: Back on the login **root** exits the app (OS default; acceptable)
  — it does NOT slip into the protected group. Back inside the app behaves
  sensibly (modal dismisses; tab/stack pops); you cannot hardware-back from
  logged-out into protected content. No crash.
- **Status**: ⏸ needs human

### TC-38: iOS swipe-back disabled on the auth root
- **Device**: iPhone (physical), Expo Go.
- **Verifies**: plan Section A (auth login/register root has
  `gestureEnabled:false` so a swipe can't escape an unauthenticated screen).
- **Steps**:
  1. On the login/register root, attempt the **iOS swipe-back gesture** from the
     left edge.
- **Expected**: The swipe-back is **disabled** on the auth root (no swipe out into
  nothing); within the auth Stack, login↔register still navigate as designed.
- **Status**: ⏸ needs human

### TC-39: Keyboard avoidance & feel on amount / note / password (small screen)
- **Device**: iPhone (physical, ideally a small screen e.g. SE) + one Android.
- **Verifies**: plan Section "Keyboard" (`KeyboardAvoidingView` behavior differs
  iOS/Android; amount/note/password fields and the submit button must stay
  visible), mandatory forms category (keyboard doesn't cover inputs/submit).
- **Steps**:
  1. On login: focus the password field — confirm it + the submit button remain
     visible above the keyboard.
  2. On the transaction form: focus the **amount** (decimal keyboard) then the
     multiline **note** — confirm neither the field nor the Submit button is
     covered; scroll works with `keyboardShouldPersistTaps`.
  3. Repeat on Android (`behavior:'height'`).
- **Expected**: On both platforms the focused field and the submit control stay
  reachable above the keyboard; typing feels responsive; dismissing the keyboard
  works. No field is permanently obscured on a small screen.
- **Status**: ⏸ needs human

### TC-40: Safe-area / notch / home indicator
- **Device**: iPhone with a notch/Dynamic Island (physical).
- **Verifies**: plan Section "Native modules"/SafeArea (every screen wraps content
  in SafeArea; Tabs bar respects the bottom inset), mandatory visual-sanity
  category.
- **Steps**:
  1. Walk every screen (login, transactions, categories, both modals).
  2. Check the top (notch/status bar) and bottom (home indicator / tab bar).
- **Expected**: No content clipped by the notch/Dynamic Island; headers and the
  tab bar respect safe-area insets; no text under the home indicator; modals
  present within the safe area. Dark/light mode (if supported) render sanely.
- **Status**: ⏸ needs human

### TC-41: Backgrounding mid-refresh then resume (O5)
- **Device**: iPhone (physical) — **device-only**: simulator suspend is unfaithful
  to real JS-thread suspension (plan Risk + O5).
- **Verifies**: O5 (`AppState` resume re-evaluates `inFlight` + token freshness;
  single-flight still holds across a mid-refresh suspend; no second refresh; guard
  reacts on resume).
- **Steps**:
  1. With an about-to-expire access token, trigger a protected action that starts
     a refresh, then **immediately background the app** (home button) for ~30s.
  2. **Foreground** the app.
  3. Repeat a variant where the refresh **terminally fails** while backgrounded.
- **Expected**: On resume the app re-evaluates and settles correctly — a
  successful mid-refresh resolves its awaiters (no duplicate refresh; check
  uvicorn for a single `/auth/refresh`), the screen shows fresh data, no login
  flash. If the refresh terminally failed while backgrounded, on resume the guard
  redirects to login (`reason=expired`) — no crash, no stuck spinner.
- **Status**: ⏸ needs human

### TC-42: Haptics feel on destructive confirm
- **Device**: iPhone (physical) — haptics are not observable on the simulator.
- **Verifies**: plan Section E (`expo-haptics` `notificationAsync(Success)` on the
  key confirmation).
- **Steps**:
  1. Delete a transaction and confirm; note the haptic on confirmation.
  2. Archive a category and confirm; note the haptic.
- **Expected**: A success haptic fires on the confirmed destructive action; it
  feels appropriate (not on every tap, not absent). No error.
- **Status**: ⏸ needs human

### TC-43: Secure-store persistence across app kill/relaunch (device)
- **Device**: iPhone (physical) — Keychain-backed secure-store on real hardware.
- **Verifies**: O2 (tokens in `expo-secure-store` only; survive a full kill),
  companion to TC-6 but on real Keychain.
- **Steps**:
  1. Log in on the device. **Force-quit** (swipe up from the app switcher).
  2. Relaunch from cold.
  3. Then log out, force-quit, relaunch again.
- **Expected**: After the first relaunch the app opens **still logged in**
  (directly on Transactions, no login flash) — the token survived in the Keychain.
  After the logout + relaunch it opens **logged out** (token cleared). No crash.
- **Status**: ⏸ needs human

### TC-44: Android datetimepicker dialog behavior
- **Device**: Android (physical or emulator), Expo Go.
- **Verifies**: plan Section E (`@react-native-community/datetimepicker` renders
  the native Android **dialog**; iOS shows inline/spinner — the iOS variant is
  simulator/Section-A-observable, but the Android dialog + its
  confirm/cancel/back interaction is device/emulator-specific).
- **Steps**:
  1. In the transaction form, tap the date field → the Android date **dialog**
     opens.
  2. Pick a date; confirm. Reopen and **cancel**. Reopen and press hardware back.
  3. Verify the chosen date is stored/rendered and converted via `toApiDate`
     (submit and confirm the row shows the picked day, no TZ off-by-one).
- **Expected**: The native Android date dialog opens on tap; confirm sets the
  date; cancel/back leave the prior value; the stored `occurred_at` matches the
  picked day (no timezone drift). No crash.
- **Status**: ⏸ needs human

---

## Obligation coverage map

Observable items → the TC(s) that verify them; purely-structural items are marked
as senior-diff-gate (not QA-observable).

| ID | Verified by (TC) / disposition |
|---|---|
| **O1** (copy coordinator, reuse only helpers/schemas) | Structural — senior diff gate; behavior surfaces in TC-2/TC-7/TC-10/TC-11 (login/refresh work end-to-end) |
| **O2** (async-hydrate-once, splash gate, sync snapshot, secure-store only) | TC-6 (no login flash), TC-5 (logout clears), TC-43 (device Keychain persist) |
| **O3** (single-flight is the entire concurrency story; no double-spend) | TC-10 (exactly one refresh) + TC-7; vitest coordinator suite is the definitive dedup proof (fallback if the wire burst can't be induced) |
| **O4** (VERIFY Request/clone semantics; captured-init rebuild default) | TC-33 (record probe outcome); replay correctness surfaces in TC-7/TC-10 |
| **O5** (AppState resume; reactive-only) | TC-41 (device-only, Section B); reactive-refresh path in TC-7 |
| **O6** (React guard redirect; typed `next`; authFetch never navigates) | TC-8 (next preserved), TC-9 (logged-out unreachable), TC-11 (reason=expired), TC-37/TC-38 (device back/swipe boundaries) |
| **O7** (app-owned error copy incl. network arm; retryable) | TC-3 (bad-creds copy), TC-4 (network arm), TC-24 (mutation retry), TC-36 (device network arm) |
| **AM-1.6-a** (offset is pageParam, not a key member) | TC-14 (no key thrash / no dup rows across load-more) |
| **AM-1.6-b** (single archived-inclusive categories cache) | TC-25 (one include_archived fetch), TC-32 (archived-inclusive join) |
| **AM-1.6-c** (category picker kind-SEGMENTED) | TC-22 (segmented, never "filtered") |
| **AM-schemas** (shared schemas + month helpers) | TC-12 (month math), TC-15 (money schema) — behavior; module reuse is senior diff gate |
| **AM-hex** (HEX_COLOR_PATTERN exported from shared; web copy dies) | TC-27 (color preview guard valid/invalid); the web-copy deletion is senior diff gate |
| **W1** (PATCH omit-vs-null; single builder) | TC-17 (amount-only omit), TC-20 (note→null) — `[wire: proxy-or-code-read]`; builder logic is vitest/senior diff gate |
| **W2** (runtime 422 narrow; error codes incl. kind-only 409) | TC-29 (kind-flip 409 field-level), TC-3 (LOGIN_BAD_CREDENTIALS) |
| **W3** (archived-inclusive join; Uncategorized; composite key) | TC-20 (refund double-bucket + no key warning + Uncategorized), TC-32 |
| **W4** (formatMoney signed net; parseMoney minor units) | TC-13 (negative net), TC-15 (12.34 minor-units) |
| **W5** (kind from category.kind; no cross-enum alias) | TC-22 (picking category sets kind) |
| **W6** (limit=200; has_more derived) | TC-14 (load-more N of total), TC-12 (from/to) |
| **W7** (no currency collected; render from data) | TC-13, TC-15 (no currency field) |
| **W8** (dual-month summary invalidation; list-only predicate) | TC-18 (both months update, C untouched) — load-bearing; TC-15/TC-19 (single-month invalidation) |
| **W9** (is_system gates; archive=PATCH; no DELETE; no client dedup) | TC-30 (archive/unarchive, no DELETE), TC-31 (is_system non-editable), TC-29 (no client dedup pre-gate) |
| **W10** (color casing stored as-entered; case-insensitive compare) | TC-27 (lowercase/uppercase hex preserved) |
| **W11** (Intl.Collator under Hermes VERIFY + fallback) | TC-34 (probe outcome), TC-26 (Cyrillic order matches the probe) |
| **A-1** (login via shared form-encoded helper) | TC-1/TC-2 (login/register succeed); encoding not re-derived is senior diff gate |
| **S1** (contract untouched; generated byte-identical) | Not QA-observable — senior diff gate (grep generated/**, api-client exports) |
| **S2** (plan-mobile.md not plan.md) | Not QA-observable — senior diff gate |
| **S3** (full lint/typecheck/test gate) | Not QA-observable — CI/senior gate |
| **S4** (vitest-only runner; wiring.test.ts deleted) | Not QA-observable — senior diff gate |
| **S5** (no speculative shared package) | Not QA-observable — architect/senior diff gate |
| **S6** (dev env :8010 / :5443 / simulator) | Environment preamble; TC-36 (device reachability) |

---

## RUN SUMMARY — run 2 (2026-08-18, simulator) · FINAL

- **Section A — 35 TCs executed** (TC-1..TC-35 with TC-21 merged into TC-22, plus TC-1b):
  - ✅ **passed: 34**
  - ❌ **failed: 1 — TC-8** (deep-linked `next` return route lost across login; full
    evidence + isolating controls in the RUN 2 section above)
  - ⏸ **blocked: 0** (the R7 toolchain gap is closed)
- **Section B — 9 TCs (TC-36..TC-44): ⏸ needs human**, untouched — physical-device only
  (LAN reachability, Android back, iOS swipe-back, keyboard feel, safe-area/notch,
  background-mid-refresh resume, haptics, Keychain persistence, Android datetimepicker).
- **Non-blocking findings**: F-1 (ru decimal-pad comma rejected by amount validation),
  F-2 (require cycle warning), F-3 (DateTimePicker deprecation warning), F-4 (double
  period in empty-state copy). See RUN 2 section.
- **Overall: ❌ FAIL OVERALL — senior-lead must handle TC-8** (and triage F-1). All other
  obligations, including every load-bearing one, are verified on a rendered app.
- **State left behind**: Postgres :5443 + MinIO running (as found); QA uvicorn and Metro
  stopped after the run; simulator left booted with Expo Go installed. New QA users
  `qa-sim-main@budgetqa.dev` / `qa-sim-empty@budgetqa.dev` / `qa-sim-reg-*` persist in the
  dev DB with their run mutations (250-tx month 2026-03, refund month 2026-04, the A→B
  move, a renamed "Żeś Renamed" category, and a few journey tx). `qa-mobile-*` from
  run 1 untouched.

---

## RUN SUMMARY (executed 2026-07-25 — degraded-honest per R7; SUPERSEDED by run 2)

### Counts

- **Section A — 34 TCs** (TC-1..TC-35, TC-21 merged into TC-22; plus TC-1b):
  - ✅ **passed outright: 0** (no TC's full pass condition — a rendered app
    journey — could be verified without a simulator).
  - ❌ **failed: 0.**
  - ⏸ **blocked-environment: 35** (all 34 Section-A TCs + TC-1b) — no full Xcode /
    no `xcrun simctl` / no device (R7). Each carries fallback evidence in the
    per-TC table above.
- **Global support evidence: ✅ vitest 28/28**, **✅ Metro iOS export (1818
  modules, exit 0)**, **✅ server-side wire journeys all green**.
- **Section B — 9 TCs** (TC-36..TC-44): ⏸ **needs human** (untouched) — a physical
  device is required.

### Honest statement of what WAS and was NOT verified

- **VERIFIED (this run):** the mobile logic behind auth/refresh/error/route (vitest
  28/28, incl. single-flight dedup, 401→refresh→retry, terminal-clear, O4 body
  preservation + RN-polyfill tripwire, network-arm copy, safeNextRoute, 409/archived
  error routing); that the entire app graph compiles and bundles to Hermes bytecode
  (Metro export); and the **server contract + seed integrity** every TC journey
  depends on (auth codes, refresh single-use, PATCH omit-vs-null behaviourally,
  cross-month dual-summary math, kind-flip 409, note→null, minor-units round-trip,
  include_archived single source, no category DELETE, is_system/system rows,
  refund double-bucket + uncategorized bucket).
- **NOT VERIFIED (blocked-environment):** anything that requires the app actually
  rendered on a device/simulator — pixels, splash-gate no-flash, keyboard type &
  avoidance, gesture/back navigation, the on-device probe console verdicts
  (TC-33/34), rendered empty/loading/error states, live React key-warning watch,
  scroll smoothness, and every on-the-wire count observed from the app (as opposed
  to curl). Server-side curl is SERVER evidence only and did NOT turn any simulator
  TC green.

### Seed-data / environment state left behind

- **Postgres :5443 — RUNNING** (left as found). **API :8010 — RUNNING** (left as
  found; not restarted, so no default/.env/TTL was touched — the refresh
  single-use check needed no TTL override).
- **Seed users (persist on the shared dev DB):**
  `qa-mobile-main@budgetqa.dev` / `qa-mobile-empty@budgetqa.dev`, pw `Qa!Test1234`.
- **`qa-mobile-main` mutations left in place** (not rolled back — dedicated QA
  user, safe to reuse or drop): 12 user categories (incl. Cyrillic set + two
  "Bonus" + Subscriptions/Rent **archived**); tx sets across 2025-11/12,
  2026-01..07 incl. the **250-row** heavy month 2026-03, the negative-net+refund
  month 2026-04, the A/B/C cross-month set (the A→B move already applied), and a
  handful of journey PATCH/POST side-effects (TX_SUBS amount now 8888, TX_MOVE now
  in 2026-02, TX_NOTED note cleared, one 12.34 tx added to 2026-07). **A clean
  re-seed should use fresh emails or drop these two users first** — the journey
  mutations mean the current numbers are post-journey, not pristine.

### User-facing next steps (to clear Section A + Section B on real hardware)

To turn the ⏸ blocked-environment items into real ✅/❌, do ONE of:

1. **Install full Xcode** (App Store or `xcodes`), then
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` + accept the
   license → `xcrun simctl` returns. Then from `apps/mobile`:
   `EXPO_PUBLIC_API_URL=http://localhost:8010 npx expo run:ios` and walk TC-1..TC-35
   with `xcrun simctl io booted screenshot`. (The O4/W11 probe console lines land
   in the Metro terminal on first launch — capture them into
   `spike-request-clone.md` for TC-33/34.)
2. **Expo Go on a physical iPhone**, same Wi-Fi, API bound `--host 0.0.0.0:8010`:
   `npx expo start`, scan the QR. This also lets you execute the whole **Section B**
   set (TC-36..TC-44: LAN reachability, Android back, iOS swipe-back, keyboard
   feel, safe-area/notch, background-mid-refresh resume, haptics, Keychain
   persistence, Android datetimepicker) — none of which a simulator can fake.

### Overall verdict

**No ❌ failures.** Every obligation that is provable off-device is GREEN (vitest +
Metro export + server contract). Because R7 removed the simulator, the Section A
*app-journey* pass conditions are **⏸ blocked-environment, not passed** — so this is
**NOT a full "READY FOR REVIEW"** on QA's own authority; it is **clean-so-far,
pending on-device execution**. Senior-lead decides whether the vitest + export +
server-side + code-read fallback stack (as ruled sufficient under R7) clears stage 5,
or whether the on-device pass is required before review. Section B's 9 items remain
pending human verification regardless.

---

## Summary (grooming — pre-implementation; superseded by RUN SUMMARY above)

- **Section A (simulator)**: 33 test cases (TC-1..TC-35; TC-21 reserved/merged
  into TC-22). Status: all ⏸ pending — implementation not started.
  - **Blocked-risk flags to resolve at run time**:
    - **Whole-section prerequisite**: `xcrun simctl` is currently unavailable
      (Command Line Tools only, no full Xcode) — Section A cannot run until full
      Xcode is installed or a device is used. See the run-phase prerequisite
      section.
    - **TC-7 / TC-10**: depend on a wait-out-able / configurable short access-token
      TTL to induce (concurrent) 401s; if not configurable, fall back to the
      vitest coordinator suite + code-read (do not fake the wire count).
    - **TC-17 / TC-20 / TC-29** wire-body key assertions: `[wire:
      proxy-or-code-read]` — literal PATCH-body inspection needs an intercept
      proxy; default is behavioral proof + `buildTransactionPatch`/
      `buildCategoryPatch` code-read, deferring the literal body to the senior
      diff gate.
- **Section B (manual device)**: 9 test cases (TC-36..TC-44), all ⏸ needs human —
  base-URL device reachability, Android back button, iOS swipe-back, keyboard
  avoidance/feel, safe-area/notch, O5 background-mid-refresh resume, haptics,
  secure-store kill/relaunch persistence, Android datetimepicker dialog.
