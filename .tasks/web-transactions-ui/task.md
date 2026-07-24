# Task: web-transactions-ui (roadmap 1.6)

Verbatim task description from PM:

---

TASK (id: `web-transactions-ui`, roadmap item 1.6): The MVP's main screens. State: HEAD 1603736 — auth flow works end-to-end in the browser (protected /transactions stub exists), all API surfaces typed in api-client, TanStack Query + react-router 7 + RHF + zod wired, CSS modules pattern started (no UI framework — decide if that continues or a component lib enters NOW; architecture says no; my PM lean: stay lib-free for MVP, CSS modules; you rule).

Scope per roadmap 1.6:
- Transactions list screen: month picker (default current), day-grouped list (occurred_at DESC per API), amount rendering via shared formatMoney with kind sign presentation (decide: minus prefix for expense? color?), category name/icon join (include_archived=true set per obligation), pagination/load-more if >200 in month (decide lean answer), empty/loading/error states
- Add/edit transaction form: amount input via shared parseMoney (minor units!), kind toggle driving category filter (expense categories for expense etc. — but category optional), category picker (grouped, archived hidden for NEW; amount-only edits allowed on archived-cat txs per 1.4 decision e), date picker (default today, future allowed), note (500 cap aligned), currency display-only (profile base RUB per AM-4 — API stamps it), delete with confirmation
- Categories management screen: merged list grouped by kind, create/rename/icon/color/archive per the 1.3 obligations, system categories visually distinct + edit-gated
- Monthly summary header: income/expense/net from GET /transactions/summary, formatMoney rendering (negative net fine), by_category breakdown display (composite keys!)
- Profile query: GET /users/me + profiles base_currency — wait: check what the API actually exposes for profile/base_currency (profiles table exists but is there a GET endpoint? If NOT — this is an API gap; the summary returns currency so maybe sufficient; VERIFY and decide — if an endpoint is needed, that's a backend addition to scope or an accepted workaround)
- Me-query error affordance + bounce authed off /login (1.5 deferrals)
- Query architecture: query keys, invalidation strategy after mutations (transactions list + summary must both invalidate), optimistic updates (decide: worth it for MVP? lean answer)
- vitest for pure logic (form mapping, key builders); web-qa browser checklist for journeys

Team: frontend-engineer (implements), web-qa (checklist + browser run), backend-engineer ONLY if the profile-endpoint gap is real and you rule an API addition (then contract regenerates + qa-engineer for the endpoint); architect not needed unless you disagree. Mobile review not needed (1.8 reads the obligations lists).

Process notes from the PM: proceed without waiting; artifacts to .tasks/web-transactions-ui/; Phase 4 with per-amendment checklist ticking ALL 18+ accumulated obligations individually; /review_senior will run (main MVP screens). Return: team + reasoning, artifact paths, open questions with recommendations. Do NOT start implementation.

---

Accumulated obligations this task consumes (see obligations.md for the consolidated tick-list):
- .tasks/categories-api/contract-review-web.md — 8 obligations
- .tasks/transactions-api/contract-review-web.md — 10 obligations
- .tasks/web-auth-flow/meta-review.md — 4 carry-forwards (findings 6, 8; email-TLD note; AM-7 body-preservation tripwire)

Standing rules: root ownership, lint gate every round, contract untouched unless API changes (senior ruled: none — schema.d.ts must remain byte-identical).
