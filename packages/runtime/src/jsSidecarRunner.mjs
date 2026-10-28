// A standalone JSON protocol runner. The host starts this inside a Linux mount/PID/network
// namespace, so package code never executes in the Electron or backend process.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
if (!entry) throw new Error("JS package entrypoint is required");
const imported = await import(pathToFileURL(entry).href);
const defaultObject = imported.default && typeof imported.default === "object" ? imported.default : {};
const operations = imported.operations ?? defaultObject.operations ?? imported.default;
if (!operations || typeof operations !== "object") throw new Error("package must export operations");

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$int") return BigInt(value.$int);
    if (keys.length === 1 && keys[0] === "$float") {
      if (value.$float === "nan") return NaN;
      if (value.$float === "infinity") return Infinity;
      if (value.$float === "-infinity") return -Infinity;
      throw new Error("invalid tagged float");
    }
    if (keys.length === 1 && keys[0] === "$bytes") return Buffer.from(value.$bytes, "base64");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

function encode(value) {
  if (typeof value === "bigint") return { $int: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { $float: Number.isNaN(value) ? "nan" : value > 0 ? "infinity" : "-infinity" };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}

function send(message) {
  process.stdout.write(JSON.stringify(encode(message)) + "\n");
}

function errorPayload(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "operation_failed",
    message: typeof error?.message === "string" ? error.message : String(error),
    retryable: error?.retryable === true,
  };
}

const context = (id, operation) => ({
  operation,
  emit(event) { send({ id, event }); },
  log(line) { process.stderr.write(String(line).slice(0, 1000) + "\n"); },
});

const start = typeof imported.start === "function" ? imported.start : defaultObject.start;
const dispose = typeof imported.dispose === "function" ? imported.dispose : defaultObject.dispose;
if (typeof start === "function") await start(context("__start", "lifecycle"));

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let request;
  try { request = JSON.parse(line); } catch { process.stderr.write("invalid JSON request\n"); continue; }
  if (!request || typeof request.id !== "string" || typeof request.op !== "string") continue;
  if (request.op === "__dispose") {
    if (typeof dispose === "function") await dispose(context(request.id, "lifecycle"));
    break;
  }
  const fn = operations[request.op];
  if (typeof fn !== "function") {
    send({ id: request.id, ok: false, error: { code: "unknown_operation", message: `unknown operation ${request.op}` } });
    continue;
  }
  try {
    const value = await fn(decode(request.args), context(request.id, request.op));
    send({ id: request.id, ok: true, value });
  } catch (error) {
    send({ id: request.id, ok: false, error: errorPayload(error) });
  }
}
lines.close();
process.stdin.pause();
