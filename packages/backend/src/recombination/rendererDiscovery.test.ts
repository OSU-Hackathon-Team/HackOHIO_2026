import assert from "node:assert/strict";
import { test } from "node:test";
import { rendererDraftProblems } from "./rendererDiscovery.js";

test("renderer drafts require existing successful UI evidence, not only fixture or host inputs", () => {
  const observations = [
    { id: 1, action: { fixture: "note.md" }, result: { path: "/workspace/note.md" } },
    { id: 2, action: { host_input: "confirm" }, result: { focused_window: "Editor" } },
    { id: 3, action: { action: "click" }, result: { error: "Target closed" } },
    { id: 4, action: { action: "snapshot" }, result: { rendered: "<h1>Title</h1>" } },
  ];
  const draft = (ids: number[]) => ({ summary: "Observed heading", requirements: [{ id: "R1", statement: "A heading produces h1", observation_ids: ids }], blockers: [] });
  assert.match(rendererDraftProblems(draft([99]), observations).join(), /missing/);
  assert.match(rendererDraftProblems(draft([1, 2, 3]), observations).join(), /no successful UI/);
  assert.deepEqual(rendererDraftProblems(draft([4]), observations), []);
  const duplicate = draft([4]); duplicate.requirements.push(duplicate.requirements[0]);
  assert.match(rendererDraftProblems(duplicate, observations).join(), /duplicated/);
});
