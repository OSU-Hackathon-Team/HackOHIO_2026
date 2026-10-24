// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/02_llm_client.md §4 (ship to Eng 3 by H4)
// Implemented by Eng 3 to unblock Step 3, following the spec; shared by Steps 2 and 3.
// Every Claude call in Splice goes through this file (Amazon Bedrock, Mantle Messages-API client).
// Implementation notes: (1) reads AWS_REGION / LLM_DEBUG from packages/backend/.env directly until
// Eng 1's config.ts exists (then switch to config.awsRegion / config.llmDebug); (2) the client is
// created on first use, so the server boots without AWS credentials.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { bedrockModelId, type SpliceRole } from "../models.js";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(BACKEND_DIR, ".env") });
const llmDebug = () => process.env.LLM_DEBUG === "1" || process.env.LLM_DEBUG === "true";

/** The subset of the Mantle client this module uses (lets tests substitute a double). */
export type ClaudeClient = Pick<AnthropicBedrockMantle, "messages">;

let client: ClaudeClient | null = null;

/** Bedrock Messages-API client. Credentials: default AWS chain (env / profile / SSO) or AWS_BEARER_TOKEN_BEDROCK. */
export function claude(): ClaudeClient {
  client ??= new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION });
  return client;
}

/** Tests only: replace the client (pass null to restore the real one on next use). */
export function setClaudeClientForTests(c: ClaudeClient | null) {
  client = c;
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
  /** JSON Schema for output_config.format. Objects need additionalProperties:false + required. */
  schema: Record<string, unknown>;
  /** Zod (or any) validation of the parsed JSON → typed value. Throw to reject. */
  parse: (value: unknown) => T;
  effort?: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called at most every 400ms with the number of output characters so far. */
  onProgress?: (outputChars: number) => void;
}

export interface StructuredResult<T> {
  value: T;
  /** Append this when continuing the conversation (repair loops). */
  assistantContent: Anthropic.ContentBlock[];
  usage: Anthropic.Usage;
  /** The model that actually answered (the refusal_fallback model if the fallback ran). */
  model: string;
}

const DEFAULT_MAX_TOKENS = 32_000;

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
  let chars = 0;
  let lastEmit = 0;
  stream.on("text", (delta) => {
    chars += delta.length;
    const now = Date.now();
    if (o.onProgress && now - lastEmit > 400) {
      lastEmit = now;
      o.onProgress(chars);
    }
  });
  const msg = await stream.finalMessage();
  o.onProgress?.(chars);
  return msg;
}

export async function structuredCall<T>(o: StructuredCallOpts<T>): Promise<StructuredResult<T>> {
  const primary = bedrockModelId(o.role);
  let msg = await streamOnce(primary, o);

  // Bedrock has no server-side fallbacks: retry a refusal once on the refusal_fallback role.
  // (Earlier thinking blocks from the primary model are dropped by the API, unbilled.)
  if (msg.stop_reason === "refusal") {
    const fallback = bedrockModelId("refusal_fallback");
    console.warn(`[llm] ${primary} declined (${msg.stop_details?.category ?? "unknown"}); retrying on ${fallback}`);
    msg = await streamOnce(fallback, o);
  }
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

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmSchemaError("Model output was not valid JSON", raw);
  }
  let value: T;
  try {
    value = o.parse(json);
  } catch (e) {
    throw new LlmSchemaError(`Model JSON failed validation: ${(e as Error).message}`, raw);
  }

  if (llmDebug()) {
    const u = msg.usage;
    console.log(`[llm] ${msg.model} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`);
  }
  return { value, assistantContent: msg.content, usage: msg.usage, model: msg.model };
}

/** Repair loops: conversation so far + the model's last answer (unchanged) + new user feedback. */
export function continueWith(
  messages: Anthropic.MessageParam[],
  assistantContent: Anthropic.ContentBlock[],
  feedback: string,
): Anthropic.MessageParam[] {
  return [...messages, { role: "assistant", content: assistantContent }, { role: "user", content: feedback }];
}
