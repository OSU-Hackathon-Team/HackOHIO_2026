# Decomp pipeline agent scaffold

**Architecture:** [DecompPileline.md](DecompPileline.md) defines the subsystem-oriented engine for 16+ workers. [DECOMP_IMPLEMENTATION_PLAN.md](DECOMP_IMPLEMENTATION_PLAN.md) lists the implementation phases and acceptance gates. The engine now has a Ghidra evidence export foundation; semantic workers, durable queue, review, and dossiers remain planned. The commands below also retain the rename diagnostic.

## Native evidence export

With Ghidra's `analyzeHeadless` installed, import an executable or shared library once and index its functions, imports, strings, and direct calls:

```sh
python launch.py analyze --binary /absolute/path/to/program
python launch.py status
```

`analyze` prints a manifest under `decomp-state/projects/<campaign>/manifest.json`. The campaign key includes the input SHA-256, Ghidra version, exporter revision, and analysis options. Repeating the command reuses the indexed baseline. Export a selected function or every discovered function:

```sh
python launch.py function --manifest decomp-state/projects/<campaign>/manifest.json --address 00401136
python launch.py export-all --manifest decomp-state/projects/<campaign>/manifest.json
```

Each function artifact records its entry address, decompilation status, C rendering, instructions, and references. External functions and decompilation errors have explicit statuses. `export-all` keeps one Ghidra decompiler context open for the full indexed program and returns a coverage inventory. Its `complete` flag means every *discovered* function exported successfully; it does not mean all behavior has been discovered or validated. `decomp-state/progress.jsonl` contains append-only JSON events, including each completed function, for a future job API/UI; `launch.py status` summarizes them. All artifacts are SHA-256 addressed under `decomp-state/artifacts/`. This is static evidence, not a validated behavioral dossier.

Build source-known stripped executable and shared-library fixtures at `-O0` and `-O2`, then execute held-out cases against the original code:

```sh
python scripts/build_decomp_fixtures.py
python scripts/probe_decomp_fixtures.py
python scripts/check_decomp_export.py
python scripts/check_decomp_scope.py
```

The generated manifest, debug companions, and probe report stay in ignored `decomp-state/fixtures/`. Analysis workers should receive only the stripped `analysis_path` entries. The source and debug companions are evaluator material.

Discover a bounded subsystem from indexed evidence:

```sh
python launch.py scope --manifest decomp-state/projects/<campaign>/manifest.json \
  --request fixtures/decomp/scope_request.json
```

The scope revision records ranked seeds, included functions, direct-call and shared-data expansion, boundary contracts, exclusions, unresolved indirect calls, and deduplicated behavioral questions. Scope artifacts and revision pointers live under `decomp-state/scopes/`; `launch.py status` reports scope counts. A scope remains `partial` until semantic claims and independent validation are available.

Run one evidence-only semantic task from a scope revision:

```sh
python launch.py work --manifest decomp-state/projects/<campaign>/manifest.json \
  --scope-artifact <scope-artifact-sha256> --subject <function-entry>
```

The worker resolves its model through `models.json` (`decomp_worker` by default), reads AWS variables from the ignored root `.env` when they are absent from the process environment, and denies OpenCode tools. It records a checkpoint, prompt and transcript artifacts, model/runtime version, token usage, structural citation checks, and a terminal status. A structurally valid draft is `unreviewed`; it cannot make a scope ready without independent semantic review and original-behavior probes. Use `--model` to evaluate a different configured provider/model. `launch.py status` counts attempts by state.

## Rename diagnostic

The earlier tool-integration diagnostic dispatches an OpenCode agent that inspects a function through a headless Ghidra MCP server, renames it, and saves the project. A second process reopens the project to verify the name. Each attempt gets its own Ghidra project under `runs/`.

The host starts **Docker Compose only**. The Docker orchestrator runs every `podman build` and `podman run`; no host Podman state or socket is used. The worker image contains Ghidra 12.1.3 and [ghidra-headless-mcp](https://github.com/mrphrazer/ghidra-headless-mcp) at a fixed commit. It mounts the installed [OpenCode](https://opencode.ai/docs/cli/) binary and credentials read-only, then gives the model a small allowlist of Ghidra tools.

## Run

Install and sign in to OpenCode on the host, then build the nested worker image:

```sh
docker compose build orchestrator
docker compose run --rm orchestrator python launch.py build
```

The build downloads the official Ghidra release and verifies its SHA-256. It can take several minutes and needs several gigabytes of free space.

Compose defaults to `/home/mitch/.opencode/bin/opencode` and `/home/mitch/.local/share/opencode/auth.json`. Set `OPENCODE_BIN` and `OPENCODE_AUTH_FILE` in your environment or `.env` to use other paths.

## Model routing

`models.json` is the single global config for what model does what (OpenCode `provider/model` format):

| Role | Default | Override |
|---|---|---|
| `decomp_worker` | `amazon-bedrock/amazon.nova-lite-v1:0` | `MODEL_DECOMP_WORKER` |
| `spec_writer` | `amazon-bedrock/amazon.nova-pro-v1:0` | `MODEL_SPEC_WRITER` |
| `legal_verification` | `amazon-bedrock/anthropic.claude-opus-4-6-v1` | `MODEL_LEGAL_VERIFICATION` |

Resolution order: `--model` (or assignment `"model"`) > `MODEL_<ROLE>` env > `models.json` role > `OPENCODE_MODEL` (legacy default override) > `models.json` `default`. Inspect the resolved table with:

```sh
docker compose run --rm orchestrator python launch.py list-models
```

`launch.py rename` accepts `--model-role <role>` (default `decomp_worker`); `--model provider/model` overrides the role for that run. Batch assignments accept optional `"model"` and `"model_role"` fields. The backend mirrors this via `packages/backend/src/models.ts`; `GET /api/health` reports the resolved `models` table.

Use the function's Ghidra entry address:

```sh
docker compose run --rm orchestrator python launch.py rename \
  --binary /workspace/path/to/binary --address 0x401126 --new-name parse_packet
```

The output path is `runs/<attempt-id>/`. `manifest.json` records the input hash, address, model, model role, and timeout. `opencode.json` is the private MCP and permission configuration. `opencode-events.jsonl` records every agent event; `result.json` records tool calls, usage, and the reopened result. A failed attempt writes `error.json` and exits nonzero. Projects are private per attempt; this milestone does not publish changes to a shared main project or claim full function documentation.

`compose.yaml` uses a privileged Docker container because nested Podman needs container and mount privileges. The Ghidra MCP server and OpenCode run together inside the Podman worker; the MCP server is not exposed over a network port.

## Python API

`launch.run(binary, address, new_name)` creates and dispatches one attempt. `launch.dispatch_many(assignments, max_workers=2)` sends independent assignments to separate Podman workers, each with a private workspace. Call `launch.build()` once before dispatching. Run this Python code inside the Docker orchestrator.

You can also save a JSON array of assignments, then run:

```sh
docker compose run --rm orchestrator python launch.py batch \
  --assignments /workspace/assignments.json --max-workers 2
```

Each assignment has `binary`, `address`, and `new_name` fields. `model`, `model_role`, and `timeout` are optional.
