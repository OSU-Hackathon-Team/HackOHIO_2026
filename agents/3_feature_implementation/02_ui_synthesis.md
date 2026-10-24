# 02 — UI Synthesis (`POST /api/synthesize`)

Blueprints + the user's prompt → a React app built around the engines. The core rule is that
**the model never writes engine files.** It sees each engine's *interface* and imports it. The
server writes `/engines/*.ts` from `blueprint.implementation.portable_code`, so engines are
byte-identical by construction. We don't ask the model to copy them and then check.

## 1. Sandpack file map the server produces

```
/public/index.html        server  (Tailwind Play CDN + #root)            hidden in the code view
/index.tsx                server  (createRoot, imports ./styles.css + ./App)
/styles.css               server  (base font + body bg)
/engines/<module>.ts      server  (portable_code, verbatim)              read-only in the code view
/App.tsx                  model   (default export App)
/components/*.tsx         model   (optional)
/lib/*.ts                 model   (optional adapters/helpers)
/data/seed.ts             model   (optional seed data)
```

Allowed generated paths: `GENERATED_PATH` in contracts. Allowed npm imports:
`ALLOWED_DEPENDENCIES` (react, react-dom, lucide-react@0.344.0, canvas-confetti@1.9.3).

## 2. Output schema — `src/synthesis/prompt.ts`

Files are an **array** of `{path, content}`. Records with arbitrary keys are awkward in strict
JSON Schema.

```ts
import { z } from "zod";

export const GeneratedFile = z.object({ path: z.string(), content: z.string() });
export const SynthDraft = z.object({
  app_title: z.string().max(60),
  app_description: z.string().max(300),
  files: z.array(GeneratedFile).min(1).max(10),
});
export type SynthDraft = z.infer<typeof SynthDraft>;

const fileSchema = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
  additionalProperties: false,
} as const;

export const SYNTH_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    app_title: { type: "string" },
    app_description: { type: "string" },
    files: { type: "array", items: fileSchema },
  },
  required: ["app_title", "app_description", "files"],
  additionalProperties: false,
} as const;
```

## 3. System prompt

```ts
export const SYNTH_SYSTEM = `You build small, polished single-page React apps that run in a Sandpack browser sandbox. Each app is built around one or more pre-written "engines": verified TypeScript modules you import but never modify or re-implement.

Respond with JSON matching the provided schema. "files" contains ONLY the files you write.

