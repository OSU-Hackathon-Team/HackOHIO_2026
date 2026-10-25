import { z } from "zod";
import { DecompRunResult } from "./decompRun.js";
import { FeatureBlueprint } from "./blueprint.js";
import { NativeSubsystemSpec } from "./nativeSpec.js";

export const NativeLibraryId = z.string().regex(/^[a-z0-9-]{8,64}$/);
export const SavedAnalysisSummary = z.object({
  id: NativeLibraryId, title: z.string(), target_id: z.string(), created_at: z.number(),
  binary_sha256: z.string().regex(/^[a-f0-9]{64}$/), result: DecompRunResult,
});
export const SavedFunction = z.object({
  entry: z.string(), name: z.string().nullable(), draft_state: z.string(), review_state: z.string().nullable(),
  decompilation: z.string().nullable(),
  claims: z.array(z.object({ statement: z.string(), review: z.object({ outcome: z.string(), reason: z.string() }).nullable() })),
  unknowns: z.array(z.string()),
});
export const SavedAnalysis = SavedAnalysisSummary.extend({
  schema: z.literal(1), functions: z.array(SavedFunction),
  observed_cases: z.array(z.object({ id: z.string(), formula: z.string(), cells: z.record(z.unknown()).optional(), observed: z.unknown() })),
  spec: NativeSubsystemSpec.nullable(),
});
export type SavedAnalysis = z.infer<typeof SavedAnalysis>;
export type SavedAnalysisSummary = z.infer<typeof SavedAnalysisSummary>;

export const SavedBlock = z.object({ schema: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/),
  blueprint: FeatureBlueprint.refine(bp => bp.verification.status === "passed" && bp.verification.total > 0 &&
    bp.verification.passed === bp.verification.total && bp.verification.tests.length === bp.verification.total &&
    bp.verification.tests.every(test => test.passed), "Building block must have passing engine tests"),
});
export type SavedBlock = z.infer<typeof SavedBlock>;
export const NativeLibrary = z.object({ enabled: z.boolean(), analyses: z.array(SavedAnalysisSummary), blocks: z.array(SavedBlock) });
export type NativeLibrary = z.infer<typeof NativeLibrary>;
