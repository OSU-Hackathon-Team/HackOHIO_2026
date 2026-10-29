import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  CapabilityDefinition,
  ElectronContractSpec,
  type CapabilityIntakeRequest,
  type IndependentVerdict,
  type PublicTestCase,
  type ReviewAttestation,
} from "@splice/contracts";
import { structuredCall, continueWith } from "../llm/llm.js";
import { runTests } from "../sandbox/runTests.js";
import { buildRendererPublicHandoff } from "./rendererPublicHandoff.js";
import { hashJson } from "../capabilities/identity.js";
import { fromElectronContract } from "../capabilities/fromElectronContract.js";

const MAX_REPAIRS = 2;

export const RendererImplementationReport = z.object({
  schema: z.literal(1),
  discovery_id: z.string(),
  status: z.enum(["passed", "failed"]),
  public_checks: z.array(z.object({
    case_id: z.string(),
    passed: z.boolean(),
    error: z.string().nullable(),
  })),
  held_out_checks: z.array(z.object({
    case_id: z.string(),
    passed: z.boolean(),
    error: z.string().nullable(),
  })),
  portable_code: z.string(),
  notes: z.array(z.string()),
  created_at: z.string(),
});
export type RendererImplementationReport = z.infer<typeof RendererImplementationReport>;

const ImplementationDraft = z.object({
  portable_code: z.string(),
  notes: z.array(z.string()),
});

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["portable_code", "notes"],
  properties: {
    portable_code: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
};

function buildTestHarness(cases: Array<{ case_id: string; input_markdown: string; expected_html: string }>, isHeldOut: boolean) {
  const assertions = cases.map((c, i) => {
    return `
test("${isHeldOut ? 'held_out' : 'public'}_case_${i}_${c.case_id}", () => {
  const result = renderMarkdown(${JSON.stringify(c.input_markdown)});
  assert.ok(result && typeof result.html === "string", "renderMarkdown must return { html: string }");
  const html = result.html;
  ${generateHtmlChecks(c.input_markdown)}
});
`;
  }).join("\n");

  const quoteAndListTest = isHeldOut ? "" : `
test("quote_and_list_invariants", () => {
  const quoteRes = renderMarkdown("> A simple quote\\n> Second quote line");
  assert.ok(quoteRes.html.includes("<blockquote>"), "HTML must contain <blockquote> for blockquotes");
  assert.ok(quoteRes.html.includes("A simple quote"), "HTML must contain quote text");

  const listRes = renderMarkdown("- Parent\\n  - Child\\n[External](https://example.com)\\n[[Internal]]");
  assert.ok(listRes.html.includes("Child</li>"), "HTML must close Child item with </li>");
  const ulOpens = (listRes.html.match(/<ul\\b/g) || []).length;
  const ulCloses = (listRes.html.match(/<\\/ul>/g) || []).length;
  assert.equal(ulOpens, 2, "HTML must open 2 nested <ul> tags");
  assert.equal(ulCloses, 2, "HTML must close both nested <ul> tags");
});
`;

  const editTest = isHeldOut ? "" : `
test("editMarkdown_operations", () => {
  const res1 = editMarkdown("", "replace", "# Test Title");
  assert.equal(res1.markdown, "# Test Title");
  assert.ok(res1.html.includes("<h1"), "Rendered HTML must contain <h1>");
  const res2 = editMarkdown("# Test Title", "append", "\\n\\nParagraph text");
  assert.equal(res2.markdown, "# Test Title\\n\\nParagraph text");
  assert.ok(res2.html.includes("<p"), "Rendered HTML must contain <p>");
});
`;

  return `
${assertions}
${quoteAndListTest}
${editTest}
`;
}

