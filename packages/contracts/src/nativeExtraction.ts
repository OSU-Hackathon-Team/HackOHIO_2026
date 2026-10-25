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

const NativeExtractionFields = z.object({
  schema: z.literal(1), analysis_id: NativeLibraryId, analysis_sha256: digest,
  created_at: z.number(), model: z.string().min(1), intent: z.string(),
  spec: NativeSubsystemSpec,
  claim_sources: z.array(z.object({ id: z.string(), function_entry: z.string(), claim_index: z.number().int().nonnegative(),
    statement: z.string(), review_reason: z.string(),
    // Public original cases whose blind prediction from this claim matched the real result.
    case_ids: z.array(z.string()).min(1).optional() })),
  requirement_sources: z.array(z.object({ requirement_id: z.string(), claim_ids: z.array(z.string()) })),
  omitted_claims: z.array(z.object({ function_entry: z.string(), claim_index: z.number().int().nonnegative(), reason: z.string() })),
  limitations: z.array(z.string()),
});

// A draft unless every fact agreed with an original case and those cases are the spec's examples.
function readiness(payload: z.infer<typeof NativeExtractionFields>, ctx: z.RefinementCtx) {
  if (payload.spec.status === "draft") return;
  const linked = new Set(payload.claim_sources.flatMap(source => source.case_ids ?? []));
  if (!payload.claim_sources.length || payload.claim_sources.some(source => !source.case_ids?.length) ||
      !payload.spec.examples.length || payload.spec.examples.some(example => !linked.has(example.name.split(" ").pop()!))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spec", "status"],
      message: "Only an extraction whose every fact agreed with a linked original case can be ready for review" });
  }
}
export const NativeExtractionPayload = NativeExtractionFields.superRefine(readiness);
export const NativeExtraction = NativeExtractionFields.extend({ id: digest }).superRefine(readiness);
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
