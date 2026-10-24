# Working on a task

1. Check `git status` and the branch. Use an isolated worktree and scoped
   `<type>/<name>` branch from the task's integration branch. The default workflow in
   `development_guidelines.md` targets `dev`; use `decomp-dev` when the user requests it.
   Preserve unrelated uncommitted changes.
2. Read the relevant architecture and milestone sections, then inspect the actual code.
   A proposed layout or acceptance gate is not proof that a feature exists.
3. Keep raw evidence, model interpretation, independent review, original execution,
   and dossier readiness distinct. Preserve immutable artifact identity and durable
   task history when changing queue or publication behavior.
4. Add a focused executable check for behavior that could regress. Run checks for the
   changed area when their Ghidra, PostgreSQL, or model prerequisites are available.
5. Update the root README for command or behavior changes, onboarding for milestone
   changes, and the implementation plan when an acceptance gate changes status.
6. Stage files explicitly, review `git diff --cached`, and commit one logical change
   at a time with a Conventional Commit message. Never stage credentials or generated data.

Specification generation and dossier-to-spec integration remain paused in the plan
until an explicit user instruction resumes them.
