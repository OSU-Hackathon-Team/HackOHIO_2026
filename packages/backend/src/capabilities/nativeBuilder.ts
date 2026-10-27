// Native capability builder: generates a typed C shim from the operation wire schemas, compiles
// the candidate with pinned flags, and verifies it through the real sidecar protocol.
//
// Supported native boundary (v1): flat object requests/results whose fields are int, float, bool
// or bounded string. Arrays, maps, nested objects, unions, optional fields and streaming events are
// rejected with a blocker rather than approximated.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { CapabilityPackage } from "@splice/contracts";
import {
  decodeWireValue,
  encodeWireValue,
  canonicalJson,
  type CapabilityDefinition,
  type OperationSpec,
  type PublicTestCase,
  type TestOutcome,
  type WireObjectType,
  type WireType,
} from "@splice/contracts";
import type { ArtifactFile, BuildHooks, BuildInput, BuiltPackage } from "./types.js";
import { buildInputManifest, hashJson, packageId, sha256Hex } from "./identity.js";
import { safeRelativePath } from "./identity.js";
import { runRestricted } from "./sandbox.js";
import { generateCapabilityClientFiles } from "./clientGen.js";

const MAX_LINE = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

interface NativeField {
  name: string;
  type: WireType;
  cType: string;
  inputExpr: string;
  outputDecl: string;
  outputArg: string;
  emit: (valueExpr: string) => string;
}

export function nativeSchemaProblems(definition: CapabilityDefinition): string[] {
  const problems: string[] = [];
  for (const operation of definition.operations) {
    if (operation.streaming) problems.push(`${operation.name}: streaming is not supported by native v1`);
    for (const [role, schema] of [
      ["request", operation.request],
      ["result", operation.result],
      ["error", operation.error],
    ] as const) {
      if (schema.kind !== "object") {
        problems.push(`${operation.name}: ${role} must be an object`);
        continue;
      }
      for (const field of schema.fields) {
        if (role === "error" && field.name === "code" && field.type.kind === "enum") continue;
        if (field.optional) {
          problems.push(`${operation.name}.${role}.${field.name}: optional native fields are ambiguous`);
          continue;
        }
        if (!nativeScalar(field.type)) {
          problems.push(`${operation.name}.${role}.${field.name}: ${field.type.kind} is not a native scalar`);
        }
        if (field.type.kind === "int" && (!field.type.signed || ![32, 64].includes(field.type.bits))) {
          problems.push(`${operation.name}.${role}.${field.name}: native v1 supports signed 32-bit and 64-bit integers only`);
        }
      }
    }
    const codeField = operation.error.fields.find((field) => field.name === "code");
    if (!codeField || codeField.type.kind !== "enum") {
      problems.push(`${operation.name}: error.code must be an enum so the shim can map return codes`);
    }
    const messageField = operation.error.fields.find((field) => field.name === "message");
    if (!messageField || !(messageField.type.kind === "string")) {
      problems.push(`${operation.name}: error.message must be a string`);
    }
    const extraErrorFields = operation.error.fields.filter((field) => field.name !== "code" && field.name !== "message");
    if (extraErrorFields.length) {
      problems.push(`${operation.name}: native error schema has unsupported fields ${extraErrorFields.map((field) => field.name).join(", ")}`);
    }
  }
  return problems;
}

function nativeScalar(type: WireType): boolean {
  if (type.kind === "int" || type.kind === "float" || type.kind === "bool") return true;
  return type.kind === "string" && type.max_bytes > 0;
}

function cType(type: WireType): string {
  switch (type.kind) {
    case "int":
      return type.bits === 64 ? (type.signed ? "int64_t" : "uint64_t") : type.bits === 32 ? "int32_t" : type.bits === 16 ? "int16_t" : "int8_t";
    case "float":
      return type.bits === 64 ? "double" : "float";
    case "bool":
      return "int";
    case "string":
      return "char*";
    default:
      throw new Error(`unsupported native type ${type.kind}`);
  }
}

