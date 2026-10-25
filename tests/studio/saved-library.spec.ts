import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/library/features", route => route.fulfill({ json: { features: [] } }));
});

const result = { readiness: "partial", spec_artifact: null, spec_status: null, spec_writer: null,
  spec_error: "spec contains source-like text", claim_outcomes: { supported_static: 1 },
  functions: { included: 1, drafted: 1, reviewed: 1 }, oracle: { public_agreement: 1, held_out_agreement: 1 },
  handoff_path: "docs/handoff", tokens: { input: 2, output: 1 } };
const summary = { id: "run-library-test", target_id: "libreoffice-calc", title: "Saved Calc analysis",
  created_at: 1792906021013, binary_sha256: "b".repeat(64), result };
const analysis = { ...summary, schema: 1, spec: null,
  functions: [{ entry: "00100000", name: "ExampleFunction", draft_state: "unreviewed", review_state: "reviewed",
    decompilation: "int example() { return 1; }", unknowns: ["Caller contract unresolved"],
    claims: [{ statement: "Returns one", review: { outcome: "supported_static", reason: "constant return" } }] }],
  observed_cases: [{ id: "public", formula: "=1", observed: 1 }], held_out_cases: ["SECRET_HELD_OUT"] };

test("saved evidence survives reload and exposes functions without offering partial engines for reuse", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/api/library", route => route.fulfill({ json: { enabled: true, analyses: [summary], blocks: [] } }));
  await page.route("**/api/library/analyses/*", route => route.fulfill({ json: analysis }));
  await page.route("**/api/library/analyses/*/extractions", route => route.fulfill({ json: { extractions: [] } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "App library", exact: true }).click();
  const saved = page.getByRole("region", { name: "Saved native library" });
  await saved.getByRole("button", { name: /Saved Calc analysis/ }).click();
  await saved.getByRole("button", { name: "Inspect saved evidence" }).click();
  const dialog = page.getByRole("dialog", { name: "Saved decompilation evidence" });
  await expect(dialog).toContainText("Specification unavailable");
  await dialog.getByRole("button", { name: "ExampleFunction" }).click();
  await expect(dialog).toContainText("int example() { return 1; }");
  await expect(dialog).toContainText("Caller contract unresolved");
  await expect(dialog.getByRole("button", { name: "Use in app builder" })).toHaveCount(0);
  await expect(page.getByText("SECRET_HELD_OUT")).toHaveCount(0);
  await page.screenshot({ path: "test-results/saved-analysis-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(saved.getByRole("button", { name: "Inspect saved evidence" })).toBeFocused();
  await page.reload();
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "App library", exact: true }).click();
  await expect(saved.getByRole("button", { name: /Saved Calc analysis/ })).toBeVisible();
});

const extracted = { schema: 1, id: "e".repeat(64), analysis_id: summary.id, analysis_sha256: "a".repeat(64),
  created_at: 1792906021014, model: "test-writer", intent: "Describe constant numeric results",
  spec: { schema: 2, kind: "native_subsystem_spec", status: "draft", title: "Numeric result behavior",
    purpose: "Produce a fixed numeric result.", boundary: "subsystem",
    interface: { inputs: ["A request."], outputs: ["The number one."], state: [] },
    requirements: [{ id: "REQ-1", statement: "Always produce the number one." }],
    behavior_steps: ["Produce one."], examples: [], acceptance_criteria: ["Result is one."], deviations: [], exclusions: [] },
  claim_sources: [{ id: "C1_1", function_entry: "00100000", claim_index: 0, statement: "Returns one", review_reason: "constant return" }],
  requirement_sources: [{ requirement_id: "REQ-1", claim_ids: ["C1_1"] }], omitted_claims: [],
  limitations: ["Claim-to-original-case links have not been established."] };
const sse = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

