# Task: mobile-mvp (roadmap 1.8) — verbatim PM brief

TASK (id: `mobile-mvp`, roadmap item 1.8): The Expo mobile client reaches MVP parity
with web. State: HEAD ed51ea0 — apps/mobile is the 0.1 scaffold (expo-router Stack,
one screen rendering formatMoney canary, plain vitest wiring test); web has proven
all the patterns: auth coordinator, query keys/invalidation tables, patch builders,
error mapping, form schemas — ALL in apps/web or packages/*; the mobile task's design
center is what to reuse vs re-implement.

Scope per roadmap 1.8 (MVP screens on the ready API):

- Auth: login/register screens, token storage in expo-secure-store (NOT AsyncStorage
  — mobile-engineer's own agent rules), the coordinator pattern per the recorded 1.8
  obligations (async-hydrate-once into memory mirror, sync snapshot, single-flight
  refresh; NO cross-tab machinery — single runtime; verify Request.clone() in RN or
  use the recorded fallback)
- Transactions: month list with summary header, add/edit/delete with parseMoney
  minor units, category picker (kind-segmented per AM-1.6-c), date picker, note
- Categories: list grouped by kind, create/rename/icon/color/archive, is_system gating
- Navigation: expo-router tabs or stack (decide), protected-route pattern (redirect
  to login when no tokens)
- API base URL config for dev (Expo device → host machine IP vs localhost — decide
  the dev convention honestly; simulator vs Expo Go on device differ)
- Data layer: same TanStack Query patterns as web — decide what physically moves to
  a shared location vs gets re-implemented (query keys? patch builders? error maps?
  — the web versions import web-only things? verify and decide per module; do NOT
  create a shared package speculatively — only move code that both clients genuinely
  consume)
- Testing: decide the test runner story NOW (0.1 deferred jest-expo to here) — what's
  unit-testable in plain vitest vs needs jest-expo vs falls to mobile-qa on
  simulator; mobile-qa joins for the FIRST time: their checklist covers
  simulator-runnable journeys (Section A) + manual device checklist (Section B) per
  their agent conventions
- UI: React Native primitives, no UI framework (consistent with web's lib-free
  stance) — confirm or challenge

Team: mobile-engineer (implements), mobile-qa (FIRST invocation — simulator + manual
checklist), frontend-engineer narrow consult ONLY if a web module gets promoted to
shared (they own the web side of that move), backend not needed (assert contract
untouched). Architect: senior-lead's call on the reuse-boundary question — it's
cross-package structure; justify either way.

Process notes from the PM: proceed without waiting; artifacts to .tasks/mobile-mvp/;
Phase 4 with per-amendment/obligation checklist covering ALL the 1.8-targeted
carry-forwards; /review_senior will run. iOS simulator available on this Mac
(xcrun simctl); Expo Go boot check was proven at 0.1. Do NOT start implementation
during grooming.

Standing rules restated: root-file ownership = backend (so no plan.md here — mobile
writes plan-mobile.md); per-amendment checklist; full lint gate every round;
contract untouched (no API changes); PG on localhost:5443; jest-expo was deferred to
exactly this task at 0.1 (scaffold-lifetime rule: mobile's placeholder wiring test
dies here if superseded).
