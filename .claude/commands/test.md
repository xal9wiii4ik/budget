---
description: Run pytest suite and QA curl checklist against running server
argument-hint: [task-id, optional]
---

You are starting the testing phase. This runs BOTH pytest and curl verification.

Task ID (if provided): $ARGUMENTS

## What to do

1. **Locate the task** (argument or most recent `.tasks/<id>/`)

2. **Verify** that `qa-checklist.md` exists and has both sections (A: pytest, B: curl).
   Code must already be implemented.

3. **Invoke qa-engineer** to run BOTH:

   **Step 3a: pytest verification**
   - Run `make test`
   - Capture pass/fail per pytest test case (Section A)
   - Update statuses in qa-checklist.md
   - If anything fails: qa-engineer does NOT fix the code. Reports back to senior-lead.

   **Step 3b: curl checklist**
   - For each CT in Section B:
     - Run the curl command
     - Compare actual to expected
     - Update status, capture response
   - If any CT fails: same — escalate to senior-lead.

4. **Write final summary** with split counts (see qa-checklist skill).

5. **Output to user:**
   - Pytest: pass/fail
   - Curl: pass/fail
   - If both green: "✅ Все тесты прошли. Запускай /review_senior."
   - If anything failed: "❌ <summary>. Senior-lead решает что делать дальше."

Local server is assumed running (uvicorn / docker).