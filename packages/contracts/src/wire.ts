// Machine-readable wire schemas and lossless value encoding.
// JSON alone cannot preserve int64, NaN/Infinity, raw bytes or resource handles, so every
// cross-process value is encoded through one of these schemas before it leaves a capability.
import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type WireObjectField = { name: string; type: WireType; optional: boolean };

export type WireType =
  | { kind: "null" }
  | { kind: "bool" }
  | { kind: "int"; bits: 8 | 16 | 32 | 64; signed: boolean }
  | { kind: "float"; bits: 32 | 64 }
  | { kind: "string"; encoding: "utf-8" | "utf-16le"; max_bytes: number }
  | { kind: "bytes"; max_bytes: number }
  | { kind: "timestamp"; unit: "ms" | "s"; epoch: "unix"; timezone: "utc" }
  | { kind: "array"; items: WireType; max_items: number; ordered: boolean }
  | { kind: "object"; fields: WireObjectField[]; additional: false }
  | { kind: "map"; values: WireType; max_entries: number }
  | { kind: "enum"; values: string[] }
  | { kind: "union"; tag: string; variants: { tag: string; type: WireType }[] }
  | { kind: "blob_ref"; max_bytes: number }
  | { kind: "handle"; resource: string; dispose_operation: string | null };

export type WireObjectType = Extract<WireType, { kind: "object" }>;

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const positiveInt = z.number().int().positive().max(16_777_216);

/**
 * The raw object branch. Zod 3 discriminated unions only accept plain objects, so field
 * name checks live in `wireSchemaProblems` instead of a `.superRefine` here.
 */
const objectSchemaRaw = z
  .object({
    kind: z.literal("object"),
    fields: z
      .array(
        z
          .object({ name: identifier, type: z.lazy(() => WireTypeSchema), optional: z.boolean() })
          .strict(),
      )
      .max(128),
    additional: z.literal(false),
  })
  .strict();

/** A recursive schema. Use `WireTypeSchema.parse` for untrusted input and `WireObjectSchema` at operation boundaries. */
export const WireTypeSchema: z.ZodType<WireType> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("null") }).strict(),
    z.object({ kind: z.literal("bool") }).strict(),
    z
      .object({ kind: z.literal("int"), bits: z.union([z.literal(8), z.literal(16), z.literal(32), z.literal(64)]), signed: z.boolean() })
      .strict(),
    z.object({ kind: z.literal("float"), bits: z.union([z.literal(32), z.literal(64)]) }).strict(),
    z
      .object({
        kind: z.literal("string"),
        encoding: z.enum(["utf-8", "utf-16le"]),
        max_bytes: positiveInt,
      })
      .strict(),
    z.object({ kind: z.literal("bytes"), max_bytes: positiveInt }).strict(),
    z
      .object({ kind: z.literal("timestamp"), unit: z.enum(["ms", "s"]), epoch: z.literal("unix"), timezone: z.literal("utc") })
      .strict(),
    z
      .object({
        kind: z.literal("array"),
        items: z.lazy(() => WireTypeSchema),
        max_items: z.number().int().positive().max(1_000_000),
        ordered: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("map"),
        values: z.lazy(() => WireTypeSchema),
        max_entries: z.number().int().positive().max(100_000),
      })
      .strict(),
    z.object({ kind: z.literal("enum"), values: z.array(z.string().min(1)).min(1).max(256) }).strict(),
    z
      .object({
        kind: z.literal("union"),
        tag: identifier,
        variants: z
          .array(
            z
              .object({ tag: z.string().min(1).max(128), type: z.lazy(() => WireTypeSchema) })
              .strict(),
          )
          .min(1)
          .max(64),
      })
      .strict(),
    z.object({ kind: z.literal("blob_ref"), max_bytes: positiveInt }).strict(),
    z
      .object({ kind: z.literal("handle"), resource: z.string().min(1).max(128), dispose_operation: z.string().nullable() })
      .strict(),
    objectSchemaRaw,
  ]),
) as z.ZodType<WireType>;

export const WireObjectSchema: z.ZodType<WireObjectType> = objectSchemaRaw.superRefine((object, ctx) => {
  const seen = new Set<string>();
  if (object.fields.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Object schema needs at least one field" });
  }
  for (const field of object.fields) {
    if (field.name.startsWith("$")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Field ${field.name} uses the reserved $ prefix` });
    }
    if (seen.has(field.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate field ${field.name}` });
    }
    seen.add(field.name);
  }
}) as z.ZodType<WireObjectType>;

