// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/01_engine_implementation.md §1-2
// The implementer sees ONLY the spec: never provenance.snippets (original source) or oracle.adapter_code.
import { z } from "zod";
import type { FeatureSpec } from "@splice/contracts";

export const EngineDraft = z.object({
  portable_code: z.string().min(1),
  notes: z.array(z.string()).max(8),
});
export type EngineDraft = z.infer<typeof EngineDraft>;

export const ENGINE_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    portable_code: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["portable_code", "notes"],
  additionalProperties: false,
} as const;

export const ENGINE_SYSTEM = `You implement TypeScript modules from a written specification. You have NOT seen any original implementation and must not guess at one beyond what the specification states.

Respond with JSON matching the provided schema:
- portable_code: one complete TypeScript module.
- notes: up to 8 short notes on non-obvious decisions (e.g. "rounding uses Math.round to 2 decimals per REQ-5").

Rules for portable_code:
1. It must satisfy the interface exactly: export every declared function with the same name and a compatible signature, and export every declared interface/type with the same name and the same shape. You may copy the interface declarations verbatim (dropping "declare").
2. Pure and deterministic: no imports, no require, no globals from the environment (process, window, document, localStorage, fetch, timers), no Date.now(), no new Date() without arguments, no Math.random(). Everything the function needs arrives through its parameters. new Date("<given string>") and Date.parse(<given string>) are fine.
3. No console output. Throw built-in errors (RangeError, TypeError, Error) where the requirements say to throw.
4. Implement every requirement. The acceptance tests are examples of the requirements, not the whole of them: do not special-case test inputs.
5. Small private helpers are fine; keep the module readable, under about 200 lines, with a one-line comment on each exported function naming the requirements it implements.
6. TypeScript strict mode must pass: no implicit any, no unused-variable errors that would fail compilation.`;

export function formatSpecForImplementer(spec: FeatureSpec): string {
  const reqs = spec.requirements.map((r) => `${r.id} [${r.kind}] ${r.statement}`).join("\n");
  return `<module name="${spec.interface.module_name}">
${spec.consumer_title}: ${spec.consumer_description}
</module>

<requirements>
${reqs}
</requirements>

<interface>
${spec.interface.types_code}
</interface>

<allowed_deviations>
${spec.allowed_deviations.join("\n") || "none"}
</allowed_deviations>

<acceptance_tests>
// Globals: test, assert (equal, deepEqual, ok, closeTo, throws) and every export of your module.
${spec.acceptance_tests}
</acceptance_tests>

Implement the module.`;
}
