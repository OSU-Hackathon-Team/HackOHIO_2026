// Development data only. Local checks below do not run the original-code oracle or production sandbox.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";
import { FeatureSpec, FeatureBlueprint } from "@splice/contracts";
import { purityViolations } from "../engine/purity.js";
import { conformanceErrors } from "../engine/conformance.js";
import { assembleBundle } from "../synthesis/assemble.js";
import { validateBundle } from "../synthesis/validateBundle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const timestamp = "2026-10-24T00:00:00.000Z";
const definitions = [
  {
    id: "recall.sm2_scheduler", title: "SM-2 spaced repetition", app: "Recall Flashcards", module: "sm2Scheduler", category: "scheduling",
    location: "src/scheduler/sm2.js:L4-L31",
    statement: "Successful reviews use 1 day, then 6 days, then the previous interval times previous ease; failed reviews reset repetitions and interval. Grades are integers 0–5.",
    types: `export interface CardState { repetitions: number; intervalDays: number; easeFactor: number; lapses: number }
export interface ReviewResult extends CardState { dueDate: string; isLeech: boolean }
export declare function reviewCard(state: CardState, grade: number, today: string): ReviewResult;`,
    code: `export interface CardState { repetitions: number; intervalDays: number; easeFactor: number; lapses: number }
export interface ReviewResult extends CardState { dueDate: string; isLeech: boolean }
export function reviewCard(state: CardState, grade: number, today: string): ReviewResult {
  if (!Number.isInteger(grade) || grade < 0 || grade > 5) throw new RangeError("Grade must be an integer 0–5");
  const intervalDays = grade < 3 ? 1 : state.repetitions === 0 ? 1 : state.repetitions === 1 ? 6 : Math.round(state.intervalDays * state.easeFactor);
  const lapses = state.lapses + (grade < 3 ? 1 : 0);
  const easeFactor = Math.max(1.3, Math.round((state.easeFactor + 0.1 - (5-grade)*(0.08+(5-grade)*0.02))*100)/100);
  const date = new Date(today + "T00:00:00Z"); date.setUTCDate(date.getUTCDate() + intervalDays);
  return { repetitions: grade < 3 ? 0 : state.repetitions + 1, intervalDays, easeFactor, lapses, dueDate: date.toISOString().slice(0,10), isLeech: lapses >= 8 };
}`,
    tests: `const fresh = { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 };
test("REQ-1: first review is due tomorrow", () => assert.equal(reviewCard(fresh, 5, "2026-10-24").dueDate, "2026-10-25"));
test("REQ-1: second review uses six days", () => assert.equal(reviewCard({ ...fresh, repetitions: 1 }, 4, "2026-10-24").intervalDays, 6));
test("REQ-1: invalid grade throws", () => assert.throws(() => reviewCard(fresh, 6, "2026-10-24"), /Grade/));`,
  },
  {
    id: "inkwell.wikilink_graph", title: "Wiki-link graph & backlinks", app: "Inkwell Notes", module: "wikiLinks", category: "graph",
    location: "src/graph/wikilinks.js:L1-L36",
    statement: "Extract wiki-link targets, dropping aliases and headings and ignoring fenced and inline code. The UI derives backlinks from these targets.",
    types: `export declare function parseLinks(markdown: string): string[];`,
    code: 'export function parseLinks(markdown: string): string[] {\n  const clean = markdown.replace(/```[\\s\\S]*?```/g, "").replace(/`[^`]*`/g, "");\n  return Array.from(clean.matchAll(/\\[\\[([^\\]]+)\\]\\]/g), (m) => m[1].split(/[|#]/)[0].trim()).filter(Boolean);\n}',
    tests: 'test("REQ-1: basic target", () => assert.deepEqual(parseLinks("See [[Heart]]"), ["Heart"]));\ntest("REQ-1: aliases and headings", () => assert.deepEqual(parseLinks("[[Heart#Anatomy|Label]]"), ["Heart"]));\ntest("REQ-1: code ignored", () => assert.deepEqual(parseLinks("`[[Hidden]]` and ```[[Hidden]]```"), []));',
  },
] as const;

