// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/03_requirements_prompt.md §1
import { z } from "zod";
import { Requirement, ExportSig, IoField } from "@splice/contracts";

export const SpecDraft = z.object({
  consumer_title: z.string().max(60),
  consumer_description: z.string().max(400),
  requirements: z.array(Requirement).min(1).max(20),
  module_name: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
  exports: z.array(ExportSig).min(1),
  types_code: z.string(),
  inputs: z.array(IoField),
  outputs: z.array(IoField),
  acceptance_tests: z.string(),
  adapter_code: z.string(),
  allowed_deviations: z.array(z.string()),
  stripped_glue: z.array(z.string()),
});
export type SpecDraft = z.infer<typeof SpecDraft>;

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const io = {
  type: "object",
  properties: { name: str, type: str, description: str },
  required: ["name", "type", "description"],
  additionalProperties: false,
} as const;

export const SPEC_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    consumer_title: str,
    consumer_description: str,
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: str,
          kind: { type: "string", enum: ["behavior", "invariant", "edge_case", "error"] },
          statement: str,
          source_refs: strArr,
        },
        required: ["id", "kind", "statement", "source_refs"],
        additionalProperties: false,
      },
    },
    module_name: str,
    exports: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: str,
          kind: { type: "string", enum: ["function", "type", "const"] },
          signature: str,
          description: str,
        },
        required: ["name", "kind", "signature", "description"],
        additionalProperties: false,
      },
    },
    types_code: str,
    inputs: { type: "array", items: io },
    outputs: { type: "array", items: io },
    acceptance_tests: str,
    adapter_code: str,
    allowed_deviations: strArr,
    stripped_glue: strArr,
  },
  required: [
    "consumer_title",
    "consumer_description",
    "requirements",
    "module_name",
    "exports",
    "types_code",
    "inputs",
    "outputs",
    "acceptance_tests",
    "adapter_code",
    "allowed_deviations",
    "stripped_glue",
  ],
  additionalProperties: false,
} as const;

export function parseSpecDraft(value: unknown): SpecDraft {
  return SpecDraft.parse(value);
}
