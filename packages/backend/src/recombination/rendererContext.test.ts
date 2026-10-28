import assert from "node:assert/strict";
import { test } from "node:test";
import { compactRendererResult } from "./rendererContext.js";

test("compact model replies bound context without changing the stored evidence", () => {
  const original = { title: "Note", text: "full evidence ".repeat(10_000), rendered: "<p>Original</p>".repeat(1000),
    controls: Array.from({ length: 100 }, (_, index) => ({ ref: `@${index}`, tag: "BUTTON", label: `Action ${index}`, class: "private full DOM metadata" })),
  };
  const before = JSON.stringify(original);
  const reply = compactRendererResult(original);
  assert(JSON.stringify(reply).length <= 6000);
  assert.match(JSON.stringify(reply), /@0/);
  assert.equal(JSON.stringify(original), before);
  assert(JSON.stringify(compactRendererResult({ elements: "x".repeat(30_000) })).length < 5200);
});

test("editable refs remain available when the ordinary control list is compacted", () => {
  const controls = Array.from({ length: 80 }, (_, i) => ({ ref: `@${i}`, tag: "BUTTON", text: `Control ${i}` }));
  const reply = compactRendererResult({ text: "fixture", controls: [...controls,
    { ref: "@80", tag: "DIV", role: "textbox", editable: true }] }) as { editable_controls: Array<{ ref: string }> };
  assert.deepEqual(reply.editable_controls.map(c => c.ref), ["@80"]);
});
