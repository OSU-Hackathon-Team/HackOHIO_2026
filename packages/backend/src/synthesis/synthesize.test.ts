import { test } from "node:test";
import assert from "node:assert/strict";
import type { SynthesisBundle } from "@splice/contracts";
import { BundleValidationError, MAX_FIXES, synthesize, type SynthHooks } from "./synthesize.js";
import { refine } from "./refine.js";
import { assembleBundle } from "./assemble.js";
import {
  ADAPTER_SENTINEL, APP, GOOD_ENGINE, LINK_ENGINE, NOTE_CARD, SOURCE_SENTINEL, fakeLlm, makeBlueprint, makeLinkSpec, makeSpec,
} from "../engine/testFixtures.js";

const sm2 = makeBlueprint(makeSpec(), GOOD_ENGINE);
const links = makeBlueprint(makeLinkSpec(), LINK_ENGINE);
const blueprints = [sm2, links];
const PROMPT = "A study app with linked notes and spaced repetition.";

const files = (app = APP) => [{ path: "/App.tsx", content: app }, { path: "/components/NoteCard.tsx", content: NOTE_CARD }];
const draft = (app = APP) => ({ app_title: "Study Room", app_description: "Notes and reviews", files: files(app) });
const BROKEN_APP = APP.replace(/updateEase/g, "updateEases");

function hooks() {
  const stages: string[] = [];
  const validations: boolean[] = [];
  const h: SynthHooks = { onStage: (s) => stages.push(s), onProgress: () => {}, onValidation: (ok) => validations.push(ok) };
  return { h, stages, validations };
}

test("synthesis returns a validated bundle with engines injected verbatim", async () => {
  const llm = fakeLlm([draft()]);
  const { h, stages, validations } = hooks();
  const b = await synthesize(blueprints, PROMPT, "b_1", h, { llm: llm.port });

  assert.equal(b.bundle_id, "b_1");
  assert.equal(b.revision, 0);
  assert.equal(b.app_title, "Study Room");
  assert.equal(b.files["/engines/sm2Scheduler.ts"], GOOD_ENGINE);
  assert.equal(b.files["/engines/wikiLinks.ts"], LINK_ENGINE);
  assert.deepEqual(validations, [true]);
  assert.deepEqual(stages, ["designing", "generating", "validating"]);
  assert.equal(llm.calls[0].role, "ui_synthesizer");
});

test("the synthesis prompt carries interfaces, never engine code, source or adapters", async () => {
  const llm = fakeLlm([draft()]);
  await synthesize(blueprints, PROMPT, "b_1", hooks().h, { llm: llm.port });
  const sent = JSON.stringify(llm.calls[0].messages);
  assert.ok(sent.includes("export declare function updateEase"));
  assert.ok(!sent.includes("Math.max(MIN_EASE"), "engine code must not be sent");
  assert.ok(!sent.includes(SOURCE_SENTINEL) && !sent.includes(ADAPTER_SENTINEL));
});

test("a compile error is fixed with append-only history", async () => {
  const llm = fakeLlm([draft(BROKEN_APP), draft()]);
  const { h, stages, validations } = hooks();
  const b = await synthesize(blueprints, PROMPT, "b_1", h, { llm: llm.port });
  assert.equal(b.files["/App.tsx"], APP);
  assert.deepEqual(validations, [false, true]);
  assert.ok(stages.includes("fixing"));
  assert.equal(llm.calls[1].messages.length, 3);
  assert.match(String(llm.calls[1].messages[2].content), /updateEases/);
});

test("exhausted fixes throw instead of returning an invalid bundle", async () => {
  const llm = fakeLlm([draft(BROKEN_APP), draft(BROKEN_APP), draft(BROKEN_APP)]);
  await assert.rejects(
    synthesize(blueprints, PROMPT, "b_1", hooks().h, { llm: llm.port }),
    (e: unknown) => e instanceof BundleValidationError && e.errors.some((x) => /updateEases/.test(x)),
  );
  assert.equal(llm.calls.length, 1 + MAX_FIXES);
});

test("unverified or duplicate engines cannot be fused", async () => {
  const failed = { ...sm2, verification: { ...sm2.verification, status: "failed" as const } };
  await assert.rejects(synthesize([failed, links], PROMPT, "b", hooks().h, { llm: fakeLlm([]).port }), /has not passed verification/);
  await assert.rejects(synthesize([sm2, sm2], PROMPT, "b", hooks().h, { llm: fakeLlm([]).port }), /Duplicate/);
});

