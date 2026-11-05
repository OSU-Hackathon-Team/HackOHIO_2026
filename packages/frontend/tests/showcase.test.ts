import test from "node:test";
import assert from "node:assert/strict";
import { applyShowcaseActions, parseCsv, projectTotal, ShowcaseProject, type ShowcaseAction } from "../src/demo/showcaseModel";
import { evaluateGrid } from "../src/demo/notesDocument";

const blank = (): ShowcaseProject => ({
  version: 1, id: "project", revision: 0, title: "Untitled app", capabilities: [], notes: [], tables: [], tasks: [], sections: [],
  theme: { mode: "dark", accent: "amber", density: "comfortable" },
});
const action = (type: ShowcaseAction["type"], target = "", data: Record<string, unknown> = {}): ShowcaseAction => ({ type, target, data });

test("a conversation can create a working budget and a follow-up edit recalculates it", () => {
  const created = applyShowcaseActions(blank(), [
    action("project.rename", "", { title: "Trip planner" }),
    action("note.create", "", { title: "Itinerary", body: "# Itinerary\n\nSee [[Budget]]." }),
    action("table.create", "", { title: "Trip budget", grid: [["Item", "Qty", "Unit cost", "Total"], ["Flights", 1, 400, "=B2*C2"], ["Hotel nights", 3, 120, "=B3*C3"], ["Grand total", "", "", "=D2+D3"]] }),
    action("task.create", "", { title: "Pack bags" }),
    action("section.add", "", { kind: "metric", title: "Total" }),
  ]);
  assert.equal(created.revision, 1);
  assert.equal(created.title, "Trip planner");
  assert.equal(projectTotal(created), 760);
  assert.deepEqual(created.capabilities.sort(), ["calc", "metrics", "notes", "tasks"]);
  const edited = applyShowcaseActions(created, [action("table.cell", "Trip budget", { row: 2, col: 1, value: 4 })]);
  assert.equal(projectTotal(edited), 880);
  assert.equal(projectTotal(created), 760);
});

test("new rows above a total preserve the formula and malformed edits are atomic", () => {
  const p = applyShowcaseActions(blank(), [action("table.create", "", { title: "Costs", grid: [["Item", "Qty", "Unit cost", "Total"], ["Flights", 1, 400, "=B2*C2"], ["Hotel", 3, 120, "=B3*C3"], ["Total", "", "", "=D2+D3"]] })]);
  const added = applyShowcaseActions(p, [action("table.addRow", "Costs", { row: ["Taxi", 1, 40, "=B4*C4"] })]);
  assert.equal(projectTotal(added), 800);
  assert.equal(added.tables[0].grid[4][3], "=D2+D3+D4");
  assert.throws(() => applyShowcaseActions(p, [action("theme.update", "", { accent: "green" }), action("table.cell", "Costs", { row: 99, col: 1, value: 5 })]), /out of range/);
  assert.equal(p.theme.accent, "amber");
  assert.equal(p.revision, 1);
});

test("removing and re-enabling Calc retains table data and dependent sections", () => {
  const p = applyShowcaseActions(blank(), [action("table.create", "", { title: "Costs", grid: [["Item", "Value"], ["Taxi", 40]] }), action("section.add", "", { kind: "metric", title: "Total", ref: "Costs" })]);
  const removed = applyShowcaseActions(p, [action("capability.disable", "calc")]);
  assert.equal(removed.tables.length, 1);
  assert.deepEqual(removed.sections.map(s => s.visible), [false, false]);
  assert.ok(!removed.capabilities.includes("calc"));
  const restored = applyShowcaseActions(removed, [action("capability.enable", "calc"), action("capability.enable", "metrics")]);
  assert.equal(projectTotal(restored), 40);
  assert.deepEqual(restored.sections.map(s => s.visible), [true, true]);
});

test("forward references, cycles, bad references, and unsupported syntax are visible", () => {
  assert.equal(evaluateGrid([["First", "Second"], ["=B2+1", 4]])[1][0], 5);
  assert.equal(evaluateGrid([["A", "B"], ["=B2", "=A2"]])[1][0], "#CYCLE");
  assert.equal(evaluateGrid([["=Z99"]])[0][0], "#REF!");
  assert.equal(evaluateGrid([[1, "=SUM(A1:A2)"], [2, ""]])[0][1], "#ERR");
});

test("CSV import handles quotes, embedded newlines, and numeric cells", () => {
  assert.deepEqual(parseCsv('Item,Qty,Price\r\n"Airport, taxi",1,40\r\n"Two\nlines",2,5\r\n'), [["Item", "Qty", "Price"], ["Airport, taxi", 1, 40], ["Two\nlines", 2, 5]]);
  assert.throws(() => parseCsv('"unclosed'), /unclosed/);
});
