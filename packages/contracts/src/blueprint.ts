import { z } from "zod";

export const BlueprintInputSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional()
});

export type BlueprintInput = z.infer<typeof BlueprintInputSchema>;

export const BlueprintOutputSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional()
});

export type BlueprintOutput = z.infer<typeof BlueprintOutputSchema>;

export const ReaEvidenceSchema = z.object({
  artifact_type: z.enum([
    "electron_asar",
    "javascript_bundle",
    "native_pe_dll",
    "native_elf",
    "managed_cli",
    "web_runtime"
  ]),
  target_file: z.string(),
  entry_symbols: z.array(z.string()),
  decompiled_snippet: z.string(),
  ipc_or_network_routes: z.array(z.string()).default([]),
  confidence_score: z.number().min(0).max(1).default(0.95),
  limitations: z.array(z.string()).default([])
});

export type ReaEvidence = z.infer<typeof ReaEvidenceSchema>;

export const CleanRoomImplementationSchema = z.object({
  language: z.literal("typescript"),
  module_name: z.string(),
  inputs: z.array(BlueprintInputSchema),
  outputs: z.array(BlueprintOutputSchema),
  portable_code: z.string(),
  unit_test_code: z.string().optional()
});

export type CleanRoomImplementation = z.infer<typeof CleanRoomImplementationSchema>;

export const FeatureBlueprintSchema = z.object({
  feature_id: z.string(),
  source_app: z.string(),
  source_icon: z.string().optional(),
  consumer_title: z.string(),
  consumer_description: z.string(),
  category: z.enum(["graph", "scheduling", "calculator", "parser", "state_engine", "utility"]),
  rea_evidence: ReaEvidenceSchema,
  clean_room_implementation: CleanRoomImplementationSchema
});

export type FeatureBlueprint = z.infer<typeof FeatureBlueprintSchema>;
