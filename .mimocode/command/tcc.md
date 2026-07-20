---
description: Edit → TypeScript check → commit cycle. Accepts a commit message or auto-generates one.
---

# Typecheck-Commit

Run the full edit-verify-commit cycle for the current project.

## Steps

1. **TypeScript check**: Run `npx tsc --noEmit 2>&1` in the project root.
   - If errors: fix them, re-run until clean.

2. **Stage changes**: Run `git add -A`.

3. **Commit**: Create a commit with the provided message, or auto-generate one from the staged diff summary.
   - Use `git diff --cached --stat` to understand what changed.
   - Write a concise commit message (1-2 lines).

4. **Push**: Run `git push`.

5. **Report**: Show the commit hash and summary of changes.

## Arguments

- `$1` (optional): Commit message. If omitted, auto-generate from diff.