async function openSavedAnalysis(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "App library", exact: true }).click();
  await page.getByRole("region", { name: "Saved native library" }).getByRole("button", { name: /Saved Calc analysis/ }).click();
  await page.getByRole("region", { name: "Saved native library" }).getByRole("button", { name: "Create building blocks" }).click();
  return page.getByRole("region", { name: "Extract features from saved evidence" });
}

test("extraction requires explicit approval, saves a draft and reloads its requirements without new model work", async ({ page }) => {
  let saved: unknown[] = [], calls = 0;
  await page.route("**/api/library", route => route.fulfill({ json: { enabled: true, analyses: [summary], blocks: [] } }));
  await page.route("**/api/library/analyses/*", route => route.fulfill({ json: analysis }));
  await page.route("**/api/library/analyses/*/extractions", route => route.fulfill({ json: { extractions: saved } }));
  await page.route("**/api/library/analyses/*/extract", route => {
    calls++;
    const request = route.request().postDataJSON();
    expect(request.confirm_cost).toBe(true);
    expect(request.function_entries).toEqual(["00100000"]);
    expect(request.intent).toBe("Describe constant numeric results");
    saved = [extracted];
    return route.fulfill({ contentType: "text/event-stream", body: sse([
      { type: "stage", message: "Writing draft" }, { type: "progress", output_chars: 80 },
      { type: "extraction", extraction: extracted }, { type: "done", ok: true }]) });
  });
  let panel = await openSavedAnalysis(page);
  const button = panel.getByRole("button", { name: "Extract draft features" });
  await expect(button).toBeDisabled();
  await panel.getByRole("textbox", { name: "What should this building block do?" }).fill("Describe constant numeric results");
  await panel.getByLabel("Extraction scope").selectOption("00100000");
  await panel.getByText("I approve paid model calls for this extraction (up to three attempts).", { exact: true }).click(); await button.click();
  await expect(panel).toContainText("Numeric result behavior");
  await expect(panel).toContainText("Supporting facts: C1_1");
  await panel.getByRole("button", { name: "Inspect supporting facts for REQ-1" }).click();
  await expect(panel).toContainText("Static review: constant return");
  await expect(panel).toContainText("Draft · implementation blocked");
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Use in app builder" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/extraction-draft-desktop.png" });
  await page.reload(); panel = await openSavedAnalysis(page);
  await expect(panel).toContainText("Always produce the number one.");
  expect(calls).toBe(1);
});

test("candidate descriptions become nested App library entries and remain review-only after reload", async ({ page }) => {
  let features: unknown[] = [], writes = 0;
  const second = { ...extracted, id: "f".repeat(64), spec: { ...extracted.spec,
    title: "Comparison behavior", purpose: "Compare two numeric results." } };
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route("**/api/library", route => route.fulfill({ json: { enabled: true, analyses: [summary], blocks: [] } }));
  await page.route("**/api/library/analyses/*", route => route.fulfill({ json: analysis }));
  await page.route("**/api/library/analyses/*/extractions", route => route.fulfill({ json: { extractions: [extracted, second] } }));
  await page.route("**/api/library/features", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { features } });
    writes++;
    expect(route.request().postDataJSON()).toEqual({ analysis_id: summary.id, extraction_id: second.id });
    features = [second];
    return route.fulfill({ json: { feature: second } });
  });
  let panel = await openSavedAnalysis(page);
  const card = panel.getByRole("article", { name: "Candidate: Comparison behavior" });
  await expect(card).toContainText("Compare two numeric results.");
  await card.getByRole("button", { name: "View details" }).click();
  const details = panel.getByRole("article", { name: "Building block details" });
  await expect(details).toContainText("Comparison behavior");
  await expect(details).toContainText("Inputs");
  await expect(details).toContainText("Outputs");
  await card.getByRole("button", { name: "Add to App library" }).click();
  await expect(card.getByRole("button", { name: "Added to App library" })).toBeDisabled();
  const library = page.getByRole("region", { name: "Saved native library" });
  await expect(library.getByRole("button", { name: /Comparison behavior/ })).toBeVisible();
  await expect(details).toContainText("Draft · implementation blocked");
  await page.screenshot({ path: "test-results/building-block-library-desktop.png" });
  await page.reload();
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "App library", exact: true }).click();
  await library.getByRole("button", { name: /Saved Calc analysis/ }).click();
  await library.getByRole("button", { name: /Comparison behavior/ }).click();
  panel = page.getByRole("region", { name: "Extract features from saved evidence" });
  await expect(panel.getByRole("article", { name: "Building block details" })).toContainText("Comparison behavior");
  await expect(panel.getByRole("button", { name: "Use in app builder" })).toHaveCount(0);
  expect(writes).toBe(1);
});

