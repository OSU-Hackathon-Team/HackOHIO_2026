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
    schema: 1,
    kind: "native_subsystem_spec",
    campaign: dummyHash,
    binary_sha256: "b".repeat(64),
    scope_id: "c".repeat(64),
    scope_revision: 1,
    title: "Task Priority Scoring Subsystem",
    status: "ready_for_review",
    boundary: {
      mode: "subsystem",
      included: [{ entry: "004012a0", name: "score_task_priority" }],
      boundaries: [],
      exclusions: [],
      unresolved_edges: [],
      expected_observables_to_investigate: ["priority score calculation"],
    },
    requirements: [
      {
        id: "REQ-1",
        subject: "004012a0",
        draft_artifact: dummyHash,
        claim_index: 0,
        statement: "Score must be non-negative and capped at 200.",
        evidence: [{ artifact: dummyHash, address: "004012a0" }],
        assumptions: [],
        alternatives: [],
        review_state: "supported_static",
        reviews: [{ outcome: "supported_static", model: "independent-reviewer" }],
        execution_state: "case_agreement",
        probe_links: [{ case_id: "completed_zero", agreement: true }],
      },
      {
        id: "REQ-2",
        subject: "004012a0",
        draft_artifact: dummyHash,
        claim_index: 1,
        statement: "Completed tasks must evaluate to priority 0.",
        evidence: [{ artifact: dummyHash, address: "004012a8" }],
        assumptions: [],
        alternatives: [],
        review_state: "supported_static",
        reviews: [{ outcome: "supported_static", model: "independent-reviewer" }],
        execution_state: "case_agreement",
        probe_links: [{ case_id: "completed_zero", agreement: true }],
      },
    ],
    function_descriptions: [
      {
        entry: "004012a0",
        name: "score_task_priority",
        draft_artifact: dummyHash,
        inputs: "TaskView* task, int64_t now_epoch",
        outputs: "int score",
        state: "stateless",
        side_effects: "none",
        errors: "clamped",
        draft_pseudocode: "int score_task_priority(TaskView *task) { return task->completed ? 0 : 42; }",
        unknowns: [],
        evidence_requests: [],
      },
    ],
    dependency_contracts: [],
    original_cases: [
      {
        case_id: "completed_zero",
        target: "score_task_priority",
        input: { completed: 1 },
        expected: 0,
        observed: 0,
        outcome: "agreement",
      },
    ],
    unresolved_claims: [],
    review_gaps: [],
    blockers: [],
    coverage: { claims: 2, supported_static: 2, case_agreements: 2 },
    provenance: {
      dossier_artifact: "d".repeat(64),
      dossier_revision: 1,
      dossier_readiness: "ready_for_spec",
      dossier_schema: 1,
      analysis: null,
      scope_artifact: "e".repeat(64),
      draft_artifacts: [dummyHash],
      review_artifacts: [dummyHash],
      probe_report_artifacts: [dummyHash],
      probe_link_artifacts: [dummyHash],
      dependency_resolution_artifacts: [],
      gap_adjudication_artifacts: [],
      generator_sha256: "f".repeat(64),
    },
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
    assert.deepEqual(featureSpec.requirements[0].source_refs, ["004012a0@004012a0"]);
    assert.equal(featureSpec.requirements[0].kind, "invariant");

    assert.ok(featureSpec.interface.types_code.includes("score_task_priority"));
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

    assert.equal(res.status, 200);
    const data = (await res.json()) as { spec: FeatureSpec };
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
