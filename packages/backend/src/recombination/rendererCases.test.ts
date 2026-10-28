import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureRendererCase, observedRenderedDocuments, readCapturedDocument, RendererAgentCaseInput, rendererControlMetadata } from "./rendererCases.js";
import { rendererDraftProblems } from "./rendererDiscovery.js";
import { buildRendererPublicHandoff } from "./rendererPublicHandoff.js";

test("fixture browser case capture verifies exact input and records settled DOM without executable markup", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="preview"><p>Editor decoration</p><textarea id="editor"></textarea></div><button id="read">Read</button><div id="output" role="document" hidden></div>
      <script>document.querySelector('#read').onclick=()=>{const output=document.querySelector('#output');output.hidden=false;
      output.innerHTML='<h1 onclick="void 0" style="color:red"></h1><svg><path></path></svg><style>h1{color:red}</style>';
      output.querySelector('h1').textContent=document.querySelector('#editor').value;};</script>`);
    const input = { case_id: "fixture", markdown: "Recorded fixture text", input_selector: "#editor", render_selector: "#read", output_selector: "#output" };
    const metadata = await page.locator("#editor").evaluate(rendererControlMetadata);
    assert.equal(await page.locator(metadata.selector).count(), 1);
    assert.equal(metadata.editable, true);
    const captured = await captureRendererCase(page, input);
    assert.equal(captured.input_verified, true);
    assert.equal(captured.rendered, "<h1>Recorded fixture text</h1>");
    assert.equal((await captureRendererCase(page, { ...input, input_selector: "body" })).rendered, "<h1>Recorded fixture text</h1>");
    await page.locator("#output").evaluate((node: any) => {
      const title = node.ownerDocument.createElement("div"); title.contentEditable = "true"; title.textContent = "Inline title"; node.append(title);
      const inactive = node.ownerDocument.createElement("textarea"); inactive.hidden = true; node.append(inactive);
    });
    const roots = await observedRenderedDocuments(page);
    assert.equal(roots.length, 1);
    assert.equal(await page.locator(roots[0].selector).getAttribute("id"), "output");
    await assert.rejects(captureRendererCase(page, { ...input, input_selector: "body" }), /no unique editable descendant/);
    assert.equal((await captureRendererCase(page, { ...input, input_method: "keyboard" })).rendered, "<h1>Recorded fixture text</h1>");
    assert.equal((await captureRendererCase(page, { ...input, markdown: "" })).rendered, "<h1></h1>");
    await assert.rejects(captureRendererCase(page, { ...input, markdown: "" }, { readDocument: async () => {
      throw Object.assign(new Error("fixture not saved"), { code: "ENOENT" });
    } }), { code: "ENOENT" });
    await page.locator("#editor").evaluate((node: any) => node.addEventListener("input", () => { node.value = "different"; }));
    await assert.rejects(captureRendererCase(page, input), /content differs/);
    await assert.rejects(captureRendererCase(page, { ...input, input_selector: "@1" }), /stable selectors/);
  } finally { await browser.close(); }
});

test("fixture live preview can hide markers while saved-document verification preserves exact Markdown", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="editor" contenteditable="true"></div><button id="read">Read</button><div id="output" hidden></div>
      <script>window.savedDoc='';const editor=document.querySelector('#editor');
      editor.addEventListener('input',()=>{window.savedDoc=editor.innerText;editor.replaceChildren();
      const hidden=document.createElement('span');hidden.hidden=true;hidden.textContent=window.savedDoc.slice(0,2);
      editor.append(hidden,document.createTextNode(window.savedDoc.slice(2)));});
      document.querySelector('#read').onclick=()=>{const output=document.querySelector('#output');output.hidden=false;
      output.innerHTML='<h1></h1>';output.querySelector('h1').textContent=window.savedDoc.slice(2);};</script>`);
    const result = await captureRendererCase(page, { case_id: "fixture-hidden-syntax", markdown: "# Heading", input_selector: "#editor",
      render_selector: "#read", output_selector: "#output", document_path: "note.md" },
    { readDocument: () => page.evaluate(() => (globalThis as any).savedDoc) });
    assert.equal(await page.locator("#editor").innerText(), "Heading");
    assert.equal(result.input_verification, "saved_document");
    assert.equal(result.rendered, "<h1>Heading</h1>");
  } finally { await browser.close(); }
});

test("saved-document verification reads only fixture Markdown and rejects paths and symlinks escaping it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "renderer-document-"));
  try {
    const workspace = path.join(root, "fixture");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "note.md"), "# Exact Markdown\r\n");
    await fs.writeFile(path.join(root, "outside.md"), "outside fixture");
    await fs.symlink(path.join(root, "outside.md"), path.join(workspace, "link.md"));
    assert.equal(await readCapturedDocument(workspace, "note.md"), "# Exact Markdown\r\n");
    await assert.rejects(readCapturedDocument(workspace, "../outside.md"), /inside the fixture/);
    await assert.rejects(readCapturedDocument(workspace, "note.js"), /Markdown file/);
    await assert.rejects(readCapturedDocument(workspace, "link.md"), /outside the fixture/);
    await fs.writeFile(path.join(workspace, "invalid.md"), Buffer.from([255]));
    await assert.rejects(readCapturedDocument(workspace, "invalid.md"), /UTF-8/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("renderer drafts require distinct executed cases and the public projection uses only replayed case outputs", () => {
  const choice = { case_id: "fixture", markdown: "text", input_selector: "@1", render_selector: "@2", output_document: 0 };
  assert.equal(RendererAgentCaseInput.safeParse(choice).success, true);
  assert.equal(RendererAgentCaseInput.safeParse({ ...choice, output_document: ".r0" }).success, false);
  assert.equal(RendererAgentCaseInput.safeParse({ ...choice, output_document: 12 }).success, false);
  const observations = [1, 2, 3, 4].map(id => ({ id, action: { action: "capture_case", case_id: `case-${id}`, value: `input ${id}` },
    result: { input_verified: true, rendered: `<p>original ${id}</p>` } }));
  const draft = { summary: "Fixture draft", blockers: [], requirements: [{ id: "R1", statement: "The fixture input yields the recorded paragraph.", observation_ids: [1, 2, 3] }] };
  assert.deepEqual(rendererDraftProblems(draft, observations, { requireCases: true }), []);
  assert.ok(rendererDraftProblems(draft, observations.slice(0, 2), { requireCases: true }).some(p => /three distinct/.test(p)));
  const source = { schema: 1, status: "draft", task: "fixture", archive_sha256: "a".repeat(64), workspace_root: "/tmp/private-fixture", ...draft, observations };
  const replay = { schema: 1, kind: "renderer_replay", archive_sha256: "a".repeat(64), status: "passed", implementation_ready: false, limitations: [],
    checks: observations.map(o => ({ observation_id: o.id, status: o.id === 3 ? "not_compared" : "passed", fields: ["rendered"] })),
    requirement_coverage: [{ id: "R1", verified_observation_ids: [1, 2] }] };
  const handoff = buildRendererPublicHandoff("renderer-fixture", source, replay);
  assert.equal(handoff.cases.length, 2);
  assert.equal(handoff.cases[0].expected_html, "<p>original 1</p>");
  assert.equal(handoff.implementation_ready, false);
  assert.ok(!JSON.stringify(handoff).includes("input_selector"));
  source.observations[0].action.value = "/tmp/private-fixture/secret";
  assert.throws(() => buildRendererPublicHandoff("renderer-fixture", source, replay), /local paths/);
});