/** Reject schemas that could silently accept untyped or ambiguous values. */
export function wireSchemaProblems(type: WireType, path = "$"): string[] {
  const problems: string[] = [];
  const visit = (node: WireType, at: string) => {
    switch (node.kind) {
      case "object": {
        if (node.fields.length === 0) problems.push(`${at}: object has no fields`);
        const seen = new Set<string>();
        for (const field of node.fields) {
          if (field.name.startsWith("$")) problems.push(`${at}.${field.name}: reserved $ prefix`);
          if (seen.has(field.name)) problems.push(`${at}.${field.name}: duplicate field`);
          seen.add(field.name);
          visit(field.type, `${at}.${field.name}`);
        }
        break;
      }
      case "array":
        visit(node.items, `${at}[]`);
        break;
      case "map":
        visit(node.values, `${at}{}`);
        break;
      case "union":
        {
          const tags = new Set<string>();
          for (const variant of node.variants) {
            if (tags.has(variant.tag)) problems.push(`${at}: duplicate union tag ${variant.tag}`);
            tags.add(variant.tag);
            visit(variant.type, `${at}<${variant.tag}>`);
          }
        }
        break;
      case "string":
        if (!node.max_bytes) problems.push(`${at}: string needs a bounded max_bytes`);
        break;
      case "enum":
        if (!node.values.length) problems.push(`${at}: enum has no values`);
        break;
      case "int":
      case "float":
      case "bytes":
      case "blob_ref":
      case "timestamp":
      case "handle":
      case "bool":
      case "null":
        break;
    }
  };
  visit(type, path);
  return problems;
}

export class WireValueError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "WireValueError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const intRanges: Record<string, [bigint, bigint]> = {
  "8:true": [-(2n ** 7n), 2n ** 7n - 1n],
  "8:false": [0n, 2n ** 8n - 1n],
  "16:true": [-(2n ** 15n), 2n ** 15n - 1n],
  "16:false": [0n, 2n ** 16n - 1n],
  "32:true": [-(2n ** 31n), 2n ** 31n - 1n],
  "32:false": [0n, 2n ** 32n - 1n],
  "64:true": [-(2n ** 63n), 2n ** 63n - 1n],
  "64:false": [0n, 2n ** 64n - 1n],
};

