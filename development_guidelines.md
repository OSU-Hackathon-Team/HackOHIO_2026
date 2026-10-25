# Git Workflow & Commit Discipline Rules

## 1. Strictly Branch-Based Development
- **Never commit directly to `main`, `dev`, or `decomp-dev`.** Before modifying code or configuration, verify the branch and worktree status.
- **Branch from the integration branch:** Use `dev` by default, or `decomp-dev` for native-engine tasks when explicitly requested. Create a dedicated scoped branch and preferably an isolated worktree before making changes.
- **Branch Naming Convention:** Use `<type>/<short-kebab-description>`:
  - `feat/<name>` (e.g., `feat/sse-extract-endpoint`)
  - `fix/<name>` (e.g., `fix/npx-offline-fallback`)
  - `chore/<name>` or `infra/<name>` (e.g., `infra/multi-stage-dockerfile`)
  - `refactor/<name>` (e.g., `refactor/blueprint-zod-schema`)
- **One Domain Per Branch:** Keep branches focused. If a task spans separate engine areas, use separate branches or atomic commits per logical unit.

## 2. Atomic, Small Commits
- **One Logical Change Per Commit:** Keep unrelated engine behavior, infrastructure, and documentation changes in separate commits.
- **Commit Early and Often:** Commit immediately after completing each self-contained logical unit of work:
  1. Updating a single configuration or migration.
  2. Changing an engine component with its focused check.
  3. Updating the docs for a changed workflow or acceptance gate.
- **Stage Explicitly:** Use `git add <specific-files>` rather than `git add .` or `git add -A` to avoid accidentally staging temporary files, `.env` secrets, or unrelated edits.

## 3. Pre-Commit Verification & Message Format
- **Verify Before Committing:** Run `git status` and `git diff --staged` before every commit to confirm only the intended changes are staged and no secrets (`.env`) are included.
- **Conventional Commit Messages:** Use concise, imperative commit messages:
  - `fix(decomp): reject misbound direct-call dependencies`
  - `docs(decomp): clarify dossier readiness gates`
  - `chore(ci): check native fixture probes`

## 4. Direct Branch-and-Merge Protocol (No Pull Requests)
- **No Pull Requests (`gh pr create` is disabled):** Do not open GitHub Pull Requests unless explicitly asked.
- **Branch off the chosen integration branch:** Use a dedicated feature/fix/chore branch. Preserve unrelated uncommitted work in existing checkouts.
- **Atomic Commits on the Feature Branch:** Continue staging specific files (`git add <files>`) and making small, single-purpose Conventional Commits on your working branch.
- **Verify and merge into the chosen integration branch:**
  1. Run checks relevant to the changed engine area and confirm the feature worktree is clean.
  2. Update the integration branch from its remote when network access and task scope permit.
  3. Merge the feature branch, preserving its atomic commits and any unrelated local changes.
  4. Push only when requested or otherwise authorized for the task.
  5. Clean up the feature branch/worktree after merge when safe.
- **Never Touch `main`:** `main` remains strictly reserved for final milestone/judging releases when explicitly instructed.
