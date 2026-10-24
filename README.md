# Decomp pipeline agent scaffold

**Architecture:** [DecompPileline.md](DecompPileline.md) defines the subsystem-oriented engine for 16+ workers. [DECOMP_IMPLEMENTATION_PLAN.md](DECOMP_IMPLEMENTATION_PLAN.md) lists the implementation phases and acceptance gates. Evidence export, bounded scopes, semantic attempts, static review, original probes, partial dossiers, and a PostgreSQL task queue are implemented. The full subsystem pipeline and its acceptance gates remain in progress. The commands below also retain the rename diagnostic.

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

The larger telemetry fixture exercises a bounded native subsystem with parsing, policy checks, and shared-state updates:

```sh
python scripts/build_telemetry_fixture.py
python scripts/probe_telemetry_fixture.py
python scripts/check_decomp_meaningful_leases.py
```

The scope request is `fixtures/decomp/telemetry_scope_request.json`. On the recorded `-O2` shared build, Ghidra indexed 39 functions, exported 39/39 statuses as `ok`, and discovered 21 functions in the telemetry scope with no unresolved edge. The disposable PostgreSQL check held 16 leases at once for 16 distinct telemetry functions and worker IDs. These checks establish task availability and lease concurrency; throughput, semantic quality at scale, and two-host recovery still need measurement.

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

Run semantic tasks through the durable queue after installing `python -m pip install -r requirements-decomp.txt` and setting `DECOMP_DATABASE_URL` to a PostgreSQL DSN:

```sh
python launch.py queue-init --manifest decomp-state/projects/<campaign>/manifest.json
python launch.py queue-enqueue --scope-artifact <scope-artifact-sha256>
python launch.py queue-run-one --manifest decomp-state/projects/<campaign>/manifest.json --worker-id worker-1
python launch.py queue-drain --manifest decomp-state/projects/<campaign>/manifest.json \
  --workers 4 --max-tasks 4
python launch.py queue-status --campaign <campaign>
python launch.py queue-metrics --campaign <campaign> --after-event-id <start-cursor>
python launch.py queue-task --task-id <task-uuid>
python launch.py queue-events --campaign <campaign> --after-id 0
python launch.py queue-review --task-id <validated-task-uuid>
python launch.py queue-review-dependency --task-id <reconciliation-task-uuid> \
  --dependency-index 0
python launch.py queue-resolve-dependencies --task-id <reconciliation-task-uuid> \
  --reviews <review-artifacts.json>
python launch.py queue-reassess --task-id <partial-task-uuid> \
  --reason "Correct missing dependency fields"
python launch.py queue-normalize-partial --task-id <partial-task-uuid>
python scripts/check_decomp_queue.py
```

`queue-run-one` leases one task, renews its lease while the model runs, submits the immutable draft, and checks its scope and evidence structure. `queue-drain` first warms the function export cache, then runs up to 32 worker loops while the database enforces its configured reasoning capacity; it prints each task outcome as it finishes. The PostgreSQL queue uses epochs to reject expired submissions, deduplicates tasks and submissions, retains checkpoints and rejected draft artifacts, caps reasoning leases at 16 by default, and writes progress events in the same transactions as task changes. `queue-metrics` reports attempt outcomes, elapsed time, model usage, and cost from durable attempts and immutable artifacts; `--after-event-id` isolates a drain using the cursor printed by `queue-status` before it starts. `queue-reassess` requeues a partial task, carrying a prior draft only when it is safe to supply as context; the maximum attempt count still applies. `queue-normalize-partial` can promote a rejected draft after deterministic address spelling or single-field text-item normalization passes the full structural check, with a new artifact linked to the original. `queue-review` runs an independent static reviewer; supported claims with unresolved dependencies stay in `needs_reconciliation`. Accepted tasks record `static_only`; original probe agreement still needs separate reconciliation. The queue check creates and removes its own test database; set `DECOMP_TEST_PG_DSN` if the local PostgreSQL test server is elsewhere. Review pool leasing, automatic conflict reconciliation, and full throughput benchmarking remain open M3/M6 work.

