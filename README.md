# Splice native decompilation engine

**Architecture:** [DecompPileline.md](DecompPileline.md) defines the subsystem-oriented engine for 16+ workers. [DECOMP_IMPLEMENTATION_PLAN.md](DECOMP_IMPLEMENTATION_PLAN.md) lists the implementation phases and acceptance gates. Evidence export, bounded scopes, semantic attempts, static review, original probes, partial dossiers, and a PostgreSQL task queue are implemented. The full subsystem pipeline and its acceptance gates remain in progress. The commands below also retain the rename diagnostic. The TypeScript app remains under `packages/`; `fixtures/decomp/` contains native evaluation targets.

## Project intake

Analyze a group of executable and shared-library modules with one request. Paths are relative to the request file unless absolute. ELF dependency discovery requires `readelf`; the fixture check also requires `gcc` and `strip`:

```json
{"schema":1,"modules":[{"id":"app","kind":"executable","path":"app.bin"},{"id":"math","kind":"shared","path":"libmath.so"}]}
```

```sh
python launch.py project-analyze --request /path/to/project.json
python launch.py project-export-all --project-artifact <project-inventory-sha256>
python launch.py project-scope --project-artifact <project-inventory-sha256> \
  --request /path/to/project-scope.json
python launch.py project-queue-init --project-scope-artifact <project-scope-sha256>
python launch.py project-queue-drain --project-scope-artifact <project-scope-sha256> \
  --workers 16
python launch.py project-queue-status --project-scope-artifact <project-scope-sha256>
python launch.py status --campaign <project-id>
python scripts/check_decomp_intake.py
```

The pointer at `decomp-state/intakes/<project-id>/manifest.json` names an immutable inventory artifact. That inventory lists each module's binary hash, analysis campaign, index artifact, and module manifest path. For ELF files, intake reads `DT_NEEDED` and matches supplied shared libraries by filename or SONAME. Unmatched libraries remain explicit external dependencies; ambiguous matches remain unresolved. A request may also declare edges with `"dependencies":[{"from":"app","to":"math"}]`, including for other binary formats. Intake reuses each module's import cache. Its separate `symbol_links_artifact` records imported-function thunk addresses, raw call sites, and matching function entries in supplied dependency modules. Matches are labeled `candidate_static`; dynamic loader binding, symbol interposition, and symbol versions remain unverified. Ambiguous and unmatched imports stay visible. `project-export-all` exports every indexed function in every supplied module, preserving per-module failures and an immutable aggregate under `decomp-state/intakes/<project-id>/exports/latest.json`. It reports unreported functions separately, and its `complete_discovered_exports` flag covers only functions found by Ghidra; executable instructions outside functions, bytes not decoded as instructions, and behavioral validation remain separate gaps. Project events in `progress.jsonl` and `status` show module starts, completions, failures, export counts, symbol-link counts, code gap counts, and artifact IDs. Cross-module contract reconciliation and aggregate dossiers remain open.

For a bounded cross-module question, use a project scope request such as `{"mode":"subsystem","query":"adjust from executable","seeds":[{"module":"app","seed":"00101050"}],"max_functions_per_module":32,"max_depth":2}`. `project-scope` creates a normal scope artifact for each reached module and adds uniquely matched imported functions as *questions for analysis*. Its project artifact lists module scope IDs, task counts, static cross-module candidates, unverified bindings, unmatched imports, and unexplored modules. Use `{"mode":"project","query":"whole project","max_functions_per_module":100}` to inventory every supplied module, subject to the stated per-module limit. The project scope stays `partial`; candidate links do not turn into accepted dependency contracts. Queue and dossier commands still operate on the emitted module scope artifacts, and the current spec generator consumes their module dossiers separately. Those dossiers report unresolved cross-module bindings as blockers in the spec handoff.

`project-queue-init` validates the project and module scope identities, applies the PostgreSQL migrations, registers each reached module campaign, and enqueues its behavior tasks. Repeating it reuses deduplicated tasks. `project-queue-drain` validates the saved module baselines, exports their indexed functions, then runs only this scope's leased semantic tasks across the reached modules under the shared reasoning pool capacity. `project-queue-status` shows task states for this project's selected work separately from each module campaign's full queue; tasks shared with another scope are counted as shared. These commands need `--dsn` or `DECOMP_DATABASE_URL`. Independent review and dossier assembly still run per module. Check the queue integration with `python scripts/check_decomp_project_queue.py`; the linked binary intake check also uses a disposable PostgreSQL database (`DECOMP_TEST_PG_DSN` if the default test server differs).

