# Decomp pipeline agent scaffold

**Architecture:** [DecompPileline.md](DecompPileline.md) defines the subsystem-oriented engine for 16+ workers. [DECOMP_IMPLEMENTATION_PLAN.md](DECOMP_IMPLEMENTATION_PLAN.md) lists the implementation phases and acceptance gates. These describe planned work; the commands below currently run isolated rename attempts, not subsystem analysis.

The current runnable scaffold is a tool-integration milestone: Python dispatches an OpenCode agent that inspects a function through a headless Ghidra MCP server, renames it, and saves the project. A second process reopens the project to verify the name. Each attempt gets its own Ghidra project under `runs/`.

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
