import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { NativeSubsystemSpec, FeatureSpec } from "@splice/contracts";
import { adaptNativeSpecToFeatureSpec } from "./nativeAdapter.js";

describe("NativeSubsystemSpec -> FeatureSpec Adapter", () => {
  const dummyHash = "a".repeat(64);
  const sampleNativeSpec: NativeSubsystemSpec = {
    schema: 2,
    kind: "native_subsystem_spec",
    status: "ready_for_review",
    title: "Task Priority Scoring Subsystem",
    purpose: "Calculates priority score from task due dates, urgency, and importance.",
    boundary: "subsystem",
    interface: {
      inputs: ["TaskView struct with due date, completion status, and importance"],
      outputs: ["Calculated priority score as non-negative integer"],
      state: ["No persistent state between calculations"],
    },
    requirements: [
      {
        id: "REQ-1",
        statement: "Completed tasks score 0 regardless of due date or importance.",
      },
      {
        id: "REQ-2",
        statement: "Overdue tasks gain 40 points per complete day late, capped at 120.",
      },
    ],
    behavior_steps: [
      "Check if task is completed; if so return 0.",
      "Calculate overdue days and urgency points, capping at 120.",
    ],
    examples: [
      {
        name: "completed_task_zero",
        input: { completed: true, importance: 3 },
        expected_output: 0,
      },
      {
        name: "overdue_task_capped",
        input: { completed: false, days_overdue: 4 },
        expected_output: 120,
      },
    ],
    acceptance_criteria: [
      "Completed tasks evaluate to 0.",
      "Urgency contribution does not exceed 120.",
    ],
    deviations: [],
    exclusions: [],
  };

  const sampleWithProvenance: NativeSubsystemSpec = {
    ...sampleNativeSpec,
    ...({
      campaign: dummyHash,
      binary_sha256: "b".repeat(64),
      provenance: {
        dossier_artifact: "d".repeat(64),
        scope_artifact: "s".repeat(64),
      },
    } as any),
  };

  test("converts a valid NativeSubsystemSpec into a valid FeatureSpec", () => {
    const adapted = adaptNativeSpecToFeatureSpec(sampleWithProvenance, {
      feature_id: "mockpriority.priority_score",
      app_id: "mockpriority",
    });

    const parsed = FeatureSpec.parse(adapted);
    assert.equal(parsed.feature_id, "mockpriority.priority_score");
    assert.equal(parsed.app_id, "mockpriority");
    assert.equal(parsed.schema_version, 1);
  });

  test("preserves all native requirements and correctly infers kinds", () => {
    const adapted = adaptNativeSpecToFeatureSpec(sampleWithProvenance);

    assert.equal(adapted.requirements.length, 2);
    assert.equal(adapted.requirements[0].id, "REQ-1");
    assert.equal(adapted.requirements[0].statement, "Completed tasks score 0 regardless of due date or importance.");
    assert.equal(adapted.requirements[0].kind, "edge_case"); // "0" -> edge_case

    assert.equal(adapted.requirements[1].id, "REQ-2");
    assert.equal(adapted.requirements[1].statement, "Overdue tasks gain 40 points per complete day late, capped at 120.");
    assert.equal(adapted.requirements[1].kind, "invariant"); // "capped at" -> invariant
  });

  test("creates a valid TypeScript InterfaceSpec without leaking C types", () => {
    const adapted = adaptNativeSpecToFeatureSpec(sampleWithProvenance);

    assert.ok(adapted.interface.exports.length > 0);
    const exp = adapted.interface.exports[0];
    assert.equal(exp.kind, "function");
    assert.ok(exp.name.length > 0);
    assert.ok(adapted.interface.types_code.includes("export declare function"));
  });

  test("generates acceptance tests anchored to requirement IDs", () => {
    const adapted = adaptNativeSpecToFeatureSpec(sampleWithProvenance);

    assert.ok(adapted.acceptance_tests.includes("REQ-1:"));
    assert.ok(adapted.acceptance_tests.includes("REQ-2:"));
    assert.equal(adapted.coverage.length, 2);
    assert.ok(adapted.coverage[0].test_names.length > 0);
    assert.ok(adapted.coverage[1].test_names.length > 0);
  });

  test("sets oracle strictly to not_executable with 0 passed / 0 total", () => {
    const adapted = adaptNativeSpecToFeatureSpec(sampleWithProvenance);

    assert.deepEqual(adapted.oracle, {
      status: "not_executable",
      adapter_code: null,
      tests: [],
      passed: 0,
      total: 0,
    });
  });

  test("preserves provenance (binary SHA256, campaign, dossier artifact)", () => {
    const adapted = adaptNativeSpecToFeatureSpec(sampleWithProvenance);

    assert.equal(adapted.provenance.target.sha256, "b".repeat(64));
    assert.ok(adapted.provenance.limitations.some((l) => l.includes("d".repeat(64))));
    assert.ok(adapted.provenance.limitations.some((l) => l.includes(dummyHash)));
    assert.equal(adapted.provenance.mode, "replay");
  });

  test("CRITICAL: strictly avoids leaking raw decompiler pseudocode into implementation content", () => {
    const specWithPseudocode = {
      ...sampleWithProvenance,
      raw_pseudocode: "void score_task_priority() { uint64_t *ptr = (uint64_t *)0x4012A0; }",
      decompilation: "int score_task_priority(TaskView *task) { asm volatile(\"movq %rax, %rbx\"); }",
    };

    const adapted = adaptNativeSpecToFeatureSpec(specWithPseudocode as any);

    const serialized = JSON.stringify({
      requirements: adapted.requirements,
      interface: adapted.interface,
      inputs: adapted.inputs,
      outputs: adapted.outputs,
      acceptance_tests: adapted.acceptance_tests,
      snippets: adapted.provenance.snippets,
    });

    assert.ok(!serialized.includes("uint64_t"));
    assert.ok(!serialized.includes("0x4012A0"));
    assert.ok(!serialized.includes("asm volatile"));
    assert.equal(adapted.provenance.snippets.length, 0);
  });
});
