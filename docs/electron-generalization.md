# Electron reconstruction from a specification

The reconstruction pipeline takes a packaged Electron `app.asar` and produces a runnable Electron
project. Nothing in the pipeline knows an application's name, channels, storage layout or features
in advance. It runs in two deliberately separated stages:

1. **Specification** — an agent observes the original app through the black-box oracle and writes
   a public specification: channels, reachable fixtures, argument samples, numbered behavioral
   requirements and stateful sequences.
2. **Implementation** — a *different* agent receives only that specification and the public
   differential cases. It has no oracle, no archive path and no archive files, so it cannot probe
   the original.

That split is the point. A single agent with oracle access can fill any gap in its own notes by
probing; then a passing result proves nothing about the handoff. With the split, an implementer
that passes demonstrates the specification was sufficient.

```bash
npm ci
npm run electron:reconstruct -- targets/build/recall/app.asar /tmp/recall-reconstructed
cd /tmp/recall-reconstructed
npm install
npm start
```

The run needs AWS credentials with Bedrock access. Model roles come from `models.json`:

| Role | Stage | Override |
|---|---|---|
| `electron_spec_writer` | observes and writes the specification | `MODEL_ELECTRON_SPEC_WRITER` |
| `electron_implementer` | implements from the public handoff | `MODEL_ELECTRON_IMPLEMENTER` |
| `electron_reconstructor` | fallback for both stages | `MODEL_ELECTRON_RECONSTRUCTOR` |

The child process receives `AWS_*` values from the repo `.env`; refresh those from the AWS CLI when
the session expires. Each round runs `opencode run --standalone` so it loads that round's agent
list, tools and MCP servers instead of reusing a background service started by an earlier run.

## Stages

1. **Static inventory** (`analyze-archive.mjs`). Reports the main entry, preloads, renderer loads,
   local module graph, IPC channels with handler arity, bridge globals and methods, assets, and
   unresolved or dynamic constructs. It never emits source text.
2. **Oracle** (`oracle.mjs`). Extracts the archive to a disposable directory and runs its main
   process in a child worker under a mocked Electron host. A case supplies fixtures under
   `userData`/`documents`/`logs`/`temp`, freezes the clock, and invokes channels. The reply records
   handler values, error names/codes, every read/write path, and the full file contents after each
   call. No target-specific fake exists in the host.
3. **Specification agent** (`agent-tools.mjs`). OpenCode runs with file tools limited to its
   workspace and the `oracle` MCP server: inventory, probe, fixture search, declare specification,
   public cases.   `oracle_declare_spec` validates the specification and reports coverage gaps: a
   channel needs a fixture that reaches it, at least one successful observation, and either three
   distinct outcomes or six observable cases (constant-result operations cannot produce three
   outcomes). A specification with gaps is not accepted.
4. **Case generation and partitioning** (`cases.mjs`). The specification expands into mutated
   fixtures, boundary arguments, repeated calls and declared sequences. The driver observes every
   case against the original, then partitions the usable observations into public (~55%), repair
   (~20%) and final held-out (~25%) sets. The partitioner rebalances per channel so the public and
   final partitions each contain a successful case and the final partition keeps at least three;
   a hash alone could otherwise leave a channel error-only in the partition it is graded on.
   `oracle_declare_spec` is the only way to save the specification: the stage has no write tools, and
   the driver ignores a `spec.json` that is not bound to a declaration record (`spec.declared.json`).
5. **Public handoff** (`spec.mjs`). The implementation workspace contains only `SPEC.md`,
   `spec.json`, `public-cases.json` and `README.md`. `SPEC.md` is a human-readable specification;
   `spec.json` is the same contract in machine-readable form; `public-cases.json` carries the
   original app's answers for the public partition.
6. **Implementation agent** (`implement-tools.mjs`). OpenCode runs with file tools and the
   `implement` MCP server: specification, public case summary, one public case, `check`, `run`.
   `check` assembles the workspace and compares the candidate with the public and repair
   partitions. The agent never receives the original app, its analysis or its paths.
