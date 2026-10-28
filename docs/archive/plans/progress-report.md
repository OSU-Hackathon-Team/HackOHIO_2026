## 2. What Has Been Accomplished (Verified)

### 2.1 Monorepo & Infrastructure Foundation
- **Workspaces Configured:** Root [`package.json`](file:///Users/kgozon/HackOHIO_2026/package.json) defines `"workspaces": ["packages/*"]` and orchestration scripts (`build`, `dev`, `typecheck`, `start`).
- **TypeScript Base Config:** [`tsconfig.base.json`](file:///Users/kgozon/HackOHIO_2026/tsconfig.base.json) sets modern `NodeNext` module resolution, ES2022 target, and strict type checking.
- **Unified Multi-Stage Dockerfile:** [`Dockerfile`](file:///Users/kgozon/HackOHIO_2026/Dockerfile) builds all stages cleanly (`base` -> `deps` -> `builder` -> `runner` / `dev`). Global installation of `rea-agents@6.7.0` is pre-baked in `base`.
- **Docker Compose Definitions:** [`compose.yaml`](file:///Users/kgozon/HackOHIO_2026/compose.yaml) and [`docker-compose.yml`](file:///Users/kgozon/HackOHIO_2026/docker-compose.yml) are synchronized, defining:
  - `splice` (default unified container on port 3001).
  - `splice-dev` (profile `dev`, ports 3001 & 5173 with volume mounts).
  - `orchestrator` (profile `worker`, privileged Podman/Ghidra execution).
- **Continuous Integration:** [`.github/workflows/ci.yml`](file:///Users/kgozon/HackOHIO_2026/.github/workflows/ci.yml) builds workspaces, typechecks, runs Docker buildx with GHA cache, boots the container, tests `/api/health`, `/`, and verifies the `/api/*` 404 guard.

### 2.2 Shared Type Contracts (`@splice/contracts`)
The contract schemas in [`packages/contracts/src`](file:///Users/kgozon/HackOHIO_2026/packages/contracts/src) are fully written with Zod 3 schemas and exported TypeScript types:
- [`pantry.ts`](file:///Users/kgozon/HackOHIO_2026/packages/contracts/src/pantry.ts): `ArtifactType`, `Category`, `ReaSeed`, `PantryFeature`, `PantryApp`, `Pantry`.
- [`evidence.ts`](file:///Users/kgozon/HackOHIO_2026/packages/contracts/src/evidence.ts): `ToolCallRecord`, `SourceSnippet`, `TargetInfo`, `RawEvidence`.
- [`spec.ts`](file:///Users/kgozon/HackOHIO_2026/packages/contracts/src/spec.ts): `Requirement`, `IoField`, `ExportSig`, `InterfaceSpec`, `TestCaseResult`, `OracleCheck`, `FeatureSpec`.
- [`blueprint.ts`](file:///Users/kgozon/HackOHIO_2026/packages/contracts/src/blueprint.ts): `EngineImplementation`, `EngineVerification`, `FeatureBlueprint`.
- [`events.ts`](file:///Users/kgozon/HackOHIO_2026/packages/contracts/src/events.ts): `PipelineStage`, `PipelineEvent` discriminated union, `ExtractRequest`, `ImplementRequest`.
- [`synthesis.ts`](file:///Users/kgozon/HackOHIO_2026/packages/contracts/src/synthesis.ts): `ALLOWED_DEPENDENCIES`, `SynthesizeRequest`, `SynthesisBundle`, `RefineRequest`, `SynthEvent`, `HealthResponse`.

### 2.3 Model Routing System (`models.json`)
- [`models.json`](file:///Users/kgozon/HackOHIO_2026/models.json) specifies model IDs for all pipeline roles:
  - `default`: `amazon-bedrock/deepseek.v3.2`
  - `decomp_worker`: `amazon-bedrock/amazon.nova-lite-v1:0`
  - `spec_writer`, `engine_writer`, `ui_synthesizer`: `amazon-bedrock/anthropic.claude-opus-5-5`
  - `refusal_fallback`: `amazon-bedrock/anthropic.claude-opus-4-8`
  - `legal_verification`: `amazon-bedrock/anthropic.claude-opus-4-6-v1`
- Dual Loaders implemented and verified:
  - TypeScript: [`packages/backend/src/models.ts`](file:///Users/kgozon/HackOHIO_2026/packages/backend/src/models.ts) with `getModel()`, `toBedrockId()`, `bedrockModelId()` (throwing if non-Claude is routed to Splice roles).
  - Python: [`model_config.py`](file:///Users/kgozon/HackOHIO_2026/model_config.py) with cached loader, environment variable overrides (`MODEL_<ROLE>`), and CLI support.

### 2.4 Server Shell & Single-Port Static Serving
- [`packages/backend/src/server.ts`](file:///Users/kgozon/HackOHIO_2026/packages/backend/src/server.ts) mounts:
  - Compression middleware with SSE anti-buffering filter (`filter: req.headers.accept === "text/event-stream" ? false : ...`).
  - CORS and JSON body parser (10MB limit).
  - Step routers: [`step1Router`](file:///Users/kgozon/HackOHIO_2026/packages/backend/src/routes/step1/index.ts) serving `GET /api/health`.
  - Strict API 404 guard (`app.all("/api/*", ...)` returning JSON 404).
  - Production static Vite SPA serving from `../../frontend/dist` with client-side SPA routing fallback.
- Verified live response on port 3001:
  - `GET /api/health` ➔ `200 OK` (JSON)
  - `GET /` ➔ `200 OK` (HTML Vite SPA)
  - `GET /api/nonexistent` ➔ `404 Not Found` (JSON)

### 2.5 REA MCP Client Shell
- [`packages/backend/src/rea/reaClient.ts`](file:///Users/kgozon/HackOHIO_2026/packages/backend/src/rea/reaClient.ts) implements `ReaMcpManager` using `@modelcontextprotocol/sdk/client` and `StdioClientTransport`. It resolves the command line (`rea-agents mcp` subcommand) across Linux/Docker and Windows.

### 2.6 Demo Target Source Code & Manifest
- [`targets/manifest.json`](file:///Users/kgozon/HackOHIO_2026/targets/manifest.json) catalogs two demonstration applications:
  1. `inkwell` (Markdown vault): features `inkwell.wikilink_graph` and `inkwell.fuzzy_search`.
  2. `recall` (Flashcards): features `recall.sm2_scheduler` and `recall.review_streaks`.
- Unbundled source code exists in [`targets/src/inkwell/src`](file:///Users/kgozon/HackOHIO_2026/targets/src/inkwell/src) and [`targets/src/recall/src`](file:///Users/kgozon/HackOHIO_2026/targets/src/recall/src).

### 2.7 Documentation, Playbooks & Specifications
- Comprehensive architectural specifications exist under [`agents/`](file:///Users/kgozon/HackOHIO_2026/agents):
  - Step 1 (Eng 1 REA): 9 detailed documents.
  - Step 2 (Eng 2 Requirements): 7 detailed documents.
  - Step 3 (Eng 3 Implementation & Studio): 10 detailed documents.
  - Complete master edition of the Hackathon judging rubric: [`agents/judging_criteria.md`](file:///Users/kgozon/HackOHIO_2026/agents/judging_criteria.md).

---

## 3. What Currently Exists vs. What is Stubbed (Component Analysis)

| Component / Subsystem | Path | Implementation State | Evidence |
| :--- | :--- | :--- | :--- |
| **Contracts** | `packages/contracts/src/*.ts` | **Complete** (100%) | 7 files, valid Zod schemas, compiles to `dist/` |
| **Backend Server Shell** | `packages/backend/src/server.ts` | **Operational** | Express app, SSE filter, SPA static serving |
| **Step 1 Router** | `packages/backend/src/routes/step1/index.ts` | **Partial** (10%) | `GET /api/health` works; `GET /api/pantry` missing |
| **Step 2 Router** | `packages/backend/src/routes/step2/index.ts` | **Stub** (0%) | 7 lines, empty `Router()`, routes not mounted |
| **Step 3 Router** | `packages/backend/src/routes/step3/index.ts` | **Stub** (0%) | 7 lines, empty `Router()`, routes not mounted |
| **Evidence Collector** | `packages/backend/src/evidence/*.ts` | **Stub** (0%) | `collector.ts`, `recorder.ts`, `replay.ts` are 4-line stubs (`export {};`) |
| **REA Bridge Details** | `packages/backend/src/rea/` | **Partial** (25%) | `reaClient.ts` implemented; `asarReader.ts`, `normalize.ts`, `reaArgs.ts` are stubs |
| **Bedrock LLM Client** | `packages/backend/src/llm/*.ts` | **Stub** (0%) | `llm.ts`, `schemas.ts` are 4-line stubs (`export {};`) |
| **Sandbox Test Runner** | `packages/backend/src/sandbox/*.ts` | **Stub** (0%) | `runTests.ts`, `worker.cjs` are 4-line stubs (`export {};`) |
| **Spec Generator & Oracle** | `packages/backend/src/spec/*.ts` | **Stub** (0%) | `buildSpec.ts`, `formatEvidence.ts`, `prompt.ts`, `staticChecks.ts`, `store.ts` are stubs |
| **Engine Implementer** | `packages/backend/src/engine/*.ts` | **Stub** (0%) | `implement.ts`, `conformance.ts`, `prompt.ts`, `purity.ts` are stubs |
| **Synthesis & Refine** | `packages/backend/src/synthesis/*.ts` | **Stub** (0%) | `assemble.ts`, `prompt.ts`, `refine.ts`, `synthesize.ts`, `validateBundle.ts` are stubs |
| **Virtual TSC Typechecker** | `packages/backend/src/typecheck/` | **Stub** (0%) | `virtualTsc.ts` is a 4-line stub (`export {};`) |
| **Backend Utility Scripts** | `packages/backend/src/scripts/*.ts` | **Stub** (0%) | All 13 scripts (`testBridge.ts`, `testLlm.ts`, `recordAll.ts`, etc.) are stubs |
| **Frontend Shell** | `packages/frontend/src/App.tsx` | **Prototype** (Mock UI) | Hardcoded layout with Mock App Pantry, Harvester query, and Sandpack placeholder |
| **Frontend Components** | `packages/frontend/src/components/*.tsx` | **Stub** (0%) | `TopBar.tsx`, `CardTray.tsx`, `Terminal.tsx`, `PantryPanel.tsx`, etc., are 4-line stubs |
| **Frontend API & Store** | `packages/frontend/src/api/`, `store/` | **Stub** (0%) | `client.ts`, `mock.ts`, `sse.ts`, `useStudio.ts` are stubs |
| **Native Decomp Engine** | `launch.py`, `agent_worker.py` | **Scaffold** | Runnable only inside container; no `engine/` package yet |

---

## 4. What Is Broken, Missing, or Discrepant

### 4.1 Missing Dependency: `@electron/asar`
- **Finding:** [`scripts/build-targets.mjs#L2`](file:///Users/kgozon/HackOHIO_2026/scripts/build-targets.mjs#L2) imports `@electron/asar`.
- **Evidence:** Executing `node -e "import('@electron/asar')"` confirms: `Cannot find package '@electron/asar'`.
- **Impact:** Running `npm run build:targets` fails immediately.
- **Root Cause:** `@electron/asar` was not declared in root [`package.json`](file:///Users/kgozon/HackOHIO_2026/package.json) `devDependencies`.

### 4.2 Unbuilt Target Binaries (`targets/build/**/app.asar`)
- **Finding:** Target `.asar` files referenced in [`targets/manifest.json`](file:///Users/kgozon/HackOHIO_2026/targets/manifest.json) do not exist.
- **Evidence:** [`targets/build/inkwell/`](file:///Users/kgozon/HackOHIO_2026/targets/build/inkwell) and [`targets/build/recall/`](file:///Users/kgozon/HackOHIO_2026/targets/build/recall) contain only `.gitkeep`.
- **Impact:** Live REA extraction against target Electron apps cannot run until `scripts/build-targets.mjs` is executed to generate the `.asar` archives.

### 4.3 Missing Fixture Data in Seed Directories
- **Finding:** As noted in [`.agents/README.md#L124-L130`](file:///Users/kgozon/HackOHIO_2026/.agents/README.md#L124-L130), the pipeline relies on fixtures for offline demo and replay mode (`REA_MODE=mock` / `LLM_MODE=mock`).
- **Evidence:**
  - `fixtures/evidence/`: contains only `_seed/.gitkeep` (0 evidence files).
  - `fixtures/specs/`: contains only `_seed/.gitkeep` (0 spec files).
  - `fixtures/blueprints/`: contains only `_seed/.gitkeep` (0 blueprint files).
  - `fixtures/transcripts/`: contains only `.gitkeep` (0 transcript files).
  - `fixtures/bundles/`: contains only `.gitkeep` (0 bundle files).
- **Impact:** If `REA_MODE=mock` or `LLM_MODE=mock` is queried by any endpoint today, no valid fixtures can be returned. The only JSON files present are in `fixtures/_legacy_mocks/`, which adhere to the outdated schema and lack `FeatureSpec` fields.

### 4.4 Discrepancy: `spec/` LibreOffice Hierarchy vs. Repository Scope
- **Finding:** The `spec/` folder contains ~130KB of documentation detailing LibreOffice architecture, modules (`writer`, `calc`, `impress-draw`), and UNO runtime.
- **Evidence:** [`docs/libreoffice-spec/README.md`](../../libreoffice-spec/README.md) explicitly documents:
  > *"Verification Status (2026-10-24): UNVERIFIED against this repository. This repository (HackOHIO_2026 / Splice, 197 tracked files) contains no LibreOffice source code."*
- **Impact:** The `spec/` files are abstract specifications written for judging/evaluation purposes, but they do not correspond to any active source code in `packages/`.

### 4.5 Python Launcher Standalone Execution Guard
- **Finding:** Running `python3 launch.py --help` on the host machine exits with code 1.
- **Evidence:** [`launch.py#L118-L119`](file:///Users/kgozon/HackOHIO_2026/launch.py#L118-L119):
  ```python
  if not Path("/.dockerenv").exists():
      raise SystemExit("Run this launcher inside the Docker orchestrator: docker compose run --build --rm orchestrator ...")
  ```
- **Impact:** `launch.py` cannot be invoked directly on macOS host; it strictly requires Docker Compose with the `orchestrator` service profile.

### 4.6 Missing Unit Tests
- **Finding:** `npm run test:unit --workspace=@splice/backend` reports `tests 0, suites 0`.
- **Evidence:** No `*.test.ts` files exist in any workspace. All testing scripts in `packages/backend/src/scripts/` are currently empty stubs.

---

## 5. Current Blockers, Risks, and External Dependencies

1. **AWS Bedrock Credentials:**
   - Splice roles (`spec_writer`, `engine_writer`, `ui_synthesizer`, `refusal_fallback`) are hard-pinned to Anthropic Claude models on AWS Bedrock (`anthropic.claude-opus-5-5`, `anthropic.claude-opus-4-8`).
   - Neither host environment nor root contains AWS credentials (`.env` is uncommitted). Without AWS credentials or valid recorded replay fixtures in `fixtures/evidence/` and `fixtures/specs/`, live extraction and synthesis will fail.

2. **REA Execution Environment:**
   - REA binary (`rea-agents`) is not installed on the host machine.
   - It is installed inside the Docker container (`node:22-bookworm-slim`). Therefore, live REA testing must run either inside the Docker container (`splice` or `splice-dev`) or after running `npm install -g rea-agents@6.7.0` on the host.

3. **OpenCode & Ghidra Podman Runtime (Native Engine Track):**
   - The native worker in [`launch.py`](file:///Users/kgozon/HackOHIO_2026/launch.py) expects `/run/opencode-bin` and `/run/opencode-auth.json` mounted into the orchestrator container. On host, `opencode` is not present in `$PATH`.

---

## 6. Recommended Prioritized Next Steps

To transition the project from its current scaffolded shell to a working end-to-end hackathon demonstration, execute work in the following sequential phases:

### Phase 1: Target Packaging & Offline Replay Seeding (Immediate Blocker)
1. **Install `@electron/asar` in Root `devDependencies`:**
   Add `"@electron/asar": "^3.2.12"` to root [`package.json`](file:///Users/kgozon/HackOHIO_2026/package.json).
2. **Package Target Applications:**
   Execute `npm run build:targets` to build `targets/build/inkwell/app.asar` and `targets/build/recall/app.asar` with SHA256 checksums.
3. **Seed Valid Fixtures:**
   Create initial mock/golden fixtures conforming to `@splice/contracts` under `fixtures/evidence/`, `fixtures/specs/`, and `fixtures/blueprints/` so developers and CI can test offline without burning AWS Bedrock tokens.

### Phase 2: Implement Step 1 (REA MCP Bridge & Pantry Route)
1. **Implement `GET /api/pantry`:**
   Read and validate [`targets/manifest.json`](file:///Users/kgozon/HackOHIO_2026/targets/manifest.json) using `Pantry` Zod schema in [`packages/backend/src/routes/step1/index.ts`](file:///Users/kgozon/HackOHIO_2026/packages/backend/src/routes/step1/index.ts).
2. **Implement REA Harvester & Bridge:**
   Complete [`packages/backend/src/rea/reaArgs.ts`](file:///Users/kgozon/HackOHIO_2026/packages/backend/src/rea/reaArgs.ts), [`normalize.ts`](file:///Users/kgozon/HackOHIO_2026/packages/backend/src/rea/normalize.ts), and [`evidence/collector.ts`](file:///Users/kgozon/HackOHIO_2026/packages/backend/src/evidence/collector.ts) following `agents/1_reverse_engineering/04_evidence_collector.md`.
3. **Verify via `npm run test:bridge` and `npm run test:collector`:**
   Replace the stubs in `packages/backend/src/scripts/` with the tests defined in `agents/1_reverse_engineering/07_testing_and_acceptance.md`.

### Phase 3: Implement Step 2 (Requirements Spec & Sandbox Oracle)
1. **Implement Bedrock LLM Client (`llm.ts`):**
   Connect to `@aws-sdk/client-bedrock-runtime` with structured JSON outputs and refusal fallback handling as specified in `agents/2_requirements_extraction/02_llm_client.md`.
2. **Implement Isolated Sandbox Runner (`sandbox/runTests.ts`):**
   Execute acceptance tests against original snippets in a child process worker.
3. **Mount `POST /api/extract`:**
   Implement SSE streaming pipeline event flow in [`packages/backend/src/routes/step2/index.ts`](file:///Users/kgozon/HackOHIO_2026/packages/backend/src/routes/step2/index.ts) returning `RawEvidence` and verified `FeatureSpec`.

### Phase 4: Implement Step 3 (Engine Synthesis & Studio Frontend)
1. **Implement Engine Generator & Conformance Loop (`engine/implement.ts`):**
   Implement the Claude prompt that writes pure TypeScript implementations matching `InterfaceSpec`.
2. **Implement Sandpack UI Synthesizer (`synthesis/synthesize.ts`):**
   Generate React wrapper applications around locked TypeScript engines and bundle them into `SynthesisBundle`.
3. **Connect Frontend UI Components:**
   Replace stubs in `packages/frontend/src/components/` with the Sandpack editor, terminal SSE stream viewer, and App Pantry tray as specified in `agents/3_feature_implementation/07_components.md`.