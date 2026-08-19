# Grooming review: mobile-offline (roadmap 5.5)

Senior-lead Phase 4. Scope grooming per grooming-workflow scope mode.
Implementation is sequenced AFTER recurring-and-limits — nothing here starts.

## 1. Team

Invoked: architect (new persistence layer + sync-queue module + a cross-service
contract change — squarely his gate), backend-engineer (plan.md, B-1 — the
idempotency fork resolved to an API change), mobile-engineer (plan-mobile.md,
M-1..M-5), qa-engineer (B-1 is a FULL API contract change — light rule does not
apply), mobile-qa (qa-mobile-checklist.md).
NOT invoked: frontend-engineer/web-qa (no web surface — web is untouched by the
additive optional field; plan.md O-13 escalates if typecheck disproves that),
code-reviewer (arrives at /review_senior of the FULL subtasks).

## 2. The idempotency fork — DECIDED (PM confirmed 2026-08-18)

API change (architect Decision 3): optional `client_id: UUID | None` on
`TransactionCreate`, per-user partial unique index, select-first hit ⇒ 200 with
the stored row and zero side effects, IntegrityError rollback+re-select race
recovery, first-write-wins. Client-side dedup was rejected as broken, not
cheaper (fetch's sent-or-not ambiguity forces silent loss or duplication).
Replay-hit status = **200** (architect Q1 recommendation, ratified).
Rationale ratified by senior-lead: the backend is the one arm where verification
is NOT degraded (pytest + curl), so the correctness-critical invariant lives
there.

## 3. Plan verdicts (senior-lead review against architecture.md)

**plan.md (B-1): ACCEPTED as written.**
- Hit-before-validation ruling (§3.2) is correct and test-pinned (test 6:
  replay-after-archive still 200). Placing the hit after `_validate_category`
  would 422 a booked row — exactly the divergence idempotency exists to prevent.
- The `client_id is not None` lookup guard is the realistic catastrophic bug and
  is pinned (test 4).
- Race recovery: rollback → re-select → None-means-re-raise keeps foreign
  IntegrityErrors untouched. First house IntegrityError recovery — deliberate,
  one place, documented. Accepted.
- Index name `uq_transactions_user_id_client_id` (house spelling) accepted over
  the architecture's illustrative `uq_transactions_user_client`.
- §5.7's internal mock is the documented rare exception (simulates a scheduling
  window); the honesty note on test 7's probabilistic coverage stands (O-12).

**plan-mobile.md (M-1..M-5): ACCEPTED with one binding amendment (below).**
- Conforms to Decisions 1-7 + the senior-lead enqueue-while-online amendment
  (M-1 test 12, obligations D4+).
- Grep gate for native confinement (storage/netinfo/ids + runtime only) adopted
  as a diff-gate item.
- M-2-prerequisite-of-M-4 claim VERIFIED by senior-lead against
  `app/(app)/transaction-form.tsx` (`createDegraded = !isEdit && !currencyKnown`,
  currency from `summaryQuery.data?.currency`): offline create requires the
  month summary in the persisted cache. **Baked into the dependency order: M-4
  depends on B-1, M-1 AND M-2 (hard).**

## 4. Mobile plan open questions — RULINGS (PM leans folded, 2026-08-18)

| # | Question | Ruling |
|---|---|---|
| 1 | `display.currency` sidecar on OutboxItem | **ACCEPT** — W7-compatible render-only sidecar; the M-1 test-17 leak guard (`toWireBody` emits exactly TransactionCreate keys) is MANDATORY |
| 2 | Five extra pure/wiring files beyond the architecture's module list | **ACCEPT** — the vitest-ability constraint justifies them; runtime.ts mirrors lib/api.ts precedent |
| 3 | MAX_TRANSIENT_ATTEMPTS=50 + isOnline-gated enqueue-kick | **ACCEPT** |
| 4 | useAuthListener no longer clears cache on session EXPIRY | **ACCEPT with a binding amendment** (below) — this rewrites a 1.8 cache-isolation guarantee; M-2 bumped to FULL tier |
| 5 | English copy (grep-proven: mobile has zero Russian user-facing strings) | **ACCEPT** — mobile-i18n recorded as its own future scope |
| 6 | Pending section top-pinned (not interleaved) + `/pending` modal + per-screen banner | **ACCEPT** — the not-interleaved argument (queued ≠ booked; summary excludes it) is the honest UX |

