import { structuredCall } from "../llm/llm.js";

// Both source-tree and native specifications use the same configured spec writer.
export function writeDraft<T>(args: {
  system: string;
  messages: Parameters<typeof structuredCall>[0]["messages"];
  schema: Parameters<typeof structuredCall>[0]["schema"];
  parse: (value: unknown) => T;
  signal?: AbortSignal;
  maxTokens?: number;
  onProgress?: (chars: number) => void;
}) {
  return structuredCall({
    role: "spec_writer",
    system: args.system,
    messages: args.messages,
    schema: args.schema,
    parse: args.parse,
    effort: "high",
    maxTokens: args.maxTokens ?? 32_000,
    signal: args.signal,
    onProgress: args.onProgress,
  });
}
