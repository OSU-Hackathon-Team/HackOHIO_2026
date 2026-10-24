// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/04_sandbox_runner.md §6
import assert from "node:assert/strict";
import { runTests } from "../sandbox/runTests.js";

const sm2 = `"use strict";
function updateEase(e, q) { return Math.max(1.3, Math.round((e + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))) * 100) / 100); }
module.exports = { updateEase };`;

const tests = `
test("REQ-1: perfect grade raises ease", () => { assert.equal(nextEaseFactor(2.5, 5), 2.6); });
test("REQ-2: floor at 1.3", () => { assert.equal(nextEaseFactor(1.3, 0), 1.3); });`;

console.log("[sandbox] 1. oracle passes through adapter -> original...");
let r = await runTests({
  kind: "oracle",
  originals: [{ path: "src/scheduler/sm2.js", code: sm2 }],
  subject: {
    lang: "js",
    code: `const m = original("src/scheduler/sm2.js"); module.exports = { nextEaseFactor: (e, q) => m.updateEase(e, q) };`,
  },
  tests,
});
assert.equal(r.fatal, null, `oracle failed: ${r.fatal}`);
assert.equal(r.passed, 2);

console.log("[sandbox] 2. a cheating adapter (doesn't call original) is rejected...");
r = await runTests({
  kind: "oracle",
  originals: [{ path: "src/scheduler/sm2.js", code: sm2 }],
  subject: { lang: "js", code: `module.exports = { nextEaseFactor: (e, q) => (q === 5 ? 2.6 : 1.3) };` },
  tests,
});
assert.equal(r.passed, 0);
assert.match(r.tests[0].error!, /never called original/);

console.log("[sandbox] 3. acceptance mode with a TS engine...");
r = await runTests({
  kind: "acceptance",
  subject: {
    lang: "ts",
    code: `export function nextEaseFactor(e: number, q: number): number { return Math.max(1.3, Math.round((e + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))) * 100) / 100); }`,
  },
  tests,
});
assert.equal(r.fatal, null, `acceptance failed: ${r.fatal}`);
assert.equal(r.passed, 2);

console.log("[sandbox] 4. infinite loop is contained...");
r = await runTests({
  kind: "acceptance",
  subject: { lang: "ts", code: `export function nextEaseFactor() { while (true) {} }` },
  tests,
});
assert.equal(r.passed, 0);
assert.match(r.tests[0].error!, /timed out/i);

console.log("[sandbox] 5. platform stub: requiring electron is fine, calling it fails clearly...");
r = await runTests({
  kind: "oracle",
  originals: [{ path: "src/main.js", code: `const { app } = require("electron"); module.exports = { go: () => app.quit() };` }],
  subject: { lang: "js", code: `const m = original("src/main.js"); module.exports = { nextEaseFactor: () => m.go() };` },
  tests,
});
assert.match(r.tests[0].error!, /platform code/);

console.log("[sandbox] 6. assert.throws accepts an error constructor or name, and rejects the wrong type...");
r = await runTests({
  kind: "acceptance",
  subject: { lang: "ts", code: `export function grade(q: number): number { if (q > 5) throw new RangeError("bad grade"); return q; }` },
  tests: `
test("constructor", () => { assert.throws(() => grade(6), RangeError); });
test("name", () => { assert.throws(() => grade(6), "RangeError"); });
test("wrong type", () => { assert.throws(() => grade(6), TypeError); });`,
});
assert.equal(r.fatal, null, `throws check failed: ${r.fatal}`);
assert.deepEqual(r.tests.map((t) => t.passed), [true, true, false]);

console.log("=== sandbox OK ===");
