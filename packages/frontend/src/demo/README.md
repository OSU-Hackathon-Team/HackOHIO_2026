# Showcase mode (`?mode=demo`)

`ShowcaseWorkspace.tsx` is the protected chat host. It uses a local Codex planner for data edits and a separate Terra code writer for React/TypeScript/CSS preview revisions. Recipes and direct controls work without a model. See [demo notes](../../../../docs/demo-notes.md) for startup and the presentation script.

- `showcaseModel.ts`: versioned project/action schemas, atomic executor, table export/import helpers.
- `showcaseStore.ts`: project persistence, per-project chat, undo/redo, cancellation, and planner client.
- `ShowcasePreviewPanels.tsx`: the real note, table, task, metric, and chart panels, shared by the host and the editable preview. It exports `ShowcasePreviewPanels`, `NotesPanel`, `TablePanel`, `TasksPanel`, `MetricPanel`, and `ChartPanel` so generated app code can compose the existing controls. The full preview takes `{ p, apply, selectedSectionId, selectSection }`; the individual panels take the same project/action callbacks plus their section or table ID and display classes.
- `CodeCanvas.tsx`: same-origin iframe bridge and code comparison/revert controls. A generated `App.tsx` receives `{ project, runtime }`. The bridge's `getProject()` and `subscribe()` keep the project prop current. `runtime.tableValues(id)` and `runtime.total(id?)` return evaluated Calc values, `runtime.apply(actions)` uses the validated action executor, and `runtime.select(id)` sets chat context. The host handles `reportReady`/`reportError` from the fixed bootstrap. Generated source can import `ShowcasePreviewPanels` from `@splice/showcase-preview`; the backend resolves that alias to this module and supplies its compiled CSS locally.
- `ShowcaseHistory.tsx`: clearly labeled recorded timeline and separate live engine checks.
- `engines/`: byte-identical run-2 package sources. Keep unchanged. `tests/demo.test.ts` pins their SHA-256 digests.
- `script.ts`, `fixtures.ts`, `chatScript.ts`, `NotesCalcApp.tsx`: earlier scripted demo retained for fixture tests and provenance. The new route does not present their scripted chat as live model output.

The planner is routed through `/api/showcase/edits` on the local backend. Code jobs use `/api/showcase/code/jobs` and immutable revision URLs. `packages/backend/src/showcase/codeJobs.ts` owns the fixed bootstrap, baseline source, candidate checks, and prepared fallback. `models.json` selects both Codex roles independently of Bedrock roles.
