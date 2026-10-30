import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

import { splitNote, joinNote, evaluateGrid, applyTableOp, hasFormulas, neutralizeHtml, type Grid } from "../src/demo/notesDocument";

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
