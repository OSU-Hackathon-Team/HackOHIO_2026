# Agent onboarding: Splice (start here)

You are working in **Splice**, a HackOHIO 2026 project built by a team of three. Read this file
first, then whichever of the files below your task needs.

| File | Read it when |
|---|---|
| `project-map.md` | You need to find where something lives, or which doc specifies it |
| `build-and-run.md` | You need to install, build, run, typecheck or test anything |
| `working-on-a-task.md` | You're about to change code: implementing a stub, changing a contract, git workflow |
| `gotchas.md` | Before writing REA, Bedrock, SSE, contracts or target-app code. Each entry cost someone time |

## Two tracks in this repo (know which one your task is in)

| Track | Language | Status | Source of truth |
|---|---|---|---|
| **Splice app (Electron demo pipeline)** | TypeScript (`packages/`) | Step 3 backend + Studio core implemented; upstream integration pending | `agents/` (README, CONTRACTS, step folders) |
| **Subsystem decompilation engine** (native binaries, 16+ parallel workers, behavioral dossiers) | Python (`launch.py`, `engine/`) | Evidence export, bounded scopes, semantic attempts, review, probes, partial dossiers, and a PostgreSQL queue run; readiness and scale gates remain open | `DecompPileline.md` (architecture), `DECOMP_IMPLEMENTATION_PLAN.md` (acceptance gates), root `README.md` (commands) |

The native spec handoff now connects the two tracks: `launch.py spec` consumes an immutable
dossier revision and the backend exposes the generated `NativeSubsystemSpec` artifact. The
larger campaign/job API remains planned. `ScopeRequest`, `EvidenceArtifact`, `BehaviorClaim`,
and `SubsystemDossier` external contracts in the plan remain proposals.
The Electron demo's limits (fixed REA collector, replay-only native targets, the hour-based cut
list) do **not** constrain the engine.

## What Splice does (30 seconds)

The user picks features from a pantry of desktop apps. The pipeline then runs three steps:

1. **Step 1 · REA (Eng 1).** The `rea-agents` MCP server locates and traces the feature's code
   inside a packaged Electron `.asar`. Output: `RawEvidence`.
2. **Step 2 · Requirements (Eng 2).** The configured model (default Qwen on **Amazon Bedrock**) writes a spec: numbered
   requirements that cite source lines, a TS interface, and acceptance tests. The tests are run
   **against the original code** through an adapter in a sandbox. Output: `FeatureSpec`.
3. **Step 3 · Implementation (Eng 3).** The configured model writes a pure TS engine **from the spec only**
   (it never sees the original source), and the same tests must pass. Then a React UI is
   generated around the locked engines and run in Sandpack. Output: `FeatureBlueprint`,
   `SynthesisBundle`. Eng 3 also owns the Studio frontend.

## Where the truth lives (in priority order)

For **native / subsystem decompilation** work: `DecompPileline.md` first, then
`DECOMP_IMPLEMENTATION_PLAN.md`. `docs/archive/` is historical context only. For the
**Splice app**:

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

**Engine files:** `launch.py`, `agent_worker.py`, `model_config.py`, `worker.Dockerfile`,
`docker-compose.yml`/`compose.yaml` and the root `README.md` belong to the Python decompilation
engine track (see the table above). The root `Dockerfile` builds the **Node app** (Node 22 +
`rea-agents@6.7.0`), and CI (`.github/workflows/ci.yml`) builds it and smoke-tests it.

## Current state (update this section when it changes)

- **Done:** monorepo scaffold, contracts (real schemas), demo target app source + manifest,
  backend server shell with per-step routers (`/api/health` works), all docs. Built
  `targets/build/*/app.asar` + `.sha256` are committed (`inkwell/src/graph/wikilinks.js` was
  truncated and has been restored from its spec).
- **Step 3 backend (Eng 3, `feat/step3-backend`):** engine purity/conformance/implement loop,
  bundle assembly + validator + virtual `tsc`, synthesize, refine, routes and scripts are implemented
  with 65 backend unit tests (61 baseline + 4 Qwen migration checks). Built against injected ports (`engine/ports.ts`). Valid
  `/api/implement|synthesize|refine` requests return **503** until Eng 1/2 helpers are wired in
  `routes/step3/deps.ts`. Log: `docs/archive/implementation_frontend/accomplishments.md`.
- **Shared LLM client:** `llm/llm.ts` is implemented per `02_llm_client.md` (Bedrock Mantle for Claude,
  plus a Converse path for `splice_compatible` non-Claude models). **Splice defaults:** all four roles use Qwen3 Coder 480B over Converse. All three primary role smoke tests returned 391 in 0.5–0.6 seconds on this account. Claude overrides remain available but account access is blocked (see `gotchas.md`).
