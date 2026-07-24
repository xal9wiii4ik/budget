---
name: implementation-plan
description: Template for implementation plans produced by backend-engineer during grooming. Defines required sections and level of detail. Used in the multi-agent workflow.
---

# Implementation Plan Format

## File location

`<project>/.tasks/<task-id>/plan.md`

## Required sections

````markdown
# Implementation Plan: <task title>

## Approach
<1-3 paragraphs:
- What we're going to do
- Why this approach over alternatives
- Key trade-offs>

## Files to modify

For each file:
- `path/to/file.py` — <what changes, brief why>

## New files

For each:
- `path/to/new.py` — <purpose, key responsibilities>

## Code skeletons

For each significant new function/class, show the signature:

```python
async def new_function(
    arg1: Type1,
    arg2: Type2,
    db: AsyncSession = Depends(get_db),
) -> ReturnType:
    """One-line docstring."""
    # 1. Step
    # 2. Step
    # 3. Step
```

Full implementations only for tricky logic. Keep this lean — don't pre-write the whole feature.

## Existing patterns to reuse

List utilities/services/patterns already in the codebase that this code will use:
- `app/utils/auth.py:require_role()` — for the admin check
- `app/services/notification.py` — to send notifications

If reinventing something, justify why.

## Database changes

If applicable, reference architecture.md. If no architect was invoked but DB changes are minor:
- New column on `users`: `last_login_at TIMESTAMP WITH TIME ZONE NULL`
- Migration: `alembic revision -m "..."`

If DB changes are non-trivial and architecture.md doesn't exist, STOP and tell senior-lead an architect is needed.

## Open questions

Things you weren't sure about. Senior-lead resolves before /implement starts.

## Risks

What could go wrong:
- Backward compatibility
- Performance regressions
- Edge cases that need careful testing
- Migration ordering issues

## Test guidance for QA

Brief notes for qa-engineer on what to test:
- Endpoints affected
- Roles to test against
- Edge cases the implementation might miss
````

## What to keep OUT of the plan

- Full implementations (write them in code, not in plan.md)
- Speculative future work
- Architecture decisions (those go in architecture.md if architect invoked)
- Detailed migration scripts (just reference them)

## Updates during implementation

If reality diverges from plan during coding, update plan.md WITH a note:

````markdown
## Updates during implementation

- [date] Original plan was X, changed to Y because <reason>
````

Don't silently deviate.