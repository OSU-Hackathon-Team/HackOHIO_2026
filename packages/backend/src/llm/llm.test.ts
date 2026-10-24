import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  LlmRefusalError, LlmSchemaError, LlmTruncatedError, continueWith, setClaudeClientForTests, setConverseClientForTests,
  structuredCall, CONVERSE_MAX_TOKENS, type ClaudeClient, type ConverseClient,
} from "./llm.js";
import type { LlmPort } from "../engine/ports.js";
import { bedrockModelId, spliceModel } from "../models.js";

// Compile-time: the real client satisfies the port Step 3 is built against.
const _port: LlmPort = { structuredCall, continueWith };
void _port;

type Reply = { text?: string; stop_reason?: Anthropic.StopReason; category?: string; model?: string };

/** Mantle double: answers stream() calls in order and records every request body. */
function fakeClaude(replies: Reply[]) {
  const requests: Record<string, any>[] = [];
  const client = {
    messages: {
      stream(params: Record<string, any>) {
        requests.push(params);
        const r = replies.shift();
        if (!r) throw new Error("unexpected stream() call");
        const handlers: ((d: string) => void)[] = [];
        const text = r.text ?? "";
        const msg = {
          id: "msg_test", type: "message", role: "assistant", model: r.model ?? params.model,
          content: text ? [{ type: "text", text, citations: null }] : [],
          stop_reason: r.stop_reason ?? "end_turn",
          stop_details: r.stop_reason === "refusal" ? { type: "refusal", category: r.category ?? null, explanation: "declined" } : null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
        };
        return {
          on(ev: string, h: (d: string) => void) { if (ev === "text") handlers.push(h); return this; },
          async finalMessage() {
            for (let i = 0; i < text.length; i += 4) handlers.forEach((h) => h(text.slice(i, i + 4)));
            return msg;
          },
        };
      },
    },
  };
  setClaudeClientForTests(client as unknown as ClaudeClient);
  return requests;
}

const originalSpec = process.env.MODEL_SPEC_WRITER;
const originalFallback = process.env.MODEL_REFUSAL_FALLBACK;
beforeEach(() => {
  process.env.MODEL_SPEC_WRITER = "amazon-bedrock/anthropic.claude-opus-5-5";
  process.env.MODEL_REFUSAL_FALLBACK = "amazon-bedrock/anthropic.claude-opus-4-8";
});
afterEach(() => {
  if (originalSpec === undefined) delete process.env.MODEL_SPEC_WRITER; else process.env.MODEL_SPEC_WRITER = originalSpec;
  if (originalFallback === undefined) delete process.env.MODEL_REFUSAL_FALLBACK; else process.env.MODEL_REFUSAL_FALLBACK = originalFallback;
  setClaudeClientForTests(null);
  setConverseClientForTests(null);
});

type ConverseReply = { tool?: string; text?: string; stop?: string };

/** Bedrock Converse double: streams each reply as ConverseStream events and records every command input. */
function fakeConverse(replies: ConverseReply[]) {
  const inputs: Record<string, any>[] = [];
  const client = {
    async send(command: { input: Record<string, any> }) {
      inputs.push(command.input);
      const r = replies.shift();
      if (!r) throw new Error("unexpected send() call");
      async function* stream() {
        yield { messageStart: { role: "assistant" } };
        const chunks = (s: string) => s.match(/.{1,5}/gs) ?? [];
        for (const c of chunks(r!.tool ?? "")) yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: c } } } };
        for (const c of chunks(r!.text ?? "")) yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: c } } };
        yield { messageStop: { stopReason: r!.stop ?? (r!.tool ? "tool_use" : "end_turn") } };
        yield { metadata: { usage: { inputTokens: 12, outputTokens: 7 } } };
      }
      return { stream: stream() };
    },
  };
  setConverseClientForTests(client as unknown as ConverseClient);
  return inputs;
}

const opts = (over: Partial<Parameters<typeof structuredCall<{ answer: number }>>[0]> = {}) => ({
  role: "spec_writer" as const,
  system: "You are a calculator.",
  messages: [{ role: "user" as const, content: "17 * 23?" }],
  schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
  parse: (v: unknown) => {
    const o = v as { answer: unknown };
    if (typeof o.answer !== "number") throw new Error("answer must be a number");
    return { answer: o.answer };
  },
  ...over,
});

