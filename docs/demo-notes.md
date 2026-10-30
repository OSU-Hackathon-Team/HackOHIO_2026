# Demo notes: Obsidian + LibreOffice Calc (`?mode=demo`)

How to run and present the event demo, what is real in it, and what to avoid on stage.

## Why the demo is mocked

A live end-to-end run takes hours of agent time and a large Bedrock token bill:
- Obsidian UI discovery
- Ghidra analysis of Calc
- clean-room implementation
- recombination

The AWS credits are also used up. So the demo **replays recorded run 2**
([run-2 gap log](obsidian-calc-demo-run2-gap-log.md)) in the frontend and runs the
**real engines that run produced**. It needs no backend, no AWS and no model calls, and makes zero
`/api` requests.

## What is real and what is scripted

| Part | Real or scripted |
|---|---|
| Markdown rendering in My app | **Real.** The run-2 Obsidian renderer engine, byte-identical |
| Table formulas, sort, insert/delete rows and columns | **Real.** The run-2 Calc engine, byte-identical |
| Pipeline progress in App library | **Scripted.** About 18 s timeline using run 2's real figures: 47 IPC channels, 15 replayed observations, 20 decompiled functions, 46 claims, 6 original LibreOffice outputs. It ends at 8/8 (Obsidian) and 10/10 (Calc) checks |
| Hashes, function addresses, original LibreOffice outputs, test-suite names | **Real**, from run 2 and `docs/handoffs/` |
| Requirement wording in the library | **Curated** for presentation, grounded in the recorded original outputs |
| Chat assistant | **Scripted.** Keyword intents that edit notes through the real engines |

The engines live in `packages/frontend/src/demo/engines/`. `tests/demo.test.ts` pins their SHA-256
to the run-2 export's `splice.lock.json` (`2b96666b…` renderer, `d7f40aa5…` Calc). **Do not edit
those two files.**

If someone asks "is this running live?":
> "The analysis pipeline is a replay of a real run we recorded; it took hours and lots of model calls.
> The app you're clicking in is real: those are the exact engines that run produced."

## Setup (presenting laptop)

The demo is on branch `feat/obsidian-calc-mock-demo`. From the **repo root**:

```powershell
git checkout feat/obsidian-calc-mock-demo
npm ci
npm run build:contracts
npm run dev:frontend
```

Open **http://localhost:5173/?mode=demo**.

**Offline option (no dev server at the event).** Build once, then serve the static files:

```powershell
npm run build -w @splice/frontend
cd packages/frontend; npx vite preview
```

Then open http://localhost:4173/?mode=demo.

**Settings and tips**
- **Speed:** `&speed=2` (~9 s per app) or `&speed=4` (~5 s). The default is ~18 s, for narrated runs.
- **Reset between visitors:** refresh the page. All state is in memory.
- **Screen size:** keep the browser at least 960 px wide. Use Ctrl +/− to zoom on a projector.
- **Windows: stop any running dev server (Ctrl+C) before `npm ci` / `npm install`.** A running Vite
  holds a native file open, and the install fails halfway. That leaves `node_modules` broken, and
  `tsc`/`vite` become "not recognized". The fix is to stop the server and run `npm ci` again.

## Demo script (about 3–4 minutes)

1. **Chat (empty start).** "Splice takes features out of apps you already use and rebuilds them as
   clean code you own. This workspace starts empty."
2. **App library → Obsidian → Markdown notes editor → Reconstruct Engine.** Read the stage lines as
   they appear:
   - it inspects the archive;
   - Markdown isn't rendered in the main process, so it drives the real UI;
   - it replays every observation;
   - a *separate* agent implements from the spec only;
   - held-out cases check the result.

   It ends at **Checks: 8 / 8**.
3. **Open my app.**
   - Project Plan renders: headings, callout, nested lists, strikethrough.
   - Click the purple **Budget** link.
   - The table is still plain text: "Obsidian can't do math."
4. **App library → LibreOffice Calc → Spreadsheet tables and formulas → Reconstruct Engine.**
   - "This one is a compiled native binary, decompiled with Ghidra."
   - Optionally, show the Requirements tab and its real function addresses (for example `0x005ea350`,
     InsertRow).

   It ends at **Checks: 10 / 10**.
5. **My app → Budget.** This is the main moment.
   - The table is live: 100 / 100 / 90, total **290**.
   - Select a cell → **Insert row** / **Delete row**.
   - **Inventory** → **↓ next to Units** re-sorts the rows.
6. **Chat.**
   - Click the **Summarize the budget** chip, then the **send arrow** (Enter does not send).
   - Then **Open my app**: a callout now says the total is 290.
   - Other chips: *Sort the inventory by units*, *Add an equipment table*, *Create a note called Travel*.

## Avoid on stage

These are limits of the run-2 engines, which we keep unmodified on purpose:

- **Functions** such as `=SUM(...)` return wrong values. Use `+ − × ÷`, comparisons and cell references.
- **`*` inside a code block** in a note turns into italics (a renderer quirk).
- **Sorting a table with formulas** isn't supported, because references are not adjusted. Those sort
  buttons are disabled; sort Inventory instead.
- Typing raw HTML into a note is escaped before rendering. It is not a full sanitizer, so don't paste
  untrusted content.

## Where it lives

| Path | Purpose |
|---|---|
| `packages/frontend/src/demo/mode.ts` | `?mode=demo` / `VITE_API_MODE=demo` and `?speed=` |
| `src/demo/fixtures.ts` | Obsidian and Calc library entries, specs and blueprints from run 2 |
| `src/demo/script.ts` | Scripted reconstruction timeline (played through `api/mock.ts`) |
| `src/demo/notesDocument.ts` | Notes with ```` ```calc ```` tables: parse, evaluate, table operations |
| `src/demo/NotesCalcApp.tsx` | The My app notes and tables view |
| `src/demo/notes.ts`, `src/demo/chatScript.ts` | Seeded budget-plan notes and the scripted assistant |
| `src/demo/engines/` | The pinned run-2 engines (do not edit) |

In demo mode, the workbench shows only Chat, App library and My app. Pipeline test and Recombine
need a backend and are not mounted. Normal mode and `?mode=development` are unchanged.

**Checks:**
- `npm run test:unit -w @splice/frontend` covers engine hashes, tables, the script and chat.
- `npm run test:studio -- --grep-invert "Sandpack boots"` checks that normal mode still works.
