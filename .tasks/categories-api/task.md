# Task: categories-api (roadmap 1.3)

Verbatim PM description:

TASK (id: `categories-api`, roadmap item 1.3): CRUD API for categories. State: HEAD 3b1fedd — auth works (current_active_user canonical), categories table live with 18 frozen system seeds (user_id NULL) + user categories, kind CHECK ('expense'|'income'), archived bool, icon/color columns exist (color nullable, no DB format check — API validation was explicitly deferred TO THIS TASK).

Scope per roadmap 1.3 and architecture "Категории":
- List endpoint: system + own categories merged (user_id NULL OR user_id = me), architecture says archived excluded by default — decide query param for including archived
- Create: own categories only, name/icon/color/kind; decide dedup policy (same name twice?), color format validation (deferred from 1.2), name length limits
- Update: rename, icon/color change — decide: can kind be changed after creation? (transactions already carry their own kind — the 1.2 sign model means category kind is a default/hint, not the sign authority; surface what update semantics follow)
- Archive (not delete) per architecture — decide: endpoint shape (PATCH archived vs dedicated POST /archive), can system categories be archived by a user? (they're shared rows user_id NULL — a per-user hide would need a new table; decompose this per Phase 3.5, recommend the lean answer)
- System categories: immutable to users (403/404 policy — decide which and be consistent with the 1.1 no-oracle philosophy)
- Authorization: every query filtered by user per architecture §3; user A must never see/touch user B's categories (404 not 403 per no-oracle? decide and pin)
- OpenAPI contract changes → regenerate both artifacts; frontend-engineer contract review (lean role like 1.1) — the client consumes this at 1.6
- Rate limiting: decide if CRUD needs any (probably not — justify)
- Tests: pytest per conventions + QA curl checklist; the 1.1/1.2 test infrastructure (make_client, db_session, seeds) is available

Team: backend + qa + frontend (contract review). Architect: senior-lead's call — CRUD on an existing table is likely NOT structural, justify skipping or invoking (the per-user-hide-of-system-categories question MIGHT be structural if you choose the new-table answer — factor that in).

Process notes from the PM: proceed without waiting; artifacts to .tasks/categories-api/; Phase 4 with per-amendment checklist. Return: team + reasoning, artifact paths, open questions with recommendations. Do NOT start implementation.
