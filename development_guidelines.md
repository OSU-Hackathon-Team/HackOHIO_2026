# Git Workflow & Commit Discipline Rules

## 1. Strictly Branch-Based Development
- **Never commit directly to `main` or `dev`.** Before modifying any code or configuration files, always verify the current branch via `git branch --show-current`.
- **Branch off `dev`:** For every new feature, fix, or infrastructure task, create and switch to a dedicated, scoped branch off the latest `dev` branch before making changes.
- **Branch Naming Convention:** Use `<type>/<short-kebab-description>`:
  - `feat/<name>` (e.g., `feat/sse-extract-endpoint`)
  - `fix/<name>` (e.g., `fix/npx-offline-fallback`)
  - `chore/<name>` or `infra/<name>` (e.g., `infra/multi-stage-dockerfile`)
  - `refactor/<name>` (e.g., `refactor/blueprint-zod-schema`)

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