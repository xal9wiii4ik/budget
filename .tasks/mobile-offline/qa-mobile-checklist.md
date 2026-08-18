# QA Mobile Checklist: mobile-offline (roadmap 5.5)

## Scope

User-journey verification of offline capability on the **1.8 MVP mobile surface
only** (transactions list/summary/create, categories) — nothing else exists on
mobile. Covers: persisted read cache (D1), the create-only outbox (D2),
`client_id` idempotency as it manifests **on the wire** (D3), reconnect
detection and the trigger union (D4), the five enumerated conflict cases (D5),
the UI affordances — banner / Pending section / summary note / parked screen /
offline-disabled writes / logout confirm (D6), and the module/dependency
footprint as it manifests at app boot (D7: `expo-sqlite`,
`@react-native-community/netinfo`, `expo-crypto`).

**Not re-verified here (owned elsewhere):**

- **vitest (mobile-engineer)** — the pure cores. Named suites, deliberately not
  duplicated below: `src/offline/outbox.test.ts` (M-1, 17 tests: hydrate-once +
  FIFO across restart, corrupt-value tolerance, enqueue persist/notify, snapshot
  stability, drain + invalidation callback, park-on-rejected-continues,
  halt-on-transient, attempts-cap parks, 401 halts keeping the queue,
  single-flight, mid-run enqueue, enqueue-while-online kick, retry, discard,
  clear, `classifySendFailure` table, `toWireBody` leak guard);
  `src/offline/persist.test.ts` (M-2: allowlist predicate 5 branches,
  `decideOfflineAction` 5 rows); `src/offline/triggers.test.ts` (M-3: fires once
  at start, EDGE-only online transition, resume, unsubscribe);
  `src/offline/routing.test.ts` (M-4: `decideCreateRoute` 4 cells,
  `decideDirectFailure` 4 rows); `src/offline/sections.test.ts` +
  `src/offline/parkedCopy.test.ts` (M-5). **This checklist verifies that the
  same obligations MANIFEST in a running app** — what the user sees, what the
  API actually receives, and that caches converge to server truth.
- **pytest + curl (qa-engineer)** — B-1's server-side idempotency invariants
  (same `client_id` twice ⇒ one row / 200; two users same uuid ⇒ two rows;
  no-`client_id` byte-identical; race). Mobile QA only checks the wire evidence
  of the client half (TC-9).

**Inherited backlog, not re-listed:** the 44 on-device TCs of
`.tasks/mobile-mvp/qa-mobile-checklist.md` are still ⏸ pending (that run was
degraded — no Xcode at the time). Section A below **assumes the 1.8 basics
work** (login, month navigation, create/edit/delete, categories render). If a
1.8 basic is broken at /test time, the dependent offline TC is recorded
**blocked-by-1.8**, not failed against this scope.

---

## ⚠ Section A is CONDITIONAL on an iOS runtime (grounded probe, 2026-08-18)

Probed today by mobile-qa on this machine:

- `xcode-select -p` → `/Applications/Xcode.app/Contents/Developer` — **full
  Xcode.app IS now installed** (`xcodebuild -version` → Xcode 26.6, build
  17F113). This is the gap that blocked the whole 1.8 run; it is closed.
- `xcrun simctl` **responds** (no "not a developer tool" error).
- **BUT** `xcrun simctl list runtimes` prints `== Runtimes ==` with **zero
  entries**, and `xcrun simctl list devices available` prints `== Devices ==`
  with none. The iOS platform runtime was still downloading at grooming time.
  **No simulator can boot until it lands.**
- No Android tooling on this machine (`emulator`/`adb` not found,
  no `~/Library/Android`) ⇒ **all Android behaviour is Section B**, unchanged
  from 1.8.

**Run-phase rule (binding on whoever executes /test):**

1. First command of the run: `xcrun simctl list runtimes`.
2. **iOS runtime present** ⇒ Section A runs **FOR REAL**, TC by TC, with
   screenshots and Metro/uvicorn evidence. Every TC below is written to be
   executable the moment a runtime exists — no rewriting needed.
3. **Runtime list still empty** ⇒ Section A is **BLOCKED-BY-TOOLING in whole**;
   record `⏸ blocked (no iOS runtime — simctl runtimes empty)` on every TC with
   the literal command output pasted as evidence. **Never fake a pass.** In that
   case the obligations fall back to the vitest suites + the senior diff gate,
   and that must be stated in the run summary.
4. If the runtime is missing but a **physical iPhone** is available, Section A
   may be run in Expo Go on the device instead — note the substitution per TC,
   and treat the device-only caveats (real radio, real suspend) as satisfied by
   that hardware, which additionally clears the matching Section B items.

Fetching the runtime if it is still absent and the user wants it:
`xcodebuild -downloadPlatform iOS` (large download; user's call, not QA's).

---

## Environment / setup preamble (run phase, not grooming)

### Stack

- **Postgres** dev DB on `localhost:5443` (S6), migrated to head — head must
  include **B-1's `client_id` migration** (`transactions.client_id` +
  `uq_transactions_user_id_client_id`). Verify before starting: without it every
  replay TC is invalid. Its migration number is allocated after
  recurring-and-limits lands — do not assume `0006`.
- **API** on `:8010` (S6): `pnpm --filter @budget/api dev`. Add `--host 0.0.0.0`
  if a physical device will be used. Keep the **uvicorn access log visible** —
  it is the wire-count evidence source (`POST /transactions → 201` vs `→ 200`,
  `GET /transactions/summary`, counts per replay).
- **Mobile**: from `apps/mobile`,
  `EXPO_PUBLIC_API_URL=http://localhost:8010 npx expo run:ios` (or
  `npx expo start` + `i`). The three new native modules ship inside Expo Go and
  need no config plugin (plan §Platform concerns) — if Expo Go fails to boot
  with them, that is TC-1 failing, not a setup error to work around.
- Keep the **Metro terminal visible**: red screens, `console.*`, React key
  warnings, and persister restore errors all surface there.

### Offline simulation on the simulator — HONEST METHOD STATEMENT

The iOS Simulator has **no airplane mode**: it shares the Mac's network stack.
`xcrun simctl status_bar booted override --cellularMode searching` changes only
the **cosmetic** status bar, never connectivity — it must not be used as an
offline stand-in. Three real methods, named and used explicitly per TC:

| id | method | what the app experiences | what netinfo is EXPECTED to report |
|----|--------|--------------------------|------------------------------------|
| **OFF-A** | Stop the uvicorn API process (Ctrl-C) | TCP refused ⇒ RN `fetch` rejects `TypeError: Network request failed` ⇒ outbox `transient/network` | **online** (host has internet) — banner stays hidden; this exercises the *direct-failure ⇒ enqueue* arm, NOT the offline banner |
| **OFF-B** | Turn the Mac's Wi-Fi off (`networksetup -setairportpower en0 off`), API left RUNNING on loopback | loopback still reaches `:8010` — requests SUCCEED | netinfo **should** flip to offline (no active interface); loopback keeps the API reachable ⇒ isolates "banner says offline" from "requests fail" |
| **OFF-C** | Wi-Fi off **and** API stopped | nothing reachable | offline — the truest simulator approximation of a phone in the metro |

