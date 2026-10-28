// Deterministic serialization used for content hashes and package identity.
import type { JsonValue } from "./wire.js";

/** Stable JSON: object keys are sorted, numbers must be finite, undefined is not JSON. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$");
}

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: non-finite numbers must be encoded as {$float}`);
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify({ $int: value.toString() });
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      if (record[key] === undefined) throw new Error(`${path}.${key}: undefined is not JSON`);
      parts.push(`${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error(`${path}: unsupported value type ${typeof value}`);
}

/** JSON-safe deep clone with a deterministic shape. Throws for values JSON cannot represent. */
export function canonicalValue<T = JsonValue>(value: unknown): T {
  return JSON.parse(canonicalJson(value)) as T;
}
