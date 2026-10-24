process.env.NODE_ENV = "test";
process.env.REA_MODE = "replay";

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { FeatureBlueprint, FeatureSpec, PipelineEvent } from "@splice/contracts";
import { app } from "../dist/server.js";
import { implementEngine, MAX_REPAIRS, type ImplementHooks } from "../dist/engine/implement.js";
import { purityViolations } from "../dist/engine/purity.js";
import { conformanceErrors } from "../dist/engine/conformance.js";
import { formatSpecForImplementer, ENGINE_SYSTEM } from "../dist/engine/prompt.js";
import { runTests } from "../dist/sandbox/runTests.js";
import {
  makeSpec,
  makeLinkSpec,
  GOOD_ENGINE,
  LINK_ENGINE,
  SOURCE_SENTINEL,
  ADAPTER_SENTINEL,
  fakeLlm,
  fakeSandbox,
  passAll,
} from "../dist/engine/testFixtures.js";
import { REPO_ROOT } from "../dist/config.js";

async function collectSseEvents(res: globalThis.Response): Promise<PipelineEvent[]> {
  const text = await res.text();
  const frames = text.split("\n\n");
  const events: PipelineEvent[] = [];
  for (const frame of frames) {
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (dataLine) {
      const json = JSON.parse(dataLine.slice(5).trim());
      events.push(PipelineEvent.parse(json));
    }
  }
  return events;
}

function createHooks(signal?: AbortSignal) {
  const stages: string[] = [];
  const testResults: any[] = [];
  const progress: { phase: string; chars: number }[] = [];
  const hooks: ImplementHooks = {
    signal,
    onStage: (s, m) => stages.push(s),
    onProgress: (phase, chars) => progress.push({ phase, chars }),
    onTestResult: (t) => testResults.push(t),
  };
  return { hooks, stages, testResults, progress };
}

