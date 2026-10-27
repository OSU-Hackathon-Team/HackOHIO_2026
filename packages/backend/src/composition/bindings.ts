import { encodeWireValue, type Binding, type PortSpec, type WireObjectType, type WireType } from "@splice/contracts";

export class BindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindingError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) throw new BindingError(`missing field ${path}`);
    current = current[part];
  }
  return current;
}

export function writePath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  if (parts.some((part) => !part || part === "__proto__" || part === "constructor" || part === "prototype")) {
    throw new BindingError(`unsafe target path ${path}`);
  }
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (existing === undefined) current[part] = {};
    else if (!isRecord(existing)) throw new BindingError(`target path ${path} crosses a non-object field`);
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

export function applyTransform(value: unknown, transform: Binding["mappings"][number]["transform"], factor: number | null): unknown {
  switch (transform) {
    case "identity":
    case "json":
      return value;
    case "string":
      return typeof value === "string" ? value : typeof value === "bigint" ? value.toString() : String(value);
    case "number": {
      const number = typeof value === "bigint" ? Number(value) : Number(value);
      if (!Number.isFinite(number)) throw new BindingError("numeric conversion produced a non-finite value");
      return number;
    }
    case "int64_decimal":
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
      throw new BindingError("int64_decimal requires an integer value");
    case "timestamp_ms_to_s":
      if (typeof value !== "number" && typeof value !== "bigint") throw new BindingError("timestamp conversion requires an integer");
      return Number(value) / 1000;
    case "timestamp_s_to_ms":
      if (typeof value !== "number" && typeof value !== "bigint") throw new BindingError("timestamp conversion requires an integer");
      return Number(value) * 1000;
    case "unit_scale":
      if ((typeof value !== "number" && typeof value !== "bigint") || factor === null || !Number.isFinite(factor)) {
        throw new BindingError("unit_scale requires a numeric value and finite factor");
      }
      return Number(value) * factor;
  }
}

function sourcePath(mapping: Binding["mappings"][number]): string {
  const match = /^\$from\.(.+)$/.exec(mapping.from);
  if (!match) throw new BindingError(`binding source must use $from.<path>: ${mapping.from}`);
  return match[1];
}

function assertObject(value: unknown, schema: WireObjectType, label: string): Record<string, unknown> {
  try {
    encodeWireValue(schema, value);
    if (!isRecord(value)) throw new Error("expected object");
    return value;
  } catch (error) {
    throw new BindingError(`${label} does not match its port schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Execute only the mappings recorded in the validated plan; provenance remains attached to the binding. */
export function applyBinding(binding: Binding, value: unknown, source: PortSpec, target: PortSpec): Record<string, unknown> {
  const encodedSource = assertObject(value, source.schema, `binding ${binding.id} source`);
  const result: Record<string, unknown> = {};
  for (const mapping of binding.mappings) {
    const raw = readPath(encodedSource, sourcePath(mapping));
    const converted = applyTransform(raw, mapping.transform, mapping.factor);
    if (binding.unit_bridge && mapping.transform !== "unit_scale") {
      if (typeof converted !== "number") throw new BindingError(`unit bridge on ${binding.id} requires numeric mapped values`);
      writePath(result, mapping.to, converted * binding.unit_bridge.factor);
    } else {
      writePath(result, mapping.to, converted);
    }
  }
  assertObject(result, target.schema, `binding ${binding.id} target`);
  return result;
}

export function wireField(schema: WireObjectType, path: string): WireType | null {
  let current: WireType = schema;
  for (const part of path.split(".")) {
    if (current.kind !== "object") return null;
    const field: WireObjectType["fields"][number] | undefined = current.fields.find((candidate) => candidate.name === part);
    if (!field) return null;
    current = field.type;
  }
  return current;
}