## Native evidence export

With Ghidra's `analyzeHeadless` installed, import an executable or shared library once and index its functions, imports, strings, and direct calls:

```sh
python launch.py analyze --binary /absolute/path/to/program
python launch.py status
```

`analyze` prints a manifest under `decomp-state/projects/<campaign>/manifest.json`. The campaign key includes the input SHA-256, Ghidra version, exporter revision, and analysis options. Concurrent requests for the same campaign share one import and index; an interrupted import is rebuilt before indexing. Repeating the command reuses the indexed baseline. `launch.py status` reports import/index time, recovery attempts, and cache hits. Export a selected function or every discovered function:

```sh
python launch.py function --manifest decomp-state/projects/<campaign>/manifest.json --address 00401136
python launch.py export-all --manifest decomp-state/projects/<campaign>/manifest.json
```

Each function artifact records its entry address, decompilation status, C rendering, instructions, references, defined data targets, and separate listing and decompiler-inferred type information. Inferred parameters are not confirmed source types; source and lock fields preserve that distinction. External functions and decompilation errors have explicit statuses. Targeted cache misses use two reusable Ghidra contexts by default; set `DECOMP_ANALYSIS_WORKERS` to `0..16` to size the local pool (`0` uses a fresh process per request). Each context opens a separate copy of the closed analyzed project because this Ghidra headless version locks projects even in read-only mode. A failed or timed-out context is stopped and started again on its next request. `export-all` keeps one Ghidra decompiler context open for the full indexed program and returns a coverage inventory. Its `complete` flag means every *discovered* function exported successfully; it does not mean all behavior has been discovered or validated. The index records executable memory, decoded instructions outside functions, defined data in executable memory, and bytes Ghidra classified as neither instruction nor defined data. It lists up to 4096 unclassified byte regions and reports the full byte and region counts plus whether the list was truncated. These bytes may be code, padding, or other material and require inspection before claiming whole-binary coverage. `decomp-state/progress.jsonl` contains append-only JSON events, including each completed function and warm-pool activity, for a future job API/UI; `launch.py status` summarizes exports, cache hits, pool waits, completions, failures, worker restarts, and the latest indexed static inventory. All artifacts are SHA-256 addressed under `decomp-state/artifacts/`. This is static evidence, not a validated behavioral dossier.

Build source-known stripped executable and shared-library fixtures at `-O0` and `-O2`, then execute held-out cases against the original code:

```sh
python scripts/build_decomp_fixtures.py
python scripts/probe_decomp_fixtures.py
python scripts/check_decomp_export.py
python scripts/check_decomp_import_cache.py
python scripts/check_decomp_warm.py
python scripts/check_decomp_scope.py
```

The generated manifest, debug companions, and probe report stay in ignored `decomp-state/fixtures/`. Analysis workers should receive only the stripped `analysis_path` entries. The source and debug companions are evaluator material.

The larger telemetry fixture exercises a bounded native subsystem with parsing, policy checks, and shared-state updates:

```sh
python scripts/build_telemetry_fixture.py
python scripts/probe_telemetry_fixture.py
python launch.py probe --fixtures-manifest decomp-state/fixtures/telemetry_manifest.json \
  --suite fixtures/decomp/telemetry_probes.json \
  --adapter scripts/telemetry_probe_adapter.py
python scripts/check_decomp_meaningful_leases.py
```

The scope request is `fixtures/decomp/telemetry_scope_request.json`. On the recorded `-O2` shared build, Ghidra indexed 39 functions, exported 39/39 statuses as `ok`, and discovered 21 functions in the telemetry scope with no unresolved edge. The disposable PostgreSQL check held 16 leases at once for 16 distinct telemetry functions and worker IDs. These checks establish task availability and lease concurrency; throughput, semantic quality at scale, and two-host recovery still need measurement.

Discover a bounded subsystem from indexed evidence:

```sh
python launch.py scope --manifest decomp-state/projects/<campaign>/manifest.json \
  --request fixtures/decomp/scope_request.json
```