// ---- refine ----

const base = (): SynthesisBundle =>
  assembleBundle(blueprints, files(), { bundle_id: "b_1", app_title: "Study Room", app_description: "d", revision: 0, mode: "live" });
const edit = (prompt: string, bundle = base()) => ({ bundle, blueprints, kind: "edit" as const, prompt, runtime_error: null });

test("an accepted edit bumps the revision and keeps engines byte-identical", async () => {
  const llm = fakeLlm([{ summary: "Added a filter.", files: [{ path: "/components/NoteCard.tsx", content: NOTE_CARD + "\n// filter" }], delete_paths: [] }]);
  let summary = "";
  const b = await refine(edit("Add a filter"), { ...hooks().h, onSummary: (s) => (summary = s) }, { llm: llm.port });

  assert.equal(b.revision, 1);
  assert.equal(b.bundle_id, "b_1");
  assert.equal(summary, "Added a filter.");
  assert.equal(b.files["/engines/sm2Scheduler.ts"], GOOD_ENGINE);
  assert.equal(b.files["/engines/wikiLinks.ts"], LINK_ENGINE);
  assert.equal(b.files["/App.tsx"], APP, "unchanged files are kept");
  assert.match(b.files["/components/NoteCard.tsx"], /\/\/ filter$/);
});

test("refine cannot touch engines or delete App, and the edit prompt carries no engine code", async () => {
  const llm = fakeLlm([{ summary: "s", files: [{ path: "/engines/sm2Scheduler.ts", content: "export {}" }], delete_paths: ["/App.tsx", "/engines/wikiLinks.ts"] }]);
  const b = await refine(edit("Rewrite the scheduler"), { ...hooks().h, onSummary: () => {} }, { llm: llm.port });
  assert.equal(b.files["/engines/sm2Scheduler.ts"], GOOD_ENGINE);
  assert.equal(b.files["/engines/wikiLinks.ts"], LINK_ENGINE);
  assert.equal(b.files["/App.tsx"], APP);
  assert.ok(b.warnings.some((w) => /Dropped file outside allowed paths: \/engines\/sm2Scheduler\.ts/.test(w)));
  assert.ok(!JSON.stringify(llm.calls[0].messages).includes("Math.max(MIN_EASE"));
});

test("changes accumulate across fix attempts", async () => {
  const llm = fakeLlm([
    { summary: "s1", files: [{ path: "/components/NoteCard.tsx", content: NOTE_CARD + "\n// kept" }, { path: "/App.tsx", content: BROKEN_APP }], delete_paths: [] },
    { summary: "s2", files: [{ path: "/App.tsx", content: APP }], delete_paths: [] },
  ]);
  let summary = "";
  const b = await refine(edit("Tweak"), { ...hooks().h, onSummary: (s) => (summary = s) }, { llm: llm.port });
  assert.match(b.files["/components/NoteCard.tsx"], /\/\/ kept$/, "the first attempt's edit survives the fix");
  assert.equal(b.revision, 1);
  assert.equal(summary, "s2");
});

test("a refine that never validates throws and reports no summary", async () => {
  const bad = { summary: "s", files: [{ path: "/App.tsx", content: BROKEN_APP }], delete_paths: [] };
  const llm = fakeLlm([bad, bad, bad]);
  let summary: string | null = null;
  await assert.rejects(refine(edit("Break it"), { ...hooks().h, onSummary: (s) => (summary = s) }, { llm: llm.port }), BundleValidationError);
  assert.equal(summary, null);
});

test("refine requests must match the bundle's verified engines", async () => {
  const run = (req: Parameters<typeof refine>[0]) => refine(req, { ...hooks().h, onSummary: () => {} }, { llm: fakeLlm([]).port });
  await assert.rejects(run({ ...edit("x"), blueprints: [sm2] }), /do not match the bundle's features/);
  const tampered = base();
  tampered.files["/engines/sm2Scheduler.ts"] = "export {}";
  await assert.rejects(run(edit("x", tampered)), /differs from its blueprint/);
  await assert.rejects(run({ ...edit("x"), kind: "fix", prompt: "", runtime_error: null }), /needs runtime_error/);
  await assert.rejects(run(edit("  ")), /needs a prompt/);
});
