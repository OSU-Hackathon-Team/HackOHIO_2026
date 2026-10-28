# Handoff: scoped native reverse engineering and cached MCP readers

Updated 2026-10-24 America/New_York. Artifact timestamps below are UTC (2026-10-25).

**The user ended this task by requesting this handoff. Do not continue experiments
as part of the outgoing agent's turn.** No changes were committed, merged, or pushed
by this agent. The EC2 worker is stopped.

## Start in the isolated checkout

All implementation edits are **uncommitted** on `fix/scoped-native-analysis` at:

```text
C:\Desktop\Coding Projects\HackOHIO_2026\.worktrees\scoped-native-analysis
```

Its base is `c17df3f` (`merge: feat/decomp-lo-pipeline into dev`). Do not delete this
worktree: it contains the implementation. The root checkout is used concurrently
and switched branches during work. Root edits that briefly contained this task's
files were byte-checked and removed after preserving them in the isolated worktree.
`.git/info/exclude` locally excludes `/.worktrees/`.

At the last root status check, somebody else's changes were present in
`packages/backend/src/engine/oracle.ts` and `oracle.test.ts`. Preserve them. Do not
switch the root checkout to do this work or incidentally stage its files.

This handoff is archived under `docs/archive/handoffs/`. Read the root AGENTS instructions,
`.agents/README.md`, `development_guidelines.md`, `docs/handoffs/libreoffice-rea.md`,
`DecompPileline.md`, and `DECOMP_IMPLEMENTATION_PLAN.md`. The earlier EC2 record in
`docs/LIBREOFFICE_EC2_TRIAL.md` is historical and has not been updated with the final success
below.

## User intent and the important architecture correction

We are helping Engineer 1 use **our orchestration + LibreOffice**, OpenCode/Qwen,
REA MCP 6.7.0, and Ghidra MCP. We are not using a LibreOffice source checkout as
input and are not implementing a new provider library.

The user correctly challenged requiring an already-known feature/function before
reverse engineering. The agreed conceptual order is:

```text
App-wide reconnaissance
  -> candidate subsystems (tentative boundaries, not verified features)
  -> scoped reverse engineering, expanding where evidence requires
  -> supported behavioral evidence
  -> feature / requirements extraction
```

Broad context can use modules, dependencies, entry points, symbols, strings, UI
resources, and runtime observations. It does not require deep decompilation of
every function. Names are discovery clues, not behavioral proof.

**Automatic app-wide subsystem discovery is NOT implemented here.** The named
exported-function trial is only a tooling diagnostic. Do not present it as Calc
formula recovery or general application intake. To preserve that distinction:

- `LoPipelineConfig.scoped_analysis` defaults to **False**.
- `scripts/lo_pipeline.py --analysis-profile` still defaults to **light**; its
  legacy light/full paths analyze the module before triage.
- `--analysis-profile scoped` explicitly enables the new seed-first path.
- `scripts/lo_agent_trial.py` defaults to scoped preparation for its diagnostic.
- Full pipeline integration, feature discovery, and acceptance remain pending.

## Actual results

Before this work, a model trial timed out at 300.681 seconds during REA cold
Ghidra analysis. A no-model repeat with 8 GB heap and five disabled analyzers hit
a 540-second provider timeout. The error exceeded REA's MCP response budget.

The new path imports the ELF for context using `-noanalysis`, then disassembles
only selected, sized function-symbol ranges. It never silently falls back to full
analysis when a symbol extent is unavailable.

Observed against `/usr/lib/libreoffice/program/libsclo.so`:

- SHA-256: `c5af49a66872a24fff540ae334e90ba9f2608d9ad2ddb5b7c197e044d26efd40`.
- Trial function: `Calc_ScSpreadsheetSettings_get_implementation`.
- Original ELF symbol value: `0x00ba1490`; Ghidra rebased entry: `0x00ca1490`.
- First scoped preparation: **39.614 seconds**.
- Scope: one function, **52 instructions / 203 decoded bytes**, within a
  **227-byte ELF symbol extent**. Unresolved calls and indirect flow are recorded.
- A repeated preparation reused the baseline without another import.
- Successful free check `20261025T032133`: REA **9.801 s**, Ghidra **4.946 s**,
  total checks **14.747 s**. Both returned real pseudocode. Ghidra reported
  `decompile_completed=true`, `timed_out=false`, and nonempty `c`.

### Final approved live trial succeeded as an unreviewed inspection

Latest completed run: **`20261025T032724`**.

