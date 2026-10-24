// Owner: Eng 3 (Implementation) — schema-valid fixtures for Step 3 unit tests (not development data).
import { FeatureBlueprint, FeatureSpec } from "@splice/contracts";
import type { ChatMessage, LlmPort, RunTestsInput, RunTestsResult, SandboxPort, StructuredCallOpts } from "./ports.js";

/** Planted where Step 3 must never look. Any prompt containing them is a leak. */
export const SOURCE_SENTINEL = "SENTINEL_ORIGINAL_SOURCE_7f3a";
export const ADAPTER_SENTINEL = "SENTINEL_ADAPTER_CODE_91bc";

export const TYPES_CODE = `export declare const MIN_EASE: number;
export interface ReviewResult { ease: number; interval: number }
export declare function updateEase(ease: number, q: number): number;
export declare function review(ease: number, interval: number, q: number): ReviewResult;`;

export const GOOD_ENGINE = `export const MIN_EASE = 1.3;
export interface ReviewResult { ease: number; interval: number }

// REQ-1 REQ-2
export function updateEase(ease: number, q: number): number {
  if (!Number.isInteger(q) || q < 0 || q > 5) throw new RangeError("grade must be an integer 0-5");
  return Math.max(MIN_EASE, Math.round((ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))) * 100) / 100);
}

// REQ-3
export function review(ease: number, interval: number, q: number): ReviewResult {
  return { ease: updateEase(ease, q), interval: q < 3 ? 1 : Math.round(interval * ease) };
}
`;

export const ACCEPTANCE_TESTS = `test("REQ-1: perfect recall raises ease by 0.1", () => { assert.equal(updateEase(2.5, 5), 2.6); });
test("REQ-2: ease never drops below MIN_EASE", () => { assert.equal(updateEase(1.3, 0), MIN_EASE); });
test("REQ-3: a lapse resets the interval to 1", () => { assert.equal(review(2.5, 10, 2).interval, 1); });`;

export function makeSpec(overrides: Partial<FeatureSpec> = {}): FeatureSpec {
  const target = { path: "targets/build/recall/app.asar", artifact_type: "electron_asar" as const, sha256: "0".repeat(64) };
  return FeatureSpec.parse({
    schema_version: 1,
    feature_id: "recall.sm2_scheduler",
    app_id: "recall",
    source_app: "Recall Flashcards",
    source_icon: "Clock",
    artifact_type: "electron_asar",
    consumer_title: "SM-2 spaced repetition",
    consumer_description: "Schedules the next review of a card from a recall grade.",
    category: "scheduling",
    requirements: [
      { id: "REQ-1", kind: "behavior", statement: "Ease changes by 0.1 - (5-q)*(0.08+(5-q)*0.02), rounded to 2 decimals", source_refs: ["src/scheduler/sm2.js:L9-L12"] },
      { id: "REQ-2", kind: "invariant", statement: "Ease never drops below MIN_EASE (1.3)", source_refs: ["src/scheduler/sm2.js:L2-L2"] },
      { id: "REQ-3", kind: "behavior", statement: "A grade below 3 resets the interval to 1", source_refs: ["src/scheduler/sm2.js:L24-L27"] },
    ],
    interface: {
      module_name: "sm2Scheduler",
      exports: [
        { name: "MIN_EASE", kind: "const", signature: "number", description: "Lowest ease factor" },
        { name: "ReviewResult", kind: "type", signature: "{ ease: number; interval: number }", description: "Result of a review" },
        { name: "updateEase", kind: "function", signature: "(ease: number, q: number) => number", description: "Next ease factor" },
        { name: "review", kind: "function", signature: "(ease: number, interval: number, q: number) => ReviewResult", description: "Grades a card" },
      ],
      types_code: TYPES_CODE,
    },
    inputs: [{ name: "q", type: "number", description: "recall grade 0-5" }],
    outputs: [{ name: "result", type: "ReviewResult", description: "next ease and interval" }],
    acceptance_tests: ACCEPTANCE_TESTS,
    coverage: [
      { requirement_id: "REQ-1", test_names: ["REQ-1: perfect recall raises ease by 0.1"] },
      { requirement_id: "REQ-2", test_names: ["REQ-2: ease never drops below MIN_EASE"] },
      { requirement_id: "REQ-3", test_names: ["REQ-3: a lapse resets the interval to 1"] },
    ],
    allowed_deviations: ["clock is injected instead of Date.now()"],
    stripped_glue: ["ipcMain.handle('card:answer')"],
    oracle: { status: "passed", adapter_code: `module.exports = require("${ADAPTER_SENTINEL}");`, tests: [], passed: 3, total: 3 },
    status: "verified",
    open_issues: [],
    repair_attempts: 0,
    provenance: {
      mode: "replay",
      target,
      rea_package_version: "6.7.0",
      tool_calls: [],
      snippets: [{ location: "app.asar:src/scheduler/sm2.js", symbol: "scheduleReview", language: "javascript", code: `// ${SOURCE_SENTINEL}`, full_module: true }],
      limitations: [],
      unknowns: [],
      collected_at: "2026-10-24T00:00:00.000Z",
      specified_at: "2026-10-24T00:00:00.000Z",
      model: "test-model",
    },
    ...overrides,
  });
}