/** Encode a host value into JSON-safe data. Int64 is always a decimal string to avoid precision loss. */
export function encodeWireValue(type: WireType, value: unknown, path = "$"): JsonValue {
  switch (type.kind) {
    case "null":
      if (value !== null) throw new WireValueError(path, "expected null");
      return null;
    case "bool":
      if (typeof value !== "boolean") throw new WireValueError(path, "expected boolean");
      return value;
    case "int": {
      let asBig: bigint;
      if (typeof value === "bigint") asBig = value;
      else if (typeof value === "number" && Number.isSafeInteger(value)) asBig = BigInt(value);
      else if (typeof value === "string" && /^-?\d+$/.test(value)) asBig = BigInt(value);
      else throw new WireValueError(path, "expected a safe integer, bigint or decimal string");
      const [min, max] = intRanges[`${type.bits}:${type.signed}`];
      if (asBig < min || asBig > max) throw new WireValueError(path, `out of range for ${type.signed ? "i" : "u"}${type.bits}`);
      if (type.bits === 64 || asBig > BigInt(Number.MAX_SAFE_INTEGER) || asBig < BigInt(Number.MIN_SAFE_INTEGER)) {
        return { $int: asBig.toString() };
      }
      return Number(asBig);
    }
    case "float": {
      if (typeof value !== "number") throw new WireValueError(path, "expected number");
      const num = type.bits === 32 && Number.isFinite(value) ? Math.fround(value) : value;
      if (Number.isNaN(num)) return { $float: "nan" };
      if (num === Infinity) return { $float: "infinity" };
      if (num === -Infinity) return { $float: "-infinity" };
      return num;
    }
    case "string": {
      if (typeof value !== "string") throw new WireValueError(path, "expected string");
      const bytes = encodedLength(value, type.encoding);
      if (bytes > type.max_bytes) throw new WireValueError(path, `string exceeds ${type.max_bytes} bytes`);
      return value;
    }
    case "bytes": {
      if (!(value instanceof Uint8Array)) throw new WireValueError(path, "expected Uint8Array");
      if (value.byteLength > type.max_bytes) throw new WireValueError(path, `bytes exceed ${type.max_bytes}`);
      return { $bytes: toBase64(value) };
    }
    case "timestamp": {
      const big = typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null;
      if (big === null) throw new WireValueError(path, "timestamps must be integer epoch values");
      if (big < 0n) throw new WireValueError(path, "timestamps cannot be negative");
      return { $int: big.toString() };
    }
    case "array": {
      if (!Array.isArray(value)) throw new WireValueError(path, "expected array");
      if (value.length > type.max_items) throw new WireValueError(path, `array exceeds ${type.max_items} items`);
      return value.map((item, index) => encodeWireValue(type.items, item, `${path}[${index}]`));
    }
    case "object": {
      if (!isRecord(value)) throw new WireValueError(path, "expected object");
      const out: Record<string, JsonValue> = {};
      const allowed = new Set(type.fields.map((field) => field.name));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new WireValueError(path, `unexpected field ${key}`);
      }
      for (const field of type.fields) {
        if (!(field.name in value)) {
          if (!field.optional) throw new WireValueError(path, `missing field ${field.name}`);
          continue;
        }
        out[field.name] = encodeWireValue(field.type, value[field.name], `${path}.${field.name}`);
      }
      return out;
    }
    case "map": {
      if (!isRecord(value)) throw new WireValueError(path, "expected map object");
      const entries = Object.entries(value);
      if (entries.length > type.max_entries) throw new WireValueError(path, `map exceeds ${type.max_entries} entries`);
      const out: Record<string, JsonValue> = {};
      for (const [key, item] of entries) out[key] = encodeWireValue(type.values, item, `${path}.${key}`);
      return out;
    }
    case "enum": {
      if (typeof value !== "string" || !type.values.includes(value)) {
        throw new WireValueError(path, `expected one of ${type.values.join(", ")}`);
      }
      return value;
    }
    case "union": {
      if (!isRecord(value)) throw new WireValueError(path, "expected tagged union object");
      const tag = value[type.tag];
      if (typeof tag !== "string") throw new WireValueError(path, `missing union tag ${type.tag}`);
      const variant = type.variants.find((item) => item.tag === tag);
      if (!variant) throw new WireValueError(path, `unknown union tag ${tag}`);
      if (!("value" in value)) throw new WireValueError(path, "union value is missing");
      return { $tag: tag, value: encodeWireValue(variant.type, value.value, `${path}.value`) };
    }
    case "blob_ref": {
      if (!isRecord(value) || typeof value.id !== "string" || typeof value.size !== "number") {
        throw new WireValueError(path, "expected { id, size } blob reference");
      }
      if (value.size > type.max_bytes) throw new WireValueError(path, `blob exceeds ${type.max_bytes} bytes`);
      return { $blob: value.id, size: value.size };
    }
    case "handle": {
      if (!isRecord(value) || typeof value.id !== "string") throw new WireValueError(path, "expected { id } handle");
      return { $handle: value.id };
    }
  }
}