- **Studio core:** typed POST-SSE client, Zustand orchestration, development adapter, pantry, activity terminal, cards/X-Ray, evidence drawer, fusion, and Sandpack preview/code are implemented. Use `?mode=development` or `VITE_API_MODE=mock`. Authored `_seed` fixtures have real local engine checks and unrun original-code oracle; simulated activity is labeled development data. Refinement/auto-fix/export remain next milestone.
- **Eng 1 helpers landed:** configuration, SSE, archive/REA bridge and collector, record/replay, pantry and schema-shaped health are implemented. Existing Step 1 tests cover these modules; live REA acceptance is separate.
- **Remaining stubs:** Eng 2 sandbox and requirements extraction. No live pipeline end to end yet; Step 3 deps remain null until the sandbox is available. Its 503 diagnostic now names only the missing sandbox.
- **Decompilation engine:** the `engine/` package runs native evidence export, scopes,
  semantic attempts, independent review, probes, partial dossiers, and a durable queue.
  Project intake now groups executable and shared-library modules with per-module analysis
  manifests, ELF dependency edges, and static candidate import/function links;
  project export aggregates every discovered function with explicit failures and code gaps.
  Project scopes now seed bounded module scopes across candidate call links while keeping
  bindings unresolved. Project queue commands register their module tasks, drain semantic work
  through a shared pool, and report selected work across module campaigns. Cross-module
  contract resolution and aggregate dossiers remain planned.
  The telemetry root caller binds all 18 direct calls to active helper contracts and is
  accepted as `static_only`. The latest 21-function dossier has 38/38 statically
  supported claims, 18 current caller dependencies, and 15 distinct agreeing
  original cases. It remains partial because 26 claims have no original probe link.
  The reset helper used a narrow deterministic fixed-store reviewer after model
  reviewers misread its overlapping vector stores. Probe runs and distinct cases
  are counted separately. Targeted Ghidra exports now use bounded warm contexts with
  restart events and status counts. Function evidence separates listing types from
  decompiler-inferred parameters and records referenced data; both semantic and review
  prompts receive that context. A real dossier exposes missing original-case links at
  the new handoff gate. The function index now counts executable regions, decoded
  instructions outside functions, and bytes classified as neither instructions nor defined
  data, exposing gaps that `export-all` success alone cannot rule out. Scale and recovery gates
  remain open. Read-only gap exports now preserve raw bytes and reference context for targeted
  adjudication. The native spec handoff now refuses partial dossiers and sends reviewed
  behavioral facts through the regular Step 2 spec writer. It publishes a prose-only
  schema 2 spec and keeps evidence and review links in a separate analyst audit artifact.
  The reported telemetry dossier remains partial because 26 claims lack original case
  links. Spec quality, human containment review, and downstream implementation gates
  remain open. A bounded O2 executable pilot found that a semantic model and independent
  reviewer agreed on an incorrect wrapped 32-bit threshold; original boundary cases
  exposed it. Numeric claims now need explicit operand-width and boundary checks in
  the prompts, and probe-link rationales still require analyst review. See the root
  `README.md` for commands.
- **Not yet installed:** esbuild, `rea-agents`, jszip and other dependencies for remaining modules. Bedrock SDKs, Zustand, Playwright, `@electron/asar` and Step 3 type-check dependencies are installed.
- **Verified (2026-10-24):** REA launch + arguments for `analyze_javascript_application`,
  `trace_application_feature` and `binary_session` (live probe; catalog and samples in `fixtures/rea/`),
  and Sandpack 2.20 error/file types.
- **Not yet verified:** `trace_javascript_semantics` / `inspect_analysis_view` argument shapes
  (`// VERIFY` in `rea/reaArgs.ts` spec), live end-to-end timings, and production integration. Bedrock Qwen role smoke tests have passed in us-east-2; see `docs/STEP3_MILESTONE.md`.

## Non-negotiable rules

- Never work on `main` or `dev`. Branch `<type>/<kebab-name>` off `dev`, make small conventional
  commits, then merge to `dev` (no PRs). Details: `working-on-a-task.md`.
- Never commit `.env` or AWS credentials. Stage files explicitly; never `git add -A` / `git add .`.
- Never fake evidence. Replay fixtures must be recordings of real runs, and replayed data must
  show `mode: "replay"` so the UI badges it.
- Never hard-code model IDs or write `"latest"` versions. Models come from root `models.json`
  (per role, `MODEL_<ROLE>` env overrides) via `packages/backend/src/models.ts`. All Splice model calls
  go through `packages/backend/src/llm/llm.ts`.
- Don't edit another step's files without saying so. Ownership is in `project-map.md`.
