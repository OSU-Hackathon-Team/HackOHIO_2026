// Owner: Eng 3 (Implementation) — dependency ports for Step 3.
// Mirror the spec'd signatures of the shared helpers so Step 3 can be tested with doubles:
// structuredCall/continueWith (agents/2_requirements_extraction/02_llm_client.md §4) and
// runTests (04_sandbox_runner.md §3). llm.test.ts checks the real llm.ts satisfies LlmPort.
import type Anthropic from "@anthropic-ai/sdk";
import type { TestCaseResult } from "@splice/contracts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ChatMessage = Anthropic.MessageParam;

export interface StructuredCallOpts<T> {
  role: "spec_writer" | "engine_writer" | "ui_synthesizer";
  system: string;
  messages: ChatMessage[];
  schema: Record<string, unknown>;
  parse: (value: unknown) => T;
  effort?: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
  onProgress?: (outputChars: number) => void;
  /** Helper tools the model may call before answering (llm.ts Converse path). */
  tools?: AssistTool[];
  maxToolTurns?: number;
}

export interface AssistTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown): Promise<string>;
}

export interface StructuredResult<T> {
  value: T;
  /** Appended unchanged when continuing the conversation (repair loops). */
  assistantContent: Anthropic.ContentBlock[];
  /** The model that actually answered (the refusal_fallback model if the fallback ran). */
  model: string;
}

export interface LlmPort {
  structuredCall<T>(o: StructuredCallOpts<T>): Promise<StructuredResult<T>>;
  continueWith(messages: ChatMessage[], assistantContent: Anthropic.ContentBlock[], feedback: string): ChatMessage[];
}

export interface RunTestsInput {
  kind: "oracle" | "acceptance";
  subject: { code: string; lang: "js" | "ts" };
  tests: string;
  perTestTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface RunTestsResult {
  fatal: string | null;
  tests: TestCaseResult[];
  passed: number;
  total: number;
  duration_ms: number;
}

export interface SandboxPort {
  runTests(input: RunTestsInput): Promise<RunTestsResult>;
}
