import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { createBuilderRouter } from "./edits.js";
import type { structuredCall } from "../llm/llm.js";
import { BuilderEditResponse } from "@splice/contracts";

async function server(call: typeof structuredCall, run: (post: (body: unknown) => Promise<Response>) => Promise<void>) {
  const app = express(); app.use(express.json()); app.use(createBuilderRouter(call));
  const instance = app.listen(0,"127.0.0.1"); await new Promise<void>(resolve => instance.once("listening",resolve));
  try { await run(body => fetch(`http://127.0.0.1:${(instance.address() as AddressInfo).port}/api/builder/edits`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); }
  finally { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); }
}
const request = { revision: 7, instruction: "Add an intro", selectedBlockId: null, featureIds: [], layout: [] };
const block = { id: "intro", kind: "text", title: "Welcome", description: "Study", visible: true, width: "full" };
test("builder endpoint validates requests before calling the model", async () => {
  let calls = 0;
  await server((async () => { calls++; throw Error("Should not call"); }) as typeof structuredCall, async post => {
    for (const body of [{}, { ...request, featureIds: ["cloud-sync"] }, { ...request, selectedBlockId: "gone" }, { ...request, layout: [{ ...block, kind: "reviews" }] }]) assert.equal((await post(body)).status,400);
  }); assert.equal(calls,0);
});
test("builder returns validated atomic edits with answering model and revision", async () => {
  await server((async opts => {
    assert.equal(opts.role,"ui_synthesizer"); assert.ok(opts.signal); assert.equal(opts.maxTokens,4000);
    const value = opts.parse({ summary: "Added an introduction", operations: [{ type: "add", blockId: "intro", index: 0, block }] });
    return { value, model: "qwen-test", assistantContent: [], usage: { input_tokens: 1, output_tokens: 1 } };
  }) as typeof structuredCall, async post => {
    const response = await post(request); assert.equal(response.status,200);
    const result = BuilderEditResponse.parse(await response.json()); assert.equal(result.revision,7); assert.equal(result.model,"qwen-test"); assert.equal(result.operations[0].block?.title,"Welcome");
  });
});
test("invalid model edits and upstream failures return errors without a partial layout", async () => {
  for (const call of [async () => { throw Error("Upstream unavailable"); }, async () => ({ value: { summary: "bad", operations: [{ type: "add", blockId: "intro", index: 0, block: { ...block, kind: "reviews" } }] }, model: "test" })]) {
    await server(call as unknown as typeof structuredCall, async post => { const response = await post(request); assert.equal(response.status,502); const result = await response.json() as { error?: string; operations?: unknown }; assert.ok(result.error); assert.equal(result.operations,undefined); });
  }
});
