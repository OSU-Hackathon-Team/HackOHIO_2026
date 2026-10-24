# Agent onboarding: Splice (start here)

You are working in **Splice**, a HackOHIO 2026 project built by a team of three. Read this file
first, then whichever of the files below your task needs.

| File | Read it when |
|---|---|
| `project-map.md` | You need to find where something lives, or which doc specifies it |
| `build-and-run.md` | You need to install, build, run, typecheck or test anything |
| `working-on-a-task.md` | You're about to change code: implementing a stub, changing a contract, git workflow |
| `gotchas.md` | Before writing REA, Bedrock, SSE, contracts or target-app code. Each entry cost someone time |

## What Splice does (30 seconds)

The user picks features from a pantry of desktop apps. The pipeline then runs three steps:

1. **Step 1 · REA (Eng 1).** The `rea-agents` MCP server locates and traces the feature's code
   inside a packaged Electron `.asar`. Output: `RawEvidence`.
2. **Step 2 · Requirements (Eng 2).** Claude (on **Amazon Bedrock**) writes a spec: numbered
   requirements that cite source lines, a TS interface, and acceptance tests. The tests are run
   **against the original code** through an adapter in a sandbox. Output: `FeatureSpec`.
3. **Step 3 · Implementation (Eng 3).** Claude writes a pure TS engine **from the spec only**
   (it never sees the original source), and the same tests must pass. Then a React UI is
   generated around the locked engines and run in Sandpack. Output: `FeatureBlueprint`,
   `SynthesisBundle`. Eng 3 also owns the Studio frontend.

## Where the truth lives (in priority order)

1. **`agents/CONTRACTS.md`** + **`packages/contracts/src/`**: every type passed between
   steps. These two must always agree.
2. **`agents/README.md`**: team ownership, timeline, runtime modes, verified REA facts,
   judging-criteria plan.
3. **`agents/<step folder>/NN_*.md`**: exact implementation specs, with code, for every file.
   Every stub in `packages/` has a header pointing to its section.
4. **`development_guidelines.md`**: the git workflow. It is mandatory.

**Ignore for current work:** `hackathon_master_plan_rea_lovable.md`, the original plan that the
`agents/` step folders supersede. `fixtures/_legacy_mocks/` holds old hand-written mocks that use
the outdated schema.

**Separate pipeline, don't mix it in:** `launch.py`, `agent_worker.py`, `Dockerfile`,
`worker.Dockerfile`, `docker-compose.yml`, root `README.md` and `DecompPileline.md` describe a
Python/Ghidra/OpenCode worker experiment. It is not part of the Node app. (The `Dockerfile`
also builds the Node app; it's pinned to Node 22 + `rea-agents@6.7.0`.)

## Current state (update this section when it changes)

- **Done:** monorepo scaffold, contracts (real schemas), demo target app source + manifest,
  backend server shell with per-step routers (`/api/health` works), all docs.
- **Stubs:** every other file under `packages/backend/src/` and `packages/frontend/src/`
  (`export {};` plus an owner/spec header). Nothing in the pipeline runs yet.
- **Not yet installed:** the per-step dependencies (Bedrock SDK, esbuild, `@electron/asar`,
  `rea-agents`, zustand, jszip, …). Each spec doc lists the ones it needs.
- **Verified (2026-10-24):** REA launch + arguments for `analyze_javascript_application`,
  `trace_application_feature` and `binary_session` (live probe; catalog and samples in `fixtures/rea/`),
  and Sandpack 2.20 error/file types.
- **Not yet verified:** `trace_javascript_semantics` / `inspect_analysis_view` argument shapes
  (`// VERIFY` in `rea/reaArgs.ts` spec), Bedrock region + model IDs + model access (no AWS
  CLI was available to check), and live end-to-end timings.

## Non-negotiable rules

- Never work on `main` or `dev`. Branch `<type>/<kebab-name>` off `dev`, make small conventional
  commits, then merge to `dev` (no PRs). Details: `working-on-a-task.md`.
- Never commit `.env` or AWS credentials. Stage files explicitly; never `git add -A` / `git add .`.
- Never fake evidence. Replay fixtures must be recordings of real runs, and replayed data must
  show `mode: "replay"` so the UI badges it.
- Never hard-code model IDs or write `"latest"` versions. All Claude calls go through
  `packages/backend/src/llm/llm.ts`.
- Don't edit another step's files without saying so. Ownership is in `project-map.md`.
