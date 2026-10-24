import assert from "node:assert/strict";
import { test } from "node:test";
import { type NativeDraft, nativeDraftProblems } from "./nativeDraft.js";
import { publicSpecContainsSource } from "./nativeSafety.js";

const draft: NativeDraft = {
  title: "Counter behavior", purpose: "Count accepted inputs.",
  interface: { inputs: ["An accepted input."], outputs: ["The count."], state: ["Current count."] },
  requirements: [{ id: "REQ-1", statement: "Each input increases the count by one.", claim_ids: ["C1"] }],
  behavior_steps: ["Update the count for each input."],
  acceptance_criteria: ["One input yields one."], deviations: [], exclusions: [],
};

test("native spec draft gate requires all facts and excludes code and report text", () => {
  assert.deepEqual(nativeDraftProblems(draft, ["C1"]), []);
  assert.match(nativeDraftProblems(draft, ["C1", "C2"]).join(), /C2/);
  assert.match(nativeDraftProblems({ ...draft, requirements: [{ ...draft.requirements[0], claim_ids: [] }] }, ["C1"]).join(), /no supporting claim/);
  assert.match(nativeDraftProblems({ ...draft, behavior_steps: ["MOVAPS XMM0, 0x00100000"] }, ["C1"]).join(), /source-like/);
  assert.match(nativeDraftProblems({ ...draft, behavior_steps: ["MOVAPS XMM0, 0x00100000"] }, ["C1"]).join(), /behavior_steps\[0\]/);
  assert.match(nativeDraftProblems({ ...draft, behavior_steps: ["counter += 1"] }, ["C1"]).join(), /source-like/);
  assert.match(nativeDraftProblems({ ...draft, interface: { ...draft.interface, inputs: ["value: uint32"] } }, ["C1"]).join(), /interface.inputs\[0\]/);
  assert.match(nativeDraftProblems({ ...draft, exclusions: ["No input validation."] }, ["C1"], { excluded_behavior: [] }).join(), /no supplied boundary facts/);
  assert.match(nativeDraftProblems({ ...draft, behavior_steps: ["Unknown whether it changes state."] }, ["C1"]).join(), /report-card/);
});

test("public spec allows executable observations but rejects code in example data", () => {
  const spec = { title: "Policy limit", examples: [{ name: "boundary_case",
    input_description: "Original executable CLI arguments: kind, value, flags.",
    input: ["1", "1023", "0"], expected_output: { stdout: "result=1023 seen=1", exit_code: 0 } }] };
  assert.equal(publicSpecContainsSource(spec), false);
  assert.equal(publicSpecContainsSource({ ...spec, examples: [{ ...spec.examples[0],
    expected_output: { stdout: "function copied() { return 1; }" } }] }), true);
});
