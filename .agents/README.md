# Agent onboarding: Splice

Splice is a native subsystem decompilation engine in progress. It imports binaries with
Ghidra, discovers bounded scopes, runs evidence-backed semantic work through a durable
PostgreSQL queue, independently reviews claims, probes original behavior, and assembles
versioned dossiers. A dossier is not yet a specification or proof of complete behavior.

## Read first

1. [Root README](../README.md): current capabilities and CLI commands.
2. [Architecture](../DecompPileline.md): intended design and completion policy.
3. [Implementation plan](../DECOMP_IMPLEMENTATION_PLAN.md): milestones and acceptance
   gates. Its **stop before specification generation** boundary is active.
4. [Project map](project-map.md), [build and run](build-and-run.md), and
   [gotchas](gotchas.md): find code and verify changes.
5. [Git rules](../development_guidelines.md) and [working on a task](working-on-a-task.md).

| Track | Language | Status | Source of truth |
|---|---|---|---|
| **Splice app (Electron demo pipeline)** | TypeScript (`packages/`) | Step 3 backend + Studio core implemented; upstream integration pending | `agents/` (README, CONTRACTS, step folders) |
| **Subsystem decompilation engine** (native binaries, 16+ parallel workers, behavioral dossiers) | Python (`launch.py`, `agent_worker.py`, `model_config.py`; planned `engine/`) | Planned; today only a Ghidra rename-attempt scaffold runs (Docker + Podman) | `DecompPileline.md` (architecture, wins for native work), then `DECOMP_IMPLEMENTATION_PLAN.md` (phases, acceptance gates) |

## Current state (2026-10-24)

- Ghidra import, index, evidence export, scope discovery, and immutable artifacts run.
- Bounded semantic attempts, structural citation checks, independent static review,
  original-binary probes, and partial dossiers run on source-known fixtures.
- PostgreSQL queues semantic and review jobs with leases, retries, fencing, durable events,
  and bounded worker pools. Findings and helper contracts support versioned publication.
- Dependency review checks caller-to-callee binding. Unresolved or misbound direct calls
  remain dossier blockers. A telemetry fixture reached 16 concurrent leases and 21 scoped
  functions; this does not establish readiness or multi-host throughput.
- Conflict reconciliation, scale gates, specification generation, and downstream API
  integration remain open. The rename-attempt diagnostic remains available.

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
- **Decompilation engine:** planned (no `engine/` package yet). The runnable piece is the
  Ghidra rename-attempt scaffold (`python launch.py rename|batch` inside Docker).
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
