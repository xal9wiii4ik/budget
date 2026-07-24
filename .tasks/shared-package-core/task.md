# Task: shared-package-core (roadmap 0.4)

Verbatim PM description:

Give `packages/shared` its real content — the utilities both clients (web 1.5+,
mobile 1.8+) will consume. State: HEAD 309b848; shared currently exports only
PACKAGE_NAME with one placeholder test.

Scope per roadmap 0.4 and the architecture doc:
- Money formatting/handling in integer minor units: minor↔display conversion,
  per-currency exponent (JPY=0, KWD=3, etc.), locale-aware formatting
  (Intl.NumberFormat), parsing user input ("12.50" → 1250) with validation.
  NEVER float arithmetic on amounts — decide the exact safe patterns
- Currency registry: ISO-4217 subset decision (full list vs curated),
  code→exponent/symbol data, and the base-currency concept
- Date formatting helpers scoped to what clients actually need (occurred_at is
  a date, created_at datetime — architecture doc)
- Zod schemas for forms shared web+mobile (architecture doc names zod): at
  minimum the transaction form shape (amount input, currency, category, date,
  note) — but 1.4/1.5 define the actual forms, so decide how much lands NOW vs
  then (YAGNI tension — surface it, don't bury it)
- PACKAGE_NAME export: keep or retire (mobile/web smoke tests bind to it —
  check who still imports it before deciding)
- Real vitest tests replace the placeholder; the pytest-conventions
  no-vacuous-tests spirit applies to TS too
- zod dependency decision: version (v4 is current in 2026 — verify), where it's
  declared, hoisted-linker implications

Team: senior-lead's call, justify. frontend-engineer owns the package per
standing split; mobile-engineer should REVIEW the API surface (Intl
availability/Hermes quirks on RN are a real risk — decide if that's a
review-only role or a plan contribution); architect only if the API surface is
judged structural; qa-engineer likely not (pure functions, vitest is the gate)
— justify.

Process notes: proceed without waiting; artifacts to
.tasks/shared-package-core/; keep lean — utilities task, not a framework; every
export must have a consumer on the 1.x horizon, name the consumer in the plan.
Phase 4 review MUST include the per-amendment checklist. Return: team +
reasoning, artifact paths, open questions with recommendations. Do NOT start
implementation.

Binding carry-forwards in force:
- 0.1 §1.3 scaffold-lifetime rule: `packages/shared/src/index.test.ts`
  placeholder MUST die in this task.
- 0.1 §1.1 root-file ownership = backend-engineer (contingency only — no root
  change currently forced).
- 0.1/0.2 retro: per-amendment checklist required in implementation reports.
- 0.3 note: @types/node is repo-visible under the hoisted linker.
