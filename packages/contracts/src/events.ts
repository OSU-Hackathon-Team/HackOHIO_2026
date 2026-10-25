// Source of truth: agents/CONTRACTS.md — change both together (all three engineers approve).
import { z } from "zod";
import { FeatureSpec } from "./spec.js";
import { FeatureBlueprint } from "./blueprint.js";

export const PipelineStage = z.enum([
  // Step 1 (Eng 1)
  "queued", "connecting", "analyzing", "tracing", "reading_source",
  // Step 2 (Eng 2)
  "specifying", "checking_oracle", "repairing_spec",
  // Step 3a (Eng 3)
  "implementing", "testing", "repairing_engine",
  // terminal
  "complete", "failed",
]);
export type PipelineStage = z.infer<typeof PipelineStage>;

const base = { run_id: z.string(), feature_id: z.string(), ts: z.number() };

export const PipelineEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), ...base, stage: PipelineStage, message: z.string() }),
  z.object({ type: z.literal("tool_call"), ...base, seq: z.number(), tool: z.string(), args_preview: z.string() }),
  z.object({ type: z.literal("tool_result"), ...base, seq: z.number(), tool: z.string(), ok: z.boolean(),
             duration_ms: z.number(), summary: z.string(), evidence_id: z.string().nullable() }),
  z.object({ type: z.literal("llm_progress"), ...base,
             phase: z.enum(["specifying", "repairing_spec", "implementing", "repairing_engine"]),
             output_chars: z.number() }),
  z.object({ type: z.literal("test_result"), ...base, name: z.string(), kind: z.enum(["oracle", "acceptance"]),
             passed: z.boolean(), error: z.string().nullable() }),
  z.object({ type: z.literal("spec"), ...base, spec: FeatureSpec }),
  z.object({ type: z.literal("blueprint"), ...base, blueprint: FeatureBlueprint }),
  z.object({ type: z.literal("error"), ...base, message: z.string(), fatal: z.boolean() }),
  z.object({ type: z.literal("done"), ...base, ok: z.boolean(), replayed: z.boolean() }),
]);
export type PipelineEvent = z.infer<typeof PipelineEvent>;

export const ExtractRequest = z.object({
  app_id: z.string(),
  feature_id: z.string(),
  force_mode: z.enum(["live", "replay"]).optional(), // dev override only
});
export type ExtractRequest = z.infer<typeof ExtractRequest>;

export const ImplementRequest = z.object({
  spec: FeatureSpec,
  force_mode: z.enum(["live", "replay"]).optional(),
});
export type ImplementRequest = z.infer<typeof ImplementRequest>;