The scope revision records ranked seeds, included functions, direct-call and shared-data expansion, boundary contracts, exclusions, unresolved indirect calls, and deduplicated behavioral questions. Project scopes also retain decoded executable instruction runs outside known functions as unresolved work; the export inventory carries the same counts and address ranges. Scope artifacts and revision pointers live under `decomp-state/scopes/`; `launch.py status` reports scope counts. A scope remains `partial` until semantic claims and independent validation are available.

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
python launch.py queue-review-fixed-memory --task-id <validated-task-uuid>
python launch.py queue-review-drain --campaign <campaign> --workers 2 --max-tasks 2
python launch.py queue-review-dependency --task-id <reconciliation-task-uuid> \
  --dependency-index 0
python launch.py queue-adjudicate-gaps --task-id <reconciliation-task-uuid> \
  --probe-report-artifact <original-probe-report-sha256> \
  --model amazon-bedrock/amazon.nova-pro-v1:0
python launch.py queue-resolve-dependencies --task-id <reconciliation-task-uuid> \
  --reviews <review-artifacts.json>
python launch.py queue-reassess --task-id <partial-task-uuid> \
  --reason "Correct missing dependency fields"
python launch.py queue-normalize-partial --task-id <partial-task-uuid>
python launch.py queue-reclassify-intrinsic --task-id <reconciliation-task-uuid>
python launch.py queue-repair-dependency-citations --task-id <reconciliation-task-uuid>
python launch.py queue-complete-direct-calls --task-id <reconciliation-task-uuid>
python launch.py queue-reopen-review --task-id <reconciliation-task-uuid> \
  --reason "Recheck path coverage"
python launch.py queue-revise-semantics --task-id <reconciliation-task-uuid> \
  --reason "Add omitted accepted-path effects"
python launch.py queue-expand-coverage --task-id <reconciliation-task-uuid> \
  --model amazon-bedrock/amazon.nova-pro-v1:0
