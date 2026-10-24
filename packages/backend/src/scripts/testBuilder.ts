// Live Bedrock acceptance; deliberately excluded from deterministic CI.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { BuilderEditResponse, applyBuilderOperations, type BuilderBlock } from "@splice/contracts";
import { createBuilderRouter } from "../builder/edits.js";
import { spliceModel } from "../models.js";
import { formatLlmError } from "../llm/llm.js";

const app = express(); app.use(express.json()); app.use(createBuilderRouter());
const server = app.listen(0,"127.0.0.1"); await new Promise<void>(resolve => server.once("listening",resolve));
const model = spliceModel("ui_synthesizer"), start = Date.now();
let layout: BuilderBlock[] = [{ id: "notes",kind: "notes",title: "My notes",description: "",width: "full",visible: true },{ id: "reviews",kind: "reviews",title: "Review practice",description: "",width: "half",visible: true }];
try {
  for (const [revision,instruction] of ["Add an introduction at the very top titled Welcome home, describing a daily study habit.","Rename the reviews section to Daily practice and move it above the notes section. Keep the introduction first."] .entries()) {
    const before = Date.now();
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/builder/edits`,{ method: "POST",headers: { "Content-Type": "application/json" },signal: AbortSignal.timeout(60000),body: JSON.stringify({ revision,instruction,selectedBlockId: null,featureIds: ["wiki-links","spaced-review"],layout }) });
    const body = await response.json(); assert.equal(response.status,200,JSON.stringify(body));
    const result = BuilderEditResponse.parse(body); assert.equal(result.revision,revision); assert.ok(result.operations.length);
    layout = applyBuilderOperations(layout,result.operations,["wiki-links","spaced-review"]);
    console.log(JSON.stringify({ revision,model: result.model,api: model.api,duration_ms: Date.now()-before,summary: result.summary,operations: result.operations.map(o => o.type) }));
  }
  assert.equal(layout[0].title,"Welcome home"); assert.equal(layout[1].id,"reviews"); assert.equal(layout[1].title,"Daily practice"); assert.equal(layout[2].id,"notes");
  console.log(`Live builder acceptance passed in ${Date.now()-start}ms; two HTTP requests, validated atomic layout edits, engines unchanged.`);
} catch (error) { console.error(`Live builder acceptance failed: ${formatLlmError(error)}`); process.exitCode = 1; }
finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
