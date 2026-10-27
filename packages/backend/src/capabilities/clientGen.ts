import type { CapabilityDefinition, WireObjectType, WireType } from "@splice/contracts";
import type { ArtifactFile } from "./types.js";

function typeName(value: string): string {
  return value.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("") || "Capability";
}

function tsType(type: WireType): string {
  switch (type.kind) {
    case "null": return "null";
    case "bool": return "boolean";
    case "int": return type.bits === 64 ? "bigint" : "number";
    case "float": return "number";
    case "string": return "string";
    case "bytes": return "Uint8Array";
    case "timestamp": return "bigint";
    case "array": return `Array<${tsType(type.items)}>`;
    case "map": return `Record<string, ${tsType(type.values)}>`;
    case "enum": return type.values.map((value) => JSON.stringify(value)).join(" | ");
    case "union": return type.variants.map((variant) => `({ ${JSON.stringify(type.tag)}: ${JSON.stringify(variant.tag)} } & ${tsType(variant.type)})`).join(" | ");
    case "blob_ref": return "{ id: string; size: number }";
    case "handle": return "{ id: string; resource: string }";
    case "object": return `{ ${type.fields.map((field) => `${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${tsType(field.type)}`).join("; ")} }`;
  }
}

function typeAlias(name: string, schema: WireObjectType): string {
  return `export type ${name} = ${tsType(schema)};`;
}

/** Generated clients keep i64/timestamps as bigint and validate through the common runtime. */
export function generateCapabilityClientFiles(definition: CapabilityDefinition): ArtifactFile[] {
  const prefix = typeName(definition.id);
  const aliases: string[] = [];
  const methods: string[] = [];
  const implementation: string[] = [];
  for (const operation of definition.operations) {
    const base = typeName(operation.name);
    const requestName = `${base}Request`;
    const resultName = `${base}Result`;
    const errorName = `${base}Error`;
    aliases.push(typeAlias(requestName, operation.request), typeAlias(resultName, operation.result), typeAlias(errorName, operation.error));
    methods.push(`${operation.name}(input: ${requestName}): Promise<${resultName}>;`);
    implementation.push(`${operation.name}: (input: ${requestName}) => client.call(${JSON.stringify(operation.name)}, input as Record<string, unknown>) as Promise<${resultName}>,`);
  }
  const client = `// Generated from CapabilityDefinition ${definition.id}@${definition.version}.
import type { CapabilityClient } from "@splice/runtime";
${aliases.join("\n")}
export interface ${prefix}Client { ${methods.join(" ")} }
export function create${prefix}Client(client: CapabilityClient): ${prefix}Client {
  return { ${implementation.join("\n")} };
}
`;
  const schemas = Object.fromEntries(definition.operations.map((operation) => [operation.name, { request: operation.request, result: operation.result }]));
  const host = `// Generated wire boundary for ${definition.id}@${definition.version}.
import { encodeWireValue, decodeWireValue, type WireObjectType } from "@splice/contracts";
const schemas: Record<string, { request: WireObjectType; result: WireObjectType }> = ${JSON.stringify(schemas)};
export async function dispatch${prefix}Operation(
  handlers: Record<string, (input: Record<string, unknown>) => Promise<Record<string, unknown>>>,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const schema = schemas[name];
  const handler = handlers[name];
  if (!schema || !handler) throw new Error("Unknown capability operation " + name);
  const request = decodeWireValue(schema.request, encodeWireValue(schema.request, input)) as Record<string, unknown>;
  const result = await handler(request);
  return decodeWireValue(schema.result, encodeWireValue(schema.result, result)) as Record<string, unknown>;
}
`;
  const readme = `# ${definition.title}\n\nGenerated public client and host wrapper for ${definition.id}@${definition.version}.\n\n` +
    `The operation request, result, and error types come from the pinned wire schemas. ` +
    `Use create${prefix}Client with a verified @splice/runtime CapabilityClient. ` +
    `Use dispatch${prefix}Operation to validate both sides of a host handler.\n\n` +
    definition.operations.map((operation) => `- ${operation.name}: ${operation.summary}`).join("\n") + "\n";
  return [
    { path: "client/client.ts", data: Buffer.from(client) },
    { path: "client/host.ts", data: Buffer.from(host) },
    { path: "client/README.md", data: Buffer.from(readme) },
  ];
}
