---
description: Pragmatic clean-code checklist over the current diff (KISS/YAGNI, no dogma)
argument-hint: [git ref or path, optional — defaults to unstaged + staged changes]
---

Review the changed code for clean-code violations. This is a **quality** pass on
readability and simplicity — it does NOT hunt for bugs (use /code-review for that).

Scope: $ARGUMENTS
If empty, review the working diff: `git diff HEAD` plus staged changes. Only
review lines that actually changed — don't audit the whole file.

## Philosophy

Flag things that make the code harder to read or maintain. This project favours
**KISS / YAGNI** — err toward *simpler*, not toward *more structure*. Do not
recommend an abstraction that isn't paying for itself yet.

## Checklist — report violations, each as `<rule>: <file:line> — <what & fix>`

Hard rules (flag every occurrence):
- **DRY** — the *same knowledge* duplicated across branches/files, or a value/limit
  redefined instead of imported from its one canonical home. (Only after the 2nd
  *real* occurrence — near-identical code that isn't the same knowledge is fine.)
- **No premature extraction** — a single-use `_helper` wrapping a one-liner that
  should just be inlined; a param/hook/config added "for later" with no caller now.
- **Dead code** — unused function, unreachable branch, "just in case" leftover,
  commented-out code. Delete it (git preserves history).
- **Magic numbers / strings** — unnamed literal carrying meaning → named constant,
  imported from the canonical place if one exists.
- **Obscured intent** — clever one-liner (bit-ops, deeply nested comprehension,
  walrus soup) where an obvious form reads clearer.
- **Deep nesting** — 3+ levels that a guard clause / early return would flatten.
- **Train wrecks** — `a.b.c.d.value` reaching through objects (Law of Demeter).
- **Misleading names** — name that doesn't describe what the thing does / returns.

Judgement calls (raise as a *question*, not an auto-fix — respect KISS/YAGNI):
- Function with 4+ args, or a boolean flag param → *ask* whether a dataclass /
  splitting the function genuinely simplifies. Do NOT mandate it.
- Long if/elif on a type field → *ask* whether polymorphism pays off here. A short,
  stable chain is fine as-is.

Explicitly OUT of scope (don't flag):
- "Max 3 arguments" / "always dataclass" as a blanket rule.
- "Polymorphism instead of every if/else."
- Style/formatting handled by ruff (run `make format` / `make flake8` instead).

## Output

1. Violations grouped by severity: **Must fix** (hard rules) vs **Consider**
   (judgement calls). Each with `file:line` and a one-line fix.
2. If nothing found: "✅ Clean — no violations in the diff."
3. Do NOT edit code in this command — just report. The user decides what to apply.
