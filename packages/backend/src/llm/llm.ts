// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/02_llm_client.md §4 (ship to Eng 3 by H4)
// Implemented by Eng 3 to unblock Step 3, following the spec; shared by Steps 2 and 3.
// Every model call in Splice goes through this file (Amazon Bedrock).
// Implementation notes:
// (1) Each role resolves through models.json (spliceModel): Claude models use the Anthropic Messages API
//     (Mantle client, as specified); non-Claude models marked splice_compatible (e.g. Qwen3 Coder) use
//     the Bedrock Converse API, with a forced tool call standing in for structured outputs. Both paths
//     return the same StructuredResult, so callers and repair loops don't change.
// (2) Reads AWS_REGION / LLM_DEBUG from packages/backend/.env directly until Eng 1's config.ts exists.
// (3) Clients are created on first use, so the server boots without AWS credentials.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import {
  BedrockRuntimeClient, ConverseStreamCommand,
  type ConverseStreamCommandOutput, type Message as ConverseMessage,
} from "@aws-sdk/client-bedrock-runtime";
import { spliceModel, type SpliceRole } from "../models.js";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(BACKEND_DIR, ".env") });
const llmDebug = () => process.env.LLM_DEBUG === "1" || process.env.LLM_DEBUG === "true";

/** The subset of the Mantle client this module uses (lets tests substitute a double). */
export type ClaudeClient = Pick<AnthropicBedrockMantle, "messages">;
/** The subset of the Bedrock runtime client this module uses. */
export interface ConverseClient {
  send(command: ConverseStreamCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseStreamCommandOutput>;
}

let client: ClaudeClient | null = null;
let converseClientInstance: ConverseClient | null = null;

/** Bedrock Messages-API client. Credentials: default AWS chain (env / profile / SSO) or AWS_BEARER_TOKEN_BEDROCK. */
export function claude(): ClaudeClient {
  client ??= new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION });
  return client;
}

/** Bedrock Converse client for non-Claude models. Credentials: default AWS chain. */
export function converseClient(): ConverseClient {
  converseClientInstance ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION });
  return converseClientInstance;
}

/** Tests only: replace the clients (pass null to restore the real ones on next use). */
export function setClaudeClientForTests(c: ClaudeClient | null) {
  client = c;
}
export function setConverseClientForTests(c: ConverseClient | null) {
  converseClientInstance = c;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class LlmRefusalError extends Error {
  constructor(public category: string | null, explanation: string | null) {
    super(`Model declined the request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`);
    this.name = "LlmRefusalError";
  }
}
export class LlmTruncatedError extends Error {
  name = "LlmTruncatedError";
}
export class LlmSchemaError extends Error {
  constructor(message: string, public raw: string) {
    super(message);
    this.name = "LlmSchemaError";
  }
}

export interface StructuredCallOpts<T> {
  /** Which models.json role answers: spec_writer | engine_writer | ui_synthesizer */
  role: Exclude<SpliceRole, "refusal_fallback">;
  system: string;
  messages: Anthropic.MessageParam[];
  /** JSON Schema for the output. Objects need additionalProperties:false + required. */
  schema: Record<string, unknown>;
  /** Zod (or any) validation of the parsed JSON → typed value. Throw to reject. */
  parse: (value: unknown) => T;
  /** Thinking depth on Claude models; ignored on the Converse path. */
  effort?: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called at most every 400ms with the number of output characters so far. */
  onProgress?: (outputChars: number) => void;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
}

export interface StructuredResult<T> {
  value: T;
  /** Append this when continuing the conversation (repair loops). */
  assistantContent: Anthropic.ContentBlock[];
  usage: LlmUsage;
  /** The model that actually answered (the refusal_fallback model if the fallback ran). */
  model: string;
}

const DEFAULT_MAX_TOKENS = 32_000;
// Bedrock Qwen3 Coder supports 16K output tokens. See the AWS model card linked in the LLM spec.
export const CONVERSE_MAX_TOKENS = 16_384;

function progressReporter(onProgress?: (n: number) => void) {
  let chars = 0;
  let lastEmit = 0;
  return {
    add(delta: string) {
      chars += delta.length;
      const now = Date.now();
      if (onProgress && now - lastEmit > 400) {
        lastEmit = now;
        onProgress(chars);
      }
    },
    done() {
      onProgress?.(chars);
    },
  };
}

function parseOutput<T>(raw: string, parse: (v: unknown) => T): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmSchemaError("Model output was not valid JSON", raw);
  }
  try {
    return parse(json);
  } catch (e) {
    throw new LlmSchemaError(`Model JSON failed validation: ${(e as Error).message}`, raw);
  }
}

// ---- Anthropic Messages API (Claude) ----

async function streamOnce(model: string, o: StructuredCallOpts<unknown>): Promise<Anthropic.Message> {
  const stream = claude().messages.stream(
    {
      model,
      max_tokens: o.maxTokens ?? DEFAULT_MAX_TOKENS,
      // No `thinking` param: Opus 5.5 always thinks adaptively; depth is set by effort (default medium).
      output_config: {
        effort: o.effort ?? "high",
        format: { type: "json_schema", schema: o.schema },
      },
      system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
      messages: o.messages,
    },
    { signal: o.signal },
  );
  const progress = progressReporter(o.onProgress);
  stream.on("text", (delta) => progress.add(delta));
  const msg = await stream.finalMessage();
  progress.done();
  return msg;
}

