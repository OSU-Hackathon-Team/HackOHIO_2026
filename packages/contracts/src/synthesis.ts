// Source of truth: agents/CONTRACTS.md — change both together (all three engineers approve).
import { z } from "zod";
import { FeatureBlueprint } from "./blueprint.js";

/** Paths the LLM is allowed to write. Engines and entry files are written by the server only. */
export const GENERATED_PATH = /^\/(App\.tsx|components\/[A-Za-z0-9_-]+\.tsx|lib\/[A-Za-z0-9_-]+\.ts|data\/seed\.ts)$/;

/** npm packages generated code may import (plus relative imports). Versions pinned server-side. */
export const ALLOWED_DEPENDENCIES = {
  "react": "18.3.1",
  "react-dom": "18.3.1",
  "lucide-react": "0.344.0",
  "canvas-confetti": "1.9.3",
} as const;

export const SynthesizeRequest = z.object({
  blueprints: z.array(FeatureBlueprint).min(1).max(4),
  prompt: z.string().min(3).max(2000),
});
export type SynthesizeRequest = z.infer<typeof SynthesizeRequest>;

export const SynthesisBundle = z.object({
  bundle_id: z.string(),
  app_title: z.string(),
  app_description: z.string(),
  files: z.record(z.string(), z.string()),   // full Sandpack file map, including engines
  dependencies: z.record(z.string(), z.string()),
  engine_paths: z.array(z.string()),         // ["/engines/sm2Scheduler.ts", ...] — read-only in the UI
  generated_paths: z.array(z.string()),
  feature_ids: z.array(z.string()),
  warnings: z.array(z.string()),
  mode: z.enum(["live", "replay"]),
  revision: z.number().int(),                // 0 = first synthesis, +1 per refine
});
export type SynthesisBundle = z.infer<typeof SynthesisBundle>;

export const RefineRequest = z.object({
  bundle: SynthesisBundle,
  blueprints: z.array(FeatureBlueprint),
  kind: z.enum(["edit", "fix"]),
  prompt: z.string().max(2000),              // user instruction (edit) or "" (fix)
  runtime_error: z.string().nullable(),      // Sandpack error text for kind "fix"
});
export type RefineRequest = z.infer<typeof RefineRequest>;

export const SynthStage = z.enum(["designing", "generating", "validating", "fixing", "complete", "failed"]);

const base = { run_id: z.string(), ts: z.number() };
export const SynthEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), ...base, stage: SynthStage, message: z.string() }),
  z.object({ type: z.literal("llm_progress"), ...base, output_chars: z.number() }),
  z.object({ type: z.literal("validation"), ...base, ok: z.boolean(), errors: z.array(z.string()) }),
  z.object({ type: z.literal("bundle"), ...base, bundle: SynthesisBundle }),
  z.object({ type: z.literal("error"), ...base, message: z.string(), fatal: z.boolean() }),
  z.object({ type: z.literal("done"), ...base, ok: z.boolean() }),
]);
export type SynthEvent = z.infer<typeof SynthEvent>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  rea: z.object({ connected: z.boolean(), version: z.string().nullable(), tool_count: z.number() }),
  rea_mode: z.enum(["live", "replay", "auto"]),
  llm_mode: z.enum(["live", "replay"]),
  model: z.string(),
  models: z.record(z.string(), z.string()), // resolved role -> model table from models.json
});
export type HealthResponse = z.infer<typeof HealthResponse>;
