import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCleanRoomIndependence } from "./oracle.js";

const PUBLIC = `export interface Note { id: string; title: string; body: string }
export interface LinkGraph { nodes: Node[]; edges: Edge[]; backlinks: Record<string, string[]>; unresolved: Record<string, string[]> }
export declare function buildLinkGraph(notes: Note[]): LinkGraph;`;
const ORIGINAL = [{
  location: "app.asar:src/graph/backlinks.js", symbol: "buildLinkGraph", language: "javascript", full_module: true,
  code: [
    "function buildLinkGraph(notes) {",
    "  const byTitleLookup = buildTitleIndex(notes, normalizeTitle);",
    "  for (const note of notes) {",
    "    for (const n of notes) backlinks[n.id] = [];",
    "    edges.push({ from: note.id, to: note.id });",
    "  }",
    "  return { nodes, edges, backlinks, unresolved };",
    "}",
  ].join("\n"),
}];

test("lines the public interface forces are not treated as copying", () => {
  const candidate = `export function buildLinkGraph(notes: Note[]): LinkGraph {
  const nodes: Node[] = [];
  for (const n of notes) backlinks[n.id] = [];
  return { nodes, edges, backlinks, unresolved };
}`;
  assert.deepEqual(checkCleanRoomIndependence(candidate, ORIGINAL, PUBLIC), { passed: true, violations: [] });
});

test("a line with private identifiers from the original is still rejected", () => {
  const candidate = "const byTitleLookup = buildTitleIndex(notes, normalizeTitle);";
  const result = checkCleanRoomIndependence(candidate, ORIGINAL, PUBLIC);
  assert.equal(result.passed, false);
  assert.match(result.violations[0], /verbatim line/);
});

test("a block of consecutive ordinary lines copied in order is rejected", () => {
  const candidate = [
    "for (const note of notes) {",
    "for (const n of notes) backlinks[n.id] = [];",
    "edges.push({ from: note.id, to: note.id });",
  ].join("\n");
  const result = checkCleanRoomIndependence(candidate, ORIGINAL, PUBLIC);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((v) => /block of consecutive lines/.test(v)), result.violations.join("\n"));
});

test("without the public interface, interface names count as private", () => {
  const candidate = "return { nodes, edges, backlinks, unresolved };";
  assert.equal(checkCleanRoomIndependence(candidate, ORIGINAL).passed, false);
});