async function anthropicCall<T>(primary: string, o: StructuredCallOpts<T>): Promise<StructuredResult<T>> {
  const msg = await streamOnce(primary, o);
  if (msg.stop_reason === "refusal") {
    throw new LlmRefusalError(msg.stop_details?.category ?? null, msg.stop_details?.explanation ?? null);
  }
  if (msg.stop_reason === "max_tokens") {
    throw new LlmTruncatedError(`Output hit max_tokens (${o.maxTokens ?? DEFAULT_MAX_TOKENS}); raise maxTokens or shrink the request`);
  }

  const raw = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const value = parseOutput(raw, o.parse);
  if (llmDebug()) {
    const u = msg.usage;
    console.log(`[llm] ${msg.model} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`);
  }
  return { value, assistantContent: msg.content, usage: msg.usage, model: msg.model };
}

// ---- Bedrock Converse API (non-Claude models) ----

const RESPOND_TOOL = "respond";

/** Our conversations only carry text (prompts, feedback, earlier JSON answers). */
function toConverseMessages(messages: Anthropic.MessageParam[]): ConverseMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string"
      ? [{ text: m.content }]
      : m.content.map((b) => {
        if (b.type !== "text") throw new Error(`The Converse path only sends text content, got a "${b.type}" block`);
        return { text: b.text };
      }),
  }));
}

async function converseCall<T>(modelId: string, o: StructuredCallOpts<T>): Promise<StructuredResult<T>> {
  const maxTokens = Math.min(o.maxTokens ?? DEFAULT_MAX_TOKENS, CONVERSE_MAX_TOKENS);
  const res = await converseClient().send(
    new ConverseStreamCommand({
      modelId,
      system: [{ text: `${o.system}\n\nSubmit your response by calling the "${RESPOND_TOOL}" tool. Its input is the JSON object described above.` }],
      messages: toConverseMessages(o.messages),
      inferenceConfig: { maxTokens },
      toolConfig: {
        tools: [{
          toolSpec: {
            name: RESPOND_TOOL,
            description: "Submit the response as a JSON object matching the schema.",
            inputSchema: { json: o.schema as Record<string, never> },
          },
        }],
        // Forcing the tool is how Converse guarantees schema-shaped JSON (no output_config here).
        toolChoice: { tool: { name: RESPOND_TOOL } },
      },
    }),
    { abortSignal: o.signal },
  );

  const progress = progressReporter(o.onProgress);
  let toolInput = "";
  let text = "";
  let stopReason: string | undefined;
  const usage: LlmUsage = { input_tokens: 0, output_tokens: 0 };
  for await (const ev of res.stream ?? []) {
    const failure = ev.internalServerException ?? ev.modelStreamErrorException ?? ev.throttlingException
      ?? ev.serviceUnavailableException ?? ev.validationException;
    if (failure) throw failure;
    const delta = ev.contentBlockDelta?.delta;
    if (delta?.toolUse?.input) {
      toolInput += delta.toolUse.input;
      progress.add(delta.toolUse.input);
    } else if (delta?.text) {
      text += delta.text;
      progress.add(delta.text);
    }
    if (ev.messageStop) stopReason = ev.messageStop.stopReason;
    if (ev.metadata?.usage) {
      usage.input_tokens = ev.metadata.usage.inputTokens ?? 0;
      usage.output_tokens = ev.metadata.usage.outputTokens ?? 0;
    }
  }
  progress.done();

  if (stopReason === "content_filtered" || stopReason === "guardrail_intervened") {
    throw new LlmRefusalError(stopReason, null);
  }
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
    throw new LlmTruncatedError(`Output stopped at ${stopReason} (maxTokens ${maxTokens}); raise maxTokens or shrink the request`);
  }

  const raw = toolInput || text;
  const value = parseOutput(raw, o.parse);
  if (llmDebug()) console.log(`[llm] ${modelId} (converse) in=${usage.input_tokens} out=${usage.output_tokens} stop=${stopReason}`);
  // Repair loops append this unchanged; it goes back to Converse as the assistant's text turn.
  return { value, assistantContent: [{ type: "text", text: raw, citations: null }], usage, model: modelId };
}

export async function structuredCall<T>(o: StructuredCallOpts<T>): Promise<StructuredResult<T>> {
  o.signal?.throwIfAborted();
  const primary = spliceModel(o.role);
  const call = (model: ReturnType<typeof spliceModel>) =>
    model.api === "converse" ? converseCall(model.id, o) : anthropicCall(model.id, o);
  try {
    return await call(primary);
  } catch (error) {
    if (!(error instanceof LlmRefusalError)) throw error;
    o.signal?.throwIfAborted();
    const fallback = spliceModel("refusal_fallback");
    if (fallback.id === primary.id && fallback.api === primary.api) throw error;
    return call(fallback);
  }
}

/** Repair loops: conversation so far + the model's last answer (unchanged) + new user feedback. */
export function continueWith(
  messages: Anthropic.MessageParam[],
  assistantContent: Anthropic.ContentBlock[],
  feedback: string,
): Anthropic.MessageParam[] {
  return [...messages, { role: "assistant", content: assistantContent }, { role: "user", content: feedback }];
}
