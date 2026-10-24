import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  Pantry,
  RawEvidence,
  FeatureSpec,
  FeatureBlueprint,
  PipelineEvent,
  SynthesisBundle,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures/hand-authored");

function readJson<T>(relativePath: string): T {
  const fullPath = path.join(REPO_ROOT, relativePath);
  assert.ok(fs.existsSync(fullPath), `Fixture file not found: ${fullPath}`);
  const raw = fs.readFileSync(fullPath, "utf-8");
  return JSON.parse(raw) as T;
}

describe("Pantry Manifest Validation", () => {
  it("successfully parses targets/manifest.json through Pantry schema", () => {
    const data = readJson("targets/manifest.json");
    const parsed = Pantry.parse(data);
    assert.ok(parsed.apps.length >= 2);
    const appIds = parsed.apps.map((a) => a.app_id);
    assert.ok(appIds.includes("inkwell"));
    assert.ok(appIds.includes("recall"));
  });
});

describe("Hand-Authored RawEvidence Fixtures", () => {
  it("validates recall.sm2_scheduler RawEvidence fixture", () => {
    const data = readJson("fixtures/hand-authored/evidence/recall.sm2_scheduler.json");
    const parsed = RawEvidence.parse(data);
    assert.equal(parsed.feature_id, "recall.sm2_scheduler");
    assert.equal(parsed.target.artifact_type, "electron_asar");
    assert.ok(parsed.snippets.length >= 1);
    assert.ok(parsed.tool_calls.length >= 1);
  });

  it("validates inkwell.wikilink_graph RawEvidence fixture", () => {
    const data = readJson("fixtures/hand-authored/evidence/inkwell.wikilink_graph.json");
    const parsed = RawEvidence.parse(data);
    assert.equal(parsed.feature_id, "inkwell.wikilink_graph");
    assert.equal(parsed.target.artifact_type, "electron_asar");
    assert.ok(parsed.snippets.length >= 2);
    assert.ok(parsed.tool_calls.length >= 1);
  });
});

describe("Hand-Authored FeatureSpec Fixtures", () => {
  it("validates recall.sm2_scheduler FeatureSpec fixture", () => {
    const data = readJson("fixtures/hand-authored/specs/recall.sm2_scheduler.json");
    const parsed = FeatureSpec.parse(data);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.feature_id, "recall.sm2_scheduler");
    assert.equal(parsed.interface.module_name, "sm2Scheduler");
    assert.ok(parsed.requirements.length >= 5);
    assert.equal(parsed.oracle.status, "passed");
    assert.equal(parsed.status, "verified");
  });

  it("validates inkwell.wikilink_graph FeatureSpec fixture", () => {
    const data = readJson("fixtures/hand-authored/specs/inkwell.wikilink_graph.json");
    const parsed = FeatureSpec.parse(data);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.feature_id, "inkwell.wikilink_graph");
    assert.equal(parsed.interface.module_name, "wikilinkGraph");
    assert.ok(parsed.requirements.length >= 5);
    assert.equal(parsed.oracle.status, "passed");
    assert.equal(parsed.status, "verified");
  });
});

describe("Hand-Authored FeatureBlueprint Fixtures", () => {
  it("validates recall.sm2_scheduler FeatureBlueprint fixture", () => {
    const data = readJson("fixtures/hand-authored/blueprints/recall.sm2_scheduler.json");
    const parsed = FeatureBlueprint.parse(data);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.feature_id, "recall.sm2_scheduler");
    assert.equal(parsed.implementation.module_name, "sm2Scheduler");
    assert.equal(parsed.verification.status, "passed");
    assert.ok(parsed.implementation.portable_code.includes("scheduleReview"));
  });

  it("validates inkwell.wikilink_graph FeatureBlueprint fixture", () => {
    const data = readJson("fixtures/hand-authored/blueprints/inkwell.wikilink_graph.json");
    const parsed = FeatureBlueprint.parse(data);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.feature_id, "inkwell.wikilink_graph");
    assert.equal(parsed.implementation.module_name, "wikilinkGraph");
    assert.equal(parsed.verification.status, "passed");
    assert.ok(parsed.implementation.portable_code.includes("buildLinkGraph"));
  });
});

describe("Hand-Authored PipelineEvent Transcript Fixtures", () => {
  const TranscriptSchema = z.array(PipelineEvent);

  it("validates recall.sm2_scheduler transcript events", () => {
    const data = readJson("fixtures/hand-authored/transcripts/recall.sm2_scheduler.json");
    const parsed = TranscriptSchema.parse(data);
    assert.ok(parsed.length >= 10);
    assert.equal(parsed[0].type, "stage");
    assert.equal(parsed[parsed.length - 1].type, "done");
  });

  it("validates inkwell.wikilink_graph transcript events", () => {
    const data = readJson("fixtures/hand-authored/transcripts/inkwell.wikilink_graph.json");
    const parsed = TranscriptSchema.parse(data);
    assert.ok(parsed.length >= 10);
    assert.equal(parsed[0].type, "stage");
    assert.equal(parsed[parsed.length - 1].type, "done");
  });
});

describe("Hand-Authored SynthesisBundle Fixture", () => {
  it("validates inkwell_recall_fusion SynthesisBundle fixture", () => {
    const data = readJson("fixtures/hand-authored/bundles/inkwell_recall_fusion.json");
    const parsed = SynthesisBundle.parse(data);
    assert.equal(parsed.bundle_id, "bundle_fusion_inkwell_recall_001");
    assert.deepEqual(parsed.feature_ids, [
      "inkwell.wikilink_graph",
      "recall.sm2_scheduler",
    ]);
    assert.ok(parsed.files["/App.tsx"]);
    assert.ok(parsed.files["/engines/wikilinkGraph.ts"]);
    assert.ok(parsed.files["/engines/sm2Scheduler.ts"]);
  });
});

describe("Strict Negative Schema Invariant Checks", () => {
  it("rejects FeatureSpec with invalid requirement IDs", () => {
    const data: any = readJson("fixtures/hand-authored/specs/recall.sm2_scheduler.json");
    const corrupted = {
      ...data,
      requirements: [
        {
          id: "INVALID_ID",
          kind: "behavior",
          statement: "broken",
          source_refs: ["test.js:L1"],
        },
      ],
    };
    assert.throws(() => FeatureSpec.parse(corrupted));
  });

  it("rejects RawEvidence with missing snippets", () => {
    const data: any = readJson("fixtures/hand-authored/evidence/recall.sm2_scheduler.json");
    const corrupted = { ...data, snippets: [] };
    assert.throws(() => RawEvidence.parse(corrupted));
  });

  it("rejects PipelineEvent with invalid event type discriminator", () => {
    const corrupted = {
      type: "unknown_event_type",
      run_id: "test",
      feature_id: "test.feat",
      ts: 12345,
    };
    assert.throws(() => PipelineEvent.parse(corrupted));
  });
});
