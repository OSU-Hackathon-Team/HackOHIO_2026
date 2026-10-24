import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { FeatureSpec, NativeSubsystemSpec } from "@splice/contracts";
import { nativeSpecsRouter } from "../dist/routes/nativeSpecs.js";
import { adaptNativeSpecToFeatureSpec } from "../dist/native/nativeAdapter.js";

describe("Native Pipeline -> FeatureSpec and Backend API", () => {
  let state = "";
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base = "";
  const dummyHash = "a".repeat(64);

  const sampleNativeSpec: NativeSubsystemSpec = {
    schema: 2,
    kind: "native_subsystem_spec",
    status: "ready_for_review",
    title: "Task Priority Scoring Subsystem",
    purpose: "Score task due dates, urgency, and task importance.",
    boundary: "subsystem",
    interface: {
      inputs: ["Task view description with due date, completion status, and importance"],
      outputs: ["Calculated priority score as non-negative integer"],
      state: ["No persistent state between calculations"],
    },
    requirements: [
      {
        id: "REQ-1",
        statement: "Score must be non-negative and capped at 200.",
      },
      {
        id: "REQ-2",
        statement: "Completed tasks must evaluate to priority 0.",
      },
    ],
    behavior_steps: [
      "Check if task is completed and produce 0.",
      "Calculate overdue days and urgency points, capping at 200.",
    ],
    examples: [
      {
        name: "completed_zero",
        input: { completed: true },
        expected_output: 0,
      },
      {
        name: "capped_200",
        input: { days_overdue: 10 },
        expected_output: 200,
      },
    ],
    acceptance_criteria: [
      "Completed tasks evaluate to 0.",
      "Score is capped at 200.",
    ],
    deviations: [],
    exclusions: [],
  };

  async function put(value: object): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(value));
    const artifact = createHash("sha256").update(bytes).digest("hex");
    const folder = path.join(state, "artifacts", artifact.slice(0, 2));
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, artifact), bytes);
    return artifact;
  }

  before(async () => {
    state = await fs.mkdtemp(path.join(os.tmpdir(), "splice-native-test-"));
    process.env.DECOMP_STATE_DIR = state;
    const app = express();
    app.use(express.json());
    app.use(nativeSpecsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.DECOMP_STATE_DIR;
    await fs.rm(state, { recursive: true, force: true });
  });

  it("valid native spec -> valid FeatureSpec adhering to Zod schema", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec, {
      appId: "mockpriority",
      featureId: "mockpriority.priority_score",
      category: "utility",
    });

    const parsed = FeatureSpec.parse(featureSpec);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.feature_id, "mockpriority.priority_score");
    assert.equal(parsed.app_id, "mockpriority");
    assert.equal(parsed.oracle.status, "not_executable");
    assert.equal(parsed.oracle.adapter_code, null);
  });

  it("requirements are preserved and interfaces/tests are valid", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec);

    assert.equal(featureSpec.requirements.length, 2);
    assert.equal(featureSpec.requirements[0].id, "REQ-1");
    assert.deepEqual(featureSpec.requirements[0].source_refs, ["REQ-1"]);
    assert.equal(featureSpec.requirements[0].kind, "invariant");

    assert.ok(featureSpec.interface.types_code.includes("taskPriorityScoringSubsystem"));
    assert.ok(featureSpec.acceptance_tests.includes('test("REQ-1:'));
    assert.ok(featureSpec.acceptance_tests.includes('test("REQ-2:'));
  });

  it("raw native pseudocode is not leaked into prompt-facing fields", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec);
    const serialized = JSON.stringify({
      requirements: featureSpec.requirements,
      interface: featureSpec.interface,
      inputs: featureSpec.inputs,
      outputs: featureSpec.outputs,
      acceptance_tests: featureSpec.acceptance_tests,
    });

    assert.equal(serialized.includes("Ghidra"), false);
    assert.equal(serialized.includes("decompiler"), false);
    assert.equal(serialized.includes("ptr"), false);
    assert.equal(serialized.includes("TaskView"), false);
  });

  it("POST /api/native-specs/adapt converts spec and returns 200", async () => {
    const res = await fetch(`${base}/api/native-specs/adapt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec: sampleNativeSpec, feature_id: "mockpriority.priority_score" }),
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as { spec: FeatureSpec };
    const validated = FeatureSpec.parse(data.spec);
    assert.equal(validated.feature_id, "mockpriority.priority_score");
    assert.equal(validated.oracle.status, "not_executable");
  });

  it("POST /api/native-specs/adapt converts spec by artifact hash", async () => {
    const artifact = await put(sampleNativeSpec);
    const res = await fetch(`${base}/api/native-specs/adapt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact }),
    });

    const text = await res.text();
    assert.equal(res.status, 200, `Expected 200 but got ${res.status}: ${text}`);
    const data = JSON.parse(text) as { spec: FeatureSpec };
    assert.equal(data.spec.app_id, "native");
  });

  it("GET /api/native-specs lists stored specs and rejects bad artifact", async () => {
    const res = await fetch(`${base}/api/native-specs`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { specs: any[] };
    assert.ok(Array.isArray(data.specs));

    const notFound = await fetch(`${base}/api/native-specs/adapt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact: "0".repeat(64) }),
    });
    assert.equal(notFound.status, 404);
  });
});