python scripts/check_decomp_queue.py
```

`queue-run-one` leases one task, renews its lease while the model runs, submits the immutable draft, and checks its scope and evidence structure. `queue-drain` first warms the function export cache, then runs up to 32 worker loops while the database enforces its configured reasoning capacity; it prints each task outcome as it finishes. The PostgreSQL queue uses epochs to reject expired submissions, deduplicates tasks and submissions, retains checkpoints and rejected draft artifacts, caps reasoning leases at 16 by default, and writes progress events in the same transactions as task changes. `queue-metrics` reports attempt outcomes, elapsed time, model usage, and cost from durable attempts and immutable artifacts, plus review artifact usage and outcomes; `--after-event-id` isolates a drain using the cursor printed by `queue-status` before it starts. `queue-reassess` requeues a partial task, carrying a prior draft only when it is safe to supply as context; the maximum attempt count still applies. `queue-normalize-partial` can promote a rejected draft after deterministic address spelling or single-field text-item normalization passes the full structural check, with a new artifact linked to the original. `queue-review` runs an independent static reviewer; supported claims with unresolved dependencies stay in `needs_reconciliation`. Accepted tasks record `static_only`; original probe agreement still needs separate reconciliation. The queue check creates and removes its own test database; set `DECOMP_TEST_PG_DSN` if the local PostgreSQL test server is elsewhere. Automatic conflict reconciliation and full throughput benchmarking remain open M3/M6 work.

`queue-review-fixed-memory` is an independent deterministic review for straight-line x86 functions containing fixed-address zero-vector stores, immediate stores, and a final `RET`. It computes written bytes and overlap counts, supports only claims in its explicit store/overlap/final-value grammar, and refuses unsupported instructions. Its review artifact identifies the deterministic method. This narrow lane resolved the telemetry reset helper after model reviewers disagreed about overlapping vector stores; it does not establish semantic support for other instruction patterns. `python scripts/check_decomp_memory_effects.py` exercises a false overlap and the supported reset shape.

`queue-init` applies the current PostgreSQL migrations, audits earlier accepted tasks for unresolved dependencies, and backfills durable review jobs for validated drafts or historically reviewed tasks. `queue-status` reports any tasks still missing a review job. Run `queue-init` again after upgrading the engine. `queue-review-drain` leases queued jobs through the independently capped review pool, renews leases while the reviewer runs, and records each outcome; expired review leases can be recovered. A review with supported claims but unreviewed dependencies is retained as `needs_reconciliation`, with its reason visible through `queue-task` and the ordered `queue-events` cursor. For a reviewed x86 function with no direct or indirect calls, `queue-reclassify-intrinsic` moves mistaken memory or input "dependencies" into visible state unknowns, creates a linked draft, and queues a fresh independent review. It refuses functions that may call another function. `queue-reopen-review` rechecks an unresolved, unpublished draft against updated review criteria. `queue-revise-semantics` starts a bounded new reasoning attempt for a contradicted or incomplete unpublished draft, with its old draft and review supplied as untrusted context. `queue-expand-coverage` requests additional cited claims for each reviewer-identified omission, records the model output and source review, and queues a fresh review only when every omission is mapped and the merged draft passes structural validation. Expansion is capped at two published revisions per task. Review every real draft dependency against the active helper contract and both raw functions, then pass the resulting artifact IDs as a JSON array to `queue-resolve-dependencies`. Acceptance requires supported reviews for every dependency and unchanged contract versions; uncertain reviews leave the task awaiting reconciliation. The queue event cursor records each dependency review and the final pinned resolution.

`queue-repair-dependency-citations` performs at most one deterministic repair for a reviewed, unpublished task. It maps existing dependency names to unique scoped function entries and raw direct-call sites, records the old and new citations in an immutable draft, and queues another independent review. It never adds a dependency or infers callee behavior; unbound calls remain visible. The dependency reviewer checks that the caller cites a direct call to the helper's actual entry before spending a model call. Resolution and dossier assembly repeat that check. Dossiers list direct calls that have no correctly bound dependency, including calls attributed to the wrong helper; those calls remain readiness blockers.

`queue-complete-direct-calls` adds only uncovered direct-call dependencies when each target has a matching active, reviewed helper contract. It copies the contract statement, cites the exact call site, records the contract artifact and version, and queues the changed caller for independent review. Missing or changed contracts block the operation. The dependency reviews and pinned resolution remain separate requirements.

`queue-revise-semantics` accepts `--probe-report-artifact` for a bounded revision. The report must contain original-execution cases for the same campaign binary and scoped function. The worker sees observed values alongside raw instruction evidence; previous model output remains untrusted.

Reviewed, accepted claims can be published into explicit semantic slots. Supply a JSON object such as `{"0":"seen_counter_increment"}` for a one-claim draft:

```sh
python launch.py queue-publish-claims --task-id <accepted-task-uuid> --slots <slots.json>
python launch.py queue-publish-contract --task-id <accepted-task-uuid> \
  --claim-index 0 --contract-key record_seen --expected-version 0
python launch.py queue-publish-contract --task-id <accepted-task-uuid> \
  --claim-indices 0,1 --contract-key record_accepted --expected-version 0
python launch.py queue-findings --campaign <campaign>
python scripts/check_decomp_findings.py
```

Findings and contract versions are immutable artifact-backed records. A helper contract can cover several independently supported claims from one task. Conditional publication checks the accepted review and contract head versions; conflicting statements in the same subject and semantic slot remain separate, with open conflict records. A changed or disputed contract stales its indexed consumers while unrelated findings remain active. Dependent accepted claims use their recorded resolution pins; semantic slot assignment remains explicit and open conflicts do not auto-resolve.

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
python launch.py probe --fixtures-manifest decomp-state/fixtures/telemetry_manifest.json \
  --suite fixtures/decomp/telemetry_apply_probes.json \
  --adapter scripts/telemetry_probe_adapter.py
```

The probe runner records binary, runner, and adapter hashes; controlled limits; inputs; expected and observed outputs; and an outcome for each case. It distinguishes `agreement`, `disagreement`, and `execution_error`. Shared-library probes use the evaluator-owned ctypes adapter in `scripts/native_probe_adapter.py`; executable probes invoke the original binary. `launch.py status` includes probe counts under a `probe:<binary-sha256>` progress key. Probe agreement and static review remain separate records.

`python scripts/check_decomp_probes.py` also exercises a regression adapter that calls the original `fold_depth` but discards its return value. The differing observed output must produce `disagreement`.

