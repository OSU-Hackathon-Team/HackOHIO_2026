# 02 — Shared LLM Client on Amazon Bedrock (`llm/llm.ts`) — ship to Eng 3 by H4

Every Claude call in Splice goes through this file: specs (Eng 2), engines, UI synthesis and
refine (Eng 3). It's the one place for the Bedrock client, model ID, structured output,
streaming progress, refusal handling and prompt caching.

**We call Claude through Amazon Bedrock.** No Anthropic API key is used anywhere.

## 1. Install & credentials

```bash
npm install -w @splice/backend @anthropic-ai/sdk @anthropic-ai/bedrock-sdk
```

We use the **Mantle** client (`AnthropicBedrockMantle`), which is Bedrock's Messages-API
endpoint. It exposes the same `messages.create` / `messages.stream` surface as the first-party SDK.
(The older `AnthropicBedrock` class is the legacy InvokeModel path. Don't use it.)

Credentials come from the **standard AWS credential chain**: env vars, `~/.aws/credentials`
profile, or SSO. Put them in `packages/backend/.env` (gitignored) **or**, better, use a named
profile:

```bash
# packages/backend/.env
AWS_REGION=us-east-2                 # the region where your account has Claude model access
AWS_PROFILE=splice                   # preferred: profile in ~/.aws/credentials or SSO
# or, temporary session creds from your AWS portal (they expire — refresh when calls start 403-ing):
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AWS_SESSION_TOKEN=...
SPLICE_MODEL=anthropic.claude-opus-5-5
SPLICE_FALLBACK_MODEL=anthropic.claude-opus-4-8
```

> ⚠️ The AWS keys that were committed in `.env` (`83f811b`) are almost certainly these Bedrock
> credentials. Revoke them before anything else (see `../README.md` §5). Temporary
> `ASIA…` session credentials expire after a few hours, so expect to paste fresh ones during
> the event. Keep them out of git.

**H0 checks (Eng 2, with whoever owns the AWS account):**
1. In the Bedrock console for `AWS_REGION`, model access is **enabled** for Claude Opus 5.5
   (and the fallback model).
2. `npm run test:llm` (§6) prints an answer. If you get `AccessDeniedException`, the model isn't
   enabled or the IAM principal lacks `bedrock:InvokeModel*` permissions.
3. Confirm the exact model IDs your account accepts. Bedrock IDs take an `anthropic.` prefix
   (`anthropic.claude-opus-5-5`). If the console shows a cross-region inference profile ID instead
   (for example a `us.`-prefixed one), put that ID in `SPLICE_MODEL`.

## 2. Decisions (and why)

| Decision | Why |
|---|---|
| `AnthropicBedrockMantle` client, region from `AWS_REGION` | Bedrock's Messages-API endpoint. Same request shapes as the first-party SDK |
| Model `anthropic.claude-opus-5-5` via `SPLICE_MODEL` | Current default Opus, with the Bedrock prefix. One place to change it |
| **Structured outputs** (`output_config.format: { type: "json_schema", schema }`) | Supported on Bedrock. Guarantees parseable JSON. Forced `tool_choice` returns a 400 on Opus 5.5, and assistant prefill is gone |
| **Streaming** + `finalMessage()` | Long outputs (full TS files) would otherwise risk HTTP timeouts. Also gives us `output_chars` progress for the UI |
| **No `thinking` param** | Opus 5.5 always uses adaptive thinking; `disabled` / `budget_tokens` return a 400. Depth is set with `output_config.effort` |
| Effort: spec `high`, engine `high`, UI synthesis `medium`, refine `medium` | Opus 5.5 defaults to `medium`, so set it explicitly |
| **Client-side refusal fallback** (retry once on `SPLICE_FALLBACK_MODEL`) | Bedrock has **no** server-side `fallbacks` parameter. "Reverse engineering" wording can trip the `cyber` safety classifier, so on `stop_reason: "refusal"` we re-issue the same request on the fallback model ourselves |
| `cache_control` on the system prompt | Supported on Bedrock. The system prompt is identical across calls, so it's cheaper and faster from the 2nd call on |
| Append-only conversations for repair | Repairs push the assistant's full `content` back unchanged, then add a user turn. Never edit earlier turns |

> Prompt wording tip for Eng 2 and Eng 3: describe the task as *analyzing our own demo apps'
> source to write specifications and tests*. That's accurate (we own the targets), and it doesn't
> read like a request to break someone else's software. This prevents most refusals in the
> first place.

## 3. Config (already in Eng 1's `config.ts`, see `1_reverse_engineering/06_backend_server_shell.md` §2)

`llm.ts` reads `config.awsRegion`, `config.model`, `config.fallbackModel` and `config.llmDebug`.
There is no API-key setting. The AWS SDK finds credentials through the default chain and
reports missing or expired ones on the first call.

## 4. `src/llm/llm.ts`

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { config } from "../config.js";

// Bedrock Messages-API client. Credentials: default AWS chain (env / profile / SSO).
export const claude = new AnthropicBedrockMantle({ awsRegion: config.awsRegion });

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class LlmRefusalError extends Error {
  constructor(public category: string | null, explanation: string | null) {
    super(`Model declined the request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`);
  }
}
export class LlmTruncatedError extends Error {}
export class LlmSchemaError extends Error {
  constructor(message: string, public raw: string) { super(message); }
}

export interface StructuredCallOpts<T> {
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
  /** The model that actually answered (differs from config.model if the fallback ran). */
  model: string;
}

async function streamOnce(model: string, o: StructuredCallOpts<unknown>): Promise<Anthropic.Message> {
  const stream = claude.messages.stream(
    {
      model,
      max_tokens: o.maxTokens ?? 32_000,
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
  let msg = await streamOnce(config.model, o);

  // Bedrock has no server-side fallbacks: retry a refusal once on the fallback model.
  // (Earlier thinking blocks from the primary model are dropped by the API, unbilled.)
  if (msg.stop_reason === "refusal" && config.fallbackModel) {
    const d = (msg as any).stop_details ?? null;
    console.warn(`[llm] ${config.model} declined (${d?.category ?? "unknown"}); retrying on ${config.fallbackModel}`);
    msg = await streamOnce(config.fallbackModel, o);
  }
  if (msg.stop_reason === "refusal") {
    const d = (msg as any).stop_details ?? null;
    throw new LlmRefusalError(d?.category ?? null, d?.explanation ?? null);
  }
  if (msg.stop_reason === "max_tokens") {
    throw new LlmTruncatedError(`Output hit max_tokens (${o.maxTokens ?? 32_000}); raise maxTokens or shrink the request`);
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

  if (config.llmDebug) {
    const u = msg.usage as any;
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
```

Notes:
- Store `result.model` in `provenance.model` / `verification.model`. If the fallback answered,
  the card says so. That's honest provenance.
- `LlmSchemaError` is rare with structured outputs, but our Zod checks are stricter than JSON
  Schema (regexes, cross-field rules). Treat it like any repair: `continueWith(..., "Your JSON failed validation: …")`.
- Don't catch AWS or SDK errors here. Let the route report them as an `error` event. The
  common ones: `AccessDeniedException` (model not enabled / IAM), `ExpiredTokenException`
  (refresh session creds), `ThrottlingException` (SDK retries twice, then surfaces it).
- If you want the SDK's own refusal middleware instead of our retry, copy its usage from the SDK
  repo's `examples/` folder. Don't improvise the import, and confirm it works with the Mantle
  client first. The manual retry above is enough for the hackathon.

## 5. Manual tool-use loop helper (only for Eng 1's agentic stretch mode)

```ts
export async function toolLoop(o: {
  system: string;
  user: string;
  tools: Anthropic.Tool[];
  run: (name: string, input: unknown) => Promise<string>; // returns tool_result text
  maxIterations?: number;
  signal?: AbortSignal;
}): Promise<Anthropic.Message> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.user }];
  for (let i = 0; i < (o.maxIterations ?? 8); i++) {
    const msg = await claude.messages
      .stream(
        {
          model: config.model,
          max_tokens: 16_000,
          output_config: { effort: "medium" },
          system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
          tools: o.tools,
          messages,
        },
        { signal: o.signal },
      )
      .finalMessage();
    if (msg.stop_reason === "refusal") throw new LlmRefusalError((msg as any).stop_details?.category ?? null, null);
    if (msg.stop_reason !== "tool_use") return msg;
    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of msg.content) {
      if (b.type !== "tool_use") continue;
      try {
        results.push({ type: "tool_result", tool_use_id: b.id, content: await o.run(b.name, b.input) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: b.id, content: (e as Error).message, is_error: true });
      }
    }
    messages.push({ role: "user", content: results }); // all results in ONE user message
  }
  throw new Error("tool loop hit max iterations");
}
```

## 6. Smoke test — `src/scripts/testLlm.ts` (`npm run test:llm`)

```ts
import { z } from "zod";
import { structuredCall } from "../llm/llm.js";

const Out = z.object({ answer: z.number() });
const r = await structuredCall({
  system: "You are a calculator. Reply only with the JSON requested.",
  messages: [{ role: "user", content: "What is 17 * 23?" }],
  schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
  parse: (v) => Out.parse(v),
  effort: "low",
  maxTokens: 2000,
  onProgress: (n) => process.stdout.write(`\r${n} chars`),
});
console.log("\n", r.value, "served by", r.model);
```

This must pass on every teammate's machine at H4. If it fails on one machine only, it's almost
always that machine's AWS credentials or region.