describe("Step 3: Engine Generator Suite", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr !== null) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("Clean-Room Engine Generation & Source Independence", () => {
    it("converts a validated feature specification into clean-room TypeScript", async () => {
      const spec = makeSpec();
      const llm = fakeLlm([{ portable_code: GOOD_ENGINE, notes: ["deterministic SM-2 scheduler"] }], "test-qwen3-coder");
      const { hooks, stages, testResults } = createHooks();

      // Run with real sandbox runner using default deps or explicit sandbox
      const blueprint = await implementEngine(spec, hooks, { llm: llm.port, sandbox: { runTests } });

      assert.equal(blueprint.schema_version, 1);
      assert.equal(blueprint.feature_id, "recall.sm2_scheduler");
      assert.equal(blueprint.implementation.module_name, "sm2Scheduler");
      assert.equal(blueprint.implementation.portable_code, GOOD_ENGINE);
      assert.deepEqual(blueprint.implementation.notes, ["deterministic SM-2 scheduler"]);

      // Verification metadata conforms to FeatureBlueprint schema
      assert.equal(blueprint.verification.status, "passed");
      assert.equal(blueprint.verification.passed, 3);
      assert.equal(blueprint.verification.total, 3);
      assert.equal(blueprint.verification.repair_attempts, 0);
      assert.equal(blueprint.verification.purity_violations.length, 0);
      assert.equal(blueprint.verification.type_errors.length, 0);
      assert.equal(blueprint.verification.model, "test-qwen3-coder");
      assert.equal(blueprint.verification.mode, "live");
      assert.ok(blueprint.verification.duration_ms >= 0);

      // Verify schema parser
      const parsed = FeatureBlueprint.parse(blueprint);
      assert.equal(parsed.feature_id, "recall.sm2_scheduler");

      assert.deepEqual(stages, ["implementing", "testing"]);
      assert.equal(testResults.length, 3);
      assert.ok(testResults.every((t) => t.passed));
    });

    it("ensures prompt never leaks original target source, snippets, or adapter code", async () => {
      const spec = makeSpec();
      const promptText = formatSpecForImplementer(spec);

      // Must never contain sensitive source or adapter sentinels
      assert.ok(!promptText.includes(SOURCE_SENTINEL), "Original source code leaked into engine prompt");
      assert.ok(!promptText.includes(ADAPTER_SENTINEL), "Adapter code leaked into engine prompt");
      assert.ok(!promptText.includes("ipcMain.handle"), "Stripped glue leaked into engine prompt");

      // Must contain requirements, interface, allowed deviations, and acceptance tests
      assert.ok(promptText.includes("<module name=\"sm2Scheduler\">"));
      assert.ok(promptText.includes("<interface>"));
      assert.ok(promptText.includes("MIN_EASE"));
      assert.ok(promptText.includes("<acceptance_tests>"));

      // Verify during repair attempts as well
      const llm = fakeLlm([
        { portable_code: GOOD_ENGINE.replace("0.1", "0.2"), notes: [] },
        { portable_code: GOOD_ENGINE, notes: [] },
      ]);
      const { hooks } = createHooks();
      await implementEngine(spec, hooks, { llm: llm.port, sandbox: { runTests } });

      const allSent = JSON.stringify(llm.calls.map((c) => c.messages));
      assert.ok(!allSent.includes(SOURCE_SENTINEL), "Original source code leaked into repair turns");
      assert.ok(!allSent.includes(ADAPTER_SENTINEL), "Adapter code leaked into repair turns");
    });
  });

  describe("Purity Validation & Environmental Isolation", () => {
    it("flags forbidden imports and require calls", () => {
      const code1 = `import fs from "node:fs";\nexport function review() {}\n`;
      const code2 = `const os = require("os");\nexport function review() {}\n`;
      const code3 = `export async function load() { const mod = await import("path"); }\n`;

      assert.ok(purityViolations(code1).some((v) => /imports are not allowed/.test(v)));
      assert.ok(purityViolations(code2).some((v) => /require\(\) is not allowed/.test(v)));
      assert.ok(purityViolations(code3).some((v) => /imports are not allowed/.test(v)));
    });

    it("flags environment globals (process, window, localStorage, globalThis)", () => {
      const code1 = `export function f() { return process.env.PORT; }\n`;
      const code2 = `export function f() { return window.location.href; }\n`;
      const code3 = `export function f() { return localStorage.getItem("key"); }\n`;
      const code4 = `export function f() { return globalThis.something; }\n`;

      assert.ok(purityViolations(code1).some((v) => /process is not available/.test(v)));
      assert.ok(purityViolations(code2).some((v) => /browser globals are not allowed/.test(v)));
      assert.ok(purityViolations(code3).some((v) => /browser globals are not allowed/.test(v)));
      assert.ok(purityViolations(code4).some((v) => /globalThis is not allowed/.test(v)));
    });

    it("flags nondeterministic functions (Math.random, Date.now, new Date())", () => {
      const code1 = `export function f() { return Math.random(); }\n`;
      const code2 = `export function f() { return Date.now(); }\n`;
      const code3 = `export function f() { return new Date(); }\n`;

      assert.ok(purityViolations(code1).some((v) => /Math\.random\(\) makes the engine nondeterministic/.test(v)));
      assert.ok(purityViolations(code2).some((v) => /reading the clock makes the engine nondeterministic/.test(v)));
      assert.ok(purityViolations(code3).some((v) => /reading the clock makes the engine nondeterministic/.test(v)));
    });

    it("flags console output, timers, and eval", () => {
      const code1 = `export function f() { console.log("debug"); }\n`;
      const code2 = `export function f() { setTimeout(() => {}, 100); }\n`;
      const code3 = `export function f(s: string) { return eval(s); }\n`;

      assert.ok(purityViolations(code1).some((v) => /console output is not allowed/.test(v)));
      assert.ok(purityViolations(code2).some((v) => /timers are not allowed/.test(v)));
      assert.ok(purityViolations(code3).some((v) => /eval is not allowed/.test(v)));
    });

    it("prevents sandbox execution when code violates purity", async () => {
      const spec = makeSpec();
      const impureCandidate = {
        portable_code: GOOD_ENGINE + "\nexport const token = Math.random();\n",
        notes: [],
      };
      const llm = fakeLlm([impureCandidate, impureCandidate, impureCandidate]);
      const sb = fakeSandbox(passAll);
      const { hooks } = createHooks();

      const blueprint = await implementEngine(spec, hooks, { llm: llm.port, sandbox: sb.port });
      assert.equal(blueprint.verification.status, "failed");
      assert.equal(blueprint.verification.repair_attempts, MAX_REPAIRS);
      assert.equal(sb.inputs.length, 0, "Sandbox must never execute impure code");
      assert.ok(blueprint.verification.purity_violations.some((p) => /Math\.random/.test(p)));
    });
  });

  describe("Type Conformance & Interface Verification", () => {
    it("reports syntax error in invalid TypeScript candidate", () => {
      const spec = makeSpec();
      const invalidTs = `export function updateEase(ease: number, q: number) { return ease +; }\n`;
      const errors = conformanceErrors(spec, invalidTs);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => /Expression expected/.test(e)));
    });

    it("reports missing function export declared in interface", () => {
      const spec = makeSpec();
      // Omits "review" function
      const missingExport = `export const MIN_EASE = 1.3;
export interface ReviewResult { ease: number; interval: number }
export function updateEase(ease: number, q: number): number { return ease; }
`;
      const errors = conformanceErrors(spec, missingExport);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => /Export "review" does not match the interface/.test(e) || /has no exported member 'review'/.test(e)));
    });

    it("reports missing type export declared in interface", () => {
      const spec = makeSpec();
      // Omits "ReviewResult" type
      const missingType = `export const MIN_EASE = 1.3;
export function updateEase(ease: number, q: number): number { return ease; }
export function review(ease: number, interval: number, q: number): any { return {}; }
`;
      const errors = conformanceErrors(spec, missingType);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => /ReviewResult/.test(e)));
    });

    it("reports incompatible function signature", () => {
      const spec = makeSpec();
      // Wrong parameter type (string instead of number)
      const wrongSignature = `export const MIN_EASE = 1.3;
export interface ReviewResult { ease: number; interval: number }
export function updateEase(ease: string, q: number): number { return 1; }
export function review(ease: number, interval: number, q: number): ReviewResult { return { ease: 1, interval: 1 }; }
`;
      const errors = conformanceErrors(spec, wrongSignature);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => /Export "updateEase" does not match the interface/.test(e)));
    });

    it("reports incompatible type shape", () => {
      const spec = makeSpec();
      // ReviewResult has wrong property type
      const wrongShape = `export const MIN_EASE = 1.3;
export interface ReviewResult { ease: string; interval: number }
export function updateEase(ease: number, q: number): number { return ease; }
export function review(ease: number, interval: number, q: number): ReviewResult { return { ease: "1", interval: 1 }; }
`;
      const errors = conformanceErrors(spec, wrongShape);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => /Export "ReviewResult" does not match the interface/.test(e)));
    });

    it("enforces TypeScript strict mode against candidate", () => {
      const spec = makeSpec();
      // Implicit any parameter
      const implicitAny = `export const MIN_EASE = 1.3;
export interface ReviewResult { ease: number; interval: number }
export function updateEase(ease, q: number): number { return ease; }
export function review(ease: number, interval: number, q: number): ReviewResult { return { ease, interval }; }
`;
      const errors = conformanceErrors(spec, implicitAny);
      assert.ok(errors.length > 0);
      assert.ok(errors.some((e) => /implicitly has an 'any' type/.test(e)));
    });
  });

  describe("Sandbox Runner Integration & Acceptance Test Execution", () => {
    it("runs acceptance tests against clean-room code in sandbox", async () => {
      const spec = makeSpec();
      const result = await runTests({
        kind: "acceptance",
        subject: { code: GOOD_ENGINE, lang: "ts" },
        tests: spec.acceptance_tests,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 3);
      assert.equal(result.total, 3);
      assert.ok(result.tests.every((t) => t.passed));
    });

    it("captures test assertion failure and records it in verification", async () => {
      const spec = makeSpec();
      // Altered constant causing test failure
      const faultyEngine = GOOD_ENGINE.replace("0.1", "0.5");
      const result = await runTests({
        kind: "acceptance",
        subject: { code: faultyEngine, lang: "ts" },
        tests: spec.acceptance_tests,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 2);
      assert.equal(result.total, 3);
      const failed = result.tests.find((t) => !t.passed);
      assert.ok(failed);
      assert.match(failed!.name, /REQ-1/);
    });

    it("contains infinite loop in acceptance test without hanging", async () => {
      const spec = makeSpec();
      const infiniteLoopTests = `test("REQ-1: infinite loop", () => { while (true) {} });`;
      const result = await runTests({
        kind: "acceptance",
        subject: { code: GOOD_ENGINE, lang: "ts" },
        tests: infiniteLoopTests,
        perTestTimeoutMs: 100,
      });

      assert.equal(result.passed, 0);
      assert.equal(result.total, 1);
      assert.equal(result.tests[0].passed, false);
      assert.match(result.tests[0].error ?? "", /timed out after 100ms/);
    });

    it("treats zero executed tests as a failure", async () => {
      const spec = makeSpec();
      const llm = fakeLlm([
        { portable_code: GOOD_ENGINE, notes: [] },
        { portable_code: GOOD_ENGINE, notes: [] },
        { portable_code: GOOD_ENGINE, notes: [] },
      ]);
      const sb = fakeSandbox(() => ({ fatal: null, tests: [], passed: 0, total: 0 }));
      const { hooks } = createHooks();

      const blueprint = await implementEngine(spec, hooks, { llm: llm.port, sandbox: sb.port });
      assert.equal(blueprint.verification.status, "failed");
      assert.match(String(llm.calls[1].messages[2].content), /no acceptance tests were executed/);
    });
  });

  describe("Self-Repair Loop & Generation Failure", () => {
    it("successfully repairs a failing implementation on attempt 1", async () => {
      const spec = makeSpec();
      // First attempt has buggy ease calculation; second attempt has correct implementation
      const buggyCode = GOOD_ENGINE.replace("0.1", "0.2");
      const llm = fakeLlm([
        { portable_code: buggyCode, notes: ["initial draft"] },
        { portable_code: GOOD_ENGINE, notes: ["fixed calculation per REQ-1"] },
      ]);
      const { hooks, stages } = createHooks();

      const blueprint = await implementEngine(spec, hooks, { llm: llm.port, sandbox: { runTests } });
      assert.equal(blueprint.verification.status, "passed");
      assert.equal(blueprint.verification.repair_attempts, 1);
      assert.equal(blueprint.implementation.portable_code, GOOD_ENGINE);
      assert.deepEqual(blueprint.implementation.notes, ["fixed calculation per REQ-1"]);

      // Verify conversation carried the specific failure in the repair turn
      assert.equal(llm.calls.length, 2);
      const repairTurn = llm.calls[1].messages[2];
      assert.match(String(repairTurn.content), /Test "REQ-1: perfect recall raises ease by 0\.1" failed/);
      assert.ok(stages.includes("repairing_engine"));
    });

    it("records failure when max repairs (MAX_REPAIRS=2) are exhausted", async () => {
      const spec = makeSpec();
      const faultyCode = GOOD_ENGINE.replace("0.1", "0.5");
      const llm = fakeLlm([
        { portable_code: faultyCode, notes: ["attempt 0"] },
        { portable_code: faultyCode, notes: ["attempt 1"] },
        { portable_code: faultyCode, notes: ["attempt 2"] },
      ]);
      const { hooks } = createHooks();

      const blueprint = await implementEngine(spec, hooks, { llm: llm.port, sandbox: { runTests } });
      assert.equal(blueprint.verification.status, "failed");
      assert.equal(blueprint.verification.repair_attempts, MAX_REPAIRS);
      assert.equal(blueprint.verification.passed, 2);
      assert.equal(blueprint.verification.total, 3);
      assert.equal(llm.calls.length, 1 + MAX_REPAIRS);
    });

    it("handles malformed JSON / schema mismatch from LLM gracefully", async () => {
      const spec = makeSpec();
      const llm = fakeLlm([
        { not_portable_code: "foo" }, // invalid schema
      ]);
      const { hooks } = createHooks();

      await assert.rejects(
        () => implementEngine(spec, hooks, { llm: llm.port, sandbox: { runTests } }),
        (err: any) => err.name === "ZodError" || err.message.includes("portable_code"),
      );
    });

    it("handles client cancellation cleanly without hanging", async () => {
      const spec = makeSpec();
      const controller = new AbortController();
      controller.abort();
      const llm = fakeLlm([{ portable_code: GOOD_ENGINE, notes: [] }]);
      const { hooks } = createHooks(controller.signal);

      await assert.rejects(
        () => implementEngine(spec, hooks, { llm: llm.port, sandbox: { runTests } }),
        (err: any) => err.name === "AbortError",
      );
      assert.equal(llm.calls.length, 0);
    });
  });

  describe("POST /api/implement Route Integration", () => {
    it("returns 400 when spec is missing or malformed", async () => {
      const res = await fetch(`${baseUrl}/api/implement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      const json = await res.json() as any;
      assert.ok(json.error);
    });

    it("streams a valid PipelineEvent sequence in replay mode for recall.sm2_scheduler", async () => {
      const spec = makeSpec();
      const res = await fetch(`${baseUrl}/api/implement`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          spec,
          force_mode: "replay",
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

      const events = await collectSseEvents(res);
      assert.ok(events.length > 0);

      // Verify done event
      const doneEvent = events.find((e) => e.type === "done");
      assert.ok(doneEvent);
      assert.equal(doneEvent.type, "done");
      if (doneEvent.type === "done") {
        assert.equal(doneEvent.ok, true);
        assert.equal(doneEvent.replayed, true);
      }

      // Verify blueprint event
      const bpEvent = events.find((e) => e.type === "blueprint");
      assert.ok(bpEvent, "Expected blueprint event in implement replay stream");
      if (bpEvent?.type === "blueprint") {
        assert.equal(bpEvent.blueprint.feature_id, "recall.sm2_scheduler");
        assert.equal(bpEvent.blueprint.implementation.module_name, "sm2Scheduler");
        assert.equal(bpEvent.blueprint.verification.mode, "replay");
      }
    });

    it("serves discovered blueprints on GET /api/blueprints", async () => {
      const res = await fetch(`${baseUrl}/api/blueprints`);
      assert.equal(res.status, 200);
      const list = await res.json() as FeatureBlueprint[];
      assert.ok(Array.isArray(list));
      assert.ok(list.length >= 1);
      const item = list.find((b) => b.feature_id === "recall.sm2_scheduler");
      assert.ok(item);
      assert.equal(item.implementation.module_name, "sm2Scheduler");
    });
  });
});