/** A second spec with a different module, for multi-engine bundles. */
export function makeLinkSpec(): FeatureSpec {
  return makeSpec({
    feature_id: "inkwell.wikilink_graph",
    app_id: "inkwell",
    source_app: "Inkwell Notes",
    consumer_title: "Wiki-link graph",
    category: "graph",
    interface: {
      module_name: "wikiLinks",
      exports: [{ name: "parseLinks", kind: "function", signature: "(md: string) => string[]", description: "Link targets" }],
      types_code: "export declare function parseLinks(md: string): string[];",
    },
  });
}

export const LINK_ENGINE = `// REQ-1
export function parseLinks(md: string): string[] {
  const out: string[] = [];
  const re = /\\[\\[([^\\]|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1].trim());
  return out;
}
`;

/** A generated UI that uses both engines above (sm2Scheduler + wikiLinks). */
export const APP = `import { useState } from "react";
import { updateEase, type ReviewResult } from "./engines/sm2Scheduler";
import { NoteCard } from "./components/NoteCard";

export default function App() {
  const [ease, setEase] = useState(2.5);
  const last: ReviewResult = { ease, interval: 1 };
  return (
    <main className="p-4">
      <NoteCard body="See [[Cardiology]]" />
      <button onClick={() => setEase(updateEase(ease, 4))}>Grade 4 (ease {last.ease})</button>
    </main>
  );
}`;

export const NOTE_CARD = `import { BookOpen } from "lucide-react";
import { parseLinks } from "../engines/wikiLinks";

export function NoteCard({ body }: { body: string }) {
  return <div><BookOpen className="h-4 w-4" />{parseLinks(body).join(", ")}</div>;
}`;

export function makeBlueprint(spec: FeatureSpec, code: string): FeatureBlueprint {
  return FeatureBlueprint.parse({
    schema_version: 1,
    feature_id: spec.feature_id,
    spec,
    implementation: { module_name: spec.interface.module_name, portable_code: code, notes: [] },
    verification: {
      status: "passed", tests: [], passed: 3, total: 3, purity_violations: [], type_errors: [],
      repair_attempts: 0, duration_ms: 1, implemented_at: "2026-10-24T00:00:00.000Z", model: "test-model", mode: "live",
    },
  });
}

/** Scripted LLM: answers calls in order and records every request. */
export function fakeLlm(answers: unknown[], model = "test-model") {
  const calls: StructuredCallOpts<unknown>[] = [];
  const port: LlmPort = {
    async structuredCall<T>(o: StructuredCallOpts<T>) {
      calls.push({ ...o, messages: [...o.messages] } as StructuredCallOpts<unknown>);
      if (calls.length > answers.length) throw new Error(`fakeLlm: unexpected call #${calls.length}`);
      const raw = answers[calls.length - 1];
      return { value: o.parse(raw), assistantContent: [{ type: "text", text: JSON.stringify(raw) }], model };
    },
    continueWith(messages: ChatMessage[], assistantContent: unknown[], feedback: string): ChatMessage[] {
      return [...messages, { role: "assistant", content: assistantContent }, { role: "user", content: feedback }];
    },
  };
  return { port, calls };
}

/** Sandbox double: the caller decides the outcome per submitted engine. */
export function fakeSandbox(run: (input: RunTestsInput) => Omit<RunTestsResult, "duration_ms">) {
  const inputs: RunTestsInput[] = [];
  const port: SandboxPort = {
    async runTests(input) {
      inputs.push(input);
      return { ...run(input), duration_ms: 1 };
    },
  };
  return { port, inputs };
}

export const passAll = (): Omit<RunTestsResult, "duration_ms"> => ({
  fatal: null,
  tests: ["REQ-1", "REQ-2", "REQ-3"].map((n) => ({ name: n, kind: "acceptance" as const, passed: true, error: null, duration_ms: 1 })),
  passed: 3,
  total: 3,
});
