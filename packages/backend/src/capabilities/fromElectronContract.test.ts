import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapabilityIntakeRequest, ReviewAttestation } from "@splice/contracts";
import { getAuthoredNotebookIntakes } from "../example/notebook.js";
import { fromElectronContract } from "./fromElectronContract.js";
import { hashJson } from "./identity.js";
import { assessCapabilityIntake } from "./intake.js";
import { FilesystemCapabilityRegistry } from "./registry.js";

const approvedAt = "2026-10-28T00:00:00.000Z";

/** A synthetic handoff: it exercises the gate and is not a reconstruction result for any app. */
function fixture(blockers: string[] = []) {
  const base = structuredClone(getAuthoredNotebookIntakes()[0].request);
  const spec = {
    schema_version: 2,
    application: { name: "fixture-app", scope: ["Evaluate one bounded formula through its IPC channel"], blockers },
    channels: {
      "evaluate-formula": { feature: "features/formula.cjs", requirements: ["Returns the arithmetic value of the formula text"] },
    },
  };
  base.definition.origin = {
    kind: "electron_contract",
    artifact_hash: hashJson(spec),
    artifact_ref: "electron/fixture@2",
    source_app: "fixture-app",
    stage: "electron_reconstruction",
  };
  const attestation: ReviewAttestation = {
    status: "approved",
    reviewer: "fixture reviewer",
    reviewed_at: approvedAt,
    artifact_hash: hashJson(spec),
    notes: ["Synthetic fixture approval"],
  };
  return { base, spec, attestation };
}

function codes(request: CapabilityIntakeRequest): string[] {
  return assessCapabilityIntake(request).record.blockers.map((item) => item.code);
}

test("an approved Electron handoff enters intake with its channel mapping", () => {
  const { base, spec, attestation } = fixture();
  const adapted = fromElectronContract(spec, base.definition, { "evaluate-formula": "evaluate" }, base.implementation, base.public_tests, attestation);
  const assessed = assessCapabilityIntake(adapted);
  assert.equal(assessed.record.accepted, true);
  assert.equal(assessed.record.readiness.upstream_review.status, "passed");
  assert.equal(assessed.record.origin_artifact_hash, hashJson(spec));
});

test("an unapproved, blocked or re-pinned Electron handoff is refused", () => {
  const { base, spec, attestation } = fixture();
  assert.throws(() => fromElectronContract(spec, base.definition, { "evaluate-formula": "evaluate" }, base.implementation, base.public_tests, null), /review approval must be explicit/);
  assert.throws(
    () => fromElectronContract(spec, base.definition, { "evaluate-formula": "evaluate" }, base.implementation, base.public_tests, { ...attestation, artifact_hash: hashJson({ changed: true }) }),
    /review approval must be explicit/,
  );
  assert.throws(() => fromElectronContract(fixture(["the persisted default is unspecified"]).spec, base.definition, { "evaluate-formula": "evaluate" }, base.implementation, base.public_tests, attestation), /unresolved readiness blockers/);

  const unapproved: CapabilityIntakeRequest = {
    ...fromElectronContract(spec, base.definition, { "evaluate-formula": "evaluate" }, base.implementation, base.public_tests, attestation),
    review_attestation: null,
  };
  assert.ok(codes(unapproved).includes("electron_review_required"));
  const blocked = fixture(["the persisted default is unspecified"]);
  blocked.base.definition.origin.artifact_hash = hashJson(blocked.spec);
  const blockedRequest: CapabilityIntakeRequest = {
    ...unapproved,
    definition: blocked.base.definition,
    origin_artifact: blocked.spec,
    review_attestation: { ...attestation, artifact_hash: hashJson(blocked.spec) },
  };
  assert.ok(codes(blockedRequest).includes("electron_spec_blocked"));
  assert.ok(codes({ ...blockedRequest, origin_artifact: { ...spec, application: { ...spec.application, name: "other-app" } } }).includes("origin_metadata_mismatch"));
});

test("every declared channel needs exactly one operation and no more", () => {
  const { base, spec, attestation } = fixture();
  const adapt = (mapping: Record<string, string>, definition = base.definition) =>
    fromElectronContract(spec, definition, mapping, base.implementation, base.public_tests, attestation);
  assert.throws(() => adapt({}), /Channel evaluate-formula has no declared capability operation/);
  assert.throws(() => adapt({ "evaluate-formula": "evaluate", "render-note": "evaluate" }), /channel render-note the handoff does not declare/);
  assert.throws(() => adapt({ "evaluate-formula": "missing" }), /maps to undeclared operation missing/);
  const extraOperation = structuredClone(base.definition);
  extraOperation.operations.push({ ...extraOperation.operations[0], name: "unused" });
  assert.throws(() => adapt({ "evaluate-formula": "evaluate" }, extraOperation), /Operation unused does not answer a declared handoff channel/);
  const twoChannels = { ...spec, channels: { "evaluate-formula": spec.channels["evaluate-formula"], "second-channel": spec.channels["evaluate-formula"] } };
  const twoChannelDefinition = structuredClone(base.definition);
  twoChannelDefinition.origin.artifact_hash = hashJson(twoChannels);
  assert.throws(
    () => fromElectronContract(twoChannels, twoChannelDefinition, { "evaluate-formula": "evaluate", "second-channel": "evaluate" }, base.implementation, base.public_tests, { ...attestation, artifact_hash: hashJson(twoChannels) }),
    /cannot answer the same operation/,
  );
});

test("an Electron-origin intake is stored beside an authored one in one registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-electron-registry-"));
  try {
    const { base, spec, attestation } = fixture();
    const requests = [
      fromElectronContract(spec, base.definition, { "evaluate-formula": "evaluate" }, base.implementation, base.public_tests, attestation),
      structuredClone(getAuthoredNotebookIntakes()[0].request),
    ];
    const registry = new FilesystemCapabilityRegistry(root);
    for (const request of requests) {
      const assessed = assessCapabilityIntake(request);
      assert.equal(assessed.record.accepted, true);
      await registry.putOriginArtifact(assessed.record.origin_artifact_hash, assessed.originArtifact);
      await registry.putIntake(assessed.record);
      assert.equal((await registry.getIntake(assessed.record.intake_id))?.origin_artifact_hash, assessed.record.origin_artifact_hash);
    }
    assert.equal((await registry.listIntakes()).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a handoff that declares and excludes the same channel is not a contract", () => {
  const { spec } = fixture();
  assert.throws(
    () => fromElectronContract({ ...spec, channel_exclusions: [{ channel: "evaluate-formula", reason: "host-dependent" }] }, structuredClone(getAuthoredNotebookIntakes()[0].request.definition), { "evaluate-formula": "evaluate" }, { kind: "typescript", entry: "a.ts", files: [{ path: "a.ts", content: "export {};", encoding: "utf8" }] }, [], null),
    /declared and excluded at the same time/,
  );
});
