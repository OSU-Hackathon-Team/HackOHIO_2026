import assert from "node:assert/strict";
import { test } from "node:test";
import { replayRendererTrace, type RendererReplaySource } from "./rendererReplay.js";

const source: RendererReplaySource = { task: "Render a heading", archive_sha256: "a".repeat(64), workspace_root: "/old",
  requirements: [{ id: "heading", observation_ids: [2] }], observations: [
    { id: 1, action: { action: "startup" }, result: { title: "Editor", text: "Workspace /old" } },
    { id: 2, action: { action: "fill", selector: "@1", value: "# Title" }, result: { title: "Editor", rendered: "<h1>Title</h1>" } },
  ] };

test("original replay preserves expectations, normalizes workspace roots, and checks requirement coverage", async () => {
  const passed = await replayRendererTrace(source, "/fresh", { title: "Editor", text: "Workspace /fresh" },
    async () => ({ title: "Editor", rendered: "<h1>Title</h1>" }), () => {});
  assert.equal(passed.status, "passed");
  assert.equal(passed.implementation_ready, false);
  const mismatch = await replayRendererTrace(source, "/fresh", { title: "Editor", text: "Workspace /fresh" },
    async () => ({ title: "Editor", rendered: "<p>Title</p>" }), () => {});
  assert.equal(mismatch.status, "failed");
  assert.deepEqual(mismatch.requirement_coverage[0].verified_observation_ids, []);
  const missing = await replayRendererTrace({ ...source, requirements: [{ id: "unobserved", observation_ids: [99] }] }, "/fresh",
    { title: "Editor", text: "Workspace /fresh" }, async () => ({ title: "Editor", rendered: "<h1>Title</h1>" }), () => {});
  assert.equal(missing.status, "failed");
});
