import type { CapabilityDefinition, CapabilityIntakeRequest, JsonValue, Meaning, WireObjectType, WireType } from "@splice/contracts";
import { hashJson } from "../capabilities/identity.js";
import { documentSignature } from "../composition/documentMigrations.js";

const text = (max_bytes: number): WireType => ({ kind: "string", encoding: "utf-8", max_bytes });
const float64: WireType = { kind: "float", bits: 64 };
const neutralMeaning: Meaning = { units: null, id_domain: null, timezone: null, ordering: null, null_semantics: null, cardinality: null, value_scale: null };
const transcriptMeaning: Meaning = { ...neutralMeaning, ordering: "sorted_by_time", cardinality: "many" };
const errors: WireObjectType = {
  kind: "object",
  additional: false,
  fields: [
    { name: "code", type: { kind: "enum", values: ["invalid_input", "invalid_formula", "missing_cell", "division_by_zero", "provider_unavailable", "internal"] }, optional: false },
    { name: "message", type: text(1000), optional: false },
  ],
};

const origin = (id: string) => {
  const artifact = { kind: "authored_development", id, version: 1 };
  return {
    artifact,
    value: {
      kind: "authored" as const,
      artifact_hash: hashJson(artifact),
      artifact_ref: `authored_development/${id}@1`,
      source_app: "Splice authored development fixture",
      stage: "downstream_authored" as const,
    },
  };
};

function operation(name: string, summary: string, request: WireObjectType, result: WireObjectType) {
  return {
    name,
    summary,
    request,
    result,
    error: errors,
    idempotent: true,
    cancellable: false,
    timeout_ms: 5_000,
    streaming: null,
    host_effects: [] as [],
  };
}

const stringMap: WireType = { kind: "map", values: float64, max_entries: 2048 };
const segment: WireObjectType = {
  kind: "object",
  additional: false,
  fields: [
    { name: "id", type: text(120), optional: false },
    { name: "start_ms", type: { kind: "int", bits: 32, signed: false }, optional: false },
    { name: "end_ms", type: { kind: "int", bits: 32, signed: false }, optional: false },
    { name: "text", type: text(4000), optional: false },
  ],
};
const segmentArray: WireType = { kind: "array", items: segment, max_items: 10_000, ordered: true };

