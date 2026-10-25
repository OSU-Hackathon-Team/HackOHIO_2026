// Source of truth: agents/CONTRACTS.md — change both together (all three engineers approve).
import { z } from "zod";
import { ArtifactType } from "./pantry.js";

export const ToolCallRecord = z.object({
  seq: z.number().int(),                   // 1-based order within the run
  tool: z.string(),                        // real REA tool name
  args: z.record(z.string(), z.unknown()), // exactly what was sent
  ok: z.boolean(),
  duration_ms: z.number(),
  evidence_id: z.string().nullable(),      // structuredContent.evidence_id
  summary: z.string(),                     // ≤ 300 chars, human readable, shown in the terminal
  limitations: z.array(z.string()),        // copied from REA's Evidence
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

export const SourceSnippet = z.object({
  location: z.string(),                    // "app.asar:src/graph/wikilinks.js" or "Calc.dll!0x140023B80"
  symbol: z.string().nullable(),
  language: z.enum(["javascript", "typescript", "csharp", "c", "asm", "text"]),
  code: z.string(),                        // full module or function text (bridge caps at 40k chars)
  full_module: z.boolean(),                // true → can be executed for differential testing
});
export type SourceSnippet = z.infer<typeof SourceSnippet>;

export const TargetInfo = z.object({
  path: z.string(),                        // repo-relative
  artifact_type: ArtifactType,
  sha256: z.string(),                      // of the target file, computed by us
});
export type TargetInfo = z.infer<typeof TargetInfo>;

export const RawEvidence = z.object({
  app_id: z.string(),
  feature_id: z.string(),
  target: TargetInfo,
  rea_package_version: z.string(),         // "6.7.0"
  mode: z.enum(["live", "replay"]),
  tool_calls: z.array(ToolCallRecord),
  snippets: z.array(SourceSnippet).min(1),
  related_paths: z.array(z.string()),      // modules REA linked to the seed (imports/callers)
  limitations: z.array(z.string()),        // union of tool limitations, de-duplicated
  unknowns: z.array(z.string()),           // things REA said it could not resolve
  collected_at: z.string(),                // ISO timestamp
});
export type RawEvidence = z.infer<typeof RawEvidence>;
