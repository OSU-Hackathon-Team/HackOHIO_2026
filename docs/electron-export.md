# Electron project export

Splice can analyze a packaged Electron target through the existing Step 1 → Step 2 → Step 3 feature pipeline, then download the synthesized app as a runnable Electron source project. After a bundle is ready, use **Electron project** in the Studio, pipeline test bench, or IDE toolbar. The ZIP contains the exact checked engine files from the bundle, the generated React renderer, local Tailwind build configuration, and an Electron main process. Unzip it, run `npm install`, then `npm start` with Node 22 or newer. `npm start` type-checks, builds the renderer, and opens a desktop window.

The project opens only its local built renderer. The window has Node integration disabled, context isolation and sandboxing enabled, blocked new windows and navigation, and denied permission requests. No source-app main process or preload code is copied into the export. Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security) informed these defaults.

## Verification boundary

This output reimplements the **selected, verified feature engines and generated UI** inside Electron. Existing feature specifications may explicitly exclude source-app IPC, persistence, menus, dialogs, networking, or window lifecycle behavior as `stripped_glue`. The exporter cannot infer or verify those behaviors from a pure engine bundle, so the generated project does not claim full source-app equivalence. A bundle in replay mode retains that mode in its README; replay is not live original-code verification.

For a reconstruction that covers the archive's Electron IPC and storage behavior, see [the behavioral Electron reconstruction pipeline](electron-generalization.md).

The export test compares every `src/engines/*` byte for byte with the input bundle and checks the desktop main-process settings. A generated study-room project was installed, type-checked, built, and launched under Electron 45. Its window loaded the local `dist/index.html`, and the renderer displayed the study-room UI. This checks that the source ZIP runs, while source-app platform parity remains outside the current feature contract.