# Files you may write (exact paths)
- /App.tsx (required; must "export default function App()")
- /components/<Name>.tsx (optional, PascalCase)
- /lib/<name>.ts (optional helpers that adapt engine inputs/outputs to UI state)
- /data/seed.ts (optional realistic seed data)
Do NOT write /index.tsx, /styles.css, /public/*, or anything under /engines/. They already exist.

# Imports
- Engines: import { fn, type T } from "./engines/<moduleName>" (from /App.tsx) or "../engines/<moduleName>" (from /components or /lib). Use the exact export names in each engine's interface.
- npm packages allowed: react, lucide-react (icons), canvas-confetti (import confetti from "canvas-confetti"). Nothing else.
- No network requests, no external images or fonts.

# Using the engines
- Every engine provided MUST be imported and visibly used in the UI. Engine results drive what is displayed. Never re-implement engine logic in UI code.
- Engines are pure: keep app state in React (useState/useReducer). Pass dates as "YYYY-MM-DD" strings when an engine asks for them; compute "today" in the UI with new Date().toISOString().slice(0, 10).
- Combine the engines so they feed each other where the user's request implies it (e.g. notes from one engine become cards for another). This fusion is the point of the app.
- Include a small footer "Built from:" listing each engine's consumer title and source app (given below).

# Data
- Ship realistic seed data for the user's domain so the app is useful the moment it opens (at least 5 items). No lorem ipsum.
- Optional persistence with localStorage must be wrapped in try/catch and must never be required for the app to work.

# Look and feel
- Tailwind CSS utility classes only (Tailwind is loaded from a CDN). No CSS files, no inline <style>.
- Clean and modern: neutral slate background, white or slate-900 cards, rounded-xl, subtle borders, clear hierarchy, generous spacing, one accent color. Responsive down to 360px wide.
- Accessible: buttons are <button>, inputs have labels, sufficient contrast.

# Code quality
- TypeScript that compiles under strict mode. Type every useState whose initial value is empty ([] or null).
- Keep the whole app under about 600 lines across files.`;
```

## 4. User message — engines described by interface only

```ts
import type { FeatureBlueprint } from "@splice/contracts";

export function formatSynthRequest(blueprints: FeatureBlueprint[], prompt: string): string {
  const engines = blueprints.map((b) => {
    const s = b.spec;
    return `<engine module="${s.interface.module_name}" path="/engines/${s.interface.module_name}.ts">
title: ${s.consumer_title}  (from ${s.source_app})
what it does: ${s.consumer_description}
behaviour:
${s.requirements.map((r) => `- ${r.statement}`).join("\n")}
interface:
${s.interface.types_code}
</engine>`;
  }).join("\n\n");
  return `${engines}\n\n<user_request>\n${prompt}\n</user_request>\n\nBuild the app.`;
}
```

## 5. Assembly — `src/synthesis/assemble.ts`

```ts
import { GENERATED_PATH, ALLOWED_DEPENDENCIES, type FeatureBlueprint, type SynthesisBundle } from "@splice/contracts";
import type { SynthDraft } from "./prompt.js";

export const ENTRY_FILES: Record<string, string> = {
  "/public/index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-slate-50 text-slate-900 antialiased">
    <div id="root"></div>
  </body>
</html>`,
  "/index.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);`,
  "/styles.css": `html, body, #root { min-height: 100%; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }`,
};

export function enginePath(b: FeatureBlueprint) {
  return `/engines/${b.implementation.module_name}.ts`;
}

/** Merge: server entry files + engines (verbatim) + allowed generated files. */
export function assembleBundle(
  blueprints: FeatureBlueprint[],
  generated: { path: string; content: string }[],
  meta: { bundle_id: string; app_title: string; app_description: string; revision: number; mode: "live" | "replay" },
): SynthesisBundle {
  const warnings: string[] = [];
  const files: Record<string, string> = { ...ENTRY_FILES };
  for (const b of blueprints) files[enginePath(b)] = b.implementation.portable_code;

  const generated_paths: string[] = [];
  for (const f of generated) {
    const p = f.path.startsWith("/") ? f.path : "/" + f.path;
    if (!GENERATED_PATH.test(p)) { warnings.push(`Dropped file outside allowed paths: ${p}`); continue; }
    files[p] = f.content;
    generated_paths.push(p);
  }

  return {
    bundle_id: meta.bundle_id,
    app_title: meta.app_title,
    app_description: meta.app_description,
    files,
    dependencies: { ...ALLOWED_DEPENDENCIES },
    engine_paths: blueprints.map(enginePath),
    generated_paths,
    feature_ids: blueprints.map((b) => b.feature_id),
    warnings,
    mode: meta.mode,
    revision: meta.revision,
  };
}
```

## 6. `src/synthesis/synthesize.ts` — generate → validate → fix (≤ 2)

```ts
import type { FeatureBlueprint, SynthesisBundle } from "@splice/contracts";
import { structuredCall, continueWith } from "../llm/llm.js";
import { SYNTH_SYSTEM, SYNTH_DRAFT_SCHEMA, SynthDraft, formatSynthRequest } from "./prompt.js";
import { assembleBundle } from "./assemble.js";
import { validateBundle } from "./validateBundle.js";

export interface SynthHooks {
  signal?: AbortSignal;
  onStage(stage: "designing" | "generating" | "validating" | "fixing", message: string): void;
  onProgress(outputChars: number): void;
  onValidation(ok: boolean, errors: string[]): void;
}

const MAX_FIXES = 2;

