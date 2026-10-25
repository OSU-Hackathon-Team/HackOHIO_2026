# Electron archive reconstruction workflow

The archive workflow has three target-independent commands. It takes a packaged Electron `app.asar` and, when a matching verified feature blueprint exists, writes a runnable Electron project with a generated function workbench.

```bash
npm ci
npm run electron:analyze -- targets/build/inkwell/app.asar
npm run electron:recreate -- targets/build/inkwell/app.asar /tmp/inkwell-workbench
cd /tmp/inkwell-workbench
npm install
npm start
```

`electron:analyze` reports the main entry, preload and renderer references, local module graph, IPC registrations and calls, bridge exports, assets, and unresolved or dynamic references. `electron:recreate` discovers blueprints by recorded archive SHA-256 and checks their oracle/implementation status, referenced modules, and exported functions. It compiles the portable implementations into a fresh Electron project. The project does not include source-app JavaScript files. `reconstruction.json` names the included features and all original IPC channels that remain uncovered.

For a behavior comparison, provide an IPC scenario with data fixtures and ordered calls:

```bash
npm run electron:verify -- targets/build/recall/app.asar /path/to/recreated-project scripts/electron/scenarios/recall.json
```

The verifier runs the original archive and candidate main process in isolated Node workers with the same mocked Electron host, fixed clock when specified, and separate fixture directories. It compares each call's result and selected persisted files. The supplied Recall scenario passes against the existing bounded Recall reconstruction. The Inkwell scenario verifies the checker against a reference fixture and catches changed search results or missing channels; this does not establish an Inkwell reconstruction.

## Coverage and remaining automation

The generated workbench is a **partial reconstruction**. It provides a desktop UI for calling verified portable feature functions, but does not recreate the original IPC, storage, window lifecycle, menus, or renderer. Both demo archives produce runnable workbenches. Their `reconstruction.json` files report zero original IPC channels matched. Use `--require-full-parity` to reject partial output before any project is written.

The current path needs no target-specific command arguments beyond the archive and output directory **when a matching verified blueprint already exists**. A new archive still needs feature discovery, an original-code oracle, a checked blueprint, and representative IPC scenarios before behavior can be claimed. The repo's Step 2 sandbox and live Step 1→2→3 handoff are not yet complete, so automatic full app reimplementation from an arbitrary archive is not available. The workflow fails explicitly instead of treating a runnable shell as equivalence evidence.

The earlier [Recall reconstruction](electron-recreation.md) is a separate reviewed adapter that implements its two observed original IPC channels and persistence. Its 41 differential checks and Electron runtime smoke establish the stated bounded behavior, not arbitrary input equivalence.
