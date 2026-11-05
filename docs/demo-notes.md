# Chat-driven showcase (`?mode=demo`)

The showcase assembles a usable app from capabilities reconstructed before the event. It does not run a new decompilation. Notes render through the byte-pinned run-2 Obsidian engine; tables and formulas run through the byte-pinned run-2 Calc engine. Tasks, charts, themes, search, and chat controls are Splice components. The History view replays recorded run-2 stages and offers separate checks that execute the bundled engines now. The run-2 evidence is documented in [the gap log](obsidian-calc-demo-run2-gap-log.md).

## Start on the presentation laptop

Use Node 22.19+ and install dependencies once with `npm ci`. Sign in to the local Codex CLI with ChatGPT before the event (`codex login`); a small structured request has been verified on this machine with `gpt-6-luna`. From the repo root:

```bash
npm run build:contracts
PORT=3001 REA_MODE=mock LLM_MODE=mock npm run dev:backend
npm run dev:frontend
```

Open `http://localhost:5173/?mode=demo`. The backend and frontend commands run in separate terminals. The frontend proxies `/api` to port 3001. No AWS credentials or Bedrock calls are needed for this showcase. `models.json` sets `showcase_planner` to `gpt-6-luna`; `MODEL_SHOWCASE_PLANNER` can override it with another model available in the presenter's Codex account. The planner endpoint accepts requests from the local computer only.

The UI remains useful when Codex or the network is unavailable: choose a recipe, use the Library, edit cells and notes, add tasks, change the theme, undo, and export. A few exact chat commands (create a note, add a task/table, set a theme) also apply locally after a planner failure. Other unsupported requests show a clear error.

## Presentation flow (90–120 seconds)

1. Open a blank project and ask: “Make a trip planner with notes, a budget, and packing tasks.” The local Codex planner returns validated actions; Splice applies them to the app. The assistant reply appears only after the transaction succeeds.
2. Ask: “Add a taxi ride costing $40 to the Trip budget table.” The row appears above the total and the sum updates. Or use the Trip planner recipe to start from a known state and edit the Hotel nights quantity from 3 to 4; the total changes from $760 to $880.
3. Change layout or color in chat: “Move the total above the table and make the accent green.” The accent and section order are directly editable too.
4. Create a note, follow an internal link, search notes, check a task, or view the bound chart. Undo a chat turn or direct edit and refresh to show persistence.
5. Open History, explain that the extraction stages were recorded earlier, and click Run engine checks. This runs current local Markdown rendering, formula evaluation, and sorting checks.
6. Export the project JSON or a table CSV. Importing JSON creates a new project, so the current app stays available.

Use the Recipes menu for Trip planner, Event budget, or Study notebook. Choosing a recipe creates another project and leaves the current one intact. The project selector switches among them. Projects and conversation history are stored in the browser's local storage; use Export before clearing browser storage.

## Supported scope

Chat can create or edit notes, tables, tasks, sections, and theme settings. It can add existing capabilities and answer simple questions about the current project, including totals and overdue tasks. The model only proposes structured actions; the app validates and applies them as one undoable transaction. Direct UI controls cover notes, cell edits, table rows, ordinary table sorting and columns, table filtering, task titles/due dates/priorities/completion, themes, and imports/exports. Note search shows matching snippets; tags filter notes. Summary cards support sum, row count, average, task count, and task completion percentage. Bar charts can bind to a chosen table and category/value columns. All derived values update from current table or task data.

Formulas support arithmetic, comparisons, and A1 references through the existing Calc engine. A wrapper evaluates dependencies in order and reports cycles and missing references. A row can be added above a final Total row when its total is a simple sum of same-column cell references. Sorting formula tables and changing their columns remain disabled until reference adjustment is implemented. Functions such as `SUM(...)` are unsupported.

The previous frontend-only scripted chat and app remain in source for historical tests, but `?mode=demo` now opens this chat-driven showcase. The engine files in `packages/frontend/src/demo/engines/` must remain unchanged; `packages/frontend/tests/demo.test.ts` pins their hashes.

## Checks

```bash
npm run build:contracts
npm run typecheck
npm run test:unit -w @splice/frontend
node --import tsx --test packages/backend/src/routes/showcase.test.ts
CI=true npx playwright test tests/studio/showcase.spec.ts
npm run build
```

The browser tests use a mocked planner response for stable UI checks. A live Codex chat request should also be rehearsed with the actual local login. Test the app again with AWS credentials absent, and verify that a backend outage leaves direct editing and recipes usable.
