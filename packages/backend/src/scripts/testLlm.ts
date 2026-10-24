// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/02_llm_client.md §6
// npm run test:llm -w @splice/backend [role]   — one real Bedrock call through llm.ts (costs a few tokens).
// role: spec_writer (default) | engine_writer | ui_synthesizer
import { z } from "zod";
import { structuredCall, formatLlmError } from "../llm/llm.js";
import { spliceModel } from "../models.js";

const role = (process.argv[2] ?? "spec_writer") as "spec_writer" | "engine_writer" | "ui_synthesizer";
const Out = z.object({ answer: z.number() });
try {
  const { id, api } = spliceModel(role);
  console.log(`Bedrock region ${process.env.AWS_REGION ?? "(unset)"} · ${role} → ${id} (${api})`);
  const t0 = Date.now();
  const r = await structuredCall({
    role,
    system: "You are a calculator. Reply only with the JSON requested.",
    messages: [{ role: "user", content: "What is 17 * 23?" }],
    schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
    parse: (v) => Out.parse(v),
    effort: "low",
    maxTokens: 2000,
    onProgress: (n) => process.stdout.write(`\r${n} chars`),
  });
  console.log(`\n`, r.value, `served by ${r.model} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(r.value.answer === 391 ? 0 : 1);
} catch (e) {
  console.error(`\ntest:llm failed: ${formatLlmError(e)}`);
  console.error("Check packages/backend/.env (AWS_REGION + credentials) and that the model is enabled in the Bedrock console.");
  process.exit(1);
}

