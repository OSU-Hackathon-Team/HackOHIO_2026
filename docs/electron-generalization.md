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

Studio's **Recombine capabilities** view also exposes this pipeline. Upload an `.asar` archive,
select the IPC channels discovered by the static inventory and original-app startup probe,
then start a scoped reconstruction job. The backend API is `POST /api/electron/archives`
(`application/octet-stream`, 100 MB limit), `GET /api/electron/archives/:id/inventory`,
`POST /api/electron/runs` with `archive_id`, `channels` and `scope_label`, and
`GET /api/electron/runs/:id` plus `/log`, `/events` and `/report`. A running job can be
cancelled with `POST /api/electron/runs/:id/cancel`. Archives and run state live under
`SPLICE_STATE_DIR/electron-runs`; a backend restart marks an unfinished run interrupted.
The report's `readiness.scoped` and `readiness.whole_app_ready` remain distinct. This API
reconstructs main-process IPC behavior; editor and renderer behavior still needs a separate
observable pipeline.

Renderer discovery is now available through `POST /api/electron/archives/:id/renderer-discovery`
with `{task, confirm_cost:true}`. Studio exposes the task and streams its UI observations.
The specification model receives only UI, fixture and native picker tools. It can select windows,
edit fields, type keys, inspect rendered elements and create fixture notes under its workspace.
It saves a **draft** with observation citations and the uploaded archive hash. The host then starts
a fresh original workspace and replays the frozen fixture/UI/native-picker actions without model
calls. Workspace paths are normalized, while observable text, title, rendered HTML and inspected
elements are compared without rewriting expectations. Errors and uncovered requirements fail the
gate. A replay pass is still not implementation approval or held-out candidate verification.
Fetch a draft with `GET /api/electron/renderer-discoveries/:id` and its replay report with the
same path plus `/replay`. Disconnect or the twenty-minute deadline stops the child process group.
To retry a frozen trace without model calls, send `replay_discovery_id` in the same discovery POST;
Studio has a saved-discovery ID field for this action. The source must have archive identity and
complete observation metadata, and its archive must match the selected upload. Retries create a
new report and preserve the source and earlier failures. Snapshots wait for a consistent title,
visible text and rendered HTML rather than sampling a partially updated frame.
For a host observation fix, `recapture:true` with a saved replay ID records a new original
revision from the same frozen actions and then replays it. It preserves the source task,
requirements, parent ID and variance report, while leaving all earlier expectations/reports
unchanged. Action failures or missing source observations reject the revision. This is original
evidence recapture, not repair of candidate held-out failures or implementation approval.
Studio exposes this as a checkbox beside the saved-discovery field.

Model replies use compact snapshots and a chunked `observation` tool for earlier exact evidence.
Full observations remain in the audit files and are used for replay comparisons; compact replies
are never used as the replay oracle. This prevents repeated DOM snapshots from exhausting the
model context without erasing evidence.

