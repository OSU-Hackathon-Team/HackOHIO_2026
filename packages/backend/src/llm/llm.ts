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
// (4) On Converse, `tools` turns the call into a short loop: the model may call helper tools (e.g. load_skills)
//     for up to maxToolTurns, then `respond` is forced, so the result is still one schema-checked JSON value.
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
  client ??= new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION || "us-east-2" });
  return client;
}

/** Bedrock Converse client for non-Claude models. Credentials: default AWS chain. */
export function converseClient(): ConverseClient {
  converseClientInstance ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-2" });
  return converseClientInstance;
}

/** Tests only: replace the clients (pass null to restore the real ones on next use). */
export function setClaudeClientForTests(c: ClaudeClient | null) {
  client = c;
}
export function setConverseClientForTests(c: ConverseClient | null) {
  converseClientInstance = c;
}
export const setClaudeClient = setClaudeClientForTests;
export const setConverseClient = setConverseClientForTests;

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

export class LlmServiceError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(message: string, options?: { code?: string; status?: number; cause?: unknown }) {
    super(sanitizeSecrets(message));
    this.name = "LlmServiceError";
    this.code = options?.code;
    this.status = options?.status;
    if (options?.cause) this.cause = options.cause;
  }
}

/**
 * Strips AWS credentials, session tokens, and API keys from error messages or logs.
 */
export function sanitizeSecrets(text: string): string {
  if (!text) return text;
  return text
    // AWS Access Key ID
    .replace(/(AKIA[0-9A-Z]{16})/g, "[REDACTED_AWS_KEY]")
    // AWS Secret Access Key (look for typical key patterns)
    .replace(/(aws_secret_access_key\s*[:=]\s*)[A-Za-z0-9/+=]{40}/gi, "$1[REDACTED]")
    // AWS Session Token
    .replace(/(ASIA[0-9A-Z]{16})/g, "[REDACTED_AWS_SESSION_KEY]")
    // Bearer tokens
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]")
    // Anthropic API keys
    .replace(/(sk-ant-[A-Za-z0-9\-._~+/]+)/gi, "[REDACTED_API_KEY]");
}

/**
 * Formats LLM errors into safe, informative error strings without leaking secrets.
 */
export function formatLlmError(error: unknown): string {
  if (!error) return "Unknown LLM error";
  if (error instanceof LlmRefusalError) {
    return error.message;
  }
  if (error instanceof LlmTruncatedError) {
    return error.message;
  }
  if (error instanceof LlmSchemaError) {
    return `${error.message} (output: ${error.raw.slice(0, 120)}${error.raw.length > 120 ? "..." : ""})`;
  }
  if (error instanceof LlmServiceError) {
    return `LLM Service Error (${error.code ?? "unknown"}): ${error.message}`;
  }
  if (error instanceof Error) {
    const name = error.name || "Error";
    const msg = sanitizeSecrets(error.message);
    if (name === "AbortError" || msg.includes("aborted")) {
      return "Request was aborted or timed out";
    }
    if (name === "ThrottlingException" || msg.includes("throttled") || msg.includes("rate limit")) {
      return `Bedrock request throttled: ${msg}`;
    }
    if (name === "AccessDeniedException" || msg.includes("AccessDenied")) {
      return `Bedrock access denied: check IAM permissions and model access in AWS region (${msg})`;
    }
    if (name === "ExpiredTokenException" || msg.includes("token has expired")) {
      return `AWS session token expired: refresh credentials (${msg})`;
    }
    return `${name}: ${msg}`;
  }
  return sanitizeSecrets(String(error));
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
  /**
   * Tools the model may call before it submits the answer (Converse path only). Results go back to the model;
   * the call still ends with the schema-shaped `respond` tool, forced once maxToolTurns are used.
   */
  tools?: AssistTool[];
  /** Model turns allowed to call `tools` before `respond` is forced. Default 4. */
  maxToolTurns?: number;
}