test("a failed building-block save stays retryable and cannot claim library membership", async ({ page }) => {
  let failed = true;
  await page.route("**/api/library", route => route.fulfill({ json: { enabled: true, analyses: [summary], blocks: [] } }));
  await page.route("**/api/library/analyses/*", route => route.fulfill({ json: analysis }));
  await page.route("**/api/library/analyses/*/extractions", route => route.fulfill({ json: { extractions: [extracted] } }));
  await page.route("**/api/library/features", route => route.request().method() === "GET"
    ? route.fulfill({ json: { features: failed ? [] : [extracted] } })
    : failed ? route.fulfill({ status: 503, json: { error: "S3 write denied" } }) : route.fulfill({ json: { feature: extracted } }));
  const panel = await openSavedAnalysis(page);
  const card = panel.getByRole("article", { name: "Candidate: Numeric result behavior" });
  await card.getByRole("button", { name: "Add to App library" }).click();
  await expect(card.getByRole("alert")).toContainText("S3 write denied");
  await expect(card.getByRole("button", { name: "Add to App library" })).toBeEnabled();
  failed = false;
  await card.getByRole("button", { name: "Add to App library" }).click();
  await expect(card.getByRole("button", { name: "Added to App library" })).toBeDisabled();
});

test("failed and incomplete extraction streams never display a successful draft", async ({ page }) => {
  let incomplete = false;
  await page.route("**/api/library", route => route.fulfill({ json: { enabled: true, analyses: [summary], blocks: [] } }));
  await page.route("**/api/library/analyses/*", route => route.fulfill({ json: analysis }));
  await page.route("**/api/library/analyses/*/extractions", route => route.fulfill({ json: { extractions: [] } }));
  await page.route("**/api/library/analyses/*/extract", route => route.fulfill({ contentType: "text/event-stream",
    body: incomplete ? sse([{ type: "extraction", extraction: extracted }])
      : sse([{ type: "error", message: "Model output failed validation" }, { type: "done", ok: false }]) }));
  const panel = await openSavedAnalysis(page);
  await panel.getByText("I approve paid model calls for this extraction (up to three attempts).", { exact: true }).click();
  await panel.getByRole("button", { name: "Extract draft features" }).click();
  await expect(panel.getByRole("alert")).toContainText("Model output failed validation");
  incomplete = true;
  await panel.getByText("I approve paid model calls for this extraction (up to three attempts).", { exact: true }).click();
  await panel.getByRole("button", { name: "Extract draft features" }).click();
  await expect(panel.getByRole("alert")).toContainText("stream ended before done");
  await expect(panel.getByText("Numeric result behavior")).toHaveCount(0);
});

test("S3 errors stay visible and Refresh can recover", async ({ page }) => {
  let failed = true;
  await page.route("**/api/library", route => failed
    ? route.fulfill({ status: 503, json: { error: "AccessDenied" } })
    : route.fulfill({ json: { enabled: true, analyses: [], blocks: [] } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "App library", exact: true }).click();
  const saved = page.getByRole("region", { name: "Saved native library" });
  await expect(saved.getByRole("alert")).toContainText("AccessDenied");
  failed = false;
  await saved.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(saved).toContainText("No saved results yet");
});
