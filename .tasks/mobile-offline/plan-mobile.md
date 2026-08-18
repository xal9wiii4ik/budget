# Implementation Plan (mobile): mobile-offline (roadmap 5.5) — M-1…M-5

Grooming only. Grounded in files read at HEAD: `.tasks/mobile-offline/task.md`,
`.tasks/mobile-offline/architecture.md` (BINDING — Decisions 1–7),
`.tasks/mobile-mvp/obligations.md` (O1–O7, AM-*, W1–W11, S*),
`apps/mobile/src/lib/{queryClient,api,baseUrl}.ts`,
`apps/mobile/src/data/{queryKeys,transactions,categories,errors}.ts`,
`apps/mobile/src/auth/{coordinator,coordinator.test,secureStore,resume,useAuthListener,useMe,useAuth}.ts`,
`apps/mobile/src/features/transactions/{TransactionList,TransactionRow,SummaryHeader,groupByDay}`,
`apps/mobile/src/features/categories/CategoryRow.tsx`,
`apps/mobile/src/components/{confirm,LogoutButton,theme}`,
`apps/mobile/app/**`, `apps/mobile/{package.json,vitest.config.ts}`,
`packages/api-client/src/{errors.ts,auth.ts,index.ts,generated/schema.d.ts}`.

## Approach

The architecture is binding and this plan does not re-litigate it. What this plan
adds is the *shape of the code* under the PM's degraded-verification constraint:
**nothing that can be wrong is allowed to live above a native import.** Every
subtask below is split into (a) a pure core with injected seams — vitest'd under
plain Node, zero `react-native`/`expo` in the module graph — and (b) a thin leaf
adapter or React shell that tests never import. This is the
`auth/coordinator.ts` + `auth/secureStore.ts` + `auth/resume.ts` pattern
verbatim; `src/auth/coordinator.test.ts` is the template for the suites.

Three native modules (`expo-sqlite`, `@react-native-community/netinfo`,
`expo-crypto`) and two pure-JS persister packages arrive in this scope. The
native three are reachable ONLY from `offline/storage.ts`, `offline/netinfo.ts`,
`offline/ids.ts`, plus the composition root `offline/runtime.ts`. Grep discipline
at review: `grep -rn "expo-sqlite\|netinfo\|expo-crypto" apps/mobile/src` must
return exactly those four files.

Conservatism, restated as code rules (the design ships untested on device):
server always wins; the outbox never drops an item silently (park, never delete);
queued rows are NEVER written into the TanStack cache; the persisted cache is
never merged, only replaced; every failure mode is a *visible, retryable* state.
Where a behaviour cannot be verified here (netinfo transitions, kv-store across a
real process restart, Expo Go boot with three new natives), the plan says so and
hands it to `qa-mobile-checklist.md` Section A rather than pretending.

**Scope fence:** mobile stays the 1.8 MVP surface — tx list/create, categories,
month summary. No receipts, currencies, goals, stats, recurring, limits on
mobile. No offline support for anything except transaction CREATE (Decision 2).

## Screens / navigation

- `apps/mobile/app/_layout.tsx` — `QueryClientProvider` → `PersistQueryClientProvider`
  (M-2); splash gate extended to `Promise.all([coordinator.ready, outbox.ready])`;
  `startOfflineRuntime()` started once after the gate (M-3).
- `apps/mobile/app/(app)/_layout.tsx` — register the new `pending` modal screen and
  add `'/pending': '/transactions'` to `MODAL_PARENT_TAB` (the O6 next-param map).
- `apps/mobile/app/(app)/pending.tsx` — **NEW** modal screen: parked-item surfacing
  with Retry / Discard (M-5). Deep-link-safe by construction: it reads the outbox
  snapshot, takes no params, relies on no prior screen state.
- `apps/mobile/app/(app)/(tabs)/transactions.tsx` — renders `<OfflineBanner />`,
  passes pending rows into `TransactionList` and `pendingCount` into
  `SummaryHeader` (M-5).
- `apps/mobile/app/(app)/(tabs)/categories.tsx` — renders `<OfflineBanner />`;
  "Add category" disabled while offline with a notice (M-5).
- `apps/mobile/app/(app)/transaction-form.tsx` — create submit routed through
  `useSubmitCreate` (M-4); edit-mode Save/Delete disabled + notice while offline (M-5).
- `apps/mobile/app/(app)/category-form.tsx` — Save/Archive disabled + notice while
  offline (M-5).

No navigator surgery, no new group, no tab. The banner is rendered per-screen
(see M-5) rather than by wrapping a navigator.

## New components / hooks (full inventory)

| Path | Kind | Imports natives? |
|---|---|---|
| `src/offline/outbox.ts` | pure core: types, transitions, replay engine, error taxonomy | no |
| `src/offline/persist.ts` | pure: allowlist predicate, buster, maxAge, purge decision | no |
| `src/offline/routing.ts` | pure: create-route + direct-failure decisions | no |
| `src/offline/triggers.ts` | pure: trigger-union subscription over injected seams | no |
| `src/offline/parkedCopy.ts` | pure: parked-reason copy table (O7 discipline) | no |
| `src/offline/storage.ts` | LEAF adapter | `expo-sqlite/kv-store` |
| `src/offline/netinfo.ts` | LEAF adapter | `@react-native-community/netinfo` |
| `src/offline/ids.ts` | LEAF adapter | `expo-crypto` |
| `src/offline/runtime.ts` | composition root (singleton wiring) | via the leaves |
| `src/offline/useOutbox.ts` | `useSyncExternalStore` hooks (outbox + online) | no (imports runtime) |
| `src/offline/useSubmitCreate.ts` | create-routing hook (thin shell over `routing.ts`) | no (imports runtime) |
| `src/features/offline/OfflineBanner.tsx` | banner component | no |
| `src/features/transactions/PendingTransactionRow.tsx` | memoized pending row | no |
| `src/features/transactions/sections.ts` | pure: pending + server → SectionList sections | no |

> **Decision-7 addendum (flag for senior-lead):** the architecture's module list
> omits a composition root. `runtime.ts` is that file — the offline analogue of the
> existing `src/lib/api.ts` (which wires coordinator + secureStore + resume). It
> constructs the outbox singleton with the real `storage`/`ids`/`send` adapters and
> the invalidation callback, and exposes `startOfflineRuntime()`. It contains no
> logic beyond wiring and is never imported by a test. `routing.ts`, `triggers.ts`,
> `parkedCopy.ts` and `features/transactions/sections.ts` are likewise additive
> pure files, added because the alternative is untestable logic inside hooks/JSX
> (no React test runner exists here — vitest `environment: 'node'`, S4).

## Data layer

- Endpoints: `POST /transactions` (the only offline-capable write) and, for
  reads, the existing `GET /transactions`, `GET /transactions/summary`,
  `GET /categories?include_archived=true`. **No new endpoint is requested by the
  mobile side.** The one contract change this scope needs — optional
  `client_id` on `TransactionCreate` plus the 200 replay-hit arm — is
  Decision 3 / subtask **B-1**, owned by backend-engineer, with the api-client
  regenerated by them. M-4 is BLOCKED on that regeneration; mobile does not
  hand-edit `packages/api-client` and does not mock the field.
- Query keys unchanged (`src/data/queryKeys.ts`, AM-1.6-a/b honoured). The outbox
  is NOT server state and NOT in the Query cache — it is app-local persisted
  client state with its own store (`useSyncExternalStore`), exactly like the auth
  mirror. Queued rows are never inserted into the Query cache (Decision 6).
- Invalidation (W8): ONE exported function is the single source used by both the
  direct create and the replay success path — see M-4.
- Offline implications: reads render from the persisted cache (M-2); writes other
  than create are blocked with visible disabled affordances (M-2/M-5). Persisted
  cache maxAge 7d, buster hand-bumped, allowlist-dehydrated.

## Subtask order and dependencies (each one engineer-run)