- Summary state: `inspected_unreviewed`.
- Model: configured Qwen3 Coder through OpenCode **1.19.4**, using the EC2 role.
- Cached preparation/copies: **0.391 s**; repeated cache check: **0.045 s**.
- Pre-model checks: REA **12.865 s**, Ghidra **4.697 s**.
- `elapsed_seconds`: **43.3 s** after preparation, including those checks.
- Actual completed model tools: `rea_open_binary`, `rea_search_procedures`,
  `rea_procedure_info`, `rea_procedure_pseudo_code`, `ghidra_program_open`,
  `ghidra_function_at`, `ghidra_decomp_function`, and both close tools.
- The raw OpenCode decompiler event contains the actual C text, not just a status.
- OpenCode reported aggregate usage: 120,986 input tokens, 1,043 output tokens,
  cost 0.0563211. This is its reported estimate, not an AWS invoice; input counts
  accumulate across steps.

The model report speculates about locking and COM-style interfaces. Those claims
are **not verified** and require review of callees and original execution. No
formula oracle, independent semantic review, ready dossier, or spec acceptance
was established by this trial.

The user's approval for the additional five-minute model trial **has now been
used**. Older docs saying that approval is unused are superseded by this handoff.
Do not assume authorization for another paid model trial. The handoff rules also
require asking before commits, merges, and pushes. The user still owns
`tests/test_lo_pipeline.py`; do not create it unless asked.

## Implementation files in the isolated worktree

New files:

- `engine/analysis/scoped.py`: ELF/debug symbol extents, scope-budget validation,
  content/configuration-specific cached preparation, private project copies,
  Java-launch adaptation for REA, and real free MCP checks.
- `engine/analysis/scripts/ScopedAnalysis.java`: bounded disassembly with
  `enableCodeAnalysis(false)`, explicit function bodies, bounded direct-call
  expansion, and unresolved frontier reporting. Global auto-analysis is skipped.
- `engine/analysis/scoped_mcp.py`: small stdio adapter using our existing MCP
  client. Restricts exposed tools, preserves upstream structured evidence,
  annotates effective scoped provenance, and exposes structured pseudocode to
  clients that consume text. Ghidra open requests must use the prepared project,
  `read_only=true`, and `update_analysis=false`.
- `tests/test_scoped_analysis.py`: cache identity/reuse, invalid budgets/seeds,
  scope-report integrity, private copies, Java-launch adaptation, real REA
  response shape, runtime-before-analysis ordering, boundary preservation,
  provenance, protocol errors, and rejection of global-analysis requests.

Modified files:

- `engine/analysis/ghidra.py`: explicit `analyze_scoped`, scoped index filtering
  and caching, exporter/version metadata, and analysis limitations in function
  evidence. Existing full/light analysis methods remain available.
- `engine/analysis/rea.py`: native procedure searches return `{address, value}`;
  `procedures()` now accepts `value` and deduplicates raw/normalized evidence rows.
- `engine/investigator.py`: scoped manifests use prepared readers and explicit
  limitations instead of fresh whole-module imports.
- `engine/lo_pipeline.py`: opt-in scoped path discovers runtime or symbol seeds
  before preparation; rebases runtime addresses afterward; preserves unknown
  extents, truncated candidate sets, and callee frontiers as unresolved items.
- `scripts/lo_pipeline.py`: explicit scoped profile, legacy default preserved.
- `scripts/lo_agent_trial.py`: scoped preparation/cache check, `--check-tools`,
  guarded live invocation, preparation timing; `--whole-module` retains the old
  diagnostic explicitly. Model timeout remains capped at 300 seconds.

## Things that cost time and must not be rediscovered

1. **REA on Linux bypasses `support/analyzeHeadless`.** It builds and invokes the
   Java command directly. A headless-script wrapper did not constrain its import.
2. REA probes Java and uses the JVM-reported `java.home` for subsequent launches.
   The current adapter creates a private view of the same JDK and sets
   `-Djava.home` to that valid view so its configured launcher remains in use.
   Version/probe/LaunchSupport calls pass through; headless imports are adapted
   to `-process` a private cached copy with `-noanalysis` and `-readOnly`.
3. REA's ordinary evidence still contains upstream `ghidra-default` and
   default-auto-analysis-complete notices. Those describe upstream defaults,
   **not our adapted session**. The scoped stdio adapter preserves the original
   evidence and adds a distinct effective-context annotation and scope digest.
   Do not strip that distinction or claim unmodified whole-module analysis ran.
4. Ghidra MCP returns a short text status but puts C in `structuredContent.c`.
   The adapter also renders structured results as text, keeping original
   structured content intact, so the agent actually receives pseudocode.
