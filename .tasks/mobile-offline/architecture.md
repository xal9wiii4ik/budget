# Architecture Plan: mobile-offline (roadmap 5.5)

Grooming only. Grounded in files read at HEAD: `.tasks/mobile-offline/task.md`
(binding PM brief), `.tasks/mobile-mvp/architecture.md` (Q5 edge rules),
`.tasks/mobile-mvp/obligations.md` (O1–O7, AM-*, W-*, S-*),
`apps/mobile/src/lib/{queryClient,api}.ts`, `apps/mobile/src/data/{queryKeys,
transactions,categories}.ts`, `apps/mobile/src/auth/coordinator.ts`,
`apps/mobile/package.json`, `apps/api/src/budget_api/routers/transactions.py`,
`apps/api/src/budget_api/schemas/transaction.py`,
`apps/api/src/budget_api/models/transaction.py`, `apps/api/alembic/versions/`,
`budget-app-architecture.md` §6.

## Context

The 1.8 MVP mobile surface (tx list/create, categories, month summary) must
survive offline: reads render from a persisted cache, transaction creates queue
and replay on reconnect, with idempotency so a replay after an ambiguous network
failure never duplicates a row. Binding constraint: verification is DEGRADED (no
simulator, no device) — every decision below is biased toward (1) the smallest
native-dependency footprint that works, (2) pure DI-seamed logic testable under
plain vitest (the `auth/coordinator.ts` precedent: platform seams injected via
interfaces, prod adapters in leaf files tests never import), and (3) conservative
conflict policy — server wins, no destructive merges, nothing silently dropped.

The backend IS fully verifiable (pytest + curl), so correctness-critical
invariants are pushed to the server arm wherever possible (Decision 3).

---

## Decision 1 — Read-side persistence

**VERDICT: TanStack Query persister (`@tanstack/react-query-persist-client` +
`@tanstack/query-async-storage-persister`, both pure JS) over
`expo-sqlite/kv-store` as the storage medium. One new native module
(`expo-sqlite`), zero hand-rolled cache code. This overrules
`budget-app-architecture.md` §6's "локальный SQLite (expo-sqlite) с очередью
синхронизации" only in its *mirror* reading: we keep expo-sqlite as the physical
medium but reject a hand-rolled SQL mirror as unjustified complexity for three
read screens.**

Alternatives rejected:

- **Hand-rolled expo-sqlite mirror** (tables mirroring transactions/categories/
  summaries + sync bookkeeping). Rejected: it re-implements what the TanStack
  cache already is — the app's read model *is* the query cache
  (`data/transactions.ts`, `data/categories.ts` render exclusively from it).
  A mirror means a second source of truth, join logic, schema migrations on the
  device, and a large untestable-on-device surface. Maximum code volume for the
  same observable behavior as "rehydrate the cache you already had".
- **Hand-rolled snapshot cache** (serialize selected query data ourselves).
  Rejected: this is a worse re-implementation of exactly what
  `persistQueryClient` does (dehydrate/hydrate, maxAge, busting), with none of
  its edge handling. Only defensible if the persister forced an unacceptable
  dep — it doesn't (the two persister packages are pure JS; only the storage
  medium is native).
- **`@react-native-async-storage/async-storage` as the medium.** Honestly
  viable — it is the canonical persister medium and works in Expo Go. Rejected
  on footprint grounds: `expo-sqlite/kv-store` exposes the same
  `getItem/setItem/removeItem` AsyncStorage-compatible interface (it is
  documented as a drop-in replacement), so one native module can serve BOTH the
  read-cache persister and the outbox (Decision 2). Choosing AsyncStorage would
  either add a second medium or put the outbox in AsyncStorage anyway — same
  count, but expo-sqlite is an `expo-*` module version-locked to SDK 57 via
  `npx expo install`, the exact risk class as the already-proven
  `expo-secure-store` (O2), which matters when nothing can be smoke-tested on
  device.
- **`expo-secure-store` as the medium.** Rejected: value-size limits (~2KB
  warning threshold) make it unusable for a month of transactions; O2 also
  reserves it for tokens.

Design points (binding on the implementer):

