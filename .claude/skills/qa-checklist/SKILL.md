---
name: qa-checklist
description: Template and conventions for QA test checklists in the multi-agent workflow. Used by qa-engineer when producing testing plans. Defines the markdown format, status icons, and curl-based test conventions.
---

# QA Checklist Format

## File location

`<project>/.tasks/<task-id>/qa-checklist.md`

## Structure

The checklist has TWO sections, both produced collaboratively at grooming:

```markdown
# QA Checklist: <task title>

## Scope
<What this checklist covers and what it doesn't>

---

## Section A: Pytest test cases
*Owned by backend-engineer. Backend writes these in `tests/` during implementation.*

### PT-1: <short name>
- **Type**: pytest (class-based, in `tests/<module>/test_<file>.py`)
- **Scenario**: <what's being tested>
- **Mocks needed**: <which external boundaries to mock, or "none">
- **Assertions**: <key things to verify — HTTP code, DB state, mock calls>
- **Status**: ⏸ pending (will become ✅ when `make test` is green)

### PT-2: <name>
...

---

## Section B: Curl test cases
*Owned by qa-engineer. Run against live server during /test phase.*

### CT-1: <short descriptive name>
- **Method**: <GET/POST/PUT/PATCH/DELETE>
- **Endpoint**: <path>
- **Auth**: <none / user / admin / specific role>
- **Setup**: <prerequisites, e.g., "CT-0 must pass first">
- **Headers**:
```
  Authorization: Bearer $TOKEN
  Content-Type: application/json
  Body (if applicable):

json  {"field": "value"}

Expected:

Status: <code>
Body contains: <fields/values>
Side effects: <e.g., "record exists in DB with status=X">


curl:

bash  curl -X <METHOD> http://localhost:8000<path> \
    -H "Authorization: Bearer $TOKEN" \
    -d '<body>'

Actual (filled in after run):

  <status code + response body>

Status: ⏸

## Split rules: pytest vs curl

When grooming, decide per scenario:

**Goes to pytest (Section A):**
- Business logic with branches
- Custom validation beyond Pydantic
- External integration success AND failure paths
- DB consistency after partial failures
- Edge cases (empty input, boundaries, idempotency)
- Authorization beyond simple "logged in" check

**Goes to curl (Section B):**
- Happy path live verification (does the deployed thing actually work?)
- Integration with real services (DB, cache, message queue) end-to-end
- Manual checks that the user would do
- Anything that needs a real HTTP roundtrip to mean something

**Goes to BOTH:**
- Critical paths where pytest covers logic and curl confirms it works live
- Document WHY in the TC description if it's in both

**Not tested:**
- Pure Pydantic validation (Pydantic tests itself)
- 401/403 on every endpoint (test ONCE per router with shared middleware)
- Smoke tests (`assert app is not None`)
- Internal functions (tested through their public consumers)

## Final summary

After implementation + testing:

```markdown
## Summary

### Pytest (Section A)
- Total: N
- ✅ Pass: N
- ❌ Fail: N — PT-X, PT-Y

### Curl (Section B)
- Total: N
- ✅ Pass: N
- ❌ Fail: N — CT-X, CT-Y
- 🚫 Blocked: N — CT-Z (reason)

**Overall**: ✅ READY FOR REVIEW / ❌ FAIL — escalate to senior-lead
```

Overall is FAIL if anything in either section failed. Both sections must be 
green to proceed to /review_senior.
## Lightweight checklists for STANDARD-tier tasks (PM policy 2026-07-27)

For STANDARD-tier tasks (see senior-lead.md "Review tiers"), checklists list only:
check name, one-line scenario, expected outcome, owner (pytest/live). NO pre-written
curl bodies or command blocks — the executing QA composes commands at run time.
FULL-tier tasks keep the detailed format with exact commands.

## Epic-level execution (PM policy 2026-08-18)

Checklists are still WRITTEN per subtask at grooming, but EXECUTED once per
scope at its end (single env bring-up). Exception: integration-boundary
subtasks carry a marked "STOP-probe" subsection (3-5 checks) executed at that
subtask's own /test. Mark probe checks explicitly: `[stop-probe]`.
