import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { splitNote, joinNote, evaluateGrid, applyTableOp, hasFormulas, neutralizeHtml, type Grid } from "../src/demo/notesDocument";
import { PipelineEvent } from "@splice/contracts";
import { playDemoRun, demoSpec } from "../src/demo/script";
import { DEMO_FEATURES, OBSIDIAN_FEATURE, CALC_FEATURE } from "../src/demo/fixtures";
import { demoReply } from "../src/demo/chatScript";
import { DEMO_NOTES } from "../src/demo/notes";

// splice.lock.json of the recorded run-2 export (plan 49717df1…): artifact `src/index.ts` per package.
const RUN2_SOURCES = {
  "../src/demo/engines/obsidianRenderer.ts": "2b96666b7bf7d8ab9816ac25977bdd54d97bd50ab9e55345b4d823c2113a2481",
  "../src/demo/engines/calcTables.ts": "d7f40aa5212a3a023f782c8a20add8472fdd294158f2818e3fc0371f66b316a5",
};

test("demo engines are byte-identical to the run-2 export", () => {
  for (const [file, sha256] of Object.entries(RUN2_SOURCES)) {
    const bytes = readFileSync(new URL(file, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, file);
  }
});

const note = "# Budget\n\n```calc\nItem | Qty | Cost | Total\nLaptops | 3 | 20 | =B2*C2\n```\n\nAfter.";

test("notes split into markdown and calc tables and join back unchanged", () => {
  const segments = splitNote(note);
  assert.deepEqual(segments.map((s) => s.kind), ["markdown", "calc", "markdown"]);
  assert.equal(joinNote(segments), note);
});

test("calc tables evaluate formulas on the run-2 engine", () => {
  const [, table] = splitNote(note);
  assert.equal(table.kind, "calc");
  const grid = (table as { grid: Grid }).grid;
  assert.ok(hasFormulas(grid));
  assert.deepEqual(evaluateGrid(grid)[1], ["Laptops", 3, 20, 60]);
  assert.equal(evaluateGrid([["=1/0"]])[0][0], "#ERR");
});

test("table operations reorder, insert and delete through the engine", () => {
  const inventory: Grid = [["Product", "Units"], ["Pear", 3], ["Apple", 2], ["Peach", 5]];
  assert.deepEqual(applyTableOp(inventory, { type: "sort", column: 0, ascending: true }).map((r) => r[0]), ["Product", "Apple", "Peach", "Pear"]);
  assert.deepEqual(applyTableOp(inventory, { type: "sort", column: 1, ascending: false }).map((r) => r[1]), ["Units", 5, 3, 2]);
  assert.deepEqual(applyTableOp(inventory, { type: "insert_row", index: 2 })[2], ["", ""]);
  assert.deepEqual(applyTableOp(inventory, { type: "delete_row", index: 1 }).map((r) => r[0]), ["Product", "Apple", "Peach"]);
  assert.deepEqual(applyTableOp(inventory, { type: "insert_column", index: 1 })[0], ["Product", "", "Units"]);
  assert.deepEqual(applyTableOp(inventory, { type: "delete_column", index: 0 })[0], ["Units"]);
});

test("raw HTML is neutralized outside code fences only", () => {
  assert.equal(neutralizeHtml("# <img onerror=x>"), "# &lt;img onerror=x>");
  assert.equal(neutralizeHtml("```js\nif (a < b) {}\n```"), "```js\nif (a < b) {}\n```");
});

test("scripted runs emit valid pipeline events and end with a passing blueprint", async () => {
  for (const feature of DEMO_FEATURES) {
    const events: PipelineEvent[] = [];
    await playDemoRun(demoSpec(feature.featureId), (e) => events.push(PipelineEvent.parse(e)), undefined, 10_000);
    const blueprint = events.find((e) => e.type === "blueprint");
    assert.ok(blueprint && blueprint.type === "blueprint");
    const v = blueprint.blueprint.verification;
    assert.equal(v.status, "passed"); assert.ok(v.total > 0); assert.equal(v.passed, v.total);
    assert.equal(events.filter((e) => e.type === "test_result").length, v.total);
    assert.deepEqual(events.at(-1), { ...events.at(-1), type: "done", ok: true });
  }
});

test("scripted chat edits notes through the engines once the features are added", () => {
  const ctx = { notes: DEMO_NOTES, selectedNoteId: "project-plan", included: [OBSIDIAN_FEATURE, CALC_FEATURE] };
  assert.match(demoReply("Add a table", { ...ctx, included: [] }).text, /Obsidian/);
  assert.match(demoReply("Sort the inventory by units", { ...ctx, included: [OBSIDIAN_FEATURE] }).text, /Calc/);

  const sorted = demoReply("Sort the inventory by units", ctx);
  const inventory = sorted.notes!.find((n) => n.id === "inventory")!;
  const grid = (splitNote(inventory.body).find((s) => s.kind === "calc") as { grid: Grid }).grid;
  assert.deepEqual(grid.map((r) => r[1]), ["Units", 5, 3, 2, 1]);

  const summary = demoReply("Summarize the budget", ctx);
  assert.match(summary.notes!.find((n) => n.id === "budget")!.body, /total is \*\*290\*\*/);

  const created = demoReply("Create a note called Travel", ctx);
  assert.equal(created.notes!.at(-1)!.title, "Travel");
  assert.equal(created.selectedNoteId, created.notes!.at(-1)!.id);
  assert.match(demoReply("make it purple", ctx).text, /can add a table/);
});
