import { z } from "zod";
import { NativeSubsystemSpec } from "./nativeSpec.js";
import { NativeLibraryId } from "./nativeLibrary.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeExtractionRequest = z.object({
  confirm_cost: z.literal(true),
  intent: z.string().max(2000).default(""),
  function_entries: z.array(z.string().min(1).max(128)).max(128).default([]),
}).strict();
export type NativeExtractionRequest = z.infer<typeof NativeExtractionRequest>;

export const NativeExtractionPayload = z.object({
  schema: z.literal(1), analysis_id: NativeLibraryId, analysis_sha256: digest,
  created_at: z.number(), model: z.string().min(1), intent: z.string(),
  // Saved claims have static reviews but no independently validated claim-to-case links.
  spec: NativeSubsystemSpec.refine(spec => spec.status === "draft", "Saved-evidence extraction must remain a draft"),
  claim_sources: z.array(z.object({ id: z.string(), function_entry: z.string(), claim_index: z.number().int().nonnegative(),
    statement: z.string(), review_reason: z.string() })),
  requirement_sources: z.array(z.object({ requirement_id: z.string(), claim_ids: z.array(z.string()) })),
  omitted_claims: z.array(z.object({ function_entry: z.string(), claim_index: z.number().int().nonnegative(), reason: z.string() })),
  limitations: z.array(z.string()),
});
export const NativeExtraction = NativeExtractionPayload.extend({ id: digest });
export type NativeExtraction = z.infer<typeof NativeExtraction>;

export const AddLibraryFeatureRequest = z.object({ analysis_id: NativeLibraryId, extraction_id: digest }).strict();
export type AddLibraryFeatureRequest = z.infer<typeof AddLibraryFeatureRequest>;

export const NativeExtractionEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), message: z.string() }),
  z.object({ type: z.literal("progress"), output_chars: z.number().nonnegative() }),
  z.object({ type: z.literal("extraction"), extraction: NativeExtraction }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("done"), ok: z.boolean() }),
]);
export type NativeExtractionEvent = z.infer<typeof NativeExtractionEvent>;