function escapeC(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function errorCodes(operation: OperationSpec): string[] {
  const field = operation.error.fields.find((entry) => entry.name === "code");
  return field && field.type.kind === "enum" ? field.type.values : ["internal"];
}

function requestSetup(operation: OperationSpec): { declarations: string[]; arguments: string[]; asserts: string[] } {
  const declarations: string[] = [];
  const args: string[] = [];
  const checks: string[] = [];
  for (const field of operation.request.fields) {
    const c = field.type;
    const name = `in_${field.name}`;
    if (c.kind === "string") {
      declarations.push(`  char ${name}[${c.max_bytes + 1}];`);
      checks.push(`  if (!parse_string_field(argsv, ${JSON.stringify(field.name)}, ${name}, sizeof ${name})) { emit_error(id, "bad_request", "invalid field ${field.name}"); return; }`);
      args.push(name);
    } else if (c.kind === "int") {
      declarations.push(`  ${cType(c)} ${name};`);
      checks.push(`  if (!parse_int_field(argsv, ${JSON.stringify(field.name)}, ${JSON.stringify(c.bits === 64 ? (c.signed ? "i64" : "u64") : "i32")}, &${name})) { emit_error(id, "bad_request", "invalid field ${field.name}"); return; }`);
      args.push(name);
    } else if (c.kind === "float") {
      declarations.push(`  ${cType(c)} ${name};`);
      checks.push(`  if (!parse_float_field(argsv, ${JSON.stringify(field.name)}, ${JSON.stringify(c.bits === 64 ? "f64" : "f32")}, &${name})) { emit_error(id, "bad_request", "invalid field ${field.name}"); return; }`);
      args.push(name);
    } else if (c.kind === "bool") {
      declarations.push(`  int ${name};`);
      checks.push(`  if (!parse_bool_field(argsv, ${JSON.stringify(field.name)}, &${name})) { emit_error(id, "bad_request", "invalid field ${field.name}"); return; }`);
      args.push(name);
    }
  }
  return { declarations, arguments: args, asserts: checks };
}

function resultOutput(operation: OperationSpec): { declarations: string[]; arguments: string[]; print: string[] } {
  const declarations: string[] = [];
  const args: string[] = [];
  const print: string[] = [];
  operation.result.fields.forEach((field, index) => {
    const c = field.type;
    const name = `out_${field.name}`;
    if (c.kind === "string") {
      declarations.push(`  char ${name}[${c.max_bytes + 1}] = {0};`);
      args.push(name, `sizeof ${name}`);
      print.push(`  ${index === 0 ? "" : 'printf(","); '}printf("\\"${escapeC(field.name)}\\":"); emit_string(${name});`);
    } else if (c.kind === "int") {
      declarations.push(`  ${cType(c)} ${name} = 0;`);
      args.push(`&${name}`);
      print.push(`  ${index === 0 ? "" : 'printf(","); '}printf("\\"${escapeC(field.name)}\\":"); ${c.bits === 64 ? `emit_i64((int64_t)${name});` : `emit_i32((int64_t)${name});`}`);
    } else if (c.kind === "float") {
      declarations.push(`  ${cType(c)} ${name} = 0;`);
      args.push(`&${name}`);
      print.push(`  ${index === 0 ? "" : 'printf(","); '}printf("\\"${escapeC(field.name)}\\":"); emit_f64((double)${name});`);
    } else if (c.kind === "bool") {
      declarations.push(`  int ${name} = 0;`);
      args.push(`&${name}`);
      print.push(`  ${index === 0 ? "" : 'printf(","); '}printf("\\"${escapeC(field.name)}\\":"); emit_bool(${name});`);
    }
  });
  return { declarations, arguments: args, print };
}

export function generateNativeShim(definition: CapabilityDefinition): string {
  const cases: string[] = [];
  const prototypes: string[] = [];
  for (const operation of definition.operations) {
    const fn = `splice_${operation.name}`;
    const request = requestSetup(operation);
    const result = resultOutput(operation);
    const params = [...request.declarations, ...result.declarations].join("\n");
    const callArgs = [...request.arguments, ...result.arguments].join(", ");
    const codes = errorCodes(operation);
    const codeTable = codes.map((code) => `"${escapeC(code)}"`).join(", ");
    prototypes.push(
      `int ${fn}(${[
        ...operation.request.fields.map((field) => `${field.type.kind === "string" ? "const char*" : cType(field.type)} ${`in_${field.name}`}`),
        ...operation.result.fields.map((field) => {
          const c = field.type;
          if (c.kind === "string") return `char* out_${field.name}, size_t out_${field.name}_cap`;
          return `${cType(c)}* out_${field.name}`;
        }),
      ].join(", ")});`,
    );
    cases.push(`
  if (strcmp(op, "${escapeC(operation.name)}") == 0) {
    static const char* errors[] = { ${codeTable} };
${params}
${request.asserts.join("\n")}
    int rc = ${fn}(${callArgs});
    if (rc != 0) { emit_error(id, (rc >= 1 && rc <= (int)(sizeof errors / sizeof errors[0])) ? errors[rc - 1] : "internal", "${escapeC(operation.name)} failed"); return; }
    printf("{\\"id\\":");
    emit_string(id);
    printf(",\\"ok\\":true,\\"value\\":{");
${result.print.join("\n")}
    printf("}}\\n");
    return;
  }`);
  }
  return `/* Generated by Splice native builder. Do not edit. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <math.h>
#include <ctype.h>
#include <limits.h>

${prototypes.join("\n")}

static const char* skip_ws(const char* p) { while (*p && (*p==' '||*p=='\\t'||*p=='\\n'||*p=='\\r')) p++; return p; }
static int hexval(int c) { if (c>='0'&&c<='9') return c-'0'; if (c>='a'&&c<='f') return c-'a'+10; if (c>='A'&&c<='F') return c-'A'+10; return -1; }

static const char* skip_value(const char* p) {
  p = skip_ws(p);
  if (*p == '"') {
    p++;
    while (*p) { if (*p == '\\\\') { p += 2; continue; } if (*p == '"') return p + 1; p++; }
    return NULL;
  }
  if (*p == '{' || *p == '[') {
    char close = *p == '{' ? '}' : ']';
    int depth = 0;
    while (*p) {
      if (*p == '"') { p = skip_value(p); if (!p) return NULL; continue; }
      if (*p == '{' || *p == '[') depth++;
      if (*p == '}' || *p == ']') { depth--; if (depth == 0) return p + 1; }
      p++;
    }
    (void)close;
    return NULL;
  }
  while (*p && *p != ',' && *p != '}' && *p != ']') p++;
  return p;
}

static const char* find_field(const char* obj, const char* key) {
  const char* p = skip_ws(obj);
  if (*p != '{') return NULL;
  p++;
  while (*p) {
    p = skip_ws(p);
    if (*p == '}') return NULL;
    if (*p != '"') return NULL;
    char name[128]; size_t n = 0;
    p++;
    while (*p && *p != '"') { if (*p == '\\\\') p++; if (n + 1 < sizeof name) name[n++] = *p; p++; }
    if (*p != '"') return NULL;
    name[n] = 0; p++;
    p = skip_ws(p);
    if (*p != ':') return NULL;
    p = skip_ws(p + 1);
    if (strcmp(name, key) == 0) return p;
    p = skip_value(p);
    if (!p) return NULL;
    p = skip_ws(p);
    if (*p == ',') p++;
  }
  return NULL;
}

static int read_json_string(const char* p, char* out, size_t cap) {
  p = skip_ws(p);
  if (*p != '"') return 0;
  p++;
  size_t n = 0;
  while (*p && *p != '"') {
    unsigned char c = (unsigned char)*p;
    if (c == '\\\\') {
      p++;
      c = (unsigned char)*p;
      if (c == 'n') c = '\\n';
      else if (c == 'r') c = '\\r';
      else if (c == 't') c = '\\t';
      else if (c == 'b') c = '\\b';
      else if (c == 'f') c = '\\f';
      else if (c == 'u') {
        unsigned code = 0;
        for (int i = 0; i < 4; i++) { p++; int h = hexval((unsigned char)*p); if (h < 0) return 0; code = code * 16 + (unsigned)h; }
        if (code < 0x80) c = (unsigned char)code;
        else if (code < 0x800) {
          if (n + 2 >= cap) return 0;
          out[n++] = (char)(0xC0 | (code >> 6)); out[n++] = (char)(0x80 | (code & 0x3F)); p++; continue;
        } else {
          if (n + 3 >= cap) return 0;
          out[n++] = (char)(0xE0 | (code >> 12)); out[n++] = (char)(0x80 | ((code >> 6) & 0x3F)); out[n++] = (char)(0x80 | (code & 0x3F)); p++; continue;
        }
      }
      if (n + 1 >= cap) return 0;
      out[n++] = (char)c; p++;
    } else {
      if (n + 1 >= cap) return 0;
      out[n++] = (char)c; p++;
    }
  }
  if (*p != '"') return 0;
  out[n] = 0;
  return 1;
}

static int parse_string_field(const char* args, const char* key, char* out, size_t cap) {
  const char* v = find_field(args, key);
  return v && read_json_string(v, out, cap);
}

static int parse_i64_value(const char* v, int64_t* out) {
  v = skip_ws(v);
  if (*v == '{') {
    const char* inner = find_field(v, "$int");
    char buf[64];
    if (!inner || !read_json_string(inner, buf, sizeof buf)) return 0;
    errno = 0; char* end = NULL; long long n = strtoll(buf, &end, 10);
    if (errno || end == buf || *end) return 0;
    *out = (int64_t)n; return 1;
  }
  errno = 0; char* end = NULL; long long n = strtoll(v, &end, 10);
  if (errno || end == v) return 0;
  while (isspace((unsigned char)*end)) end++;
  if (*end && *end != ',' && *end != '}') return 0;
  *out = (int64_t)n; return 1;
}

static int parse_int_field(const char* args, const char* key, const char* kind, void* out) {
  const char* v = find_field(args, key);
  if (!v) return 0;
  int64_t value;
  if (!parse_i64_value(v, &value)) return 0;
  if (strcmp(kind, "i64") == 0) { *(int64_t*)out = value; return 1; }
  if (strcmp(kind, "i32") == 0 && value >= INT32_MIN && value <= INT32_MAX) { *(int32_t*)out = (int32_t)value; return 1; }
  return 0;
}

static int parse_float_field(const char* args, const char* key, const char* kind, void* out) {
  const char* v = find_field(args, key);
  if (!v) return 0;
  v = skip_ws(v);
  double value = 0;
  if (*v == '{') {
    const char* marker = find_field(v, "$float");
    char buf[32];
    if (!marker || !read_json_string(marker, buf, sizeof buf)) return 0;
    if (strcmp(buf, "nan") == 0) value = NAN;
    else if (strcmp(buf, "infinity") == 0) value = INFINITY;
    else if (strcmp(buf, "-infinity") == 0) value = -INFINITY;
    else return 0;
  } else {
    errno = 0; char* end = NULL; value = strtod(v, &end);
    if (errno || end == v) return 0;
  }
  if (strcmp(kind, "f64") == 0) *(double*)out = value; else *(float*)out = (float)value;
  return 1;
}

static int parse_bool_field(const char* args, const char* key, int* out) {
  const char* v = find_field(args, key);
  if (!v) return 0;
  if (strncmp(v, "true", 4) == 0) { *out = 1; return 1; }
  if (strncmp(v, "false", 5) == 0) { *out = 0; return 1; }
  return 0;
}

static void emit_string(const char* s) {
  putchar('"');
  for (const unsigned char* p = (const unsigned char*)s; *p; p++) {
    if (*p == '"' || *p == '\\\\') { putchar('\\\\'); putchar(*p); }
    else if (*p < 0x20) printf("\\\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static void emit_i64(int64_t v) { printf("{\\"$int\\":\\"%lld\\"}", (long long)v); }
static void emit_i32(int64_t v) { printf("%lld", (long long)v); }
static void emit_f64(double v) {
  if (isnan(v)) printf("{\\"$float\\":\\"nan\\"}");
  else if (isinf(v)) printf(v > 0 ? "{\\"$float\\":\\"infinity\\"}" : "{\\"$float\\":\\"-infinity\\"}");
  else printf("%.17g", v);
}
static void emit_bool(int v) { printf(v ? "true" : "false"); }

static void emit_error(const char* id, const char* code, const char* message) {
  printf("{\\"id\\":"); emit_string(id); printf(",\\"ok\\":false,\\"error\\":{\\"code\\":"); emit_string(code);
  printf(",\\"message\\":"); emit_string(message); printf("}}\\n"); fflush(stdout);
}

static void handle_line(char* line) {
  char id[256] = "";
  const char* p = skip_ws(line);
  const char* idv = find_field(p, "id");
  const char* opv = find_field(p, "op");
  const char* argsv = find_field(p, "args");
  if (!idv || !read_json_string(idv, id, sizeof id) || !opv) { emit_error("", "protocol", "missing id or op"); return; }
  char op[128];
  if (!read_json_string(opv, op, sizeof op) || !argsv) { emit_error(id, "protocol", "invalid op or args"); return; }
${cases.join("\n")}
  emit_error(id, "unknown_operation", op);
}

int main(void) {
  static char line[${MAX_LINE}];
  while (fgets(line, sizeof line, stdin)) {
    size_t len = strlen(line);
    if (len == sizeof line - 1 && line[len - 1] != '\\n') { emit_error("", "protocol", "line too long"); return 2; }
    handle_line(line);
    fflush(stdout);
  }
  return 0;
}
`;
}

interface NativeCase {
  op: string;
  args: Record<string, unknown>;
  expect?: Record<string, unknown>;
  expect_error?: { code: string };
}

interface RunOutcome {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: { code: string; message: string };
  duration_ms: number;
}

async function runCase(binary: string, root: string, definition: CapabilityDefinition, testCase: NativeCase, signal?: AbortSignal): Promise<RunOutcome> {
  const operation = definition.operations.find((item) => item.name === testCase.op);
  if (!operation) throw new Error(`Unknown operation ${testCase.op}`);
  const started = Date.now();
  const request = JSON.stringify({
    id: "1",
    op: testCase.op,
    args: encodeWireValue(operation.request, testCase.args),
  });
  const relative = path.relative(root, binary).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("sidecar binary escaped build root");
  const result = await runRestricted(`/work/${relative}`, [], {
    cwd: root,
    input: `${request}\n`,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: MAX_LINE,
    signal,
  });
  const line = result.stdout.split("\n").find(Boolean);
  if (!line) throw new Error(`sidecar produced no response for ${testCase.op}: ${result.stderr.slice(0, 400)}`);
  const response = JSON.parse(line) as { ok: boolean; value?: unknown; error?: { code: string; message: string } };
  if (!response.ok) return { ok: false, error: response.error ?? { code: "internal", message: "unknown" }, duration_ms: Date.now() - started };
  const value = decodeWireValue(operation.result, response.value) as Record<string, unknown>;
  return { ok: true, value, duration_ms: Date.now() - started };
}

function boundaryCases(definition: CapabilityDefinition): { name: string; definitionCase: NativeCase }[] {
  const cases: { name: string; definitionCase: NativeCase }[] = [];
  for (const operation of definition.operations) {
    for (const extreme of ["min", "max"] as const) {
      const args: Record<string, unknown> = {};
      for (const field of operation.request.fields) {
        const type = field.type;
        if (type.kind === "int" && type.bits === 64) {
          args[field.name] = extreme === "min" ? (type.signed ? "-9223372036854775808" : "0") : (type.signed ? "9223372036854775807" : "18446744073709551615");
        } else if (type.kind === "int") {
          args[field.name] = extreme === "min" ? -(2 ** (type.bits - 1)) : 2 ** (type.bits - 1) - 1;
        } else if (type.kind === "float") {
          args[field.name] = extreme === "min" ? -1.7976931348623157e308 : 1.7976931348623157e308;
        } else if (type.kind === "bool") {
          args[field.name] = false;
        } else if (type.kind === "string") {
          args[field.name] = "";
        }
      }
      cases.push({ name: `${operation.name} boundary ${extreme}`, definitionCase: { op: operation.name, args } });
    }
  }
  return cases;
}

export async function buildNativePackage(
  input: BuildInput,
  hooks: BuildHooks,
  isCancelled: () => boolean = () => false,
): Promise<BuiltPackage> {
  const { definition } = input;
  if (input.implementation.kind !== "c") throw new Error("buildNativePackage requires a C implementation");
  const problems = nativeSchemaProblems(definition);
  if (problems.length) throw new Error(`Native boundary is ambiguous:\n${problems.join("\n")}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "splice-native-"));
  const srcDir = path.join(work, "src");
  const binDir = path.join(work, "bin");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  try {
    hooks.onStage("prepare", "Writing C candidate and generated shim", 10);
    const sourcePaths: string[] = [];
    const seenSourcePaths = new Set<string>();
    for (const file of input.implementation.files) {
      const safe = safeRelativePath(file.path);
      if (!/\.(?:c|h)$/.test(safe) || safe === "splice_shim.c") throw new Error(`Unsupported or reserved C source path ${file.path}`);
      if (seenSourcePaths.has(safe)) throw new Error(`Duplicate C source path ${file.path}`);
      seenSourcePaths.add(safe);
      sourcePaths.push(safe);
      const target = path.join(srcDir, safe);
      if (!target.startsWith(`${srcDir}${path.sep}`)) throw new Error(`Unsafe implementation path ${file.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
    }
    const candidateEntry = safeRelativePath(input.implementation.entry);
    const candidatePath = path.join(srcDir, candidateEntry);
    if (!candidatePath.startsWith(`${srcDir}${path.sep}`)) throw new Error(`Unsafe C entry ${input.implementation.entry}`);
    if (!seenSourcePaths.has(candidateEntry) || !candidateEntry.endsWith(".c")) throw new Error(`Missing C entry ${input.implementation.entry}`);
    const shimPath = path.join(srcDir, "splice_shim.c");
    fs.writeFileSync(shimPath, generateNativeShim(definition));

    const allowedFlags = new Set(["-O0", "-O1", "-O2", "-O3", "-Wall", "-Wextra", "-Werror", "-pedantic"]);
    const invalidFlags = input.implementation.compiler.flags.filter((flag) => !allowedFlags.has(flag));
    if (invalidFlags.length) throw new Error(`Unsupported or unsafe compiler flags: ${invalidFlags.join(", ")}`);
    const flags = ["-std=c11", "-O2", "-D_FORTIFY_SOURCE=2", "-Wall", "-Wextra", ...input.implementation.compiler.flags];
    const binary = path.join(binDir, "sidecar");
    hooks.onStage("compile", `Compiling with ${input.implementation.compiler.name}`, 35);
    const compile = await runRestricted(input.implementation.compiler.name, [
      ...flags,
      ...sourcePaths.filter((source) => source.endsWith(".c")).map((source) => `/work/src/${source}`),
      `/work/${path.relative(work, shimPath).split(path.sep).join("/")}`,
      "-lm",
      "-o",
      `/work/${path.relative(work, binary).split(path.sep).join("/")}`,
    ], { cwd: work, timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024, writable: true, signal: hooks.signal });
    if (compile.code !== 0) throw new Error(`Native compile failed:\n${compile.stderr || compile.stdout}`);
    fs.chmodSync(binary, 0o755);
    const version = spawnSync("gcc", ["-dumpfullversion"], { encoding: "utf8" }).stdout.trim() || "unknown";

    hooks.onStage("verify", "Running public C cases through the sidecar", 60);
    const tests: TestOutcome[] = [];
    for (const test of input.public_tests) {
      if (isCancelled()) throw new Error("cancelled");
      const parsed = JSON.parse(test.code) as NativeCase[];
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`C test ${test.name} has no cases`);
      for (const testCase of parsed) {
        const outcome = await runCase(binary, work, definition, testCase, hooks.signal);
        const passed = testCase.expect_error
          ? !outcome.ok && outcome.error?.code === testCase.expect_error.code
          : outcome.ok && deepEqual(outcome.value, decodeWireValue(
              definition.operations.find((item) => item.name === testCase.op)!.result,
              encodeWireValue(definition.operations.find((item) => item.name === testCase.op)!.result, testCase.expect ?? {}),
            ));
        tests.push({
          name: `${test.name} · ${testCase.op}`,
          kind: "public",
          passed,
          requirement_ids: test.requirement_ids,
          duration_ms: outcome.duration_ms,
          assertions: 1,
          calls: 1,
          detail: passed
            ? "Matched through the native sidecar"
            : `Expected ${JSON.stringify(testCase.expect ?? testCase.expect_error)}, got ${JSON.stringify(outcome, (_key, value) => typeof value === "bigint" ? value.toString() : value)}`,
        });
      }
    }

    hooks.onStage("verify", "Running numeric boundary cases", 80);
    const boundaries = [];
    for (const boundary of boundaryCases(definition)) {
      if (isCancelled()) throw new Error("cancelled");
      try {
        const outcome = await runCase(binary, work, definition, boundary.definitionCase, hooks.signal);
        boundaries.push({ name: boundary.name, passed: outcome.ok || Boolean(outcome.error?.code), detail: outcome.ok ? "typed result" : `typed error ${outcome.error?.code}` });
      } catch (error) {
        boundaries.push({ name: boundary.name, passed: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }

    const bytes = fs.readFileSync(binary);
    const artifacts: ArtifactFile[] = [
      { path: "definition.json", data: Buffer.from(canonicalJson(definition)) },
      { path: "build-input.json", data: Buffer.from(canonicalJson(buildInputManifest(input))) },
      { path: "bin/sidecar", data: bytes },
      ...generateCapabilityClientFiles(definition),
      ...sourcePaths.map((source) => ({ path: `src/${source}`, data: fs.readFileSync(path.join(srcDir, source)) })),
      { path: "src/splice_shim.c", data: Buffer.from(generateNativeShim(definition)) },
    ];
    const implementationHash = sha256Hex(Buffer.concat(artifacts.map((artifact) => artifact.data)));
    const buildHash = sha256Hex(Buffer.from(artifacts.map((artifact) => sha256Hex(artifact.data)).join("")));
    const computedDefinitionHash = hashJson(definition);
    if (input.hash_definition && input.hash_definition !== computedDefinitionHash) {
      throw new Error("Intake definition hash does not match the definition being built");
    }
    const definitionHash = computedDefinitionHash;
    const verification = {
      schema_version: 1 as const,
      generated_at: new Date().toISOString(),
      generator: "splice.capabilities.native-builder@1",
      tests,
      mutation: { total: 0, killed: 0, survivors: [] as string[] },
      purity_violations: [] as string[],
      type_errors: [] as string[],
      boundary_checks: boundaries,
      blockers: [] as string[],
      verdict: "failed" as "passed" | "failed",
      report_hash: "",
    };
    verification.verdict = tests.every((test) => test.passed) && boundaries.every((check) => check.passed) ? "passed" : "failed";
    verification.report_hash = hashJson(verification);

    const pkg: CapabilityPackage = {
      schema_version: 1,
      package_id: packageId(definitionHash, buildHash),
      definition: { id: definition.id, version: definition.version, hash: definitionHash },
      runtime_kind: "native_sidecar",
      entrypoints: [{ kind: "sidecar_executable", path: "bin/sidecar", protocol: "splice-sidecar-v1" }],
      platforms: [{ os: "linux", arch: "x64" }],
      build: {
        recipe: `gcc ${flags.join(" ")} ${sourcePaths.filter((source) => source.endsWith(".c")).join(" ")} splice_shim.c -lm`,
        toolchain: { name: "gcc", version },
        source_hash: implementationHash,
        build_hash: buildHash,
        reproducible: true,
        log_hash: hashJson({ stdout: compile.stdout, stderr: compile.stderr }),
        attempts: 0,
      },
      artifacts: artifacts.map((artifact) => ({
        path: artifact.path,
        sha256: sha256Hex(artifact.data),
        size: artifact.data.length,
        kind: artifact.path.startsWith("bin/") ? "binary" : artifact.path === "definition.json" ? "manifest" : artifact.path.startsWith("client/") ? "client" : "source",
      })),
      dependency_lock: [],
      assets: [],
      verification,
      independent_verdict_ref: null,
      readiness: {
        upstream_review: input.intake_readiness?.upstream_review ?? { status: "unknown", detail: "Upstream review is not recorded by intake", at: null, evidence_hash: null },
        implementation_checks: {
          status: verification.verdict,
          detail: `${tests.filter((test) => test.passed).length}/${tests.length} public cases, ${boundaries.filter((check) => check.passed).length}/${boundaries.length} boundary checks`,
          at: new Date().toISOString(),
          evidence_hash: verification.report_hash,
        },
        independent_behavior_checks: input.intake_readiness?.independent_behavior_checks ?? { status: "not_run", detail: "No independent behavior evaluation has been revalidated", at: null, evidence_hash: null },
        composition_checks: { status: "not_run", detail: "Checked by the composition gate", at: null, evidence_hash: null },
        packaging_checks: { status: "passed", detail: "Sidecar built and exercised on linux/x64", at: new Date().toISOString(), evidence_hash: buildHash },
      },
      created_at: new Date().toISOString(),
    };
    if (verification.verdict !== "passed") {
      throw new Error(`Native package verification failed: ${tests.filter((test) => !test.passed).map((test) => test.name).join(", ")}`);
    }
    hooks.onStage("complete", "Native package verified", 100);
    return { package: CapabilityPackage.parse(pkg), files: artifacts };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function deepEqual(actual: unknown, expected: unknown): boolean {
  try {
    assert.deepEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}
