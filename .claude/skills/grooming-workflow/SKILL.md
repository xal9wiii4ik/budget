---
name: grooming-workflow
description: Defines the structure and outputs of the grooming phase — how senior-lead coordinates qa-engineer, backend-engineer, and optionally architect to produce a complete implementation plan. Use when starting work on any new task via /groom.
---

# Grooming Workflow

The grooming phase transforms a task description into:
- An implementation plan
- A QA checklist
- Optionally, an architecture plan

## Phases

### Phase 1: Task understanding (senior-lead)

1. Read user's task description
2. Restate it: "Я понял задачу так: <restatement>. Верно?"
3. Wait for user confirmation OR proceed if user is impatient
4. Create `<project>/.tasks/<task-id>/` directory
5. Write `<project>/.tasks/<task-id>/task.md` with the verbatim user description

### Phase 2: Team selection (senior-lead)

State explicitly:
- Which agents will be invoked and why
- Which agents will NOT be invoked and why

Default team: backend-engineer + qa-engineer.
Add architect if any of these are true:
- New DB tables
- New modules
- Cross-service changes
- Changes affecting >3 files structurally

### Phase 3: Parallel-ish work

Order:
1. (Optional) architect produces `architecture.md`
2. backend-engineer produces `plan.md` (using architect's plan if exists)
3. qa-engineer produces `qa-checklist.md` (using plan.md to know which endpoints to test)

QA can start work in parallel with backend once enough is in plan.md.

### Phase 3.5: Decision decomposition (senior-lead + architect/backend)

A task description names *features* ("search by address", "sort by date",
"bulk delete", "needs-attention flag"). Each feature hides several concrete
implementation decisions the user has NOT made yet. Grooming's job is to surface
them — not to silently pick one and bury it in the plan.

For every non-trivial requirement, especially **search / filter / sort / bulk /
status-and-flag** requirements, run these three passes:

1. **Enumerate the decision points.** Break the feature into the concrete
   choices it forces. Example — "one search field":
   - How does an id term behave — exact match, or substring like the rest?
   - Which physical fields does each search term hit?
   - Does the single field map to one query, or dispatch by input shape?

   Each such choice becomes an explicit open question **with a recommendation**,
   not one coarse "how should search work?".

2. **Map each searched/filtered/sorted field to its physical storage, and flag
   mismatches.** A requirement that reads atomic ("search by address") may be
   several columns underneath (`street`, `city`, `state`, `zip`, `country`), or
   one column that must be split, or data owned by another service. Whenever the
   logical field and the physical storage don't line up 1:1, that mismatch is a
   design decision to surface (concatenate? tokenize? cross-service read?), never
   an implementation detail to decide alone.

3. **Assess index / performance impact of every new query pattern — even when the
   answer is "no index needed".** Any new `WHERE` / `ORDER BY` / `JOIN` shape gets
   an explicit written verdict: does an existing index cover it, is a leading-
   wildcard `ILIKE` un-indexable, is the per-tenant row count small enough to scan?
   Record the decision (and any future trigger, e.g. "add pg_trgm at N rows") so a
   later reader sees a deliberate choice, not an oversight.

4. **Decide the response shape explicitly — never inherit it.** For any endpoint
   that returns an entity, the wire shape is a decision, not a byproduct of "reuse
   the existing serializer". Surface each of these as its own open question:
   - **Projection**: lean list DTO (only what the caller renders) vs full object.
     A list endpoint returning the raw ORM model is a buried default — call it out.
   - **Nested collections**: embed vs reference-by-id (separate fetch). State the
     payload cost of embedding and the round-trip cost of referencing.
   - **Field redundancy**: a field already carried by a nested object (`location_id`
     next to `location.id`), or duplicated under a grouping — flag for removal.
   - **Field meaning per context**: the same concept may be a `bool` on a row and a
     `count`/`int` in an aggregate — say so, don't let the reader guess.

The output of this phase is a set of sharp, individually-answerable open questions
carried into Phase 5 — not buried defaults.

### Phase 3.6: Verification gates (must pass before Phase 5 handoff)

Three checks that catch the errors decomposition alone misses. A grooming that
skips them ships confident-but-wrong artifacts.

1. **Cross-service verification gate.** Whenever a requirement names or implies
   another service (ms-providers, ms-menu, gateway, shared_library) — **read that
   service's actual handler / serializer / enum before asserting anything about
   its capabilities or blockers.** Never state "X is supported / blocked" from
   memory or inference. Then classify every action the feature needs as one of:
   *ours* (we build it), *passthrough* (FE calls the other service directly through
   the gateway — we only document it), or *blocked* (needs a change in the other
   service — name the exact enum/handler/contract to change and who owns it).
   Getting this wrong invents endpoints we don't own and misses real blockers.

2. **Reuse-existing-operation gate.** Before designing any new endpoint, status
   vocabulary, or field, locate the existing single-entity or canonical operation
   and prefer **generalizing it** over inventing a parallel one. Bulk delete →
   check for an existing status/state-machine transition and generalize that.
   A new status enum → check whether the model already has one (`subscription_status`)
   and reuse its vocabulary. This is the CLAUDE.md "find how this codebase already
   solves it" principle applied with teeth.

3. **Intent-confirmation gate.** When an agent *infers* a requirement the user did
   not state (e.g. "this flag is derived, not stored", "the writer is a sync job"),
   it must (a) mark it explicitly as an assumption, and (b) present the **minimal**
   interpretation, not build elaborate machinery on top of a guess. Speculative
   cross-service infrastructure erected on an unconfirmed intent is the most
   expensive kind of rework. Ask "stored or computed?" — don't pick and build.

### Phase 4: Senior review of artifacts

Senior-lead reads all artifacts and:
- Identifies conflicts (e.g., backend says approach A, architect said B)
- Identifies gaps (e.g., qa-checklist misses an endpoint that's in plan.md)
- Sends artifacts back to authors for revision OR accepts

### Phase 5: Handoff to user

Output to user:
- Summary of team selection
- Links to artifacts in `.tasks/<task-id>/`
- Open questions — every decision point surfaced in Phase 3.5 that the user has
  not already settled, each phrased as a specific either/or with a recommendation.
  A grooming that produced zero open questions for a search/filter/sort/bulk
  feature almost certainly buried a default — go back and decompose.
- "Ready for /implement" if no questions

## Output file structure
<project>/.tasks/<task-id>/
├── task.md              # original user request, verbatim
├── architecture.md      # (optional) from architect
├── plan.md              # from backend-engineer
├── qa-checklist.md      # from qa-engineer
├── review.md            # from code-reviewer (later)
└── meta-review.md       # from senior-lead (later)

## Task ID format

Kebab-case, max 5 words, derived from task description.
Examples:
- "Add rate limiting on login" → `add-login-rate-limit`
- "Fix N+1 in user list endpoint" → `fix-user-list-n-plus-one`
- "Refactor auth module to use new permission system" → `refactor-auth-permissions`

## Scope grooming mode (PM policy since 2026-07-26 — the DEFAULT)

Groom SCOPES, not individual tasks. A scope is a coherent feature cluster
(e.g. a roadmap stage: "чеки и OCR" = storage + parse pipeline + confirm UI +
merchant autocategorization). One grooming run per scope produces, in
`.tasks/<scope-id>/`:

- `architecture.md` — decisions for the whole scope (architect invoked once)
- `plan.md` / `plan-web.md` / `plan-mobile.md` — implementation plans with an
  explicit **subtask breakdown**: ordered subtasks with dependencies, each
  small enough to implement in one engineer run
- `qa-checklist.md` — QA strategy for the scope, mapped to subtasks
- `grooming-review.md` — Phase 4 as usual, plus a **review-tier tag per subtask**
  (full / standard / fast — see senior-lead.md "Review tiers")

Subtasks then go straight to implementation against the scope plan — they get
NO individual grooming. The senior-lead diff gate and tests still apply to
every subtask. If implementation reveals the scope plan is wrong, stop and
re-groom the affected part — don't silently deviate.

Per-task grooming (the phases above) remains for: standalone risky tasks
outside any scope, and security-critical work the PM explicitly flags.

**Trivial-task fast path:** a task that repeats an established, previously
groomed pattern (e.g. another CRUD router following the categories/transactions
precedent) skips grooming entirely — implement directly against the precedent
in `.tasks/`, diff gate + tests still mandatory.