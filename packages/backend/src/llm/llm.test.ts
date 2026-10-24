import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  LlmRefusalError, LlmSchemaError, LlmTruncatedError, continueWith, setClaudeClientForTests, structuredCall,
  type ClaudeClient,
} from "./llm.js";
import type { LlmPort } from "../engine/ports.js";
import { bedrockModelId } from "../models.js";

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

afterEach(() => setClaudeClientForTests(null));

const opts = (over: Partial<Parameters<typeof structuredCall<{ answer: number }>>[0]> = {}) => ({
  role: "engine_writer" as const,
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
  assert.equal(r.model, bedrockModelId("engine_writer"));
  assert.equal(r.assistantContent[0].type, "text");
  const req = requests[0];
  assert.equal(req.model, bedrockModelId("engine_writer"));
  assert.equal(req.max_tokens, 2000);
  assert.deepEqual(req.output_config, { effort: "low", format: { type: "json_schema", schema: opts().schema } });
  assert.deepEqual(req.system, [{ type: "text", text: "You are a calculator.", cache_control: { type: "ephemeral" } }]);
  assert.equal("thinking" in req, false, "Opus 5.5 rejects an explicit thinking config");
  assert.equal(progress.at(-1), '{"answer":391}'.length);
});

test("a refusal is retried once on the refusal_fallback model", async () => {
  const requests = fakeClaude([{ stop_reason: "refusal", category: "cyber" }, { text: '{"answer":391}' }]);
  const r = await structuredCall(opts());
  assert.deepEqual(requests.map((q) => q.model), [bedrockModelId("engine_writer"), bedrockModelId("refusal_fallback")]);
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