| # | Subtask | Depends on | Tier | Can start before B-1? |
|---|---|---|---|---|
| M-1 | Outbox pure core + vitest suite | — | FULL | yes |
| M-2 | Persistence wiring + purge policy | M-1 | STANDARD | yes |
| M-3 | Connectivity + trigger union | M-1 | STANDARD | yes |
| M-4 | Create-tx routing (clientId, enqueue policy, W8 invalidation) | **B-1**, M-1 (M-2 functionally) | FULL | **no** |
| M-5 | UI affordances | M-2, M-3, M-4 | STANDARD | partially (banner/disabled-writes only) |

---

# M-1 — Outbox pure core (FULL tier)

**Depends on:** nothing (runs in parallel with B-1). **Blocks:** M-2, M-3, M-4, M-5.
**Files:** NEW `src/offline/outbox.ts`, NEW `src/offline/outbox.test.ts`. Nothing else.
**Imports allowed in `outbox.ts`:** `@budget/api-client` (types + `ApiError` +
`getErrorCode`) and nothing else. No `react`, no `react-native`, no `expo-*`, no
`@tanstack/*`.

## Module API (exact)

```ts
import { ApiError, getErrorCode } from '@budget/api-client';
import type { components } from '@budget/api-client';

type TransactionCreate = components['schemas']['TransactionCreate'];
type TransactionRead = components['schemas']['TransactionRead'];

/** Async KV seam. Prod: offline/storage.ts (expo-sqlite/kv-store). Tests: Map fake. */
export interface KV {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type OutboxErrorKind = 'network' | 'server' | 'rejected';
export interface OutboxError {
  kind: OutboxErrorKind;
  status?: number;
  code?: string;   // getErrorCode(body) when present — feeds parkedCopy.ts (O7)
}

export interface OutboxItem {
  clientId: string;
  body: TransactionCreate;          // schema-valid form output (W1/W4/W7 conventions)
  /** Display-only sidecar; NEVER sent. See the Decision-2 addendum below. */
  display: { currency: string };
  enqueuedAt: string;               // ISO, from the injected clock; informational
  status: 'queued' | 'parked';
  transientAttempts: number;
  lastError: OutboxError | null;
}

export interface OutboxState { items: OutboxItem[] }   // FIFO, index 0 = oldest

export type SendResult =
  | { outcome: 'success'; created: TransactionRead }
  | { outcome: 'rejected'; status: number; code?: string }
  | { outcome: 'transient'; kind: 'network' | 'server'; status?: number }
  | { outcome: 'unauthorized' };

export interface OutboxDeps {
  storage: KV;
  send: (item: OutboxItem) => Promise<SendResult>;
  clock: () => number;
  newId: () => string;
  /** Replay-success hook — prod runs the W8 invalidation (M-4). Injected so the core stays TanStack-free. */
  onReplaySuccess?: (item: OutboxItem, created: TransactionRead) => void;
  /** netinfo HINT only (Decision 4): gates the enqueue-kick, never gates a send. Default: () => true. */
  isOnline?: () => boolean;
  maxTransientAttempts?: number;    // default MAX_TRANSIENT_ATTEMPTS
  storageKey?: string;              // default OUTBOX_KEY
}

export type ReplayStop = 'empty' | 'drained' | 'transient' | 'unauthorized';
export interface ReplayRunResult {
  sent: number;
  parked: number;
  stoppedBy: ReplayStop;
}

export interface Outbox {
  /** Resolves when hydration from storage completes (splash gate — the O2 pattern). */
  ready: Promise<void>;
  /** useSyncExternalStore snapshot. Reference-STABLE between mutations. */
  getSnapshot(): OutboxState;
  subscribe(listener: () => void): () => void;
  /** Adds an item (FIFO tail), persists, notifies. Kicks replay when isOnline(). */
  enqueue(input: { body: TransactionCreate; display: { currency: string }; clientId?: string }): Promise<OutboxItem>;
  /** Single-flight replay run. Concurrent calls share ONE promise. */
  replay(): Promise<ReplayRunResult>;
  /** parked -> queued, attempts reset, then replay(). */
  retry(clientId: string): Promise<ReplayRunResult>;
  /** Destructive removal (UI confirms first). */
  discard(clientId: string): Promise<void>;
  /** Purge everything (logout / different-user login — Decision 1). */
  clear(): Promise<void>;
}

export const OUTBOX_KEY = 'budget.offline.outbox.v1';
export const MAX_TRANSIENT_ATTEMPTS = 50;

export function createOutbox(deps: OutboxDeps): Outbox;
```

Pure, separately-exported helpers (the parts worth testing in isolation):

```ts
export function parseOutboxState(raw: string | null): OutboxState;      // corrupt/partial -> { items: [] }
export function serializeOutboxState(state: OutboxState): string;
export function applySuccess(state: OutboxState, clientId: string): OutboxState;
export function applyRejected(state: OutboxState, clientId: string, error: OutboxError): OutboxState;
export function applyTransient(state: OutboxState, clientId: string, error: OutboxError, maxAttempts: number): OutboxState;
export function classifySendFailure(error: unknown): SendResult;         // taxonomy, see below
export function toWireBody(item: OutboxItem): TransactionCreate;         // returns item.body — the display sidecar must never leak
export function queuedItems(state: OutboxState): OutboxItem[];
export function parkedItems(state: OutboxState): OutboxItem[];
export function pendingCount(state: OutboxState): number;                // queued only
```

