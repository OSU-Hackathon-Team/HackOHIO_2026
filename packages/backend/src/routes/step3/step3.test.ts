import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import type { FeatureBlueprint, SynthesisBundle } from "@splice/contracts";
import { createStep3Router } from "./index.js";
import type { SseWriterPort, Step3Deps } from "./deps.js";
import { assembleBundle } from "../../synthesis/assemble.js";
import {
  APP, GOOD_ENGINE, LINK_ENGINE, NOTE_CARD, fakeLlm, fakeSandbox, makeBlueprint, makeLinkSpec, makeSpec, passAll,
} from "../../engine/testFixtures.js";

/** The SSE writer from agents/1_reverse_engineering/06_backend_server_shell.md §3, minus the ping. */
function openSse(_req: express.Request, res: express.Response): SseWriterPort {
  res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
  res.flushHeaders();
  const ac = new AbortController();
  let closed = false;
  res.on("close", () => { closed = true; ac.abort(); });
  return {
    send(e) { if (!closed) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); },
    close() { if (!closed) { closed = true; res.end(); } },
    get signal() { return ac.signal; },
  };
}

function makeDeps(answers: unknown[], mode: "live" | "replay" = "live") {
  const llm = fakeLlm(answers);
  const saved: [string, string, boolean][] = [];
  const deps: Step3Deps = {
    llm: llm.port,
    sandbox: fakeSandbox(passAll).port,
    llmMode: () => mode,
    openSse,
    newRunId: () => "run_test",
    createTranscript: (kind, key) => ({ push() {}, save: async (ok) => { saved.push([kind, key, ok]); } }),
    replayTranscript: async () => false,
  };
  return { deps, llm, saved };
}

const tmpDirs: string[] = [];
after(() => Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true }))));

async function serve(deps: Step3Deps | null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "step3-"));
  tmpDirs.push(dir);
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(createStep3Router(deps, { blueprintsDir: dir }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, body: unknown) =>
    fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body) });
  return { url, dir, post, close: () => new Promise((r) => server.close(r)) };
}

async function events(res: Response): Promise<{ type: string; [k: string]: any }[]> {
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  return (await res.text()).split("\n\n").filter(Boolean)
    .map((frame) => JSON.parse(frame.split("\n").find((l) => l.startsWith("data:"))!.slice(5)));
}

const types = (es: { type: string }[]) => es.map((e) => e.type);
const assertOneDoneLast = (es: { type: string }[]) => {
  assert.equal(types(es).filter((t) => t === "done").length, 1);
  assert.equal(es.at(-1)!.type, "done");
};

const spec = makeSpec();
const sm2 = makeBlueprint(spec, GOOD_ENGINE);
const links = makeBlueprint(makeLinkSpec(), LINK_ENGINE);
const files = (app = APP) => [{ path: "/App.tsx", content: app }, { path: "/components/NoteCard.tsx", content: NOTE_CARD }];
const draft = (app = APP) => ({ app_title: "Study Room", app_description: "d", files: files(app) });
const PROMPT = "A study app with linked notes and spaced repetition.";

test("malformed requests get 400 JSON before any stream opens", async () => {
  const s = await serve(makeDeps([]).deps);
  try {
    for (const p of ["/api/implement", "/api/synthesize", "/api/refine"]) {
      const res = await s.post(p, {});
      assert.equal(res.status, 400, p);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    }
    const unverified: FeatureBlueprint = { ...sm2, verification: { ...sm2.verification, status: "failed" } };
    const res = await s.post("/api/synthesize", { blueprints: [unverified], prompt: PROMPT });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /has not passed verification/);
  } finally { await s.close(); }
});

test("valid requests get 503 while upstream helpers are missing", async () => {
  const s = await serve(null);
  try {
    for (const [p, body] of [["/api/implement", { spec }], ["/api/synthesize", { blueprints: [sm2], prompt: PROMPT }]] as const) {
      const res = await s.post(p, body);
      assert.equal(res.status, 503, p);
      assert.ok(((await res.json()) as { missing: string[] }).missing.some((m) => /sandbox\/runTests\.ts/.test(m)));
    }
  } finally { await s.close(); }
});

test("GET /api/blueprints serves golden fixtures, skipping .latest and shadowed seeds", async () => {
  const s = await serve(null);
  try {
    await fs.mkdir(path.join(s.dir, "_seed"));
    await fs.writeFile(path.join(s.dir, "recall.sm2_scheduler.json"), JSON.stringify(sm2));
    await fs.writeFile(path.join(s.dir, "inkwell.wikilink_graph.latest.json"), JSON.stringify(links));
    await fs.writeFile(path.join(s.dir, "_seed", "recall.sm2_scheduler.json"), JSON.stringify({ ...sm2, implementation: { ...sm2.implementation, notes: ["seed"] } }));
    const res = await fetch(s.url + "/api/blueprints");
    assert.equal(res.status, 200);
    const list = (await res.json()) as FeatureBlueprint[];
    assert.deepEqual(list.map((b) => [b.feature_id, b.implementation.notes]), [["recall.sm2_scheduler", []]]);
  } finally { await s.close(); }
});

