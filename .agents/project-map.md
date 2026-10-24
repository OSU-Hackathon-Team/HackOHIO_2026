# Project map

Every stub file starts with a header like:
`// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/04_sandbox_runner.md §3`.
Open that section before writing code. It usually contains the complete implementation.

## Top level

```
.agents/                    agent onboarding (you are here)
agents/                     the build spec: README, CONTRACTS, JOURNAL, one folder per step
  1_reverse_engineering/    Step 1 docs (Eng 1)
  2_requirements_extraction/ Step 2 docs (Eng 2)
  3_feature_implementation/ Step 3 docs (Eng 3), including the demo runbook
packages/
  contracts/                @splice/contracts — zod schemas, compiled to dist/
  backend/                  @splice/backend — Express + tsx, ESM, port 3001
  frontend/                 @splice/frontend — Vite + React + Tailwind v3 + Sandpack, port 5173
targets/                    demo apps that REA analyzes (source + built .asar)
fixtures/                   recorded runs used for replay mode and tests
scripts/build-targets.mjs   packs targets/src/<app> into targets/build/<app>/app.asar
models.json                 role → model routing for BOTH tracks (Splice defaults use Qwen via Converse)
Dockerfile                  Node app image (contracts → backend → frontend), used by CI
.github/workflows/ci.yml    CI: npm ci + build on Node 22, then Docker smoke test (/api/health, SPA, 404 guard)

# Subsystem decompilation engine track (Python)
DecompPileline.md           engine architecture — takes precedence for native/subsystem work
DECOMP_IMPLEMENTATION_PLAN.md  phases, proposed engine/ layout, acceptance gates
launch.py, agent_worker.py  current rename-attempt scaffold (OpenCode + Ghidra headless MCP)
model_config.py             Python role resolver for models.json
worker.Dockerfile, docker-compose.yml, compose.yaml   orchestrator + Podman worker images
docs/archive/               historical reviews; context only, not policy
engine/                     native analysis, queue, dossier, and specification artifact generator
```

## Backend (`packages/backend/src/`) by owner

| Path | Owner | Spec |
|---|---|---|
| `server.ts` | Eng 1 | mounts `routes/step{1,2,3}`. Don't add routes here |
| `config.ts`, `http/sse.ts` | Eng 1 | `1_reverse_engineering/06_backend_server_shell.md` |
| `routes/step1/` (`/api/health`, `/api/pantry`) | Eng 1 | same, §4 |
| `rea/` (`reaClient`, `reaArgs`, `normalize`, `asarReader`) | Eng 1 | `03_mcp_bridge.md`, `04_evidence_collector.md` |
| `evidence/` (`collector`, `recorder`, `replay`) | Eng 1 | `04_*`, `05_record_and_replay.md` |
| `llm/` (**shared**, used by Eng 2 and Eng 3) | Eng 2 | `2_requirements_extraction/02_llm_client.md` |
| `sandbox/` (**shared**: `runTests.ts`, `worker.cjs`) | Eng 2 | `04_sandbox_runner.md` |
| `spec/` (`prompt`, `formatEvidence`, `staticChecks`, `buildSpec`, `store`) | Eng 2 | `03_*`, `05_*` |
| `routes/nativeSpecs.ts` | Native handoff | Generate and fetch immutable native specs |
| `routes/step2/` (`/api/extract`, `/api/specs`) | Eng 2 | `01_pipeline_and_route.md` |
| `engine/` (`prompt`, `purity`, `conformance`, `implement`) | Eng 3 | `3_feature_implementation/01_engine_implementation.md` |
| `synthesis/` (`prompt`, `assemble`, `synthesize`, `refine`, `validateBundle`) | Eng 3 | `02_*`, `03_*`, `04_*` |
| `typecheck/virtualTsc.ts` | Eng 3 | `03_bundle_validator.md` |
| `routes/step3/` (`/api/implement`, `/api/blueprints`, `/api/synthesize`, `/api/refine`) | Eng 3 | `01_*` §6, `02_*` §7, `04_*` |
| `scripts/*.ts` | owner named in each header | each runs one module alone (see `build-and-run.md`) |

## Frontend (`packages/frontend/src/`), all Eng 3

`api/` (POST-SSE client, typed API, mock mode) → `store/useStudio.ts` (zustand store +
pipeline orchestration) → `components/` (TopBar, PantryPanel, Terminal, FeatureCard, CardTray,
EvidenceDrawer, FusionPanel, `studio/*`, `ui/*`). Also `lib/` (exportZip, format) and
`dev/IsolationRoute.tsx` (`?test=card|terminal|sandpack|drawer`). Specs:
`3_feature_implementation/05–08_*.md`. The core Studio is implemented; see `docs/STEP3_MILESTONE.md` for the development demo and pending integration.

## Data flow and HTTP API

```
POST /api/extract   {app_id, feature_id}  → SSE PipelineEvent… → "spec" event      (Steps 1+2)
POST /api/implement {spec}                → SSE PipelineEvent… → "blueprint" event (Step 3a)
POST /api/synthesize {blueprints, prompt} → SSE SynthEvent…    → "bundle" event    (Step 3b)
POST /api/refine    RefineRequest          → SSE SynthEvent…    → "bundle" (revision+1)
GET  /api/health · /api/pantry · /api/specs · /api/blueprints
```

Types: `packages/contracts/src/{pantry,evidence,spec,blueprint,events,synthesis}.ts`.

## Targets and fixtures

- `targets/manifest.json` is the pantry: 2 apps × 2 features (`inkwell.wikilink_graph`,
  `inkwell.fuzzy_search`, `recall.sm2_scheduler`, `recall.review_streaks`). Each feature has
  REA seeds and the symbols that must be reconstructed.
- `targets/src/**` is **frozen once specs are recorded**: requirements cite line numbers
  (e.g. `sm2.js:L21-L23`). `targets/build/**` (the `.asar` + `.sha256`) is committed.
- `fixtures/{evidence,specs,blueprints,bundles,transcripts/<kind>}/`: golden `*.json` files are
  committed; `*.latest.json` files are scratch and gitignored. `_seed/` folders hold temporary
  hand-built inputs, deleted at checkpoint 2. `fixtures/rea/` holds the REA tool catalog dump.