/** Decode transport data back into host values, rejecting anything the schema does not describe. */
export function decodeWireValue(type: WireType, encoded: unknown, path = "$"): unknown {
  switch (type.kind) {
    case "null":
      if (encoded !== null) throw new WireValueError(path, "expected null");
      return null;
    case "bool":
      if (typeof encoded !== "boolean") throw new WireValueError(path, "expected boolean");
      return encoded;
    case "int": {
      let big: bigint;
      if (typeof encoded === "number" && Number.isSafeInteger(encoded)) big = BigInt(encoded);
      else if (isRecord(encoded) && typeof encoded.$int === "string" && /^-?\d+$/.test(encoded.$int)) big = BigInt(encoded.$int);
      else throw new WireValueError(path, "expected integer or {$int}");
      const [min, max] = intRanges[`${type.bits}:${type.signed}`];
      if (big < min || big > max) throw new WireValueError(path, `out of range for ${type.signed ? "i" : "u"}${type.bits}`);
      if (type.bits === 64) return big;
      return Number(big);
    }
    case "float": {
      if (isRecord(encoded) && typeof encoded.$float === "string") {
        if (encoded.$float === "nan") return NaN;
        if (encoded.$float === "infinity") return Infinity;
        if (encoded.$float === "-infinity") return -Infinity;
        throw new WireValueError(path, "unknown $float marker");
      }
      if (typeof encoded !== "number" || !Number.isFinite(encoded)) throw new WireValueError(path, "expected finite number");
      return type.bits === 32 ? Math.fround(encoded) : encoded;
    }
    case "string": {
      if (typeof encoded !== "string") throw new WireValueError(path, "expected string");
      if (encodedLength(encoded, type.encoding) > type.max_bytes) throw new WireValueError(path, "string too long");
      return encoded;
    }
    case "bytes": {
      if (!isRecord(encoded) || typeof encoded.$bytes !== "string") throw new WireValueError(path, "expected {$bytes}");
      const bytes = fromBase64(encoded.$bytes);
      if (bytes.byteLength > type.max_bytes) throw new WireValueError(path, "bytes too long");
      return bytes;
    }
    case "timestamp": {
      if (!isRecord(encoded) || typeof encoded.$int !== "string" || !/^\d+$/.test(encoded.$int)) {
        throw new WireValueError(path, "expected {$int} timestamp");
      }
      return BigInt(encoded.$int);
    }
    case "array": {
      if (!Array.isArray(encoded)) throw new WireValueError(path, "expected array");
      if (encoded.length > type.max_items) throw new WireValueError(path, "array too long");
      return encoded.map((item, index) => decodeWireValue(type.items, item, `${path}[${index}]`));
    }
    case "object": {
      if (!isRecord(encoded)) throw new WireValueError(path, "expected object");
      const allowed = new Set(type.fields.map((field) => field.name));
      for (const key of Object.keys(encoded)) {
        if (!allowed.has(key)) throw new WireValueError(path, `unexpected field ${key}`);
      }
      const out: Record<string, unknown> = {};
      for (const field of type.fields) {
        if (!(field.name in encoded)) {
          if (!field.optional) throw new WireValueError(path, `missing field ${field.name}`);
          continue;
        }
        out[field.name] = decodeWireValue(field.type, encoded[field.name], `${path}.${field.name}`);
      }
      return out;
    }
    case "map": {
      if (!isRecord(encoded)) throw new WireValueError(path, "expected map object");
      const entries = Object.entries(encoded);
      if (entries.length > type.max_entries) throw new WireValueError(path, "map too large");
      const out: Record<string, unknown> = {};
      for (const [key, item] of entries) out[key] = decodeWireValue(type.values, item, `${path}.${key}`);
      return out;
    }
    case "enum": {
      if (typeof encoded !== "string" || !type.values.includes(encoded)) throw new WireValueError(path, "invalid enum value");
      return encoded;
    }
    case "union": {
      if (!isRecord(encoded) || typeof encoded.$tag !== "string" || !("value" in encoded)) {
        throw new WireValueError(path, "expected {$tag, value}");
      }
      const variant = type.variants.find((item) => item.tag === encoded.$tag);
      if (!variant) throw new WireValueError(path, "unknown union tag");
      return { [type.tag]: variant.tag, value: decodeWireValue(variant.type, encoded.value, `${path}.value`) };
    }
    case "blob_ref": {
      if (!isRecord(encoded) || typeof encoded.$blob !== "string" || typeof encoded.size !== "number") {
        throw new WireValueError(path, "expected {$blob, size}");
      }
      return { id: encoded.$blob, size: encoded.size };
    }
    case "handle": {
      if (!isRecord(encoded) || typeof encoded.$handle !== "string") throw new WireValueError(path, "expected {$handle}");
      return { id: encoded.$handle };
    }
  }
}

function encodedLength(value: string, encoding: "utf-8" | "utf-16le"): number {
  if (encoding === "utf-16le") return value.length * 2;
  return new TextEncoder().encode(value).byteLength;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("invalid base64");
  const clean = value.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let index = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]);
    const b = B64.indexOf(clean[i + 1]);
    const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0;
    const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0;
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("invalid base64");
    out[index++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) out[index++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) out[index++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, index);
}

/** A compact TypeScript type expression for generated clients and host wrappers. */
export function wireTsType(type: WireType): string {
  switch (type.kind) {
    case "null":
      return "null";
    case "bool":
      return "boolean";
    case "int":
      return type.bits === 64 ? "bigint" : "number";
    case "float":
      return "number";
    case "string":
    case "enum":
      return type.kind === "enum" ? type.values.map((value) => JSON.stringify(value)).join(" | ") : "string";
    case "bytes":
      return "Uint8Array";
    case "timestamp":
      return "bigint";
    case "array":
      return `Array<${wireTsType(type.items)}>`;
    case "map":
      return `Record<string, ${wireTsType(type.values)}>`;
    case "object": {
      const fields = type.fields.map((field) => `${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${wireTsType(field.type)}`);
      return `{ ${fields.join("; ")} }`;
    }
    case "union":
      return type.variants.map((variant) => wireTsType(variant.type)).join(" | ");
    case "blob_ref":
      return "BlobRef";
    case "handle":
      return "Handle";
  }
}
