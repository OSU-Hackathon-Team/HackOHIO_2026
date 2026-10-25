import { z } from "zod";
import { NativeExtraction } from "./nativeExtraction.js";
import { NativeLibraryId } from "./nativeLibrary.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_DISCOVERED_CAPABILITIES = 5;

// Explicit cost confirmation only: agents choose the capabilities, so no prompt or function selection is accepted.
export const NativeDiscoveryRequest = z.object({ confirm_cost: z.literal(true) }).strict();
export type NativeDiscoveryRequest = z.infer<typeof NativeDiscoveryRequest>;

export const DiscoveredCapability = z.object({
  id: z.string().regex(/^CAP-[1-9]\d*$/),
  name: z.string().min(1).max(80),
  purpose: z.string().min(1).max(400),
  claim_ids: z.array(z.string().min(1)).min(1),
});
export type DiscoveredCapability = z.infer<typeof DiscoveredCapability>;

// Every eligible claim is either assigned to a capability or accounted for here.
export const UnassignedClaim = z.object({
  claim_id: z.string().min(1),
  disposition: z.enum(["supporting_only", "insufficient", "deferred"]),
  reason: z.string().min(1).max(400),
});
export type UnassignedClaim = z.infer<typeof UnassignedClaim>;

export const DiscoveryCandidate = z.discriminatedUnion("status", [
  z.object({ capability_id: z.string(), status: z.literal("saved"), extraction_id: digest }),
  z.object({ capability_id: z.string(), status: z.literal("failed"), error: z.string() }),
  z.object({ capability_id: z.string(), status: z.literal("not_attempted"), reason: z.string() }),
]);
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidate>;

export const DiscoveryStatus = z.enum(["complete", "partial", "empty", "cancelled", "failed"]);
export type DiscoveryStatus = z.infer<typeof DiscoveryStatus>;

export const NativeDiscoveryReportPayload = z.object({
  schema: z.literal(1), analysis_id: NativeLibraryId, analysis_sha256: digest, created_at: z.number(),
  // The model that answered the discovery pass; each saved draft records its own writer model.
  model: z.string().nullable(),
  status: DiscoveryStatus,
  explanation: z.string(),
  eligible_claims: z.number().int().nonnegative(),
  omitted_claims: z.number().int().nonnegative(),
  capabilities: z.array(DiscoveredCapability).max(MAX_DISCOVERED_CAPABILITIES),
  unassigned: z.array(UnassignedClaim),
  candidates: z.array(DiscoveryCandidate),
  error: z.string().nullable(),
  limitations: z.array(z.string()),
});
export const NativeDiscoveryReport = NativeDiscoveryReportPayload.extend({ id: digest });
export type NativeDiscoveryReport = z.infer<typeof NativeDiscoveryReport>;

export const NativeDiscoveryEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), message: z.string() }),
  z.object({ type: z.literal("progress"), output_chars: z.number().nonnegative() }),
  z.object({ type: z.literal("capabilities"), capabilities: z.array(DiscoveredCapability), unassigned: z.array(UnassignedClaim),
    explanation: z.string() }),
  z.object({ type: z.literal("draft"), capability_id: z.string(), extraction: NativeExtraction }),
  z.object({ type: z.literal("candidate_failed"), capability_id: z.string(), message: z.string() }),
  z.object({ type: z.literal("report"), report: NativeDiscoveryReport }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("done"), ok: z.boolean() }),
]);
export type NativeDiscoveryEvent = z.infer<typeof NativeDiscoveryEvent>;
