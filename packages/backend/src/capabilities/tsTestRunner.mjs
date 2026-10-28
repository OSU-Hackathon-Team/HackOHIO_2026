import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodeWireValue, encodeWireValue } from "@splice/contracts";

const [moduleFile, definitionFile, testsFile] = process.argv.slice(2);
const definition = JSON.parse(await fs.readFile(definitionFile, "utf8"));
const tests = JSON.parse(await fs.readFile(testsFile, "utf8"));
const loaded = await import(pathToFileURL(path.resolve(moduleFile)).href);
const defaultExport = loaded.default && typeof loaded.default === "object" ? loaded.default : {};
const operations = loaded.operations ?? defaultExport.operations;
if (!operations || typeof operations !== "object") throw new Error("built package has no operations table");

function countedAssert(counter) {
  return new Proxy(assert, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        counter.assertions += 1;
        return Reflect.apply(value, target, args);
      };
    },
    apply(target, thisArg, args) {
      counter.assertions += 1;
      return Reflect.apply(target, thisArg, args);
    },
  });
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const outcomes = [];
for (const test of tests) {
  const operationByName = new Map(definition.operations.map((operation) => [operation.name, operation]));
  const counts = { calls: 0, assertions: 0 };
  const context = {
    async call(name, input) {
      const operation = operationByName.get(name);
      const handler = operations[name];
      if (!operation || typeof handler !== "function") throw new Error(`unknown operation ${name}`);
      counts.calls += 1;
      const validatedInput = decodeWireValue(operation.request, encodeWireValue(operation.request, input));
      const raw = await handler(validatedInput, { operation: name, log() {}, emit() {} });
      return decodeWireValue(operation.result, encodeWireValue(operation.result, raw));
    },
    get assert() {
      return countedAssert(counts);
    },
  };

  const started = Date.now();
  let passed = false;
  let detail = "";
  try {
    await new AsyncFunction("ctx", test.code)(context);
    passed = counts.calls > 0 && counts.assertions > 0;
    if (!passed) detail = "test passed without a real call and assertion";
  } catch (error) {
    detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  outcomes.push({
    name: test.name,
    kind: "public",
    passed,
    requirement_ids: test.requirement_ids,
    duration_ms: Date.now() - started,
    assertions: counts.assertions,
    calls: counts.calls,
    detail: detail || "public behavior matched",
  });
}

process.stdout.write(`@@SPLICE_RESULT@@${JSON.stringify({ tests: outcomes })}\n`);
