import { z } from "zod";

// UI-triggered native decompilation runs (backend: routes/decompRuns.ts, worker: infra/decomp-ec2).

export const DecompTarget = z.object({
  id: z.string(),                       // "libreoffice-calc"
  name: z.string(),                     // "LibreOffice Calc"
  description: z.string(),
  library: z.string(),                  // engine library key, e.g. "calc" -> libsclo.so
  driver: z.enum(["uno", "cli"]).optional(),  // how cases run; absent means uno (older backends)
  function_budgets: z.array(z.number().int().positive()),   // allowed max_functions values
  estimated_cost_usd: z.record(z.string(), z.number()),     // by budget, e.g. {"20": 0.5}
});
export type DecompTarget = z.infer<typeof DecompTarget>;

export const DecompRunRequest = z.object({
  target_id: z.string(),
  max_functions: z.number().int().nonnegative(),
  mode: z.enum(["analysis", "public_oracle"]).optional(),
  confirm_cost: z.literal(true),        // the UI must show the estimate and get consent first
}).strict().superRefine((request, ctx) => {
  if ((request.mode === "public_oracle") !== (request.max_functions === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "public_oracle requires zero functions; analysis requires a positive budget" });
  }
});
export type DecompRunRequest = z.infer<typeof DecompRunRequest>;

export const DecompStage = z.enum([
  "queued", "instance_starting", "uploading", "setup", "triage", "analyze", "scope",
  "claims", "oracle", "dossier", "spec", "importing", "complete", "failed",
]);
export type DecompStage = z.infer<typeof DecompStage>;

export const PublicOracleReport = z.object({
  schema: z.literal(1), target_id: z.string(), application_version: z.string().nullable(),
  driver_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  binary_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  cases: z.array(z.object({
    id: z.string(), input: z.unknown(), observed: z.unknown(), error: z.string().nullable(),
    outcome: z.enum(["observed", "execution_error"]),
    diagnostics: z.object({ sort_descriptor: z.array(z.object({ name: z.string(), value: z.string().max(20000) })) }).optional(),
  }).strict()).min(1).max(512),
}).strict();
export type PublicOracleReport = z.infer<typeof PublicOracleReport>;

export const DecompRunResult = z.object({
  public_oracle: PublicOracleReport.optional(),
  readiness: z.string().nullable(),
  spec_artifact: z.string().nullable(),
  spec_status: z.enum(["draft", "ready_for_review"]).nullable(),
  spec_writer: z.string().nullable(),   // which writer produced the spec (LLM or deterministic fallback)
  spec_error: z.string().nullable(),
  claim_outcomes: z.record(z.string(), z.number()),
  functions: z.object({ included: z.number().int(), drafted: z.number().int(), reviewed: z.number().int() }),
  oracle: z.object({ public_agreement: z.number().int(), held_out_agreement: z.number().int(),
    public_observed: z.number().int().default(0), held_out_observed: z.number().int().default(0) }),
  handoff_path: z.string().nullable(), // repo-relative folder with README.md + evidence.json
  tokens: z.object({ input: z.number().int(), output: z.number().int() }),
});
export type DecompRunResult = z.infer<typeof DecompRunResult>;

const base = { run_id: z.string(), ts: z.number() };
export const DecompRunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), ...base, stage: DecompStage, message: z.string() }),
  z.object({ type: z.literal("progress"), ...base, label: z.string(), done: z.number().int(), total: z.number().int() }),
  z.object({ type: z.literal("log"), ...base, line: z.string() }),
  z.object({ type: z.literal("result"), ...base, result: DecompRunResult }),
  z.object({ type: z.literal("error"), ...base, message: z.string(), fatal: z.boolean() }),
  z.object({ type: z.literal("done"), ...base, ok: z.boolean() }),
]);
export type DecompRunEvent = z.infer<typeof DecompRunEvent>;

export const DecompRun = z.object({
  run_id: z.string(),
  target_id: z.string(),
  mode: z.enum(["analysis", "public_oracle"]).optional(),
  max_functions: z.number().int(),
  stage: DecompStage,
  started_at: z.number(),
  finished_at: z.number().nullable(),
  ok: z.boolean().nullable(),
  result: DecompRunResult.nullable(),
});
export type DecompRun = z.infer<typeof DecompRun>;
