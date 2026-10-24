import { test } from "node:test";
import assert from "node:assert/strict";
import type { SynthesisBundle } from "@splice/contracts";
import { assembleBundle, ENTRY_FILES } from "./assemble.js";
import { validateBundle } from "./validateBundle.js";
import { GOOD_ENGINE, LINK_ENGINE, makeBlueprint, makeLinkSpec, makeSpec } from "../engine/testFixtures.js";

const sm2 = makeBlueprint(makeSpec(), GOOD_ENGINE);
const links = makeBlueprint(makeLinkSpec(), LINK_ENGINE);
const blueprints = [sm2, links];
const meta = { bundle_id: "b_test", app_title: "Study", app_description: "Notes + reviews", revision: 0, mode: "live" as const };

const APP = `import { useState } from "react";
import { updateEase, type ReviewResult } from "./engines/sm2Scheduler";
import { NoteCard } from "./components/NoteCard";

export default function App() {
  const [ease, setEase] = useState(2.5);
  const last: ReviewResult = { ease, interval: 1 };
  return (
    <main className="p-4">
      <NoteCard body="See [[Cardiology]]" />
      <button onClick={() => setEase(updateEase(ease, 4))}>Grade 4 (ease {last.ease})</button>
    </main>
  );
}`;
const NOTE_CARD = `import { BookOpen } from "lucide-react";
import { parseLinks } from "../engines/wikiLinks";

export function NoteCard({ body }: { body: string }) {
  return <div><BookOpen className="h-4 w-4" />{parseLinks(body).join(", ")}</div>;
}`;

const generated = (app = APP, card = NOTE_CARD) => [
  { path: "/App.tsx", content: app },
  { path: "/components/NoteCard.tsx", content: card },
];
const bundle = (gen = generated()): SynthesisBundle => assembleBundle(blueprints, gen, meta);
const validate = (b: SynthesisBundle) => validateBundle(b, blueprints);

test("a valid two-engine bundle passes", () => {
  const b = bundle();
  assert.deepEqual(validate(b), { ok: true, errors: [] });
  assert.deepEqual(b.engine_paths, ["/engines/sm2Scheduler.ts", "/engines/wikiLinks.ts"]);
  assert.equal(b.files["/engines/sm2Scheduler.ts"], GOOD_ENGINE);
  assert.deepEqual(b.dependencies, { "react": "18.3.1", "react-dom": "18.3.1", "lucide-react": "0.344.0", "canvas-confetti": "1.9.3" });
});

test("a typo'd engine export is a type error naming it", () => {
  const v = validate(bundle(generated(APP.replace(/updateEase/g, "updateEases"))));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /updateEases/.test(e) && /App\.tsx/.test(e)), v.errors.join("\n"));
});

test("an unavailable package is rejected", () => {
  const v = validate(bundle(generated(`import axios from "axios";\n` + APP)));
  assert.ok(v.errors.some((e) => /package "axios" is not available/.test(e)), v.errors.join("\n"));
});

test("an engine that is never imported is rejected", () => {
  const v = validate(bundle(generated(APP, `export function NoteCard({ body }: { body: string }) { return <div>{body}</div>; }`)));
  assert.ok(v.errors.some((e) => /Engine wikiLinks is never imported/.test(e)), v.errors.join("\n"));
});

test("an edited engine is rejected", () => {
  const b = bundle();
  b.files["/engines/sm2Scheduler.ts"] = GOOD_ENGINE.replace("1.3", "1.2");
  assert.ok(validate(b).errors.some((e) => /\/engines\/sm2Scheduler\.ts differs from the verified engine/.test(e)));
});

test("a file outside the allowed paths is rejected", () => {
  const b = bundle();
  b.files["/src/App.tsx"] = APP;
  assert.ok(validate(b).errors.some((e) => e === "File not allowed: /src/App.tsx"));
});

test("assembly drops generated files that target server-owned or disallowed paths", () => {
  const b = bundle([...generated(), { path: "/engines/sm2Scheduler.ts", content: "export {}" },
    { path: "/index.tsx", content: "hacked" }, { path: "src/App.tsx", content: APP }]);
  assert.equal(b.files["/engines/sm2Scheduler.ts"], GOOD_ENGINE);
  assert.equal(b.files["/index.tsx"], ENTRY_FILES["/index.tsx"]);
  assert.deepEqual(b.generated_paths, ["/App.tsx", "/components/NoteCard.tsx"]);
  assert.equal(b.warnings.length, 3);
  assert.equal(validate(b).ok, true);
});

test("a modified entry file is rejected", () => {
  const b = bundle();
  b.files["/index.tsx"] = "hacked";
  assert.ok(validate(b).errors.some((e) => /\/index\.tsx was modified/.test(e)));
});

test("missing App or default export is rejected", () => {
  assert.ok(validate(bundle([{ path: "/components/NoteCard.tsx", content: NOTE_CARD }])).errors.includes("Missing /App.tsx"));
  const v = validate(bundle(generated(APP.replace("export default function App", "export function App"))));
  assert.ok(v.errors.some((e) => /must have a default export/.test(e)));
});

test("an unresolved relative import is rejected", () => {
  const v = validate(bundle(generated(`import { x } from "./lib/missing";\n` + APP)));
  assert.ok(v.errors.some((e) => /cannot resolve import "\.\/lib\/missing"/.test(e)));
});

test("duplicate engines are rejected at assembly and validation", () => {
  const twin = makeBlueprint(makeSpec(), GOOD_ENGINE);
  assert.throws(() => assembleBundle([sm2, twin], generated(), meta), /Duplicate engine module "sm2Scheduler"/);
  assert.ok(validateBundle(bundle(), [sm2, twin]).errors.some((e) => /Duplicate feature "recall\.sm2_scheduler"/.test(e)));
});

test("a file written twice keeps the last version once", () => {
  const b = bundle([...generated(), { path: "/App.tsx", content: APP + "\n// v2" }]);
  assert.deepEqual(b.generated_paths, ["/App.tsx", "/components/NoteCard.tsx"]);
  assert.match(b.files["/App.tsx"], /\/\/ v2$/);
  assert.equal(b.warnings.length, 1);
});
