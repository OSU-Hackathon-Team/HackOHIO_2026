import { z } from "zod";

// A registered native decompilation target: fixtures/decomp/targets/<id>.json.
// The driver decides how cases run on the worker (scripts/native_pipeline.py):
//   uno  LibreOffice over UNO; cases are formulas or bounded table operations, observed from Calc.
//   cli  an apt-installed command-line program; cases are argument lists, and the program's
//        own stdout, stderr and exit code are the oracle.
const budgetKeyed = z.record(z.string().regex(/^\d+$/), z.number().nonnegative());

export const DecompTargetSpec = z.object({
  schema: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  driver: z.enum(["uno", "cli"]),
  library: z.string().regex(/^[a-z0-9][a-z0-9+._-]{0,63}$/),
  install: z.object({
    apt: z.string().regex(/^[a-z0-9][a-z0-9+.-]{1,63}$/),
    binary: z.string().regex(/^\/usr\/(?:s?bin|lib)\/(?!.*\.\.)[A-Za-z0-9+._/-]+$/),
  }).strict().optional(),
  cases: z.string().regex(/^fixtures\/decomp\/[a-z0-9_/.-]+\.json$/),
  trace_patterns: z.array(z.string().min(1)).min(1),
  /** Analysis profile `scripts/native_pipeline.py` runs; absent means scoped analysis. */
  scoped_analysis: z.boolean().optional(),
  function_budgets: z.array(z.number().int().positive().max(200)).min(1),
  estimated_cost_usd: budgetKeyed,
  depth_by_budget: z.record(z.string().regex(/^\d+$/), z.number().int().min(1).max(9)),
  handoff: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
}).strict().superRefine((target, ctx) => {
  if (target.driver === "cli" && !target.install) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["install"], message: "cli targets need an install recipe" });
  }
  for (const budget of target.function_budgets) {
    if (!(String(budget) in target.estimated_cost_usd) || !(String(budget) in target.depth_by_budget)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["function_budgets"],
        message: `budget ${budget} needs a cost estimate and a depth` });
    }
  }
});
export type DecompTargetSpec = z.infer<typeof DecompTargetSpec>;