export function getAuthoredNotebookIntakes(): Array<{ definition: CapabilityDefinition; request: CapabilityIntakeRequest }> {
  const formulaOrigin = origin("formula_subset");
  const markdownOrigin = origin("markdown_subset");
  const transcriptOrigin = origin("recorded_transcription_provider");
  const definitions: CapabilityDefinition[] = [
    {
      schema_version: 1,
      id: "splice.example.formula",
      version: "1.0.0",
      title: "Bounded formula evaluator",
      description: "An authored development evaluator for decimal arithmetic and single-cell references.",
      origin: formulaOrigin.value,
      selected_behavior: ["decimal arithmetic with +, -, *, / and parentheses", "single-cell references resolved from an explicit cell map", "typed formula and division errors"],
      exclusions: ["not Calc parity", "no functions, ranges, locale rules, date serials, arrays or circular-reference analysis"],
      operations: [operation("evaluate", "Evaluate one bounded arithmetic formula.", {
        kind: "object", additional: false, fields: [
          { name: "formula", type: text(2048), optional: false },
          { name: "cells", type: stringMap, optional: false },
        ],
      }, { kind: "object", additional: false, fields: [{ name: "value", type: float64, optional: false }] })],
      provides: [{ port: "evaluate", schema: { kind: "object", additional: false, fields: [{ name: "value", type: float64, optional: false }] }, meaning: neutralMeaning }], requires: [],
      state: { ownership: "package", durable: false, schema: null, migrations: [] },
      lifecycle: { start_operation: null, dispose_operation: null, restart_policy: "on_crash" },
      host_effects: [], assumptions: ["Cell names are A1-style identifiers", "All values use ordinary decimal floating point"],
      preferred_runtime: "ts_worker",
      public_tests: [{ name: "arithmetic", requirement_ids: ["FORMULA-1"], kind: "public" }],
    },
    {
      schema_version: 1,
      id: "splice.example.markdown",
      version: "1.0.0",
      title: "Safe Markdown subset renderer",
      description: "An authored development renderer for headings, paragraphs, emphasis, lists, code and safe links.",
      origin: markdownOrigin.value,
      selected_behavior: ["heading, paragraph, emphasis, list and fenced-code subset", "HTML escaping before rendering", "safe HTTP, mail and fragment links"],
      exclusions: ["not Obsidian parity", "no embeds, block references, callouts, plugins or resource loading"],
      operations: [operation("render", "Render the declared Markdown subset to escaped HTML.", {
        kind: "object", additional: false, fields: [{ name: "markdown", type: text(100_000), optional: false }, { name: "value", type: float64, optional: false }, { name: "segments", type: segmentArray, optional: false }],
      }, { kind: "object", additional: false, fields: [{ name: "html", type: text(300_000), optional: false }] })],
      provides: [], requires: [
        { port: "calculation", schema: { kind: "object", additional: false, fields: [{ name: "value", type: float64, optional: false }] }, meaning: neutralMeaning },
        { port: "transcript", schema: { kind: "object", additional: false, fields: [{ name: "segments", type: segmentArray, optional: false }] }, meaning: transcriptMeaning },
      ],
      state: { ownership: "package", durable: false, schema: null, migrations: [] },
      lifecycle: { start_operation: null, dispose_operation: null, restart_policy: "on_crash" },
      host_effects: [], assumptions: ["The renderer returns HTML for a trusted host view to insert"],
      preferred_runtime: "ts_worker",
      public_tests: [{ name: "escaping", requirement_ids: ["MARKDOWN-1"], kind: "public" }],
    },
    {
      schema_version: 1,
      id: "splice.example.transcription",
      version: "1.0.0",
      title: "Recorded transcription fixture",
      description: "An authored fixture adapter that accepts transcript segments and returns them in declared order.",
      origin: transcriptOrigin.value,
      selected_behavior: ["accept ordered transcript segments from a recorded fixture"],
      exclusions: ["not a live audio provider", "no speech recognition, microphone access or Notion parity"],
      operations: [operation("accept_segments", "Validate and return recorded transcript segments.", {
        kind: "object", additional: false, fields: [{ name: "segments", type: segmentArray, optional: false }],
      }, { kind: "object", additional: false, fields: [{ name: "segments", type: segmentArray, optional: false }] })],
      provides: [{ port: "accept_segments", schema: { kind: "object", additional: false, fields: [{ name: "segments", type: segmentArray, optional: false }] }, meaning: transcriptMeaning }], requires: [],
      state: { ownership: "package", durable: false, schema: null, migrations: [] },
      lifecycle: { start_operation: null, dispose_operation: null, restart_policy: "on_crash" },
      host_effects: [], assumptions: ["The caller supplies already transcribed segments"],
      preferred_runtime: "ts_worker",
      public_tests: [{ name: "ordered segments", requirement_ids: ["TRANSCRIPT-1"], kind: "public" }],
    },
  ];
  const sources = [formulaImplementation, markdownImplementation, transcriptionImplementation];
  const tests = [
    { name: "arithmetic", requirement_ids: ["FORMULA-1"], harness: "ts" as const, code: 'let out = await ctx.call("evaluate", { formula: "=B2*C2", cells: { B2: 3, C2: 20 } }); ctx.assert.equal(out.value, 60); out = await ctx.call("evaluate", { formula: "=B2+C2", cells: { B2: 3, C2: 20 } }); ctx.assert.equal(out.value, 23); out = await ctx.call("evaluate", { formula: "=C2-B2", cells: { B2: 3, C2: 20 } }); ctx.assert.equal(out.value, 17); out = await ctx.call("evaluate", { formula: "=C2/B2", cells: { B2: 3, C2: 20 } }); ctx.assert.ok(Math.abs(out.value - 20 / 3) < 1e-9); await ctx.assert.rejects(() => ctx.call("evaluate", { formula: "=C2/0", cells: { C2: 20 } }), /Formula divides by zero/);' },
    { name: "escaping", requirement_ids: ["MARKDOWN-1"], harness: "ts" as const, code: 'let out = await ctx.call("render", { markdown: "# Title\\n\\nA **bold** line with <script>", value: 60, segments: [] }); ctx.assert.equal(out.html, "<h1>Title</h1>\\n<p>A <strong>bold</strong> line with &lt;script&gt;</p>"); out = await ctx.call("render", { markdown: "- [budget](https://example.org)\\n- second\\n\\nValue {{value}}", value: 80, segments: [{ id: "s1", start_ms: 0, end_ms: 500, text: "<test>" }] }); ctx.assert.equal(out.html, "<ul><li><a href=\\"https://example.org\\">budget</a></li><li>second</li></ul>\\n<p>Value 80</p>\\n<ol class=\\"transcript\\"><li>&lt;test&gt;</li></ol>");' },
    { name: "ordered segments", requirement_ids: ["TRANSCRIPT-1"], harness: "ts" as const, code: 'const input = [{ id: "s1", start_ms: 0, end_ms: 500, text: "hello" }]; let out = await ctx.call("accept_segments", { segments: input }); ctx.assert.deepEqual(out.segments, input); out = await ctx.call("accept_segments", { segments: [...input, ...input] }); ctx.assert.deepEqual(out.segments, input); await ctx.assert.rejects(() => ctx.call("accept_segments", { segments: [{ id: "s2", start_ms: 500, end_ms: 600, text: "later" }, ...input] }), /ordered/);' },
  ];
  return definitions.map((definition, index) => ({
    definition,
    request: {
      definition,
      origin_artifact: [formulaOrigin.artifact, markdownOrigin.artifact, transcriptOrigin.artifact][index],
      review_attestation: null,
      implementation: { kind: "typescript", entry: "index.ts", files: [{ path: "index.ts", content: sources[index], encoding: "utf8" }] },
      public_tests: [tests[index]],
      independent_verdict: null,
    },
  }));
}

