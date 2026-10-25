import { test } from "node:test";
import assert from "node:assert/strict";
import { createStudio } from "../src/store/studioState";
import { mockApi } from "../src/api/mock";
import type { Api } from "../src/api/client";
import type { PipelineEvent, SynthEvent } from "@splice/contracts";
const ids = ["inkwell.wikilink_graph", "recall.sm2_scheduler"];
async function setup(overrides: Partial<Api> = {}) {
  const store = createStudio({ ...mockApi, ...overrides }); await store.getState().init();
  ids.forEach(id => store.getState().toggleFeature(id)); return store;
}
test("two interleaved seed pipelines preserve honest oracle status and fuse byte-identical engines", async () => {
  const store = await setup(); await store.getState().harvest();
  for (const id of ids) { const card = store.getState().cards[id]; assert.equal(card.phase, "ready"); assert.equal(card.spec?.status, "unverified"); assert.equal(card.spec?.oracle.total, 0); assert.equal(card.blueprint?.verification.passed, 3); }
  await store.getState().fuse(); const state = store.getState(); assert.equal(state.synth.status, "ready");
  for (const card of Object.values(state.cards)) assert.equal(state.synth.bundle!.files[`/engines/${card.blueprint!.implementation.module_name}.ts`], card.blueprint!.implementation.portable_code);
});
test("failed extraction never starts implementation for that feature; another feature can finish", async () => {
  const implemented: string[] = [];
  const store = await setup({
    async extract(app, id, on, signal) { if (id === ids[0]) { on({ type: "done", run_id: "x", feature_id: id, ts: 0, ok: false, replayed: false }); return; } return mockApi.extract(app,id,on,signal); },
    async implement(spec,on,signal) { implemented.push(spec.feature_id); return mockApi.implement(spec,on,signal); },
  });
  await store.getState().harvest(); assert.deepEqual(implemented, [ids[1]]); assert.equal(store.getState().cards[ids[0]].phase, "failed"); assert.equal(store.getState().cards[ids[1]].phase, "ready");
});
test("incomplete extraction cannot mark a feature ready", async () => {
  const store = await setup({ async extract() {} }); await store.getState().harvest();
  assert.equal(store.getState().cards[ids[0]].phase, "failed");
});
test("duplicate harvest is ignored and cancelled late events cannot resurrect cards", async () => {
  let calls = 0; let emit: (e: PipelineEvent) => void = () => {}; let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const store = await setup({ async extract(_app,_id,on) { calls++; emit = on; await pending; } });
  const work = store.getState().harvest([ids[0]]); await store.getState().harvest([ids[0]]); assert.equal(calls, 1);
  store.getState().cancel(); emit({ type: "stage", run_id: "late", feature_id: ids[0], ts: 0, stage: "complete", message: "stale" }); release(); await work;
  assert.equal(store.getState().cards[ids[0]].error, "Cancelled"); assert.equal(store.getState().harvesting, false);
});
test("failed fusion preserves the last working bundle and ignores duplicate fuse", async () => {
  let calls = 0;
  const store = await setup({ async synthesize(b,p,on,signal) { calls++; if (calls === 1) return mockApi.synthesize(b,p,on,signal); throw new Error("503 missing helper"); } });
  await store.getState().harvest(); const first = store.getState().fuse(); await store.getState().fuse(); await first; assert.equal(calls,1);
  const bundle = store.getState().synth.bundle; await store.getState().fuse(); assert.equal(store.getState().synth.bundle, bundle); assert.equal(store.getState().synth.status,"failed");
});
test("cancelled synthesis ignores a late bundle", async () => {
  let emit: (e: SynthEvent) => void = () => {}; let release!: () => void;
  const store = await setup({ async synthesize(_b,_p,on) { emit = on; await new Promise<void>(resolve => { release = resolve; }); } });
  await store.getState().harvest(); const work = store.getState().fuse(); store.getState().cancel();
  emit({ type: "done", run_id: "late", ts: 0, ok: true }); release(); await work;
  assert.equal(store.getState().synth.status, "idle"); assert.equal(store.getState().synth.bundle, undefined);
});