test("POST /api/implement streams stages, tests, a blueprint and one done", async () => {
  const { deps, saved } = makeDeps([{ portable_code: GOOD_ENGINE, notes: [] }]);
  const s = await serve(deps);
  try {
    const es = await events(await s.post("/api/implement", { spec }));
    assert.deepEqual(types(es), ["stage", "stage", "test_result", "test_result", "test_result", "blueprint", "stage", "done"]);
    assert.equal(es.at(-2)!.stage, "complete");
    assert.equal(es.at(-1)!.ok, true);
    assert.equal(es.at(-1)!.replayed, false);
    assert.deepEqual(saved, [["implement", "recall.sm2_scheduler", true]]);
    const written = JSON.parse(await fs.readFile(path.join(s.dir, "recall.sm2_scheduler.latest.json"), "utf8"));
    assert.equal(written.implementation.portable_code, GOOD_ENGINE);
  } finally { await s.close(); }
});

test("a failing implement run ends with a fatal error and done ok=false", async () => {
  const { deps, saved } = makeDeps([]); // the fake LLM throws on its first call
  const s = await serve(deps);
  try {
    const es = await events(await s.post("/api/implement", { spec }));
    assertOneDoneLast(es);
    const err = es.find((e) => e.type === "error")!;
    assert.equal(err.fatal, true);
    assert.equal(es.at(-1)!.ok, false);
    assert.deepEqual(saved, [["implement", "recall.sm2_scheduler", false]]);
  } finally { await s.close(); }
});

test("replay mode without a recording fails cleanly and never calls the model", async () => {
  const { deps, llm } = makeDeps([], "replay");
  const s = await serve(deps);
  try {
    const es = await events(await s.post("/api/implement", { spec }));
    assert.deepEqual(types(es), ["error", "done"]);
    assert.equal(es[1].replayed, true);
    assert.equal(llm.calls.length, 0);
  } finally { await s.close(); }
});

test("POST /api/synthesize streams a validated bundle", async () => {
  const { deps, saved } = makeDeps([draft()]);
  const s = await serve(deps);
  try {
    const es = await events(await s.post("/api/synthesize", { blueprints: [sm2, links], prompt: PROMPT }));
    assertOneDoneLast(es);
    const bundle = es.find((e) => e.type === "bundle")!.bundle as SynthesisBundle;
    assert.equal(bundle.files["/engines/sm2Scheduler.ts"], GOOD_ENGINE);
    assert.equal(es.at(-2)!.stage, "complete");
    assert.equal(es.at(-1)!.ok, true);
    assert.deepEqual(saved, [["synthesize", "inkwell.wikilink_graph+recall.sm2_scheduler__a-study-app-with-linked-notes-and-spaced", true]]);
  } finally { await s.close(); }
});

test("synthesis that never validates streams no bundle and ends ok=false", async () => {
  const broken = draft(APP.replace(/updateEase/g, "updateEases"));
  const { deps } = makeDeps([broken, broken, broken]);
  const s = await serve(deps);
  try {
    const es = await events(await s.post("/api/synthesize", { blueprints: [sm2, links], prompt: PROMPT }));
    assertOneDoneLast(es);
    assert.ok(!types(es).includes("bundle"));
    assert.deepEqual(es.filter((e) => e.type === "validation").map((e) => e.ok), [false, false, false]);
    assert.equal(es.find((e) => e.type === "error")!.fatal, true);
    assert.equal(es.at(-1)!.ok, false);
  } finally { await s.close(); }
});

test("POST /api/refine streams revision+1 and the summary as the complete message", async () => {
  const bundle = assembleBundle([sm2, links], files(), { bundle_id: "b_1", app_title: "Study Room", app_description: "d", revision: 0, mode: "live" });
  const { deps, saved } = makeDeps([{ summary: "Added a due-today filter.", files: [{ path: "/App.tsx", content: APP + "\n// due" }], delete_paths: [] }]);
  const s = await serve(deps);
  try {
    const es = await events(await s.post("/api/refine", { bundle, blueprints: [sm2, links], kind: "edit", prompt: "Add a due-today filter", runtime_error: null }));
    assertOneDoneLast(es);
    assert.equal(es.find((e) => e.type === "bundle")!.bundle.revision, 1);
    assert.deepEqual(es.at(-2), { type: "stage", run_id: "run_test", ts: es.at(-2)!.ts, stage: "complete", message: "Added a due-today filter." });
    assert.deepEqual(saved, [["synthesize", "refine__b_1__r0", true]]);
  } finally { await s.close(); }
});