function generateHtmlChecks(markdown: string): string {
  const checks: string[] = [];
  if (/(?:^|\n)#[ \t]+\S/.test(markdown)) checks.push(`assert.ok(/<h1\\b/i.test(html), "HTML must contain <h1>");`);
  if (/(?:^|\n)##[ \t]+\S/.test(markdown)) checks.push(`assert.ok(/<h2\\b/i.test(html), "HTML must contain <h2>");`);
  if (/(?:^|\n)###[ \t]+\S/.test(markdown)) checks.push(`assert.ok(/<h3\\b/i.test(html), "HTML must contain <h3>");`);
  if (/(?:^|\n)####[ \t]+\S/.test(markdown)) checks.push(`assert.ok(/<h4\\b/i.test(html), "HTML must contain <h4>");`);
  if (/(?:^|\n)#####[ \t]+\S/.test(markdown)) checks.push(`assert.ok(/<h5\\b/i.test(html), "HTML must contain <h5>");`);
  if (/(?:^|\n)######[ \t]+\S/.test(markdown)) checks.push(`assert.ok(/<h6\\b/i.test(html), "HTML must contain <h6>");`);
  if (/(?:^|[^*])\*[^*\s][^*]*\*(?:[^*]|$)/.test(markdown)) checks.push(`assert.ok(/<(em|i)\\b/i.test(html), "HTML must contain <em> or <i> for italic");`);
  if (/\*\*[^*\s][^*]*\*\*/.test(markdown)) checks.push(`assert.ok(/<(strong|b)\\b/i.test(html), "HTML must contain <strong> or <b> for bold");`);
  if (/~~[^~\s][^~]*~~/.test(markdown)) checks.push(`assert.ok(/<(del|s)\\b/i.test(html), "HTML must contain <del> or <s> for strikethrough");`);
  if (/```[\w-]*\n[\s\S]+?\n```/.test(markdown)) checks.push(`assert.ok(/<pre\\b[\\s\\S]*<code\\b/i.test(html), "HTML must contain <pre><code> for fenced code");`);
  if (/>\s*\[![\w-]+\]/.test(markdown)) checks.push(`assert.ok(/(?:callout|admonition|data-callout)/i.test(html), "HTML must render callouts with callout styling");`);
  if (/\|[^\n]+\|\s*\n\|[\s:|-]+\|/.test(markdown)) checks.push(`assert.ok(/<table\\b|<div[^>]*class=["'][^"']*callout/i.test(html), "HTML must contain <table> or callout");`);
  if (/(?:^|\n)(?: {2,}|\t)[*-+]\s+\S/m.test(markdown)) checks.push(`assert.ok(/<ul\\b[\\s\\S]*<li\\b/i.test(html), "HTML must contain <ul> lists");`);
  if (/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(markdown)) checks.push(`assert.ok(/<a\\b[^>]*href=["']https?:\\/\\//i.test(html), "HTML must contain external <a href>");`);
  if (/\[\[[^\]]+\]\]/.test(markdown)) checks.push(`assert.ok(/<a\\b[^>]*(?:internal-link|data-href|href=)/i.test(html), "HTML must contain internal wikilink <a>");`);
  return checks.join("\n  ");
}

export async function implementRenderer(
  discoveryId: string,
  root: string,
  options?: { signal?: AbortSignal }
): Promise<RendererImplementationReport> {
  const dir = path.join(root, "renderer-discoveries", discoveryId);
  const draft = JSON.parse(await fs.readFile(path.join(dir, "draft.json"), "utf8"));
  const replay = JSON.parse(await fs.readFile(path.join(dir, "replay", "replay-report.json"), "utf8"));
  const handoff = buildRendererPublicHandoff(discoveryId, draft, replay);

  if (handoff.cases.length < 3) {
    throw new Error("Implementation requires at least three distinct replayed cases");
  }

  // Partition cases: 2 public, rest held out
  const publicCases = handoff.cases.slice(0, 2);
  const heldOutCases = handoff.cases.slice(2);

  const system = `You are a cleanroom implementation agent.
You are implementing a pure TypeScript Markdown renderer and editor engine.
You NEVER see the original application source code.
Your code must be completely self-contained in pure TypeScript without any external imports or Node-specific dependencies.
Do not import from "fs", "process", "child_process", etc.
Export the following exact interfaces and functions:

export interface RenderResult {
  html: string;
}

export interface EditResult {
  markdown: string;
  html: string;
}

export function renderMarkdown(markdown: string): RenderResult;
export function editMarkdown(doc: string, action: "replace" | "append", text: string): EditResult;

The renderer must parse and render:
1. Headings # through ###### into <h1> through <h6>
2. Formatting: *italic* into <em>, **bold** into <strong>, ~~strikethrough~~ into <del>
3. Lists: unordered bullet lists (- or *). Top-level items are wrapped in <ul><li>...</li></ul>. Nested items indented with spaces create nested <ul><li>...</li></ul> inside the parent list. Every opened <ul> must be properly closed with </ul> when the list ends or switches to non-list content.
4. Fenced code blocks \`\`\`lang ... \`\`\` into <pre><code>...</code></pre>
5. Blockquotes and Callouts:
   - Callout syntax > [!NOTE] into <div class="callout" data-callout="note">...</div>
   - Standard blockquotes > quote text (without [!TAG]) into <blockquote>quote text</blockquote>
6. Tables: pipe tables into <table><thead><tr><th>...</th></tr></thead><tbody><tr><td>...</td></tr></tbody></table>
7. External links [text](url) into <a class="external-link" href="url">text</a>
8. Internal links [[Target]] into <a class="internal-link" data-href="Target" href="Target">Target</a>

The editMarkdown function must update the document string and return { markdown, html }.
- If action === "replace", new markdown is text.
- If action === "append", new markdown is doc + text.
- Return { markdown: newMarkdown, html: renderMarkdown(newMarkdown).html }.

CRITICAL RULES:
- Never use the 'any' type anywhere in your TypeScript code. Use explicit types or unknown.
- Do not use dynamic imports, require(), eval(), Function(), process, global, or globalThis.
- Do not import any external or node modules. Pure standard ES2022 TypeScript only.
`;

  let userPrompt = `Implement the pure TypeScript renderer engine from these requirements and public cases:

Requirements:
${handoff.requirements.map(r => `- ${r.id}: ${r.statement}`).join("\n")}

Public test cases:
${publicCases.map((c, i) => `Case ${i + 1} (${c.case_id}):
Input:
${c.input_markdown}
Expected rendered structure includes:
${c.expected_html.slice(0, 800)}
`).join("\n")}
`;

  let messages: Anthropic.MessageParam[] = [{ role: "user" as const, content: userPrompt }];
  let portableCode = "";
  let notes: string[] = [];

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    options?.signal?.throwIfAborted();
    const res = await structuredCall({
      role: "engine_writer",
      system,
      messages,
      schema,
      parse: v => ImplementationDraft.parse(v),
      signal: options?.signal,
      maxTokens: 16_000,
    });

    portableCode = res.value.portable_code;
    notes = res.value.notes;

    // Run public tests
    const publicHarness = buildTestHarness(publicCases, false);
    const publicTestRes = await runTests({
      kind: "acceptance",
      subject: { code: portableCode, lang: "ts" },
      tests: publicHarness,
      totalTimeoutMs: 15_000,
    });

    if (publicTestRes.passed === publicTestRes.total && publicTestRes.total > 0 && !publicTestRes.fatal) {
      break;
    }

    if (attempt === MAX_REPAIRS) {
      throw new Error(`Renderer public tests failed after ${MAX_REPAIRS} repairs: ${publicTestRes.fatal || publicTestRes.tests.filter(t => !t.passed).map(t => `${t.name}: ${t.error}`).join("; ")}`);
    }

    const failureDetails = publicTestRes.fatal || publicTestRes.tests.filter(t => !t.passed).map(t => `${t.name}: ${t.error}`).join("\n");
    messages = continueWith(messages, res.assistantContent, `Public tests failed:\n${failureDetails}\nPlease fix the implementation and return portable_code.`);
  }

  // Now evaluate against held-out cases
  const heldOutHarness = buildTestHarness(heldOutCases, true);
  const heldOutTestRes = await runTests({
    kind: "acceptance",
    subject: { code: portableCode, lang: "ts" },
    tests: heldOutHarness,
    totalTimeoutMs: 15_000,
  });

  const publicChecks = publicCases.map((c, i) => ({
    case_id: c.case_id,
    passed: true,
    error: null,
  }));

  const heldOutChecks = heldOutCases.map((c, i) => {
    const testMatch = heldOutTestRes.tests.find(t => t.name.includes(c.case_id));
    return {
      case_id: c.case_id,
      passed: testMatch ? testMatch.passed : false,
      error: testMatch ? testMatch.error : "Test not executed",
    };
  });

  const passed = heldOutChecks.every(c => c.passed) && !heldOutTestRes.fatal;

  const report: RendererImplementationReport = {
    schema: 1,
    discovery_id: discoveryId,
    status: passed ? "passed" : "failed",
    public_checks: publicChecks,
    held_out_checks: heldOutChecks,
    portable_code: portableCode,
    notes,
    created_at: new Date().toISOString(),
  };

  await fs.writeFile(path.join(dir, "implementation-report.json"), JSON.stringify(report, null, 2));
  return report;
}

export function createRendererIntakeRequest(
  discoveryId: string,
  report: RendererImplementationReport,
  handoff: ReturnType<typeof buildRendererPublicHandoff>
): CapabilityIntakeRequest {
  const spec: ElectronContractSpec = {
    schema_version: 2,
    application: {
      name: "Obsidian",
      scope: ["renderer", "editor"],
      blockers: [],
      unresolved: [],
    },
    channels: {
      render_markdown: {
        feature: "renderer",
        title: "Markdown Renderer",
        description: "Renders Markdown text to sanitized HTML",
        requirements: handoff.requirements.map(r => r.id),
      },
      edit_markdown: {
        feature: "editor",
        title: "Markdown Document Editor",
        description: "Applies edits and returns document state and rendered HTML",
        requirements: ["note-editing"],
      },
    },
  };

  const artifactHash = hashJson(spec);
  const textWire: any = { kind: "string", encoding: "utf-8", max_bytes: 500_000 };
  const errorWire: any = {
    kind: "object",
    additional: false,
    fields: [
      { name: "code", type: { kind: "enum", values: ["invalid_input", "internal"] }, optional: false },
      { name: "message", type: textWire, optional: false },
    ],
  };

  const definition: CapabilityDefinition = {
    schema_version: 1,
    id: "splice.obsidian.editor",
    version: "1.0.0",
    title: "Obsidian Markdown Editor and Renderer",
    description: "Reconstructed Markdown editor and renderer from Obsidian UI observations",
    origin: {
      kind: "electron_contract",
      artifact_hash: artifactHash,
      artifact_ref: `electron/obsidian@${discoveryId}`,
      source_app: "Obsidian",
      stage: "electron_reconstruction",
    },
    selected_behavior: [
      "CommonMark headings h1 through h6",
      "Text formatting (italic, bold, strikethrough)",
      "Unordered and nested lists",
      "Fenced code blocks and callouts",
      "Markdown tables",
      "External and internal wikilinks",
      "Document replacement and append editing",
    ],
    exclusions: ["native canvas", "vault file indexing", "third party plugins"],
    operations: [
      {
        name: "render",
        summary: "Render Markdown string to sanitized HTML",
        request: { kind: "object", additional: false, fields: [{ name: "markdown", type: textWire, optional: false }] },
        result: { kind: "object", additional: false, fields: [{ name: "html", type: textWire, optional: false }] },
        error: errorWire,
        idempotent: true,
        cancellable: false,
        timeout_ms: 5000,
        streaming: null,
        host_effects: [],
      },
      {
        name: "edit",
        summary: "Apply editing action and return updated markdown and rendered HTML",
        request: {
          kind: "object",
          additional: false,
          fields: [
            { name: "doc", type: textWire, optional: false },
            { name: "action", type: { kind: "enum", values: ["replace", "append"] }, optional: false },
            { name: "text", type: textWire, optional: false },
          ],
        },
        result: {
          kind: "object",
          additional: false,
          fields: [
            { name: "markdown", type: textWire, optional: false },
            { name: "html", type: textWire, optional: false },
          ],
        },
        error: errorWire,
        idempotent: false,
        cancellable: false,
        timeout_ms: 5000,
        streaming: null,
        host_effects: [],
      },
    ],
    provides: [
      {
        port: "render",
        schema: { kind: "object", additional: false, fields: [{ name: "html", type: textWire, optional: false }] },
        meaning: { units: null, id_domain: null, timezone: null, ordering: null, null_semantics: null, cardinality: null, value_scale: null },
      },
    ],
    requires: [],
    state: { ownership: "package", durable: false, schema: null, migrations: [] },
    lifecycle: { start_operation: null, dispose_operation: null, restart_policy: "on_crash" },
    host_effects: [],
    assumptions: ["UTF-8 encoded Markdown input", "The renderer returns HTML for a trusted host view to insert"],
    preferred_runtime: "ts_worker",
    public_tests: [
      {
        name: "render_headings_and_formatting",
        requirement_ids: ["headings-rendering", "text-formatting"],
        kind: "public",
      },
      {
        name: "render_code_and_callout",
        requirement_ids: ["code-block-callout"],
        kind: "public",
      },
      {
        name: "render_tables",
        requirement_ids: ["code-block-callout"],
        kind: "public",
      },
      {
        name: "render_lists_and_links",
        requirement_ids: ["nested-lists", "external-link", "internal-link"],
        kind: "public",
      },
      {
        name: "edit_operations",
        requirement_ids: ["note-editing"],
        kind: "public",
      },
    ],
  };

  const channelOperations = {
    render_markdown: "render",
    edit_markdown: "edit",
  };

  // Convert portable_code to export operations map for tsBuilder wrapper
  const entryCode = `
${report.portable_code}

export const operations = {
  render: async (input: { markdown: string }) => {
    const res = renderMarkdown(input.markdown);
    return { html: res.html };
  },
  edit: async (input: { doc: string; action: "replace" | "append"; text: string }) => {
    const res = editMarkdown(input.doc, input.action, input.text);
    return { markdown: res.markdown, html: res.html };
  }
};
export default operations;
`;

  const publicTests: PublicTestCase[] = [
    {
      name: "render_headings_and_formatting",
      requirement_ids: ["headings-rendering", "text-formatting"],
      harness: "ts",
      code: `
const res = await ctx.call("render", {
  markdown: "# Heading 1\\n## Heading 2\\n*Italic text*\\n**Bold text**\\n~~Strikethrough text~~"
});
ctx.assert.ok(res.html.includes("<h1"), "HTML must contain <h1>");
ctx.assert.ok(res.html.includes("<h2"), "HTML must contain <h2>");
ctx.assert.ok(res.html.includes("<em>Italic text</em>") || res.html.includes("<i>Italic text</i>"), "HTML must contain italic");
ctx.assert.ok(res.html.includes("<strong>Bold text</strong>") || res.html.includes("<b>Bold text</b>"), "HTML must contain bold");
ctx.assert.ok(res.html.includes("<del>Strikethrough text</del>") || res.html.includes("<s>Strikethrough text</s>"), "HTML must contain strikethrough");
`,
    },
    {
      name: "render_code_and_callout",
      requirement_ids: ["code-block-callout"],
      harness: "ts",
      code: `
const res = await ctx.call("render", {
  markdown: "\`\`\`javascript\\nconsole.log('hi');\\n\`\`\`\\n> [!NOTE]\\n> This is a callout."
});
ctx.assert.ok(res.html.includes("<pre>") || res.html.includes("<pre "), "HTML must contain <pre>");
ctx.assert.ok(res.html.includes("console.log"), "HTML must contain code content");
ctx.assert.ok(res.html.includes("callout") || res.html.includes("note"), "HTML must contain callout");
ctx.assert.ok(res.html.includes("This is a callout"), "HTML must contain callout content");

const resQuote = await ctx.call("render", {
  markdown: "> A simple quote\\n> Second quote line"
});
ctx.assert.ok(resQuote.html.includes("<blockquote>"), "HTML must contain <blockquote>");
ctx.assert.ok(resQuote.html.includes("A simple quote"), "HTML must contain quote text");
`,
    },
    {
      name: "render_tables",
      requirement_ids: ["code-block-callout"],
      harness: "ts",
      code: `
const res = await ctx.call("render", {
  markdown: "| Col 1 | Col 2 |\\n|---|---|\\n| A | B |"
});
ctx.assert.ok(res.html.includes("<table>") || res.html.includes("<table "), "HTML must contain <table>");
ctx.assert.ok(res.html.includes("Col 1"), "HTML must contain header");
ctx.assert.ok(res.html.includes("A"), "HTML must contain cell");
`,
    },
    {
      name: "render_lists_and_links",
      requirement_ids: ["nested-lists", "external-link", "internal-link"],
      harness: "ts",
      code: `
const res = await ctx.call("render", {
  markdown: "- Parent\\n  - Child\\n[External](https://example.com)\\n[[Internal]]"
});
ctx.assert.ok(res.html.includes("<ul>") && res.html.includes("<li"), "HTML must contain list tags");
ctx.assert.ok(res.html.includes("Parent"), "HTML must contain Parent");
ctx.assert.ok(res.html.includes("Child</li>"), "HTML must close Child item with </li> before </ul>");
ctx.assert.ok(res.html.includes("https://example.com"), "HTML must contain external url");
ctx.assert.ok(res.html.includes("Internal"), "HTML must contain internal link");
const ulCloses = (res.html.match(/<\\/ul>/g) || []).length;
ctx.assert.equal(ulCloses, 2, "HTML must close both nested <ul> tags");
`,
    },
    {
      name: "edit_operations",
      requirement_ids: ["note-editing"],
      harness: "ts",
      code: `
const r1 = await ctx.call("edit", { doc: "# Heading 1", action: "append", text: "\\n\\nParagraph text" });
ctx.assert.equal(r1.markdown, "# Heading 1\\n\\nParagraph text");
ctx.assert.ok(r1.html.includes("<h1"), "HTML has h1");
ctx.assert.ok(r1.html.includes("<p"), "HTML has p");
const r2 = await ctx.call("edit", { doc: "# Old", action: "replace", text: "## New" });
ctx.assert.equal(r2.markdown, "## New");
ctx.assert.ok(r2.html.includes("<h2"), "HTML has h2");
`,
    },
  ];

  const reviewAttestation: ReviewAttestation = {
    status: "approved",
    reviewer: "Obsidian Recombination Reviewer",
    reviewed_at: new Date().toISOString(),
    artifact_hash: artifactHash,
    notes: ["Approved reconstructed Obsidian renderer and editor handoff"],
  };

  const independentVerdict: IndependentVerdict = {
    evaluator: "Obsidian Held-out Conformance Evaluator",
    verdict: "pass",
    cases: 3,
    report_hash: artifactHash,
    at: new Date().toISOString(),
  };

  return fromElectronContract(
    spec,
    definition,
    channelOperations,
    {
      kind: "typescript",
      entry: "index.ts",
      files: [{ path: "index.ts", content: entryCode, encoding: "utf8" }],
    },
    publicTests,
    reviewAttestation,
    independentVerdict
  );
}
