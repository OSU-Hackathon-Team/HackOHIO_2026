# Working on a task

## 1. Git workflow (from `development_guidelines.md`, mandatory)

```bash
git checkout dev && git pull --rebase origin dev
git checkout -b feat/<short-kebab-name>          # also fix/, chore/, infra/, refactor/
# …work… one logical change per commit:
git add <specific files>                          # never `git add .` / `-A`; never .env
git diff --staged                                 # confirm no secrets / unrelated edits
git commit -m "feat(backend): add sandbox runner worker"
# when verified (build/typecheck passes, status clean):
git checkout dev && git pull --rebase origin dev && git merge <branch> && git push origin dev
git branch -d <branch>
```

No pull requests. Never touch `main`. If you're an agent, **confirm with the user before
merging or pushing**, because pushing publishes the work.

## 2. Implementing a stub (the most common task)

1. Open the stub, read its header, then open the referenced doc section. Read the step folder's
   `README.md` too: it lists the interfaces that step provides and consumes.
2. Install the dependencies the doc names (`--save-exact` where the doc pins a version).
3. Write the code. The doc usually has a near-complete implementation. Adapt it to reality
   instead of pasting it blindly. **Check every `// VERIFY` marker** against real output
   (`fixtures/rea/tools.json`, real Bedrock responses).
4. Code conventions:
   - ESM with **`.js` extensions on relative imports** (`import { rea } from "./rea/reaClient.js"`).
   - Types come from `@splice/contracts`. Don't redefine contract shapes locally.
   - Pass `AbortSignal` (`sse.signal`) into every REA / Bedrock call inside a route.
   - Streaming routes follow the pattern in `agents/1_reverse_engineering/06_backend_server_shell.md` §6.
   - Match the surrounding style. Keep comments sparse and purposeful.
5. Run the module's script (`build-and-run.md`) and `npm run typecheck`.
6. Remove the "Stub from the team scaffold" line from the header (keep the owner/spec line).
7. Update the "Current state" section in `.agents/README.md` if a milestone moved.

## 3. Changing a contract

Contracts are shared by all three engineers, so a contract change is a team decision.
1. Edit **both** `agents/CONTRACTS.md` and `packages/contracts/src/<file>.ts`.
2. Keep zod 3 APIs only. Use `.js` import extensions.
3. `npm run build:contracts && npm run typecheck`. Fix every consumer that breaks.
4. Commit as `refactor(contracts): …` or `feat(contracts): …` on its own, and tell the user it
   needs the team's approval.

## 4. Other recurring tasks

| Task | How |
|---|---|
| Add a pantry feature | Add the source module under `targets/src/<app>/src/`, add the feature to `targets/manifest.json` (seeds + symbols), `npm run build:targets`, commit source + `targets/build/**` together. Then record evidence → spec → blueprint fixtures |
| Change demo target source | Don't, once specs are recorded. If you must, re-record every fixture for that app, because requirement line refs and the `.asar` sha256 change |
| Record a golden fixture | Run the live path (script or UI) → inspect `*.latest.json` → `npm run fixtures:promote -w @splice/backend -- <id>` → commit the golden `*.json` |
| Tune a prompt | Prompts live in `spec/prompt.ts`, `engine/prompt.ts`, `synthesis/prompt.ts`. Re-run `spec:all` / `test:implement` / `test:synthesis` and log before/after numbers in `agents/JOURNAL.md` |
| Try an alternative approach or hit a wall | Add a row to `agents/JOURNAL.md` (time, who, what, numbers, decision). The judging criteria reward this explicitly |

## 5. Definition of done

Each step folder's `README.md` (or its `0N_testing_and_acceptance.md`) has an acceptance
checklist. A feature is done when its checklist items pass, not when the code compiles.
