import test from "node:test";
import assert from "node:assert/strict";
import type { DecompRunEvent, NativeSubsystemSpec } from "@splice/contracts";
import { applyDecompEvent, initialRunView, liveNativeTargetId, nativeSpecToLibrary } from "../src/ide/data/liveNative";

const spec = (status: NativeSubsystemSpec["status"]): NativeSubsystemSpec => ({
  schema: 2, kind: "native_subsystem_spec", status, title: "Calc formula evaluation",
  purpose: "Evaluate spreadsheet formulas.", boundary: "subsystem",
  interface: { inputs: ["A formula."], outputs: ["A value or error."], state: [] },
  requirements: [{ id: "REQ-1", statement: "Multiplication binds tighter than addition." }],
  behavior_steps: ["Parse, then evaluate."],
  examples: [{ name: "precedence", input: "=1+2*3", expected_output: { value: 7 } }],
  acceptance_criteria: ["=1+2*3 evaluates to 7."], deviations: [], exclusions: [],
});

test("a draft live spec becomes a native library entry that needs review", () => {
  const artifact = "ab".repeat(32);
  const { target, feature } = nativeSpecToLibrary(artifact, spec("draft"));
  assert.equal(target.id, liveNativeTargetId(artifact));
  assert.equal(target.engineKind, "ghidra_native");
  assert.equal(target.nativeSpec?.status, "draft");
  assert.equal(feature.targetId, target.id);
  assert.equal(feature.readiness, "needs_review");
  assert.equal(feature.friendlyStatusLabel, "Needs Review");
  assert.equal(feature.plainRules[0].explanation, "Multiplication binds tighter than addition.");
});

test("a ready_for_review spec is offered as usable", () => {
  const { feature } = nativeSpecToLibrary("cd".repeat(32), spec("ready_for_review"));
  assert.equal(feature.readiness, "sample");
  assert.equal(feature.friendlyStatusLabel, "Ready to Use");
});

test("run events fold into the run view in order", () => {
  const base = { run_id: "run-1", ts: 1 };
  const events: DecompRunEvent[] = [
    { ...base, type: "stage", stage: "claims", message: "40 functions" },
    { ...base, type: "progress", label: "drafted", done: 3, total: 40 },
    { ...base, type: "progress", label: "reviewed", done: 1, total: 40 },
    { ...base, type: "log", line: "[claims] 40 functions, 2 workers" },
    { ...base, type: "error", message: "worker lost", fatal: true },
    { ...base, type: "done", ok: false },
  ];
  const view = events.reduce(applyDecompEvent, initialRunView("run-1"));
  assert.deepEqual(view.drafted, { done: 3, total: 40 });
  assert.deepEqual(view.reviewed, { done: 1, total: 40 });
  assert.deepEqual(view.log, ["[claims] 40 functions, 2 workers"]);
  assert.equal(view.error, "worker lost");
  assert.equal(view.finished, true);
  assert.equal(view.stage, "failed");
});
