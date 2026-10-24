# Git Workflow & Commit Discipline Rules

## 1. Strictly Branch-Based Development
- **Never commit directly to `main` or `dev`.** Before modifying any code or configuration files, always verify the current branch via `git branch --show-current`.
- **Branch off `dev`:** For every new feature, fix, or infrastructure task, create and switch to a dedicated, scoped branch off the latest `dev` branch before making changes.
- **Branch Naming Convention:** Use `<type>/<short-kebab-description>`:
  - `feat/<name>` (e.g., `feat/sse-extract-endpoint`)
  - `fix/<name>` (e.g., `fix/npx-offline-fallback`)
  - `chore/<name>` or `infra/<name>` (e.g., `infra/multi-stage-dockerfile`)
  - `refactor/<name>` (e.g., `refactor/blueprint-zod-schema`)
- **One Domain Per Branch:** Keep branches focused. If a task spans clearly separate domains (e.g., `infra` vs. `feat(frontend)`), use separate branches or atomic commits per logical unit.

## 2. Atomic, Small Commits
- **One Logical Change Per Commit:** Never bundle unrelated changes (e.g., Docker setup + frontend UI tweaks + schema updates) into a single monolithic commit.
- **Commit Early and Often:** Commit immediately after completing each self-contained logical unit of work:
  1. Adding or updating a single configuration file (e.g., `.dockerignore`, `Dockerfile`).
  2. Updating shared contracts/schemas in `packages/contracts`.
  3. Implementing a single route or service in `packages/backend`.
  4. Building or wiring a single component in `packages/frontend`.
- **Stage Explicitly:** Use `git add <specific-files>` rather than `git add .` or `git add -A` to avoid accidentally staging temporary files, `.env` secrets, or unrelated edits.

## 3. Pre-Commit Verification & Message Format
- **Verify Before Committing:** Run `git status` and `git diff --staged` before every commit to confirm only the intended changes are staged and no secrets (`.env`) are included.
- **Conventional Commit Messages:** Use concise, imperative commit messages:
  - `feat(backend): add static SPA fallback excluding /api routes`
  - `infra(docker): add multi-stage Dockerfile with base rea-agents cache`
  - `chore(docker): add .dockerignore and docker-compose profiles`

## 4. Direct Branch-and-Merge Protocol (No Pull Requests)
- **No Pull Requests (`gh pr create` is disabled):** Do not open GitHub Pull Requests unless explicitly asked.
- **Branch off `dev` for All Work:** Still create a dedicated feature/fix/infra branch (`<type>/<short-kebab-description>`) off the latest `dev` before starting any task. Never write uncommitted experimental work directly on `main` or `dev`.
- **Atomic Commits on the Feature Branch:** Continue staging specific files (`git add <files>`) and making small, single-purpose Conventional Commits on your working branch.
- **Verify, Merge into `dev`, and Push:**
  1. Once all atomic commits on the working branch are complete and verified (build/typecheck passes and `git status` is clean), switch to `dev`: `git checkout dev`
  2. Pull latest `origin/dev` to prevent conflicts: `git pull --rebase origin dev`
  3. Merge the feature branch into `dev` preserving atomic commits: `git merge <branch-name>`
  4. Push directly to `origin/dev`: `git push origin dev`
  5. Clean up the merged local feature branch: `git branch -d <branch-name>`
- **Never Touch `main`:** `main` remains strictly reserved for final milestone/judging releases when explicitly instructed.

"Before touching any files, you MUST run git checkout -b <type>/<name> off dev and confirm git branch --show-current. Do not make any edits on dev directly."