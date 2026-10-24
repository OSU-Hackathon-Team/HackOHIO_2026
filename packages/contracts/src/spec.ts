// Source of truth: agents/CONTRACTS.md — change both together (all three engineers approve).
import { z } from "zod";
import { Category, ArtifactType } from "./pantry.js";
import { ToolCallRecord, SourceSnippet, TargetInfo } from "./evidence.js";

export const Requirement = z.object({
  id: z.string().regex(/^REQ-\d+$/),       // "REQ-4"
  kind: z.enum(["behavior", "invariant", "edge_case", "error"]),
  statement: z.string(),                   // "A grade below 3 resets repetitions to 0 and the interval to 1 day"
  source_refs: z.array(z.string()).min(1), // "src/scheduler/sm2.js:L18-L24" — must point into RawEvidence.snippets
});
export type Requirement = z.infer<typeof Requirement>;

export const IoField = z.object({
  name: z.string(),
  type: z.string(),                        // TS type text, e.g. "CardState"
  description: z.string(),
});
export type IoField = z.infer<typeof IoField>;

export const ExportSig = z.object({
  name: z.string(),                        // "reviewCard"
  kind: z.enum(["function", "type", "const"]),
  signature: z.string(),                   // "(state: CardState, grade: number, today: string) => ReviewResult"
  description: z.string(),
});
export type ExportSig = z.infer<typeof ExportSig>;

export const InterfaceSpec = z.object({
  module_name: z.string().regex(/^[a-z][A-Za-z0-9]*$/), // engine file becomes /engines/<module_name>.ts
  exports: z.array(ExportSig).min(1),
  /** Ambient TS declarations the implementation must satisfy, e.g.
   *  `export interface CardState {...}` and `export declare function reviewCard(...): ReviewResult;` */
  types_code: z.string(),
});
export type InterfaceSpec = z.infer<typeof InterfaceSpec>;

export const TestCaseResult = z.object({
  name: z.string(),
  kind: z.enum(["oracle", "acceptance"]),  // oracle = run vs original via adapter; acceptance = run vs new engine
  passed: z.boolean(),
  error: z.string().nullable(),
  duration_ms: z.number(),
});
export type TestCaseResult = z.infer<typeof TestCaseResult>;

export const OracleCheck = z.object({
  status: z.enum(["passed", "failed", "not_executable"]), // not_executable: native/replay targets
  adapter_code: z.string().nullable(),     // JS: implements the interface by calling the ORIGINAL module
  tests: z.array(TestCaseResult),
  passed: z.number().int(),
  total: z.number().int(),
});
export type OracleCheck = z.infer<typeof OracleCheck>;

export const RequirementCoverage = z.object({
  requirement_id: z.string(),
  test_names: z.array(z.string()),         // COMPUTED by parsing "REQ-n" out of test names, never LLM-claimed
});
export type RequirementCoverage = z.infer<typeof RequirementCoverage>;

export const SpecProvenance = z.object({
  mode: z.enum(["live", "replay"]),        // replay → UI shows REPLAY badge
  target: TargetInfo,
  rea_package_version: z.string(),
  tool_calls: z.array(ToolCallRecord),
  snippets: z.array(SourceSnippet),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
  collected_at: z.string(),
  specified_at: z.string(),
  model: z.string(),
});
export type SpecProvenance = z.infer<typeof SpecProvenance>;

export const FeatureSpec = z.object({
  schema_version: z.literal(1),
  feature_id: z.string(),
  app_id: z.string(),
  source_app: z.string(),                  // "Recall Flashcards"
  source_icon: z.string(),                 // lucide icon name
  artifact_type: ArtifactType,
  consumer_title: z.string(),
  consumer_description: z.string(),
  category: Category,
  requirements: z.array(Requirement).min(1),
  interface: InterfaceSpec,
  inputs: z.array(IoField),
  outputs: z.array(IoField),
  /** Uses sandbox globals test()/assert and the interface's exports as globals.
   *  Every test name starts with the requirement IDs it covers: test("REQ-4 REQ-5: lapse ...", ...) */
  acceptance_tests: z.string(),
  coverage: z.array(RequirementCoverage),  // computed
  allowed_deviations: z.array(z.string()), // "clock is injected as `today` instead of Date.now()"
  stripped_glue: z.array(z.string()),      // platform code deliberately left out: "ipcMain.handle('card:answer')", "fs deck storage"
  oracle: OracleCheck,
  status: z.enum(["verified", "unverified"]), // verified ⇔ oracle passed && every requirement covered && no open issues
  open_issues: z.array(z.string()),        // why it's unverified (shown on the card); empty when verified
  repair_attempts: z.number().int(),
  provenance: SpecProvenance,
});
export type FeatureSpec = z.infer<typeof FeatureSpec>;
