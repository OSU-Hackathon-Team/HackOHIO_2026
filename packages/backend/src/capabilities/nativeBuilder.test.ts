import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { CapabilityDefinition, WireObjectType } from "@splice/contracts";
import { nativeSchemaProblems, buildNativePackage } from "./nativeBuilder.js";
import type { BuildInput } from "./types.js";

const i64 = { kind: "int", bits: 64, signed: true } as const;
const text = { kind: "string", encoding: "utf-8", max_bytes: 120 } as const;

const errorSchema: WireObjectType = {
  kind: "object",
  additional: false,
  fields: [
    { name: "code", type: { kind: "enum", values: ["overflow", "division_by_zero", "internal"] }, optional: false },
    { name: "message", type: text, optional: false },
  ],
};

function definition(): CapabilityDefinition {
  return {
    schema_version: 1,
    id: "splice.test.native_math",
    version: "1.0.0",
    title: "Native integer math fixture",
    description: "Development fixture used to prove the native sidecar transport.",
    origin: {
      kind: "authored",
      artifact_hash: "0".repeat(64),
      artifact_ref: "authored_development/native_math@1",
      source_app: "Splice authored development fixture",
      stage: "downstream_authored",
    },
    selected_behavior: ["signed 64-bit addition with overflow detection", "signed 64-bit division with zero detection"],
    exclusions: ["no unsigned support", "no arrays"],
    operations: [
      {
        name: "add_i64",
        summary: "Add two signed 64-bit integers.",
        request: {
          kind: "object",
          additional: false,
          fields: [
            { name: "a", type: i64, optional: false },
            { name: "b", type: i64, optional: false },
          ],
        },
        result: {
          kind: "object",
          additional: false,
          fields: [{ name: "sum", type: i64, optional: false }],
        },
        error: errorSchema,
        idempotent: true,
        cancellable: false,
        timeout_ms: 2_000,
        streaming: null,
        host_effects: [],
      },
      {
        name: "divide_i64",
        summary: "Divide with explicit zero handling.",
        request: {
          kind: "object",
          additional: false,
          fields: [
            { name: "a", type: i64, optional: false },
            { name: "b", type: i64, optional: false },
          ],
        },
        result: {
          kind: "object",
          additional: false,
          fields: [
            { name: "quotient", type: i64, optional: false },
            { name: "remainder", type: i64, optional: false },
          ],
        },
        error: errorSchema,
        idempotent: true,
        cancellable: false,
        timeout_ms: 2_000,
        streaming: null,
        host_effects: [],
      },
    ],
    provides: [],
    requires: [],
    state: { ownership: "package", durable: false, schema: null, migrations: [] },
    lifecycle: { start_operation: null, dispose_operation: null, restart_policy: "on_crash" },
    host_effects: [],
    assumptions: ["linux x64", "gcc"],
    preferred_runtime: "native_sidecar",
    public_tests: [
      { name: "add", requirement_ids: ["REQ-1"], kind: "public" },
      { name: "divide", requirement_ids: ["REQ-2"], kind: "public" },
    ],
  };
}

const candidate = `#include <stdint.h>
#include <stddef.h>

int splice_add_i64(int64_t a, int64_t b, int64_t* sum) {
  if (__builtin_add_overflow(a, b, sum)) return 1;
  return 0;
}

int splice_divide_i64(int64_t a, int64_t b, int64_t* quotient, int64_t* remainder) {
  if (b == 0) return 2;
  *quotient = a / b;
  *remainder = a % b;
  return 0;
}
`;

function input(): BuildInput {
  return {
    intake_id: `int_${"0".repeat(32)}`,
    definition: definition(),
    implementation: {
      kind: "c",
      entry: "candidate.c",
      files: [{ path: "candidate.c", content: candidate, encoding: "utf8" }],
      compiler: { name: "gcc", flags: [] },
    },
    public_tests: [
      {
        name: "add cases",
        requirement_ids: ["REQ-1"],
        harness: "c",
        code: JSON.stringify([
          { op: "add_i64", args: { a: "1", b: "2" }, expect: { sum: "3" } },
          { op: "add_i64", args: { a: "9223372036854775807", b: "1" }, expect_error: { code: "overflow" } },
        ]),
      },
      {
        name: "divide cases",
        requirement_ids: ["REQ-2"],
        harness: "c",
        code: JSON.stringify([
          { op: "divide_i64", args: { a: "7", b: "2" }, expect: { quotient: "3", remainder: "1" } },
          { op: "divide_i64", args: { a: "7", b: "0" }, expect_error: { code: "division_by_zero" } },
        ]),
      },
    ],
  };
}

