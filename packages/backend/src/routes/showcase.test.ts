import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createShowcaseRouter } from "./showcase.js";

const request = {
  prompt: "Add a task", revision: 0, selectedSectionId: null, history: [],
  project: { id: "p", revision: 0, title: "App", capabilities: [], notes: [], tables: [], tasks: [], sections: [], theme: { mode: "dark", accent: "amber", density: "comfortable" } },
  derived: { total: 0, tableTotals: [], tasksComplete: 0 },
};

test("showcase planner route checks revisions and origin before invoking a model", async () => {
  let calls = 0;
  const app = express(); app.use(express.json());
  app.use(createShowcaseRouter(async () => { calls++; return { outcome: "answer" as const, message: "Ready", actions: [], model: "test" }; }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/showcase/edits`;
  try {
    const post = (body: unknown, origin = "http://localhost:5173") => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
    assert.equal((await post({ ...request, revision: 1 })).status, 400);
    assert.equal((await post(request, "https://outside.example")).status, 403);
    const good = await post(request);
    assert.equal(good.status, 200);
    assert.equal(((await good.json()) as { message: string }).message, "Ready");
    assert.equal(calls, 1);
  } finally { server.close(); }
});

test("showcase planner permits one in-flight request per project", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const app = express(); app.use(express.json());
  app.use(createShowcaseRouter(async () => { started(); await gate; return { outcome: "answer" as const, message: "Ready", actions: [], model: "test" }; }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/showcase/edits`;
  const post = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" }, body: JSON.stringify(request) });
  try {
    const first = post();
    await entered;
    assert.equal((await post()).status, 409);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await post()).status, 200);
  } finally { release(); server.close(); }
});