test("a structured call sends the spec'd request and returns the parsed value", async () => {
  const requests = fakeClaude([{ text: '{"answer":391}' }]);
  const progress: number[] = [];
  const r = await structuredCall(opts({ effort: "low", maxTokens: 2000, onProgress: (n) => progress.push(n) }));

  assert.deepEqual(r.value, { answer: 391 });
  assert.equal(r.model, bedrockModelId("spec_writer"));
  assert.equal(r.assistantContent[0].type, "text");
  const req = requests[0];
  assert.equal(req.model, bedrockModelId("spec_writer"));
  assert.equal(req.max_tokens, 2000);
  assert.deepEqual(req.output_config, { effort: "low", format: { type: "json_schema", schema: opts().schema } });
  assert.deepEqual(req.system, [{ type: "text", text: "You are a calculator.", cache_control: { type: "ephemeral" } }]);
  assert.equal("thinking" in req, false, "Opus 5.5 rejects an explicit thinking config");
  assert.equal(progress.at(-1), '{"answer":391}'.length);
});

test("a refusal is retried once on the refusal_fallback model", async () => {
  const requests = fakeClaude([{ stop_reason: "refusal", category: "cyber" }, { text: '{"answer":391}' }]);
  const r = await structuredCall(opts());
  assert.deepEqual(requests.map((q) => q.model), [bedrockModelId("spec_writer"), bedrockModelId("refusal_fallback")]);
  assert.equal(r.model, bedrockModelId("refusal_fallback"), "provenance records the model that actually answered");
});

test("a refusal from both models throws LlmRefusalError with the category", async () => {
  fakeClaude([{ stop_reason: "refusal", category: "cyber" }, { stop_reason: "refusal", category: "cyber" }]);
  await assert.rejects(structuredCall(opts()), (e: unknown) => e instanceof LlmRefusalError && e.category === "cyber");
});

test("hitting max_tokens throws LlmTruncatedError", async () => {
  fakeClaude([{ text: '{"answ', stop_reason: "max_tokens" }]);
  await assert.rejects(structuredCall(opts()), LlmTruncatedError);
});

test("invalid JSON and failed validation throw LlmSchemaError with the raw text", async () => {
  fakeClaude([{ text: "not json" }]);
  await assert.rejects(structuredCall(opts()), (e: unknown) => e instanceof LlmSchemaError && e.raw === "not json");
  fakeClaude([{ text: '{"answer":"391"}' }]);
  await assert.rejects(structuredCall(opts()), /failed validation: answer must be a number/);
});

test("continueWith appends the assistant content unchanged, then the feedback", () => {
  const content = [{ type: "text", text: "{}", citations: null }] as Anthropic.ContentBlock[];
  const msgs = continueWith([{ role: "user", content: "hi" }], content, "fix it");
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].content, content);
  assert.deepEqual(msgs[2], { role: "user", content: "fix it" });
});

// ---- Converse path (non-Claude models marked splice_compatible, e.g. Qwen3 Coder) ----

const QWEN = "qwen.qwen3-coder-480b-a35b-v1:0";
const qwenOpts = (over: Parameters<typeof opts>[0] = {}) => opts({ role: "engine_writer", ...over });

test("models.json routes engine_writer to Qwen3 Coder over Converse; non-compatible models are refused", () => {
  delete process.env.MODEL_SPEC_WRITER;
  delete process.env.MODEL_REFUSAL_FALLBACK;
  for (const role of ["spec_writer", "engine_writer", "ui_synthesizer", "refusal_fallback"] as const) {
    assert.deepEqual(spliceModel(role), { id: QWEN, api: "converse" });
  }
  assert.deepEqual(spliceModel("engine_writer"), { id: QWEN, api: "converse" });
  assert.throws(() => spliceModel("engine_writer", "amazon-bedrock/amazon.nova-lite-v1:0"), /not marked splice_compatible/);
  assert.throws(() => bedrockModelId("engine_writer"), /needs a Claude model/);
});

