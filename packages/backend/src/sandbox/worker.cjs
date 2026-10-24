"use strict";
// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/04_sandbox_runner.md §4
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { isDeepStrictEqual, inspect } = require("node:util");
const posix = require("node:path").posix;

if (!parentPort) {
  throw new Error("worker.cjs must be run as a worker thread");
}

const { kind, subjectJs, testsJs, originals = [], perTestTimeoutMs = 500, requireOriginalCalls } = workerData;

const show = (v) => (typeof v === "string" ? v : inspect(v, { depth: 4, breakLength: Infinity }));
const errMsg = (e) => (e && typeof e === "object" && "message" in e ? (e.name || "Error") + ": " + e.message : String(e));

class AssertionError extends Error {
  constructor(m) {
    super(m);
    this.name = "AssertionError";
  }
}
const same = (a, e) => a === e || (Number.isNaN(a) && Number.isNaN(e));
const assert = {
  equal(a, e, m) {
    if (!same(a, e)) throw new AssertionError(m || "expected " + show(e) + ", got " + show(a));
  },
  deepEqual(a, e, m) {
    if (!isDeepStrictEqual(a, e)) throw new AssertionError(m || "expected " + show(e) + ", got " + show(a));
  },
  ok(v, m) {
    if (!v) throw new AssertionError(m || "expected truthy, got " + show(v));
  },
  closeTo(a, e, eps, m) {
    const tol = eps === undefined ? 1e-9 : eps;
    if (typeof a !== "number" || Math.abs(a - e) > tol) {
      throw new AssertionError(m || "expected " + e + " ± " + tol + ", got " + show(a));
    }
  },
  // `expected` may be an error name ("RangeError") or a constructor (RangeError), as in node:assert.
  throws(fn, expected) {
    try {
      fn();
    } catch (err) {
      const name = typeof expected === "function" ? expected.name : expected;
      const matches = !expected || (err && (err.name === name ||
        (typeof expected === "function" && err instanceof expected)));
      if (!matches) {
        throw new AssertionError("expected " + name + " to be thrown, got " + errMsg(err));
      }
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
  console: {
    log(...args) {
      process.stdout.write(args.map(show).join(" ") + "\n");
    },
    info(...args) {
      process.stdout.write(args.map(show).join(" ") + "\n");
    },
    warn(...args) {
      process.stderr.write(args.map(show).join(" ") + "\n");
    },
    error(...args) {
      process.stderr.write(args.map(show).join(" ") + "\n");
    },
  },
});

function runModule(code, filename, requireFn, originalFn) {
  const mod = { exports: {} };
  ctx.__f = vm.runInContext("(function (module, exports, require, original) {\n" + code + "\n})", ctx, {
    filename,
    timeout: 2000,
  });
  ctx.__args = [mod, mod.exports, requireFn, originalFn];
  vm.runInContext("__f.apply(undefined, __args)", ctx, { timeout: 2000 });
  delete ctx.__f;
  delete ctx.__args;
  return mod.exports;
}

// ---- platform stubs: any property chain is fine, calling it throws ----
function stub(name) {
  return new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => "[stub " + name + "]" : stub(name + "." + String(p))),
    apply: () => {
      throw new Error(name + "() is platform code and is not available in the sandbox");
    },
    construct: () => {
      throw new Error("new " + name + "() is platform code and is not available in the sandbox");
    },
  });
}

// ---- originals registry with call counting ----
const norm = (p) => posix.normalize(String(p).replace(/\\/g, "/")).replace(/^(\.\/|\/)+/, "");
const registry = new Map(originals.map((m) => [norm(m.path), m.code]));
const cache = new Map();
const counter = { n: 0 };

function resolveIn(from, spec) {
  const base = spec.startsWith(".") ? posix.join(posix.dirname(from), spec) : spec;
  for (const c of [base, base + ".js", base + "/index.js"]) {
    if (registry.has(norm(c))) return norm(c);
  }
  return null;
}

function counted(exp) {
  const wrap = (f) =>
    function () {
      counter.n++;
      return f.apply(this, arguments);
    };
  if (typeof exp === "function") return wrap(exp);
  if (!exp || typeof exp !== "object") return exp;
  const out = Object.create(Object.getPrototypeOf(exp) || Object.prototype);
  for (const k of Object.keys(exp)) {
    out[k] = typeof exp[k] === "function" ? wrap(exp[k]) : exp[k];
  }
  return out;
}

function loadOriginal(p) {
  if (cache.has(p)) return cache.get(p);
  cache.set(p, {}); // cycle guard
  const exp = runModule(
    registry.get(p),
    p,
    (spec) => {
      if (spec === "path" || spec === "node:path") return posix;
      if (!spec.startsWith(".")) return stub(spec);
      const r = resolveIn(p, spec);
      if (!r) throw new Error("Cannot find module '" + spec + "' from " + p + " (not part of the evidence)");
      return loadOriginal(r);
    },
    noOriginal,
  );
  const c = counted(exp);
  cache.set(p, c);
  return c;
}

function originalFn(p) {
  const r = resolveIn("", p);
  if (!r) throw new Error('original("' + p + '") not found. Available: ' + [...registry.keys()].join(", "));
  return loadOriginal(r);
}
function noOriginal() {
  throw new Error("original() is only available to the adapter");
}
function noRequire(spec) {
  throw new Error("require('" + spec + "') is not allowed here; the code must be self-contained");
}

// ---- run ----
function post(fatal, results) {
  parentPort.postMessage({ fatal, tests: results || [] });
}

let subjectExports;
try {
  subjectExports = runModule(
    subjectJs,
    kind === "oracle" ? "adapter.js" : "engine.ts",
    noRequire,
    kind === "oracle" ? originalFn : noOriginal,
  );
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
if (tests.length === 0) {
  post("No tests were registered (did the file call test(...)?)");
  return;
}

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
    results.push({
      name: t.name,
      kind,
      passed: true,
      error: null,
      duration_ms: Math.round(performance.now() - start),
    });
  } catch (e) {
    results.push({
      name: t.name,
      kind,
      passed: false,
      error: errMsg(e),
      duration_ms: Math.round(performance.now() - start),
    });
  }
}
post(null, results);
