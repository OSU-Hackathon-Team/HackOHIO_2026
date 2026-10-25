import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { FeatureSpec, NativeSubsystemSpec } from "@splice/contracts";
import { nativeSpecsRouter } from "./nativeSpecs.js";

let state = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let base = "";

async function put(value: object): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(value));
  const artifact = createHash("sha256").update(bytes).digest("hex");
  const folder = path.join(state, "artifacts", artifact.slice(0, 2));
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, artifact), bytes);
  return artifact;
}

before(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), "splice-native-spec-api-"));
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

test("native API persists a partial draft and reads only public schema 2 specs", async () => {
  const scopeId = "a".repeat(64);
  const dossier = {
    schema: 1, campaign: "c".repeat(64), binary_sha256: "b".repeat(64),
    scope_id: scopeId, scope_revision: 1, scope_artifact: "d".repeat(64),
    revision: 1, readiness: "partial", draft_artifacts: [], review_artifacts: [],
    probe_report_artifacts: [], probe_link_artifacts: [],
    dependency_resolution_artifacts: [], gap_adjudication_artifacts: [],
    scope: { campaign: "c".repeat(64), scope_id: scopeId, revision: 1,
      request: { mode: "subsystem", query: "counter", expected_observables: [] },
      included: [], boundaries: [], exclusions: [], unresolved: [] },
    claims: [], functions: [], dependency_contracts: [], probes: [],
    independent_review_gaps: [], coverage: { claims: 0 },
    blockers: [{ kind: "missing_function_drafts" }],
  };
  const dossierArtifact = await put(dossier);
  const response = await fetch(`${base}/api/native-specs`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dossier_artifact: dossierArtifact }) });
  assert.equal(response.status, 200);
  const draftResult = await response.json();
  assert.equal(draftResult.spec.status, "draft");
  assert.deepEqual(draftResult.spec.requirements, []);
  assert.deepEqual(draftResult.spec.examples, []);
  const adaptDraft = await fetch(`${base}/api/native-specs/adapt`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact: draftResult.artifact }) });
  assert.equal(adaptDraft.status, 400);
  const publicSpec = { schema: 2, kind: "native_subsystem_spec", status: "ready_for_review",
    title: "Counter behavior", purpose: "Count events.", boundary: "subsystem",
    interface: { inputs: ["An event."], outputs: ["The count."], state: ["A count."] },
    requirements: [{ id: "REQ-1", statement: "Each event increases the count." }],
    behavior_steps: ["Count each event."],
    examples: [{ name: "once", input: { value: 1 }, expected_output: { count: 1 } }],
    acceptance_criteria: ["One event yields one."], deviations: [], exclusions: [] };
  const artifact = await put(publicSpec);
  const fetched = await fetch(`${base}/api/native-specs/${artifact}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), publicSpec);
  const unsafeArtifact = await put({ ...publicSpec, behavior_steps: ["MOVAPS XMM0, 0x00100000"] });
  assert.equal((await fetch(`${base}/api/native-specs/${unsafeArtifact}`)).status, 500);
  const stored = path.join(state, "artifacts", artifact.slice(0, 2), artifact);
  await fs.writeFile(stored, "tampered");
  assert.equal((await fetch(`${base}/api/native-specs/${artifact}`)).status, 500);
});

test("native API rejects malformed artifact identities", async () => {
  const response = await fetch(`${base}/api/native-specs`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dossier_artifact: "../other" }) });
  assert.equal(response.status, 400);
  assert.equal((await fetch(`${base}/api/native-specs/bad`)).status, 400);
});

test("POST /api/native-specs/adapt converts valid native spec to valid FeatureSpec with all guarantees", async () => {
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

  // 1. Adapt via direct spec payload
  const res = await fetch(`${base}/api/native-specs/adapt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spec: sampleNativeSpec,
      feature_id: "mockpriority.priority_score",
      binary_sha256: "b".repeat(64),
      campaign: dummyHash,
      dossier_artifact: "d".repeat(64),
    }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { spec: FeatureSpec };
  
  // A. valid native spec -> valid FeatureSpec (validates against Zod schema)
  const parsed = FeatureSpec.parse(data.spec);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.feature_id, "mockpriority.priority_score");

  // B. requirements are preserved
  assert.equal(parsed.requirements.length, 2);
  assert.equal(parsed.requirements[0].id, "REQ-1");
  assert.equal(parsed.requirements[0].statement, "Score must be non-negative and capped at 200.");
  assert.equal(parsed.requirements[0].kind, "invariant");
  assert.equal(parsed.requirements[1].id, "REQ-2");

  // C. interface is valid
  assert.ok(parsed.interface.module_name.length > 0);
  assert.ok(parsed.interface.exports.length > 0);

  // D. acceptance tests are valid
  assert.ok(parsed.acceptance_tests.length > 0);
  assert.ok(parsed.acceptance_tests.includes('test("REQ-1:'));
  assert.ok(parsed.acceptance_tests.includes('test("REQ-2:'));

  // E. oracle is strictly not_executable
  assert.equal(parsed.oracle.status, "not_executable");
  assert.equal(parsed.oracle.adapter_code, null);
  assert.deepEqual(parsed.oracle.tests, []);

  // F. provenance is preserved
  assert.equal(parsed.provenance.target.sha256, "b".repeat(64));
  assert.equal(parsed.provenance.target.artifact_type, "native_elf");
  assert.ok(parsed.provenance.limitations.some((l) => l.includes("d".repeat(64))));
  assert.ok(parsed.provenance.limitations.some((l) => l.includes(dummyHash)));

  // G. raw native pseudocode is not included in generated implementation-facing content
  const promptFacingContent = JSON.stringify({
    requirements: parsed.requirements,
    interface: parsed.interface,
    tests: parsed.acceptance_tests,
  });
  assert.equal(promptFacingContent.includes("Ghidra"), false);
  assert.equal(promptFacingContent.includes("decompiler"), false);
  assert.equal(promptFacingContent.includes("ptr"), false);
  assert.equal(promptFacingContent.includes("0x4012A0"), false);

  // 2. Adapt via stored artifact digest
  const specArtifact = await put(sampleNativeSpec);
  const res2 = await fetch(`${base}/api/native-specs/adapt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact: specArtifact }),
  });
  assert.equal(res2.status, 200);
  const data2 = (await res2.json()) as { spec: FeatureSpec };
  assert.equal(data2.spec.feature_id, "native.taskpriorityscoringsubsystem");

  // 3. GET /api/native-specs lists stored specs
  const listRes = await fetch(`${base}/api/native-specs`);
  assert.equal(listRes.status, 200);
  const listData = (await listRes.json()) as { specs: Array<{ artifact: string; spec: NativeSubsystemSpec }> };
  assert.ok(listData.specs.some((s) => s.artifact === specArtifact));

  // 4. Error cases
  const badRes = await fetch(`${base}/api/native-specs/adapt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact: "0".repeat(64) }), // nonexistent artifact
  });
  assert.equal(badRes.status, 404);

  const invalidRes = await fetch(`${base}/api/native-specs/adapt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spec: { invalid: true } }),
  });
  assert.equal(invalidRes.status, 400);
});
