# Bounded Electron app reconstruction: Recall

`scripts/electron/recreate-recall.mjs` takes the committed packaged Recall `app.asar`, inspects its JavaScript modules and Electron calls, and writes a separate runnable Electron source project. It refuses archives whose SHA-256, package name, main entry, IPC channels, or local module links differ from the reviewed target. The inspection report in `evidence.json` records the archive hash, per-module hashes, main entry, discovered IPC handlers, local imports, bridge exports, and window loads. The output does not include original source files.

The reconstructed app implements the observed `card:answer` and `stats:streak` IPC channels, JSON deck persistence under Electron `userData/decks`, the scheduler from the checked Recall blueprint, and an independent streak implementation. It has a local desktop UI with a demo card, exposed through a narrow preload bridge. The demo setup/state channels and UI are new conveniences; the two original IPC channels remain separately checked. This is a bounded reconstruction of the small packaged fixture, not a general Electron decompiler.

```bash
npm ci
npm run test:electron-recreation
npm run test:electron-runtime          # Linux with xvfb-run; downloads Electron 45
node scripts/electron/recreate-recall.mjs targets/build/recall/app.asar /tmp/recall-recreated
cd /tmp/recall-recreated
npm install
npm start
```

`test:electron-recreation` first checks that the inspector finds Inkwell's separate preload bridge and IPC channels, and that the Recall reconstruction refuses that different archive. It then extracts the original Recall `app.asar` into an isolated temporary directory, runs its main process and the reconstructed main process with the same mock Electron IPC host and fixed clock, and compares handler results and persisted JSON after each operation. It also compares scheduler and streak results directly. The current suite passes 41 original-versus-reconstruction checks, including success, failure, invalid grade, missing deck, scheduling progression, and streak cases. The test prints the temporary project path for inspection.

`test:electron-runtime` installs the generated project's pinned Electron 45 dependency, launches it under Xvfb, checks its local window through the Chromium debugging protocol, clicks grade 5, and checks both the updated UI and `userData/decks/demo.json`. The behavioral checks cover the named channels and cases; they are not proof of equivalence for every possible input or for the source app's unimplemented platform behavior.
