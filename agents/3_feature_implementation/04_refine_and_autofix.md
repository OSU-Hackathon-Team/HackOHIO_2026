# 04 — Refine & Auto-Fix (`POST /api/refine`)

Two kinds, one endpoint:

| `kind` | Trigger | Model receives |
|---|---|---|
| `edit` | User types in the refine chat ("add a dark-mode toggle") | current generated files + engine interfaces + instruction |
| `fix` | Sandpack reports a runtime error after a bundle loads | current generated files + engine interfaces + the error text |

The model returns **only changed or new files** plus paths to delete. The server merges them,
re-validates (fix loop ≤ 2 as in synthesis), bumps `revision`, and streams the new bundle.
**Engines and entry files can't change.** Any returned path outside `GENERATED_PATH` is dropped
with a warning.

## 1. Schema & prompt — `src/synthesis/refine.ts`

```ts
import { z } from "zod";
import { GeneratedFile } from "./prompt.js";

export const RefineDraft = z.object({
  summary: z.string().max(300),            // shown in the chat as the assistant's reply
  files: z.array(GeneratedFile).max(10),   // full content of every changed/new file
  delete_paths: z.array(z.string()),
});

export const REFINE_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    delete_paths: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "files", "delete_paths"],
  additionalProperties: false,
} as const;

export const REFINE_SYSTEM = SYNTH_SYSTEM + `

# You are now EDITING an existing app
- You receive the current files you are allowed to change, the engines' interfaces, and either a user instruction or a runtime error.
- Return the FULL content of every file you change or add, plus delete_paths for files to remove. Do not return unchanged files.
- Keep everything that already works. Make the smallest change that fully satisfies the request.
- For a runtime error: find the root cause in the files and fix it; do not hide it with try/catch unless the error is genuinely expected.
- summary: one or two sentences, addressed to the user, describing what changed.`;
```

User message:

```ts
export function formatRefineRequest(req: RefineRequest): string {
  const editable = req.bundle.generated_paths
    .map((p) => `<file path="${p}">\n${req.bundle.files[p]}\n</file>`)
    .join("\n\n");
  const engines = req.blueprints
    .map((b) => `<engine module="${b.implementation.module_name}" path="/engines/${b.implementation.module_name}.ts">\n${b.spec.interface.types_code}\n</engine>`)
    .join("\n\n");
  const ask = req.kind === "fix"
    ? `<runtime_error>\n${req.runtime_error}\n</runtime_error>\nFix this error.`
    : `<user_request>\n${req.prompt}\n</user_request>`;
  return `${engines}\n\n${editable}\n\n${ask}`;
}
```

## 2. Merge + validate

```ts
export async function refine(req: RefineRequest, hooks: SynthHooks & { onSummary(s: string): void }): Promise<SynthesisBundle> {
  let messages: Parameters<typeof structuredCall>[0]["messages"] = [{ role: "user", content: formatRefineRequest(req) }];
  const call = () => structuredCall({
    system: REFINE_SYSTEM, messages, schema: REFINE_DRAFT_SCHEMA, parse: (v) => RefineDraft.parse(v),
    effort: "medium", maxTokens: 48_000, signal: hooks.signal, onProgress: hooks.onProgress,
  });

  hooks.onStage("generating", req.kind === "fix" ? "Diagnosing the runtime error…" : "Applying your change…");
  let res = await call();

  for (let attempt = 0; ; attempt++) {
    const generated = new Map(req.bundle.generated_paths.map((p) => [p, req.bundle.files[p]]));
    for (const p of res.value.delete_paths) if (p !== "/App.tsx") generated.delete(p);
    for (const f of res.value.files) generated.set(f.path.startsWith("/") ? f.path : "/" + f.path, f.content);

    const bundle = assembleBundle(req.blueprints, [...generated].map(([path, content]) => ({ path, content })), {
      bundle_id: req.bundle.bundle_id,
      app_title: req.bundle.app_title,
      app_description: req.bundle.app_description,
      revision: req.bundle.revision + 1,
      mode: "live",
    });
    hooks.onStage("validating", "Type-checking…");
    const v = validateBundle(bundle, req.blueprints);
    hooks.onValidation(v.ok, v.errors);
    if (v.ok || attempt >= 2) {
      if (!v.ok) bundle.warnings.push(...v.errors.map((e) => `Unresolved: ${e}`));
      hooks.onSummary(res.value.summary);
      return bundle;
    }
    hooks.onStage("fixing", `Fixing ${v.errors.length} compile problem(s)…`);
    messages = continueWith(messages, res.assistantContent,
      `After your change the app does not compile:\n<errors>\n${v.errors.join("\n")}\n</errors>\nReturn the corrected files (full content).`);
    res = await call();
  }
}
```

Add `summary` to the stream: emit it as a `stage` event with `stage: "complete"` and
`message: summary`. The chat panel shows the last `complete` message as the assistant reply.
The route is the same shape as `/api/synthesize` (02 §7), with `RefineRequest` and the key
`refine__<bundle_id>__r<revision>` for transcripts.

## 3. Auto-fix policy (frontend, implemented in 08)

```
bundle loads in Sandpack
  └─ runtime error within 4 s of load (or on first interaction)?
       ├─ autoFixUsed[bundle_id] < 1  → automatically POST /api/refine {kind:"fix", runtime_error}
       │                                  show toast "Found a runtime error — fixing automatically…"
       └─ otherwise                    → show error banner with [Fix with AI] button (manual)
```

- One automatic attempt per bundle revision chain is enough, and it avoids loops.
- Error text sent: Sandpack's `title + message + path:line` (first 2,000 chars).
- Ignore errors that clear on their own within 1 s (Sandpack can flash errors while bundling).
