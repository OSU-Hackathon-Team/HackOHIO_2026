# 03 — Requirements Prompt & Output Schema

One structured call turns `RawEvidence` into a `SpecDraft`. `buildSpec` (05) then checks it,
runs the oracle, repairs it, and wraps it into a `FeatureSpec`.

## 1. `SpecDraft` — what the model returns

Zod (validation, in `src/spec/prompt.ts`):

```ts
import { z } from "zod";
import { Requirement, ExportSig, IoField } from "@splice/contracts";

export const SpecDraft = z.object({
  consumer_title: z.string().max(60),
  consumer_description: z.string().max(400),
  requirements: z.array(Requirement).min(1).max(20),
  module_name: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
  exports: z.array(ExportSig).min(1),
  types_code: z.string(),
  inputs: z.array(IoField),
  outputs: z.array(IoField),
  acceptance_tests: z.string(),
  adapter_code: z.string(),
  allowed_deviations: z.array(z.string()),
  stripped_glue: z.array(z.string()),
});
export type SpecDraft = z.infer<typeof SpecDraft>;
```

JSON Schema for `output_config.format` (hand-written, in `src/llm/schemas.ts`). Keep it plain:
strings, arrays, objects and enums, every object `additionalProperties: false` with everything
`required`. Regex rules stay in Zod.

```ts
const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const io = {
  type: "object",
  properties: { name: str, type: str, description: str },
  required: ["name", "type", "description"],
  additionalProperties: false,
} as const;

export const SPEC_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    consumer_title: str,
    consumer_description: str,
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: str,
          kind: { type: "string", enum: ["behavior", "invariant", "edge_case", "error"] },
          statement: str,
          source_refs: strArr,
        },
        required: ["id", "kind", "statement", "source_refs"],
        additionalProperties: false,
      },
    },
    module_name: str,
    exports: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: str,
          kind: { type: "string", enum: ["function", "type", "const"] },
          signature: str,
          description: str,
        },
        required: ["name", "kind", "signature", "description"],
        additionalProperties: false,
      },
    },
    types_code: str,
    inputs: { type: "array", items: io },
    outputs: { type: "array", items: io },
    acceptance_tests: str,
    adapter_code: str,
    allowed_deviations: strArr,
    stripped_glue: strArr,
  },
  required: [
    "consumer_title", "consumer_description", "requirements", "module_name", "exports", "types_code",
    "inputs", "outputs", "acceptance_tests", "adapter_code", "allowed_deviations", "stripped_glue",
  ],
  additionalProperties: false,
} as const;
```

## 2. System prompt — `src/spec/prompt.ts`

Keep it byte-identical between calls. No timestamps or IDs in it, so prompt caching works.

```ts
export const SPEC_SYSTEM = `You are the requirements analyst in Splice, a tool that turns features of desktop apps into reusable modules.

You receive source code that a reverse-engineering tool (REA) located inside a packaged Electron app. The apps are small demo apps our team built and owns. Your job: write a precise, testable SPECIFICATION of one feature so a different engineer can re-implement it as a pure TypeScript module without ever seeing the original. You do not write the implementation.

Respond with JSON matching the provided schema.

# requirements
- Number them REQ-1, REQ-2, ... with no gaps.
- Each is ONE observable behavior of the feature's domain logic that a test can check. kind is one of: behavior, invariant, edge_case, error.
- Each cites source_refs as "<path>:L<start>-L<end>" using the line numbers shown in the evidence. Cite only the lines that justify the statement.
- Describe what the code DOES, including quirks: rounding, ordering and tie-breaks, de-duplication, what input is ignored, what throws. Never describe what it "should" do. A surprising behavior in the original IS a requirement.
- Use the declared feature boundary to decide what to include. Preserve externally observable persistence, timing, networking, ordering, errors, and state changes when they belong to the requested behavior. For the pure-function Electron demo, omit transport/UI wiring only when it does not change that behavior; list each exclusion and its reason in stripped_glue. Do not exclude behavior solely because it uses a platform API.
- Aim for 5 to 12 requirements. Cover every branch of the functions listed under <symbols>.

# interface: module_name, exports, types_code
- Design a clean TypeScript API for the domain logic. module_name is camelCase (e.g. sm2Scheduler).
- Parameters and results are plain data: string, number, boolean, arrays, plain objects. No classes, Map, Set, Date objects or callbacks in signatures. Dates are "YYYY-MM-DD" strings.
- No hidden inputs. Anything the original reads from the clock, randomness or environment becomes an explicit parameter. Record each such change in allowed_deviations.
- You may rename fields for clarity. Record renames in allowed_deviations.
- types_code contains ONLY "export interface", "export type" and "export declare function" declarations. No implementations, no imports.
- exports lists every function and type declared in types_code, with its signature.

# acceptance_tests (TypeScript)
- Runs in a sandbox with these globals: test(name, fn); assert.equal(actual, expected, msg?); assert.deepEqual(actual, expected, msg?); assert.ok(value, msg?); assert.closeTo(actual, expected, epsilon?, msg?); assert.throws(fn, errorName?); plus every function in your interface, called directly by name. No imports.
- Every test name starts with the requirement IDs it covers, e.g. test("REQ-3 REQ-5: later reviews use the previous ease", () => { ... }).
- Every requirement is covered by at least one test. Tests are synchronous and deterministic: no Date.now(), new Date() without arguments, or Math.random().
- Use small literal inputs whose expected outputs you computed by tracing the original code by hand, step by step. Include boundary values. Prefer exact equality; use closeTo only for genuinely fractional results.