/** A read-only helper the model can call mid-answer, e.g. to load a skill. */
export interface AssistTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input (objects need additionalProperties:false + required). */
  inputSchema: Record<string, unknown>;
  /** Returns the text sent back to the model. A thrown error is reported to the model as a failed tool call. */
  run(input: unknown): Promise<string>;
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
  if (o.tools?.length) throw new Error("Tool-assisted structured calls are implemented on the Converse path only");
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

interface ConverseTurn {
  text: string;
  toolUses: { id: string; name: string; input: string }[];
  stopReason?: string;
}

/** One streamed model turn. Tool input without a contentBlockStart is the forced respond tool. */
async function converseTurn(
  modelId: string, o: StructuredCallOpts<unknown>, messages: ConverseMessage[], maxTokens: number,
  offerTools: boolean, usage: LlmUsage, progress: ReturnType<typeof progressReporter>,
): Promise<ConverseTurn> {
  const tools = o.tools ?? [];
  const system = tools.length
    ? `${o.system}\n\nYou may call the other tools first to gather what you need. Submit your final response by calling the "${RESPOND_TOOL}" tool. Its input is the JSON object described above.`
    : `${o.system}\n\nSubmit your response by calling the "${RESPOND_TOOL}" tool. Its input is the JSON object described above.`;
  const res = await converseClient().send(
    new ConverseStreamCommand({
      modelId,
      system: [{ text: system }],
      messages,
      inferenceConfig: { maxTokens },
      toolConfig: {
        // Every tool stays declared on every turn: Bedrock rejects toolUse/toolResult history without its spec.
        tools: [
          {
            toolSpec: {
              name: RESPOND_TOOL,
              description: "Submit the response as a JSON object matching the schema.",
              inputSchema: { json: o.schema as Record<string, never> },
            },
          },
          ...tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as Record<string, never> } } })),
        ],
        // Forcing respond is how Converse guarantees schema-shaped JSON (no output_config here).
        toolChoice: offerTools ? { auto: {} } : { tool: { name: RESPOND_TOOL } },
      },
    }),
    { abortSignal: o.signal },
  );

  const blocks = new Map<number, { text: string; tool?: { id: string; name: string; input: string } }>();
  const block = (i: number) => blocks.get(i) ?? blocks.set(i, { text: "" }).get(i)!;
  let stopReason: string | undefined;
  for await (const ev of res.stream ?? []) {
    const failure = ev.internalServerException ?? ev.modelStreamErrorException ?? ev.throttlingException
      ?? ev.serviceUnavailableException ?? ev.validationException;
    if (failure) throw failure;
    const start = ev.contentBlockStart;
    if (start?.start?.toolUse) {
      block(start.contentBlockIndex ?? 0).tool = { id: start.start.toolUse.toolUseId ?? "", name: start.start.toolUse.name ?? RESPOND_TOOL, input: "" };
    }
    const deltaEvent = ev.contentBlockDelta;
    const delta = deltaEvent?.delta;
    if (delta?.toolUse?.input) {
      const b = block(deltaEvent!.contentBlockIndex ?? 0);
      b.tool ??= { id: "", name: RESPOND_TOOL, input: "" };
      b.tool.input += delta.toolUse.input;
      progress.add(delta.toolUse.input);
    } else if (delta?.text) {
      block(deltaEvent!.contentBlockIndex ?? 0).text += delta.text;
      progress.add(delta.text);
    }
    if (ev.messageStop) stopReason = ev.messageStop.stopReason;
    if (ev.metadata?.usage) {
      usage.input_tokens += ev.metadata.usage.inputTokens ?? 0;
      usage.output_tokens += ev.metadata.usage.outputTokens ?? 0;
    }
  }
  const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
  return {
    text: ordered.map((b) => b.text).join(""),
    toolUses: ordered.flatMap((b) => (b.tool ? [b.tool] : [])),
    stopReason,
  };
}

function toolInputObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function converseCall<T>(modelId: string, o: StructuredCallOpts<T>): Promise<StructuredResult<T>> {
  const maxTokens = Math.min(o.maxTokens ?? DEFAULT_MAX_TOKENS, CONVERSE_MAX_TOKENS);
  const tools = o.tools ?? [];
  const maxToolTurns = tools.length ? (o.maxToolTurns ?? 4) : 0;
  const messages = toConverseMessages(o.messages);
  const progress = progressReporter(o.onProgress);
  const usage: LlmUsage = { input_tokens: 0, output_tokens: 0 };

  for (let turn = 0; ; turn++) {
    o.signal?.throwIfAborted();
    const t = await converseTurn(modelId, o as StructuredCallOpts<unknown>, messages, maxTokens, turn < maxToolTurns, usage, progress);
    if (t.stopReason === "content_filtered" || t.stopReason === "guardrail_intervened") {
      throw new LlmRefusalError(t.stopReason, null);
    }
    if (t.stopReason === "max_tokens" || t.stopReason === "model_context_window_exceeded") {
      throw new LlmTruncatedError(`Output stopped at ${t.stopReason} (maxTokens ${maxTokens}); raise maxTokens or shrink the request`);
    }

    const respond = t.toolUses.find((u) => u.name === RESPOND_TOOL);
    const helpers = t.toolUses.filter((u) => u.name !== RESPOND_TOOL);
    if (respond || !helpers.length) {
      progress.done();
      const raw = respond?.input || t.text;
      const value = parseOutput(raw, o.parse);
      if (llmDebug()) console.log(`[llm] ${modelId} (converse) turns=${turn + 1} in=${usage.input_tokens} out=${usage.output_tokens} stop=${t.stopReason}`);
      // Repair loops append this unchanged; it goes back to Converse as the assistant's text turn.
      return { value, assistantContent: [{ type: "text", text: raw, citations: null }], usage, model: modelId };
    }

    // The model asked for helper tools: record its turn, run them, and send every result back in one user turn.
    messages.push({
      role: "assistant",
      content: [
        ...(t.text ? [{ text: t.text }] : []),
        ...helpers.map((u) => ({ toolUse: { toolUseId: u.id, name: u.name, input: toolInputObject(u.input) as never } })),
      ],
    });
    const results = [];
    for (const u of helpers) {
      const tool = tools.find((x) => x.name === u.name);
      try {
        if (!tool) throw new Error(`Unknown tool "${u.name}". Available: ${tools.map((x) => x.name).join(", ")}, ${RESPOND_TOOL}`);
        results.push({ toolResult: { toolUseId: u.id, content: [{ text: await tool.run(toolInputObject(u.input)) }] } });
      } catch (e) {
        o.signal?.throwIfAborted();
        results.push({ toolResult: { toolUseId: u.id, content: [{ text: sanitizeSecrets((e as Error).message) }], status: "error" as const } });
      }
    }
    messages.push({ role: "user", content: results });
  }
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

/**
 * Manual tool-use loop helper (spec: agents/2_requirements_extraction/02_llm_client.md §5).
 */
export async function toolLoop(o: {
  role: Exclude<SpliceRole, "refusal_fallback">;
  system: string;
  user: string;
  tools: Anthropic.Tool[];
  run: (name: string, input: unknown) => Promise<string>; // returns tool_result text
  maxIterations?: number;
  signal?: AbortSignal;
}): Promise<Anthropic.Message> {
  const modelId = spliceModel(o.role).id;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.user }];
  for (let i = 0; i < (o.maxIterations ?? 8); i++) {
    const stream = claude().messages.stream(
      {
        model: modelId,
        max_tokens: 16_000,
        output_config: { effort: "medium" },
        system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
        tools: o.tools,
        messages,
      },
      { signal: o.signal },
    );
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      throw new LlmRefusalError((msg as any).stop_details?.category ?? null, null);
    }
    if (msg.stop_reason !== "tool_use") return msg;
    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of msg.content) {
      if (b.type !== "tool_use") continue;
      try {
        results.push({ type: "tool_result", tool_use_id: b.id, content: await o.run(b.name, b.input) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: b.id, content: sanitizeSecrets((e as Error).message), is_error: true });
      }
    }
    messages.push({ role: "user", content: results }); // all results in ONE user message
  }
  throw new Error("tool loop hit max iterations");
}

