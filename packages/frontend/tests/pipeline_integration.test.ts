import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { liveApi } from "../src/api/client";
import { createStudio } from "../src/store/studioState";
import {
  FeatureSpec,
  FeatureBlueprint,
  SynthesisBundle,
  Pantry,
  type PipelineEvent,
  type SynthEvent,
} from "@splice/contracts";
import manifest from "../../../targets/manifest.json";
import sm2SpecJson from "../../../fixtures/specs/_seed/recall.sm2_scheduler.json";
import sm2BpJson from "../../../fixtures/blueprints/_seed/recall.sm2_scheduler.json";
import studyRoomJson from "../../../fixtures/bundles/_seed/study-room.json";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const encoder = new TextEncoder();
function sseResponse(lines: string[]) {
  const text = lines.map(l => (l ? `data: ${l}\n\n` : "\n\n")).join("");
  const bytes = encoder.encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const validSpec = FeatureSpec.parse(sm2SpecJson);
const validBlueprint = FeatureBlueprint.parse(sm2BpJson);
const validBundle = SynthesisBundle.parse(studyRoomJson);
const validPantry = Pantry.parse(manifest);

test("liveApi.health validates health contract and rejects incomplete payloads", async () => {
  globalThis.fetch = async (url: any) => {
    assert.equal(url, "/api/health");
    return new Response(
      JSON.stringify({
        ok: true,
        rea: { connected: true, version: "1.0", tool_count: 42 },
        rea_mode: "live",
        llm_mode: "live",
        model: "claude-3-7-sonnet",
        models: { ui_synthesizer: "claude-3-7-sonnet" },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  const health = await liveApi.health();
  assert.equal(health.ok, true);
  assert.equal(health.rea.tool_count, 42);

  // Incomplete/invalid health response
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(liveApi.health(), /health response is incomplete/);
});

test("liveApi.pantry fetches and parses the pantry manifest", async () => {
  globalThis.fetch = async (url: any) => {
    assert.equal(url, "/api/pantry");
    return new Response(JSON.stringify(manifest), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const pantry = await liveApi.pantry();
  assert.equal(pantry.apps.length > 0, true);
  assert.equal(pantry.apps[0].app_id, "inkwell");
});

test("liveApi.extract and liveApi.implement stream pipeline events and forward force_mode", async () => {
  let extractBody: any;
  let implementBody: any;

  globalThis.fetch = async (url: any, opts: any) => {
    const parsed = JSON.parse(opts.body);
    if (url === "/api/extract") {
      extractBody = parsed;
      const events: PipelineEvent[] = [
        {
          type: "stage",
          run_id: "r1",
          feature_id: "recall.sm2_scheduler",
          ts: 100,
          stage: "analyzing",
          message: "Tracing REA",
        },
        {
          type: "spec",
          run_id: "r1",
          feature_id: "recall.sm2_scheduler",
          ts: 101,
          spec: validSpec,
        },
        {
          type: "done",
          run_id: "r1",
          feature_id: "recall.sm2_scheduler",
          ts: 102,
          ok: true,
          replayed: true,
        },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    if (url === "/api/implement") {
      implementBody = parsed;
      const events: PipelineEvent[] = [
        {
          type: "stage",
          run_id: "r2",
          feature_id: "recall.sm2_scheduler",
          ts: 200,
          stage: "implementing",
          message: "Building engine",
        },
        {
          type: "blueprint",
          run_id: "r2",
          feature_id: "recall.sm2_scheduler",
          ts: 201,
          blueprint: validBlueprint,
        },
        {
          type: "done",
          run_id: "r2",
          feature_id: "recall.sm2_scheduler",
          ts: 202,
          ok: true,
          replayed: true,
        },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    throw new Error(`Unexpected url ${url}`);
  };

  const extractEvents: PipelineEvent[] = [];
  await liveApi.extract(
    "recall",
    "recall.sm2_scheduler",
    e => extractEvents.push(e),
    undefined,
    { force_mode: "replay" },
  );

  assert.equal(extractBody.force_mode, "replay");
  assert.equal(extractEvents.length, 3);
  assert.equal(extractEvents[0].type, "stage");
  assert.equal(extractEvents[1].type, "spec");

  const implementEvents: PipelineEvent[] = [];
  await liveApi.implement(
    validSpec,
    e => implementEvents.push(e),
    undefined,
    { force_mode: "replay" },
  );

  assert.equal(implementBody.force_mode, "replay");
  assert.equal(implementEvents.length, 3);
  assert.equal(implementEvents[1].type, "blueprint");
});

test("liveApi.synthesize and liveApi.refine stream synthesis events", async () => {
  let synthBody: any;
  let refineBody: any;

  globalThis.fetch = async (url: any, opts: any) => {
    const parsed = JSON.parse(opts.body);
    if (url === "/api/synthesize") {
      synthBody = parsed;
      const events: SynthEvent[] = [
        { type: "stage", run_id: "s1", ts: 10, stage: "generating", message: "Designing UI" },
        { type: "bundle", run_id: "s1", ts: 11, bundle: validBundle },
        { type: "done", run_id: "s1", ts: 12, ok: true },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    if (url === "/api/refine") {
      refineBody = parsed;
      const events: SynthEvent[] = [
        { type: "stage", run_id: "ref1", ts: 20, stage: "generating", message: "Refining UI" },
        {
          type: "bundle",
          run_id: "ref1",
          ts: 21,
          bundle: { ...validBundle, revision: validBundle.revision + 1 },
        },
        { type: "stage", run_id: "ref1", ts: 22, stage: "complete", message: "Added dark mode" },
        { type: "done", run_id: "ref1", ts: 23, ok: true },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    throw new Error(`Unexpected url ${url}`);
  };

  const synthEvents: SynthEvent[] = [];
  await liveApi.synthesize([validBlueprint], "Prompt", e => synthEvents.push(e));
  assert.equal(synthBody.prompt, "Prompt");
  assert.equal(synthEvents.length, 3);
  assert.equal(synthEvents[1].type, "bundle");

  const refineEvents: SynthEvent[] = [];
  await liveApi.refine(
    {
      bundle: validBundle,
      blueprints: [validBlueprint],
      kind: "edit",
      prompt: "Add dark mode",
      runtime_error: null,
    },
    e => refineEvents.push(e),
  );
  assert.equal(refineBody.kind, "edit");
  assert.equal(refineEvents.length, 4);
  assert.equal(refineEvents[1].type, "bundle");
});

test("end-to-end user flow: discovery -> harvest -> fuse -> conversational refine", async () => {
  globalThis.fetch = async (url: any, opts: any) => {
    if (url === "/api/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          rea: { connected: true, version: "1.0", tool_count: 10 },
          rea_mode: "live",
          llm_mode: "live",
          model: "claude-3-7-sonnet",
          models: {},
        }),
      );
    }
    if (url === "/api/pantry") {
      return new Response(JSON.stringify(validPantry));
    }
    if (url === "/api/extract") {
      const events: PipelineEvent[] = [
        {
          type: "stage",
          run_id: "run-e",
          feature_id: "recall.sm2_scheduler",
          ts: 1,
          stage: "analyzing",
          message: "Extracting REA",
        },
        {
          type: "test_result",
          run_id: "run-e",
          feature_id: "recall.sm2_scheduler",
          ts: 2,
          name: "SM2 basic schedule",
          kind: "oracle",
          passed: true,
          error: null,
        },
        {
          type: "spec",
          run_id: "run-e",
          feature_id: "recall.sm2_scheduler",
          ts: 3,
          spec: validSpec,
        },
        {
          type: "done",
          run_id: "run-e",
          feature_id: "recall.sm2_scheduler",
          ts: 4,
          ok: true,
          replayed: false,
        },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    if (url === "/api/implement") {
      const events: PipelineEvent[] = [
        {
          type: "stage",
          run_id: "run-i",
          feature_id: "recall.sm2_scheduler",
          ts: 5,
          stage: "implementing",
          message: "Synthesizing engine",
        },
        {
          type: "test_result",
          run_id: "run-i",
          feature_id: "recall.sm2_scheduler",
          ts: 6,
          name: "SM2 verification test",
          kind: "acceptance",
          passed: true,
          error: null,
        },
        {
          type: "blueprint",
          run_id: "run-i",
          feature_id: "recall.sm2_scheduler",
          ts: 7,
          blueprint: validBlueprint,
        },
        {
          type: "done",
          run_id: "run-i",
          feature_id: "recall.sm2_scheduler",
          ts: 8,
          ok: true,
          replayed: false,
        },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    if (url === "/api/synthesize") {
      const events: SynthEvent[] = [
        { type: "stage", run_id: "run-s", ts: 9, stage: "generating", message: "Generating App.tsx" },
        { type: "bundle", run_id: "run-s", ts: 10, bundle: validBundle },
        { type: "done", run_id: "run-s", ts: 11, ok: true },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    if (url === "/api/refine") {
      const body = JSON.parse(opts.body);
      assert.equal(body.prompt, "Make buttons rounded");
      const events: SynthEvent[] = [
        { type: "stage", run_id: "run-r", ts: 12, stage: "generating", message: "Updating CSS" },
        {
          type: "bundle",
          run_id: "run-r",
          ts: 13,
          bundle: { ...validBundle, revision: validBundle.revision + 1 },
        },
        { type: "stage", run_id: "run-r", ts: 14, stage: "complete", message: "Buttons are now rounded" },
        { type: "done", run_id: "run-r", ts: 15, ok: true },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  };

  const store = createStudio(liveApi);
  await store.getState().init();

  assert.equal(store.getState().health?.ok, true);
  assert.equal(store.getState().pantry?.apps.length! > 0, true);

  // Select feature
  store.getState().toggleFeature("recall.sm2_scheduler");
  assert.deepEqual(store.getState().selected, ["recall.sm2_scheduler"]);

  // Harvest feature
  await store.getState().harvest();
  const card = store.getState().cards["recall.sm2_scheduler"];
  assert.equal(card.phase, "ready");
  assert.equal(card.includeInFusion, true);
  assert.equal(card.oracleResults?.["SM2 basic schedule"], true);
  assert.equal(card.engineResults?.["SM2 verification test"], true);

  // Fuse app
  await store.getState().fuse();
  assert.equal(store.getState().synth.status, "ready");
  assert.equal(store.getState().synth.bundle?.bundle_id, validBundle.bundle_id);

  // Refine app (conversational edit)
  await store.getState().refine("edit", "Make buttons rounded");
  assert.equal(store.getState().synth.status, "ready");
  assert.equal(store.getState().synth.bundle?.revision, validBundle.revision + 1);
  assert.equal(store.getState().synth.chat.length, 2);
  assert.equal(store.getState().synth.chat[0].role, "user");
  assert.equal(store.getState().synth.chat[0].text, "Make buttons rounded");
  assert.equal(store.getState().synth.chat[1].role, "assistant");
  assert.equal(store.getState().synth.chat[1].text, "Buttons are now rounded");
});

test("unverified engine failure never fabricates ready state and excludes from fusion", async () => {
  const failingBlueprint: FeatureBlueprint = {
    ...validBlueprint,
    verification: {
      ...validBlueprint.verification,
      status: "failed",
      passed: 1,
      total: 3,
    },
  };

  globalThis.fetch = async (url: any) => {
    if (url === "/api/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          rea: { connected: true, version: "1.0", tool_count: 5 },
          rea_mode: "live",
          llm_mode: "live",
          model: "m",
          models: {},
        }),
      );
    }
    if (url === "/api/pantry") return new Response(JSON.stringify(validPantry));
    if (url === "/api/extract") {
      const events: PipelineEvent[] = [
        {
          type: "spec",
          run_id: "r1",
          feature_id: "recall.sm2_scheduler",
          ts: 1,
          spec: validSpec,
        },
        {
          type: "done",
          run_id: "r1",
          feature_id: "recall.sm2_scheduler",
          ts: 2,
          ok: true,
          replayed: false,
        },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    if (url === "/api/implement") {
      const events: PipelineEvent[] = [
        {
          type: "blueprint",
          run_id: "r2",
          feature_id: "recall.sm2_scheduler",
          ts: 3,
          blueprint: failingBlueprint,
        },
        {
          type: "done",
          run_id: "r2",
          feature_id: "recall.sm2_scheduler",
          ts: 4,
          ok: true,
          replayed: false,
        },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    throw new Error(`Unexpected url ${url}`);
  };

  const store = createStudio(liveApi);
  await store.getState().init();
  store.getState().toggleFeature("recall.sm2_scheduler");
  await store.getState().harvest();

  const card = store.getState().cards["recall.sm2_scheduler"];
  assert.equal(card.phase, "failed");
  assert.equal(card.includeInFusion, false);
  assert.match(card.error!, /Engine verification did not pass/);

  // Fusion should not proceed because 0 valid engines are included
  await store.getState().fuse();
  assert.equal(store.getState().synth.status, "idle");
});

test("auto-fix flow: handles preview runtime errors and tracks autoFixUsedFor", async () => {
  let refineCalled = false;
  let refineKind: string | undefined;
  let runtimeError: string | null | undefined;

  globalThis.fetch = async (url: any, opts: any) => {
    if (url === "/api/refine") {
      const body = JSON.parse(opts.body);
      refineCalled = true;
      refineKind = body.kind;
      runtimeError = body.runtime_error;
      const events: SynthEvent[] = [
        { type: "stage", run_id: "f1", ts: 1, stage: "fixing", message: "Fixing runtime error" },
        {
          type: "bundle",
          run_id: "f1",
          ts: 2,
          bundle: { ...validBundle, revision: validBundle.revision + 1 },
        },
        { type: "done", run_id: "f1", ts: 3, ok: true },
      ];
      return sseResponse(events.map(e => JSON.stringify(e)));
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const store = createStudio(liveApi);
  // Set up existing ready bundle and blueprint card
  store.setState({
    cards: {
      "recall.sm2_scheduler": {
        feature_id: "recall.sm2_scheduler",
        app_id: "recall",
        title: "SM2",
        phase: "ready",
        message: "ready",
        blueprint: validBlueprint,
        replayed: false,
        includeInFusion: true,
      },
    },
    synth: {
      status: "ready",
      message: "Ready",
      bundle: validBundle,
      validationErrors: [],
      outputChars: 0,
      chat: [],
      autoFixUsedFor: null,
    },
  });

  await store.getState().refine("fix", "TypeError: Cannot read property 'map' of undefined");

  assert.equal(refineCalled, true);
  assert.equal(refineKind, "fix");
  assert.equal(runtimeError, "TypeError: Cannot read property 'map' of undefined");
  assert.equal(store.getState().synth.autoFixUsedFor, validBundle.bundle_id);
  assert.equal(store.getState().synth.bundle?.revision, validBundle.revision + 1);
});