**Binding amendment on ruling 4 (PM-directed):** M-2 must lift purge execution
out of the hook into a DI'd executor — `runOfflineAction(action, deps)` where
deps carry `{clearQueryCache, removePersistedCache, clearOutbox, removeOwnerMarker,
adoptOwnerMarker}` — with vitest coverage asserting: (a) `purge/different-user`
fires ALL FOUR purge effects; (b) `adopt-owner` after a different-user purge runs
strictly AFTER the purge effects; (c) `session-expired` fires none. The
cross-user cache-bleed guarantee formerly enforced by clear-on-any-signout is
now enforced by the owner-marker purge — that compensating test is the gate for
shipping the weakened listener.

## 5. Review-tier table (final)

| # | Subtask | Depends on | Tier | Note |
|---|---|---|---|---|
| B-1 | client_id migration + POST idempotency + pytest + contract regen | — | **FULL** | money-adjacent contract change; fully verifiable (pytest+curl) | **MOVED 2026-08-19 → scope mcp-server S1 (do not redo)** |
| M-1 | Outbox pure core + 17-test vitest suite | — (parallel with B-1) | **FULL** | sync-queue core |
| M-2 | Persistence wiring + purge policy + runOfflineAction executor | M-1 | **FULL** (bumped from STANDARD) | security-adjacent: rewrites the 1.8 clear-on-signout guarantee |
| M-3 | Connectivity: netinfo→onlineManager + trigger union | M-1 | STANDARD | |
| M-4 | Create-tx routing: clientId everywhere, enqueue policy, W8 invalidation extraction | **B-1, M-1, M-2 (hard)** | **FULL** | decides what reaches the wire |
| M-5 | UI affordances: banner, pending section, /pending modal, disabled writes, logout confirm | M-2, M-3, M-4 | STANDARD | banner/disabled-writes can start earlier |

Senior-lead diff gate applies to every subtask regardless of tier. FULL
subtasks get code-reviewer at /review_senior; STANDARD get engineer
self-review via /review-pr.

## 6. Architect defaults ratified (veto window: before the owning subtask's /implement)

- Q2 parked items are Discard-only (no editing) — ratified.
- Q3 logout with pending ⇒ confirm-then-discard — ratified.
- Q4 persisted-cache maxAge 7 days — ratified.
- Q5 client_id on ALL creates (one code path; makes the direct-failure enqueue
  arm safe) — ratified.

## 7. Environment status for /test (probed 2026-08-18)