> **Decision-2 addendum (flag for senior-lead):** `OutboxItem` gains one field
> beyond the architecture's binding sketch — `display: { currency: string }`.
> Reason: W7 forbids collecting currency, so `body.currency` stays absent and the
> server stamps it; but the M-5 pending row must render the amount with
> `formatMoney` (W4), which needs a currency. The value is copied from the month
> summary the form already reads (`summaryQuery.data.currency`, the same value the
> form's zod schema uses today, `transaction-form.tsx:93-116`). It is a *display*
> sidecar: `toWireBody()` returns `item.body` only, and a test asserts no
> `display`/`clientId` key reaches the wire body. No wire semantics change.

## Hydration, mirror, reactivity (O2/O3/O6 pattern, verbatim)

- `createOutbox` starts a single `ready = storage.getItem(key).then(parse)` flight.
  Load-once into `let state: OutboxState`, then `notify()`. Read errors and
  malformed JSON collapse to `{ items: [] }` and never throw (the
  `secureStore.ts:17-24` runtime-narrow precedent).
- Guard against a stale hydrate clobbering newer writes: adopt the hydrated state
  ONLY if nothing was enqueued in the meantime (`coordinator.ts:140-145` NIT-13
  precedent) — otherwise merge by prepending the hydrated items ahead of the
  newly-enqueued ones (FIFO: older first). The splash gate makes this a
  belt-and-suspenders path, exactly as in the coordinator.
- Writes: **memory-sync + notify first, `await storage.setItem` after** (O2). A
  storage write failure is swallowed (logged via `console.warn` in `__DEV__`
  only) — losing durability is not worth crashing a submit; the item still lives
  in memory for this process. Recorded honestly as a Section-A QA item.
- `getSnapshot()` returns the SAME object reference until a mutation replaces it
  (every transition builds a new `OutboxState`). This is the
  `useSyncExternalStore` correctness requirement (an unstable snapshot loops
  forever) and is explicitly tested.
- `subscribe(listener)` over a `Set`, returns unsubscribe — `coordinator.ts:161-166`.

## Replay engine state machine

```
idle ──replay()──► running ──► drained | halted(transient) | halted(unauthorized) | empty
                     │
                     └─ per item (head of the queued sub-list, re-read EACH iteration)
```

Per-item rules (Decision 2, binding):

| `send` outcome | state transition | run continues? |
|---|---|---|
| `success` | remove item; call `onReplaySuccess(item, created)` | **yes** — next item |
| `rejected` (4xx except 401) | `status='parked'`, `lastError={kind:'rejected',status,code}` | **yes** — a parked item must not dam the queue |
| `transient` (network / 5xx / 408 / 429) | `transientAttempts += 1`; park iff it reaches `maxTransientAttempts` | **no** — HALT (`stoppedBy:'transient'`) |
| `unauthorized` (401) | nothing changes — attempts NOT incremented | **no** — HALT (`stoppedBy:'unauthorized'`), queue intact |

- The loop re-reads `queuedItems(state)[0]` on every iteration, so an item
  enqueued *while a run is in flight* is picked up by that same run (no lost
  trigger, no second run needed).
- Cap-park + halt: hitting the cap parks the head AND halts the run (the failure
  was transient ⇒ the network is down ⇒ continuing is pointless). The next
  trigger starts at the new head.
- 401 does not increment attempts: a session death must not consume the poison
  budget of a perfectly good item. The coordinator has already tried
  refresh→retry once (`coordinator.ts:249-256`), so a 401 reaching us is terminal.
- **Single-flight:** one `inFlight: Promise<ReplayRunResult> | null`; `replay()`
  returns it when set; identity-guarded clear in `.finally` (`if (inFlight ===
  flight) inFlight = null`) — the `coordinator.ts:189-201` pattern, for the same
  reason (a late-settling run must not reopen the window for a replacement run).
- No timers, no backoff machinery: replay is trigger-driven (M-3), and the
  trigger union *is* the backoff.
- The engine wraps `deps.send` in try/catch and routes a thrown error through
  `classifySendFailure` — a leaky adapter can never crash a run.

## Error taxonomy (grounded in the code as it exists today)

`classifySendFailure(error: unknown): SendResult` — mirrors how
`src/data/errors.ts:21-24,60-63` and the coordinator already classify:

| Input | Result |
|---|---|
| not an `ApiError` (RN `fetch` rejects with `TypeError: Network request failed`) | `{outcome:'transient', kind:'network'}` — matches `describeTransactionError`'s non-ApiError ⇒ NETWORK_MESSAGE arm |
| `ApiError.status === 401` | `{outcome:'unauthorized'}` |
| `ApiError.status >= 500`, or `408`, or `429` | `{outcome:'transient', kind:'server', status}` |
| any other `ApiError` 4xx (400/403/404/409/422/…) | `{outcome:'rejected', status, code: getErrorCode(error.body)}` |

`getErrorCode` handles both envelope arms (`detail` as string, or
`detail.code`) — `packages/api-client/src/auth.ts`. The 422 `ValidationError[]`
arm yields `code === undefined`; `parkedCopy.ts` (M-5) falls back to generic copy.
Note `lib/queryClient.ts:26-31` already encodes the same "4xx deterministic,
everything else transient" policy for queries — this is that policy for writes.

The prod `send` adapter (built in M-4, wired in `runtime.ts`) is:
`throwOnError(apiClient.POST('/transactions', { body: toWireBody(item) }))` →
`{outcome:'success', created}`; `catch (e) → classifySendFailure(e)`.
`throwOnError` keys off `response.ok`, so B-1's **200** replay-hit arm and the
**201** fresh-insert arm are both successes with the same `TransactionRead` body
— no client change needed for the 200 arm beyond the regenerated types.

## vitest suite outline (`src/offline/outbox.test.ts`)

Fakes only: `Map`-backed KV, scripted `send`, counter `newId`, fixed `clock`.
No expo/react-native in the graph (S4/R5). Each test below exercises a branch
that can genuinely break; no re-assertion of another test's value.

1. **hydrate-once + FIFO across a restart** — enqueue A,B against KV #1; build a
   NEW outbox over the SAME KV; replay; assert `send` call order is exactly
   `[A, B]`. (Covers serialize/parse round-trip *and* ordering — the thing that
   silently breaks if state is stored as an object map.)
2. **corrupt persisted value** — KV holds `'{not json'` / `'{"items":3}'`; the
   outbox hydrates to empty, `ready` resolves, no throw.
3. **enqueue persists and notifies** — subscriber fires once; the serialized KV
   value contains the item; `getSnapshot()` reference CHANGED.
4. **snapshot stability** — two consecutive `getSnapshot()` calls with no mutation
   in between return the identical reference (`useSyncExternalStore` contract).
5. **success drains and invalidates** — 2 items, both succeed: queue empty,
   `onReplaySuccess` called twice with the matching item + created row,
   `stoppedBy: 'drained'`.
6. **park-on-rejected CONTINUES** — item A → 422 `CATEGORY_ARCHIVED`, item B →
   success. Assert: A is `parked` with `code:'CATEGORY_ARCHIVED'`, B was sent and
   removed, `stoppedBy:'drained'`, `parked:1`. (The "a parked item must not dam
   the queue" rule.)
7. **halt-on-transient** — item A → network failure, item B queued. Assert `send`
   called EXACTLY once, B untouched and still `queued`, A `transientAttempts===1`,
   `stoppedBy:'transient'`.
8. **attempts cap parks and halts** — `maxTransientAttempts: 2`; two failing runs:
   after run 2 the head is `parked` with the last error, run result
   `stoppedBy:'transient'`, and a THIRD run attempts item B (proving the cap
   unblocks the queue rather than wedging it).
9. **401 halts and keeps the queue** — items unchanged, still `queued`,
   `transientAttempts` still 0 (the "don't burn the poison budget" branch),
   `stoppedBy:'unauthorized'`.
10. **single-flight** — a deferred `send`; call `replay()` twice before it
    settles; assert both calls return the SAME promise/result object and `send`
    was invoked once for the head item.
11. **mid-run enqueue is picked up by the running run** — enqueue B while A's send
    is pending; assert one run sends both (loop re-reads the head).
12. **enqueue-while-online kicks replay** — `isOnline: () => true` and a queue
    that already has an item ⇒ `send` is invoked without any other trigger.
    Contrast case: `isOnline: () => false` ⇒ `send` NOT invoked. (Senior-lead
    amendment; the contrast is what makes the test non-vacuous.)
13. **retry(clientId)** — a parked item becomes `queued` with attempts reset and
    is sent by the run `retry` kicks.
14. **discard(clientId)** — removed from memory AND from the persisted value; a
    later replay never sends it.
15. **clear()** — memory empty and `storage.removeItem` called with the key.
16. **`classifySendFailure` table** — one case per routing-distinct branch:
    plain `Error` ⇒ transient/network; `ApiError(500)` ⇒ transient/server;
    `ApiError(429)` ⇒ transient; `ApiError(422, {detail:'CATEGORY_ARCHIVED'})` ⇒
    rejected + code; `ApiError(401)` ⇒ unauthorized.
17. **`toWireBody` leak guard** — the returned object has exactly the
    `TransactionCreate` keys; no `display`, no `status`, no `transientAttempts`.

Deliberately NOT tested (vacuous): that `queuedItems`/`parkedItems` filter by
status (proven by 6/9), that the buster constant equals its literal, that
`enqueuedAt` equals the injected clock's ISO.

---

# M-2 — Read-cache persistence + purge policy (STANDARD tier)

**Depends on:** M-1 (`KV` interface, `outbox.clear()`).
**New:** `src/offline/storage.ts` (LEAF), `src/offline/persist.ts` (pure),
`src/offline/persist.test.ts`.
**Changed:** `app/_layout.tsx`, `src/auth/useAuthListener.ts`, `package.json`.

## Storage leaf (`src/offline/storage.ts`)

The ONLY file importing `expo-sqlite/kv-store`. Header comment mirrors
`secureStore.ts`: kept out of the vitest graph on purpose.

```ts
import Storage from 'expo-sqlite/kv-store';       // AsyncStorage-compatible async API
import type { KV } from './outbox';

const PREFIX = 'budget.offline.';
export function createKvStorage(): KV { /* getItem/setItem/removeItem, prefixed */ }
export const kvStorage = createKvStorage();
```

One medium serves BOTH the persister and the outbox (Decision 1). Use the ASYNC
API (`getItem`/`setItem`/`removeItem` return promises) — `createAsyncStoragePersister`
requires it and the outbox's `KV` is async by design. Tokens stay in
expo-secure-store; **nothing auth-related is ever written here** (O2).

## Pure persist module (`src/offline/persist.ts`)

```ts
/** HAND-BUMPED. Bump whenever data/queryKeys.ts key shapes change, the rendered
 *  read models change, or an api-client regeneration changes persisted field
 *  shapes. A mismatch drops the cache — the safe failure mode. */
export const CACHE_SCHEMA_VERSION = 1;
export const PERSIST_BUSTER = `v${CACHE_SCHEMA_VERSION}`;
export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days (Decision 1 / Q4)
export const OWNER_KEY = 'budget.offline.owner';
export const CACHE_KEY = 'budget.offline.query-cache';

/** Structural param, NOT TanStack's Query class — so the test needs no QueryClient. */
export function shouldPersistQuery(q: { queryKey: readonly unknown[]; state: { status: string } }): boolean;

export type OfflineEvent =
  | { type: 'logout' }
  | { type: 'session-expired' }
  | { type: 'me-loaded'; userId: string };

export type OfflineAction =
  | { action: 'keep' }
  | { action: 'adopt-owner'; userId: string }
  | { action: 'purge'; reason: 'logout' | 'different-user' };

export function decideOfflineAction(event: OfflineEvent, marker: string | null): OfflineAction;
```

`shouldPersistQuery` — allowlist, not denylist: `state.status === 'success'` AND
`key[0] === 'categories' || key[0] === 'transactions'`. `['me']`
(`auth/useMe.ts:8`) and anything else never persists.

`decideOfflineAction` truth table (Decision 1, binding):

| event | marker | action |
|---|---|---|
| `logout` | any | `purge/logout` (cache + outbox + marker) |
| `session-expired` | any | `keep` — tokens are gone, the guard locks the UI; purging here would destroy queued transactions on a transient refresh failure |
| `me-loaded` | `null` | `adopt-owner` (first login on this device) |
| `me-loaded` | `=== userId` | `keep` (resume, incl. after expiry) |
| `me-loaded` | `!== userId` | `purge/different-user`, then adopt |

## Mounting

`app/_layout.tsx`:

```
GestureHandlerRootView > SafeAreaProvider > PersistQueryClientProvider
  client={queryClient}
  persistOptions={{
    persister: createAsyncStoragePersister({ storage: kvStorage, key: CACHE_KEY }),
    maxAge: PERSIST_MAX_AGE_MS,
    buster: PERSIST_BUSTER,
    dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
  }}
  onSuccess={() => { void startOfflineRuntime(); }}   // M-3
```

- The existing splash gate stays and becomes `Promise.all([coordinator.ready,
  outbox.ready])` — the route guard reads a synchronous auth mirror
  (`(app)/_layout.tsx:29`) and M-4's routing reads a synchronous outbox
  snapshot, so neither may evaluate pre-hydration.
- Cache RESTORE is TanStack's own gate (`PersistQueryClientProvider` withholds
  fetches until restore resolves; `useIsRestoring()` is available if a screen
  ever needs it — none do today: their `isPending` skeletons already cover it).
- Mutations are NOT persisted (no `resumePausedMutations`, no
  `mutationCache` dehydration) — Decision 2 rejected that mechanism explicitly.

## Purge wiring (`src/auth/useAuthListener.ts`, amended)

Today it clears the whole Query cache on ANY signed-in → signed-out edge
(`useAuthListener.ts:16-21`). That is wrong once a cache is persisted: clearing on
a *session expiry* would write an empty snapshot and destroy the offline read
cache the user needs. Amended behaviour:

- sign-out edge AND `coordinator.wasSessionExpired()` ⇒ `decideOfflineAction({type:'session-expired'})`
  ⇒ **keep**: do not clear, do not purge. Nothing renders it (the guard is at
  `/login`); on re-login the owner check decides.
- sign-out edge otherwise (intentional logout) ⇒ `purge/logout`:
  `queryClient.clear()` + `persister.removeClient()` + `outbox.clear()` +
  `kvStorage.removeItem(OWNER_KEY)`. The M-5 confirm runs BEFORE logout is called.
- `useMe().data?.id` transitions to a defined value ⇒ feed `{type:'me-loaded'}`
  with the stored marker; `adopt-owner` writes the marker, `purge/different-user`
  runs the same purge as logout and THEN adopts.

**Honest window (accepted, documented):** between an interactive login and
`/users/me` resolving, a *different* user could momentarily see the previous
user's cached lists. It is bounded by one round trip, only reachable when the
previous session ended by EXPIRY (an intentional logout already purged), and
requires network by definition (login does). The mismatch purge is the backstop.
The alternative — blocking every query on `/users/me` — is a larger, riskier
change than the hazard warrants. Recorded for QA Section B.

## Tests (`src/offline/persist.test.ts`)

1. `shouldPersistQuery` allowlist: `['transactions', filters]` success ⇒ true;
   `['transactions','summary','2026-08']` success ⇒ true; `['categories',{…}]`
   success ⇒ true; `['me']` success ⇒ **false**; `['transactions', filters]` with
   `status:'error'` ⇒ **false**. (Five routing-distinct branches; the `['me']` and
   error rows are the ones that leak/poison if the predicate is written as a denylist.)
2. `decideOfflineAction` — one case per table row above (5 rows), each returning a
   different action; the `session-expired ⇒ keep` row is the one whose regression
   silently eats a user's queue.

Not tested (vacuous): that `PERSIST_MAX_AGE_MS` equals 7 days; that the buster
string is `'v1'`.

## Not verifiable here (→ qa-mobile-checklist Section A)

kv-store durability across a real process restart; Expo Go boot with expo-sqlite
linked; that `PersistQueryClientProvider` restore actually precedes the first
paint on device; persisted-cache size behaviour for a 200-row month.

---

# M-3 — Connectivity + replay trigger union (STANDARD tier)

**Depends on:** M-1. **New:** `src/offline/netinfo.ts` (LEAF),
`src/offline/triggers.ts` (pure), `src/offline/triggers.test.ts`,
`src/offline/runtime.ts` (composition root).
**Changed:** `src/lib/queryClient.ts` (comment only — the recorded FUTURE-TASK
trigger fires here), `app/_layout.tsx` (start the runtime).

## netinfo leaf (`src/offline/netinfo.ts`)

The ONLY file importing `@react-native-community/netinfo`:

```ts
import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';

/** Wire netinfo into TanStack's onlineManager. Idempotent; returns an unsubscribe. */
export function wireOnlineManager(): () => void {
  return onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) =>
      // isInternetReachable === null means UNKNOWN -> treat as ONLINE.
      // netinfo is a HINT, never a gate (Decision 4): false-offline must never
      // block a send, and a captive portal reporting "online" is handled by the
      // outbox's halt-on-transient rule.
      setOnline(Boolean(state.isConnected) && state.isInternetReachable !== false),
    ),
  );
}
```

This makes the existing `refetchOnReconnect: true` live with **no change to
`lib/queryClient.ts` behaviour** — only its comment (lines 7-13) is rewritten
from "INERT … recorded FUTURE-TASK trigger" to "LIVE since mobile-offline;
wired in `src/offline/netinfo.ts`". That comment rewrite is a required diff item.

## Trigger union (`src/offline/triggers.ts`, pure)

```ts
export interface TriggerDeps {
  /** onlineManager.subscribe in prod; a fake emitter in tests. */
  subscribeOnline: (cb: (online: boolean) => void) => () => void;
  /** auth/resume.ts subscribeAppStateResume (the existing O5 seam) in prod. */
  subscribeResume: (cb: () => void) => () => void;
  replay: () => void;
  /** Initial online belief at start. */
  isOnline: () => boolean;
}
export function startReplayTriggers(deps: TriggerDeps): () => void;
```

Trigger union — all funnel into the single-flight `outbox.replay()`; firing
several at once is harmless by construction (M-1 test 10):

| trigger | where it lives |
|---|---|
| app start (after outbox hydration + cache restore) | `startReplayTriggers` fires once |
| offline → online **transition** (edge, not every event) | `subscribeOnline` |
| AppState foreground resume | `subscribeResume` — reuses `auth/resume.ts` |
| any successful direct create | `useCreateTransaction.onSuccess` (M-4) |
| **enqueue while believed online** (senior-lead amendment) | inside `outbox.enqueue` via the injected `isOnline()` (M-1) |
| manual: banner "Sync now" / per-item Retry | M-5 → `outbox.replay()` / `outbox.retry()` |

Pure vs leaf: `triggers.ts` owns the edge-detection logic (holds the last known
online value) and is fully testable with fake emitters; `netinfo.ts` and
`resume.ts` are the leaves that produce events.

## Composition root (`src/offline/runtime.ts`)

Not a test target. Constructs the singleton:

```ts
export const outbox = createOutbox({
  storage: kvStorage,                              // offline/storage.ts (leaf)
  send: (item) => sendCreate(item),                // M-4 adapter over apiClient
  clock: Date.now,
  newId,                                           // offline/ids.ts (leaf)
  onReplaySuccess: (_item, created) => invalidateAfterTransactionCreate(queryClient, created),  // W8
  isOnline: () => onlineManager.isOnline(),
});

let started = false;
export function startOfflineRuntime(): void {   // idempotent; called from _layout onSuccess
  if (started) return;
  started = true;
  wireOnlineManager();
  startReplayTriggers({ subscribeOnline: …, subscribeResume: subscribeAppStateResume,
                        replay: () => void outbox.replay(), isOnline: () => onlineManager.isOnline() });
}
```

## Tests (`src/offline/triggers.test.ts`)

1. **fires once at start** — `replay` called exactly once on `startReplayTriggers`.
2. **EDGE only** — emitting `online:true` while already online does NOT call
   replay; `true → false → true` DOES. (The branch that, if written as
   "on every event", turns every netinfo tick into a request storm.)
3. **resume triggers replay**.
4. **unsubscribe stops everything** — after the returned disposer, further
   online/resume events call nothing (leak guard on a module started per app run).

Not tested (vacuous): that `replay` is the injected function; netinfo's own
semantics (unreachable here — Section A).

## Not verifiable here (→ Section A)

Real netinfo transitions (airplane mode, Wi-Fi↔cellular, captive portal), whether
Android emits the transition on process resume, iOS background-suspend behaviour.

---

# M-4 — Create-tx routing (FULL tier)

**Depends on:** **B-1 (regenerated api-client carrying optional `client_id` on
`TransactionCreate` + the 200 response arm)** and M-1. Also functionally depends
on M-2 — see the currency note below.
**New:** `src/offline/ids.ts` (LEAF), `src/offline/routing.ts` (pure),
`src/offline/routing.test.ts`, `src/offline/useSubmitCreate.ts` (hook shell),
`src/offline/send.ts` (prod send adapter, tiny, no tests — imports `apiClient`).
**Changed:** `src/data/transactions.ts` (export the invalidation function; attach
`client_id` pass-through), `app/(app)/transaction-form.tsx` (submit path).

## clientId on EVERY create (architecture Q5 = "all creates, one code path")

`src/offline/ids.ts` — the ONLY file importing `expo-crypto`:

```ts
import * as Crypto from 'expo-crypto';
export const newId = (): string => Crypto.randomUUID();
```

The id is generated at **submit time**, before the routing decision, and travels
with the item through every arm. This is what makes the
"direct send fails with a network error ⇒ enqueue the SAME clientId" arm safe:
the id must have existed on the FIRST attempt or the ambiguous-failure replay
could duplicate the row (Decision 3).

## Routing decisions (pure — `src/offline/routing.ts`)

Kept out of the hook so they are vitest-able (no React runner exists, S4):

```ts
export function decideCreateRoute(input: { online: boolean; queueNonEmpty: boolean }): 'direct' | 'enqueue';
//   direct  iff  online && !queueNonEmpty        (FIFO: a new create must never jump an older queued one)
//   enqueue otherwise

export function decideDirectFailure(result: SendResult): 'enqueue' | 'surface';
//   'enqueue' for outcome 'transient' (network OR 5xx — ambiguous: sent-or-not unknown; client_id makes replay safe)
//   'surface' for 'rejected' (inline field errors — existing UX) and 'unauthorized' (the guard reacts)
```

Note the deliberate asymmetry with the replay engine: on the DIRECT path a 5xx is
enqueued rather than surfaced as a dead end (mobile networks; errors must be
recoverable, never dead ends), while inside a replay run a 5xx halts the run.

## Submit hook (`src/offline/useSubmitCreate.ts`)

Thin shell — no logic beyond calling the pure deciders:

```ts
export type SubmitOutcome =
  | { mode: 'created'; transaction: TransactionRead }
  | { mode: 'queued'; clientId: string };

export function useSubmitCreate(): {
  submit(input: { body: TransactionCreate; currency: string }): Promise<SubmitOutcome>;
  isPending: boolean;
};
```

Flow:
1. `clientId = newId()`; `body = { ...formBody, client_id: clientId }`.
2. `decideCreateRoute({ online: onlineManager.isOnline(), queueNonEmpty: pendingCount(outbox.getSnapshot()) > 0 })`.
3. `'direct'` ⇒ `createTransaction.mutateAsync(body)` (the EXISTING
   `useCreateTransaction`, unchanged UX and unchanged `onSuccess` invalidation)
   ⇒ `{mode:'created'}`; then kick `void outbox.replay()` (post-mutation trigger).
   On throw ⇒ `classifySendFailure(err)` ⇒ `decideDirectFailure`:
   `'enqueue'` ⇒ `outbox.enqueue({ body, display:{currency}, clientId })` ⇒
   `{mode:'queued'}`; `'surface'` ⇒ rethrow (the form routes it through
   `describeTransactionError`, unchanged).
4. `'enqueue'` ⇒ `outbox.enqueue(...)` ⇒ `{mode:'queued'}`. `enqueue` itself kicks
   replay when `isOnline()` (senior-lead amendment) — that covers the
   "queue was non-empty but we are online" case with no extra call site.

## Invalidation identity (W8 — the binding requirement)

`src/data/transactions.ts` today keeps the create invalidation private:
`invalidateTxLists` (lines 36-41, predicate `queryKey[0]==='transactions' &&
queryKey[1]!=='summary'`), `affectedMonth` (lines 30-32), used by
`useCreateTransaction.onSuccess` (lines 75-81). M-4 extracts EXACTLY that body
into one exported function and makes both paths call it:

```ts
export function invalidateAfterTransactionCreate(queryClient: QueryClient, created: TransactionRead): void {
  void invalidateTxLists(queryClient);
  void queryClient.invalidateQueries({ queryKey: qk.txSummary(affectedMonth(created.occurred_at)) });
}
```

`useCreateTransaction.onSuccess` becomes `(created) => invalidateAfterTransactionCreate(queryClient, created)`;
`runtime.ts` passes the same function as the outbox's `onReplaySuccess`. One
body, two callers — "replay success runs the SAME invalidation" is then
structural, not a convention. `useUpdateTransaction`/`useDeleteTransaction` keep
their own two-month/Set logic untouched (W8 date-move rule is edit-only).

## 422 handling: direct vs replay

- **Direct:** unchanged — `describeTransactionError` (`src/data/errors.ts:60-92`)
  routes `CATEGORY_NOT_FOUND` / `CATEGORY_ARCHIVED` to the `category_id` field,
  validation issues to their fields, everything else to the form root. The user
  fixes it in the open form. No behaviour change.
- **Replay:** there is no open form and no user present, so the item is **parked**
  with `{kind:'rejected', status:422, code}` and surfaced on the pending screen
  (M-5) with human copy from `parkedCopy.ts` (O7 app-owned table) plus Retry /
  Discard. Never silently dropped, never silently category-stripped (Decision 5.1:
  converting a categorized expense to uncategorized is a destructive merge of intent).

## Create-form UX when the item is enqueued (designed here, Decision 6)

The form must not lie ("Saved") and must not feel like a failure:

- Submit button label/pending state unchanged during the attempt.
- Outcome `'created'` ⇒ today's behaviour exactly: `router.back()`.
- Outcome `'queued'` ⇒ `Haptics.notificationAsync(Success)`, then `router.back()`,
  and the transactions screen shows the row in its **Pending** section (M-5) with
  the banner reading "Offline — N transaction(s) will sync later". The dismissal is
  immediate (the write is durably persisted before `enqueue` resolves), and the
  honest wording lives on the row/banner rather than in a toast the user can miss.
  No toast/snackbar library is added.
- Outcome `'surface'` (rejected/unauthorized) ⇒ the form STAYS OPEN with inline
  field errors — unchanged from today.

**Currency prerequisite (call-out).** `transaction-form.tsx:93-116` disables
create while the account currency is unknown (`createDegraded`), because
`transactionFormSchema(currency)` needs it for minor-unit scaling (W4/W7). The
currency comes from the month summary query. Therefore **offline create only
works when the summary is in the persisted cache** ⇒ M-2 is a functional
prerequisite of M-4, not merely an adjacent feature. Cold-install + offline = no
create, and the form says so via the existing degraded notice (reworded to
"Can't create while offline until this month has loaded once"). Recorded as a
Risk and a Section-B QA item.

## Tests (`src/offline/routing.test.ts`)

1. `decideCreateRoute` — the four input combinations, asserting the ONLY `'direct'`
   cell is `{online:true, queueNonEmpty:false}` (the FIFO-preservation rule is
   exactly the `{online:true, queueNonEmpty:true} ⇒ 'enqueue'` cell).
2. `decideDirectFailure` — `transient/network ⇒ enqueue`, `transient/server(500)
   ⇒ enqueue`, `rejected(422) ⇒ surface`, `unauthorized ⇒ surface`. (The
   `500 ⇒ enqueue` row is the deliberate direct-vs-replay asymmetry; the
   `422 ⇒ surface` row is what keeps inline field errors working.)

Not tested (vacuous): that `newId` returns a uuid; that the hook returns
`isPending` (no React runner, and it is a pass-through of TanStack state).

## Blocker to state plainly

M-4 cannot start until B-1 has landed AND `packages/api-client` has been
regenerated with `client_id` on `TransactionCreate`. Mobile will not hand-edit
generated types and will not send an un-typed field. If B-1 slips, M-1/M-2/M-3/
M-5-minus-pending-rows can still proceed.

---

# M-5 — UI affordances (STANDARD tier)

**Depends on:** M-2, M-3, M-4.
**New:** `src/offline/useOutbox.ts`, `src/offline/parkedCopy.ts` (+ test),
`src/features/offline/OfflineBanner.tsx`,
`src/features/transactions/PendingTransactionRow.tsx`,
`src/features/transactions/sections.ts` (+ test), `app/(app)/pending.tsx`.
**Changed:** `TransactionList.tsx`, `SummaryHeader.tsx`,
`app/(app)/(tabs)/transactions.tsx`, `app/(app)/(tabs)/categories.tsx`,
`app/(app)/transaction-form.tsx`, `app/(app)/category-form.tsx`,
`src/components/LogoutButton.tsx`, `app/(app)/_layout.tsx`.

## Copy language — HONEST FINDING

The grooming brief asked for Russian copy "per app conventions". **Checked:
`grep -rP '[А-Яа-я]' apps/mobile/src apps/mobile/app` returns exactly one file —
`src/lib/probes.ts`, and only as Cyrillic *test data* for the W11 `Intl.Collator`
canary.** Every user-facing mobile string today is English ("No transactions in
…", "Retry", "Log out", "System categories can't be edited."). Russian exists only
in web's stats/advisor screens (a later scope). **Therefore all new mobile copy in
this scope is ENGLISH**, matching the surface it sits next to; mixing languages
inside one screen would be worse than either choice. If PM wants the mobile app
localised, that is its own scope (every existing string, plus a i18n mechanism) —
flagged, not silently decided.

## Reactivity hooks (`src/offline/useOutbox.ts`)

```ts
export function useOutbox(): OutboxState;   // useSyncExternalStore(outbox.subscribe, outbox.getSnapshot, outbox.getSnapshot)
export function useIsOnline(): boolean;     // useSyncExternalStore over onlineManager.subscribe / isOnline
```

Same shape as `useIsAuthenticated` (`src/auth/useAuth.ts:15-21`). Server-state
rule intact: the outbox is client state, not API data.

## Offline banner (`src/features/offline/OfflineBanner.tsx`)

Source of truth = `useIsOnline()` + `useOutbox()`. Priority order (first match wins):

| condition | copy | affordance |
|---|---|---|
| parked > 0 | "N transaction(s) failed to sync" | tap → `/pending` |
| offline && queued > 0 | "Offline — N transaction(s) will sync later" | — |
| offline | "Offline — showing saved data" | — |
| online && queued > 0 | "Syncing N…" | "Sync now" (manual trigger → `outbox.replay()`) |
| otherwise | renders `null` | — |

Placement: rendered at the top of each tab screen's `SafeAreaView`, below the
toolbar (two call sites: `transactions.tsx`, `categories.tsx`). **UX call:** not
wrapped around the navigator — a wrapping `View` in `(app)/_layout.tsx` would sit
above the Tabs header and shift the modal presentation; per-screen placement is
explicit, safe-area-correct, and keeps modals unaffected. Touch target ≥ 44pt for
the tappable variants; `accessibilityRole="button"` where tappable, `"alert"` for
the parked state.

## Pending rows in the transaction list — UX call: a dedicated PENDING SECTION

`src/features/transactions/sections.ts` (pure):

```ts
export type ListRow = { kind: 'server'; tx: TransactionRead } | { kind: 'pending'; item: OutboxItem };
export interface ListSection { key: string; title: string; kind: 'pending' | 'day'; data: ListRow[] }
export function pendingForMonth(items: OutboxItem[], month: string): OutboxItem[];   // queued only, occurred_at.slice(0,7) === month
export function buildTransactionSections(server: TransactionRead[], pending: OutboxItem[]): ListSection[];
```

Queued items render as a **"Pending — not yet synced"** section pinned at the TOP,
NOT interleaved into `occurred_at` day groups. Rationale (this is the architect's
explicitly-delegated call):

1. Interleaving implies "booked". A queued row is not a server row; the summary
   provably excludes it (Decision 5.3), so placing it among booked rows
   contradicts the summary the user is reading two inches above.
2. `groupByDay.ts` exists to PRESERVE the server's `occurred_at`-DESC order and
   intra-day tiebreak without re-sorting (its header comment). Splicing client
   rows into those groups requires inventing an intra-day position — a fake
   ordering fact.
3. A queued item may fall in a different month than the one being viewed;
   day-merging would either hide it or misplace it. The section is month-scoped
   (`pendingForMonth`) while the banner count is global, so nothing disappears
   silently.
4. Pinned at the top it is always visible without scrolling — the point of the
   affordance.
5. It keeps the merge a trivially testable pure function.

`TransactionList.tsx` changes: `sections` come from `buildTransactionSections`;
`keyExtractor` = `row.kind === 'server' ? row.tx.id : 'q:' + row.item.clientId`;
`renderItem` switches on `row.kind` (`TransactionRow` vs `PendingTransactionRow`,
both `memo`'d); the empty state fires only when `server.length === 0 && pending.length === 0`;
the footer count keeps counting SERVER rows only ("Showing N of total" must not
be inflated by unsynced items).

`PendingTransactionRow.tsx`: same layout as `TransactionRow`, dimmed, with a
"Pending" badge and no press-to-edit (a queued item cannot be edited — Q2
Discard-only). Amount via `formatMoney(signedMinor, item.display.currency,
{locale: APP_LOCALE})` — sign from `kind`, integer minor units, no float math
(W4/W5). Category name joined from the same archived-inclusive index (W3);
`category_id === null` ⇒ "Uncategorized".

## Summary header

`SummaryHeader` gains `pendingCount: number` and renders, under the totals when
`> 0`: **"N pending — not included"**. Server numbers are untouched — the client
literally cannot compute a queued item's contribution (currency is server-stamped
when omitted, W7; the base snapshot is server-computed), so any client-side
addition would be a fabrication (Decision 5.3).

## Parked items — dedicated screen `app/(app)/pending.tsx`

**UX call:** a screen, not an inline section. Parked items are rare, each needs a
sentence of explanation plus two actions, and the transactions list must not turn
into an error console. The screen is deep-link-safe (reads the outbox snapshot,
no params, no prior-screen state) and is registered as a modal in
`(app)/_layout.tsx` with `MODAL_PARENT_TAB['/pending'] = '/transactions'` so the
O6 `next` preservation stays coherent.

Per parked card: amount + category + date + the reason from `parkedCopy.ts`, e.g.
`CATEGORY_ARCHIVED` ⇒ "That category was archived. Discard this one and re-add it
online."; unknown/absent code ⇒ "This transaction couldn't be saved. You can try
again or discard it."; `kind:'network'` at the attempts cap ⇒ "Couldn't reach the
server after many attempts."
Actions: **Retry** (`outbox.retry(clientId)`; ≥44pt) and **Discard**
(`confirmAction({ title:'Discard transaction', message:"This transaction was never
saved. Discard it? This can't be undone.", confirmLabel:'Discard', destructive:true })`
— `src/components/confirm.ts`, which already fires success haptics). Nothing is
ever auto-dismissed. Screen states: empty ("Nothing failed to sync."), populated;
no loading/error states exist (local state, synchronous).

## Offline-disabled write affordances (Decision 2 — visibly disabled, not hidden)

- `transaction-form.tsx` **edit mode** while offline: Save + Delete disabled,
  notice "Offline — editing needs a connection." Create mode stays enabled.
- `category-form.tsx` while offline: Save/Archive disabled + the same notice.
- `categories.tsx`: "Add category" disabled + notice.
- Rows stay pressable (viewing is fine); only the writes are gated.
- Disabled styling uses the existing `colors.disabled` token; `FormButton`
  already supports `disabled`.

## Logout with pending items

`LogoutButton.tsx`: when `pendingCount(useOutbox()) > 0`, wrap `logout.mutate()`
in `confirmAction({ title:'Log out', message:'N unsynced transaction(s) will be
discarded.', confirmLabel:'Log out', destructive:true })`. Confirming proceeds to
`coordinator.logout()`, whose sign-out edge runs the M-2 `purge/logout` path
(cache + outbox + owner marker). Zero pending ⇒ today's one-tap behaviour.

## Tests

- `sections.test.ts`: (1) pending section is first and server day-groups follow in
  server order; (2) `pendingForMonth` excludes PARKED items and items from other
  months (two failure modes that would otherwise show unsent rows as pending in
  the wrong month); (3) empty pending ⇒ no empty "Pending" section is emitted.
- `parkedCopy.test.ts`: known code ⇒ its specific copy; **unknown code ⇒ the
  generic fallback** (the branch that otherwise renders `undefined` to the user).

No component tests: there is no React Native test renderer in this repo
(vitest `environment: 'node'`, S4) and adding one is out of scope. All render
logic is therefore pushed into the pure functions above — that is the point.

## Platform concerns (M-5 and scope-wide)

- **Permissions:** none. No camera/photos/location in this scope.
- **iOS vs Android:** the pending modal inherits the existing Stack modal config
  (iOS swipe-back, Android hardware back both dismiss — no custom back handler
  added, so Android back stays default-correct). Banner text must survive
  Android's larger default font scaling — single line + `numberOfLines={1}` +
  ellipsis on the long variants.
- **Safe areas / keyboard:** unchanged patterns — screens already use
  `SafeAreaView edges={['bottom']}` and `KeyboardAwareForm`; the banner sits
  inside the existing safe-area container, never over the notch.
- **Native modules touched:** `expo-sqlite` (kv-store), `@react-native-community/netinfo`,
  `expo-crypto`. All ship inside Expo Go and are pinned by `npx expo install`; no
  config plugin entries are required in `app.json`; no prebuild/eject. Adding
  them is pre-approved by the architecture (Decision 1/4/7) — implementers must
  not add anything beyond this list without senior-lead approval.
- **JS-thread cost:** the outbox mirror is a small array; sections are rebuilt in
  `useMemo`; rows stay `memo`'d; replay is sequential and network-bound. No work
  added to navigation/animation frames.

## UI states (per screen, explicit)

- **Transactions tab** — loading: existing skeletons (now often skipped, since the
  persisted cache hydrates first); empty: only when server AND pending are empty;
  error: existing "Couldn't load transactions." + Retry — and when cached data
  exists the query renders the cached rows with the banner as the stale indicator
  instead of the error box; success: sections + optional Pending section.
  Offline: banner + cached data, never a crash.
- **Summary header** — loading/error unchanged; success gains the "N pending —
  not included" line.
- **Categories tab** — unchanged states + banner + disabled Add while offline.
- **Transaction form (create)** — normal; degraded when currency unknown (submit
  disabled + notice); submitting; queued (dismiss + haptic); rejected (inline
  field errors).
- **Transaction form (edit)** — unchanged states + offline-disabled Save/Delete
  with notice.
- **Pending screen** — empty ("Nothing failed to sync.") / populated; each card
  has Retry (pending state while its run is in flight) and Discard (confirm).
- **Banner** — five variants above, or absent.

---

# New dependencies (complete, nothing beyond this list)

Run from `apps/mobile` (expo install must resolve against the installed SDK, and
writes into that package.json), then re-link from the repo root:

```bash
cd apps/mobile
npx expo install expo-sqlite @react-native-community/netinfo expo-crypto
cd ../..
pnpm --filter @budget/mobile add \
  @tanstack/react-query-persist-client@5.101.4 \
  @tanstack/query-async-storage-persister@5.101.4
pnpm install
```

- The two persister packages are pure JS and MUST be pinned to the same version
  line as the installed `@tanstack/react-query` (`5.101.4`,
  `apps/mobile/package.json:17`). If that exact patch is not published for a
  persister package, pin the nearest published `5.101.x` and record the choice in
  the implementation report — do NOT float a caret (every dep in this package is
  exact-pinned).
- `npx expo install` pins the three natives to the SDK-57-compatible versions —
  same risk class as the already-proven `expo-secure-store` (O2). Do not
  hand-write these versions.
- No `app.json` change: none of the three needs a config plugin for the usage
  here. **Unverifiable locally** (no simulator/device): that Expo Go boots with
  all three linked → qa-mobile-checklist Section A, first item.

# Files: new vs changed

**New (14 source + 6 test):**
`src/offline/{outbox,persist,routing,triggers,parkedCopy,storage,netinfo,ids,runtime,send,useOutbox,useSubmitCreate}.ts`,
`src/features/offline/OfflineBanner.tsx`,
`src/features/transactions/{PendingTransactionRow.tsx,sections.ts}`,
`app/(app)/pending.tsx`,
tests: `src/offline/{outbox,persist,triggers,routing,parkedCopy}.test.ts`,
`src/features/transactions/sections.test.ts`.

**Changed:**

| File | Change | Subtask |
|---|---|---|
| `app/_layout.tsx` | PersistQueryClientProvider; splash gate `Promise.all([coordinator.ready, outbox.ready])`; `startOfflineRuntime()` | M-2, M-3 |
| `src/lib/queryClient.ts` | comment lines 7-13 rewritten: reconnect is LIVE, wired in `offline/netinfo.ts` | M-3 |
| `src/auth/useAuthListener.ts` | purge policy: expiry keeps, logout purges cache+outbox+marker; owner-marker check on `me` | M-2 |
| `src/data/transactions.ts` | export `invalidateAfterTransactionCreate`; `useCreateTransaction.onSuccess` calls it | M-4 |
| `app/(app)/transaction-form.tsx` | create submit via `useSubmitCreate`; queued outcome UX; edit-mode offline gating | M-4, M-5 |
| `app/(app)/category-form.tsx` | offline-disabled Save/Archive + notice | M-5 |
| `app/(app)/_layout.tsx` | register `pending` modal; `MODAL_PARENT_TAB['/pending']` | M-5 |
| `app/(app)/(tabs)/transactions.tsx` | banner; pending rows; `pendingCount` into SummaryHeader | M-5 |
| `app/(app)/(tabs)/categories.tsx` | banner; offline-disabled Add | M-5 |
| `src/features/transactions/TransactionList.tsx` | section source, union rows, keyExtractor, empty-state condition | M-5 |
| `src/features/transactions/SummaryHeader.tsx` | "N pending — not included" | M-5 |
| `src/components/LogoutButton.tsx` | confirm when pending > 0 | M-5 |
| `apps/mobile/package.json` | the five new deps | M-2, M-3, M-4 |

`src/features/transactions/groupByDay.ts` is **not** modified — `sections.ts`
composes over it, so its preserve-server-order guarantee stays untouched.
`packages/api-client` and `packages/shared` are **not** touched by any mobile
subtask (the api-client change is B-1's regeneration).

# Open questions (senior-lead to resolve)

1. **Decision-2 addendum — `display.currency` on `OutboxItem`** (M-1): needed so a
   pending row can render money at all under W7. Confirm the sidecar is acceptable
   vs. the alternative of rendering pending amounts with no currency symbol.
2. **Decision-7 addendum — `runtime.ts` / `routing.ts` / `triggers.ts` /
   `parkedCopy.ts` / `sections.ts`** are files the architecture's module list does
   not name. All are pure or wiring-only and exist to keep logic out of hooks/JSX.
   Confirm.
3. **`MAX_TRANSIENT_ATTEMPTS = 50`** (architecture suggested 30, left open):
   attempts accrue across offline stretches because each trigger costs one
   attempt, so 30 is reachable by a genuinely-offline power user in a day. 50 with
   the enqueue-kick gated on `isOnline()` is the proposal. Confirm the number.
4. **`useAuthListener` semantics change** (M-2): "session expiry no longer clears
   the in-memory Query cache". Required by Decision 1's keep-on-expiry rule, but
   it edits a 1.8-sanctioned behaviour ("no stale user object leaks into a fresh
   session") — the leak is now closed by the owner-marker purge instead. Needs an
   explicit blessing since it weakens one guarantee to satisfy another.
5. **Copy language = English** (M-5), per the grep evidence above. Confirm, or
   scope a separate mobile-i18n task.
6. **Banner placement per tab screen** rather than a navigator wrapper (M-5) —
   confirm the UX call.

# Risks

- **Nothing here is device-verified.** The three native modules, kv-store
  durability across a real restart, netinfo transition behaviour, and the
  Expo Go boot are all Section-A blocked items. The pure cores are covered by
  vitest; the seams are not. Highest-consequence unverified item: kv-store writes
  actually persisting across a cold start — if they silently don't, the outbox
  degrades to in-process only (items survive the session, not a kill) and the
  read cache never hydrates. Both fail SAFE (no data loss beyond what was never
  synced, no duplicates) but the feature would be hollow.
- **Duplicate transactions if B-1's idempotency is imperfect.** The whole
  ambiguous-failure arm (direct network failure ⇒ enqueue same clientId) rests on
  the server's per-user unique index. If B-1 ships without the race-safe
  insert path, a fast double-replay duplicates a financial row. B-1's pytest
  matrix is the gate; mobile must not ship M-4 before it is green.
- **Offline create is unreachable on a cold install** (currency prerequisite,
  M-4). Expected and honest, but it will look like a bug to a tester who wipes the
  app and immediately goes offline — call it out in the QA checklist.
- **Poison-cap parking during long offline stretches** (mitigated by the
  `isOnline()` gate on the enqueue-kick and cap 50): the failure mode is a parked
  item with Retry, never a dropped one.
- **Different-user cache window** (M-2, documented above): bounded by one
  `/users/me` round trip, only after a session expiry, network-only.
- **`PersistQueryClientProvider` interaction with the existing splash gate**: if
  restore is slower than the auth gate, the first paint may show skeletons before
  hydrated data appears. Acceptable; verify on device (Section A).
- **Android back / iOS swipe-back on the new modal** and banner text overflow at
  large font scales: simulator-only checks.

# Obligations checklist (tick at implementation review)

Architecture (binding):
- [ ] D1 persister over `expo-sqlite/kv-store`; allowlist dehydration; hand-bumped buster; maxAge 7d (M-2)
- [ ] D1 purge policy: logout purge / different-user purge via `ownerUserId` marker / session-expiry KEEP (M-2)
- [ ] D2 create-tx is the ONLY offline-capable mutation; all other writes disabled-offline with a notice (M-2/M-5)
- [ ] D2 outbox shape (`OutboxItem`/`OutboxState`/`OutboxDeps`) + hydrate-once + `useSyncExternalStore` (M-1/M-5)
- [ ] D2 FIFO, single-flight replay, deterministic-4xx ⇒ park+continue, transient ⇒ halt, cap ⇒ park, 401 ⇒ halt keep queue (M-1)
- [ ] D3 `client_id` on EVERY create; 200 replay-hit arm treated as success; no hand-edited generated code (M-4)
- [ ] D4 netinfo → `onlineManager` as a HINT (never a gate); trigger union (M-3)
- [ ] D4+ **senior-lead amendment**: enqueue-while-online is itself a replay trigger (M-1 `isOnline` kick + M-4 routing)
- [ ] D5 conflict cases 1–5: park on `CATEGORY_ARCHIVED`, no duplicate on replay, queued items never folded into server caches, no cross-user replay, cache never merged (M-1/M-2/M-5)
- [ ] D6 banner / queued rows rendered FROM OUTBOX STATE (never inserted into the Query cache) / "N pending — not included" / parked cards with Retry+Discard / offline-disabled edits / logout confirm (M-5)
- [ ] D7 module layout under `src/offline/`; nothing promoted to packages; dep list exactly as specified (all)

Mobile-MVP obligations still binding:
- [ ] O2 tokens stay in expo-secure-store; kv-store holds NO auth material; hydrate-once + memory mirror pattern reused (M-1/M-2)
- [ ] O3 single-flight promise is the entire concurrency story for replay; `useSyncExternalStore` over the mirror (M-1)
- [ ] O5 resume seam reused via injection (`auth/resume.ts`), not re-implemented (M-3)
- [ ] O6 no imperative navigation from non-React code; the pending modal is deep-link-safe and in `MODAL_PARENT_TAB` (M-5)
- [ ] O7 app-owned error copy incl. the network arm; every failure has a visible, retryable affordance (M-1/M-5)
- [ ] AM-1.6-a offset stays the pageParam; the persisted key shape is untouched (M-2)
- [ ] AM-1.6-b single archived-inclusive categories cache used for pending-row joins too (M-5)
- [ ] AM-schemas shared `transactionFormSchema` + month helpers unchanged; no forked validation (M-4)
- [ ] W1 no PATCH-body discipline regression (edit path untouched) (M-4)
- [ ] W2 422 narrowed at runtime; codes routed — inline on direct, parked+code on replay (M-4/M-5)
- [ ] W3 archived-inclusive join + "Uncategorized" for `null` on pending rows (M-5)
- [ ] W4 money: integer minor units, `formatMoney` for every render incl. pending rows, no float math, no `toInputString` on signed values (M-5)
- [ ] W5 kind carries the sign; no `type Kind` alias (M-5)
- [ ] W7 no currency collected anywhere; `display.currency` is render-only and never sent (M-1/M-4)
- [ ] W8 replay success runs the SAME invalidation as `useCreateTransaction.onSuccess` — one exported function, two callers (M-4)
- [ ] W9 category affordance gating unchanged; no client-side dedup pre-gate added (M-5)
- [ ] W11 no new `Intl.Collator` usage introduced (M-5)
- [ ] S1/S5 `packages/**` untouched by mobile subtasks; nothing promoted (all)
- [ ] S3 `pnpm typecheck` + `pnpm lint` + `pnpm test` green for `@budget/mobile` before each subtask reports done (all)
- [ ] S4 plain vitest only; no new runner; no expo/react-native import in any test graph (`grep` gate) (all)

PM constraint:
- [ ] Every native import confined to `offline/{storage,netinfo,ids}.ts` (+ `runtime.ts` wiring) — grep-verified
- [ ] Every behavioural rule has a vitest test over fakes; no test imports a leaf
- [ ] Nothing dropped silently: every terminal state is parked + visible + retryable/discardable
- [ ] Device/simulator-only checks are recorded in `qa-mobile-checklist.md` Section A as BLOCKED, never faked
