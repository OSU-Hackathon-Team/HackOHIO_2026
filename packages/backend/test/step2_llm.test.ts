process.env.NODE_ENV = "test";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  structuredCall,
  continueWith,
  toolLoop,
  setClaudeClientForTests,
  setConverseClientForTests,
  LlmRefusalError,
  LlmTruncatedError,
  LlmSchemaError,
  LlmServiceError,
  sanitizeSecrets,
  formatLlmError,
  type ClaudeClient,
  type ConverseClient,
} from "../dist/llm/llm.js";
import { SPEC_DRAFT_SCHEMA, SpecDraft, parseSpecDraft } from "../dist/llm/schemas.js";
import { spliceModel, bedrockModelId, getModel, roleEnvVar } from "../dist/models.js";

function fakeClaude(steps: Array<{ text?: string; stop_reason?: string; category?: string; explanation?: string }>) {
  const requests: any[] = [];
  let i = 0;
  const client: ClaudeClient = {
    messages: {
      stream(params: any) {
        requests.push(params);
        const step = steps[i++] ?? { text: "{}" };
        const text = step.text ?? "";
        const stopReason = (step.stop_reason ?? "end_turn") as any;
        const msg = {
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text, citations: null }],
          model: params.model,
          stop_reason: stopReason,
          stop_details: step.category ? { type: "refusal", category: step.category, explanation: step.explanation ?? null } : null,
          usage: { input_tokens: 10, output_tokens: text.length, cache_read_input_tokens: 0 },
        };
        const handlers: Record<string, ((...args: any[]) => void)[]> = {};
        const emitter = {
          on(event: string, handler: any) {
            (handlers[event] ??= []).push(handler);
            return emitter;
          },
          async finalMessage() {
            for (const h of handlers["text"] ?? []) {
              h(text);
            }
            return msg;
          },
        };
        return emitter as any;
      },
    } as any,
  };
  setClaudeClientForTests(client);
  return requests;
}

function fakeConverse(steps: Array<{ tool?: string; text?: string; stop?: string }>) {
  const inputs: any[] = [];
  let i = 0;
  const client: ConverseClient = {
    async send(command: any) {
      inputs.push(command.input);
      const step = steps[i++] ?? { tool: "{}" };
      async function* stream() {
        if (step.tool) {
          yield { contentBlockDelta: { delta: { toolUse: { input: step.tool } } } };
        }
        if (step.text) {
          yield { contentBlockDelta: { delta: { text: step.text } } };
        }
        yield { messageStop: { stopReason: step.stop ?? "tool_use" } };
        yield { metadata: { usage: { inputTokens: 12, outputTokens: 7 } } };
      }
      return { stream: stream() } as any;
    },
  };
  setConverseClientForTests(client);
  return inputs;
}

const sampleCalcOpts = (over: Partial<Parameters<typeof structuredCall<{ answer: number }>>[0]> = {}) => ({
  role: "spec_writer" as const,
  system: "You are a calculator.",
  messages: [{ role: "user" as const, content: "What is 17 * 23?" }],
  schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
  parse: (v: unknown) => {
    const o = v as { answer: unknown };
    if (typeof o.answer !== "number") throw new Error("answer must be a number");
    return { answer: o.answer };
  },
  ...over,
});

const originalSpec = process.env.MODEL_SPEC_WRITER;
const originalFallback = process.env.MODEL_REFUSAL_FALLBACK;
const originalRegion = process.env.AWS_REGION;

