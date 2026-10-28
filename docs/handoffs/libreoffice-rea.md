# Handoff: reverse engineer LibreOffice Calc with REA + Ghidra

**Branch:** `feat/decomp-lo-pipeline`, local only, all changes uncommitted.
**Don't commit or push** unless the user asks. Stage files explicitly; never `git add -A`.
Never commit `.env` or AWS credentials.

## Goal

Eng 1's native decompilation engine needs to produce real, evidence-backed behaviour specs for
LibreOffice Calc's formula interpreter (`libsclo.so`). REA (`rea-agents@6.7.0`) must actually
take part in the run.

## Why this work exists

Before this branch:
- The Python engine (`engine/`, `launch.py`) never called REA.
- `scripts/stress_test_calc_formula_engine.py` and `assemble_calc_formula_dossier.py` stage
  their results:
  - Each probe copies `expected` into `observed`.
  - Claims are written from function names, not from the decompiler output.
  - Readiness is hard-coded.
  - The "cleanroom" C file existed before the run.

Both scripts now print a warning. Don't delete them; they belong to Eng 1. Don't use their
output as evidence.

## What was built (uncommitted)

| File | Role |
|---|---|
| `engine/lo_pipeline.py` | Orchestrator; see the stage list below. Dependencies are injected so it can be tested with fakes. |
| `engine/analysis/rea.py` | REA launch (`rea_command`), `static_triage` (search_procedures/strings/xrefs), `RuntimeTracer` (persistent Frida session through REA; hit offset + image_base gives the Ghidra entry) |
| `engine/analysis/mcp_stdio.py` | Minimal stdio JSON-RPC MCP client used for REA |
| `engine/analysis/elfinfo.py` | `.symtab` / GNU build-id / `/usr/lib/debug/.build-id` debug file detection |
| `engine/libreoffice.py` | `find_install`, case suite load and held-out split, `UnoDriver`, `probe_report` (same record shape as `engine/validation/probes.py`, so `dossier.py` and `gaps.py` accept it) |
| `scripts/lo_uno_driver.py` | Runs under system `/usr/bin/python3` (needs `import uno`). JSON line protocol: `ready` (with soffice.bin pid), `eval`, `quit` |
| `engine/investigator.py` | Optional OpenCode agent with REA + Ghidra MCP servers and read-only tools. Answers open review questions and feeds a `revision_context` back to `SemanticWorker` |
| `engine/analysis/scripts/LightAnalysisOptions.java` | Ghidra pre-script that turns off expensive analyzers for huge libraries |
| `fixtures/decomp/libreoffice/formula_cases.json` | 32 formula cases; 10 `held_out`; 7 `confidence: "unverified"` |
| `scripts/lo_paths.py`, `lo_oracle.py`, `lo_pipeline.py` | CLIs; see "How to run" |

Pipeline stages in `run_pipeline`:
1. Ghidra `analyze` (light profile).
2. REA triage: Frida runtime hits per public case, or REA static search.
3. `seeds_from_runtime` picks seeds from those hits (no hand-picked addresses).
4. `persist_scope` builds the scope from those seeds.
5. `SemanticWorker` writes claims with runtime observations; `IndependentReviewer` checks them.
6. The oracle runs every case in real LibreOffice.
7. `persist_dossier` decides readiness.
8. `persist_spec` runs only if readiness is `ready_for_spec`.

Edits to Eng 1's existing files (all flagged to the user):
- `engine/analysis/ghidra.py`: `analysis_profile="full"|"light"`. `full` keeps
  `analysis_options: {}`, so existing campaign hashes and caches are unchanged.
- `engine/scope.py`: finds companion symbols by build-id; caches `nm` output.
- `engine/worker.py`: `SemanticWorker.run(..., runtime_observations=...)` appends them to the
  prompt and stores an artifact.
- `engine/model_runtime.py`: `invoke_opencode(..., mcp=..., allow_tools=...)`.
- `compose.yaml`: `MODEL_DECOMP_WORKER` / `MODEL_SPEC_WRITER` defaults changed from Nova to
  Qwen3 Coder 480B, matching `models.json`.
