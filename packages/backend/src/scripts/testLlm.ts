// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/02_llm_client.md §6
// npm run test:llm -w @splice/backend   — one real Bedrock call through llm.ts (costs a few tokens).
import { z } from "zod";
import { structuredCall } from "../llm/llm.js";
import { bedrockModelId } from "../models.js";

const Out = z.object({ answer: z.number() });
console.log(`Bedrock region ${process.env.AWS_REGION ?? "(unset)"} · spec_writer → ${bedrockModelId("spec_writer")}`);
try {
  const t0 = Date.now();
  const r = await structuredCall({
    role: "spec_writer",
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
  console.error(`\ntest:llm failed: ${(e as Error).name}: ${(e as Error).message}`);
  console.error("Check packages/backend/.env: AWS_REGION plus AWS_PROFILE, AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN, or AWS_BEARER_TOKEN_BEDROCK; and that the model is enabled in the Bedrock console.");
  process.exit(1);
}