export async function synthesize(blueprints: FeatureBlueprint[], prompt: string, bundleId: string, hooks: SynthHooks): Promise<SynthesisBundle> {
  let messages: Parameters<typeof structuredCall>[0]["messages"] = [{ role: "user", content: formatSynthRequest(blueprints, prompt) }];
  const call = () =>
    structuredCall({
      role: "ui_synthesizer",
      system: SYNTH_SYSTEM,
      messages,
      schema: SYNTH_DRAFT_SCHEMA,
      parse: (v) => SynthDraft.parse(v),
      effort: "medium",
      maxTokens: 48_000,
      signal: hooks.signal,
      onProgress: hooks.onProgress,
    });

  hooks.onStage("designing", `Designing an app around ${blueprints.map((b) => b.spec.interface.module_name).join(" + ")}`);
  hooks.onStage("generating", "Generating React components…");
  let res = await call();

  for (let attempt = 0; ; attempt++) {
    const bundle = assembleBundle(blueprints, res.value.files, {
      bundle_id: bundleId, app_title: res.value.app_title, app_description: res.value.app_description, revision: 0, mode: "live",
    });
    hooks.onStage("validating", "Type-checking the bundle against the engines…");
    const v = validateBundle(bundle, blueprints);
    hooks.onValidation(v.ok, v.errors);
    if (v.ok || attempt >= MAX_FIXES) {
      if (!v.ok) bundle.warnings.push(...v.errors.map((e) => `Unresolved: ${e}`));
      return bundle;
    }
    hooks.onStage("fixing", `Fixing ${v.errors.length} problem(s): ${v.errors[0].slice(0, 120)}`);
    messages = continueWith(messages, res.assistantContent,
      `The app does not compile yet:\n<errors>\n${v.errors.join("\n")}\n</errors>\nReturn ALL your files again with the errors fixed. Remember: engines are fixed; adapt the UI to their exact interfaces.`);
    res = await call();
  }
}
```

## 7. Route (add to `src/routes/step3/index.ts`)

```ts
step3Router.post("/api/synthesize", async (req, res) => {
  const parsed = SynthesizeRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { blueprints, prompt } = parsed.data;
  const sse = openSse(req, res);
  const run_id = newRunId();
  const key = `${blueprints.map((b) => b.feature_id).sort().join("+")}__${slug(prompt)}`;
  const base = () => ({ run_id, ts: Date.now() });

  if (config.llmMode === "replay") {
    if (!(await replayTranscript("synthesize", key, sse, { runId: run_id }))) {
      sse.send({ type: "error", ...base(), message: `No recording for "${key}"`, fatal: true });
      sse.send({ type: "done", ...base(), ok: false });
    }
    return sse.close();
  }

  const transcript = createTranscript("synthesize", key);
  const emit = (e: SynthEvent) => { sse.send(e); transcript.push(e); };
  let ok = false;
  try {
    const bundle = await synthesize(blueprints, prompt, `b_${run_id}`, {
      signal: sse.signal,
      onStage: (stage, message) => emit({ type: "stage", ...base(), stage, message }),
      onProgress: (output_chars) => emit({ type: "llm_progress", ...base(), output_chars }),
      onValidation: (ok, errors) => emit({ type: "validation", ...base(), ok, errors }),
    });
    emit({ type: "bundle", ...base(), bundle });
    emit({ type: "stage", ...base(), stage: "complete", message: `${bundle.app_title}: ${bundle.generated_paths.length} files around ${bundle.engine_paths.length} engines` });
    ok = true;
  } catch (e) {
    if (!sse.signal.aborted) emit({ type: "error", ...base(), message: (e as Error).message, fatal: true });
  } finally {
    emit({ type: "done", ...base(), ok });
    await transcript.save(ok);
    sse.close();
  }
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
```

The demo prompt is fixed (09), so its `key` is stable and replay finds it.

## 8. Demo recipes to test against (`npm run test:synthesis`)

| Recipe | Blueprints | Prompt |
|---|---|---|
| **Med-school study room** (golden path) | `inkwell.wikilink_graph` + `recall.sm2_scheduler` | "Build a study app for a medical student: notes link to each other with [[wiki links]], show each note's backlinks, and turn every note into a flashcard scheduled with spaced repetition. Show what's due today." |
| Habit journal | `recall.review_streaks` + `inkwell.fuzzy_search` | "A daily journal where I can quickly fuzzy-search past entries and see my current and longest writing streak." |
| All four | all | "A personal knowledge base with linked notes, fast search, spaced-repetition review and a streak counter." |

`testSynthesis.ts` runs each recipe, validates, writes `fixtures/bundles/<key>.latest.json`, and
prints file list, line counts, warnings and time. A bundle passes when the validator has 0
errors **and** it loads in Sandpack without a runtime error (checked by hand in the Studio).
