import { z } from "zod";
import { FeatureBlueprintSchema, type FeatureBlueprint } from "./blueprint.js";

export const SseProgressEventSchema = z.object({
  stage: z.enum([
    "connected",
    "analyzing",
    "locating_symbol",
    "tracing_ast",
    "decompiling",
    "clean_room_synthesis",
    "complete",
    "error"
  ]),
  message: z.string(),
  tool_called: z.string().optional(),
  tool_args: z.record(z.any()).optional(),
  timestamp: z.number(),
  data: FeatureBlueprintSchema.optional()
});

export type SseProgressEvent = z.infer<typeof SseProgressEventSchema>;

export const SynthesisRequestSchema = z.object({
  blueprints: z.array(FeatureBlueprintSchema),
  specialization_prompt: z.string()
});

export type SynthesisRequest = z.infer<typeof SynthesisRequestSchema>;

export const SynthesisResponseSchema = z.object({
  app_title: z.string(),
  app_description: z.string(),
  files: z.record(z.string()),
  dependencies: z.record(z.string()).default({})
});

export type SynthesisResponse = z.infer<typeof SynthesisResponseSchema>;

export const RefineRequestSchema = z.object({
  current_files: z.record(z.string()),
  blueprints: z.array(FeatureBlueprintSchema),
  refine_prompt: z.string()
});

export type RefineRequest = z.infer<typeof RefineRequestSchema>;
