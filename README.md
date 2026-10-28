# Splice Native Decompilation & Studio Engine

Splice is an end-to-end subsystem decompilation and synthesis engine with an integrated Studio development interface. It extracts behavioral evidence from native binaries (via Ghidra and execution probes), formulates formal specifications through AI-driven reasoning, and generates cleanroom implementations verified against original runtime behavior.

---

## Table of Contents
- [Quick Start Guide](#quick-start-guide)
- [Running with Docker](#running-with-docker)
- [Architecture & Deep Dives](#architecture--deep-dives)
- [Core Commands & Workflows](#core-commands--workflows)
  - [1. Project Intake & Cross-Module Analysis](#1-project-intake--cross-module-analysis)
  - [2. Native Evidence Export & Scoping](#2-native-evidence-export--scoping)
  - [3. Review, Probing & Dossier Assembly](#3-review-probing--dossier-assembly)
  - [4. Specification Generation & Cleanroom Handoff](#4-specification-generation--cleanroom-handoff)
  - [5. Durable PostgreSQL Task Queue](#5-durable-postgresql-task-queue)
  - [6. Functional C Synthesis & Cleanroom Workbench](#6-functional-c-synthesis--cleanroom-workbench)
  - [7. Tool-Integration Diagnostic & Model Routing](#7-tool-integration-diagnostic--model-routing)
- [Python Dispatcher API](#python-dispatcher-api)

---

## Quick Start Guide

### 1. First-Time Setup
```bash
npm ci
npm run build:contracts
```

### 2. Run All Workspaces Concurrently (Recommended)
Starts the contracts build watcher, backend server (`:3003`), and Studio frontend (`:5173`):
```bash
PORT=3003 REA_MODE=mock LLM_MODE=mock npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 3. Run Backend and Frontend in Separate Terminals

**Terminal 1 — Backend (Port 3003):**
```bash
# Mock / replay mode (offline, no AWS credentials required):
PORT=3003 REA_MODE=mock LLM_MODE=mock npm run dev:backend

# Live mode (requires AWS Bedrock credentials):
PORT=3003 REA_MODE=auto LLM_MODE=live npm run dev:backend
```
*Health Check:* `curl http://localhost:3003/api/health`

**Terminal 2 — Studio Frontend (Port 5173):**
```bash
npm run dev:frontend
```
Open [http://localhost:5173](http://localhost:5173) (automatically proxies `/api` requests to backend on port 3003).

---

## Running with Docker

Run Studio and the backend inside containerized environments:

| Mode | Command | Port | Description |
|---|---|---|---|
| **Production** | `docker compose up -d --build --force-recreate splice` | `3001` | Optimized production bundle |
| **Development** | `docker compose --profile dev up --build --force-recreate splice-dev` | `5173` | Hot-reloading development container |

For container rebuilds, environment configuration, and workspace details, see the [Docker Frontend Guide](docs/DOCKER_FRONTEND.md).

---

## Architecture & Deep Dives

- **Subsystem Pipeline Architecture:** [DecompPileline.md](DecompPileline.md) defines the subsystem engine design for 16+ parallel workers.
- **Acceptance Gates & Milestones:** [DECOMP_IMPLEMENTATION_PLAN.md](DECOMP_IMPLEMENTATION_PLAN.md) outlines implementation phases, acceptance gates, and verification standards.
- **Private S3 Cache:** [docs/decomp-s3-cache.md](docs/decomp-s3-cache.md) documents content-addressed caching in `cache/v1/` for exact function exports, semantic records, and specifications.
- **Cleanroom Handoff & Governance:** [docs/NATIVE_CLEANROOM_HANDOFF.md](docs/NATIVE_CLEANROOM_HANDOFF.md) details analyst/implementer separation, audit artifact boundaries, and legal rights verification.
- **Studio Frontend Workspace:** [docs/DOCKER_FRONTEND.md](docs/DOCKER_FRONTEND.md) explains Chat, App Library, and My App workspaces.
- **Documentation Index:** [docs/README.md](docs/README.md) lists every live document and separates the historical archive.

---

## Core Commands & Workflows

Splice uses `launch.py` and dedicated utility scripts in `scripts/` to orchestrate analysis, reasoning, probing, queue management, and code generation.

### 1. Project Intake & Cross-Module Analysis
Analyze multiple executable and shared-library modules simultaneously with dependency mapping (`DT_NEEDED` / symbol links).

#### Request Example (`project.json`)
```json
{
  "schema": 1,
  "modules": [
    {"id": "app", "kind": "executable", "path": "app.bin"},
    {"id": "math", "kind": "shared", "path": "libmath.so"}
  ]
}
```

#### Intake & Scope Commands
| Action | Command | Description |
|---|---|---|
| **Analyze Modules** | `python launch.py project-analyze --request /path/to/project.json` | Scans modules, resolves ELF `DT_NEEDED`, matches shared libraries |
| **Export All Functions** | `python launch.py project-export-all --project-artifact <project-inventory-sha256>` | Exports all indexed functions across supplied modules |
| **Define Project Scope** | `python launch.py project-scope --project-artifact <project-inventory-sha256> --request /path/to/project-scope.json` | Creates module scope artifacts from seeds or whole-project query |
| **Initialize Project Queue** | `python launch.py project-queue-init --project-scope-artifact <project-scope-sha256>` | Applies PostgreSQL migrations and registers module campaigns |
| **Drain Project Queue** | `python launch.py project-queue-drain --project-scope-artifact <project-scope-sha256> --workers 16` | Runs leased semantic tasks under shared reasoning capacity |
| **Check Queue Status** | `python launch.py project-queue-status --project-scope-artifact <project-scope-sha256>` | Reports project task states and shared task counts |
| **Campaign Status** | `python launch.py status --campaign <project-id>` | Summarizes campaign progress, exports, and artifact IDs |
| **Verify Intake Integration**| `python scripts/check_decomp_intake.py` | Runs fixture intake and ELF symbol-link checks |
| **Verify Queue Integration** | `python scripts/check_decomp_project_queue.py` | Validates multi-module queue drainage with PostgreSQL |

> **Scope request formats:**
> - Subsystem mode: `{"mode":"subsystem","query":"adjust from executable","seeds":[{"module":"app","seed":"00101050"}],"max_functions_per_module":32,"max_depth":2}`
> - Whole project mode: `{"mode":"project","query":"whole project","max_functions_per_module":100}`
>
> Pass `--dsn` or set `DECOMP_DATABASE_URL` (test DB override: `DECOMP_TEST_PG_DSN`).

---

### 2. Native Evidence Export & Scoping
Extract function decompilation, assembly, references, and executable gap analysis via headless Ghidra.

| Action | Command | Description |
|---|---|---|
| **Analyze Binary** | `python launch.py analyze --binary /absolute/path/to/program` | Imports and indexes binary functions, imports, strings, and calls |
| **Inspect Status** | `python launch.py status` | Reports import/index time, recovery attempts, and cache hits |
| **Export Single Function** | `python launch.py function --manifest decomp-state/projects/<campaign>/manifest.json --address <hex-addr>` | Exports C rendering, assembly, references, and types for function |
| **Export All Functions** | `python launch.py export-all --manifest decomp-state/projects/<campaign>/manifest.json` | Exports every discovered function and returns coverage inventory |
| **Inspect Byte Gap** | `python launch.py gap --manifest decomp-state/projects/<campaign>/manifest.json --start <hex> --end <hex>` | Inspects unclassified byte ranges (up to 4096 bytes) |
| **Define Subsystem Scope** | `python launch.py scope --manifest decomp-state/projects/<campaign>/manifest.json --request fixtures/decomp/scope_request.json` | Discovers bounded subsystem from seeds and call/data expansion |
| **Single Semantic Task** | `python launch.py work --manifest decomp-state/projects/<campaign>/manifest.json --scope-artifact <sha256> --subject <entry>` | Runs evidence-only reasoning attempt with model repair |

<details>
<summary>Verification and Fixture Checks</summary>

```bash
# Build and check standard test fixtures
python scripts/build_decomp_fixtures.py
python scripts/probe_decomp_fixtures.py
python scripts/check_decomp_export.py
python scripts/check_decomp_import_cache.py
python scripts/check_decomp_warm.py
python scripts/check_decomp_scope.py

# Telemetry subsystem fixture checks
python scripts/build_telemetry_fixture.py
python scripts/probe_telemetry_fixture.py
python launch.py probe --fixtures-manifest decomp-state/fixtures/telemetry_manifest.json \
  --suite fixtures/decomp/telemetry_probes.json \
  --adapter scripts/telemetry_probe_adapter.py
python scripts/check_decomp_meaningful_leases.py
```
</details>

*Configuration:* Set `DECOMP_ANALYSIS_WORKERS` (`0..16`, default `2`) to control Ghidra worker pool size (`0` uses a fresh process per request). Artifacts are SHA-256 addressed under `decomp-state/artifacts/`.

---

### 3. Review, Probing & Dossier Assembly
Subject draft semantic claims to independent model review and ground-truth runtime execution probes before assembling an immutable behavioral dossier.

| Stage | Command | Description |
|---|---|---|
| **Independent Review** | `python launch.py review --draft-artifact <draft-artifact-sha256>` | Evaluates draft claims (`supported_static`, `contradicted`, `uncertain`) |
| **Verify Review Logic** | `python scripts/check_decomp_review.py` | Validates reviewer detection on false-claim fixture (`DECOMP_REVIEW_CHECK_MODEL`) |
| **Run Native Probes** | `python launch.py probe --fixtures-manifest decomp-state/fixtures/manifest.json --suite fixtures/decomp/probes.json` | Executes test cases against original stripped binaries |
| **Run Telemetry Probes** | `python launch.py probe --fixtures-manifest decomp-state/fixtures/telemetry_manifest.json --suite fixtures/decomp/telemetry_apply_probes.json --adapter scripts/telemetry_probe_adapter.py` | Runs stateful telemetry probe suite with adapter |
| **Verify Probes & Links** | `python scripts/check_decomp_probes.py`<br>`python scripts/check_decomp_probe_links.py` | Verifies probe execution and probe link validation logic |
| **Assemble Dossier** | `python launch.py dossier --manifest <manifest> --scope-artifact <sha256> --inputs <inputs.json>` | Assembles immutable dossier linking drafts, reviews, and probes |

*Inputs schema for dossier assembly (`inputs.json`):*
```json
{
  "draft_artifacts": ["<sha256>"],
  "review_artifacts": ["<sha256>"],
  "probe_report_artifacts": ["<sha256>"],
  "probe_link_artifacts": ["<sha256>"],
  "dependency_resolution_artifacts": ["<sha256>"],
  "gap_adjudication_artifacts": ["<sha256>"]
}
```
*Output:* Writes readable Markdown dossier to `decomp-state/dossiers/<scope-id>/latest.md` and outputs JSON and Markdown artifact hashes.

---

### 4. Specification Generation & Cleanroom Handoff
Convert verified dossiers into implementation specifications stripped of original assembly, pseudocode, and internal compiler mechanics.

| Step | Command | Description |
|---|---|---|
| **Handoff Eligibility Check** | `python scripts/check_decomp_handoff.py --dossier-artifact <dossier-sha256>` | Checks if dossier is eligible for cleanroom spec generation |
| **Generate Formal Spec** | `python launch.py spec --dossier-artifact <dossier-sha256>` | Invokes Step 2 spec writer to emit cleanroom spec & private audit artifact |
| **Verify Spec Quality** | `python scripts/check_decomp_spec.py` | Validates spec formatting, prose requirements, and audit separation |

#### Backend API Endpoints:
- `POST /api/native-specs` (Body: `{"dossier_artifact": "<sha256>"}`)
- `GET /api/native-specs/<spec-artifact-sha256>`
- *Configuration:* Set `DECOMP_STATE_DIR` when engine state is hosted outside repository root.
- *Reference:* See [docs/NATIVE_CLEANROOM_HANDOFF.md](docs/NATIVE_CLEANROOM_HANDOFF.md) for complete workflow and compliance guidelines.

---

### 5. Durable PostgreSQL Task Queue
Orchestrate high-throughput, distributed semantic analysis, review, dependency reconciliation, and contract publication backed by PostgreSQL.

#### Queue Lifecycle & Processing
| Workflow Step | Command | Description |
|---|---|---|
| **Initialize Migrations** | `python launch.py queue-init --manifest <manifest>` | Applies DB migrations and audits earlier accepted tasks |
| **Enqueue Scope Tasks** | `python launch.py queue-enqueue --scope-artifact <scope-sha256>` | Enqueues deduplicated semantic tasks for scope |
| **Execute Single Task** | `python launch.py queue-run-one --manifest <manifest> --worker-id worker-1` | Leases and executes one task with epoch-based lease renewal |
| **Drain Task Queue** | `python launch.py queue-drain --manifest <manifest> --workers 4 --max-tasks 4` | Concurrently drains tasks up to reasoning lease limit |
| **Queue & Metrics Status** | `python launch.py queue-status --campaign <campaign>`<br>`python launch.py queue-metrics --campaign <campaign> --after-event-id <cursor>` | Inspects queue counts, throughput, elapsed time, and token costs |
| **Inspect Task & Events** | `python launch.py queue-task --task-id <task-uuid>`<br>`python launch.py queue-events --campaign <campaign> --after-id 0` | Retrieves specific task state or ordered append-only event log |

#### Review, Reconciliation & Contract Publishing
| Action | Command | Description |
|---|---|---|
| **Static Review Task** | `python launch.py queue-review --task-id <task-uuid>` | Runs independent static review on completed task |
| **Deterministic Review** | `python launch.py queue-review-fixed-memory --task-id <task-uuid>` | Deterministic review for straight-line x86 fixed-memory stores |
| **Drain Review Queue** | `python launch.py queue-review-drain --campaign <campaign> --workers 2 --max-tasks 2` | Leases and executes pending review jobs through review pool |
| **Review Dependency** | `python launch.py queue-review-dependency --task-id <task-uuid> --dependency-index 0` | Reviews draft dependency against active helper contract |
| **Adjudicate Gaps** | `python launch.py queue-adjudicate-gaps --task-id <task-uuid> --probe-report-artifact <sha256> --model <model>` | Classifies reviewer gaps using secondary model and probe evidence |
| **Resolve Dependencies** | `python launch.py queue-resolve-dependencies --task-id <task-uuid> --reviews <reviews.json>` | Pins verified dependency versions to unblock task acceptance |
| **Reassess / Normalize** | `python launch.py queue-reassess --task-id <task-uuid> --reason "..."`<br>`python launch.py queue-normalize-partial --task-id <task-uuid>` | Requeues task or deterministically normalizes minor draft errors |
| **Reclassify / Repair Citations**| `python launch.py queue-reclassify-intrinsic --task-id <task-uuid>`<br>`python launch.py queue-repair-dependency-citations --task-id <task-uuid>` | Reclassifies mistaken dependencies or repairs direct-call citations |
| **Direct Calls & Revisions** | `python launch.py queue-complete-direct-calls --task-id <task-uuid>`<br>`python launch.py queue-revise-semantics --task-id <task-uuid> --reason "..."` | Binds matching active helper contracts or requests semantic revision |
| **Expand Coverage** | `python launch.py queue-expand-coverage --task-id <task-uuid> --model <model>` | Generates cited claims for reviewer-identified omissions |
| **Publish Claims & Contracts** | `python launch.py queue-publish-claims --task-id <task-uuid> --slots <slots.json>`<br>`python launch.py queue-publish-contract --task-id <task-uuid> --claim-index 0 --contract-key <key> --expected-version 0`<br>`python launch.py queue-findings --campaign <campaign>` | Publishes accepted claims into immutable semantic slots and contracts |
| **Queue Verification Checks** | `python scripts/check_decomp_queue.py`<br>`python scripts/check_decomp_memory_effects.py`<br>`python scripts/check_decomp_findings.py` | End-to-end integration checks for queue, memory effects, and findings |

---

### 6. Functional C Synthesis & Cleanroom Workbench
Generate and validate pure C implementations from behavioral specifications and observed transitions using an isolated container workbench.

```bash
# 1. Build the cleanroom implementer container
podman build -t splice-cleanroom-implementer:local -f implementer.Dockerfile .

# 2. Run end-to-end synthesis loop with workbench
python scripts/run_functional_c_e2e.py \
  --state decomp-state \
  --scope-artifact <scope-sha256> \
  --public-report-artifact <training-report-sha256> \
  --full-report-artifact <full-report-sha256> \
  --interface token-array \
  --workbench --build-workbench-image

# 3. Compile and verify native C candidate against held-out probes
python scripts/run_native_c_candidate.py \
  --state decomp-state \
  --spec-artifact <spec-sha256> \
  --probe-report-artifact <probes-sha256> \
  --workbench

# 4. The same workbench for a command-line target: the harness builds the candidate
#    into a program and runs the public cases through its command line
python scripts/run_executable_c_e2e.py \
  --state decomp-state --allow-draft \
  --spec-artifact <spec-sha256> \
  --public-report-artifact <public-report-sha256> \
  --full-report-artifact <full-report-sha256> \
  --workbench --workbench-runtime docker
```

<details>
<summary>Additional Synthesis & Discovery Utilities</summary>

- **Expand Evidence Coverage:**
  ```bash
  python scripts/expand_functional_evidence.py --state decomp-state \
    --scope-artifact <scope> --public-report-artifact <training> \
    --full-report-artifact <full> --adapter <adapter> --count 40 --seed 7
  ```
- **Demo Transition Behavior:**
  ```bash
  python scripts/demo_functional_c.py --state decomp-state \
    --public-report-artifact <report> --full-report-artifact <report> \
    --source-artifact <candidate> --trace token-array-003
  ```
- **LibreOffice Calc Discovery:**
  ```bash
  python scripts/run_calc_discovery.py --state decomp-state [--expand-claims]
  ```
- **Random Subsystem Runner:**
  ```bash
  python scripts/run_random_subsystem.py <binary> --state decomp-state \
    [--seed 42] [--max-watchdog-retries 2] [--no-watchdog] \
    [--model <model>] [--review-model <model>] [--gap-model <model>]
  ```
- **Cleanroom Verification:**
  ```bash
  python scripts/check_cleanroom.py [--container]
  ```
</details>

*Workbench Options:*
- `--broker-model`: Override default broker model (`cleanroom_broker` in `models.json`).
- `--auth-file`: Mount OpenCode auth credentials read-only.
- `--workbench-network`: Set network mode (`none` for offline harness validation).

---

### 7. Tool-Integration Diagnostic & Model Routing

Inspect and safely rename symbols using OpenCode and headless Ghidra MCP:

```bash
# Build nested worker image via Docker orchestrator
docker compose build orchestrator
docker compose run --rm orchestrator python launch.py build

# Execute rename diagnostic
docker compose run --rm orchestrator python launch.py rename \
  --binary /workspace/path/to/binary --address 0x401126 --new-name parse_packet \
  [--model-role <role>] [--model <provider/model>]
```

#### Model Routing Configuration
Models are mapped in `models.json` and resolved in priority order:
1. Explicit CLI argument (`--model`)
2. Environment variable override (`MODEL_<ROLE>`)
3. `models.json` role default
4. `OPENCODE_MODEL` (legacy override)
5. `models.json` global `default`

| Role | Default Model | Environment Override |
|---|---|---|
| `decomp_worker` | `amazon-bedrock/amazon.nova-lite-v1:0` | `MODEL_DECOMP_WORKER` |
| `legal_verification` | `amazon-bedrock/amazon.nova-pro-v1:0` | `MODEL_LEGAL_VERIFICATION` |

*Inspect active model configuration:*
```bash
docker compose run --rm orchestrator python launch.py list-models
# or locally:
python launch.py list-models
```

*Environment paths:* Set `OPENCODE_BIN` and `OPENCODE_AUTH_FILE` to specify custom paths on host.

---

## Python Dispatcher API

For programmatic batch execution within the Docker orchestrator:

```python
import launch

# Dispatch a single rename attempt
launch.run(binary="/workspace/target.bin", address="0x401126", new_name="parse_packet")

# Dispatch parallel assignments across Podman workers
launch.dispatch_many(assignments=[...], max_workers=2)
```

**Batch CLI Execution:**
```bash
docker compose run --rm orchestrator python launch.py batch \
  --assignments /workspace/assignments.json --max-workers 2
```
*Assignment Schema:* JSON array of objects with required fields `binary`, `address`, `new_name`, and optional `model`, `model_role`, `timeout`.