- `worker.Dockerfile`: adds `libreoffice-calc-nogui`, `python3-uno`, binutils, gdb, nodejs/npm,
  `rea-agents@6.7.0`, `frida==17.2.17`, `frida-tools==14.4.5`, and ddebs debug symbols
  (`libreoffice-calc-dbgsym`, `libreoffice-core-dbgsym`). ENV sets
  `REA_COMMAND="rea-agents mcp"`, `LO_PYTHON`, `SAL_USE_VCLPLUGIN=svp`.

## Verified so far

- All new and changed Python files compile and import under Python 3.10 in WSL.
- `tests/test_native_engine.py`: 26/26 pass in WSL, after these edits.
- Nothing else is verified. No new unit tests exist. The user said they will write
  `tests/test_lo_pipeline.py` themselves, so don't write it unless asked.
- The pipeline, REA, Frida, the UNO driver and the Ghidra light profile have **never run**.

## Environment on this machine

- Windows host; no Docker on Windows. Run Python tests in WSL, because `engine/intake.py`
  imports `fcntl`:
  `wsl -d Ubuntu-22.04 -- bash -lc 'cd "/mnt/c/Desktop/Coding Projects/HackOHIO_2026" && PYTHONPATH=. python3 -m unittest tests.test_native_engine'`
- Docker Engine 29.1.3 + Compose 2.40 were installed **inside WSL Ubuntu-22.04** (apt
  `docker.io docker-compose-v2`). Use `wsl -d Ubuntu-22.04 -u root -- bash -lc '...'`.
- WSL resources: 12 cores, 7 GB RAM, about 950 GB disk. 7 GB is tight for Ghidra on
  `libsclo.so` plus LibreOffice at the same time.
- Image `splice-worker:lo` was being built when this was written:
  `docker build -f worker.Dockerfile -t splice-worker:lo .`, log in WSL at
  `/tmp/worker-build.log`.
  - Check whether it finished: `docker images splice-worker`.
  - Check whether debug symbols failed: `grep "warning: LibreOffice debug" /tmp/worker-build.log`.
- The first build failed because a scripted edit mangled backslash continuations in the
  Dockerfile. It's now fixed; if you edit it again, use the editor, not shell heredocs.

## How to run (inside the container)

```bash
# from WSL, repo mounted at /workspace; privileged is needed for Frida ptrace
docker run --rm -it --privileged -v "/mnt/c/Desktop/Coding Projects/HackOHIO_2026:/workspace" \
  -w /workspace -e CONTAINER_ORCHESTRATOR=1 splice-worker:lo bash
```

Free steps, in this order:
1. `python3 scripts/lo_paths.py`
   - Every line should be ok. `debug_file` for `libsclo.so` matters most; without it, names
     are `FUN_*`.
2. `python3 scripts/lo_oracle.py --characterize decomp-state/lo_characterized.json`
   - Shows what real LibreOffice returns. Give the user the `unverified` cases to confirm.
   - Never "fix" a disagreement by editing `observed`. Only a human-confirmed change to the
     suite's `expected` is allowed.

Costs Bedrock tokens, so **ask the user first**. It needs fresh AWS credentials in the
repo-root `.env`, `AWS_REGION=us-east-2` (Qwen was verified there), and the OpenCode binary
plus auth file mounted (`OPENCODE_BIN` defaults to `/run/opencode-bin`):

```bash
python3 scripts/lo_pipeline.py --max-functions 20 --workers 2   # start small
```

- The summary goes to `decomp-state/lo_runs/*.json`.
- Exit code 2 means the dossier isn't ready; the blockers are in the summary.
- If Frida fails, use `--seed-source rea_static --static-pattern '...'`.

## Known risks, likely first failures

