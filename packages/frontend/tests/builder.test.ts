import test from "node:test";
import assert from "node:assert/strict";
import { applyBuilderOperations, type BuilderEditResponse, type BuilderBlock } from "@splice/contracts";
import { createBuilderStore, activeProject, type EditClient } from "../src/builder/store";
import { parseLinks } from "../../../fixtures/engines/_seed/wikiLinks";

function setup(client: EditClient = async r => ({ revision: r.revision, model: "test", summary: "No changes", operations: [] })) {
  const data = new Map<string,string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string,v: string) => { data.set(k,v); } };
  const store = createBuilderStore(client,storage); store.getState().create("Study",[],true);
  return { store, storage, data, state: () => store.getState(), project: () => activeProject(store.getState())! };
}
const text: BuilderBlock = { id: "intro", kind: "text", title: "Welcome", description: "Study together", width: "full", visible: true };
test("dependencies are added once; blocked findings cannot be reused; undo and redo persist", () => {
  const { state, project, storage } = setup();
  state().addFeature("spaced-review"); assert.deepEqual(project().featureIds,["wiki-links","spaced-review"]); assert.equal(project().layout.length,3);
  state().addFeature("wiki-links"); assert.equal(project().layout.length,3);
  state().addFeature("cloud-sync"); assert.match(state().error!,/not available/); assert.equal(project().layout.length,3);
  state().undo(); assert.equal(project().layout.length,0); state().redo(); assert.equal(project().layout.length,3);
  const restored = createBuilderStore(async () => { throw Error(); },storage); assert.equal(restored.getState().projects[0].layout.length,3);
});
test("validated operations are atomic and preserve engines and unrelated sections", () => {
  const layout = [text];
  assert.throws(() => applyBuilderOperations(layout,[{ type: "remove", blockId: "intro", index: 0, block: null }, { type: "remove", blockId: "missing", index: 0, block: null }],[]),/Unknown/);
  assert.deepEqual(layout,[text]);
  assert.throws(() => applyBuilderOperations(layout,[{ type: "update", blockId: "intro", index: 0, block: { ...text, kind: "notes" } }],[]),/preserve/);
  assert.throws(() => applyBuilderOperations(layout,[{ type: "add", blockId: "notes", index: 0, block: { ...text, id: "notes", kind: "notes" } }],[]),/needs/);
  assert.throws(() => applyBuilderOperations(layout,[{ type: "add", blockId: "intro", index: 0, block: text }],[]),/unique/);
});
test("assistant success is one undoable revision and rejects duplicate work", async () => {
  let answer!: (r: BuilderEditResponse) => void, calls = 0;
  const { state, project } = setup(async () => { calls++; return new Promise(resolve => { answer = resolve; }); });
  const pending = state().send("Add an intro"); await state().send("duplicate"); state().addText(); assert.equal(calls,1); assert.equal(project().layout.length,0);
  answer({ revision: 0, model: "qwen-test", summary: "Added introduction", operations: [{ type: "add", blockId: text.id, index: 0, block: text }] }); await pending;
  assert.deepEqual(project().layout,[text]); assert.equal(project().revision,1); assert.equal(project().chat.at(-1)?.model,"qwen-test");
  state().undo(); assert.equal(project().layout.length,0); state().redo(); assert.deepEqual(project().layout,[text]);
});
test("cancellation, project switches and stale responses never apply edits", async () => {
  let answer!: (r: BuilderEditResponse) => void;
  const { state, project } = setup(async () => new Promise(resolve => { answer = resolve; }));
  const response = { revision: 0, model: "test", summary: "Added", operations: [{ type: "add" as const, blockId: text.id, index: 0, block: text }] };
  const p = state().send("Add"); state().cancel(); answer(response); await p; assert.equal(project().layout.length,0);
  const p2 = state().send("Add"); state().create("Other",[],true); answer(response); await p2; assert.equal(project().layout.length,0); assert.equal(project().chat.length,1);
  const p3 = state().send("Add"); answer({ ...response, revision: 99 }); await p3; assert.match(state().error!,/project changed/); assert.equal(project().layout.length,0);
});
test("backend failures and invalid operations preserve the previous layout", async () => {
  for (const client of [async () => { throw Error("503 service unavailable"); }, async () => ({ revision: 1, model: "test", summary: "bad", operations: [{ type: "remove" as const, blockId: "missing", index: 0, block: null }] })]) {
    const { state, project } = setup(client); state().addText(); const before = project().layout;
    await state().send("Change"); assert.deepEqual(project().layout,before); assert.ok(state().error); assert.equal(state().busy,false);
  }
});
test("storage corruption is preserved and quota failure leaves an editable in-memory project", () => {
  let overwritten = false;
  const corrupt = createBuilderStore(async () => { throw Error(); }, { getItem: () => "invalid-json", setItem: () => { overwritten = true; } });
  corrupt.getState().create("new",[],true); corrupt.getState().retrySave(); assert.equal(overwritten,false); assert.match(corrupt.getState().storageError!,/untouched/);
  const quota = createBuilderStore(async () => { throw Error(); }, { getItem: () => null, setItem: () => { throw Error("Quota"); } });
  quota.getState().create("new",[],true); quota.getState().addText(); assert.equal(activeProject(quota.getState())?.layout.length,1); assert.equal(quota.getState().saved,false);
});
test("real sample engines connect a new note and calculate reviews across reopen", () => {
  const { state, project, storage } = setup(); state().addFeature("spaced-review"); state().addNote("New case","See [[Cardiology#Case|heart]]");
  assert.deepEqual(parseLinks(project().notes.at(-1)!.body),["Cardiology"]);
  state().reviewNote("cardiology",4); assert.equal(project().reviews.cardiology.intervalDays,1); state().reviewNote("cardiology",4); assert.equal(project().reviews.cardiology.intervalDays,6);
  const restored = createBuilderStore(async () => { throw Error(); },storage); assert.equal(restored.getState().projects[0].reviews.cardiology.intervalDays,6);
});
