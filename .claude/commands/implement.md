---
description: Implement the task per the plan from /groom
argument-hint: [task-id, optional — defaults to most recent]
---

You are starting the implementation phase.

Task ID (if provided): $ARGUMENTS

## What to do

1. **Locate the task.**
   - If $ARGUMENTS specifies a task-id, use `.tasks/$ARGUMENTS/`
   - Otherwise, use the most recently modified `.tasks/<task-id>/` directory
   - If no .tasks/ directory exists, tell user: "Нет grooming артефактов. Запусти /groom сначала."

2. **Verify readiness.**
   - `plan.md` must exist
   - `qa-checklist.md` must exist
   - Open questions in plan.md must be resolved (no "TBD" entries)

3. **Invoke senior-lead** to coordinate implementation:
   - senior-lead invokes backend-engineer with the plan
   - backend-engineer writes the actual code, following plan.md
   - If backend discovers the plan is wrong, it stops and tells senior-lead
   - senior-lead reviews work-in-progress, pushes back if needed

4. **At the end:**
   - All planned files are modified/created
   - Code matches plan.md (or plan.md was updated with deviations + reasons)
   - run command /review_senior or if user specifed command command from user
   - run command /clean-check
   - Tell user: "Реализация готова. Запускай /test для прогона QA-чеклиста."

Do NOT proceed to /test or /review_senior automatically — those are separate user-triggered steps.