test("a Converse call forces the respond tool with the schema and returns the parsed value", async () => {
  const inputs = fakeConverse([{ tool: '{"answer":391}' }]);
  const progress: number[] = [];
  const r = await structuredCall(qwenOpts({ maxTokens: 2000, onProgress: (n) => progress.push(n) }));

  assert.deepEqual(r.value, { answer: 391 });
  assert.equal(r.model, QWEN);
  assert.deepEqual(r.usage, { input_tokens: 12, output_tokens: 7 });
  assert.deepEqual(r.assistantContent, [{ type: "text", text: '{"answer":391}', citations: null }]);
  const req = inputs[0];
  assert.equal(req.modelId, QWEN);
  assert.equal(req.inferenceConfig.maxTokens, 2000);
  assert.deepEqual(req.toolConfig.toolChoice, { tool: { name: "respond" } });
  assert.deepEqual(req.toolConfig.tools[0].toolSpec.inputSchema, { json: opts().schema });
  assert.match(req.system[0].text, /^You are a calculator\.[\s\S]*"respond" tool/);
  assert.deepEqual(req.messages, [{ role: "user", content: [{ text: "17 * 23?" }] }]);
  assert.equal(progress.at(-1), '{"answer":391}'.length);
});

test("Converse repair turns go back as text, append-only", async () => {
  const inputs = fakeConverse([{ tool: '{"answer":390}' }, { tool: '{"answer":391}' }]);
  const first = await structuredCall(qwenOpts());
  const messages = continueWith(qwenOpts().messages, first.assistantContent, "Wrong, try again.");
  await structuredCall(qwenOpts({ messages }));
  assert.deepEqual(inputs[1].messages, [
    { role: "user", content: [{ text: "17 * 23?" }] },
    { role: "assistant", content: [{ text: '{"answer":390}' }] },
    { role: "user", content: [{ text: "Wrong, try again." }] },
  ]);
});

test("Converse stop reasons map to the same typed errors", async () => {
  delete process.env.MODEL_REFUSAL_FALLBACK;
  fakeConverse([{ tool: '{"ans', stop: "max_tokens" }]);
  await assert.rejects(structuredCall(qwenOpts()), LlmTruncatedError);
  fakeConverse([{ stop: "content_filtered" }]);
  await assert.rejects(structuredCall(qwenOpts()), (e: unknown) => e instanceof LlmRefusalError && e.category === "content_filtered");
  fakeConverse([{ text: "I think it is 391" }]);
  await assert.rejects(structuredCall(qwenOpts()), LlmSchemaError);
});

test("Converse caps output tokens at the Bedrock limit", async () => {
  const inputs = fakeConverse([{ tool: '{"answer":391}' }]);
  await structuredCall(qwenOpts({ maxTokens: 48_000 }));
  assert.equal(inputs[0].inferenceConfig.maxTokens, CONVERSE_MAX_TOKENS);
});

test("an identical fallback is not retried", async () => {
  delete process.env.MODEL_REFUSAL_FALLBACK;
  const inputs = fakeConverse([{ stop: "content_filtered" }]);
  await assert.rejects(structuredCall(qwenOpts()), LlmRefusalError);
  assert.equal(inputs.length, 1);
});

test("fallback dispatch can cross APIs and records the answering model", async () => {
  delete process.env.MODEL_REFUSAL_FALLBACK;
  const requests = fakeClaude([{ stop_reason: "refusal" }]);
  const inputs = fakeConverse([{ tool: '{"answer":391}' }]);
  const result = await structuredCall(opts());
  assert.equal(result.model, QWEN);
  assert.equal(requests.length, 1);
  assert.equal(inputs.length, 1);
});

test("Converse can fall back once to a Claude override", async () => {
  const inputs = fakeConverse([{ stop: "guardrail_intervened" }]);
  const requests = fakeClaude([{ text: '{"answer":391}' }]);
  const result = await structuredCall(qwenOpts());
  assert.equal(result.model, bedrockModelId("refusal_fallback"));
  assert.equal(inputs.length, 1);
  assert.equal(requests.length, 1);
});
