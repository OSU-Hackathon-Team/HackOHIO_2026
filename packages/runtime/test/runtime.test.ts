import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { canonicalJson, type CapabilityDefinition, type CapabilityPackage, type WireObjectType } from "@splice/contracts";
import { createCapabilityClient } from "../src/client.js";
import { FsBlobStore } from "../src/host.js";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (fields: WireObjectType["fields"]): WireObjectType => ({ kind: "object", fields, additional: false });
const i64 = { kind: "int", bits: 64, signed: true } as const;
const f64 = { kind: "float", bits: 64 } as const;
const text = { kind: "string", encoding: "utf-8", max_bytes: 1000 } as const;
const empty = object([{ name: "value", type: { kind: "bool" }, optional: false }]);
const errors = object([{ name: "code", type: text, optional: false }, { name: "message", type: text, optional: false }]);

function definition(runtime: CapabilityDefinition["preferred_runtime"]): CapabilityDefinition {
  return {
    schema_version: 1,
    id: "splice.runtime.fixture",
    version: "1.0.0",
    title: "Runtime transport fixture",
    description: "Authored fixture for typed worker and sidecar boundaries.",
    origin: { kind: "authored", artifact_hash: "0".repeat(64), artifact_ref: "authored_development/runtime", source_app: "Splice", stage: "downstream_authored" },
    selected_behavior: ["Echo typed values", "exercise timeout and crash handling"],
    exclusions: [],
    operations: [
      { name: "echo", summary: "Echo typed values.", request: object([{ name: "number", type: i64, optional: false }, { name: "special", type: f64, optional: false }]), result: object([{ name: "number", type: i64, optional: false }, { name: "special", type: f64, optional: false }]), error: errors, idempotent: true, cancellable: true, timeout_ms: 1000, streaming: null, host_effects: [] },
      { name: "hang", summary: "Wait indefinitely.", request: empty, result: empty, error: errors, idempotent: true, cancellable: true, timeout_ms: 1000, streaming: null, host_effects: [] },
      { name: "crash", summary: "Exit without reply.", request: empty, result: empty, error: errors, idempotent: false, cancellable: false, timeout_ms: 1000, streaming: null, host_effects: [] },
      { name: "restricted", summary: "Require network permission.", request: empty, result: empty, error: errors, idempotent: true, cancellable: false, timeout_ms: 1000, streaming: null, host_effects: ["network"] },
      { name: "probe", summary: "Probe visible filesystem paths.", request: object([{ name: "path", type: text, optional: false }]), result: object([{ name: "visible", type: { kind: "bool" }, optional: false }]), error: errors, idempotent: true, cancellable: false, timeout_ms: 1000, streaming: null, host_effects: [] },
      { name: "network_probe", summary: "Probe a host TCP port.", request: object([{ name: "port", type: { kind: "int", bits: 32, signed: true }, optional: false }]), result: object([{ name: "reachable", type: { kind: "bool" }, optional: false }]), error: errors, idempotent: true, cancellable: false, timeout_ms: 1000, streaming: null, host_effects: [] },
      { name: "stream", summary: "Emit ordered typed events.", request: empty, result: empty, error: errors, idempotent: true, cancellable: true, timeout_ms: 1000, streaming: { event: object([{ name: "seq", type: { kind: "int", bits: 32, signed: true }, optional: false }]), ordering: "ordered", max_events: 2 }, host_effects: [] },
      { name: "read_env", summary: "Read an explicitly provided sandbox variable.", request: empty, result: object([{ name: "value", type: text, optional: false }]), error: errors, idempotent: true, cancellable: false, timeout_ms: 1000, streaming: null, host_effects: [] },
    ],
    provides: [], requires: [],
    state: { ownership: "package", durable: false, schema: null, migrations: [] },
    lifecycle: { start_operation: null, dispose_operation: null, restart_policy: "on_crash" },
    host_effects: [{ effect: "network", scope: "fixture", reason: "Permission gate test" }],
    assumptions: [], preferred_runtime: runtime,
    public_tests: [{ name: "echo", requirement_ids: ["R1"], kind: "public" }],
  };
}