7. **Assembly** (`project.mjs`). The driver generates the package metadata, main-process IPC
   wiring, sandboxed preload bridge, renderer and reconstruction manifest around the agent's
   feature modules. Original source files are not copied; the specification files are metadata and
   stay out of the runnable project.
8. **Differential verification** (`pipeline.mjs`). The assembled project runs under the same
   oracle. Public cases pass before repair cases are revealed; repair cases must pass before the
   run converges. The final held-out partition is evaluated once, after convergence, and its
   failures are never fed back.

Feedback is bounded and auditable:

- Public failures and the expected original outcomes go back to the implementer.
- Repair cases become visible (`repair-cases.json`) only after the first failed round, and are
  compared from then on.
- Final held-out counts and channel names never appear in agent feedback. After convergence the
  report records the final partition, the environment identity, the specification hash and every
  agent round.

## What the report promises

`reconstruction-report.json` (schema 2) carries:

- `spec`: specification SHA-256, channels, declared scope, exclusions, blockers, unresolved items.
- `partitions.public|repair|final`: cases, passed, coverage per channel and remaining gaps.
- `observations`: total generated cases, usable expectations and every observation that produced
  no usable expectation. Unusable original observations are readiness blockers, never silent.
- `readiness`: `{ ready, blockers }`. A run is ready only when all three partitions match with no
  coverage gaps, no observation failures and no declared blocker.

Channels the feature contract cannot express (a result that depends on the invoking window, menus,
 tray, dialogs, notifications, network) must be declared in `channel_exclusions` with a reason. The
driver rejects a channel that is neither implemented nor excluded, rejects a channel that is both,
and reports exclusions in the manifest and in `readiness`. A run with exclusions can be ready for
its declared scope (`readiness.ready`) but never whole-app ready (`readiness.whole_app_ready`).

## Environment knobs

| Variable | Effect |
|---|---|
| `ELECTRON_STATE_ROOT` | default parent for run state when `--state` is absent (use a large disk) |
| `ELECTRON_AGENT_CONTEXT` / `ELECTRON_AGENT_OUTPUT` | model context/output limits (defaults 196608 / 16384) |
| `ELECTRON_NO_SANDBOX=1` | adds `--no-sandbox` to `electron:smoke` for containers without a SUID sandbox |
| `OPENCODE_BIN` | OpenCode binary to run (default `opencode`) |

The readiness claim is still bounded: generated cases are samples, not equivalence proofs for
arbitrary input. The specification agent decides what to observe, so behavior it never reached is
absent from both the specification and the verdict. Only main-process IPC, persisted files and
error results are compared; renderer layout, menus, tray, updater and other platform effects are
outside the verified scope. The renderer and preload are generated from the specification.

## Commands

- `npm run electron:analyze -- <app.asar>` — static inventory only.
- `npm run electron:reconstruct -- <app.asar> <out>` — both stages, verification and assembly.
  Options: `--spec-rounds`, `--impl-rounds`, `--spec-timeout`, `--impl-timeout`, `--case-timeout`,
  `--spec-model`, `--impl-model`, `--spec <spec.json>` (reuse a reviewed specification and skip
  discovery), `--state <dir>`, `--keep-workspace`.
- `npm run electron:verify -- <app.asar> <project> <scenario.json>` — differential comparison for
  an explicit scenario you supply.
- `npm run electron:workbench -- <app.asar> <out>` — offline function workbench from a verified
  blueprint (not app reconstruction).
- `npm run test:electron-general` — oracle, case generation, partition coverage, specification
  validation, both agent tool servers, handoff isolation, assembly and differential verification.
  No credentials needed; CI runs it.

`npm run electron:smoke -- <out>` opens a generated project under Electron with `xvfb-run`, checks
the preload bridge and renderer, and invokes one channel. It needs a local `npm install` in the
generated project and a display (or xvfb).

## Evidence and limits

Bounded successful runs are recorded per application with the specification hash, partition counts,
coverage map and agent rounds in the generated report. Older single-agent results (Inkwell 27/27
public, Recall 22/22 public) used the previous pipeline where the implementer still had oracle
access; they are historical and are not evidence for handoff sufficiency. Re-run an application to
produce current evidence.