Xcode.app installed; `xcode-select -p` → Xcode.app; `xcrun simctl` responds.
The senior-lead probe mid-download saw an empty runtime list; **PM verified
later the same day that the iOS 26.5 runtime IS installed with devices
available (iPhone 17 Pro et al.)** — TC-0 (the checklist's runtime gate probe)
is expected to PASS and Section A (22 TCs) runs FOR REAL at /test. The TC-0
probe discipline stays regardless — Section A is never assumed. The 1.8 backlog of 44
on-device TCs (.tasks/mobile-mvp/qa-mobile-checklist.md) remains pending and is
not re-listed.

## 8. Carry-forwards (durable record; each future grooming reads this)

- **mobile-i18n:** mobile user-facing copy is English throughout; localisation
  is its own scope (every existing string + a mechanism), not piecemeal.
- **Offline for post-MVP mobile surfaces** (receipts/currencies/goals/stats,
  recurring/limits): explicitly OUT of this scope; when mobile gains those
  screens, offline-capability per mutation must be re-decided against this
  scope's Decision 2 framework (idempotency key exists by then).
- **Web offline:** the browser is its own story; nothing here promotes.
- **Idempotency generalisation trigger:** if any OTHER endpoint ever needs
  replay-safety (e.g. recurring instances), generalise B-1's pattern
  (per-user client_id + partial unique index), do not invent a second one.
- **Rate limit on POST /transactions (binding):** none exists today
  (grep-confirmed, plan.md §3.4). If one is EVER added, the idempotent-replay
  arm must be exempt (or throttled-not-parked), otherwise an outbox flush after
  a long offline stretch parks rows the server already booked. Any future
  rate-limiting scope must read this line.
- **Replay-after-DELETE resurrection (known v1 semantic):** a queued create
  replayed after the user deleted the created row from another client re-creates
  it (the key is only as durable as the row). Accepted for v1 — single-user,
  delete is online-only on mobile so self-inflicted resurrection is impossible.
  Revisit trigger: a real multi-device delete-while-queued complaint ⇒ tombstone
  table then, not now.
- **NetInfo captive-portal behavior** and kv-store cold-start durability are
  Section A/B items; if kv-store durability fails on device, the recorded
  fallback posture is "outbox degrades to in-process, fails safe, feature
  hollow — fix before release", not a silent ship.

## 9. QA artifacts — coverage verdict (Phase 4 gate)

**qa-checklist.md (B-1): ACCEPTED.** 15 TCs (TC-B1-1..14 + TC-Z1). The
pytest/curl split is explicit and non-duplicative (§"Covered by pytest" table).
Two TCs add coverage nobody planned and both stay: TC-B1-7 (UUID spelling
canonicalization — uppercase/urn/braced replays must hit 200, any 201 is a
silent double-book) and TC-B1-12 (client_id on PATCH is inert). DDL-level index
proof and the destructive migration cycle run against budget_test only — house
precedent honored. All TCs ⏸ EXECUTE-AT-/test; nothing was run at grooming.

**qa-mobile-checklist.md: ACCEPTED.** TC-0 runtime-gate probe + 22 conditional
Section A TCs + 11 Section B manual-device items. Every "Not verifiable here"
list entry and every plan-mobile.md Risk maps to a TC (checklist §"Obligation
coverage map" verified). The offline-simulation method statement is honest
(kill-API vs Mac-network-off vs real radio, per TC). The cold-install degraded
create (TC-16) is correctly written as expected-behavior-not-bug. Section B
items are user-run; mobile-qa never marks them passed. 1.8's 44 inherited
on-device TCs referenced, not re-listed.

No gaps found between plans and checklists. No conflicts between agents
remained unresolved.

## 10. Rulings on qa-engineer's B-1 questions (PM leans folded, 2026-08-18)

| # | Question | Ruling |
|---|---|---|
| Q1 | Replay-after-DELETE resurrects the row (TC-B1-13) | **ACCEPT + document** for v1. Tombstoning is over-engineering for a single-user app; the mobile client cannot self-inflict it (delete is online-only, and a user deleting a row they can see means it already synced). Recorded in §8 with a revisit trigger. TC-B1-13's expected 201-new-id stands as the documented semantic. |
| Q2 | UUID spelling / canonicalization | **Mandated**: M-4 mints client_id via `expo-crypto` `Crypto.randomUUID()` — lowercase-canonical by construction (already the plan-mobile.md M-4 spec; now a binding obligation: any future id source must emit canonical lowercase). Server-side canonicalization test TC-B1-7 stands as written — any 201 from a spelling variant is a ❌ finding. |
| Q3 | 200 vs 201 on replay hit | **RULED: 200** (architect recommendation, PM-confirmed §2). TC-B1-2/-3/-7/-8 assertions stand as written. Plan.md §8-Q1's 201 fallback is dead. |
| Q4 | No rate limit on POST /transactions | **Accepted for this scope**; the future-limit-must-exempt-replay note is a BINDING carry-forward (§8). |
| Q5 | client_id absent from TransactionRead ⇒ reconciliation by returned id | **Confirmed as the deliberate design.** The outbox dequeues on the send's resolved response; a crash between server commit and the client ack leaves the item queued, and the next replay is a 200 hit that dequeues it — no id persistence needed, no tombstone, no read-side field. |

## 11. Ready state

Scope groomed. All forks decided, all agent questions ruled, artifacts
complete: architecture.md, plan.md (B-1), plan-mobile.md (M-1..M-5),
qa-checklist.md, qa-mobile-checklist.md, grooming-review.md. Implementation is
SEQUENCED AFTER recurring-and-limits — on PM's go, B-1 and M-1 start in
parallel; every subtask ticks its plan obligations + the §4/§10 amendments.
No commits were made during grooming.
