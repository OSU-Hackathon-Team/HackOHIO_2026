process.env.NODE_ENV = "test";
process.env.REA_MODE = "replay";
process.env.LLM_MODE = "replay";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import vm from "node:vm";
import ts from "typescript";
import {
  RawEvidence,
  FeatureSpec,
  FeatureBlueprint,
  PipelineEvent,
  SynthesisBundle,
} from "@splice/contracts";
import { app } from "../dist/server.js";
import { loadRecordedEvidence, loadRecordedBlueprint } from "../dist/evidence/replay.js";
import { loadRecordedSpec, listSpecs } from "../dist/spec/store.js";
import { staticChecks } from "../dist/spec/staticChecks.js";
import { purityViolations } from "../dist/engine/purity.js";
import { conformanceErrors } from "../dist/engine/conformance.js";
import { assembleBundle } from "../dist/synthesis/assemble.js";
import { validateBundle } from "../dist/synthesis/validateBundle.js";

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

describe("Autonomous Pipeline & Replay Verification Suite", () => {
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

  describe("Phase 1: Autonomous Evidence Ingestion (mock_decompiled_evidence.json)", () => {
    it("loads and validates mock decompiled evidence offline with zero external calls", async () => {
      const evidence = await loadRecordedEvidence("mockpriority.priority_score");
      assert.ok(evidence, "Expected loadRecordedEvidence to find mock_decompiled_evidence.json");

      // Validate Zod contract conformance
      const parsed = RawEvidence.parse(evidence);
      assert.equal(parsed.mode, "replay");
      assert.equal(parsed.app_id, "mockpriority");
      assert.equal(parsed.feature_id, "mockpriority.priority_score");
      assert.equal(parsed.target.artifact_type, "native_elf");
      assert.equal(parsed.target.path, "fixtures/test-run/mock_task_priority.elf");

      // Verify decompiler snippets integrity
      assert.equal(parsed.snippets.length, 1);
      const snippet = parsed.snippets[0];
      assert.equal(snippet.symbol, "score_task_priority");
      assert.equal(snippet.language, "c");
      assert.match(snippet.code, /urgency_bucket/);
      assert.match(snippet.code, /score_task_priority/);

      // Verify limitations and unknowns are recorded for clean-room handoff
      assert.ok(parsed.limitations.length >= 1);
      assert.ok(parsed.unknowns.length >= 1);
    });
  });

  describe("Phase 2: Autonomous Specification Synthesis & Static Verification", () => {
    it("loads and validates FeatureSpec with strict schema and static checks", async () => {
      const spec = await loadRecordedSpec("mockpriority.priority_score");
      assert.ok(spec, "Expected FeatureSpec fixture for mockpriority.priority_score");

      const parsed = FeatureSpec.parse(spec);
      assert.equal(parsed.schema_version, 1);
      assert.equal(parsed.feature_id, "mockpriority.priority_score");
      assert.equal(parsed.app_id, "mockpriority");
      assert.equal(parsed.interface.module_name, "priorityScore");

      // Verify requirements completeness (REQ-1..REQ-5)
      assert.equal(parsed.requirements.length, 5);
      const reqIds = parsed.requirements.map((r) => r.id);
      assert.deepEqual(reqIds, ["REQ-1", "REQ-2", "REQ-3", "REQ-4", "REQ-5"]);

      // Verify interface contracts
      assert.ok(parsed.interface.types_code.includes("export interface TaskView"));
      assert.ok(parsed.interface.types_code.includes("score_task_priority"));
      assert.ok(parsed.interface.types_code.includes("urgency_bucket"));

      // Verify static checks
      const evidence = await loadRecordedEvidence("mockpriority.priority_score");
      assert.ok(evidence);
      const draft = {
        ...parsed,
        exports: parsed.interface.exports,
        types_code: parsed.interface.types_code,
        acceptance_tests: parsed.acceptance_tests,
      };
      const problems = await staticChecks(draft as any, evidence);
      // Ensure no fatal syntax or structural issues
      const fatalProblems = problems.filter((p) => /syntax|unparseable|export declare/.test(p));
      assert.deepEqual(fatalProblems, []);
    });
  });

  describe("Phase 3: Clean-Room Implementation, Purity & Conformance Oracle", () => {
    it("verifies clean-room portable code purity, interface conformance and acceptance suite", async () => {
      const spec = await loadRecordedSpec("mockpriority.priority_score");
      assert.ok(spec);
      const blueprint = await loadRecordedBlueprint("mockpriority.priority_score");
      assert.ok(blueprint, "Expected FeatureBlueprint fixture for mockpriority.priority_score");

      const parsed = FeatureBlueprint.parse(blueprint);
      assert.equal(parsed.feature_id, "mockpriority.priority_score");
      assert.equal(parsed.verification.status, "passed");
      assert.equal(parsed.verification.passed, 5);
      assert.equal(parsed.verification.total, 5);

      const code = parsed.implementation.portable_code;
      assert.ok(code.length > 50);

      // Verify AST Purity (zero illegal globals, zero fs/process/eval/dom)
      const violations = purityViolations(code);
      assert.deepEqual(violations, [], "Clean-room engine must have zero AST purity violations");

      // Verify Interface Conformance
      const conformance = conformanceErrors(spec, code);
      assert.deepEqual(conformance, [], "Clean-room engine must conform 100% to FeatureSpec interface");

      // Execute acceptance tests in isolated VM context
      const executedTests: { name: string; passed: boolean }[] = [];
      const testContext = vm.createContext({
        exports: {},
        assert,
        test: (name: string, fn: () => void) => {
          fn();
          executedTests.push({ name, passed: true });
        },
        expect: (val: any) => ({
          toBe: (expected: any) => assert.equal(val, expected),
          toEqual: (expected: any) => assert.deepEqual(val, expected),
        }),
      });

      const transpiled = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      vm.runInContext(transpiled, testContext, { timeout: 1000 });
      Object.assign(testContext, testContext.exports);

      // Adapt import statements in test code for VM evaluation
      const vmTestScript = spec.acceptance_tests
        .replace(/import\s+[^;]+;\s*/g, "")
        .trim();
      vm.runInContext(vmTestScript, testContext, { timeout: 1000 });

      assert.equal(executedTests.length, 5, "All 5 acceptance test cases must execute");
      assert.ok(executedTests.every((t) => t.passed), "All acceptance tests must pass");
    });
  });

  describe("Phase 4: Autonomous UI Synthesis & Virtual TypeScript Typecheck", () => {
    it("assembles bundle and passes virtual TypeScript compilation with zero errors", async () => {
      const blueprint = await loadRecordedBlueprint("mockpriority.priority_score");
      assert.ok(blueprint);

      const appCode = `import { useState } from "react";
import { score_task_priority, urgency_bucket, type TaskView } from "./engines/priorityScore";

export default function App() {
  const [importance, setImportance] = useState(3);
  const task: TaskView = {
    completed: false,
    importance,
    due_epoch: 1000000,
  };
  const score = score_task_priority(task, 0);
  const urgency = urgency_bucket(1000000, 0);

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Task Priority Dashboard</h1>
      <p>Score: {score}</p>
      <p>Urgency Bucket: {urgency}</p>
      <button onClick={() => setImportance((i) => Math.min(5, i + 1))}>Increase Importance</button>
    </div>
  );
}
`;

      const bundle = assembleBundle([blueprint], [{ path: "/App.tsx", content: appCode }], {
        bundle_id: "bundle_autonomous_mockpriority",
        app_title: "Task Priority Dashboard",
        app_description: "Offline verification bundle",
        revision: 0,
        mode: "replay",
      });

      // Verify bundle structure
      assert.equal(bundle.bundle_id, "bundle_autonomous_mockpriority");
      assert.ok(bundle.files["/App.tsx"]);
      assert.ok(bundle.files["/engines/priorityScore.ts"]);
      assert.equal(bundle.files["/engines/priorityScore.ts"], blueprint.implementation.portable_code);

      // Execute comprehensive bundle validation + virtual TypeScript typecheck
      const validation = validateBundle(bundle, [blueprint]);
      assert.equal(validation.ok, true, `Bundle validation failed: ${validation.errors.join(", ")}`);
      assert.deepEqual(validation.errors, []);
    });
  });

  describe("Phase 5: Programmatic HTTP / SSE Replay Execution", () => {
    it("executes unattended POST /api/extract stream for mockpriority.priority_score", async () => {
      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          app_id: "mockpriority",
          feature_id: "mockpriority.priority_score",
          force_mode: "replay",
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

      const events = await collectSseEvents(res);
      assert.ok(events.length >= 5, "Expected streamed event sequence");

      // Verify stages
      const stages = events.filter((e) => e.type === "stage").map((e: any) => e.stage);
      assert.ok(stages.includes("queued"));
      assert.ok(stages.includes("specifying"));
      assert.ok(stages.includes("complete"));

      // Verify spec event
      const specEvent = events.find((e) => e.type === "spec");
      assert.ok(specEvent, "Expected spec event in replay stream");
      if (specEvent?.type === "spec") {
        assert.equal(specEvent.spec.feature_id, "mockpriority.priority_score");
        assert.equal(specEvent.spec.provenance.mode, "replay");
        assert.equal(specEvent.spec.requirements.length, 5);
      }

      // Verify done event
      const doneEvent = events.find((e) => e.type === "done");
      assert.ok(doneEvent);
      if (doneEvent?.type === "done") {
        assert.equal(doneEvent.ok, true);
        assert.equal(doneEvent.replayed, true);
      }
    });

    it("executes unattended POST /api/implement stream for mockpriority.priority_score", async () => {
      const spec = await loadRecordedSpec("mockpriority.priority_score");
      assert.ok(spec);

      const res = await fetch(`${baseUrl}/api/implement`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          spec,
          force_mode: "replay",
        }),
      });

      assert.equal(res.status, 200);
      const events = await collectSseEvents(res);

      const bpEvent = events.find((e) => e.type === "blueprint");
      assert.ok(bpEvent, "Expected blueprint event");
      if (bpEvent?.type === "blueprint") {
        assert.equal(bpEvent.blueprint.feature_id, "mockpriority.priority_score");
        assert.equal(bpEvent.blueprint.verification.status, "passed");
      }

      const doneEvent = events.find((e) => e.type === "done");
      assert.ok(doneEvent);
      if (doneEvent?.type === "done") {
        assert.equal(doneEvent.ok, true);
        assert.equal(doneEvent.replayed, true);
      }
    });

    it("verifies strict non-zero exit codes on malformed or nonexistent requests", async () => {
      const badReq = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: "unknown" }),
      });
      assert.equal(badReq.status, 400);

      const notFound = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: "unknown", feature_id: "unknown.feature" }),
      });
      assert.equal(notFound.status, 404);
    });
  });
});
