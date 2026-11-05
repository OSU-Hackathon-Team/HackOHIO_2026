# Showcase mode (`?mode=demo`)

`ShowcaseWorkspace.tsx` is the active chat-and-preview demo. It uses a local Codex planner endpoint and real run-2 Obsidian/Calc engines. Recipes and direct controls work without a model. See [demo notes](../../../../docs/demo-notes.md) for startup and the presentation script.

- `showcaseModel.ts`: versioned project/action schemas, atomic executor, table export/import helpers.
- `showcaseStore.ts`: project persistence, per-project chat, undo/redo, cancellation, and planner client.
- `ShowcaseHistory.tsx`: clearly labeled recorded timeline and separate live engine checks.
- `engines/`: byte-identical run-2 package sources. Keep unchanged. `tests/demo.test.ts` pins their SHA-256 digests.
- `script.ts`, `fixtures.ts`, `chatScript.ts`, `NotesCalcApp.tsx`: earlier scripted demo retained for fixture tests and provenance. The new route does not present their scripted chat as live model output.

The planner is routed through `/api/showcase/edits` on the local backend. `models.json` selects its Codex model independently of Bedrock roles.