- **What persists:** `shouldDehydrateQuery` allowlist — only the three MVP
  families: `qk.categories()`, `qk.txList(...)`, `qk.txSummary(...)`
  (`key[0] === 'categories' || key[0] === 'transactions'`), and only successful
  queries. `/users/me` and anything auth-adjacent never persists. Mutations
  never persist (we have our own outbox; TanStack mutation persistence is
  explicitly NOT used — Decision 2).
- **Busting/versioning:** `buster = `${CACHE_SCHEMA_VERSION}`` where
  `CACHE_SCHEMA_VERSION` is a hand-bumped constant in
  `apps/mobile/src/offline/persist.ts` with a comment obliging a bump whenever
  `data/queryKeys.ts` shapes or the rendered read models change (api-client
  regen with field changes counts). A mismatched buster drops the cache — the
  safe failure mode.
- **maxAge: 7 days** (see Open Question Q4). Older than the TanStack default
  24h because the whole point of this scope is usability during multi-day
  offline stretches; 7 days is still short enough that stale financial data
  self-evicts. Every screen already treats cached data as stale-refetchable
  (staleTime 30s in `lib/queryClient.ts`) — hydrated data triggers a refetch
  when online, so server wins the moment connectivity exists.
- **Purge policy (financial data must not outlive the account on the device):**
  - Intentional `logout()` → purge persisted cache + `queryClient.clear()` +
    purge outbox (with the Decision 6 pending-items confirm).
  - Login as a DIFFERENT user → purge cache + outbox before hydrating queries.
    Mechanism: an `ownerUserId` marker key stored beside the cache, written from
    the first successful `/users/me` after login; mismatch ⇒ purge. (The
    coordinator does not know user ids — `useMe` does; the marker lives in the
    offline module, not in the coordinator.)
  - Terminal session EXPIRY (coordinator's `sessionExpired` path) → KEEP cache
    and outbox. Tokens are gone, the guard locks the UI behind login; purging
    here would destroy a user's queued offline transactions on a transient
    refresh failure. On re-login the `ownerUserId` check decides keep-vs-purge.
- **Vitest-ability:** the allowlist predicate, buster derivation, and the
  purge-decision function (`(event, ownerUserId, loginUserId) → keep|purge`) are
  pure exports in `offline/persist.ts` with no native import; the only file
  importing `expo-sqlite/kv-store` is the thin `offline/storage.ts` adapter
  (pattern: `auth/secureStore.ts`).

## Decision 2 — Write queue (outbox)

**VERDICT: exactly ONE mutation is offline-capable: transaction create. All
others — tx edit, tx delete, category create/update/archive — remain
online-only, with the affordance disabled while offline plus a notice ("Offline —
editing needs a connection"). The outbox is a pure DI-seamed core in
`apps/mobile/src/offline/outbox.ts`, mirroring the coordinator's testability
pattern.**

Why the conservative split (argued, not assumed):

- **Create-tx** is the real mobile offline use case (log an expense on the
  metro), is the PM minimum, and is the only write that idempotency-by-client-id
  makes replay-safe end-to-end (Decision 3). A queued create references nothing
  that must still be in a particular state except its category — one enumerable
  conflict (Decision 5).
- **Tx edit/delete offline** would replay PATCH/DELETE against rows that may
  have been edited/deleted from another device meanwhile: PATCH is
  last-write-wins per field with no version token on the contract
  (`routers/transactions.py` has no If-Match/updated_at guard), so offline edits
  are exactly the destructive-merge territory the PM constraint forbids.
  DELETE replay on 404 is benign, but shipping delete-only edit support is
  incoherent UX. Online-only.
- **Category CRUD offline** hits W9's server-authoritative 409 name-conflict
  (no client dedup pre-gate) and archive interacts with the queued-create
  conflict below; categories change rarely and are not the offline use case.
  Online-only.

Outbox core design (binding shape, exact code left to the engineer):

```ts
// offline/outbox.ts — imports NOTHING platform-specific.
type OutboxItem = {
  clientId: string;              // uuid, generated at enqueue (Decision 3)
  body: TransactionCreate;       // already schema-valid form output, W1/W4 conventions
  enqueuedAt: string;            // ISO, from injected clock; informational only
  status: 'queued' | 'parked';
  transientAttempts: number;
  lastError: { kind: 'network' | 'server' | 'rejected'; status?: number; code?: string } | null;
};
type OutboxState = { items: OutboxItem[] };  // FIFO, index 0 = oldest

interface OutboxDeps {
  storage: KV;                    // { getItem/setItem/removeItem } — kv-store adapter or in-memory fake
  send: (item: OutboxItem) => Promise<SendResult>;  // prod: POST /transactions via apiClient
  clock: () => number;
  newId: () => string;            // prod: expo-crypto randomUUID; tests: counter
}
```

- **Hydration:** load-once from a single JSON key (`outbox:v1`) into an
  in-memory mirror behind the existing splash gate; sync reads, async persisted
  writes — the O2 pattern verbatim. `subscribe/getSnapshot` for
  `useSyncExternalStore` (O3/O6 precedent).
- **Enqueue policy:** every create carries a `clientId` from the moment of form
  submit. If online AND the queue is empty → direct send (existing
  `useCreateTransaction` path, unchanged UX: inline 422 errors, invalidation per
  W8). If offline (Decision 4 signal) OR the queue is non-empty (FIFO
  preservation — a new create must not jump an older queued one) → enqueue. If a
  direct send fails with a NETWORK error (ambiguous: sent-or-not unknown) →
  enqueue the same `clientId` for replay; idempotency makes this safe
  (Decision 3).
- **Replay engine:** single-flight (an `inFlight` promise, the coordinator's
  exact concurrency pattern — one replay run at a time), strictly FIFO,
  sequential, one item per request. Per item:
  - Success (200/201) → dequeue, then run the SAME invalidation as
    `useCreateTransaction.onSuccess` (list predicate + affected month summary,
    W8).
  - **Deterministic rejection (4xx except 401)** — e.g. 422
    `CATEGORY_ARCHIVED` — retrying can never succeed → mark `parked`
    immediately with the code, CONTINUE with the next item (a parked item must
    not dam the queue; ordering of *successful* creates is preserved because
    parked items are out of the success stream by definition, and creates are
    independent rows).
  - **Transient failure (network error, 5xx, timeout)** → increment
    `transientAttempts`, HALT the whole run (if the network is down for item N
    it is down for N+1; halting preserves FIFO and burns no battery). No timer
    loop, no exponential backoff machinery: replay is TRIGGER-driven
    (Decision 4), which is the backoff. Poison guard: `transientAttempts >=
    MAX_TRANSIENT_ATTEMPTS` (suggest 30) → `parked` with the last error —
    never an infinite retry, never a silent drop.
  - **401 after the coordinator's own refresh-retry** → session is gone: HALT,
    keep the queue intact (`paused` is representable as: queue non-empty +
    `hasToken() === false`). Resume after re-login passes the `ownerUserId`
    check (Decision 1).
- **Parked items:** surfaced in UI (Decision 6) with manual **Retry** (resets
  `parked` → `queued`, zeroes `transientAttempts`) and **Discard** (confirmed
  destructive removal). Never auto-deleted.
- **Editing a queued item:** out of scope; Discard + re-create is the
  workaround (Open Question Q2).
- **NOT TanStack's `mutationCache` persistence / `resumePausedMutations`:**
  rejected as the queue mechanism — mutation persistence serializes closures'
  variables but the replay semantics (FIFO across app restarts, park states,
  per-item error taxonomy, user-scoped purge) would end up hand-rolled around
  it anyway, inside TanStack internals we cannot vitest cleanly. A 150-line
  pure module with injected seams is strictly more testable, which is the
  binding constraint.

## Decision 3 — Idempotency (the fork, surfaced for PM)

**VERDICT: option (a) — API change. Client-generated UUID `client_id` on
`TransactionCreate`, per-user partial unique index, replay returns the existing
row. Additive + optional, web untouched. This is a contract change ⇒ backend
subtask + api-client regeneration ⇒ `plan.md` exists and the subtask is FULL
tier. Recommended precisely because the backend is the arm we CAN fully verify
(pytest + curl), while the client-side alternative is unverifiable AND
incorrect.**

Exact server semantics (binding):

- **Schema:** `TransactionCreate.client_id: uuid.UUID | None = None`
  (additive, optional — web sends nothing and is byte-compatible).
  `TransactionRead` gains NO field (client_id is a write-side dedup token, not
  a read-model fact; exposing it invites clients to treat it as an id).
- **Column:** `transactions.client_id UUID NULL`.
- **Index:** partial unique `uq_transactions_user_client
  ON transactions (user_id, client_id) WHERE client_id IS NOT NULL`.
  Per-user scoping: one user's uuid can never collide with or probe another's
  (no cross-user oracle); NULLs (all existing rows, all web rows) are exempt.
- **Migration:** additive Alembic revision (next free number after whatever
  recurring-and-limits lands — do not hardcode; 0005 is current HEAD). Column +
  index only; no backfill.
- **POST path** (`create_transaction`): when `payload.client_id` is not None,
  SELECT the row by `(user_id = me, client_id)` FIRST; on hit, return it
  serialized with **200** and SKIP all side effects (no second row, no
  merchant-map upsert, no snapshot recompute — the stored row is the record of
  what was booked, same principle as the export's stored-snapshot rule). On
  miss, proceed exactly as today with `client_id` stamped on the row; the
  lookup-then-insert race is closed by catching the unique-index
  IntegrityError and re-selecting (or `ON CONFLICT DO NOTHING` + re-select) —
  race-safe under concurrent replays. Fresh insert stays **201**; the route
  declares the additional 200 arm with the same `TransactionRead` model
  (contract-visible, generated client types both).
- **Verification (the point):** pytest end-to-end — same client_id twice ⇒ one
  row, second response 200 with identical body; two users same uuid ⇒ two rows;
  no client_id ⇒ today's behavior byte-identical; replay skips the merchant
  learning upsert; race test via concurrent posts.

Alternative (b) — client-side dedup, no API change — rejected with the honest
assessment the brief asked for: `fetch` cannot distinguish "request never left
the device" from "response lost after the server committed" (the coordinator's
own O4 rebuild work exists because of exactly this opacity). A defensive
no-API-change replay policy therefore has only two arms on ambiguous failure:
(1) don't retry ⇒ the user's transaction is silently lost whenever the request
never arrived — silent drop, forbidden; (2) retry ⇒ duplicate row whenever the
response was lost — for a finance app a duplicated expense corrupts the month
summary the user trusts. Heuristic dedup (fetch the list and match
amount+date+note) is a destructive merge against legitimately identical
transactions (two identical coffees) — forbidden by the conservative policy.
(b) is not a cheaper option; it is a broken one. The only cost of (a) is a FULL
backend subtask — in the one environment where verification is NOT degraded.

## Decision 4 — Reconnect detection

**VERDICT: adopt `@react-native-community/netinfo` wired to TanStack
`onlineManager.setEventListener` — firing exactly the future-task trigger
recorded in `apps/mobile/src/lib/queryClient.ts` ("Wiring
onlineManager.setEventListener to @react-native-community/netinfo is a recorded
FUTURE-TASK trigger"). This makes the existing `refetchOnReconnect: true` live
with no queryClient change, gives the offline banner a single source of truth,
and gives the outbox its primary replay trigger. But netinfo is a HINT, not a
gate: replay triggers are a defensive union, and a send is never *blocked* by
netinfo claiming offline.**

- Replay triggers (any of): onlineManager offline→online transition; AppState
  foreground resume (the O5 seam already exists — `auth/resume.ts`
  `subscribeAppStateResume`, reused via injection); app start after outbox
  hydration; completion of any successful direct mutation; manual "Sync now" /
  per-item Retry. All triggers funnel into the single-flight replay — firing
  several at once is harmless by construction.
- Why not skip the native dep (replay-on-foreground/failure only): honestly
  viable for *replay*, but it leaves the offline BANNER with no source of truth
  except "the last request failed" — a mushy, laggy signal — and leaves
  `refetchOnReconnect` permanently inert, so cached screens would not
  self-refresh on reconnect (pull-to-refresh only). The brief's UX (banner,
  queued indication) needs a live signal. Netinfo is bundled in Expo Go and
  pinned via `npx expo install` — same risk class as our other adds; its known
  failure modes (captive portals reporting online, false offline) are covered
  by the trigger-union and never-gate rules above.
- Native-dep risk ledger for the whole scope (nothing can be smoke-tested on
  device): `expo-sqlite` (Decision 1), `@react-native-community/netinfo`,
  `expo-crypto` (uuid source for `clientId`; prod adapter behind the injected
  `newId` seam). All three ship inside Expo Go and are version-pinned by
  `npx expo install`. All are imported ONLY from thin leaf adapter files;
  every testable behavior lives above the seams.

## Decision 5 — Conflict semantics

Create-only offline writes make the conflict surface small. Enumerated cases
and their SERVER-WINS resolutions (no destructive merges anywhere):

1. **Queued create references a category archived server-side meanwhile** →
   replay gets 422 `CATEGORY_ARCHIVED` (deterministic) → item PARKED with the
   code, surfaced as "Category was archived — discard and re-add online"
   (Retry/Discard; no silent category-stripping — silently converting the user's
   categorized expense to uncategorized would be a destructive merge of intent).
   Categories have NO DELETE (W9), so `CATEGORY_NOT_FOUND` for an own category
   cannot legitimately occur; if it ever does, same parked path.
2. **Duplicate replay after ambiguous failure** → closed by Decision 3
   (client_id); replay N times ⇒ one row, later replays get 200 + the row.
3. **Month summary / list staleness while offline** → not a merge problem by
   construction: queued items are NEVER folded into the server caches
   (Decision 6), the summary renders server numbers plus an honest "N pending —
   not included" note (client-side addition is impossible anyway: currency is
   server-stamped when omitted (W7) and the base snapshot is server-computed
   (D5), so the client literally cannot compute the queued item's contribution).
   On reconnect, refetch replaces everything — server wins.
4. **Session expiry with queued items** → replay halts; queue survives; after
   re-login the `ownerUserId` check gates replay (same user ⇒ resume; different
   user ⇒ purge, never cross-user replay — a queued tx must never be created
   under another account).
5. **Persisted cache vs server** → never merged: hydration seeds the cache,
   any refetch overwrites wholesale (TanStack semantics), buster/maxAge drop
   stale shapes. No client-side reconciliation exists to get wrong.

## Decision 6 — UI affordances (design only)

- **Offline banner:** one component, source of truth = `onlineManager`
  subscription (Decision 4) + outbox snapshot (`useSyncExternalStore` over the
  outbox mirror — the O3 reactivity pattern). States: offline ("Offline — new
  transactions will sync later"); online with pending ("Syncing N…"); parked
  items present ("N failed to sync" → links to the parked UI).
- **Tx list:** queued items rendered FROM OUTBOX STATE, merged at render time
  into the day-grouped list (`features/transactions/groupByDay.ts` gains a
  pure merge step) as a visually distinct row type (pending badge/dimmed), NOT
  inserted into the TanStack cache. Optimistic cache insertion is rejected, not
  just deferred: a faked `TransactionRead` cannot be constructed honestly — the
  server stamps `currency` when omitted, computes `base_amount_minor`/
  `base_currency` and `created_at` (`routers/transactions.py` create path), so
  any fake is a lie the summary/W3 join could propagate; and replay-success
  invalidation would race the fake's removal. Rendering from outbox state keeps
  the two sources cleanly separated and is trivially vitest-able as a pure
  merge function.
- **Summary header:** server numbers untouched + "N pending — not included"
  annotation when the outbox is non-empty (case 3 above).
- **Parked-item surfacing:** per-item card (what/when/why — the human-readable
  arm of the stored error code via the app-owned error copy table, O7) with
  Retry and Discard (confirm dialog per the existing `components/confirm.ts`
  pattern). Never auto-dismissed.
- **Offline-disabled writes:** edit/delete tx and category CRUD affordances
  disabled while offline with a short notice (Decision 2). Disabled means
  visibly disabled, not hidden.
- **Logout with pending items:** confirm dialog "N unsynced transactions will
  be discarded" before the Decision 1 purge (Open Question Q3).

## Decision 7 — Module placement, dependency edges, subtasks

**Placement: everything app-owned under `apps/mobile/src/offline/`. NOTHING
promotes to packages** — per the mobile-mvp Q5 rules (cache-shape/app-local →
app-owned) and S5 (no second consumer exists: web has no outbox and no
persistence need; the browser is its own offline story if ever). The Q5 edge
diagram is unchanged. The only package-visible change is the REGENERATED
api-client from Decision 3's contract change (a new scope with backend in
scope — the mobile-mvp S1 freeze applied to that task, not this one).

```
apps/mobile/src/offline/
  outbox.ts        — pure core: state, transitions, replay engine (DI: storage/send/clock/newId)
  persist.ts       — pure: dehydrate allowlist, buster, purge-decision fn; persister wiring
  storage.ts       — LEAF: expo-sqlite/kv-store KV adapter (only file importing it)
  netinfo.ts       — LEAF: netinfo → onlineManager wiring (only file importing netinfo)
  ids.ts           — LEAF: expo-crypto randomUUID adapter behind the newId seam
  useOutbox.ts     — useSyncExternalStore hook over the outbox mirror
```

New dependencies (complete list): native — `expo-sqlite`,
`@react-native-community/netinfo`, `expo-crypto` (all via `npx expo install`,
all bundled in Expo Go); pure JS — `@tanstack/react-query-persist-client`,
`@tanstack/query-async-storage-persister`.

Subtask skeleton (implementation AFTER recurring-and-limits; ordered, each
one-engineer-run sized):

| # | Subtask | Depends on | Tier |
|---|---|---|---|
| B-1 | `client_id` migration + POST idempotency + pytest suite + regenerate api-client | — | **FULL** |
| M-1 | Outbox pure core (state/transitions/replay/park) + vitest suite over fakes | — (parallel with B-1) | **FULL** |
| M-2 | Persistence wiring: kv-store adapter, persister + buster + allowlist, purge-on-logout/owner-check | M-1 | STANDARD |
| M-3 | Connectivity: netinfo→onlineManager, trigger-union wiring (resume/app-start/manual) | M-1 | STANDARD |
| M-4 | Create-tx routing: clientId on every create, offline/queue-non-empty enqueue policy, replay invalidation (W8) | B-1, M-1 | **FULL** (it decides what reaches the wire) |
| M-5 | UI affordances: banner, queued rows merge, summary note, parked UI, disabled-offline writes, logout confirm | M-2, M-3, M-4 | STANDARD |

Per the PM brief this scope emits `plan.md` (backend, B-1) AND `plan-mobile.md`
(M-1…M-5), plus `qa-mobile-checklist.md` with honest Section A
(blocked-environment: everything needing a device/simulator — netinfo behavior,
kv-store persistence across real restarts, Expo Go boot with the three new
native modules) / Section B (manual, post-deploy).

## What this does NOT decide

- Exact TypeScript shapes beyond the binding sketches; file-internal naming.
- `MAX_TRANSIENT_ATTEMPTS` exact value and the parked-copy wording (app-owned
  copy, O7 discipline).
- Whether `groupByDay` merge places queued items by `occurred_at` group or in a
  dedicated "Pending" section — mobile-engineer's UX call within "visually
  distinct, not faked into server data".
- The pytest matrix details for B-1 beyond the enumerated invariants.
- jest-expo vs vitest — settled at 1.8 (plain vitest, S4); this scope adds no
  new runner need because every new module is seam-isolated.

---

## Open questions for PM (either/or, with recommendation)

- **Q1 — Replay-hit status code:** 200-with-existing-row vs always-201.
  **Recommend 200**: it is the honest semantic ("nothing was created"), it is
  contract-visible for tests, and clients treat both as success identically.
- **Q2 — Parked-item editing:** allow editing a parked item (e.g. re-pick the
  archived category) vs Discard-only. **Recommend Discard-only** this scope:
  editing reopens the form-against-queue-state surface for a rare case;
  discard + re-create online covers it.
- **Q3 — Logout with pending items:** confirm-then-discard vs keeping per-user
  queues on the device across logouts. **Recommend confirm-then-discard**:
  per-user retained queues on a shared device retain financial data after an
  explicit "remove me" action; the confirm makes the loss consensual and
  visible.
- **Q4 — Persisted-cache maxAge:** 24h (TanStack default, most conservative)
  vs 7 days. **Recommend 7 days**: the scope exists for multi-day offline
  stretches; staleness is bounded by refetch-on-reconnect and the buster.
- **Q5 — Uniform client_id:** attach `client_id` to ALL creates (online ones
  too) vs only queued/replayed ones. **Recommend all**: one code path, and the
  enqueue-on-network-failure arm (Decision 2) only works if the id existed on
  the FIRST attempt.
