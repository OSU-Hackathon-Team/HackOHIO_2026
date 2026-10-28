import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapabilityIntakeRequest, NativeSubsystemSpec } from "@splice/contracts";
import { getAuthoredNotebookIntakes } from "../example/notebook.js";
import { hashJson } from "./identity.js";
import { assessCapabilityIntake } from "./intake.js";
import { fromNativeSpec } from "./fromNativeSpec.js";
import { FilesystemCapabilityRegistry, RegistryIntegrityError } from "./registry.js";
import { buildTypeScriptPackage } from "./tsBuilder.js";

function authored(): CapabilityIntakeRequest {
  return structuredClone(getAuthoredNotebookIntakes()[0].request);
}

function nativeRequest(status: NativeSubsystemSpec["status"], approved: boolean): CapabilityIntakeRequest {
  const request = authored();
  const artifact: NativeSubsystemSpec = {
    schema: 2, kind: "native_subsystem_spec", status, title: "Native formula fixture",
    purpose: "Exercise the public review gate", boundary: "subsystem",
    interface: { inputs: ["formula"], outputs: ["value"], state: [] },
    requirements: [{ id: "REQ-1", statement: "Return a formula value" }],
    behavior_steps: ["Read a formula and return its value"],
    examples: [{ name: "one", input: { formula: "=1" }, expected_output: { value: 1 } }],
    acceptance_criteria: ["Returns the expected value"], deviations: [], exclusions: [],
  };
  request.origin_artifact = artifact;
  request.definition.origin = {
    kind: "native_subsystem_spec", artifact_hash: hashJson(artifact), artifact_ref: "native/fixture@2",
    source_app: "fixture", stage: "native_spec",
  };
  request.review_attestation = approved
    ? { status: "approved", reviewer: "fixture reviewer", reviewed_at: "2026-10-27T00:00:00.000Z", artifact_hash: hashJson(artifact), notes: ["Fixture approval"] }
    : null;
  return request;
}

function codes(request: CapabilityIntakeRequest): string[] {
  return assessCapabilityIntake(request).record.blockers.map((item) => item.code);
}

test("intake rejects draft and unapproved review-ready native specs", () => {
  assert.ok(codes(nativeRequest("draft", false)).includes("native_spec_draft"));
  assert.ok(codes(nativeRequest("ready_for_review", false)).includes("native_review_required"));
});

test("a synthetic approved native-origin definition and an authored definition use one registry API", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-origin-registry-"));
  try {
    const native = nativeRequest("ready_for_review", true);
    const adapted = fromNativeSpec(native.origin_artifact, native.definition, native.implementation, native.public_tests, native.review_attestation);
    const registry = new FilesystemCapabilityRegistry(root);
    for (const request of [authored(), adapted]) {
      const assessed = assessCapabilityIntake(request);
      assert.equal(assessed.record.accepted, true);
      await registry.putOriginArtifact(assessed.record.origin_artifact_hash, assessed.originArtifact);
      await registry.putIntake(assessed.record);
      const loaded = await registry.getIntake(assessed.record.intake_id);
      assert.equal(loaded?.definition_hash, assessed.record.definition_hash);
    }
    assert.equal((await registry.listIntakes()).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("intake rejects no-op tests, mismatched origin bytes and undeclared effects", () => {
  const noOp = authored();
  noOp.public_tests[0].code = 'await ctx.call("evaluate", { formula: "=1", cells: {} }); ctx.assert.ok(true);';
  assert.ok(codes(noOp).includes("test_not_executable"));

  const tampered = authored();
  tampered.origin_artifact = { changed: true };
  assert.ok(codes(tampered).includes("origin_hash_mismatch"));

  const effect = authored();
  effect.definition.operations[0].host_effects.push("network" as never);
  assert.throws(() => assessCapabilityIntake(effect), /Invalid capability intake request/);
});

test("registry detects a changed package artifact on read", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-registry-tamper-"));
  try {
    const request = authored();
    const intake = assessCapabilityIntake(request);
    assert.equal(intake.record.accepted, true);
    const built = await buildTypeScriptPackage({
      intake_id: intake.record.intake_id,
      definition: intake.record.definition,
      implementation: request.implementation,
      public_tests: request.public_tests,
    }, { onStage() {} });
    const registry = new FilesystemCapabilityRegistry(root);
    await registry.putPackage(built.package, built.files);
    assert.ok(await registry.getPackage(built.package.package_id));
    const target = path.join(root, "packages", built.package.package_id, "definition.json");
    fs.appendFileSync(target, "\n");
    await assert.rejects(() => registry.getPackage(built.package.package_id), RegistryIntegrityError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