Assemble an immutable dossier from explicit artifact IDs with `python launch.py dossier --manifest <manifest> --scope-artifact <sha256> --inputs <json-file>`. The input file contains arrays named `draft_artifacts`, `review_artifacts`, `probe_report_artifacts`, and optionally `probe_link_artifacts` and `dependency_resolution_artifacts`. A probe link artifact has `schema: 1` and a `links` array. Each link identifies a `draft_artifact`, `claim_index`, `probe_report_artifact`, `case_id`, JSON `observed_pointer`, `expected_observed` value, and evaluator rationale. The assembler checks the original case's binary identity, outcome, and observed field before recording `case_agreement` or `case_disagreement`. This is agreement for the cited case, not proof of a claim across all inputs. `python scripts/check_decomp_probe_links.py` checks that a wrong expected observation becomes a disagreement and a missing field is rejected. With `--dsn` or `DECOMP_DATABASE_URL`, the dossier records a consistent PostgreSQL snapshot of current helper contract heads; without one, reviewed dependencies retain a head-check blocker. The command writes a readable `decomp-state/dossiers/<scope-id>/latest.md` and returns content-addressed JSON and Markdown hashes. It lists missing function drafts, unresolved scope edges, review gaps, unreviewed or stale dependency contracts, and probe linkage gaps as blockers. Readiness remains `partial` until those gaps are resolved; raw Ghidra output, model claims, static review, and original probes stay distinct.

The dossier inputs may also include `gap_adjudication_artifacts`. Each adjudication must match a supplied draft, review, and original probe report. Its decisions and reasons remain visible; blocking or uncertain decisions remain dossier blockers. A matching original case with disagreement or execution error prevents gap clearance. `queue-adjudicate-gaps` uses a model different from the claim reviewer and clears review gaps only when all current claims have static support and every gap is independently classified nonblocking. Tasks with dependencies remain in reconciliation until every dependency is reviewed against its active helper contract. Dossier coverage reports distinct original cases and total probe runs separately.

Check a persisted dossier against the existing specification generator's input contract
without writing a specification artifact:

```sh
python scripts/check_decomp_handoff.py --dossier-artifact <dossier-artifact-sha256>
```

The check preserves dossier coverage, original cases, blockers, and evidence links. The
current execution boundary in `DECOMP_IMPLEMENTATION_PLAN.md` stops before advancing a
live campaign into specification generation.

The existing generator can produce a native subsystem specification from one immutable
dossier revision when that phase is resumed:

```sh
python launch.py spec --dossier-artifact <dossier-artifact-sha256>
python scripts/check_decomp_spec.py
```

The command writes content-addressed JSON and Markdown under `decomp-state/specifications/<scope-id>/`. Supported static claims become numbered requirements with raw addresses, independent reviews, and linked original cases. Function inputs, outputs, state, effects, errors, and pseudocode remain labeled as draft descriptions. Unsupported claims, review gaps, unresolved edges, exclusions, dependency status, and dossier blockers remain explicit. Case agreement applies only to the recorded input, and a `partial` specification is not verified. Repeating the command for the same dossier artifact returns the same spec artifact. Old dossier artifacts missing current handoff fields are rejected with a field list; reassemble them from their persisted inputs before generating a spec. The Node backend exposes the same handoff with `POST /api/native-specs` (`{"dossier_artifact":"<sha256>"}`) and `GET /api/native-specs/<spec-artifact-sha256>`; set `DECOMP_STATE_DIR` if the engine state is outside the repository. The native spec contract is separate from the Electron `FeatureSpec`.

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
| `legal_verification` | `amazon-bedrock/amazon.nova-pro-v1:0` | `MODEL_LEGAL_VERIFICATION` |

Resolution order: `--model` (or assignment `"model"`) > `MODEL_<ROLE>` env > `models.json` role > `OPENCODE_MODEL` (legacy default override) > `models.json` `default`. Inspect the resolved table with:

```sh
docker compose run --rm orchestrator python launch.py list-models
```

`launch.py rename` accepts `--model-role <role>` (default `decomp_worker`); `--model provider/model` overrides the role for that run. Batch assignments accept optional `"model"` and `"model_role"` fields. `python launch.py list-models` shows the resolved table.

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
