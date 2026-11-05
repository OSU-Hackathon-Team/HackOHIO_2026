import { test, expect } from "@playwright/test";

const revision = "11111111-1111-4111-8111-111111111111";
const candidate = `const bridge = parent.__spliceShowcaseBridge;
function render() { document.getElementById("value").textContent = "$" + bridge.total().toFixed(0); }
bridge.subscribe(render); render(); bridge.reportReady();`;

async function mockCandidate(page: import("@playwright/test").Page) {
  await page.route("**/api/showcase/code/revisions/*/index.html", route => route.fulfill({ contentType: "text/html", body: `<div id="value"></div><script src="app.js"></script>` }));
  await page.route("**/api/showcase/code/revisions/*/app.js", route => route.fulfill({ contentType: "text/javascript", body: candidate }));
  await page.route("**/api/showcase/code/revisions/*/source", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ revision, projectId: "test", parentRevision: null, summary: "Budget banner", files: ["App.tsx"], model: "test", createdAt: new Date().toISOString(), source: { "App.tsx": "export default function App() {}" }, parentSource: { "App.tsx": "export default function App() { return null; }" } }) }));
  await page.route("**/api/showcase/code/jobs", route => route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "test-job", status: "planning" }) }));
  await page.route("**/api/showcase/code/jobs/*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "test-job", projectId: "test", parentRevision: null, dataRevision: 0, status: "ready", revision, model: "test-writer", summary: "Added a budget banner", files: ["App.tsx"], repairs: 0 }) }));
}

test("feature chat activates code, keeps live table data, compares source, and reverts only code", async ({ page }) => {
  await mockCandidate(page);
  await page.goto("/?mode=demo");
  await page.getByRole("button", { name: "Trip planner", exact: true }).click();
  await page.getByLabel("Chat mode").selectOption("feature");
  await page.getByLabel("Describe a change").fill("Add a spending-limit banner");
  await page.getByRole("button", { name: "Send" }).click();
  const frame = page.frameLocator('iframe[title="Splice feature preview"]');
  await expect(frame.locator("#value")).toHaveText("$760");
  await page.getByLabel("Cell B3").fill("4");
  await page.getByLabel("Cell B3").press("Enter");
  await expect(frame.locator("#value")).toHaveText("$880");
  await page.getByRole("button", { name: "Compare code" }).click();
  await expect(page.getByText("Changed files: App.tsx")).toBeVisible();
  await page.reload();
  await expect(frame.locator("#value")).toHaveText("$880");
  await page.getByRole("button", { name: "Revert code change" }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByText("$880.00")).toBeVisible();
});

test("candidate is rechecked against a table edit made while code is generated", async ({ page }) => {
  await mockCandidate(page);
  let rechecked = false;
  await page.route("**/api/showcase/code/jobs/*", async route => { await new Promise(resolve => setTimeout(resolve, 1800)); await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "test-job", projectId: "test", parentRevision: null, dataRevision: 0, status: "ready", revision, model: "test-writer", summary: "Budget banner", files: ["App.tsx"], repairs: 0 }) }); });
  await page.route("**/api/showcase/code/revisions/*/validate", async route => { const body = route.request().postDataJSON(); expect(body.project.revision).toBe(1); expect(body.derived.total).toBe(880); rechecked = true; await route.fulfill({ contentType: "application/json", body: '{"valid":true}' }); });
  await page.goto("/?mode=demo");
  await page.getByRole("button", { name: "Trip planner", exact: true }).click();
  await page.getByLabel("Chat mode").selectOption("feature");
  await page.getByLabel("Describe a change").fill("Add a spending-limit banner");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByLabel("Cell B3").fill("4");
  await page.getByLabel("Cell B3").press("Enter");
  await expect(page.frameLocator("iframe").locator("#value")).toHaveText("$880");
  expect(rechecked).toBe(true);
});

test("Auto routes three mixed data, code, and data turns without losing the app", async ({ page }) => {
  await mockCandidate(page);
  await page.route("**/api/showcase/edits", async route => {
    const request = route.request().postDataJSON();
    const feature = /banner/i.test(request.prompt);
    const first = /taxi/i.test(request.prompt);
    const actions = feature ? [] : first ? [{ type: "table.addRow", target: "Trip budget", data: { row: ["Taxi", 1, 40, "=B4*C4"] } }] : [{ type: "table.cell", target: "Trip budget", data: { row: 2, col: 1, value: 4 } }];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ outcome: feature ? "unsupported" : "apply", message: feature ? "Needs a new UI feature" : "Done", actions, model: "test-planner" }) });
  });
  await page.goto("/?mode=demo");
  await page.getByRole("button", { name: "Trip planner", exact: true }).click();
  const input = page.getByLabel("Describe a change");
  await input.fill("Add a taxi costing $40"); await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("$800.00")).toBeVisible();
  await input.fill("Add a spending-limit banner"); await page.getByRole("button", { name: "Send" }).click();
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#value")).toHaveText("$800");
  await input.fill("Change hotel nights to four"); await page.getByRole("button", { name: "Send" }).click();
  await expect(frame.locator("#value")).toHaveText("$920");
  await expect(page.getByText("$920.00")).toBeVisible();
  await expect(page.getByLabel("Cell A4")).toHaveValue("Taxi");
});

test("Stop cancels a code job and a late result cannot activate", async ({ page }) => {
  await mockCandidate(page);
  let cancelled = false;
  await page.route("**/api/showcase/code/jobs/*", async route => {
    if (route.request().method() === "DELETE") { cancelled = true; await route.fulfill({ contentType: "application/json", body: '{"cancelled":true}' }); return; }
    await new Promise(resolve => setTimeout(resolve, 1600));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "test-job", projectId: "test", parentRevision: null, dataRevision: 0, status: "ready", revision, model: "test-writer", repairs: 0 }) }).catch(() => {});
  });
  await page.goto("/?mode=demo");
  await page.getByRole("button", { name: "Trip planner", exact: true }).click();
  await page.getByLabel("Chat mode").selectOption("feature");
  await page.getByLabel("Describe a change").fill("Add a spending-limit banner");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.waitForTimeout(1900);
  expect(cancelled).toBe(true);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByText("$760.00")).toBeVisible();
});
