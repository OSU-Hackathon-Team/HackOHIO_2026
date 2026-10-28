import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { captureRendererCase, rendererControlMetadata } from "./rendererCases.js";
import { rendererDraftProblems } from "./rendererDiscovery.js";
import { buildRendererPublicHandoff } from "./rendererPublicHandoff.js";

test("fixture browser case capture verifies exact input and records settled DOM without executable markup", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<textarea id="editor"></textarea><button id="read">Read</button><div id="output" hidden></div>
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
    assert.equal((await captureRendererCase(page, { ...input, input_method: "keyboard" })).rendered, "<h1>Recorded fixture text</h1>");
    assert.equal((await captureRendererCase(page, { ...input, markdown: "" })).rendered, "<h1></h1>");
    await page.locator("#editor").evaluate((node: any) => node.addEventListener("input", () => { node.value = "different"; }));
    await assert.rejects(captureRendererCase(page, input), /content differs/);
    await assert.rejects(captureRendererCase(page, { ...input, input_selector: "@1" }), /stable selectors/);
  } finally { await browser.close(); }
});

test("renderer drafts require distinct executed cases and the public projection uses only replayed case outputs", () => {
  const observations = [1, 2, 3].map(id => ({ id, action: { action: "capture_case", case_id: `case-${id}`, value: `input ${id}` },
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
