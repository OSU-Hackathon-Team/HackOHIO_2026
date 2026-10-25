// Deterministic API Router & Client Generator (Layer 2 of Backend Generation)
//
// Takes a FeatureSpec with placement: "server" or "either" and an implemented engine
// module, then produces:
//   1. An Express router (POST /api/<feature_id>/<export_name>)
//   2. A typed frontend client wrapper (client.<feature_id>.<export_name>(args))
//
// Zero model calls, zero hallucination risk. Generated code is deterministic from the spec.

import type { FeatureSpec } from "@splice/contracts";

// ---------------------------------------------------------------------------
// Helpers: extract function parameter names from a signature string
// ---------------------------------------------------------------------------

/** Given a signature like "(card: CardState, grade: number, now: number) => CardState",
 *  returns ["card", "grade", "now"]. */
export function extractParamNames(signature: string): string[] {
  const match = signature.match(/^\(([^)]*)\)\s*=>/);
  if (!match) return [];
  const inner = match[1].trim();
  if (!inner) return [];
  // Split on commas, but respect nested angle brackets for generics
  const params: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) params.push(trimmed.split(":")[0].trim());
      current = "";
      continue;
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) params.push(trimmed.split(":")[0].trim());
  return params;
}

/** Sanitize a feature_id or export name for use in a URL path segment or property name. */
export function sanitizeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// ---------------------------------------------------------------------------
// Type-derived Zod schema strings
// ---------------------------------------------------------------------------

/** Produce a simple Zod schema string for a known TS primitive or named type.
 *  For complex types we fall back to z.unknown() and let runtime checks handle it. */
export function typeToZod(typeText: string, typesCode: string): string {
  let t = typeText.trim();
  if (t.endsWith("?")) {
    return typeToZod(t.slice(0, -1), typesCode);
  }
  if (t === "string") return "z.string()";
  if (t === "number") return "z.number()";
  if (t === "boolean") return "z.boolean()";
  if (t === "string[]" || t === "Array<string>") return "z.array(z.string())";
  if (t === "number[]" || t === "Array<number>") return "z.array(z.number())";
  if (t === "boolean[]" || t === "Array<boolean>") return "z.array(z.boolean())";
  if (t === "void" || t === "undefined") return "z.void()";
  if (t === "any") return "z.any()";
  if (t === "unknown") return "z.unknown()";
  if (t.startsWith("Record<")) return "z.record(z.unknown())";
  if (t.startsWith("{}") || t.startsWith("Object")) return "z.record(z.unknown())";
  // Object/interface types: trust the engine, validate as unknown at the boundary
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return "z.unknown() as unknown as " + t;
  // Fallback: anything else ( unions, etc.) → unknown
  return "z.unknown()";
}

// ---------------------------------------------------------------------------
// Router generator
// ---------------------------------------------------------------------------

/** Generate an Express router module string for a given FeatureSpec + engine import path.
 *
 *  For every export in spec.interface.exports whose kind is "function" and whose
 *  placement is "server" or "either", emits a POST /api/<feature_id>/<export_name>
 *  route that validates the request body with Zod (derived from io_types) and
 *  forwards to the engine function.
 *
 *  @param spec         The FeatureSpec (must have placement server/either and the engine already implemented).
 *  @param engineImport  TS import path for the engine module, e.g. "@/engines/sm2Scheduler".
 *  @returns            A string of TypeScript source for the router. */