const formulaImplementation = `
type Token = { kind: "number" | "cell" | "operator" | "eof"; value: string };
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code, retryable: false }); }
function tokenize(source: string): Token[] {
  const text = source.startsWith("=") ? source.slice(1) : source;
  if (text.length > 2048) fail("invalid_formula", "Formula is too long");
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\\s/.test(text[index])) { index += 1; continue; }
    const rest = text.slice(index);
    const number = /^(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?/.exec(rest);
    if (number) { tokens.push({ kind: "number", value: number[0] }); index += number[0].length; continue; }
    const cell = /^[A-Za-z]{1,3}[1-9]\\d{0,6}/.exec(rest);
    if (cell) { tokens.push({ kind: "cell", value: cell[0].toUpperCase() }); index += cell[0].length; continue; }
    if ("+-*/()".includes(text[index])) { tokens.push({ kind: "operator", value: text[index++] }); continue; }
    fail("invalid_formula", "Formula contains an unsupported token");
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}
function evaluate(source: string, cells: Record<string, number>): number {
  const tokens = tokenize(source); let at = 0; let depth = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const expression = (): number => { let value = term(); while (peek().value === "+" || peek().value === "-") { const op = take().value; const rhs = term(); value = op === "+" ? value + rhs : value - rhs; } return value; };
  const term = (): number => { let value = atom(); while (peek().value === "*" || peek().value === "/") { const op = take().value; const rhs = atom(); if (op === "/" && rhs === 0) fail("division_by_zero", "Formula divides by zero"); value = op === "*" ? value * rhs : value / rhs; } return value; };
  const atom = (): number => { const token = take(); if (token.value === "+") return atom(); if (token.value === "-") return -atom(); if (token.value === "(") { depth += 1; if (depth > 32) fail("invalid_formula", "Formula nesting is too deep"); const value = expression(); if (take().value !== ")") fail("invalid_formula", "Missing closing parenthesis"); depth -= 1; return value; } if (token.kind === "number") return Number(token.value); if (token.kind === "cell") { if (!Object.hasOwn(cells, token.value)) fail("missing_cell", "Formula references a missing cell"); return cells[token.value]; } fail("invalid_formula", "Expected a number, cell or parenthesized expression"); };
  const result = expression(); if (peek().kind !== "eof" || !Number.isFinite(result)) fail("invalid_formula", "Formula has trailing input or a non-finite result"); return result;
}
export const operations = { evaluate: ({ formula, cells }: { formula: string; cells: Record<string, number> }) => ({ value: evaluate(formula, cells) }) };
`;