describe("native capability builder", () => {
  it("rejects ambiguous native schemas", () => {
    const definitionValue = definition();
    definitionValue.operations[0] = {
      ...definitionValue.operations[0],
      request: {
        kind: "object",
        additional: false,
        fields: [
          { name: "a", type: { kind: "array", items: i64, max_items: 4, ordered: true }, optional: false },
          { name: "b", type: i64, optional: true },
        ],
      },
      streaming: { event: definitionValue.operations[0].result, ordering: "ordered", max_events: 1 },
    };
    const problems = nativeSchemaProblems(definitionValue);
    assert.ok(problems.some((problem) => problem.includes("optional")));
    assert.ok(problems.some((problem) => problem.includes("array")));
    assert.ok(problems.some((problem) => problem.includes("streaming")));
  });

  it("rejects integer widths the generated shim cannot safely parse", () => {
    const narrow = definition();
    narrow.operations[0].request.fields[0].type = { kind: "int", bits: 16, signed: true };
    assert.ok(nativeSchemaProblems(narrow).some((problem) => problem.includes("signed 32-bit and 64-bit")));
    const unsigned = definition();
    unsigned.operations[0].request.fields[0].type = { kind: "int", bits: 64, signed: false };
    assert.ok(nativeSchemaProblems(unsigned).some((problem) => problem.includes("signed 32-bit and 64-bit")));
  });

  it("builds, compiles and verifies a native package through the sidecar", async () => {
    const built = await buildNativePackage(input(), { onStage: () => {} });
    assert.equal(built.package.runtime_kind, "native_sidecar");
    assert.equal(built.package.verification.verdict, "passed");
    assert.equal(built.package.readiness.implementation_checks.status, "passed");
    const artifacts = new Map(built.files.map((file) => [file.path, file.data]));
    assert.ok(artifacts.has("bin/sidecar"));
    assert.ok(artifacts.has("src/candidate.c"));
    const binary = artifacts.get("bin/sidecar")!;
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splice-native-test-"));
    const file = path.join(dir, "sidecar");
    fs.writeFileSync(file, binary);
    fs.chmodSync(file, 0o755);
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const child = spawn(file, []);
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk.toString();
          child.kill();
        });
        child.on("error", reject);
        child.on("exit", () => resolve(out));
        child.stdin.end(
          JSON.stringify({ id: "1", op: "add_i64", args: { a: { $int: "9223372036854775806" }, b: { $int: "1" } } }) + "\n",
        );
      });
      const parsed = JSON.parse(response.trim());
      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.value, { sum: { $int: "9223372036854775807" } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes every compiled C source in the package artifacts", async () => {
    const multi = input();
    if (multi.implementation.kind !== "c") throw new Error("C fixture expected");
    multi.implementation.files[0].content = candidate
      .replace("#include <stddef.h>", "#include <stddef.h>\nint splice_checked_add(int64_t a, int64_t b, int64_t* sum);")
      .replace("__builtin_add_overflow(a, b, sum)", "splice_checked_add(a, b, sum)");
    multi.implementation.files.push({
      path: "helper.c", encoding: "utf8",
      content: '#include <stdint.h>\nint splice_checked_add(int64_t a, int64_t b, int64_t* sum) { return __builtin_add_overflow(a, b, sum); }\n',
    });
    const built = await buildNativePackage(multi, { onStage() {} });
    assert.equal(built.package.verification.verdict, "passed");
    assert.ok(built.files.some((file) => file.path === "src/helper.c"));
  });

  it("fails the build when a public case does not match", async () => {
    const bad = input();
    bad.public_tests[0] = { ...bad.public_tests[0], code: JSON.stringify([{ op: "add_i64", args: { a: "1", b: "2" }, expect: { sum: "4" } }]) };
    await assert.rejects(() => buildNativePackage(bad, { onStage: () => {} }), /verification failed/);
  });
});