function fixture(runtime: "ts_worker" | "native_sidecar", entrySource: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-runtime-fixture-"));
  const def = definition(runtime);
  const definitionHash = sha256(canonicalJson(def));
  const entry = runtime === "ts_worker" ? "module.mjs" : "sidecar.mjs";
  const source = Buffer.from(entrySource);
  fs.writeFileSync(path.join(root, entry), source, { mode: 0o755 });
  const pkg = {
    schema_version: 1,
    package_id: `pkg_${"a".repeat(32)}`,
    definition: { id: def.id, version: def.version, hash: definitionHash },
    runtime_kind: runtime,
    entrypoints: [{ kind: runtime === "ts_worker" ? "module" : "sidecar_executable", path: entry, protocol: runtime === "ts_worker" ? "splice-ts-module-v1" : "splice-sidecar-v1" }],
    platforms: [{ os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64" }],
    build: { recipe: "fixture", toolchain: { name: "node", version: process.version }, source_hash: sha256(source), build_hash: sha256(source), reproducible: true, log_hash: sha256(source), attempts: 0 },
    artifacts: [{ path: entry, sha256: sha256(source), size: source.length, kind: "binary" }],
    dependency_lock: [], assets: [],
    verification: { schema_version: 1, generated_at: new Date().toISOString(), generator: "runtime-fixture", tests: [], mutation: { total: 0, killed: 0, survivors: [] }, purity_violations: [], type_errors: [], boundary_checks: [], blockers: [], verdict: "passed", report_hash: "0".repeat(64) },
    independent_verdict_ref: null,
    readiness: { upstream_review: { status: "not_applicable", detail: "fixture", at: null, evidence_hash: null }, implementation_checks: { status: "passed", detail: "fixture", at: null, evidence_hash: null }, independent_behavior_checks: { status: "not_applicable", detail: "fixture", at: null, evidence_hash: null }, composition_checks: { status: "not_run", detail: "fixture", at: null, evidence_hash: null }, packaging_checks: { status: "passed", detail: "fixture", at: null, evidence_hash: null } },
    created_at: new Date().toISOString(),
  } as CapabilityPackage;
  return { root, def, pkg, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const workerCode = `
import fs from "node:fs";
import { createConnection } from "node:net";
export const operations = {
  echo: ({ number, special }) => ({ number, special }),
  hang: () => new Promise(() => {}),
  crash: () => { process.exit(7); },
  restricted: ({ value }) => ({ value }),
  probe: ({ path }) => ({ visible: fs.existsSync(path) }),
  network_probe: ({ port }) => new Promise((resolve) => { const socket = createConnection({ host: "127.0.0.1", port }); socket.once("connect", () => { socket.destroy(); resolve({ reachable: true }); }); socket.once("error", () => resolve({ reachable: false })); socket.setTimeout(250, () => { socket.destroy(); resolve({ reachable: false }); }); }),
  stream: (_input, ctx) => { ctx.emit({ seq: 1 }); ctx.emit({ seq: 2 }); return { value: true }; },
  read_env: () => ({ value: process.env.SPLICE_TEST_VALUE ?? "" }),
};
export function dispose(ctx) { ctx.log("disposed"); }
`;

const sidecarCode = `#!/usr/bin/env node
import fs from "node:fs";
let buffer = "";
process.stdin.on("data", (chunk) => { buffer += chunk.toString(); for (;;) { const end = buffer.indexOf("\\n"); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); const request = JSON.parse(line); if (request.op === "crash") process.exit(7); if (request.op === "hang") continue; const value = request.op === "echo" ? request.args : request.op === "probe" ? { visible: fs.existsSync(request.args.path) } : { value: true }; process.stdout.write(JSON.stringify({ id: request.id, ok: true, value }) + "\\n"); } });
`;

test("isolated JS process validates int64 and NaN, enforces permissions, and restarts after timeout", async () => {
  const f = fixture("ts_worker", workerCode);
  const client = await createCapabilityClient(f.pkg, { definition: f.def, artifactRoot: f.root });
  try {
    const value = await client.call("echo", { number: 9223372036854775807n, special: NaN });
    assert.equal(value.number, 9223372036854775807n);
    assert.equal(Number.isNaN(value.special), true);
    await assert.rejects(() => client.call("restricted", { value: true }), (error: { code?: string }) => error.code === "permission_denied");
    await assert.rejects(() => client.call("hang", { value: true }, { timeoutMs: 30 }), (error: { code?: string }) => error.code === "timeout");
    assert.equal((await client.call("echo", { number: -1n, special: Infinity })).number, -1n);
    const events: unknown[] = [];
    assert.deepEqual(await client.call("stream", { value: true }, { onEvent: (event) => events.push(event) }), { value: true });
    assert.deepEqual(events, [{ seq: 1 }, { seq: 2 }]);
    const controller = new AbortController();
    const pending = client.call("hang", { value: true }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => pending, (error: { code?: string }) => error.code === "cancelled");
  } finally { await client.dispose(); f.cleanup(); }
});

test("JS package process sees its package but not a host scratch file", async () => {
  const f = fixture("ts_worker", workerCode);
  const outside = path.join(os.tmpdir(), `splice-js-secret-${process.pid}`);
  fs.writeFileSync(outside, "host-only");
  const client = await createCapabilityClient(f.pkg, { definition: f.def, artifactRoot: f.root });
  try {
    assert.deepEqual(await client.call("probe", { path: "/package/module.mjs" }), { visible: true });
    assert.deepEqual(await client.call("probe", { path: outside }), { visible: false });
  } finally {
    await client.dispose();
    fs.rmSync(outside, { force: true });
    f.cleanup();
  }
});

test("JS package process cannot connect to a host TCP listener", async () => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP test listener has no port");
  const f = fixture("ts_worker", workerCode);
  const client = await createCapabilityClient(f.pkg, { definition: f.def, artifactRoot: f.root });
  try {
    assert.deepEqual(await client.call("network_probe", { port: address.port }), { reachable: false });
  } finally {
    await client.dispose();
    f.cleanup();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("JS process runs its dispose hook before host teardown", async () => {
  const f = fixture("ts_worker", workerCode);
  const logs: string[] = [];
  const client = await createCapabilityClient(f.pkg, { definition: f.def, artifactRoot: f.root, onLog: (line) => logs.push(line) });
  try {
    await client.call("echo", { number: 1n, special: 1 });
    await client.dispose();
    assert.ok(logs.includes("disposed"));
  } finally {
    await client.dispose();
    f.cleanup();
  }
});

test("package environment is validated and made available inside the namespace", async () => {
  const f = fixture("ts_worker", workerCode);
  try {
    await assert.rejects(
      () => createCapabilityClient(f.pkg, { definition: f.def, artifactRoot: f.root, env: { "BAD=KEY": "value" } }),
      /invalid package environment variable/,
    );
    const client = await createCapabilityClient(f.pkg, { definition: f.def, artifactRoot: f.root, env: { SPLICE_TEST_VALUE: "inside" } });
    try { assert.deepEqual(await client.call("read_env", { value: true }), { value: "inside" }); }
    finally { await client.dispose(); }
  } finally { f.cleanup(); }
});

test("sidecar validates tagged values and contains a crashed child", async () => {
  const f = fixture("native_sidecar", sidecarCode);
  const client = await createCapabilityClient(f.pkg, { definition: f.def, artifactRoot: f.root });
  try {
    const value = await client.call("echo", { number: -9223372036854775808n, special: -Infinity });
    assert.equal(value.number, -9223372036854775808n);
    assert.equal(value.special, -Infinity);
    await assert.rejects(() => client.call("crash", { value: true }), (error: { code?: string }) => error.code === "crashed");
    assert.equal((await client.call("echo", { number: 3n, special: 1.5 })).number, 3n);
  } finally { await client.dispose(); f.cleanup(); }
});

test("native sidecar sees its read-only package but not a host scratch file", async () => {
  const f = fixture("native_sidecar", sidecarCode);
  const outside = path.join(os.tmpdir(), `splice-sidecar-secret-${process.pid}`);
  fs.writeFileSync(outside, "host-only");
  const client = await createCapabilityClient(f.pkg, { definition: f.def, artifactRoot: f.root });
  try {
    assert.deepEqual(await client.call("probe", { path: "/package/sidecar.mjs" }), { visible: true });
    assert.deepEqual(await client.call("probe", { path: outside }), { visible: false });
  } finally {
    await client.dispose();
    fs.rmSync(outside, { force: true });
    f.cleanup();
  }
});

test("a saved audio blob is rejected if its bytes change before provider replay", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-blob-integrity-"));
  try {
    const blobs = new FsBlobStore(root);
    const ref = await blobs.put(new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(await blobs.get(ref), new Uint8Array([1, 2, 3, 4]));
    fs.writeFileSync(path.join(root, ref.id.slice(0, 2), ref.id), Buffer.from([4, 3, 2, 1]));
    await assert.rejects(() => blobs.get(ref), (error: { code?: string }) => error.code === "blob_corrupt");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
