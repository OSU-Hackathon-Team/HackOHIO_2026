// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/02_ui_synthesis.md §2-4
// The model never writes engines: it sees each engine's interface and imports it.
import { z } from "zod";
import type { FeatureBlueprint } from "@splice/contracts";

export const GeneratedFile = z.object({ path: z.string(), content: z.string() });
export type GeneratedFile = z.infer<typeof GeneratedFile>;

export const SynthDraft = z.object({
  app_title: z.string().max(60),
  app_description: z.string().max(300),
  files: z.array(GeneratedFile).min(1).max(10),
});
export type SynthDraft = z.infer<typeof SynthDraft>;

export const FILE_SCHEMA = {
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
    files: { type: "array", items: FILE_SCHEMA },
  },
  required: ["app_title", "app_description", "files"],
  additionalProperties: false,
} as const;

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
- The engines are the only source of feature logic. If the user's request asks for behaviour no engine provides (for example scheduling, search, or streaks without a matching engine), do not implement that algorithm yourself. Leave it out and show one short, muted note in the UI naming the missing feature.

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

/** Engines are described by interface and behaviour only; their code is never sent. */
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
