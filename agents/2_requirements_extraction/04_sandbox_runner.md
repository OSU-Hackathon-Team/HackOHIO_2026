# 04 — Shared Sandbox Runner (`sandbox/`) — ship to Eng 3 by H4

One runner, used in two modes:

| Mode | Subject (module under test) | `original()` available? | Who uses it |
|---|---|---|---|
| `oracle` | the spec's **adapter** (JS), which delegates to the original app modules | yes, loads evidence snippets | Eng 2: proves tests match the original |
| `acceptance` | the **engine** (TS) written by Eng 3 | no | Eng 3: proves the engine meets the spec |

In both modes, the subject's exports become **globals** for the test file, so the exact same
`acceptance_tests` string runs against the original (through the adapter) and against the new
engine. That symmetry is the core trick of the whole pipeline.

## 1. Install

```bash
npm install -w @splice/backend esbuild
```

## 2. Isolation model (good enough for a hackathon, and say so if asked)

- Each run happens in a **fresh `worker_thread`** with a memory cap, and the parent kills it on
  a hard timeout. Infinite loops and memory blow-ups can't hurt the server.
- Inside the worker, all code runs in a **single fresh `vm` context**: one realm, so deep
  equality between engine output and test literals works. Each module load and each test runs
  under a `vm` timeout.
- The code has no `require` of real modules. Platform modules (`electron`, `fs`, …) are stubs
  that throw when called; `path` gets the posix implementation.
- `vm` isn't a security boundary against a determined attacker. The code we run is our own
  apps' code plus code Claude wrote for us. Worker plus timeout plus no fs/network is
  proportionate.

## 3. `src/sandbox/runTests.ts`

```ts
import { Worker } from "node:worker_threads";
import { transform } from "esbuild";
import type { TestCaseResult } from "@splice/contracts";

export interface SandboxModule {
  path: string;   // "src/scheduler/sm2.js" (as in the evidence)
  code: string;   // CommonJS JavaScript, as shipped in the app
}

export interface RunTestsInput {
  kind: "oracle" | "acceptance";
  subject: { code: string; lang: "js" | "ts" };
  tests: string;                       // TypeScript (types are stripped, not checked)
  originals?: SandboxModule[];         // oracle mode only
  requireOriginalCalls?: boolean;      // default: kind === "oracle"
  perTestTimeoutMs?: number;           // default 500
  totalTimeoutMs?: number;             // default 8000
}

export interface RunTestsResult {
  fatal: string | null;                // compile/load error, timeout, or "no tests"
  tests: TestCaseResult[];
  passed: number;
  total: number;
  duration_ms: number;
}

async function toCjs(code: string, lang: "js" | "ts", sourcefile: string): Promise<string> {
  const r = await transform(code, { loader: lang, format: "cjs", target: "es2022", sourcefile });
  return r.code;
}

const WORKER_URL = new URL("./worker.cjs", import.meta.url);

export async function runTests(input: RunTestsInput): Promise<RunTestsResult> {
  const t0 = performance.now();
  const done = (fatal: string | null, tests: TestCaseResult[] = []): RunTestsResult => ({
    fatal,
    tests,
    passed: tests.filter((t) => t.passed).length,
    total: tests.length,
    duration_ms: Math.round(performance.now() - t0),
  });

  let subjectJs: string;
  let testsJs: string;
  try {
    subjectJs = await toCjs(input.subject.code, input.subject.lang, input.kind === "oracle" ? "adapter.js" : "engine.ts");
    testsJs = await toCjs(input.tests, "ts", "tests.ts");
  } catch (e) {
    return done(`Compile error: ${(e as Error).message}`);
  }

  const totalTimeout = input.totalTimeoutMs ?? 8000;
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_URL, {
      workerData: {
        kind: input.kind,
        subjectJs,
        testsJs,
        originals: input.originals ?? [],
        perTestTimeoutMs: input.perTestTimeoutMs ?? 500,
        requireOriginalCalls: input.requireOriginalCalls ?? input.kind === "oracle",
      },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(done(`Timed out after ${totalTimeout}ms (infinite loop or very slow code?)`));
    }, totalTimeout);
    worker.once("message", (m: { fatal: string | null; tests: TestCaseResult[] }) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(done(m.fatal, m.tests));
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      resolve(done(`Sandbox crashed: ${e.message}`));
    });
  });
}
```

## 4. `src/sandbox/worker.cjs` (plain CommonJS — not compiled by tsx)