- **REA Frida on Linux:** it's unknown whether REA's Frida provider needs the npm `frida` module
  instead of the pip one. `RuntimeTracer` parses REA's response shapes loosely (`_first`,
  `script_messages`); adjust these to the real payloads you see.
- **REA Ghidra static open:** may need `REA_GHIDRA_STARTUP_TIMEOUT_MS` raised, and may need its
  own Ghidra path config.
- **ddebs debug symbols** may not match the installed LibreOffice version.
- **Light analysis option names** in `LightAnalysisOptions.java` aren't verified against
  Ghidra 12.1.3. Unknown names are logged and skipped.
- **Address format:** runtime hits map to index entries by integer value. Ghidra's string
  format of entries (e.g. `0011b900`) isn't assumed.
- **UNO grammar:** `setFormula` uses `;` between function arguments. Error codes expected:
  532 `#DIV/0!`, 519 `#VALUE!`, 502 invalid argument, 503 `#NUM!`.
- **Scoring:** LibreOffice source must never reach a model prompt or the spec.

## Rules

- Report real command output. Don't claim a stage works until you've run it.
- Ask before Bedrock spend, commits, merges or pushes.
- Background: [`decompilation-recommendations.md`](decompilation-recommendations.md) (slowness and
  junk causes), and [`../NATIVE_CLEANROOM_HANDOFF.md`](../NATIVE_CLEANROOM_HANDOFF.md) (cleanroom
  separation; held-out cases stay hidden from the spec writer and implementer).
- The plan is at `C:\Users\pohfe\.claude\plans\yeah-rename-the-branch-federated-eclipse.md`.

## EC2 runtime follow-up (2026-10-24 local / 2026-10-25 UTC)

See [the EC2 trial record](../LIBREOFFICE_EC2_TRIAL.md) for exact outcomes and
resource IDs. Runtime setup is present in `7250435` (`EC2 Migration`); these
follow-up diagnostics and documentation edits remain local. Existing user edits
are preserved; this agent did not create that commit.

- Native regression suite plus two new launcher regressions: **28/28 pass**.
- Fixed REA's Node 18 import crash by pinning Node 22.19.0. REA 6.7.0 and Ghidra
  MCP startup/catalog checks expose 207 and 212 tools respectively.
- Explicit active Qwen registration, session title/small-model configuration,
  and working-directory isolation fix OpenCode startup. A calculator smoke
  returned 391; an EC2 model invocation successfully called `rea_open_binary`.
- Worker now pins OpenCode 1.19.4 and isolates Frida CLI dependencies from the
  main Python environment. Actual EC2 `pip check`: no broken requirements.
- The matching debug package is `libreoffice-calc-nogui-dbgsym`. Ubuntu's server
  returned 503/504; the complete symbols gate remains blocked. Hash-verified
  download retries are present, but a successful installation is not claimed.
- EC2 `i-01fbcb94645a47036` in us-east-2 uses m7i.2xlarge, encrypted 200 GB gp3,
  a scoped instance role, SSM, and no inbound ports. No credential files were
  uploaded. It is **stopped**, retaining disk and private S3 evidence.
- First model trial timed out at 300.681 seconds during REA cold Ghidra analysis,
  after opening the real binary. No independent Ghidra MCP decompilation ran.
- A no-model repeat confirmed the supported 8 GB heap override and light
  analysis settings, but hit its 540-second provider deadline. The timeout's
  diagnostic exceeded REA's MCP response budget and became `resource_constraint`.
- One further five-minute model trial is approved but unused: its prerequisite
  free check failed. Keep that authorization; do not spend it on another known
  cold-start timeout. Separate longer preparation and reusable sessions first.

`scripts/lo_agent_trial.py` prepares by default; `--run-live` is explicit and
bounded to 300 seconds. `scripts/ec2_lo_trial_bootstrap.sh` is the reproducible
strict-preflight bootstrap; the exported-function experiment's missing-DWARF
exception is recorded separately. Formula recovery and live pipeline readiness
remain unverified. The user still owns `tests/test_lo_pipeline.py`.