Set `capture_cases:true` in the discovery request (or Studio's executable-case checkbox) to
require at least three distinct Markdown cases. The model's `render_case` tool fills a selected
original editor, verifies the exact text, clicks a selected view control, and records settled DOM
from a selected rendered-document element. It strips scripts, styles, SVG controls and event
attributes; it never invents expected HTML. Captures are frozen actions replayed against a fresh
original workspace. Three distinct cases with requirement citations are required in this mode.
Uncited exploration cases do not enter the implementation handoff. The public handoff adds
`cases:[{case_id,observation_id,input_markdown,expected_html}]` only for captures confirmed by replay,
and rejects case exports requiring local-path redaction. Case capture remains specification
evidence; implementation, independent held-out evaluation and approval are separate gates.
Editor and view controls can be selected with current snapshot refs; the host freezes them as
structural DOM paths before capture so replay does not depend on the model guessing selectors.
Compact snapshots retain a separate editable-control list without changing existing control-ref
ordering. Failed captures report mode/selector guidance and cannot satisfy the case-count gate.
When a selected container has one visible editable descendant, capture resolves that descendant.
Input must match on two consecutive reads after the fill; a mismatch returns its offset, lengths
and a bounded actual-text excerpt for model feedback instead of publishing a case.
The model can choose `input_method:"keyboard"` for custom editors: the host focuses, selects all,
deletes and inserts the complete text. The chosen method is frozen with the capture action and
must pass the same exact-input check during original replay.
For live preview editors whose visible DOM omits syntax markers, `document_path` can name the
original note relative to the fixture workspace. The host then verifies exact saved Markdown
bytes on two reads after editing. Only bounded Markdown files inside that workspace are readable;
absolute paths, source files and escaping symlinks are rejected. The public case records whether
input was checked using the editor DOM or the saved document, while omitting the fixture path.

This opt-in path currently requires Linux, Xvfb, xdotool, and Electron with a correctly configured
sandbox helper. `SPLICE_RENDERER_ORIGINAL_EXECUTABLE` selects an installed source-app executable;
its adjacent resources must contain the uploaded archive hash. It is observed through Chromium
CDP, so it does not depend on production Node inspector support. Otherwise the host uses the
installed Electron package (or `SPLICE_RENDERER_ELECTRON`) and a conventional main entry launcher.
For multi-archive packaging, optional `resource_archives:[{archive_id,name}]` and `entry_resource`
recreate the source resources layout from client uploads. This gives the app a separate workspace
and user configuration, but does not provide operating-system isolation from the host filesystem.
Original replay acceptance, requirement review, held-out renderer checks and downstream renderer
implementation are still required before claiming editor parity.

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
   unresolved or dynamic constructs. It never emits source text. Entry resolution is shared with the
   oracle (`entry.mjs`): the file `package.json` names is used when it exists, and when it does not
   (a launcher package that ships its payload as a second archive) a conventional entry name is used
   and reported as an `entry-fallback` diagnostic rather than failing the run.
2. **Oracle** (`oracle.mjs`). Extracts the archive to a disposable directory and runs its main
   process in a child worker under a mocked Electron host. The host answers the API surface real
   main processes use — `app.getPath` for the platform keys, `app.name`, desktop integration
   (`dock`, recent documents, default protocol client), `screen` displays, `Tray`, `nativeImage`,
   `Menu`, `protocol`, `systemPreferences`, `session` (including `webRequest`, `getUserAgent` and
   the spell-checker surface), `globalShortcut`, `remote`, windows and an invoking window for
   `event.sender` — because a missing method makes the app's own behavior look broken and pushes
   channels into exclusions it does not deserve. Electron-only modules are answered too: `original-fs`
   resolves to Node's `fs`, and `process._linkedBinding` returns a stub instead of throwing.
   A main module that registers nothing as it loads but exports an initializer (the launcher shape)
   is invoked the way a launcher invokes it, with the application directory and an event emitter.
   Both IPC forms are observed: `ipcMain.handle` returns a value to `invoke`, and an `ipcMain.on`
   channel answers `sendSync` through `event.returnValue`, so a main process built from synchronous
   channels is observable rather than invisible. A case supplies fixtures under
   `userData`/`documents`/`logs`/`temp`, freezes the clock, and invokes channels. The observation
   records handler values, error names/codes, every read/write path, and the full file contents
   after each call. No target-specific fake exists in the host.
3. **Specification agent** (`agent-tools.mjs`). OpenCode runs with file tools limited to its
   workspace and the `oracle` MCP server: inventory, probe, file, fixture search, declare
   specification, public cases. Probe replies have to fit an agent's context window on a real
   application, so each call reports its changed and removed files with content capped at 4000
   characters and an index of every file's size and digest; `oracle_file` re-runs the probe to
   return one file's exact bytes when a requirement has to state them. `oracle_declare_spec`
   merges into `spec.json` so a large application is declared in batches, and reports
   `remaining_channels` alongside problems and gaps; a coverage gap is a channel the driver cannot
   observe at all (no usable case, or no case the original answers), and a channel that answers one
   way over varying inputs is reported as narrow instead. Narrow is not a rejection: a version string
   has one answer however it is called, and the sentences that make a channel's result depend on its
   arguments still have to be reachable. A specification with reachability gaps is not accepted.
   Discovery declarations sample shape-diverse cases per channel (up to six per shape family, twelve
   per channel) and cache every observation, so re-declaring a large application only runs what
   changed; the driver observes the full suite once after the spec is accepted.
4. **Case generation and partitioning** (`cases.mjs`). The specification expands into mutated
   fixtures, boundary arguments, repeated calls and declared sequences. The driver observes every
   case against the original, then partitions the usable observations into public (~55%), repair
   (~20%) and final held-out (~25%) sets. The partitioner rebalances per channel so the public and
   final partitions each contain a successful case and the final partition keeps at least three;
   a hash alone could otherwise leave a channel error-only in the partition it is graded on.
   `oracle_declare_spec` is the only way to save the specification: the stage has no write tools, and
   the driver ignores a `spec.json` that is not bound to a declaration record (`spec.declared.json`).
5. **Public handoff** (`spec.mjs`). The implementation workspace contains only `SPEC.md`,
   `spec.json`, `public-cases.json`, `README.md` and, once a round has failed, the driver's own
   `failures.md` (the failing cases with their calls; it is derived from public and repair cases
   only). `SPEC.md` is a human-readable specification;
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

Every observed case is observed **twice**, the second time in a different run directory and under
a different host configuration (other window bounds and display size). An answer that changes
between the two observations is not the application's behavior but the run's own state — the mock's
window bounds, a path outside the storage roots, a random identifier the original minted, its own
clock — and no feature module could reproduce it from the contract:

- the case is dropped, never graded, and is listed with its shape in `spec.unstable_cases`;
- a channel that keeps no reproducible case at all is excluded, reported in
  `spec.unreproducible_channel_exclusions` and `readiness.excluded` with `source: "host-variation"`,
  and removed from the contract so the assembled project does not expect a module for it;
- either way the run cannot claim whole-app readiness without saying so.

Without this check a mock's own window bounds, or the original's random identifier, would be
verified as if they were the application's behavior. The check costs one extra observation per
generated case and covers every case, not a sample of them; two draws can still agree on a value
that is unstable only more rarely than that.

## Reconstructing a subsystem

A real application can be larger than one specification round can carry. `--only` limits a run to a
named subset of the discovered channels (a channel name, a comma-separated list or a `*`
wildcard), which the specification agent is told about and which the driver enforces:

- the specification stage declares and the driver verifies only the channels in scope; the
  inventory reports the others as `out_of_scope_channels`, and a declaration about one is ignored
  rather than failed;
- out-of-scope channels are written into the contract as exclusions with `source: "run-scope"` and a
  reason naming the scope, so the assembled project registers exactly what was verified and
  `validateWorkspace` still sees a complete contract;
- the report carries a top-level `scope` block (`label`, `patterns`, `channels`, `out_of_scope`) and
  `readiness.scoped`; `readiness.ready` means this subsystem reached parity, while
  `readiness.whole_app_ready` stays false because the other channels were neither specified nor
  verified.

Scope is a different claim from an exclusion: an exclusion says the channel's behavior cannot be
expressed by the feature contract, a scope says this run did not attempt it. Subsystems are how the
same pipeline works incrementally on a large app, and the report never lets the result be mistaken
for the application.

Feedback is bounded and auditable:

- Public failures and the expected original outcomes go back to the implementer.
- Repair cases become visible (`repair-cases.json`) only after the first failed round, and are
  compared from then on.
- Final held-out counts and channel names never appear in agent feedback. After convergence the
  report records the final partition, the environment identity, the specification hash and every
  agent round.

## What the report promises

`reconstruction-report.json` (schema 2) carries:

- `scope`: the subsystem this run covered, when `--only` was used (`label`, `patterns`, `channels`,
  `out_of_scope`), and `null` for a whole-application run.
- `spec`: specification SHA-256, channels, declared scope, exclusions (with their `source`:
  `specification`, `host-variation` or `run-scope`), the cases dropped as unstable or as calling a
  channel the run does not reconstruct, blockers and unresolved items.
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
| `ELECTRON_CASES_PER_CHANNEL` | cap on generated argument/fixture cases per channel (default 16) |

| `ELECTRON_NO_SANDBOX=1` | adds `--no-sandbox` to `electron:smoke` for containers without a SUID sandbox |
| `OPENCODE_BIN` | OpenCode binary to run (default `opencode`) |

The readiness claim is still bounded: generated cases are samples, not equivalence proofs for
arbitrary input, and reproducibility is decided by two observations — an answer that is unstable
only more rarely than that is compared against the original's own run state. The specification agent decides what to observe, so behavior it never reached is
absent from both the specification and the verdict. Only main-process IPC, persisted files and
error results are compared; renderer layout, menus, tray, updater and other platform effects are
outside the verified scope. The renderer and preload are generated from the specification.

## Commands

- `npm run electron:analyze -- <app.asar>` — static inventory only.
- `npm run electron:reconstruct -- <app.asar> <out>` — both stages, verification and assembly.
  Options: `--spec-rounds`, `--impl-rounds`, `--spec-timeout`, `--impl-timeout`, `--case-timeout`,
  `--spec-model`, `--impl-model`, `--spec <spec.json>` (reuse a reviewed specification and skip
  discovery), `--only <channel[,channel|*]>` (reconstruct a subsystem; repeatable),
  `--scope-label <text>` (how the report names that subsystem), `--state <dir>`, `--keep-workspace`.
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
