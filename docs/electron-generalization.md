# Electron archive reconstruction workflow

The archive workflow has three target-independent commands. Given an Electron `app.asar`, the one-command exporter selects the highest-coverage reviewed reconstruction available. Recall uses its reviewed IPC/storage adapter and automatically runs the original-versus-candidate scenario. Inkwell falls back to a runnable workbench for its verified portable graph feature.

```bash
npm ci
npm run electron:analyze -- targets/build/inkwell/app.asar
npm run electron:recreate -- targets/build/inkwell/app.asar /tmp/inkwell-workbench
cd /tmp/inkwell-workbench
npm install
npm start
```

`electron:analyze` reports the main entry, preload and renderer references, local module graph, IPC registrations and calls, bridge exports, assets, and unresolved or dynamic references. `electron:recreate` checks reviewed adapters first, then discovers blueprints by recorded archive SHA-256 and checks their oracle/implementation status, referenced modules, and exported functions. It compiles portable implementations into a fresh Electron project. The project does not include source-app JavaScript files. `analysis.json` records the archive inventory, and `reconstruction.json` names covered and uncovered behavior.

For a behavior comparison, provide an IPC scenario with data fixtures and ordered calls:

```bash
npm run electron:verify -- targets/build/recall/app.asar /path/to/recreated-project scripts/electron/scenarios/recall.json
```

The verifier runs the original archive and candidate main process in isolated Node workers with the same mocked Electron host, fixed clock when specified, and separate fixture directories. It compares each call's result and selected persisted files. The one-command Recall path runs its supplied scenario automatically. The Inkwell scenario verifies the checker against a reference fixture and catches changed search results or missing channels; this does not establish an Inkwell reconstruction.

## Coverage and remaining automation

The generated workbench is a **partial reconstruction**. It provides a desktop UI for calling verified portable feature functions, but does not recreate the original IPC, storage, window lifecycle, menus, or renderer. The default Inkwell export reports zero original IPC channels matched. The default Recall export reports both observed original channels matched by its six-case automatic scenario, plus bounded storage behavior; its UI is independently rebuilt. Use `--require-original-ipc` to reject workbench fallback, or `--require-full-parity` to reject every current adapter before writing output.

The current path needs no target-specific command arguments beyond the archive and output directory **when a matching verified blueprint already exists**. A new archive still needs feature discovery, an original-code oracle, a checked blueprint, and representative IPC scenarios before behavior can be claimed. The repo's Step 2 sandbox and live Step 1→2→3 handoff are not yet complete, so automatic full app reimplementation from an arbitrary archive is not available. The workflow fails explicitly instead of treating a runnable shell as equivalence evidence.

The [Recall reconstruction](electron-recreation.md) implements its two observed original IPC channels and persistence. Its 41-case extended differential suite and Electron runtime smoke establish the stated bounded behavior, not arbitrary input equivalence.