**OFF-B's netinfo result is itself unverified** (the simulator's `NWPathMonitor`
view of a host with only loopback up is not something grooming can assert).
**TC-2 is a calibration probe that records what actually happens**, and every
later TC states which method it uses. If OFF-B does **not** flip netinfo, TC-2
records that honestly and the banner-dependent TCs fall back to OFF-C, with the
"offline banner while requests still succeed" case demoted to Section B
(TC-M1). This is a measurement, not an assumption.

### Seed data (dedicated test users, never real data)

Seed via the existing API as test users (`@budgetqa.dev` — reserved TLDs are
rejected server-side). Fresh users, not 1.8's leftovers:

- `qa-off-main@budgetqa.dev` / `Qa!Test1234` — primary. Categories: "Groceries",
  "Food", "Salary" (income), plus **"Doomed"** (expense) which exists solely to
  be archived server-side mid-test (TC-10). Transactions: ~6 in the current
  month across ≥2 days, a handful in the previous month, **one month with 250
  transactions** (scripted loop) for TC-18.
- `qa-off-second@budgetqa.dev` / `Qa!Test1234` — the different-user purge target
  (TC-15). Must own at least 2 transactions with visibly different amounts so a
  leak is obvious on screen.
- `qa-off-fresh@budgetqa.dev` / `Qa!Test1234` — **never logged in on this
  device**; used exactly once for the cold-install TC-16. Give it 1–2
  transactions so "the month exists server-side" is true and the degraded state
  is provably about the local cache, not an empty account.

### Run rules

- Screenshot each key step: `xcrun simctl io booted screenshot <path>.png`, then
  **Read the image** — a screenshot not looked at is not evidence.
- A red screen, uncaught error, or React duplicate-key warning in Metro is a
  **FAIL** for the TC it appears under, except in the deliberate-failure TCs
  (2, 9, 10, 11, 16) where the *handled* failure is the pass condition.
- Restore the environment between TCs: API running, Wi-Fi on, outbox drained
  (or explicitly noted as carried over).
- Status legend: ⏸ pending · ✅ pass · ❌ fail (screenshot + log evidence) ·
  ⏸ blocked (reason).
- On failure: capture evidence, **do not fix code**, report to senior-lead.

---

## Section A: simulator (run by mobile-qa) — CONDITIONAL per the gate above