# adapter_code (plain JavaScript, CommonJS)
- Implements EVERY function in your interface by calling the ORIGINAL module(s), so the acceptance tests can be run against the original app code.
- Load originals with original("<path exactly as shown in the evidence>"), e.g. const sm2 = original("src/scheduler/sm2.js").
- Only translate between your interface and the original: rename fields, convert "YYYY-MM-DD" to the original's clock format and back. Do NOT re-implement logic in the adapter. Every interface function must delegate its real work to an original function. Tests that never call into original code are rejected.
- End with module.exports = { <every interface function> }.
- Original modules may require each other by relative path. Platform modules (electron, fs, ...) are stubbed and throw when called, so only call domain functions.

# consumer_title, consumer_description, inputs, outputs
- consumer_title: at most 6 plain words. consumer_description: at most 2 sentences a non-programmer understands: what you give it and what you get back.
- inputs/outputs describe the main function's parameters and result in plain terms.

# Small example (different feature, for format only)
Original src/text/stats.js:
  1 | function countWords(s) { return s.trim() === "" ? 0 : s.trim().split(/\\s+/).length; }
  2 | module.exports = { countWords };
Good requirement: { "id": "REQ-1", "kind": "edge_case", "statement": "A string that is empty or only whitespace has 0 words", "source_refs": ["src/text/stats.js:L1-L1"] }
Good test: test("REQ-1: blank text has zero words", () => { assert.equal(wordCount("   "), 0); });
Good adapter: const stats = original("src/text/stats.js"); function wordCount(text) { return stats.countWords(text); } module.exports = { wordCount };`;
```

## 3. Evidence formatting — `src/spec/formatEvidence.ts`

Line numbers are **required**: requirements cite them, and static checks (05) verify them.

```ts
import type { RawEvidence, PantryApp, PantryFeature } from "@splice/contracts";

export function snippetPath(location: string): string {
  // "app.asar:src/graph/backlinks.js" → "src/graph/backlinks.js"
  const i = location.indexOf(":");
  return i >= 0 ? location.slice(i + 1) : location;
}

export function withLineNumbers(code: string): string {
  const lines = code.split(/\r?\n/);
  const w = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(w)} | ${l}`).join("\n");
}

export function formatEvidence(ev: RawEvidence, app: PantryApp, feature: PantryFeature): string {
  const calls = ev.tool_calls
    .map((c) => `#${c.seq} ${c.tool} ${c.ok ? "ok" : "FAILED"} ${c.duration_ms}ms — ${c.summary}${c.evidence_id ? ` (evidence ${c.evidence_id.slice(0, 15)}…)` : ""}`)
    .join("\n");
  const sources = ev.snippets
    .map((s) =>
      `<source path="${snippetPath(s.location)}" symbol="${s.symbol ?? ""}" full_module="${s.full_module}">\n${withLineNumbers(s.code)}\n</source>`)
    .join("\n\n");

  return `<feature>
app: ${app.display_name} (${app.app_id}), artifact: ${ev.target.artifact_type}, sha256: ${ev.target.sha256.slice(0, 16)}…
feature_id: ${feature.feature_id}
title: ${feature.title}
question: ${feature.query}
</feature>

<symbols>
${feature.symbols.join(", ")}
</symbols>

<rea_trace>
${calls || "(evidence recorded earlier; no live calls in this run)"}
limitations: ${ev.limitations.join(" | ") || "none reported"}
unknowns: ${ev.unknowns.join(" | ") || "none reported"}
</rea_trace>

${sources}

Write the specification for this feature.`;
}
```

## 4. The call — inside `buildSpec` (05)

```ts
const messages = [{ role: "user" as const, content: formatEvidence(evidence, app, feature) }];
const first = await structuredCall({
  role: "spec_writer",
  system: SPEC_SYSTEM,
  messages,
  schema: SPEC_DRAFT_SCHEMA,
  parse: (v) => SpecDraft.parse(v),
  effort: "high",
  maxTokens: 32_000,
  signal: hooks.signal,
  onProgress: (n) => hooks.onProgress("specifying", n),
});
```

## 5. Prompt-tuning checklist (run `npm run spec:all` after each change)

| Symptom | Fix in prompt |
|---|---|
| Requirements describe "ideal" behaviour, and the oracle fails | Strengthen "describe what it DOES"; add the quirk to the example |
| Adapter re-implements logic or discards original results | Review delegation and data transformations; a call counter alone cannot detect this. Feed concrete failures back into repair (05) |
| Tests use `new Date()` | Already forbidden. The static check catches it and repair quotes it |
| Platform concerns appear in the interface | Check the requested boundary. Preserve observable effects; exclude only implementation wiring, with a reason |
| Titles too technical ("SM-2 Recurrence Engine") | Keep the "non-programmer" wording. Judges read these cards |