export function generateExpressRouter(spec: FeatureSpec, engineImport: string = `@/engines/${spec.interface.module_name}`): string {
  const featureId = sanitizeSegment(spec.feature_id);
  const lines: string[] = [];

  // Header
  lines.push(`import { Router, type Request, type Response } from "express";`);
  lines.push(`import { z } from "zod";`);
  lines.push(`import { ${spec.interface.exports.filter(e => e.kind === "function").map(e => e.name).join(", ")} } from "${engineImport}";`);
  lines.push(`import type { ${extractTypeNames(spec.interface.types_code).join(", ")} } from "${engineImport}";`);
  lines.push("");
  lines.push(`const router = Router();`);
  lines.push(`const FEATURE_ID = "${featureId}";`);
  lines.push("");

  // For each function export, generate a route
  for (const exp of spec.interface.exports) {
    if (exp.kind !== "function") continue;
    const placement = spec.placement ?? "either";
    if (placement !== "server" && placement !== "either") continue;

    const exportName = exp.name;
    const routePath = `/api/${featureId}/${exportName}`;
    const paramNames = extractParamNames(exp.signature);

    lines.push(`// ${exp.description}`);
    lines.push(`// Signature: ${exp.signature}`);

    // Build Zod schema for the request body
    // For simplicity: we expect the body to be an object whose keys match the
    // function parameter names in order. We emit a schema derived from the
    // interface types_code if available, otherwise z.unknown().
    if (paramNames.length === 0) {
      lines.push(`router.post("${routePath}", async (req: Request, res: Response) => {`);
      lines.push(`  try {`);
      lines.push(`    const args = req.body as any[];`);
      lines.push(`    if (!Array.isArray(args)) {`);
      lines.push(`      return res.status(400).json({ error: "Expected an array of arguments" });`);
      lines.push(`    }`);
      lines.push(`    const result = await ${exportName}(...args);`);
      lines.push(`    return res.json({ ok: true, result });`);
      lines.push(`  } catch (err: any) {`);
      lines.push(`    if (err instanceof z.ZodError || err?.name === "ZodError" || err instanceof RangeError || err?.name === "RangeError" || err instanceof TypeError || err?.name === "TypeError") {`);
      lines.push(`      return res.status(400).json({ error: "Validation failed", details: err.errors ?? err.message });`);
      lines.push(`    }`);
      lines.push(`    console.error("[${featureId}] ${exportName} error:", err);`);
      lines.push(`    return res.status(500).json({ error: "Internal server error" });`);
      lines.push(`  }`);
      lines.push(`});`);
    } else {
      // Build parameter schema
      const paramSchemas = paramNames.map((p) => {
        // Try to infer type from the signature text
        const sigMatch = exp.signature.match(new RegExp(`\\b${p}\\s*:\\s*([^),]+)`));
        const typeText = sigMatch ? sigMatch[1].trim() : "unknown";
        // Strip optional marker
        const baseType = typeText.replace(/^\?/, "").trim();
        const zod = typeToZod(baseType, spec.interface.types_code);
        // Handle optional parameters (trailing ? in signature or type)
        const isOptional = exp.signature.includes(`${p}?:`) || exp.signature.includes(`${p}? :`) || typeText.endsWith("?");
        return `    ${p}: ${zod}${isOptional ? ".optional()" : ""}`;
      }).join(",\n");

      lines.push(`const ${exportName}Params = z.object({`);
      lines.push(paramSchemas);
      lines.push(`});`);
      lines.push("");
      lines.push(`router.post("${routePath}", async (req: Request, res: Response) => {`);
      lines.push(`  try {`);
      lines.push(`    const body = ${exportName}Params.parse(req.body);`);
      lines.push(`    const args: any[] = [`);
      paramNames.forEach((p) => lines.push(`      body.${p},`));
      lines.push(`    ];`);
      lines.push(`    const result = await ${exportName}(...args);`);
      lines.push(`    return res.json({ ok: true, result });`);
      lines.push(`  } catch (err: any) {`);
      lines.push(`    if (err instanceof z.ZodError || err?.name === "ZodError" || err instanceof RangeError || err?.name === "RangeError" || err instanceof TypeError || err?.name === "TypeError") {`);
      lines.push(`      return res.status(400).json({ error: "Validation failed", details: err.errors ?? err.message });`);
      lines.push(`    }`);
      lines.push(`    console.error("[${featureId}] ${exportName} error:", err);`);
      lines.push(`    return res.status(500).json({ error: "Internal server error" });`);
      lines.push(`  }`);
      lines.push(`});`);
    }
    lines.push("");
  }

  lines.push("export default router;");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Client generator
// ---------------------------------------------------------------------------

/** Generate a typed frontend API client module string.
 *
 *  Emits a nested object: client.<feature_id>.<export_name>(args) that performs
 *  fetch('/api/<feature_id>/<export_name>', { method: 'POST', ... }) and unwraps
 *  the { ok, result } response shape.
 *
 *  @param spec   The FeatureSpec.
 *  @returns      A string of TypeScript source for the client module. */
export function generateApiClient(spec: FeatureSpec): string {
  const featureId = sanitizeSegment(spec.feature_id);
  const lines: string[] = [];

  lines.push(`// Auto-generated typed client for ${spec.feature_id}`);
  lines.push(`// DO NOT EDIT — generated by apiGenerator from the FeatureSpec.`);
  lines.push("");

  // Build the client object structure
  lines.push(`export const apiClient = {`);
  lines.push(`  "${featureId}": {`);

  for (const exp of spec.interface.exports) {
    if (exp.kind !== "function") continue;
    const placement = spec.placement ?? "either";
    if (placement !== "server" && placement !== "either") continue;

    const exportName = exp.name;
    const routePath = `/api/${featureId}/${exportName}`;
    const paramNames = extractParamNames(exp.signature);
    const returnType = exp.signature.split("=>")[1]?.trim() ?? "unknown";

    lines.push(`    /** ${exp.description} */`);
    lines.push(`    /** Signature: ${exp.signature} */`);

    if (paramNames.length === 0) {
      lines.push(`    ${exportName}: async (): Promise<${returnType}> => {`);
      lines.push(`      const res = await fetch("${routePath}", {`);
      lines.push(`        method: "POST",`);
      lines.push(`        headers: { "Content-Type": "application/json" },`);
      lines.push(`        body: JSON.stringify([]),`);
      lines.push(`      });`);
      lines.push(`      if (!res.ok) {`);
      lines.push(`        const err = await res.json().catch(() => ({})) as any;`);
      lines.push(`        throw new Error(err.error ?? \`API error \${res.status}\`);`);
      lines.push(`      }`);
      lines.push(`      const body = await res.json() as { ok: boolean; result: ${returnType} };`);
      lines.push(`      if (!body.ok) throw new Error(body.error ?? "API returned ok: false");`);
      lines.push(`      return body.result;`);
      lines.push(`    },`);
    } else {
      // Build parameter list
      const params = paramNames.map((p) => {
        const sigMatch = exp.signature.match(new RegExp(`\\b${p}\\s*:\\s*([^),]+)`));
        const typeText = sigMatch ? sigMatch[1].trim().replace(/^\?/, "").trim() : "unknown";
        return `${p}: ${typeText}`;
      }).join(", ");

      lines.push(`    ${exportName}: async (${params}): Promise<${returnType}> => {`);
      lines.push(`      const res = await fetch("${routePath}", {`);
      lines.push(`        method: "POST",`);
      lines.push(`        headers: { "Content-Type": "application/json" },`);
      lines.push(`        body: JSON.stringify({`);
      paramNames.forEach((p) => lines.push(`          ${p},`));
      lines.push(`        }),`);
      lines.push(`      });`);
      lines.push(`      if (!res.ok) {`);
      lines.push(`        const err = await res.json().catch(() => ({})) as any;`);
      lines.push(`        throw new Error(err.error ?? \`API error \${res.status}\`);`);
      lines.push(`      }`);
      lines.push(`      const body = await res.json() as { ok: boolean; result: ${returnType} };`);
      lines.push(`      if (!body.ok) throw new Error(body.error ?? "API returned ok: false");`);
      lines.push(`      return body.result;`);
      lines.push(`    },`);
    }
    lines.push("");
  }

  lines.push(`  },`);
  lines.push(`};`);
  lines.push("");
  lines.push(`export type ApiClient = typeof apiClient;`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract top-level type names from types_code (interfaces, type aliases, consts). */
function extractTypeNames(typesCode: string): string[] {
  const names: string[] = [];
  // export interface Foo { ... }
  for (const m of typesCode.matchAll(/export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.push(m[1]);
  }
  // export type Foo = ...
  for (const m of typesCode.matchAll(/export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
    names.push(m[1]);
  }
  // export declare function ... — skip, those are functions
  // export const Foo: ... — skip consts for import, they're values
  return [...new Set(names)];
}