const markdownImplementation = `
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
function inline(source: string): string {
  let value = escapeHtml(source);
  value = value.replace(/\\[([^\\]]+)\\]\\(([^ )]+)\\)/g, (_all, label: string, raw: string) => { const url = raw.trim(); return /^(https?:|mailto:|#)/i.test(url) ? '<a href="' + escapeHtml(url) + '">' + label + '</a>' : label; });
  value = value.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>").replace(/\\*([^*]+)\\*/g, "<em>$1</em>").replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
  return value;
}
function render(markdown: string): string {
  const blocks: string[] = []; let paragraph: string[] = []; let list: string[] = []; let code: string[] | null = null;
  const flushParagraph = () => { if (paragraph.length) blocks.push("<p>" + inline(paragraph.join(" ")) + "</p>"); paragraph = []; };
  const flushList = () => { if (list.length) blocks.push("<ul>" + list.map((line) => "<li>" + inline(line) + "</li>").join("") + "</ul>"); list = []; };
  for (const line of markdown.split(/\\r?\\n/)) {
    if (line.startsWith("\x60\x60\x60")) { if (code) { blocks.push("<pre><code>" + escapeHtml(code.join("\\n")) + "</code></pre>"); code = null; } else { flushParagraph(); flushList(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = /^(#{1,6})\\s+(.+)$/.exec(line);
    if (heading) { flushParagraph(); flushList(); const level = heading[1].length; blocks.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">"); continue; }
    const item = /^\\s*[-*+]\\s+(.+)$/.exec(line);
    if (item) { flushParagraph(); list.push(item[1]); continue; }
    flushList(); paragraph.push(line.trim());
  }
  flushParagraph(); flushList(); if (code) blocks.push("<pre><code>" + escapeHtml(code.join("\\n")) + "</code></pre>"); return blocks.join("\\n");
}
export const operations = { render: ({ markdown, value, segments }: { markdown: string; value: number; segments: Array<{ id: string; start_ms: number; end_ms: number; text: string }> }) => ({ html: render(markdown.replace(/\\{\\{value\\}\\}/g, String(value))) + (segments.length ? '\\n<ol class="transcript">' + segments.map((segment) => '<li>' + escapeHtml(segment.text) + '</li>').join('') + '</ol>' : '') }) };
`;

const transcriptionImplementation = `
export const operations = { accept_segments: ({ segments }: { segments: Array<{ id: string; start_ms: number | bigint; end_ms: number | bigint; text: string }> }) => {
  let last = -1n;
  const seen = new Map<string, string>();
  const unique: typeof segments = [];
  for (const segment of segments) { const encoded = JSON.stringify(segment); const prior = seen.get(segment.id); if (prior) { if (prior !== encoded) throw Object.assign(new Error("Duplicate transcript ID has conflicting content"), { code: "invalid_input", retryable: false }); continue; } const start = BigInt(segment.start_ms); const end = BigInt(segment.end_ms); if (start < last || end < start) throw Object.assign(new Error("Transcript segments must be ordered"), { code: "invalid_input", retryable: false }); last = start; seen.set(segment.id, encoded); unique.push(segment); }
  return { segments: unique };
} };
`;