describe("Step 2: Bedrock LLM Integration Suite", () => {
  beforeEach(() => {
    process.env.AWS_REGION = "us-east-2";
    process.env.MODEL_SPEC_WRITER = "amazon-bedrock/anthropic.claude-opus-5-5";
    process.env.MODEL_REFUSAL_FALLBACK = "amazon-bedrock/anthropic.claude-opus-4-8";
  });

  afterEach(() => {
    if (originalSpec === undefined) delete process.env.MODEL_SPEC_WRITER;
    else process.env.MODEL_SPEC_WRITER = originalSpec;
    if (originalFallback === undefined) delete process.env.MODEL_REFUSAL_FALLBACK;
    else process.env.MODEL_REFUSAL_FALLBACK = originalFallback;
    if (originalRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = originalRegion;
    setClaudeClientForTests(null);
    setConverseClientForTests(null);
  });

  describe("Model Configuration and Routing", () => {
    it("resolves configured roles through models.json", () => {
      const specWriter = spliceModel("spec_writer");
      assert.ok(specWriter.id, "spec_writer must resolve to a model id");
      assert.ok(specWriter.api === "anthropic" || specWriter.api === "converse");

      const engineWriter = spliceModel("engine_writer");
      assert.ok(engineWriter.id, "engine_writer must resolve to a model id");

      const uiSynthesizer = spliceModel("ui_synthesizer");
      assert.ok(uiSynthesizer.id, "ui_synthesizer must resolve to a model id");

      const refusalFallback = spliceModel("refusal_fallback");
      assert.ok(refusalFallback.id, "refusal_fallback must resolve to a model id");
    });

    it("respects MODEL_<ROLE> environment variable overrides", () => {
      const envVar = roleEnvVar("spec_writer");
      const saved = process.env[envVar];
      try {
        process.env[envVar] = "amazon-bedrock/anthropic.claude-opus-5-5";
        const model = spliceModel("spec_writer");
        assert.equal(model.id, "anthropic.claude-opus-5-5");
        assert.equal(model.api, "anthropic");
      } finally {
        if (saved !== undefined) {
          process.env[envVar] = saved;
        } else {
          delete process.env[envVar];
        }
      }
    });

    it("rejects non-compatible non-Claude models gracefully", () => {
      assert.throws(
        () => spliceModel("engine_writer", "amazon-bedrock/amazon.nova-lite-v1:0"),
        /not marked splice_compatible/,
      );
    });
  });

  describe("Structured Calls and Streaming", () => {
    it("executes Claude Messages API structured calls deterministically with progress tracking", async () => {
      const savedEnv = process.env[roleEnvVar("spec_writer")];
      process.env[roleEnvVar("spec_writer")] = "anthropic.claude-opus-5-5";
      try {
        const requests = fakeClaude([{ text: '{"answer":391}' }]);
        const progressDeltas: number[] = [];

        const result = await structuredCall(
          sampleCalcOpts({
            effort: "high",
            maxTokens: 2500,
            onProgress: (chars) => progressDeltas.push(chars),
          }),
        );

        assert.deepEqual(result.value, { answer: 391 });
        assert.equal(result.model, "anthropic.claude-opus-5-5");
        assert.equal(requests.length, 1);
        assert.equal(requests[0].model, "anthropic.claude-opus-5-5");
        assert.equal(requests[0].max_tokens, 2500);
        assert.deepEqual(requests[0].output_config, {
          effort: "high",
          format: { type: "json_schema", schema: sampleCalcOpts().schema },
        });
        assert.equal(progressDeltas.at(-1), '{"answer":391}'.length);
      } finally {
        if (savedEnv !== undefined) process.env[roleEnvVar("spec_writer")] = savedEnv;
        else delete process.env[roleEnvVar("spec_writer")];
      }
    });

    it("executes Bedrock Converse API calls with forced respond tool and structured parsing", async () => {
      const savedEnv = process.env[roleEnvVar("spec_writer")];
      process.env[roleEnvVar("spec_writer")] = "qwen.qwen3-coder-480b-a35b-v1:0";
      try {
        const inputs = fakeConverse([{ tool: '{"answer":391}' }]);
        const progress: number[] = [];

        const result = await structuredCall(
          sampleCalcOpts({
            effort: "low",
            maxTokens: 2000,
            onProgress: (n) => progress.push(n),
          }),
        );

        assert.deepEqual(result.value, { answer: 391 });
        assert.equal(result.model, "qwen.qwen3-coder-480b-a35b-v1:0");
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0].modelId, "qwen.qwen3-coder-480b-a35b-v1:0");
        assert.deepEqual(inputs[0].toolConfig.toolChoice, { tool: { name: "respond" } });
        assert.equal(progress.at(-1), '{"answer":391}'.length);
      } finally {
        if (savedEnv !== undefined) process.env[roleEnvVar("spec_writer")] = savedEnv;
        else delete process.env[roleEnvVar("spec_writer")];
      }
    });

    it("constructs append-only conversations via continueWith", () => {
      const messages = [{ role: "user" as const, content: "Initial prompt" }];
      const assistantContent = [{ type: "text" as const, text: '{"answer": 0}', citations: null }];
      const continued = continueWith(messages, assistantContent, "Validation failed: answer must be positive");

      assert.equal(continued.length, 3);
      assert.deepEqual(continued[0], { role: "user", content: "Initial prompt" });
      assert.deepEqual(continued[1], { role: "assistant", content: assistantContent });
      assert.deepEqual(continued[2], { role: "user", content: "Validation failed: answer must be positive" });
    });
  });

  describe("Boundary Validation with Shared Schemas", () => {
    const validDraftPayload = {
      consumer_title: "SM-2 Interval Calculator",
      consumer_description: "Calculates review intervals and ease factor using SM-2 algorithm.",
      requirements: [
        {
          id: "REQ-1",
          kind: "behavior",
          statement: "Grade 3 or higher increments repetition count.",
          source_refs: ["src/sm2.js:L10-L15"],
        },
      ],
      module_name: "sm2Calculator",
      exports: [
        {
          name: "calculateInterval",
          kind: "function",
          signature: "(grade: number, reps: number) => number",
          description: "Returns the interval in days",
        },
      ],
      types_code: "export interface SM2State { repetitions: number; ease: number; }\n",
      inputs: [{ name: "grade", type: "number", description: "Review performance grade 0-5" }],
      outputs: [{ name: "interval", type: "number", description: "Days until next review" }],
      acceptance_tests: "test('REQ-1: test reps increment', () => assert.equal(calculateInterval(4, 1), 6));",
      adapter_code: "export function calculateInterval(g, r) { return originalSm2(g, r); }",
      allowed_deviations: ["State stores ease factor as rounded float"],
      stripped_glue: ["ipcMain.handle('sm2:calc')"],
    };

    it("validates a compliant SpecDraft payload", () => {
      const parsed = parseSpecDraft(validDraftPayload);
      assert.equal(parsed.module_name, "sm2Calculator");
      assert.equal(parsed.requirements.length, 1);
      assert.equal(parsed.requirements[0].id, "REQ-1");
    });

    it("verifies SPEC_DRAFT_SCHEMA conforms to JSON schema constraints required by Bedrock", () => {
      assert.equal(SPEC_DRAFT_SCHEMA.type, "object");
      assert.equal(SPEC_DRAFT_SCHEMA.additionalProperties, false);
      assert.ok(Array.isArray(SPEC_DRAFT_SCHEMA.required));
      assert.ok(SPEC_DRAFT_SCHEMA.required.includes("module_name"));
      assert.ok(SPEC_DRAFT_SCHEMA.required.includes("acceptance_tests"));
      assert.ok(SPEC_DRAFT_SCHEMA.required.includes("adapter_code"));
    });

    it("rejects an invalid SpecDraft with malformed requirement ID or invalid module name", () => {
      assert.throws(
        () => parseSpecDraft({ ...validDraftPayload, module_name: "123_invalid_module" }),
        /module_name/,
      );

      assert.throws(
        () =>
          parseSpecDraft({
            ...validDraftPayload,
            requirements: [{ id: "NOT-A-REQ-ID", kind: "behavior", statement: "Test", source_refs: ["file.js:L1"] }],
          }),
        /requirements/,
      );
    });
  });

  describe("Robust Error Handling", () => {
    it("handles model refusals by falling back to refusal_fallback role", async () => {
      const savedPrimary = process.env[roleEnvVar("spec_writer")];
      const savedFallback = process.env[roleEnvVar("refusal_fallback")];
      process.env[roleEnvVar("spec_writer")] = "anthropic.claude-opus-5-5";
      process.env[roleEnvVar("refusal_fallback")] = "anthropic.claude-opus-4-8";
      try {
        const requests = fakeClaude([
          { stop_reason: "refusal", category: "cyber", explanation: "Disallowed content" },
          { text: '{"answer":391}' },
        ]);

        const result = await structuredCall(sampleCalcOpts());
        assert.equal(requests.length, 2);
        assert.equal(requests[0].model, "anthropic.claude-opus-5-5");
        assert.equal(requests[1].model, "anthropic.claude-opus-4-8");
        assert.equal(result.model, "anthropic.claude-opus-4-8");
      } finally {
        if (savedPrimary !== undefined) process.env[roleEnvVar("spec_writer")] = savedPrimary;
        else delete process.env[roleEnvVar("spec_writer")];
        if (savedFallback !== undefined) process.env[roleEnvVar("refusal_fallback")] = savedFallback;
        else delete process.env[roleEnvVar("refusal_fallback")];
      }
    });

    it("throws LlmRefusalError when primary and fallback models both refuse", async () => {
      const savedPrimary = process.env[roleEnvVar("spec_writer")];
      const savedFallback = process.env[roleEnvVar("refusal_fallback")];
      process.env[roleEnvVar("spec_writer")] = "anthropic.claude-opus-5-5";
      process.env[roleEnvVar("refusal_fallback")] = "anthropic.claude-opus-4-8";
      try {
        fakeClaude([
          { stop_reason: "refusal", category: "cyber" },
          { stop_reason: "refusal", category: "cyber" },
        ]);

        await assert.rejects(
          structuredCall(sampleCalcOpts()),
          (err: unknown) => err instanceof LlmRefusalError && err.category === "cyber",
        );
      } finally {
        if (savedPrimary !== undefined) process.env[roleEnvVar("spec_writer")] = savedPrimary;
        else delete process.env[roleEnvVar("spec_writer")];
        if (savedFallback !== undefined) process.env[roleEnvVar("refusal_fallback")] = savedFallback;
        else delete process.env[roleEnvVar("refusal_fallback")];
      }
    });

    it("throws LlmTruncatedError when output hits max_tokens", async () => {
      fakeClaude([{ text: '{"ans', stop_reason: "max_tokens" }]);
      await assert.rejects(structuredCall(sampleCalcOpts()), LlmTruncatedError);
    });

    it("throws LlmSchemaError on malformed JSON or failed Zod validation", async () => {
      fakeClaude([{ text: "not-json-content" }]);
      await assert.rejects(
        structuredCall(sampleCalcOpts()),
        (err: unknown) => err instanceof LlmSchemaError && err.raw === "not-json-content",
      );

      fakeClaude([{ text: '{"answer": "not-a-number"}' }]);
      await assert.rejects(
        structuredCall(sampleCalcOpts()),
        (err: unknown) => err instanceof LlmSchemaError && err.message.includes("failed validation"),
      );
    });

    it("handles AbortSignal cancellation explicitly", async () => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(structuredCall(sampleCalcOpts({ signal: controller.signal })));
    });
  });

  describe("Secret Safety and Error Sanitization", () => {
    it("sanitizes AWS access keys and tokens from strings", () => {
      const leaked = "Failed to authenticate with AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE using sk-ant-api03-abcdef123456";
      const sanitized = sanitizeSecrets(leaked);

      assert.equal(sanitized.includes("AKIAIOSFODNN7EXAMPLE"), false);
      assert.equal(sanitized.includes("ASIAIOSFODNN7EXAMPLE"), false);
      assert.equal(sanitized.includes("sk-ant-api03"), false);
      assert.ok(sanitized.includes("[REDACTED_AWS_KEY]"));
      assert.ok(sanitized.includes("[REDACTED_AWS_SESSION_KEY]"));
      assert.ok(sanitized.includes("[REDACTED_API_KEY]"));
    });

    it("formats known AWS Bedrock service errors safely with formatLlmError", () => {
      const throttling = new Error("Rate exceeded for operation InvokeModel");
      throttling.name = "ThrottlingException";
      assert.match(formatLlmError(throttling), /Bedrock request throttled/);

      const accessDenied = new Error("User arn:aws:iam::123:user/test is not authorized to perform: bedrock:InvokeModel");
      accessDenied.name = "AccessDeniedException";
      assert.match(formatLlmError(accessDenied), /Bedrock access denied/);

      const expired = new Error("The security token included in the request is expired");
      expired.name = "ExpiredTokenException";
      assert.match(formatLlmError(expired), /AWS session token expired/);

      const serviceErr = new LlmServiceError("Model resource not found", { code: "ResourceNotFoundException" });
      assert.match(formatLlmError(serviceErr), /LLM Service Error/);
    });
  });

  describe("Tool Loop Helper", () => {
    it("executes tools and accumulates tool results into a single turn", async () => {
      const savedEnv = process.env[roleEnvVar("spec_writer")];
      process.env[roleEnvVar("spec_writer")] = "anthropic.claude-opus-5-5";
      try {
        let callCount = 0;
        const fakeClient: ClaudeClient = {
          messages: {
            stream(params: any) {
              callCount++;
              const msg =
                callCount === 1
                  ? {
                      id: "msg_tool",
                      type: "message",
                      role: "assistant",
                      content: [
                        {
                          type: "tool_use",
                          id: "tool_1",
                          name: "add",
                          input: { a: 20, b: 22 },
                        },
                      ],
                      model: params.model,
                      stop_reason: "tool_use",
                      usage: { input_tokens: 5, output_tokens: 10 },
                    }
                  : {
                      id: "msg_final",
                      type: "message",
                      role: "assistant",
                      content: [{ type: "text", text: "The answer is 42", citations: null }],
                      model: params.model,
                      stop_reason: "end_turn",
                      usage: { input_tokens: 10, output_tokens: 5 },
                    };

              return {
                on: () => {},
                async finalMessage() {
                  return msg;
                },
              } as any;
            },
          } as any,
        };
        setClaudeClientForTests(fakeClient);

        const finalMsg = await toolLoop({
          role: "spec_writer",
          system: "You are a calculator assistant.",
          user: "What is 20 + 22?",
          tools: [
            {
              name: "add",
              description: "Add two numbers",
              input_schema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
              },
            },
          ],
          run: async (name, input) => {
            const { a, b } = input as { a: number; b: number };
            return JSON.stringify({ result: a + b });
          },
        });

        assert.equal(finalMsg.stop_reason, "end_turn");
        assert.equal(finalMsg.content[0].type, "text");
        assert.equal((finalMsg.content[0] as any).text, "The answer is 42");
        assert.equal(callCount, 2);
      } finally {
        if (savedEnv !== undefined) process.env[roleEnvVar("spec_writer")] = savedEnv;
        else delete process.env[roleEnvVar("spec_writer")];
      }
    });
  });

  describe("Optional Live Bedrock Integration Path", () => {
    it("runs live Bedrock call only when TEST_LIVE_BEDROCK=1 is set", async () => {
      if (process.env.TEST_LIVE_BEDROCK !== "1") {
        // Deterministic skip path when live AWS credentials or flag are not present
        assert.ok(true, "Skipping live Bedrock test: TEST_LIVE_BEDROCK=1 not set");
        return;
      }

      // Live path: invokes actual configured Bedrock endpoint
      const result = await structuredCall(sampleCalcOpts());
      assert.deepEqual(result.value, { answer: 391 });
      assert.ok(result.model.length > 0);
    });
  });
});