`queue-init` applies the current PostgreSQL migrations and audits earlier accepted tasks for unresolved dependencies. Run it again after upgrading the engine. A review with supported claims but unreviewed dependencies is retained as `needs_reconciliation`, with its reason visible through `queue-task` and the ordered `queue-events` cursor. Review every draft dependency against the active helper contract and both raw functions, then pass the resulting artifact IDs as a JSON array to `queue-resolve-dependencies`. Acceptance requires supported reviews for every dependency and unchanged contract versions; uncertain reviews leave the task awaiting reconciliation. The queue event cursor records each dependency review and the final pinned resolution.

Reviewed, accepted claims can be published into explicit semantic slots. Supply a JSON object such as `{"0":"seen_counter_increment"}` for a one-claim draft:

```sh
python launch.py queue-publish-claims --task-id <accepted-task-uuid> --slots <slots.json>
python launch.py queue-publish-contract --task-id <accepted-task-uuid> \
  --claim-index 0 --contract-key record_seen --expected-version 0
python launch.py queue-findings --campaign <campaign>
python scripts/check_decomp_findings.py
```

Findings and contract versions are immutable artifact-backed records. Conditional publication checks the accepted review and contract head versions; conflicting statements in the same subject and semantic slot remain separate, with open conflict records. A changed or disputed contract stales its indexed consumers while unrelated findings remain active. Dependent accepted claims use their recorded resolution pins; semantic slot assignment remains explicit and open conflicts do not auto-resolve.

Independently challenge a draft against the raw function evidence:

```sh
python launch.py review --draft-artifact <draft-artifact-sha256>
```

The reviewer records an outcome for each claim (`supported_static`, `contradicted`, or `uncertain`) plus missing behavior and unresolved questions. A `reviewed` result means the review record is structurally complete; static support and original-execution agreement remain separate. Review attempts and outcomes are stored as immutable artifacts and counted by `launch.py status`.

`python scripts/check_decomp_review.py` seeds an explicitly false constant-return claim on a real stripped fixture and requires the independent reviewer to flag it. Set `DECOMP_REVIEW_CHECK_MODEL` to use a different configured OpenCode model for that check.

Run independently specified cases against the original stripped fixture binaries:

```sh
python launch.py probe --fixtures-manifest decomp-state/fixtures/manifest.json \
  --suite fixtures/decomp/probes.json
```

The probe runner records binary, runner, and adapter hashes; controlled limits; inputs; expected and observed outputs; and an outcome for each case. It distinguishes `agreement`, `disagreement`, and `execution_error`. Shared-library probes use the evaluator-owned ctypes adapter in `scripts/native_probe_adapter.py`; executable probes invoke the original binary. `launch.py status` includes probe counts under a `probe:<binary-sha256>` progress key. Probe agreement and static review remain separate records.

`python scripts/check_decomp_probes.py` also exercises a regression adapter that calls the original `fold_depth` but discards its return value. The differing observed output must produce `disagreement`.

Assemble an immutable dossier from explicit artifact IDs with `python launch.py dossier --manifest <manifest> --scope-artifact <sha256> --inputs <json-file>`. The input file contains arrays named `draft_artifacts`, `review_artifacts`, `probe_report_artifacts`, and optionally `probe_link_artifacts` and `dependency_resolution_artifacts`. A probe link artifact has `schema: 1` and a `links` array. Each link identifies a `draft_artifact`, `claim_index`, `probe_report_artifact`, `case_id`, JSON `observed_pointer`, `expected_observed` value, and evaluator rationale. The assembler checks the original case's binary identity, outcome, and observed field before recording `case_agreement` or `case_disagreement`. This is agreement for the cited case, not proof of a claim across all inputs. `python scripts/check_decomp_probe_links.py` checks that a wrong expected observation becomes a disagreement and a missing field is rejected. With `--dsn` or `DECOMP_DATABASE_URL`, the dossier records a consistent PostgreSQL snapshot of current helper contract heads; without one, reviewed dependencies retain a head-check blocker. The command writes a readable `decomp-state/dossiers/<scope-id>/latest.md` and returns content-addressed JSON and Markdown hashes. It lists missing function drafts, unresolved scope edges, review gaps, unreviewed or stale dependency contracts, and probe linkage gaps as blockers. Readiness remains `partial` until those gaps are resolved; raw Ghidra output, model claims, static review, and original probes stay distinct.

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
