# mobile-offline (roadmap 5.5) — scope grooming brief (verbatim from PM)

SCOPE (id: `mobile-offline`, roadmap 5.5): local persistence (expo-sqlite or the
architect's alternative — decide honestly incl. whether TanStack Query persister
over AsyncStorage/SQLite is the leaner answer vs a hand-rolled mirror), write
queue for offline mutations (create tx at minimum; decompose which mutations are
offline-capable vs online-only), sync/replay on reconnect with idempotency
(server has no idempotency keys — decompose: add one to the API (contract
change, FULL) vs client-side dedup; surface the fork, recommend), conflict
semantics, UI affordances (offline banner, queued-item indication, failed-replay
surfacing per the mobile-engineer conventions).

CONSTRAINT FROM PM (binding, applies to every agent): verification is DEGRADED —
no simulator, no device (re-probed 2026-08-18: `xcrun simctl` unavailable,
CommandLineTools only). Everything must be architected for maximum vitest-ability
(pure sync-queue logic with DI'd storage/network seams), the checklist splits
simulator/manual arms honestly (blocked-environment, never faked), and the
design must be defensive enough to ship untested-on-device: conservative
conflict policy, no destructive merges, server always wins on conflict unless
trivially safe.

The mobile app is STILL the 1.8 MVP (no receipts/currencies/goals/stats screens
on mobile). Offline means offline for the MVP screens (tx list/create,
categories, summary) ONLY. Do not grow mobile feature parity in this scope.

Expected tiers: sync-queue core + any API change = FULL; UI affordances =
STANDARD. Outputs: architecture.md, plan-mobile.md (+plan.md ONLY if an API
change is chosen), qa-mobile-checklist.md (honest Section A blocked-environment
/ Section B manual), grooming-review.md.

Implementation sequenced AFTER the recurring-and-limits scope — grooming only.