const blueprints: FeatureBlueprint[] = [];
for (const d of definitions) {
  const spec = FeatureSpec.parse({
    schema_version: 1, feature_id: d.id, app_id: d.id.split(".")[0], source_app: d.app, source_icon: d.category === "graph" ? "BookOpen" : "Clock",
    artifact_type: "electron_asar", consumer_title: d.title, consumer_description: "Development seed: " + d.statement, category: d.category,
    requirements: [{ id: "REQ-1", kind: "behavior", statement: d.statement, source_refs: [d.location] }],
    interface: { module_name: d.module, types_code: d.types, exports: [{ name: d.category === "graph" ? "parseLinks" : "reviewCard", kind: "function", signature: d.types, description: d.statement }] },
    inputs: [], outputs: [], acceptance_tests: d.tests, coverage: [], allowed_deviations: ["Simplified authored development seed; not a complete extracted feature."], stripped_glue: [],
    oracle: { status: "not_executable", adapter_code: null, tests: [], passed: 0, total: 0 }, status: "unverified",
    open_issues: ["Development data: original-code oracle has not run. not_executable describes this seed's missing adapter, not the original target."], repair_attempts: 0,
    provenance: { mode: "replay", target: { path: `targets/build/${d.id.split(".")[0]}/app.asar`, artifact_type: "electron_asar", sha256: (await fs.readFile(path.join(root, `targets/build/${d.id.split(".")[0]}/app.asar.sha256`), "utf8")).trim().split(/\s/)[0] },
      rea_package_version: "development-seed", tool_calls: [], snippets: [], limitations: ["Authored seed; not a REA recording."], unknowns: ["Original behavior has not been checked."], collected_at: timestamp, specified_at: timestamp, model: "authored-development-seed" },
  });
  assert.deepEqual(purityViolations(d.code), []);
  assert.deepEqual(conformanceErrors(spec, d.code), []);
  const tests: { name: string; kind: "acceptance"; passed: boolean; error: null; duration_ms: number }[] = [];
  const context = vm.createContext({ exports: {}, assert, test: (name: string, fn: () => void) => {
    fn(); tests.push({ name, kind: "acceptance", passed: true, error: null, duration_ms: 0 });
  } });
  const js = ts.transpileModule(d.code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(js, context, { timeout: 1000 });
  // Node strict deepEqual is realm-sensitive; compare values after normalizing their data.
  context.assert = { equal: assert.equal, throws: assert.throws, deepEqual: (a: unknown, b: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))) };
  Object.assign(context, context.exports);
  vm.runInContext(d.tests, context, { timeout: 1000 });
  assert.equal(tests.length, 3);
  const bp = FeatureBlueprint.parse({ schema_version: 1, feature_id: d.id, spec,
    implementation: { module_name: d.module, portable_code: d.code, notes: ["Authored development seed; checked locally, not generated by a model."] },
    verification: { status: "passed", tests, passed: tests.length, total: tests.length, purity_violations: [], type_errors: [], repair_attempts: 0, duration_ms: 0, implemented_at: timestamp, model: "local-seed-checks", mode: "replay" } });
  blueprints.push(bp);
  for (const [kind, value] of [["specs", spec], ["blueprints", bp]] as const) {
    const dir = path.join(root, "fixtures", kind, "_seed"); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${d.id}.json`), JSON.stringify(value, null, 2) + "\n");
  }
}

const app = `import { useState } from "react";
import { parseLinks } from "./engines/wikiLinks";
import { reviewCard, type CardState } from "./engines/sm2Scheduler";
const initial = [
  { title: "Cardiology", body: "The heart connects to [[Anatomy]] and [[Physiology]]." },
  { title: "Anatomy", body: "Structures support [[Physiology]]." },
  { title: "Physiology", body: "Review [[Cardiology]] for circulation." },
  { title: "Pharmacology", body: "Treatments build on [[Physiology]]." },
  { title: "Clinical practice", body: "Use [[Cardiology]] and [[Pharmacology]]." }
];
export default function App() {
  const [notes, setNotes] = useState(initial);
  const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [due, setDue] = useState<Record<string, string>>({});
  function review(title: string) {
    const result = reviewCard(cards[title] ?? { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 }, 4, new Date().toISOString().slice(0,10));
    setCards({ ...cards, [title]: result }); setDue({ ...due, [title]: result.dueDate });
  }
  return <main style={{ maxWidth: 768, margin: "auto", padding: 24, fontFamily: "system-ui, sans-serif", color: "#17232d", lineHeight: 1.6 }} className="mx-auto max-w-3xl p-6 text-slate-900">
    <p className="text-xs font-bold uppercase tracking-widest text-amber-700">Development data · local checks only</p>
    <h1 style={{ fontSize: 30, lineHeight: 1.2, letterSpacing: "-0.04em", margin: "16px 0" }} className="my-3 text-3xl font-bold">Study room</h1>
    <p className="mb-6">Link your notes. Practice a little every day.</p>
    <form onSubmit={e => { e.preventDefault(); if (!title.trim() || notes.some(n => n.title.toLowerCase() === title.trim().toLowerCase())) return; setNotes([...notes, { title: title.trim(), body }]); setTitle(""); setBody(""); }} style={{ display: "grid", gap: 12, padding: 16, margin: "24px 0", border: "1px solid #cbd5e1", borderRadius: 10, background: "white" }} className="mb-6 grid gap-3 rounded-xl border bg-white p-4">
      <label>Note title<input style={{ display: "block", width: "100%", boxSizing: "border-box", minHeight: 44, padding: 8, border: "1px solid #94a3b8", borderRadius: 5 }} className="mt-1 block w-full rounded border p-2" value={title} onChange={e => setTitle(e.target.value)} required /></label>
      <label>Note text<textarea style={{ display: "block", width: "100%", boxSizing: "border-box", minHeight: 70, padding: 8, border: "1px solid #94a3b8", borderRadius: 5 }} className="mt-1 block w-full rounded border p-2" value={body} onChange={e => setBody(e.target.value)} placeholder="Connect an idea with [[Cardiology]]" /></label>
      <button style={{ minHeight: 44, border: 0, borderRadius: 5, background: "#17232d", color: "white", cursor: "pointer" }} className="min-h-11 rounded bg-slate-900 px-4 py-2 text-white">Add note</button>
    </form>
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))" }} className="grid gap-4 sm:grid-cols-2">{notes.map(n => <article style={{ padding: 16, border: "1px solid #cbd5e1", borderRadius: 10, background: "white", overflowWrap: "anywhere" }} className="rounded-xl border bg-white p-4" key={n.title}>
      <h2 className="text-lg font-semibold">{n.title}</h2><p className="my-2 text-sm">{n.body}</p>
      <p className="text-xs text-slate-600">Links: {parseLinks(n.body).join(", ") || "None"}</p>
      <p className="my-2 text-xs text-slate-600">Backlinks: {notes.filter(other => parseLinks(other.body).some(t => t.toLowerCase() === n.title.toLowerCase())).map(other => other.title).join(", ") || "None"}</p>
      <button style={{ minHeight: 44, width: "100%", padding: 8, margin: "12px 0", border: "1px solid #94a3b8", borderRadius: 5, background: "#edf5f0", cursor: "pointer" }} className="my-2 min-h-11 rounded border px-3" onClick={() => review(n.title)}>Review {n.title} · grade 4</button>
      <p role="status" className="text-sm">{due[n.title] ? "Next review: " + due[n.title] : "Ready to review"}</p>
    </article>)}</div>
    <footer className="mt-6 text-xs text-slate-500">Built from: Wiki links (Inkwell Notes) and SM-2 (Recall Flashcards). Authored development seeds; original behavior unverified.</footer>
  </main>;
}`;
const bundle = assembleBundle(blueprints, [{ path: "/App.tsx", content: app }], { bundle_id: "development-study-room", app_title: "Study room", app_description: "Authored development example using locally checked engines; original-code oracle unrun.", revision: 0, mode: "replay" });
bundle.warnings.push("Development data, not a recording or live model output. Original specifications are unverified.");
assert.deepEqual(validateBundle(bundle, blueprints), { ok: true, errors: [] });
const bundleDir = path.join(root, "fixtures/bundles/_seed"); await fs.mkdir(bundleDir, { recursive: true });
await fs.writeFile(path.join(bundleDir, "study-room.json"), JSON.stringify(bundle, null, 2) + "\n");
console.log("Studio seeds: 6 local acceptance checks passed, purity/conformance passed, bundle validates. Oracle NOT run.");
