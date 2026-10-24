import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { NativeSubsystemSpec, FeatureSpec } from "@splice/contracts";
import { adaptNativeSpecToFeatureSpec } from "./nativeAdapter.js";

describe("NativeSubsystemSpec -> FeatureSpec Adapter", () => {
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
      included: [
        { entry: "004012a0", name: "score_task_priority" },
        { entry: "00401220", name: "urgency_bucket" },
      ],
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
        statement: "Completed tasks score 0 regardless of due date or importance.",
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
        statement: "Overdue tasks gain 40 points per complete day late, capped at 120.",
        evidence: [{ artifact: dummyHash, address: "004012a8" }],
        assumptions: [],
        alternatives: [],
        review_state: "supported_static",
        reviews: [{ outcome: "supported_static", model: "independent-reviewer" }],
        execution_state: "case_agreement",
        probe_links: [{ case_id: "overdue_capped", agreement: true }],
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

  test("valid native spec -> valid FeatureSpec adhering to Zod schema", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec, {
      appId: "mockpriority",
      featureId: "mockpriority.priority_score",
      category: "utility",
    });

    const parsed = FeatureSpec.safeParse(featureSpec);
    assert.ok(parsed.success, `FeatureSpec failed validation: ${parsed.error?.message}`);
    assert.equal(featureSpec.schema_version, 1);
    assert.equal(featureSpec.feature_id, "mockpriority.priority_score");
    assert.equal(featureSpec.app_id, "mockpriority");
  });

  test("requirements are preserved with correct IDs and source references", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec);

    assert.equal(featureSpec.requirements.length, 2);
    assert.equal(featureSpec.requirements[0].id, "REQ-1");
    assert.equal(
      featureSpec.requirements[0].statement,
      "Completed tasks score 0 regardless of due date or importance."
    );
    assert.deepEqual(featureSpec.requirements[0].source_refs, ["004012a0@004012a0"]);

    assert.equal(featureSpec.requirements[1].id, "REQ-2");
    assert.equal(featureSpec.requirements[1].kind, "invariant");
  });

  test("interface is valid TypeScript declaration with module name and exports", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec);

    assert.ok(/^[a-z][A-Za-z0-9]*$/.test(featureSpec.interface.module_name));
    assert.ok(featureSpec.interface.exports.length >= 1);
    assert.ok(featureSpec.interface.types_code.includes("declare function"));
  });

  test("acceptance tests cover every requirement and match required test() pattern", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec);

    assert.ok(featureSpec.acceptance_tests.includes('test("REQ-1:'));
    assert.ok(featureSpec.acceptance_tests.includes('test("REQ-2:'));

    assert.equal(featureSpec.coverage.length, 2);
    assert.ok(featureSpec.coverage.every((c) => c.test_names.length > 0));
  });

  test("native oracle status is strictly not_executable with null adapter", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec);

    assert.deepEqual(featureSpec.oracle, {
      status: "not_executable",
      adapter_code: null,
      tests: [],
      passed: 0,
      total: 0,
    });
  });

  test("native provenance is preserved", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec);

    assert.equal(featureSpec.provenance.target.sha256, sampleNativeSpec.binary_sha256);
    assert.equal(featureSpec.provenance.target.artifact_type, "native_elf");
    assert.ok(
      featureSpec.provenance.limitations.some((l) =>
        l.includes(`Dossier artifact: ${sampleNativeSpec.provenance.dossier_artifact}`)
      )
    );
    assert.ok(
      featureSpec.provenance.limitations.some((l) =>
        l.includes(`Campaign: ${sampleNativeSpec.campaign}`)
      )
    );
  });

  test("CRITICAL: raw native pseudocode is not leaked into prompt-facing fields", () => {
    const featureSpec = adaptNativeSpecToFeatureSpec(sampleNativeSpec);
    const jsonStr = JSON.stringify(featureSpec);

    // The raw decompiler snippet must NOT be present
    assert.ok(
      !jsonStr.includes("return task->completed ? 0 : 42;"),
      "Raw decompiler pseudocode must not be present in FeatureSpec"
    );
    assert.equal(featureSpec.provenance.snippets.length, 0);
  });
});
