import assert from "node:assert/strict";
import { test } from "node:test";
import { type NativeDraft, nativeDraftProblems } from "./nativeDraft.js";

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
  assert.match(nativeDraftProblems({ ...draft, behavior_steps: ["counter += 1"] }, ["C1"]).join(), /source-like/);
  assert.match(nativeDraftProblems({ ...draft, behavior_steps: ["Unknown whether it changes state."] }, ["C1"]).join(), /report-card/);
});