```js
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { isDeepStrictEqual, inspect } = require("node:util");
const posix = require("node:path").posix;

const { kind, subjectJs, testsJs, originals, perTestTimeoutMs, requireOriginalCalls } = workerData;

const show = (v) => inspect(v, { depth: 4, breakLength: Infinity });
const errMsg = (e) => (e && typeof e === "object" && "message" in e ? (e.name || "Error") + ": " + e.message : String(e));

class AssertionError extends Error {
  constructor(m) { super(m); this.name = "AssertionError"; }
}
const same = (a, e) => a === e || (Number.isNaN(a) && Number.isNaN(e));
const assert = {
  equal(a, e, m) { if (!same(a, e)) throw new AssertionError(m || "expected " + show(e) + ", got " + show(a)); },
  deepEqual(a, e, m) { if (!isDeepStrictEqual(a, e)) throw new AssertionError(m || "expected " + show(e) + ", got " + show(a)); },
  ok(v, m) { if (!v) throw new AssertionError(m || "expected truthy, got " + show(v)); },
  closeTo(a, e, eps, m) {
    const tol = eps === undefined ? 1e-9 : eps;
    if (typeof a !== "number" || Math.abs(a - e) > tol) throw new AssertionError(m || "expected " + e + " ± " + tol + ", got " + show(a));
  },
  throws(fn, name) {
    try { fn(); } catch (err) {
      if (name && (!err || err.name !== name)) throw new AssertionError("expected " + name + " to be thrown, got " + errMsg(err));
      return;
    }
    throw new AssertionError("expected function to throw");
  },
};

// ---- one realm for everything ----
const tests = [];
const ctx = vm.createContext({
  test: (name, fn) => tests.push({ name: String(name), fn }),
  assert,
  console: { log() {}, info() {}, warn() {}, error() {} },
});

function runModule(code, filename, requireFn, originalFn) {
  const mod = { exports: {} };
  ctx.__f = vm.runInContext("(function (module, exports, require, original) {" + code + "\n})", ctx, { filename });
  ctx.__args = [mod, mod.exports, requireFn, originalFn];
  vm.runInContext("__f.apply(undefined, __args)", ctx, { timeout: 1000 });
  delete ctx.__f;
  delete ctx.__args;
  return mod.exports;
}

// ---- platform stubs: any property chain is fine, calling it throws ----
function stub(name) {
  return new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => "[stub " + name + "]" : stub(name + "." + String(p))),
    apply: () => { throw new Error(name + "() is platform code and is not available in the sandbox"); },
    construct: () => { throw new Error("new " + name + "() is platform code and is not available in the sandbox"); },
  });
}

// ---- originals registry with call counting ----
const norm = (p) => posix.normalize(String(p).replace(/\\/g, "/")).replace(/^(\.\/|\/)+/, "");
const registry = new Map(originals.map((m) => [norm(m.path), m.code]));
const cache = new Map();
const counter = { n: 0 };

function resolveIn(from, spec) {
  const base = spec.startsWith(".") ? posix.join(posix.dirname(from), spec) : spec;
  for (const c of [base, base + ".js", base + "/index.js"]) if (registry.has(norm(c))) return norm(c);
  return null;
}

function counted(exp) {
  const wrap = (f) => function () { counter.n++; return f.apply(this, arguments); };
  if (typeof exp === "function") return wrap(exp);
  if (!exp || typeof exp !== "object") return exp;
  const out = {};
  for (const k of Object.keys(exp)) out[k] = typeof exp[k] === "function" ? wrap(exp[k]) : exp[k];
  return out;
}

function loadOriginal(p) {
  if (cache.has(p)) return cache.get(p);
  cache.set(p, {}); // cycle guard
  const exp = runModule(registry.get(p), p, (spec) => {
    if (spec === "path" || spec === "node:path") return posix;
    if (!spec.startsWith(".")) return stub(spec);
    const r = resolveIn(p, spec);
    if (!r) throw new Error("Cannot find module '" + spec + "' from " + p + " (not part of the evidence)");
    return loadOriginal(r);
  }, noOriginal);
  const c = counted(exp);
  cache.set(p, c);
  return c;
}

function originalFn(p) {
  const r = resolveIn("", p);
  if (!r) throw new Error('original("' + p + '") not found. Available: ' + [...registry.keys()].join(", "));
  return loadOriginal(r);
}
function noOriginal() { throw new Error("original() is only available to the adapter"); }
function noRequire(spec) { throw new Error("require('" + spec + "') is not allowed here; the code must be self-contained"); }

// ---- run ----
function post(fatal, results) { parentPort.postMessage({ fatal, tests: results || [] }); }

let subjectExports;
try {
  subjectExports = runModule(subjectJs, kind === "oracle" ? "adapter.js" : "engine.ts", noRequire, kind === "oracle" ? originalFn : noOriginal);
} catch (e) {
  post((kind === "oracle" ? "Adapter" : "Engine") + " failed to load: " + errMsg(e));
  return;
}
Object.assign(ctx, subjectExports);

try {
  runModule(testsJs, "tests.ts", noRequire, noOriginal);
} catch (e) {
  post("Test file failed to load: " + errMsg(e));
  return;
}
if (tests.length === 0) { post("No tests were registered (did the file call test(...)?)"); return; }

const results = [];
for (const t of tests) {
  counter.n = 0;
  ctx.__t = t.fn;
  const start = performance.now();
  try {
    vm.runInContext("__t()", ctx, { timeout: perTestTimeoutMs });
    if (requireOriginalCalls && counter.n === 0) {
      throw new AssertionError("this test never called original code through the adapter");
    }
    results.push({ name: t.name, kind, passed: true, error: null, duration_ms: Math.round(performance.now() - start) });
  } catch (e) {
    results.push({ name: t.name, kind, passed: false, error: errMsg(e), duration_ms: Math.round(performance.now() - start) });
  }
}
post(null, results);
```