Numbering is scope-local (1.8's TC-1..44 are a separate document).

### TC-0: Runtime gate probe — decides whether Section A runs at all
- **Verifies**: the environment ruling above; grooming-review §7.
- **Steps**:
  1. `xcrun simctl list runtimes`
  2. `xcrun simctl list devices available`
- **Expected**: at least one **iOS** runtime and one bootable device ⇒ proceed
  with TC-1..TC-21. Empty list ⇒ paste the output verbatim, mark TC-1..TC-21
  `⏸ blocked (no iOS runtime)`, and stop Section A. No other outcome is
  acceptable; Section A is never "assumed fine".
- **Status**: ⏸ pending

### TC-1: App boots with the three NEW native modules linked — the highest-value smoke
- **Verifies**: D7 dependency list (`expo-sqlite`,
  `@react-native-community/netinfo`, `expo-crypto` + the two pure-JS persister
  packages); plan §New dependencies ("all bundled in Expo Go, no config plugin,
  no prebuild"); the whole scope's central unverifiable risk — *does the app
  still start at all*.
- **Precondition**: M-1..M-5 merged; `pnpm install` done; API up.
- **Steps**:
  1. `EXPO_PUBLIC_API_URL=http://localhost:8010 npx expo run:ios` (or
     `npx expo start` + `i` for Expo Go — record WHICH was used; if a dev build
     was required, that itself is a finding worth reporting).
  2. Watch the Metro output through bundling and first paint.
  3. Log in as `qa-off-main`; land on Transactions; screenshot.
  4. Grep gate cross-check (cheap, done here because it is boot-adjacent):
     `grep -rn "expo-sqlite\|netinfo\|expo-crypto" apps/mobile/src` returns ONLY
     `offline/storage.ts`, `offline/netinfo.ts`, `offline/ids.ts`,
     `offline/runtime.ts`.
- **Expected**: bundle succeeds; app reaches the login screen and then the
  Transactions tab. **No** "Native module cannot be null", no
  `requireNativeModule` / `TurboModuleRegistry` error, no unresolved-import
  redbox for any of the three modules, no `expo-sqlite` "database is locked" or
  kv-store open failure in Metro. Grep returns exactly the four files.
- **Status**: ⏸ pending

### TC-2: Offline-simulation calibration — what netinfo ACTUALLY reports (OFF-A/B/C)
- **Verifies**: D4 (netinfo is a HINT, never a gate); M-3 leaf wiring to
  `onlineManager`; establishes the method each later TC relies on. Deliberate-
  failure TC.
- **Precondition**: logged in, current month loaded.
- **Steps**:
  1. **OFF-A** — stop the API. Pull-to-refresh. Record: does the banner appear?
     What does Metro log? Does a create attempt enqueue (TC-5 territory) or show
     an inline error?
  2. Restart the API. **OFF-B** — `networksetup -setairportpower en0 off` with
     the API still running. Wait ~5s. Record: banner shown? Does pull-to-refresh
     still SUCCEED (loopback)?
  3. **OFF-C** — API stopped too. Record banner + request behaviour.
  4. Wi-Fi back on, API back up. Record how long until the banner clears and
     whether a refetch fires (`refetchOnReconnect`, uvicorn log).
- **Expected**: no crash in any state; the app degrades to cached data with a
  visible affordance in at least OFF-C. The **actual** netinfo behaviour per
  method is written into this TC's result table and referenced by every later
  banner-dependent TC. A finding of "OFF-B does not flip netinfo" is a valid,
  useful PASS of this probe — it is a measurement, and the affected checks move
  to OFF-C / Section B.
- **Status**: ⏸ pending

### TC-3: Persisted cache restores BEFORE first paint on a warm relaunch (online)
- **Verifies**: D1 (persister over kv-store, allowlist, buster);
  M-2 §Mounting + the Risk "PersistQueryClientProvider interaction with the
  existing splash gate"; M-2's "not verifiable here" item *restore precedes the
  first paint*.
- **Precondition**: logged in as `qa-off-main`; current month + categories
  loaded (so all three allowlisted families are in the cache); API UP.
- **Steps**:
  1. Kill the app from the simulator app switcher (full termination, not
     background).
  2. Relaunch. **Screenshot within the first second** of the app shell
     appearing, before any refetch could plausibly land.
  3. Compare against the uvicorn log timeline.
- **Expected**: the transactions list + summary render from hydrated cache —
  **skeletons are skipped or flash only briefly**; the subsequent refetch
  (staleTime 30s) overwrites with identical server data without visible jumping
  or a duplicated-row flicker. No "no data" flash between splash and hydration.
  If skeletons appear for a noticeable beat before data, record it as an
  accepted-but-observed deviation (the plan calls this acceptable) with the
  screenshot.
- **Status**: ⏸ pending

### TC-4: Offline browse after app KILL + relaunch — kv-store durability (HIGHEST-CONSEQUENCE)
- **Verifies**: D1 persistence medium; M-2's top "not verifiable here" item and
  the plan's **highest-consequence unverified risk** ("kv-store writes actually
  persisting across a cold start — if they silently don't, the feature is
  hollow"); D5.5 (cache never merged, only replaced).
- **Precondition**: TC-3 state (month + categories cached), then a queued item
  from TC-5 may be carried in deliberately (note if so).
- **Steps**:
  1. With everything loaded, go **OFF-C** (Wi-Fi off + API stopped).
  2. **Kill the app** completely from the app switcher.
  3. Relaunch it while still OFF-C. Screenshot the Transactions tab and the
     Categories tab.
  4. Navigate to the previous month (also cached) and back.
- **Expected**: the app opens **logged in** (secure-store, O2) and renders the
  **cached** transactions, summary numbers and categories with the offline
  banner — not skeletons-forever, not an error box, not an empty state, not a
  crash. Uncached months may legitimately show the error/empty state with a
  retry affordance (O7) — that is correct, not a failure. **If the lists are
  empty here, the persister is not actually writing to disk: report as a
  BLOCKER — the fallback posture recorded by senior-lead is "fix before
  release", never a silent ship.**
- **Status**: ⏸ pending

### TC-5: Offline create ⇒ queued row in the pinned Pending section + summary note
- **Verifies**: D2 (create is the ONLY offline-capable mutation); D6 (rendered
  FROM OUTBOX STATE, never inserted into the Query cache); D5.3 (summary shows
  server numbers + "N pending — not included"); M-5 §Pending section (top-pinned,
  month-scoped, queued-only); M-4 §Create-form UX (no "Saved" lie, immediate
  dismissal, honest wording lives on the row/banner).
- **Precondition**: month loaded and cached; outbox empty; then **OFF-C**.
- **Steps**:
  1. Offline, tap "+", enter `12.50`, pick "Groceries", keep today's date,
     submit.
  2. Observe the form dismissal and the transactions screen. Screenshot.
  3. Create a second one (`3.00`, "Food"). Screenshot.
  4. Read the summary header numbers and compare with pre-offline values.
- **Expected**: the form **dismisses immediately** (no spinner hang, no "Saved"
  claim, no inline error); each row appears in a **"Pending — not yet synced"**
  section **pinned at the TOP** of the list, visually distinct (dimmed +
  "Pending" badge), **not** interleaved into the day groups; the row is **not
  pressable to edit** (Q2 Discard-only). Amounts render `12.50` in the account
  currency via `formatMoney` (W4/W7 — no raw `1250`, no float artefacts,
  currency taken from the cached summary, never collected from the user).
  Category name shown from the archived-inclusive index (W3). **Summary totals
  are UNCHANGED** and gain "2 pending — not included". Footer "Showing N of
  total" still counts SERVER rows only. Metro: no red screen, no duplicate-key
  warning across the union rows.
- **Status**: ⏸ pending

### TC-6: Pending section semantics — month scope, parked exclusion, empty state
- **Verifies**: M-5 §Pending section rationale 3 (month-scoped section vs global
  banner count); `pendingForMonth` excludes PARKED; TransactionList empty-state
  condition (`server.length === 0 && pending.length === 0`).
- **Precondition**: TC-5's two queued items in the CURRENT month, still offline;
  ideally one parked item from TC-10 present (run this after TC-10 if so, and
  say which).
- **Steps**:
  1. Navigate to the PREVIOUS month. Screenshot.
  2. Return to the current month. Screenshot.
  3. Offline, create a transaction dated in the **previous** month; then look at
     both months.
  4. With a parked item present, confirm it does NOT appear in the Pending
     section of any month.
  5. Navigate to a month with **no** server transactions and no pending items.
- **Expected**: the Pending section shows only items whose `occurred_at` month
  matches the month on screen; the **banner count stays global** (nothing
  silently disappears — the count still reads the total). Parked items never
  appear in the Pending section (they live on the pending screen). An empty
  month with no pending items shows the normal empty state; a month with only
  pending items does NOT show the empty state.
- **Status**: ⏸ pending

### TC-7: Offline banner — all five variants
- **Verifies**: D6 banner; M-5 banner table (five variants); O7 (every failure
  state has a visible affordance); placement per-tab-screen inside the safe area.
- **Precondition**: ability to reach each state (uses OFF-C for offline, OFF-A
  for the "online with queue" arm if TC-2 showed OFF-B does not flip netinfo).
- **Steps** — screenshot each of the five, on BOTH the Transactions and
  Categories tabs:
  1. `parked > 0` ⇒ "N transaction(s) failed to sync", tappable → `/pending`.
  2. `offline && queued > 0` ⇒ "Offline — N transaction(s) will sync later".
  3. `offline`, no queue ⇒ "Offline — showing saved data".
  4. `online && queued > 0` ⇒ "Syncing N…" with a working **"Sync now"**.
  5. Fully synced, online ⇒ banner **absent** (renders `null`), no leftover gap.
- **Expected**: the correct single variant each time (parked outranks the
  others), counts accurate, text on one line with ellipsis rather than
  overflowing, tappable variants ≥44pt and actually navigating, banner never
  covering the toolbar or the notch. Variant 5 leaves no empty strip.
- **Status**: ⏸ pending

### TC-8: Reconnect ⇒ replay ⇒ exactly ONE POST per queued item (201), FIFO, W8 refetch
- **Verifies**: D2 replay engine (FIFO, single-flight, sequential); D4 trigger
  union; **W8 invalidation identity** (replay success runs the SAME invalidation
  as `useCreateTransaction.onSuccess` — one exported function, two callers);
  D5.3 (server wins on refetch).
- **Precondition**: TC-5's queued items (know their order and amounts); still
  OFF-C; **clear the uvicorn log** immediately before step 1.
- **Steps**:
  1. Wi-Fi back on and API back up (restore the API FIRST so the reconnect edge
     finds a reachable server).
  2. Watch the screen without touching it for ~10s; screenshot mid-sync if the
     "Syncing N…" banner appears.
  3. Read the uvicorn access log for the whole window.
  4. Screenshot the settled list and summary.
- **Expected**: replay fires **without user action**; the log shows **exactly
  one `POST /transactions` per queued item, each `201`**, in **enqueue order**
  (12.50 before 3.00) — no duplicates, no interleaving, no retry storm; followed
  by the invalidation traffic (`GET /transactions...` list + `GET
  /transactions/summary` for the **affected month only** — other cached months
  must NOT refetch). On screen: the Pending section disappears, the same rows
  now appear as normal server rows in their day groups, the summary totals
  **increase by exactly 15.50**, and the "N pending" note is gone. Banner clears.
  No duplicate row anywhere. Metro clean.
- **Status**: ⏸ pending

### TC-9: Wire-level idempotency — interrupted first attempt replays as 200, ONE row
- **Verifies**: D3 (client_id on EVERY create, Q5); D2 enqueue-on-network-failure
  arm; grooming-review §2 (replay hit ⇒ **200**, zero side effects); the plan
  Risk "duplicate transactions if B-1's idempotency is imperfect". Deliberate-
  failure TC — the ambiguity is the point.
- **Precondition**: online, outbox empty, uvicorn log cleared. B-1 migration at
  head (verify first).
- **Steps**:
  1. Open the create form with a distinctive amount (`77.77`, "Food").
  2. Submit and **kill the API within the same instant** (best-effort race: have
     `Ctrl-C` ready, or use a tighter variant — start the request against a
     `mitmproxy`/`socat` shim you can sever mid-flight). Record which variant was
     used and whether the server actually received the first POST (the log tells
     you).
  3. Restart the API; let replay fire (or tap "Sync now").
  4. Read the log; then pull-to-refresh and inspect the list.
- **Expected** — two legitimate outcomes, both PASS, both must be distinguished
  in the report:
  - **First POST never arrived** (no log line): replay sends it once, `201`,
    one row.
  - **First POST arrived and committed** but the response was lost: replay sends
    the **same `client_id`** and the log shows the second `POST /transactions →
    **200**` (not 201, not 409, not a second insert). **Exactly one `77.77` row**
    exists in the list after refresh and the summary counts it **once**.
  Either way: no duplicate financial row, no silent loss, no red screen. If two
  `77.77` rows appear, that is a **release blocker** — capture the log and stop.
- **Status**: ⏸ pending

### TC-10: Parked flow — category archived server-side while the item is queued
- **Verifies**: D5.1 (422 `CATEGORY_ARCHIVED` ⇒ PARK, never silent category
  stripping); D2 park-and-CONTINUE (a parked item must not dam the queue); O7
  (app-owned copy via `parkedCopy.ts`); M-4 §422 handling (replay arm parks;
  only the direct arm shows inline field errors). Deliberate-failure TC.
- **Precondition**: online; outbox empty; the "Doomed" category ACTIVE.
- **Steps**:
  1. Go **OFF-C**. Create tx **A** = `9.99` / "Doomed", then tx **B** = `5.55` /
     "Groceries" (B after A, so FIFO puts the doomed one first).
  2. Bring the API back up **while the device is still offline** (Wi-Fi off), and
     archive "Doomed" from the **web app or curl** as `qa-off-main` (a
     server-side change the phone cannot see).
  3. Wi-Fi on. Let replay run. Screenshot the banner and the list.
  4. Tap the banner → the pending screen. Screenshot each card.
- **Expected**: A comes back **422** and is **PARKED** with code
  `CATEGORY_ARCHIVED`; **B is still sent and succeeds in the same run** (the log
  shows a POST for B after A's 422 — the queue is not dammed) and B's row lands
  in the list. The banner switches to "1 transaction failed to sync" and links to
  `/pending`. The card shows amount + category + date + **human copy** ("That
  category was archived. Discard this one and re-add it online.") — not a raw
  code, not "undefined", not raw JSON — with **Retry** and **Discard** both
  visible and ≥44pt. Nothing was auto-dismissed; A's category was **not**
  silently blanked to Uncategorized; A never appears as a booked row.
- **Status**: ⏸ pending

### TC-11: Pending screen — Retry and Discard, including the confirmed destructive path
- **Verifies**: D2 parked-item affordances (Retry resets to queued + zeroes
  attempts; Discard is confirmed and permanent); M-5 pending screen states;
  `components/confirm.ts` reuse; O7 retryability. Deliberate-failure TC.
- **Precondition**: TC-10's parked item A present, online.
- **Steps**:
  1. On the pending screen tap **Retry** on A (category still archived). Watch
     the log and the card.
  2. Un-archive "Doomed" server-side (web/curl); tap **Retry** again.
  3. Create + park a second item (repeat TC-10 briefly), then tap **Discard**;
     read the confirm dialog; **Cancel** first, verify the item survives; then
     Discard and confirm.
  4. Kill and relaunch the app; reopen the pending screen.
  5. Drain everything; view the empty pending screen.
- **Expected**: Retry against a still-archived category re-sends **once** (one
  log line, 422) and the item returns to parked with the same copy — no loop, no
  crash, still retryable. After un-archiving, Retry **succeeds** (201) and the
  row moves into the transactions list. Discard shows the confirm ("This
  transaction was never saved. Discard it? This can't be undone."); Cancel keeps
  the item; confirming removes it permanently — and it **does not come back after
  a kill/relaunch** (proving the persisted value was updated, not just memory).
  Empty state reads "Nothing failed to sync." No loading/error states appear
  (local state).
- **Status**: ⏸ pending

### TC-12: Offline-disabled write affordances — visibly disabled, not hidden
- **Verifies**: D2 (create-tx is the ONLY offline-capable mutation); D6 disabled
  affordances; M-5 §Offline-disabled writes.
- **Precondition**: month + categories cached; **OFF-C**.
- **Steps**:
  1. Offline, tap an existing server transaction row → the edit form opens.
     Screenshot.
  2. Try Save and Delete.
  3. Back out; Categories tab: try "Add category"; open an existing category and
     try Save / Archive. Screenshot.
  4. Confirm **create** transaction is still enabled (contrast — this is what
     makes the TC non-vacuous).
  5. Restore connectivity and confirm all of them re-enable without a relaunch.
- **Expected**: rows remain **pressable** (viewing is fine); Save/Delete/Archive
  and "Add category" are **visibly disabled** (disabled token styling, not
  hidden, not silently no-op) with the notice "Offline — editing needs a
  connection."; tapping them does nothing and logs nothing. Create-transaction
  stays enabled and queues (TC-5). Everything re-enables reactively when
  connectivity returns.
- **Status**: ⏸ pending

### TC-13: Logout with pending items ⇒ confirm ⇒ purge of cache + outbox + marker
- **Verifies**: D1 purge-on-logout; D6/Q3 confirm-then-discard; M-5
  `LogoutButton`; M-2 `decideOfflineAction('logout') ⇒ purge`.
- **Precondition**: online API available; **two queued or parked items present**
  (create them via OFF-C, then come back online only after killing the API so
  they stay queued — OFF-A is the convenient method).
- **Steps**:
  1. Tap Log out with pending items present. Screenshot the dialog.
  2. **Cancel** — verify the session and the queue survive.
  3. Tap Log out again and confirm.
  4. Log back in as the **same** user `qa-off-main`, immediately screenshot
     before any refetch lands.
  5. Separately: drain the queue, then log out with **zero** pending items.
- **Expected**: with pending > 0 a confirm appears naming the count ("2 unsynced
  transaction(s) will be discarded."); Cancel is a true no-op; confirming logs
  out and **purges** the persisted cache, the outbox and the owner marker. After
  re-login there is **no** Pending section, **no** parked items, and no
  pre-populated list before the fetch resolves (the first paint may show
  skeletons — correct). With zero pending, logout is **one tap, no dialog**
  (unchanged 1.8 behaviour).
- **Status**: ⏸ pending

### TC-14: Session expiry KEEPS the queue and cache; re-login as the same user resumes replay
- **Verifies**: D1 (`session-expired ⇒ keep` — the row whose regression silently
  eats a user's queue); D2 401 ⇒ HALT with the queue intact; D5.4; M-2's
  `useAuthListener` semantics change (open question 4, ratified).
- **Precondition**: queued items present; a way to force terminal expiry — the
  1.8-sanctioned method (revoke/expire the refresh token server-side or delete
  the stored refresh token) — record which was used.
- **Steps**:
  1. With ≥2 items queued, force the session to expire, then trigger a replay
     (foreground the app / tap "Sync now"). Watch the log.
  2. Observe the redirect to login (`reason=expired`, O3/O5/O6).
  3. Kill and relaunch the app while logged out; screenshot the login screen.
  4. Log back in as the **same** user; watch the log and the screen.
- **Expected**: on 401 the replay **HALTS** — the log shows at most one failed
  POST plus the coordinator's single refresh attempt, and **no further POSTs**;
  the queue is **not** purged and **not** drained. After the expiry redirect the
  items still exist (a kill/relaunch proves persistence). On re-login as the same
  user the owner-marker check yields KEEP and replay resumes automatically:
  each item posts exactly once, rows appear, summary updates. **No queued
  transaction is lost anywhere in this journey.**
- **Status**: ⏸ pending

### TC-15: Login as a DIFFERENT user purges cache + outbox (no cross-user leak, no cross-user replay)
- **Verifies**: D1 different-user purge via the `ownerUserId` marker; D5.4 ("a
  queued tx must never be created under another account"); M-2
  `decideOfflineAction('me-loaded', mismatch) ⇒ purge`.
- **Precondition**: logged in as `qa-off-main` with cached data AND ≥1 queued
  item; `qa-off-second` seeded with visibly different transactions.
- **Steps**:
  1. Reach the expiry state of TC-14 (so nothing purged at logout) — or, if
     forcing expiry is impractical, log out and note that the logout purge
     already fired (the TC is then weaker; say so).
  2. Log in as `qa-off-second`.
  3. Screenshot immediately after login lands, and again after the fetch settles.
  4. Watch the uvicorn log for the whole window.
  5. Check `qa-off-main`'s data afterwards (log back in) for a stray row.
- **Expected**: after `/users/me` resolves, `qa-off-second` sees **only their
  own** transactions/summary/categories — no row belonging to `qa-off-main`
  survives on screen — and the Pending section is **empty**: the previous user's
  queued item is **never POSTed** under this session (the log must show no POST
  of `qa-off-main`'s amount). `qa-off-main`'s account is unchanged.
  **Known accepted window** (plan M-2): between login and `/users/me` resolving,
  the previous user's cached lists may flash for up to one round trip. If the
  step-3 immediate screenshot catches it, record it as the **documented,
  accepted** behaviour and cross-reference TC-M8 — not as a new defect.
- **Status**: ⏸ pending

### TC-16: Cold install + offline ⇒ DEGRADED create notice (expected, NOT a bug)
- **Verifies**: M-4 §Currency prerequisite ("offline create is unreachable until
  the month summary has loaded once", making M-2 a functional prerequisite of
  M-4) and the matching Risk; W4/W7 (the form needs the account currency for
  minor-unit scaling and never collects a currency from the user).
- **Precondition**: **delete the app from the simulator** (`xcrun simctl
  uninstall booted <bundleId>` or long-press → Remove App) and reinstall — a
  genuine cold install with no persisted cache. `qa-off-fresh` has server-side
  transactions.
- **Steps**:
  1. Fresh install; log in as `qa-off-fresh` **online**; then immediately, before
     the month summary loads, go **OFF-C**. (If it always beats you, log in
     online, kill the app, delete it, reinstall, and attempt an offline login —
     record which variant produced the state.)
  2. Attempt to open the create form and submit.
  3. Screenshot the form. Screenshot Metro.
  4. Restore connectivity, let the summary load once, kill the app, go OFF-C
     again, relaunch, and create.
- **Expected** — **the pass condition is the honest degraded notice, not a
  crash**: the create submit is **disabled** with the existing degraded notice
  reworded to something like "Can't create while offline until this month has
  loaded once." No red screen, no NaN amount, no zero-currency render, no
  attempt to guess a currency, no silent enqueue of an un-scaled amount. After
  the summary has been cached once (step 4), offline create works normally
  (TC-5). **Testers will read step 2 as a bug — it is designed behaviour;
  record it as PASS with the screenshot and the plan citation.**
- **Status**: ⏸ pending

### TC-17: Trigger union on the simulator — and no request storm
- **Verifies**: D4 trigger union (app start after hydration, online EDGE
  transition, AppState foreground resume via the O5 seam, successful direct
  create, enqueue-while-online kick, manual "Sync now"); M-3 EDGE-only rule
  ("the branch that turns every netinfo tick into a request storm"); O3
  single-flight.
- **Precondition**: one queued item present per sub-step; uvicorn log cleared
  before each; the API reachable.
- **Steps**:
  1. **App start**: queue an item via OFF-A, kill the app, restart the API, then
     relaunch. Count POSTs.
  2. **Foreground resume**: queue an item, press the simulator Home
     (`Device ▸ Home`), wait 5s, reopen. Count POSTs.
  3. **Online edge**: queue an item under OFF-C, then restore Wi-Fi. Count POSTs.
  4. **Enqueue-while-online kick**: with the API up, force a direct-send failure
     (OFF-A momentarily) so an item enqueues, restore the API, then create a
     second transaction — the enqueue itself should kick the replay.
  5. **Manual**: tap "Sync now" twice in rapid succession.
  6. **Storm check**: leave the app idle and online with an empty queue for
     60s; count requests.
- **Expected**: each trigger causes the queue to drain with **exactly one POST
  per item**; a double "Sync now" produces **no second POST for the same item**
  (single-flight); the idle window produces **no repeated POSTs** and no
  periodic polling of `/transactions` beyond normal focus/stale refetches. Any
  repeated identical POST for the same `client_id` in a short window is a FAIL
  (even though the server would dedupe it — burning battery on a storm is the
  defect).
- **Status**: ⏸ pending

### TC-18: 250-transaction month — persisted, hydrated offline, scrolled
- **Verifies**: M-2's "persisted-cache size behaviour for a 200-row month";
  AM-1.6-a (offset stays the pageParam, persisted key shape untouched); the
  mandatory lists-at-scale category; plan §JS-thread cost.
- **Precondition**: `qa-off-main`'s 250-tx month; online.
- **Steps**:
  1. Open that month; **load more until all 250 rows are loaded**; note the
     footer "Showing N of total".
  2. Kill the app; go **OFF-C**; relaunch; open that month.
  3. Scroll top→bottom→top briskly; screenshot mid-scroll and at the bottom.
  4. Offline-create 2 transactions in that month and scroll again.
  5. Note any Metro warning about persisted-value size or a slow kv-store write.
- **Expected**: offline relaunch renders the previously loaded pages from the
  persisted cache (partial hydration of only page 1 is acceptable **if** the
  footer count is honest and load-more shows the offline error affordance rather
  than a crash — record which happened). Scrolling stays smooth with **no blank
  rows**, no flicker, no duplicate-key warning where pending rows meet server
  rows. The Pending section stays pinned above the 250 rows and does not
  re-order them. No dropped-frames warning storm in Metro; no kv-store
  size/quota error.
- **Status**: ⏸ pending

### TC-19: Navigation — /pending modal deep link, iOS swipe-back, O6 `next` coherence
- **Verifies**: O6 (deep-link-safe modal, no imperative navigation from
  non-React code, `MODAL_PARENT_TAB['/pending'] = '/transactions'`); M-5 pending
  screen registration.
- **Precondition**: a parked item exists; the app installed.
- **Steps**:
  1. From the Transactions tab, tap the parked banner → `/pending`; swipe back
     (iOS gesture) → verify you land on Transactions.
  2. While **logged out**, deep-link to `/pending`
     (`xcrun simctl openurl booted <scheme>://pending`) — verify the auth guard
     catches it and the `next` route returns you to `/pending` after login.
  3. While logged in, deep-link straight to `/pending` from a cold start.
  4. From the Categories tab, reach `/pending` via the banner and dismiss.
- **Expected**: the modal opens with its data (it reads the outbox snapshot; no
  params, no prior-screen state) and never renders blank on a cold deep link;
  swipe-back dismisses to the **transactions** tab, not to a blank stack; the
  logged-out deep link goes to login and returns to `/pending` afterwards
  (`next` preserved, O6); no navigation happens from outside React. Android
  hardware back on this modal is **Section B** (TC-M5).
- **Status**: ⏸ pending

### TC-20: Visual sanity — safe areas, banner overflow, dark/light, screenshots
- **Verifies**: mandatory visual category; plan §Platform concerns (banner
  single-line + `numberOfLines={1}`, banner inside the existing safe-area
  container, never over the notch); D6 "disabled means visibly disabled".
- **Precondition**: run on a **notched** device profile (e.g. iPhone 15/16 Pro)
  and, if a second runtime exists, a small one (SE) — record which.
- **Steps**:
  1. Screenshot every new surface with the banner visible: Transactions,
     Categories, transaction form (create + edit-disabled), category form,
     pending screen (populated + empty).
  2. In the simulator's Settings ▸ Accessibility ▸ Display & Text Size, raise
     the text size to the largest non-accessibility step and re-screenshot the
     banner in its **longest** variant ("Offline — N transaction(s) will sync
     later" with N ≥ 10).
  3. If the app supports dark mode, repeat the key screens in dark mode.
- **Expected**: no text clipped or overlapping the notch/home indicator; banner
  truncates with an ellipsis rather than wrapping into the toolbar or pushing
  the list; the Pending badge and dimmed styling are legible in both appearances;
  disabled controls are visibly distinct from enabled ones (not merely
  unresponsive); pending rows are visually distinguishable from server rows at a
  glance. Android font scaling and true accessibility sizes are **Section B**
  (TC-M6).
- **Status**: ⏸ pending

### TC-21: Metro / console hygiene across every offline flow
- **Verifies**: cross-cutting; O7 (no unhandled error reaches the user as a
  crash); plan's no-red-screen expectation for every state.
- **Precondition**: all the above executed with the Metro terminal captured.
- **Steps**: re-read the full Metro output for the session; grep the captured
  log for `Warning:`, `key`, `Possible Unhandled Promise Rejection`,
  `Native module`, `SQLite`, `persist`.
- **Expected**: no red screen at any point; no duplicate-key warning where
  pending and server rows coexist; no unhandled promise rejection from a replay
  run or a failed persist write; no `useSyncExternalStore` "getSnapshot should be
  cached" warning (the snapshot-stability contract manifesting); no persister
  restore error; the only errors present are the deliberately provoked, handled
  ones from TCs 2/9/10/11/16.
- **Status**: ⏸ pending

---

## Section B: manual device (run by the USER — mobile-qa NEVER marks these passed)

These need a real radio, a real suspend, real Android, real time, or human
judgment. mobile-qa writes the steps and the expected results; the user
executes and reports. Run against a device build with the API reachable
(`--host 0.0.0.0`, phone on the same Wi-Fi) or post-deploy against the deployed
API. Every item here corresponds to something the plan explicitly listed as
"not verifiable here" or to a named Risk.

### TC-M1: Real airplane-mode journey (radio transitions, not a killed process)
- **Device**: iPhone (physical). Also worth repeating on Android.
- **Verifies**: D4 netinfo against a REAL radio (M-3 "not verifiable here": real
  netinfo transitions); the whole offline journey end to end; the simulator's
  OFF-A/B/C methods are approximations — this is the real thing.
- **Steps**:
  1. Load the current month online; then enable **Airplane Mode** from Control
     Centre.
  2. Confirm the banner appears within a couple of seconds ("Offline — showing
     saved data").
  3. Create two transactions offline; confirm they land in the Pending section.
  4. Lock the phone for a minute, unlock, reopen the app — confirm the queue and
     the banner survived.
  5. Disable Airplane Mode. Do not touch the app. Watch it sync.
- **Expected**: banner appears/clears **promptly** on the real radio transitions
  (no manual pull-to-refresh needed); both items replay automatically, once each;
  rows move from Pending into the list; the summary increases by exactly the two
  amounts; no duplicates; no crash at any point.
- **Status**: ⏸ needs human

### TC-M2: Wi-Fi ↔ cellular flap DURING a replay
- **Device**: iPhone with a working cellular plan (and Android if available).
- **Verifies**: D2 transient ⇒ HALT-and-preserve; D4 trigger union under a
  network change that is neither clean-offline nor clean-online; the risk of a
  half-sent queue.
- **Steps**:
  1. Queue **5** transactions offline (airplane mode), each with a distinct
     amount you note down.
  2. Turn the radio back on and, while the "Syncing N…" banner is visible, walk
     out of Wi-Fi range (or toggle Wi-Fi off so it hands over to cellular).
  3. Let it settle on cellular; observe.
  4. Return to Wi-Fi; observe again.
  5. Afterwards, check the transaction list against your five noted amounts, and
     check the same account from the web app.
- **Expected**: **exactly five** transactions exist server-side — no duplicates
  from the interrupted item (this is D3's idempotency doing its job on a real
  handover) and none lost. Any item interrupted mid-flight either completes or
  returns to the queue and replays; the app never wedges in "Syncing" forever
  with an undrained queue and no affordance ("Sync now" must always be able to
  finish it).
- **Status**: ⏸ needs human

### TC-M3: Background / suspend / task-kill during an active replay (O5)
- **Device**: iPhone (physical) — iOS genuinely suspends; the simulator does not
  faithfully reproduce this.
- **Verifies**: O5 resume seam; D2 durability of the queue across suspension;
  M-3 "iOS background-suspend behaviour"; the mandatory app-lifecycle category.
- **Steps**:
  1. Queue 5 transactions offline; restore connectivity and, the instant syncing
     starts, **swipe up to the home screen**.
  2. Wait 2 minutes; reopen the app.
  3. Repeat, but instead of backgrounding, **kill the app from the app switcher**
     mid-sync; then relaunch.
  4. Repeat once more, killing the app while a single create is in flight
     (submit, then immediately kill).
  5. Verify the final server state from the web app each time.
- **Expected**: after backgrounding, the resume trigger finishes the queue on
  return; after a mid-sync kill, the surviving items are still queued and replay
  on relaunch. **Total server rows equal total submitted rows — no duplicates
  (idempotency) and no losses (durable outbox).** An item killed mid-flight
  either exists once or replays to exist once. No "phantom" pending row that can
  never be drained.
- **Status**: ⏸ needs human

### TC-M4: Captive-portal false-online (hotel/cafe Wi-Fi)
- **Device**: iPhone on a captive-portal Wi-Fi (or a router configured to
  intercept), API reachable only via the real internet.
- **Verifies**: D4's explicitly named netinfo failure mode ("captive portals
  reporting online"), and the rule that **netinfo is a HINT and never a gate** —
  a send must not be blocked, and a wrongly-optimistic banner must not cause
  data loss.
- **Steps**:
  1. Join a captive-portal network **without** signing in to the portal.
  2. Observe the banner (netinfo will likely claim ONLINE).
  3. Create a transaction. Observe what happens.
  4. Sign in to the portal so the connection becomes genuinely usable; observe.
- **Expected**: with a false-online signal, the create is attempted, fails as a
  network error, and is **enqueued** (never lost, never a raw redirect-HTML
  parse error on screen, never a crash — the portal's HTML response must not be
  mistaken for a success). Once the portal is passed, the queued item replays
  and appears exactly once. Worst acceptable outcome: a misleading banner for a
  while; unacceptable: a lost or duplicated transaction, or a stuck spinner.
- **Status**: ⏸ needs human

### TC-M5: Android — hardware back on the pending modal, and reconnect on process resume
- **Device**: Android phone (no Android tooling exists on the dev Mac — probed).
- **Verifies**: plan §Platform concerns (no custom back handler added, so
  Android back must stay default-correct); M-3 "whether Android emits the
  transition on process resume"; O6 modal coherence.
- **Steps**:
  1. With a parked item present, open `/pending` from the banner; press the
     **hardware back** button.
  2. Repeat with the gesture-navigation back swipe.
  3. Queue items offline, background the app long enough for Android to freeze
     the process, restore connectivity, then reopen.
  4. Press back from the transactions tab root and confirm the app behaves as
     before this scope (no new back trap).
- **Expected**: hardware back and gesture back both dismiss the modal to the
  Transactions tab — never exiting the app from the modal, never landing on a
  blank screen. After a frozen-process resume, the queue drains (via the resume
  trigger even if the netinfo transition was missed while frozen) — this is
  precisely why the trigger set is a union.
- **Status**: ⏸ needs human

### TC-M6: Font scale / accessibility text — banner and pending rows
- **Device**: iPhone and Android at their **largest accessibility text sizes**.
- **Verifies**: plan §Platform concerns (banner survives Android's larger default
  font scaling; single line + ellipsis); the plan Risk "banner text overflow at
  large font scales".
- **Steps**:
  1. Set the system text size to the largest accessibility step.
  2. View every banner variant (force ≥10 pending so the count is two digits),
     the Pending section rows, the summary "N pending — not included" line, and a
     parked card with its longest copy.
- **Expected**: nothing clipped, overlapping, or pushed off screen; the banner
  truncates gracefully rather than wrapping over the list; the parked card's
  explanation stays fully readable (it may wrap — cards are allowed to grow);
  Retry/Discard remain reachable and ≥44pt. Report any variant where the count
  or the action becomes unreadable.
- **Status**: ⏸ needs human

### TC-M7: Multi-day offline stretch — 7-day maxAge expiry and the poison cap
- **Device**: any physical device; needs **real calendar time** (or a documented
  system-clock shift, which is itself a device-only manoeuvre).
- **Verifies**: D1/Q4 `maxAge = 7 days`; D2 `MAX_TRANSIENT_ATTEMPTS` (50)
  parking rather than infinite retry; the plan Risk "poison-cap parking during
  long offline stretches"; the scope's raison d'être (multi-day offline
  usability).
- **Steps**:
  1. Load a month online, then keep the device offline (airplane mode) and use
     the app briefly each day for **8 days** — or advance the device clock past
     7 days, noting that the clock shift is the method used.
  2. Each day: confirm cached data still renders, and add one offline
     transaction.
  3. On day 8 (past maxAge), relaunch the app while still offline.
  4. Then reconnect and let everything sync.
- **Expected**: through day 7 the cached month keeps rendering. After maxAge the
  persisted **read cache** is dropped — the lists show empty/error states with a
  retry affordance (acceptable and expected), **but the OUTBOX must NOT be
  dropped**: every offline transaction from all 8 days must still be queued and
  must replay on reconnect. If any item parked from attempt-cap exhaustion, it
  must be visible on the pending screen with Retry — **never silently dropped**.
  Final check from the web app: all 8 transactions exist, exactly once each.
- **Status**: ⏸ needs human

### TC-M8: The different-user cache window (one round trip) after a session expiry
- **Device**: physical device — the window is a timing observation on real
  network latency; a screen recording is the practical evidence.
- **Verifies**: the plan's explicitly documented, accepted M-2 hazard: between an
  interactive login and `/users/me` resolving, a different user may momentarily
  see the previous user's cached lists (bounded by one round trip, reachable only
  after a session ended by EXPIRY, network-required).
- **Steps**:
  1. As user A, load data; let the session end by **expiry** (not logout).
  2. Log in as user B on the same device, **recording the screen**.
  3. Step through the recording frame by frame around the login transition.
  4. Repeat on a deliberately slow connection (throttled/edge network) to widen
     the window.
- **Expected**: any flash of user A's data lasts **at most one `/users/me` round
  trip** and is replaced by user B's data (or empty state) as soon as the marker
  mismatch purge fires. Nothing of user A's persists after that; user B never
  sees a Pending item belonging to A; nothing of A's is ever POSTed under B.
  **If A's data survives past `/users/me` resolving, that is a defect — report
  it.** A brief flash is the documented accepted behaviour, recorded here so the
  user knows it is known, not new.
- **Status**: ⏸ needs human

### TC-M9: kv-store durability on real hardware — cold start and device reboot
- **Device**: physical device (the device arm of TC-4; simulator storage is not
  proof for real iOS sandboxes/low-storage behaviour).
- **Verifies**: D1 storage medium; the plan's highest-consequence unverified
  risk; O2 (secure-store tokens survive too — the offline cache must not have
  disturbed them).
- **Steps**:
  1. Load data + queue two items; **fully power-cycle the phone** (not just an
     app kill).
  2. Reopen the app offline. Check: still logged in? cached lists present? queue
     present?
  3. Reconnect and sync; verify from the web app.
  4. Optional but valuable: repeat with the device near-full on storage.
- **Expected**: still logged in (secure-store, O2), cached month renders, both
  queued items still pending and then replay exactly once each. If the queue or
  cache is empty after a reboot, the recorded posture is **"fix before release"**
  (senior-lead carry-forward) — report immediately, do not ship around it.
- **Status**: ⏸ needs human

### TC-M10: Haptics and feel on the queued-submit path
- **Device**: physical device (the simulator has no haptics).
- **Verifies**: M-4 §Create-form UX (`Haptics.notificationAsync(Success)` on the
  queued outcome) and `components/confirm.ts` haptics on the Discard confirm;
  the "does it feel like a failure?" judgment that only a human can make.
- **Steps**:
  1. Offline, submit a transaction; note the haptic and the dismissal timing.
  2. Online, submit one; compare the two — do they feel meaningfully different?
  3. Discard a parked item and note the confirm haptic.
- **Expected**: the queued submit gives a success haptic and dismisses without
  lag, yet the user is **not misled into thinking it was saved to the server** —
  the Pending row and banner are what tell the truth. Human verdict required:
  "would I know my transaction is not synced yet?" If the answer is no, that is a
  UX finding worth reporting even though nothing is technically broken.
- **Status**: ⏸ needs human

### TC-M11: Low-end / older device — hydration cost of a heavy month
- **Device**: the oldest/slowest phone available (device arm of TC-18).
- **Verifies**: plan §JS-thread cost; M-2's persisted-cache size concern on real
  hardware; the mandatory low-end-performance category.
- **Steps**:
  1. With the 250-transaction month cached, cold-start the app offline and time
     from tap to rendered list.
  2. Scroll the full list; add two offline transactions; scroll again.
- **Expected**: cold start remains usable (no multi-second white screen, no ANR
  on Android, no watchdog termination); scrolling is not visibly janky; the
  Pending section does not cause the list to re-layout the whole month on every
  keystroke/insert. Report timings, not just a verdict.
- **Status**: ⏸ needs human

---

## Obligation coverage map (every named "not verifiable here" item and Risk has a TC)

| Source | Item | TC |
|---|---|---|
| M-2 "not verifiable here" | kv-store durability across a real process restart | TC-4 (sim), TC-M9 (device) |
| M-2 "not verifiable here" | Expo Go boot with expo-sqlite linked | TC-1 |
| M-2 "not verifiable here" | restore precedes first paint | TC-3 |
| M-2 "not verifiable here" | persisted-cache size for a 200-row month | TC-18, TC-M11 |
| M-3 "not verifiable here" | real netinfo transitions (airplane, Wi-Fi↔cellular, captive portal) | TC-2 (approximation), TC-M1, TC-M2, TC-M4 |
| M-3 "not verifiable here" | Android transition on process resume | TC-M5 |
| M-3 "not verifiable here" | iOS background-suspend behaviour | TC-M3 |
| Risk | nothing device-verified / three native modules | TC-1 |
| Risk | duplicate transactions if B-1 idempotency is imperfect | TC-9, TC-M2, TC-M3 |
| Risk | offline create unreachable on a cold install (currency) | TC-16 |
| Risk | poison-cap parking during long offline stretches | TC-M7, TC-11 |
| Risk | different-user cache window | TC-15, TC-M8 |
| Risk | PersistQueryClientProvider vs splash gate | TC-3 |
| Risk | Android back / iOS swipe-back on the new modal | TC-19 (iOS), TC-M5 (Android) |
| Risk | banner text overflow at large font scales | TC-20 (sim), TC-M6 (device) |
| D1 | allowlist / buster / maxAge 7d / purge policy | TC-3, TC-4, TC-13, TC-14, TC-15, TC-M7 |
| D2 | create-only offline; FIFO; park-and-continue; halt-on-transient; 401 halt | TC-5, TC-8, TC-10, TC-12, TC-14 |
| D3 | client_id on every create; 200 replay hit; no duplicates | TC-9, TC-M2, TC-M3 |
| D4 | netinfo as a hint; trigger union; EDGE-only; no storm | TC-2, TC-17, TC-M4, TC-M5 |
| D5 | conflict cases 1–5 | 1: TC-10 · 2: TC-9 · 3: TC-5/TC-8 · 4: TC-14/TC-15 · 5: TC-3/TC-4 |
| D6 | banner (5 variants), pending rows from outbox state, summary note, parked screen, disabled writes, logout confirm | TC-5, TC-6, TC-7, TC-10, TC-11, TC-12, TC-13 |
| D7 | module placement / native confinement / dep list | TC-1 (grep gate) |
| O2/O3/O5/O6/O7 | tokens survive, single-flight, resume seam, deep-link-safe modal, visible retryable errors | TC-4, TC-17, TC-19, TC-11, TC-M3, TC-M9 |
| W3/W4/W7/W8 | archived-inclusive join, minor-unit money, no currency collected, invalidation identity | TC-5, TC-8 |
| AM-1.6-a/b | offset pageParam + persisted key shape; single categories cache | TC-18, TC-5 |

---

## Summary (grooming — pre-implementation; to be superseded by a RUN SUMMARY at /test)

### Section A: simulator — 22 TCs (TC-0 … TC-21)
- Total: 22 · Passed: 0 · Failed: 0 · **Pending: 22**
- **CONDITIONAL**: the first act of the run is `xcrun simctl list runtimes`.
  Runtime present ⇒ all 22 run for real. Runtime still absent ⇒ all 22 are
  recorded `⏸ blocked (no iOS runtime — simctl runtimes empty)` with the command
  output pasted, and the run summary must state plainly that the offline feature
  shipped **device-unverified**, backed only by the vitest suites and the senior
  diff gate.
- Highest-value first if time is short: **TC-1** (does it boot with three new
  native modules at all), **TC-4** (kv-store durability — the hollow-feature
  risk), **TC-9** (wire idempotency — the duplicate-money risk), **TC-8**
  (replay + W8 refetch), **TC-10** (park path). Everything else is refinement on
  top of these five.

### Section B: manual device — 11 items (TC-M1 … TC-M11) awaiting human verification
TC-M1 airplane-mode journey · TC-M2 Wi-Fi↔cellular flap during replay ·
TC-M3 background/suspend/kill during replay · TC-M4 captive-portal false-online ·
TC-M5 Android back on the pending modal + frozen-process resume ·
TC-M6 accessibility font scales · TC-M7 multi-day offline + 7d maxAge + poison
cap · TC-M8 different-user cache window · TC-M9 kv-store durability across a
device reboot · TC-M10 haptics/feel on the queued submit · TC-M11 low-end device
hydration cost.

**mobile-qa never marks a Section B item passed.** They are not release blockers
by default — senior-lead decides — but **TC-M3, TC-M7 and TC-M9 concern data
loss or duplication of financial rows** and are the three this checklist
recommends treating as pre-release gates.

### Verdict rule for the run
Any Section A failure ⇒ **❌ FAIL OVERALL**, senior-lead handles (mobile-qa does
not fix code). All Section A passed ⇒ **✅ READY FOR REVIEW**, with the 11
Section B items flagged pending human verification and the 44 inherited 1.8
on-device TCs (`.tasks/mobile-mvp/qa-mobile-checklist.md`) still open.
