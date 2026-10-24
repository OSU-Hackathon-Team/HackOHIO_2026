// Source of truth: agents/CONTRACTS.md — change both together (all three engineers approve).
import { z } from "zod";
import { FeatureSpec, TestCaseResult } from "./spec.js";

export const EngineImplementation = z.object({
  module_name: z.string(),                 // === spec.interface.module_name
  portable_code: z.string(),               // pure TS, zero imports, deterministic
  notes: z.array(z.string()),              // implementer's notes (shown in evidence drawer)
});
export type EngineImplementation = z.infer<typeof EngineImplementation>;

export const EngineVerification = z.object({
  status: z.enum(["passed", "failed"]),
  tests: z.array(TestCaseResult),          // kind "acceptance"
  passed: z.number().int(),
  total: z.number().int(),
  purity_violations: z.array(z.string()),  // must be empty for "passed"
  type_errors: z.array(z.string()),        // conformance to spec.interface.types_code; must be empty
  repair_attempts: z.number().int(),
  duration_ms: z.number(),
  implemented_at: z.string(),
  model: z.string(),
  mode: z.enum(["live", "replay"]),
});
export type EngineVerification = z.infer<typeof EngineVerification>;

export const FeatureBlueprint = z.object({
  schema_version: z.literal(1),
  feature_id: z.string(),
  spec: FeatureSpec,
  implementation: EngineImplementation,
  verification: EngineVerification,
});
export type FeatureBlueprint = z.infer<typeof FeatureBlueprint>;