> A top-level `return` is legal in CommonJS: Node wraps the file in a function.
> `performance` is a global in Node 22 workers.

## 5. Contract with Eng 3 (acceptance mode)

```ts
const r = await runTests({
  kind: "acceptance",
  subject: { code: engineTs, lang: "ts" },
  tests: spec.acceptance_tests,
});
// r.fatal !== null → engine didn't compile/load (show it to the model in repair)
// r.tests[i].error → per-test assertion message, e.g. "expected 15, got 16"
```

## 6. `src/scripts/testSandbox.ts` — `npm run test:sandbox` (must pass by H4)

```ts
import assert from "node:assert/strict";
import { runTests } from "../sandbox/runTests.js";

const sm2 = `"use strict";
function updateEase(e, q) { return Math.max(1.3, Math.round((e + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))) * 100) / 100); }
module.exports = { updateEase };`;

const tests = `
test("REQ-1: perfect grade raises ease", () => { assert.equal(nextEaseFactor(2.5, 5), 2.6); });
test("REQ-2: floor at 1.3", () => { assert.equal(nextEaseFactor(1.3, 0), 1.3); });`;

// 1. oracle passes through adapter → original
let r = await runTests({
  kind: "oracle",
  originals: [{ path: "src/scheduler/sm2.js", code: sm2 }],
  subject: { lang: "js", code: `const m = original("src/scheduler/sm2.js"); module.exports = { nextEaseFactor: (e, q) => m.updateEase(e, q) };` },
  tests,
});
assert.equal(r.fatal, null);
assert.equal(r.passed, 2);

// 2. a cheating adapter (doesn't call the original) is rejected
r = await runTests({
  kind: "oracle",
  originals: [{ path: "src/scheduler/sm2.js", code: sm2 }],
  subject: { lang: "js", code: `module.exports = { nextEaseFactor: (e, q) => (q === 5 ? 2.6 : 1.3) };` },
  tests,
});
assert.equal(r.passed, 0);
assert.match(r.tests[0].error!, /never called original/);

// 3. acceptance mode with a TS engine
r = await runTests({
  kind: "acceptance",
  subject: { lang: "ts", code: `export function nextEaseFactor(e: number, q: number): number { return Math.max(1.3, Math.round((e + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))) * 100) / 100); }` },
  tests,
});
assert.equal(r.passed, 2);

// 4. infinite loop is contained
r = await runTests({ kind: "acceptance", subject: { lang: "ts", code: `export function nextEaseFactor() { while (true) {} }` }, tests });
assert.equal(r.passed, 0);
assert.match(r.tests[0].error!, /timed out/i);

// 5. platform stub: requiring electron is fine, calling it fails clearly
r = await runTests({
  kind: "oracle",
  originals: [{ path: "src/main.js", code: `const { app } = require("electron"); module.exports = { go: () => app.quit() };` }],
  subject: { lang: "js", code: `const m = original("src/main.js"); module.exports = { nextEaseFactor: () => m.go() };` },
  tests,
});
assert.match(r.tests[0].error!, /platform code/);

console.log("=== sandbox OK ===");
```
