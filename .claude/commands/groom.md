---
description: Start grooming a new task — senior-lead picks team, produces plan + QA checklist
argument-hint: <task description>
---

You are starting the grooming phase for a new task.

Task description from user: $ARGUMENTS

If $ARGUMENTS is empty, ask the user: "Опиши задачу для груминга."

## What to do

1. Invoke the **senior-lead** agent with the task description
2. senior-lead will follow the `grooming-workflow` skill:
   - Understand task
   - Select team (must explain selection)
   - Invoke architect (if needed), backend-engineer, qa-engineer
   - Coordinate their output
   - Save artifacts to `.tasks/<task-id>/`
   - Hand off to user with summary

3. At the end, the user should see:
   - Which agents were used and why
   - Links to plan.md, qa-checklist.md, and architecture.md (if exists)
   - Any open questions
   - Instruction: "Ready for /implement когда подтвердишь план"

Do NOT skip senior-lead's decision-making step. The point of grooming is that the senior-lead actively coordinates, not just relays.