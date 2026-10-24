process.env.NODE_ENV = "test";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTests, RunTestsInputSchema } from "../dist/sandbox/runTests.js";

const sm2Original = `"use strict";
function updateEase(e, q) {
  return Math.max(1.3, Math.round((e + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))) * 100) / 100);
}
function calculateInterval(rep, ease) {
  if (rep === 1) return 1;
  if (rep === 2) return 6;
  return Math.round(6 * ease);
}
module.exports = { updateEase, calculateInterval };`;

describe("Step 2: Sandbox Runner Suite", () => {
  describe("Successful Execution", () => {
    it("runs oracle tests against original code via an adapter", async () => {
      const tests = `
        test("REQ-1: updateEase with grade 5", () => {
          assert.equal(nextEase(2.5, 5), 2.6);
        });
        test("REQ-2: calculateInterval with 1 rep", () => {
          assert.equal(interval(1, 2.5), 1);
        });
      `;

      const result = await runTests({
        kind: "oracle",
        originals: [{ path: "src/scheduler/sm2.js", code: sm2Original }],
        subject: {
          lang: "js",
          code: `
            const m = original("src/scheduler/sm2.js");
            module.exports = {
              nextEase: (e, q) => m.updateEase(e, q),
              interval: (r, e) => m.calculateInterval(r, e),
            };
          `,
        },
        tests,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 2);
      assert.equal(result.total, 2);
      assert.equal(result.tests[0].name, "REQ-1: updateEase with grade 5");
      assert.equal(result.tests[0].passed, true);
      assert.equal(result.tests[0].kind, "oracle");
      assert.equal(result.tests[1].passed, true);
      assert.ok(result.duration_ms >= 0);
    });

    it("runs acceptance tests against a TypeScript engine", async () => {
      const tsEngine = `
        export interface SM2State {
          ease: number;
        }
        export function computeNextEase(state: SM2State, grade: number): number {
          return Math.max(1.3, Math.round((state.ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))) * 100) / 100);
        }
      `;

      const tests = `
        test("REQ-1: acceptance test for engine computeNextEase", () => {
          assert.equal(computeNextEase({ ease: 2.5 }, 5), 2.6);
          assert.equal(computeNextEase({ ease: 1.3 }, 0), 1.3);
        });
      `;

      const result = await runTests({
        kind: "acceptance",
        subject: { lang: "ts", code: tsEngine },
        tests,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 1);
      assert.equal(result.total, 1);
      assert.equal(result.tests[0].passed, true);
      assert.equal(result.tests[0].kind, "acceptance");
    });

    it("handles assert.closeTo, assert.throws, and assert.deepEqual", async () => {
      const tests = `
        test("assertions test", () => {
          assert.deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] });
          assert.closeTo(1.000000001, 1.0, 1e-6);
          assert.throws(() => { throw new Error("Boom"); });
          assert.throws(() => {
            const err = new TypeError("Bad type");
            throw err;
          }, "TypeError");
          assert.ok(true);
        });
      `;

      const result = await runTests({
        kind: "acceptance",
        subject: { lang: "ts", code: `export const ready = true;` },
        tests,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 1);
      assert.equal(result.tests[0].passed, true);
    });
  });

  describe("Nonzero Exit, Compilation Failure, and Errors", () => {
    it("reports compile error for malformed TypeScript in subject", async () => {
      const result = await runTests({
        kind: "acceptance",
        subject: { lang: "ts", code: `export function broken( { return 1;` },
        tests: `test("dummy", () => assert.ok(true));`,
      });

      assert.ok(result.fatal !== null);
      assert.match(result.fatal!, /Compile error/i);
      assert.equal(result.passed, 0);
      assert.equal(result.total, 0);
    });

    it("reports compile error for malformed TypeScript in tests", async () => {
      const result = await runTests({
        kind: "acceptance",
        subject: { lang: "ts", code: `export const ok = true;` },
        tests: `test("broken test", () => { let x: = 123; });`,
      });

      assert.ok(result.fatal !== null);
      assert.match(result.fatal!, /Compile error/i);
      assert.equal(result.passed, 0);
    });

    it("reports fatal load error when subject throws during initialization", async () => {
      const result = await runTests({
        kind: "acceptance",
        subject: { lang: "ts", code: `throw new Error("Init crash");` },
        tests: `test("test1", () => assert.ok(true));`,
      });

      assert.ok(result.fatal !== null);
      assert.match(result.fatal!, /Engine failed to load:.*Init crash/);
      assert.equal(result.passed, 0);
    });

    it("captures test assertions failures without failing the entire suite", async () => {
      const tests = `
        test("passing test", () => assert.equal(1, 1));
        test("failing test", () => assert.equal(1, 2, "numbers not equal"));
      `;

      const result = await runTests({
        kind: "acceptance",
        subject: { lang: "ts", code: `export const x = 1;` },
        tests,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 1);
      assert.equal(result.total, 2);
      assert.equal(result.tests[0].passed, true);
      assert.equal(result.tests[1].passed, false);
      assert.match(result.tests[1].error!, /numbers not equal/);
    });
  });

  describe("Timeouts and Infinite Loops", () => {
    it("contains infinite loop in a test via perTestTimeoutMs", async () => {
      const tests = `
        test("REQ-1: infinite loop", () => {
          while (true) {}
        });
        test("REQ-2: normal test", () => {
          assert.equal(1, 1);
        });
      `;

      const result = await runTests({
        kind: "acceptance",
        subject: { lang: "ts", code: `export const x = 1;` },
        tests,
        perTestTimeoutMs: 100,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 1);
      assert.equal(result.total, 2);
      assert.equal(result.tests[0].passed, false);
      assert.match(result.tests[0].error!, /timed out/i);
      assert.equal(result.tests[1].passed, true);
    });

    it("aborts when total execution exceeds totalTimeoutMs", async () => {
      // Simulate slow execution that exceeds total budget
      const result = await runTests({
        kind: "acceptance",
        subject: {
          lang: "ts",
          code: `
            // Busy loop during top-level load
            const start = Date.now();
            while (Date.now() - start < 600) {}
            export const done = true;
          `,
        },
        tests: `test("t", () => assert.ok(true));`,
        totalTimeoutMs: 150,
      });

      assert.ok(result.fatal !== null);
      assert.match(result.fatal!, /Timed out after 150ms/i);
      assert.equal(result.passed, 0);
    });
  });

  describe("Cheating Adapter Detection (Oracle Mode)", () => {
    it("rejects an adapter that does not invoke the original module", async () => {
      const tests = `
        test("REQ-1: test", () => {
          assert.equal(nextEase(2.5, 5), 2.6);
        });
      `;

      const result = await runTests({
        kind: "oracle",
        originals: [{ path: "src/scheduler/sm2.js", code: sm2Original }],
        subject: {
          lang: "js",
          code: `
            // Cheating: hardcoded without calling original()
            module.exports = { nextEase: (e, q) => 2.6 };
          `,
        },
        tests,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 0);
      assert.equal(result.total, 1);
      assert.match(result.tests[0].error!, /never called original code through the adapter/);
    });

    it("allows bypassing original check when requireOriginalCalls is explicitly false", async () => {
      const result = await runTests({
        kind: "oracle",
        requireOriginalCalls: false,
        originals: [{ path: "src/scheduler/sm2.js", code: sm2Original }],
        subject: {
          lang: "js",
          code: `module.exports = { calc: () => 42 };`,
        },
        tests: `test("calc", () => assert.equal(calc(), 42));`,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 1);
    });
  });

  describe("Platform Stubs and Isolation Guarantees", () => {
    it("stubs electron and throws when called", async () => {
      const originalWithElectron = `
        const { app, BrowserWindow } = require("electron");
        function quit() { return app.quit(); }
        module.exports = { quit };
      `;

      const result = await runTests({
        kind: "oracle",
        originals: [{ path: "src/main.js", code: originalWithElectron }],
        subject: {
          lang: "js",
          code: `
            const m = original("src/main.js");
            module.exports = { doQuit: () => m.quit() };
          `,
        },
        tests: `test("quit test", () => doQuit());`,
      });

      assert.equal(result.passed, 0);
      assert.match(result.tests[0].error!, /platform code and is not available in the sandbox/);
    });

    it("prevents require() calls inside subject code", async () => {
      const result = await runTests({
        kind: "acceptance",
        subject: {
          lang: "js",
          code: `const fs = require("fs"); module.exports = { read: () => fs.readFileSync("/etc/passwd") };`,
        },
        tests: `test("t", () => read());`,
      });

      assert.ok(result.fatal !== null);
      assert.match(result.fatal!, /require\('fs'\) is not allowed here/);
    });

    it("prevents engine from accessing original() function", async () => {
      const result = await runTests({
        kind: "acceptance",
        subject: {
          lang: "js",
          code: `const o = original("src/main.js"); module.exports = {};`,
        },
        tests: `test("t", () => assert.ok(true));`,
      });

      assert.ok(result.fatal !== null);
      assert.match(result.fatal!, /original\(\) is only available to the adapter/);
    });
  });

  describe("Boundary Validation of Requests", () => {
    it("rejects malformed inputs with missing required fields", async () => {
      // @ts-expect-error Testing boundary validation with invalid object
      const result = await runTests({ kind: "invalid-kind" });

      assert.ok(result.fatal !== null);
      assert.match(result.fatal!, /Invalid input:/);
      assert.equal(result.passed, 0);
    });

    it("reports fatal error when test file defines zero tests", async () => {
      const result = await runTests({
        kind: "acceptance",
        subject: { lang: "ts", code: `export const val = 1;` },
        tests: `// No test() calls here!`,
      });

      assert.ok(result.fatal !== null);
      assert.match(result.fatal!, /No tests were registered/);
      assert.equal(result.passed, 0);
    });

    it("verifies RunTestsInputSchema parser validates valid structures", () => {
      const parsed = RunTestsInputSchema.parse({
        kind: "acceptance",
        subject: { code: "export const x = 1;", lang: "ts" },
        tests: "test('a', () => {});",
      });
      assert.equal(parsed.kind, "acceptance");
      assert.equal(parsed.perTestTimeoutMs, 500);
      assert.equal(parsed.totalTimeoutMs, 8000);
    });
  });

  describe("Standard Output and Error Capture", () => {
    it("captures stdout and stderr from console logs inside the sandbox", async () => {
      const tests = `
        test("logging test", () => {
          console.log("standard output line 1");
          console.error("standard error line 2");
          assert.ok(true);
        });
      `;

      const result = await runTests({
        kind: "acceptance",
        subject: { lang: "ts", code: `export const val = 1;` },
        tests,
      });

      assert.equal(result.fatal, null);
      assert.equal(result.passed, 1);
      assert.ok(result.stdout?.includes("standard output line 1"));
      assert.ok(result.stderr?.includes("standard error line 2"));
    });
  });
});
