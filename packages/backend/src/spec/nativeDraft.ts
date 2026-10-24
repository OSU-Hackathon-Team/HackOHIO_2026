import { z } from "zod";
import { continueWith, LlmSchemaError } from "../llm/llm.js";
import { writeDraft } from "./writeDraft.js";
import { sourceLikeText } from "./nativeSafety.js";

const text = z.string().min(1);
export const NativeDraft = z.object({
  title: text,
  purpose: text,
  interface: z.object({ inputs: z.array(text).min(1), outputs: z.array(text).min(1), state: z.array(text) }),
  requirements: z.array(z.object({ id: text, statement: text, claim_ids: z.array(text) })).min(1),
  behavior_steps: z.array(text).min(1),
  acceptance_criteria: z.array(text).min(1),
  deviations: z.array(text),
  exclusions: z.array(text),
});
export type NativeDraft = z.infer<typeof NativeDraft>;

const string = { type: "string" } as const;
const strings = { type: "array", items: string } as const;
export const NATIVE_DRAFT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title: string, purpose: string,
    interface: { type: "object", additionalProperties: false,
      properties: { inputs: strings, outputs: strings, state: strings },
      required: ["inputs", "outputs", "state"] },
    requirements: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { id: string, statement: string, claim_ids: strings },
      required: ["id", "statement", "claim_ids"] } },
    behavior_steps: strings, acceptance_criteria: strings,
    deviations: strings, exclusions: strings,
  },
  required: ["title", "purpose", "interface", "requirements", "behavior_steps",
    "acceptance_criteria", "deviations", "exclusions"],
} as const;

const SYSTEM = `You are Splice's regular specification writer. Turn reviewed behavioral facts into a
standalone cleanroom implementation specification. A different implementer sees only the result.
Write what an implementation must do, including data representation, ordering, state changes,
error behavior, boundary values, widths and overflow when the facts establish them.
Include relevant boundary and dependency contracts. State any deliberate exclusion and
interface adaptation explicitly; do not silently omit observable behavior.
Do not write source code, disassembly, language syntax, type declarations, executable tests,
or close translations of source control flow. behavior_steps are short, high-level prose.
Do not mention decompilation, reviews, evidence scores, addresses, claims, unknowns, or gaps.
Do not guess. Every factual requirement must cite one or more supplied claim_ids.
Do not invent initial values, thresholds, widths, error behavior, or causal rules from a
single example. Treat function summaries and examples as context, not as permission to
add facts absent from claims. If a statement has no claim, remove it.
Cover every supplied claim_id with a requirement. Combine facts when that improves clarity.
Number requirements REQ-1 onward without gaps. The interface is a descriptive data contract,
not a programming-language signature. Acceptance criteria are observable checks in prose.
If the facts do not define an essential behavior, the input should have been rejected upstream.
Return only schema-shaped JSON.`;

function fields(d: NativeDraft): string[] {
  return [d.title, d.purpose, ...d.interface.inputs, ...d.interface.outputs,
    ...d.interface.state, ...d.requirements.map((r) => r.statement),
    ...d.behavior_steps, ...d.acceptance_criteria, ...d.deviations, ...d.exclusions];
}

export function nativeDraftProblems(d: NativeDraft, claimIds: string[]): string[] {
  const errors: string[] = [];
  const expected = new Set(claimIds);
  const covered = new Set<string>();
  d.requirements.forEach((r, index) => {
    if (r.id !== `REQ-${index + 1}`) errors.push(`requirement ${index + 1} has wrong ID`);
    if (!r.claim_ids.length) errors.push(`${r.id} has no supporting claim`);
    for (const id of r.claim_ids) {
      if (!expected.has(id)) errors.push(`${r.id} cites invented claim ${id}`);
      else covered.add(id);
    }
  });
  for (const id of expected) if (!covered.has(id)) errors.push(`claim ${id} is not specified`);
  for (const value of fields(d)) {
    if (sourceLikeText(value) || value.includes("\n")) {
      errors.push("source-like or report-card content in implementer text");
      break;
    }
  }
  return errors;
}

export async function writeNativeDraft(input: { claims: { id: string }[]; [key: string]: unknown }): Promise<{ draft: NativeDraft; model: string }> {
  const ids = input.claims.map((claim) => claim.id);
  let messages: Parameters<typeof writeDraft>[0]["messages"] = [
    { role: "user", content: JSON.stringify(input) },
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    let result;
    try {
      result = await writeDraft({ system: SYSTEM, messages,
        schema: NATIVE_DRAFT_SCHEMA, parse: (value) => NativeDraft.parse(value),
        maxTokens: 16_384 });
    } catch (error) {
      if (!(error instanceof LlmSchemaError) || attempt === 2) throw error;
      messages = [{ role: "user", content: `${JSON.stringify(input)}\n\nThe previous draft failed schema validation: ${error.message}. Return every required field with valid types.` }];
      continue;
    }
    const problems = nativeDraftProblems(result.value, ids);
    if (!problems.length) return { draft: result.value, model: result.model };
    if (attempt === 2) throw new Error(`native spec draft failed validation: ${problems.join("; ")}`);
    messages = continueWith(messages, result.assistantContent,
      `Repair the complete draft: ${problems.join("; ")}. Keep all established behavior and use prose only.`);
  }
  throw new Error("native spec draft failed validation");
}