export function notebookPlan(packages: ReadonlyMap<string, string>) {
  const intakes = getAuthoredNotebookIntakes();
  const formula = packages.get("splice.example.formula");
  const markdown = packages.get("splice.example.markdown");
  const transcription = packages.get("splice.example.transcription");
  if (!formula || !markdown || !transcription) throw new Error("Authored notebook capabilities have not been built");
  const notebookSchema: WireObjectType = {
    kind: "object", additional: false, fields: [
      { name: "transcript", type: segmentArray, optional: false },
      { name: "formula", type: text(2048), optional: false },
      { name: "value", type: float64, optional: false },
      { name: "html", type: text(300_000), optional: false },
    ],
  };
  const wfInput: WireObjectType = {
    kind: "object", additional: false, fields: [
      { name: "segments", type: segmentArray, optional: false },
      { name: "formula", type: text(2048), optional: false },
      { name: "markdown", type: text(100_000), optional: false },
    ],
  };
  const documents = [
    { id: "meeting", kind: "document" as const, schema: notebookSchema, owner_instance: null, revisioned: true, description: "Composition-owned meeting notebook state.", initial: { transcript: [], formula: "", value: 0, html: "" } },
    { id: "workbook", kind: "workbook" as const, schema: { kind: "object" as const, additional: false as const, fields: [{ name: "cells", type: stringMap, optional: false }] }, owner_instance: null, revisioned: true, description: "Confirmed numeric cells for meeting calculations.", initial: { cells: {} } },
  ];
  return {
    schema_version: 1 as const,
    app: { title: "Meeting notebook", description: "Authored development slice that stores recorded transcript segments, evaluates a bounded formula and renders a safe Markdown subset." },
    instances: [
      { instance: "transcript", package_id: transcription, definition_hash: hashJson(intakes[2].definition), config: {}, permissions: [] },
      { instance: "formula", package_id: formula, definition_hash: hashJson(intakes[0].definition), config: {}, permissions: [] },
      { instance: "markdown", package_id: markdown, definition_hash: hashJson(intakes[1].definition), config: {}, permissions: [] },
    ],
    bindings: [
      { id: "formula_markdown", from: { instance: "formula", port: "evaluate" }, to: { instance: "markdown", port: "calculation" }, mappings: [{ from: "$from.value", to: "value", transform: "identity" as const, factor: null }], unit_bridge: null, notes: ["Formula output is explicitly mapped into Markdown rendering"] },
      { id: "transcript_markdown", from: { instance: "transcript", port: "accept_segments" }, to: { instance: "markdown", port: "transcript" }, mappings: [{ from: "$from.segments", to: "segments", transform: "identity" as const, factor: null }], unit_bridge: null, notes: ["Recorded transcript segments are explicitly mapped into the note"] },
    ],
    documents,
    document_migrations: [{ id: "add_workbook", from_signature: documentSignature(documents.slice(0, 1)), to_signature: documentSignature(documents), add_documents: ["workbook"] }],
    workflows: [{
      id: "update_notebook", name: "Update meeting notebook", trigger: "user" as const, input: wfInput,
      output: { kind: "object" as const, additional: false as const, fields: [
        { name: "transcript", type: segmentArray, optional: false },
        { name: "value", type: float64, optional: false },
        { name: "html", type: text(300_000), optional: false },
      ] },
      steps: [
        { id: "transcribe", operation: { instance: "transcript", port: "accept_segments" }, input: [{ from: "$input.segments", to: "segments", transform: "identity" as const, factor: null }], depends_on: [], timeout_ms: 5_000, retries: 0, retry_on_codes: [], idempotency: "none" as const, on_error: "fail" as const, cancellation: "propagate" as const, stale_guard: null, writes: [{ document: "meeting", path: "transcript", from: "$steps.transcribe.segments" }] },
        { id: "calculate", operation: { instance: "formula", port: "evaluate" }, input: [{ from: "$input.formula", to: "formula", transform: "identity" as const, factor: null }, { from: "$doc.workbook.cells", to: "cells", transform: "identity" as const, factor: null }], depends_on: [], timeout_ms: 5_000, retries: 0, retry_on_codes: [], idempotency: "none" as const, on_error: "fail" as const, cancellation: "propagate" as const, stale_guard: { document: "workbook" }, writes: [{ document: "meeting", path: "formula", from: "$input.formula" }, { document: "meeting", path: "value", from: "$steps.calculate.value" }] },
        { id: "render", operation: { instance: "markdown", port: "render" }, input: [{ from: "$input.markdown", to: "markdown", transform: "identity" as const, factor: null }, { from: "$bindings.formula_markdown.value", to: "value", transform: "identity" as const, factor: null }, { from: "$bindings.transcript_markdown.segments", to: "segments", transform: "identity" as const, factor: null }], depends_on: ["calculate", "transcribe"], timeout_ms: 5_000, retries: 0, retry_on_codes: [], idempotency: "none" as const, on_error: "fail" as const, cancellation: "propagate" as const, stale_guard: null, writes: [{ document: "meeting", path: "html", from: "$steps.render.html" }] },
      ],
    }],
    ui: [
      { id: "notebook", kind: "document" as const, title: "Meeting notebook", bindings: [{ name: "transcript", source: "$doc.meeting.transcript", operation: null }, { name: "formula", source: "$doc.meeting.formula", operation: null }, { name: "value", source: "$doc.meeting.value", operation: null }, { name: "html", source: "$doc.meeting.html", operation: null }], actions: [{ id: "update", label: "Update notebook", workflow: "update_notebook" }] },
      { id: "workbook", kind: "table" as const, title: "Confirmed budget cells", bindings: [{ name: "cells", source: "$doc.workbook.cells", operation: null }], actions: [] },
    ],
    permissions: [], providers: [{ id: "recorded_provider", capability: "splice.example.transcription", transport: "env" as const, required: false, config_schema: { kind: "object" as const, additional: false as const, fields: [{ name: "region", type: text(100), optional: true }] }, replacement_for: "Notion speech recognition", document_projection: { document: "meeting", path: "transcript", id_prefix: "aws" }, workflow_input: { workflow: "update_notebook", path: "segments" } }],
    acceptance_scenarios: [{ id: "formula_60_to_80", name: "Notebook updates formula result", steps: [
      { kind: "set_document" as const, document: "workbook", path: "cells", value: { B2: 3, C2: 20 } },
      { kind: "invoke" as const, workflow: "update_notebook", input: { segments: [{ id: "seg-1", start_ms: 0, end_ms: 500, text: "Budget line" }], formula: "=B2*C2", markdown: "# Meeting\nBudget is **{{value}}**" }, expect_status: "succeeded" as const },
      { kind: "assert_document" as const, document: "meeting", path: "value", equals: 60 },
      { kind: "assert_document" as const, document: "meeting", path: "html", equals: '<h1>Meeting</h1>\n<p>Budget is <strong>60</strong></p>\n<ol class="transcript"><li>Budget line</li></ol>' },
      { kind: "restart" as const },
      { kind: "assert_document" as const, document: "meeting", path: "value", equals: 60 },
      { kind: "assert_document" as const, document: "workbook", path: "cells", equals: { B2: 3, C2: 20 } },
      { kind: "set_document" as const, document: "workbook", path: "cells", value: { B2: 4, C2: 20 } },
      { kind: "invoke" as const, workflow: "update_notebook", input: { segments: [{ id: "seg-1", start_ms: 0, end_ms: 500, text: "Budget line" }], formula: "=B2*C2", markdown: "# Meeting\nBudget is **{{value}}**" }, expect_status: "succeeded" as const },
      { kind: "assert_document" as const, document: "meeting", path: "value", equals: 80 },
      { kind: "assert_document" as const, document: "meeting", path: "html", equals: '<h1>Meeting</h1>\n<p>Budget is <strong>80</strong></p>\n<ol class="transcript"><li>Budget line</li></ol>' },
    ] }, {
      id: "formula_error",
      name: "Invalid formula fails with an explicit error",
      steps: [
        { kind: "set_document" as const, document: "workbook", path: "cells", value: { B2: 3 } },
        { kind: "invoke" as const, workflow: "update_notebook", input: { segments: [], formula: "=B2/0", markdown: "Error {{value}}" }, expect_status: "failed" as const },
      ],
    }, {
      id: "duplicate_transcript_event",
      name: "Duplicate transcript segment is inserted once",
      steps: [
        { kind: "set_document" as const, document: "workbook", path: "cells", value: { B2: 1, C2: 2 } },
        { kind: "invoke" as const, workflow: "update_notebook", input: { segments: [{ id: "seg-1", start_ms: 0, end_ms: 500, text: "One" }, { id: "seg-1", start_ms: 0, end_ms: 500, text: "One" }], formula: "=B2*C2", markdown: "Value {{value}}" }, expect_status: "succeeded" as const },
        { kind: "assert_document" as const, document: "meeting", path: "transcript", equals: [{ id: "seg-1", start_ms: 0, end_ms: 500, text: "One" }] },
      ],
    }],
    notes: ["All three packages are authored development fixtures, not recovered application behavior.", "The authored transcription package accepts supplied segments; optional AWS speech recognition runs in the host as an external provider."],
  };
}

export function jsonSafeDefinition(value: CapabilityDefinition): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