5. Separate readers get separate copies of `baseline.gpr` / `baseline.rep`.
   This follows the existing `WarmGhidraPool` pattern and avoids cross-process
   project locks or changes to the immutable prepared database.
6. Linux JDK symlinks in result archives do not extract cleanly with Windows tar.
   Extract only needed files, or exclude `*/rea-install/*` and `*/rea-java/*`.
7. Windows `python.exe` was unavailable. WSL Python 3.10.12 runs the unit tests.
   The latest local WSL Docker check returned `docker: command not found`; older
   handoffs describe an installation that is no longer present. Do not assume it.

## Tests and unfinished validation

**Last fully observed test run: 41 tests passed**:

```bash
cd "/mnt/c/Desktop/Coding Projects/HackOHIO_2026/.worktrees/scoped-native-analysis"
PYTHONPATH=. python3 -m unittest tests.test_scoped_analysis tests.test_native_engine tests.test_model_runtime
```

After that run, a scoped-index filtering/cache test and an empty-runtime-seed
assertion were added. The user interrupted the command that was going to run
them. The patch is present, but its final test result was not observed. Rerun
the command above and `git diff --check` before claiming the latest tree passes.
Do not count the optional paid integration suite as verified.

The real MCP check and final model trial passed on the deployed payload. Later
local changes were documentation wording and the interrupted test additions;
nevertheless review the worktree diff against the deployment before publishing.

Still unverified: the complete `--analysis-profile scoped` pipeline with Frida,
claim workers/review/oracle/dossier/spec; multi-function/cross-module acceptance;
automatic candidate subsystem discovery; completeness of exception/unwind and
type information. Scoped evidence explicitly says those global passes did not run.
Missing symbol extents fail or remain unresolved instead of guessing boundaries.
The full matching Calc debug-symbol package is still blocked by Ubuntu 503/504;
the exported factory diagnostic does not need DWARF, but formula discovery may.

## EC2 and artifacts

Instance **`i-01fbcb94645a47036`**, `us-east-2`, m7i.2xlarge, Ubuntu 24.04,
encrypted 200 GB gp3. **Stopped**, last observed after the final trial. SSM and an
instance role are configured; no inbound ports, no uploaded static credentials.
Stopped EBS and retained S3 still incur storage charges. No resources were deleted.

Private bucket/role/profile: `splice-lo-trial-1792893524936`.
S3 archive: `results/results.tgz`; payload: `inputs/payload.tgz`.
Final archive observed modified at `2026-10-25T03:28:22Z`.

Root ignored tooling/state (not in the isolated checkout):

```text
decomp-state/ec2-tools/deployment.json
decomp-state/ec2-tools/results.tgz
decomp-state/ec2-tools/results/scoped-trials/20261025T032724/
decomp-state/ec2-tools/resume.mjs
decomp-state/ec2-tools/remote.mjs
decomp-state/ec2-tools/fetch-results.mjs
decomp-state/ec2-tools/start-probe.mjs
decomp-state/ec2-tools/run-scoped-trial.sh
```

The final folder has the extracted summary, model report, events, and Ghidra check.
The archive contains all raw checks, projects, and progress logs. On EC2 they live
under `/var/lib/splice-trial/results/`; code is under `/opt/splice`; existing image
is `splice-worker:lo-agent`. The runner uploads results and stops the instance,
with a scheduled shutdown backstop.

SDK helper scripts must run **from the root checkout**: they read only AWS keys
from its `packages/backend/.env` and load SDKs installed in ignored tooling.
Never print, copy, archive, or commit that file. Source payloads were explicitly
whitelisted from the isolated worktree; no credentials, LibreOffice source, or
held-out case suites were uploaded. Helpers can start instances or spend tokens:
inspect them and current authorization before using them.

## Suggested next pickup

1. Enter the isolated branch, preserve unrelated root work, rerun the interrupted
   unit checks, and review all new/untracked files as well as tracked diffs.
2. Inspect final raw tool results and the model report. Keep speculative claims
   unreviewed; the successful trial is tooling evidence, not feature correctness.
3. Update current docs/journal with these measured outcomes and the discovery-first
   architecture correction. Earlier trial docs still describe the previous failure.
4. Align the application-wide reconnaissance / candidate-subsystem discovery
   stage with the user before making seed-first scoped diagnostics the app default.
   Reuse the new bounded backend for deep analysis after candidates are available.
5. Validate full scoped pipeline integration separately when authorized. Keep
   explicit partial coverage and unresolved dependencies; never fabricate oracle
   observations or infer behavioral claims from names.

No further commands, model calls, deployments, commits, or pushes are requested
by the outgoing user's final handoff instruction.
