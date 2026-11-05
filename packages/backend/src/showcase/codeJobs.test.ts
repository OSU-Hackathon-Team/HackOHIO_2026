import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { baselineAppSource, baselineCssSource, checkBuild, createPreparedRevision, mergeFiles, readRevision, validateRevision } from "./codeJobs.js";

const project = { id: crypto.randomUUID(), revision: 0, title: "Trip planner", notes: [], tables: [], tasks: [], sections: [], theme: { mode: "dark", accent: "amber" } };
const derived = { total: 0, tableTotals: {}, tableValues: {} };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..", ".splice-state/showcase-code/revisions");
const files = (app: string) => ({ "App.tsx": `import type { AppProps } from "./runtime"; ${app}`, "styles.css": "body { margin: 0 }" });

test("candidate source cannot replace the runtime or escape its editable directory", () => {
  assert.throws(() => mergeFiles(files("export default function App(_p: AppProps) { return <p>Ready</p> }"), { summary: "bad", files: [{ path: "../server.ts", content: "" }], deletePaths: [] }), /Invalid code path/);
  assert.throws(() => mergeFiles(files("export default function App(_p: AppProps) { return <p>Ready</p> }"), { summary: "bad", files: [{ path: "runtime.ts", content: "" }], deletePaths: [] }), /Invalid code path/);
});

test("a candidate must typecheck and boot in a real browser", async () => {
  const good = crypto.randomUUID(), bad = crypto.randomUUID(), crash = crypto.randomUUID();
  try {
    await checkBuild(good, files("export default function App({ project }: AppProps) { return <p>{project.title}</p> }"), project, derived, new AbortController().signal);
    await assert.rejects(checkBuild(bad, files("import Missing from './missing'; export default function App(_p: AppProps) { return <p>{Missing}</p> }"), project, derived, new AbortController().signal), /Cannot find module/);
    await assert.rejects(checkBuild(crash, files("export default function App(_p: AppProps) { throw new Error('boom'); return <p>Never</p> }"), project, derived, new AbortController().signal), /Browser boot failed/);
  } finally { await Promise.all([good, bad, crash].map(id => rm(path.join(root, id), { recursive: true, force: true }))); }
});

test("prepared fallback is a real revision and reopens without a model call", async () => {
  const prepared = await createPreparedRevision(project, derived, null);
  try {
    assert.match(prepared.model, /Prepared example/);
    const reopened = await readRevision(prepared.revision);
    assert.match(reopened.source["App.tsx"], /runtime\.total/);
    assert.match(reopened.parentSource["App.tsx"], /ShowcasePreviewPanels/);
    await validateRevision(prepared.revision, project, derived);
  } finally { await rm(path.join(root, prepared.revision), { recursive: true, force: true }); }
});

test("editable baseline bundles the real showcase panels", async () => {
  const revision = crypto.randomUUID();
  const withSection = { ...project, version: 1, capabilities: ["calc", "metrics"], theme: { ...project.theme, density: "comfortable" }, sections: [{ id: crypto.randomUUID(), kind: "metric", ref: "all", title: "Total", visible: true, width: "half" }] };
  try { await checkBuild(revision, { "App.tsx": baselineAppSource, "styles.css": baselineCssSource }, withSection, derived, new AbortController().signal); }
  finally { await rm(path.join(root, revision), { recursive: true, force: true }); }
});
