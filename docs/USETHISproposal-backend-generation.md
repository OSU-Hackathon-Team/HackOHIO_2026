# Proposal: generate a backend, not just a frontend

Status: brainstorm, nothing built yet. Written for Engineer 2, who owns spec extraction and the hand-authored specs.

## The gap today

Step 3 produces a frontend-only app:

- `/api/implement` turns each `FeatureSpec` into a pure TypeScript engine and checks it against `acceptance_tests`.
- `/api/synthesize` wraps the engines in a React app that runs in Sandpack. Everything runs in the browser, and state lives in React state or `localStorage`.

Our specs already record the backend we throw away. It's in `stripped_glue`:

| Spec | `stripped_glue` | What it really is |
|---|---|---|
| `recall.sm2_scheduler` | `ipcMain.handle('card:answer')`, `fs deck storage` | an API endpoint, and persistence |
| `inkwell.wikilink_graph` | `ipcMain.handle('vault:graph')`, `electron webview force-graph` | an API endpoint, plus UI |
| `mockpriority.priority_score` | ELF calling conventions, memory layout | nothing server-side |

So the source apps had a client/server split: Electron main vs renderer. We extract the logic correctly, then drop the half that held data.

## Proposal, in three layers

### 1. Spec: say where code runs (Engineer 2's part)

Add optional fields to `FeatureSpec` in `packages/contracts/src/spec.ts`. They're optional so existing specs and replay fixtures keep parsing.

```ts
placement: z.enum(["client", "server", "either"]).default("either"),
effects: z.array(z.enum(["persistence", "network", "filesystem", "shared_state", "secrets"])).default([]),
entities: z.array(z.object({               // only when effects includes "persistence"
  name: z.string(),                        // "Card"
  key: z.string(),                         // "id"
  fields: z.array(IoField),                // reuse the existing IoField
})).default([]),
```

How to fill them:

- **Hand-authored or Electron specs:** each `ipcMain.handle(...)` in `stripped_glue` becomes a candidate server operation. `fs` or `localStorage` writes become `effects: ["persistence"]` plus an entity.
- **Native (decomp) specs:** use observed side effects from the dossier (file I/O, sockets) as evidence. A name alone isn't evidence, and `placement` stays `either` when there's no evidence.
- The engines themselves stay pure. `placement` and `effects` describe the glue around them, not the engine code.

Ask for Engineer 2: does the extractor already see the IPC handlers and storage calls it strips? If so, it could emit structured records instead of strings, e.g. `{ kind: "ipc", channel: "card:answer", maps_to: "answer_card" }`, and these fields become nearly free.

### 2. Generated API layer: deterministic, no model

The engines already export a typed interface (`interface.types_code`). For every export with `placement` `server` or `either`:

- Route: `POST /api/<module>/<export>`, with zod request/response schemas derived from the interface types.
- Typed client: `client.<module>.<export>(args)`, so the frontend calls the server where it used to import the engine directly.
- Check: one HTTP round-trip test per export, confirming the wrapper passes values through unchanged. The engine logic is still covered by the existing acceptance tests.

No model calls means no extra spend and no hallucination risk. It's the same pattern our own repo uses: a shared `contracts` package between `backend` and `frontend`.

### 3. Backend synthesis: model step, for persistence and shared state

This is only needed when a spec declares `persistence` or `shared_state`.

1. Synthesis first writes an **app contract**: entities plus endpoints, as zod.
2. The backend writer generates routes and storage behind a repository interface (SQLite, or in-memory for tests).
3. The frontend writer builds against the contract's client.
4. Verify with generated contract tests against the real backend, using the same repair loop `/api/implement` uses.

The bundle would gain `backend_paths` and a `contract_path` beside today's `engine_paths` and `generated_paths`.

### Preview

The options for running a backend:

- **Sandpack Nodebox:** runs Node/Express in the browser. Keeps today's flow, so it's the first choice.
- **Our backend:** runs the generated server in a sandboxed child process.
- **Export only:** the user downloads the repo and runs it themselves.

## Suggested order

1. Add the spec fields (optional), and backfill the 3 existing specs by hand. *(Engineer 2)*
2. Generate the API layer and client, previewed in Nodebox.
3. Backend synthesis for `persistence`, only if the demo needs data to survive a reload.

## Open questions

- Is the demo goal "data survives a reload" (layer 2 plus a tiny store is enough) or "multiple users" (needs layer 3 plus auth)?
- Should `entities` come from extraction, or should synthesis infer them from the requirements?
- Nodebox: we need to confirm the Sandpack version we pin supports it.
