# Native Binary Decompilation Engine

## 1. Architectural Relationship to Splice

The **Native Binary Decompilation Engine** is a distinct, decoupled workstream from the main **Splice TypeScript clean-room synthesis pipeline**.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Splice Core Pipeline (TypeScript / Electron)                           │
│ .asar ──> REA Discovery ──> RawEvidence ──> FeatureSpec ──> Engine TS  │
└────────────────────────────────────────────────────────────────────────┘
                                    ▲
                         Handoff:   │ NativeSubsystemSpec
                       (launch.py spec / POST /api/native-specs)
                                    │
┌────────────────────────────────────────────────────────────────────────┐
│ Native Decompilation Engine (Python / Containerized Batch Worker)       │
│ ELF/Shared Lib ──> Ghidra Headless ──> OpenCode MCP ──> Dossier ───────┘
│                 ──> PostgreSQL Queue (Parallel Leased Workers)         │
└────────────────────────────────────────────────────────────────────────┘
```

- **Splice Core (TypeScript Track):** Focused on desktop applications (primarily Electron packages). It extracts JavaScript/TypeScript ASTs and traces via `rea-agents`, generates a behavioral `FeatureSpec`, and synthesizes clean-room TypeScript implementations validated inside isolated Node.js/Docker sandboxes.
- **Native Decompilation Engine (Python Track):** An offline/batch orchestrator designed for compiled native binaries (x86_64 ELF executables and shared libraries). It drives NSA Ghidra (12.1.3 Headless) through an MCP tool interface (`ghidra-headless-mcp`), coordinating autonomous LLM agents (via OpenCode) to decompile, inspect, rename, probe, and draft behavioral dossiers.
- **The Integration Handoff:** The two workstreams meet at a strict contract boundary:
  - `launch.py spec --dossier-artifact <sha256>` consumes an immutable behavioral dossier revision and outputs a `NativeSubsystemSpec` JSON artifact.
  - The Splice backend exposes this handoff via `POST /api/native-specs` and `GET /api/native-specs/:artifact`, enabling Splice downstream synthesis to ingest reverse-engineered native subsystem contracts without coupling to Ghidra's runtime.

---

## 2. Prerequisites & Environment Setup

Native binary analysis requires specialized tools running inside an isolated container environment to prevent untrusted agent actions or uncontained execution on the host system.

### Container Environment (Mandatory for Agent Execution)
- **Container Runtime:** Podman or Docker with container-in-container execution permissions.
- **Orchestrator Container:** Built using [worker.Dockerfile](file:///Users/kgozon/HackOHIO_2026/worker.Dockerfile) (Eclipse Temurin 21 JDK + Ghidra 12.1.3 + Python venv with `ghidra-headless-mcp`, `openai-agents`, `pyghidra`).
- **Container Guards:** `launch.py` strictly enforces container guards (`check_container_guard`). Commands like `build`, `rename`, and `batch` refuse to execute directly on the host without `/.dockerenv`, `/run/.containerenv`, or `CONTAINER_ORCHESTRATOR=1`.

### OpenCode & MCP
- OpenCode CLI binary mounted read-only at `/run/opencode-bin`.
- OpenCode authentication file mounted read-only at `/run/opencode-auth.json`.
- Headless MCP server: `/opt/venv/bin/ghidra-headless-mcp` communicating via standard I/O with process timeouts (120s).

### Model Routing Configuration
Models are configured via [models.json](file:///Users/kgozon/HackOHIO_2026/models.json) and resolved by [model_config.py](file:///Users/kgozon/HackOHIO_2026/model_config.py) in the following order:
1. Explicit CLI argument (`--model <provider/model>`).
2. Environment role override (`MODEL_<ROLE_UPPER>`, e.g., `MODEL_DECOMP_WORKER`).
3. `models.json` role mapping (`roles[role]`).
4. Legacy environment override (`OPENCODE_MODEL`).
5. `models.json` default (`"default"`).
6. Built-in fallback (`amazon-bedrock/deepseek.v3.2`).

Available roles:
- `decomp_worker`: Autonomous function decompiler inspection and rename agents.
- `spec_writer`: Dossier-to-specification conversion.
- `legal_verification`: Multi-model review and license boundary verification.

---

## 3. Running the Engine

### Launching the Orchestrator
To start the container orchestrator defined in [compose.yaml](file:///Users/kgozon/HackOHIO_2026/compose.yaml):
```bash
docker compose --profile worker up orchestrator
```

### Inspecting Configured Models
```bash
python3 launch.py list-models
```

### Importing and Indexing a Native Binary
```bash
python3 launch.py analyze --binary /path/to/binary.elf --state decomp-state
```

### Exporting Decompiler Evidence for a Function
```bash
python3 launch.py function --manifest decomp-state/manifest.json --address 0x401126
```

### Autonomous Single Function Rename Attempt (Inside Container)
```bash
python3 launch.py rename \
  --binary /path/to/binary.elf \
  --address 0x401126 \
  --new-name process_incoming_queue \
  --model amazon-bedrock/anthropic.claude-3-5-sonnet \
  --timeout 180
```

### Batch Parallel Dispatch (Inside Container)
```bash
python3 launch.py batch --assignments assignments.json --max-workers 4
```

### Dossier Assembly & Spec Generation
```bash
# Assemble dossier from validated evidence, reviews, and probes:
python3 launch.py dossier --manifest manifest.json --scope-artifact <scope_hash> --inputs inputs.json

# Generate NativeSubsystemSpec from an assembled dossier:
python3 launch.py spec --dossier-artifact <dossier_hash>
```

---

## 4. Security & Credential Isolation

1. **No Credentials in Source or Logs:**
   - Secrets (`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_ACCESS_KEY_ID`, OpenCode tokens) are never checked into git.
   - All errors captured by `launch.py` and `agent_worker.py` pass through `sanitize_secrets()`, which replaces sensitive credentials with `[..._REDACTED]` prior to writing to `error.json` or stderr.
2. **Read-Only Mounts:**
   - Host repository code is mounted read-only (`/app:ro`).
   - OpenCode binaries and authentication files are mounted read-only (`:ro`).
3. **Workspace Isolation:**
   - Each attempt runs in an ephemeral workspace under `runs/<uuid>/` with explicit timeout caps (default 180s).
   - In case of timeout or failure, containers are forcefully stopped (`podman rm -f`) and error metadata is recorded safely.

---

## 5. Testing & Verification

### Deterministic Unit Tests (No Credentials / No External Tools Required)
Unit tests verify configuration resolution, argument validation, container guards, secret sanitization, MCP message parsing, and durable queue degradation using deterministic mocks:
```bash
python3 -m unittest tests/test_native_engine.py
```

### Optional Integration Tests (Equipped Container Environment)
When running inside an environment with the container runtime, Ghidra Headless, and OpenCode installed:
```bash
export RUN_NATIVE_INTEGRATION=1
python3 -m unittest tests/test_native_integration.py
```

---

## 6. Constraints & Limitations

> [!IMPORTANT]
> **No False Claims:** In accordance with repository development rules, native binary decompilation is **not** claimed as universally complete. Full end-to-end autonomous decompilation requires successful containerized execution of all pipeline stages against real targets in an equipped Podman/Docker environment.
>
> **Current Operational Boundaries:**
> - Static indexing, evidence export, mock orchestration, and specification handoffs are functional and tested.
> - High-concurrency durable queuing requires an active PostgreSQL instance (`requirements-decomp.txt`).
> - Rename persistence verification requires a live Ghidra headless process reopen check inside the worker container.
