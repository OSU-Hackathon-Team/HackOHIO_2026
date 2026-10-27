# Electron reconstruction from observed behavior

The reconstruction pipeline takes a packaged Electron `app.asar` and writes a new, runnable
Electron project that implements the archive's IPC behavior. Nothing in the pipeline knows an
application's name, channels, storage layout or features in advance.

```bash
npm ci
npm run electron:reconstruct -- targets/build/recall/app.asar /tmp/recall-reconstructed
cd /tmp/recall-reconstructed
npm install
npm start
```

The run needs AWS credentials with Bedrock access. The agent's model comes from the
`electron_reconstructor` role in `models.json` (Qwen3 Coder 480B by default; override with
`MODEL_ELECTRON_RECONSTRUCTOR`). The child process receives the `AWS_*` values from the repo
`.env`; refresh those with the AWS CLI before a run if the session expired.

## Stages

1. **Static inventory** (`analyze-archive.mjs`). Reports the main entry, preloads, renderer loads,
   local module graph, IPC channels with handler arity, bridge globals and methods, assets, and
   unresolved or dynamic constructs. It never emits source text.
2. **Oracle** (`oracle.mjs`). Extracts the archive to a disposable directory and runs its main
   process in a child worker under a mocked Electron host. A case supplies fixtures under
   `userData`/`documents`/`logs`/`temp`, freezes the clock, and invokes channels. The reply records
   handler values, error names/codes, every read/write path, and the full file contents after each
   call. No target-specific fake exists in the host.
3. **Orchestration agent** (`agent.mjs`, `agent-tools.mjs`). OpenCode runs with file tools limited
   to a fresh workspace and an `oracle` MCP server. The agent probes channels, discovers argument
   shapes and storage layout, writes one CommonJS feature module per channel, and declares
   `contract.json` with the fixtures, sample arguments and UI parameters it inferred. The original
   archive's source is never in the workspace and is not available through any tool.
4. **Mechanical case generation** (`cases.mjs`). The contract is expanded into mutated fixtures,
   boundary arguments and failure paths, and the clock is frozen. A deterministic hash split makes
   ~55% public (the agent may see them with expected original outcomes), ~20% repair (revealed with
   expectations only after a failed round) and ~25% final held-out (never revealed). Expectations
   always come from the original archive.
5. **Assembly** (`project.mjs`). The driver generates the package metadata, main-process IPC wiring,
   sandboxed preload bridge, renderer, and reconstruction manifest around the agent's feature
   modules. Original source files are not copied; the output contains only `analysis.json`,
   `reconstruction.json`, the generated shell and the new feature modules.
6. **Differential verification** (`pipeline.mjs`). The assembled project runs under the same
   oracle. Public, repair and final held-out cases must match the original's values, error
   names/codes and persisted file bytes. Contract coverage gates require every original channel to
   have at least one successful case and three distinct outcomes, so an implementation that only
   reproduces errors is rejected.

Repair rounds feed back public and repair failures (with expected outcomes) while the final
held-out partition stays hidden. That is what forces exactness on key insertion order, `NaN`/null
serialization and original error quirks instead of approximately correct behavior.

## No hand-holding

`scripts/electron/` contains no per-application adapters, templates, blueprints or scenarios for
reconstruction. The previous reviewed Recall adapter and hand-written template were removed with
the pipeline that replaced them. Two commands remain target-neutral:

- `npm run electron:analyze -- <app.asar>` — static inventory only.
- `npm run electron:verify -- <app.asar> <project> <scenario.json>` — verify an existing project
  against an explicit scenario you supply.

`npm run electron:workbench -- <app.asar> <out>` is a separate offline fallback. It requires a
verified `FeatureBlueprint` whose provenance matches the archive SHA-256 and produces a function
workbench, not an app reconstruction. It is not a substitute for the behavior pipeline.

## Evidence and limits

- Inkwell (`inkwell-notes`, sha256 `37979c1c…`): 27/27 public, 17/17 held-out, 0/0 final, with the
  agent reproducing wiki-link parsing, graph de-duplication, unresolved links, fuzzy scoring
  quirks (including whitespace-only queries) and backlink ordering.
- Recall (`recall-flashcards`, sha256 `76af753a…`): the first run exposed a fixture that only
  reached error paths; the coverage gate rejected it. After the fixture repair: 22/22 public,
  23/23 held-out and 20/20 final cases, including deck persistence bytes, SM-2 progression, grade
  validation and streak boundaries.

The claim stays bounded. Generated cases are samples, not equivalence proofs for arbitrary input.
The renderer and preload are generated from the declared contract; main-process IPC, errors and
file effects are what the differential suite verifies. Platform behavior outside IPC (menus, tray,
updater, multiple windows) is not reconstructed or claimed. Runtime window smoke tests still
require a machine with Electron and a display, and are not part of the automated gate.
