import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("showcase recipe supports direct cell edits, totals, undo and refresh", async ({ page }) => {
  await page.goto("/?mode=demo");
  await page.getByRole("button", { name: "Trip planner", exact: true }).click();
  await expect(page.getByText("$760.00")).toBeVisible();
  await page.locator(".obsidian-preview a.internal-link").click();
  await expect(page.locator(".obsidian-preview h1")).toHaveText("Budget");
  await page.getByLabel("Cell B3").fill("4");
  await page.getByLabel("Cell B3").press("Enter");
  await expect(page.getByText("$880.00")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("$760.00")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Trip planner" })).toBeVisible();
  await expect(page.getByText("$760.00")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toBe("trip-planner.json");
  const json = await readFile(await exported.path(), "utf8");
  expect(JSON.parse(json).tables[0].grid[2][1]).toBe(3);
  await page.getByLabel("Cell B3").fill("5");
  await page.getByLabel("Cell B3").press("Enter");
  await expect(page.getByText("$1000.00")).toBeVisible();
  await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({ name: "saved.json", mimeType: "application/json", buffer: Buffer.from(json) });
  await expect(page.getByRole("heading", { name: "Trip planner (imported)" })).toBeVisible();
  await expect(page.getByText("$760.00")).toBeVisible();
});

test("history separates recorded replay from checks run now", async ({ page }) => {
  await page.goto("/?mode=demo");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("These capabilities were reconstructed before the showcase.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Run engine checks" }).click();
  await expect(page.getByText("PASS · Obsidian renderer produced bold Markdown")).toBeVisible();
  await expect(page.getByText("PASS · Calc engine evaluated 3 × 120 = 360")).toBeVisible();
  await expect(page.getByText("PASS · Calc engine sorted the table")).toBeVisible();
  await page.getByRole("button", { name: "Replay recorded steps" }).first().click();
  await expect(page.getByText("Recorded timeline complete. These events are a replay of run 2.")).toBeVisible();
});

test("chat actions update the live app and can be undone as one turn", async ({ page }) => {
  await page.route("**/api/showcase/edits", async route => {
    const request = route.request().postDataJSON();
    expect(request.project.revision).toBe(0);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      outcome: "apply", message: "I will make a plan", model: "test-planner", actions: [
        { type: "project.rename", target: "", data: { title: "Trip planner" } },
        { type: "note.create", target: "", data: { title: "Itinerary", body: "# Itinerary" } },
        { type: "table.create", target: "", data: { title: "Budget", grid: [["Item", "Qty", "Price", "Total"], ["Flight", 1, 400, "=B2*C2"]] } },
        { type: "task.create", target: "", data: { title: "Pack bags" } },
      ],
    }) });
  });
  await page.goto("/?mode=demo");
  await page.getByLabel("Describe a change").fill("Make a trip planner");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trip planner" })).toBeVisible();
  await expect(page.getByText("$400.00")).toHaveCount(0); // No summary card was requested.
  await expect(page.getByLabel("Task title Pack bags")).toHaveValue("Pack bags");
  await expect(page.getByText("Done: renamed the app, created a note, created a table, created a task.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Done: renamed the app, created a note, created a table, created a task.")).toBeVisible();
  await page.getByTitle("New project").click();
  await page.getByLabel("Project").selectOption({ label: "Trip planner" });
  await expect(page.getByText("Done: renamed the app, created a note, created a table, created a task.")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Untitled app" })).toBeVisible();
  await expect(page.getByText("Your app starts here")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo this change" })).toHaveCount(0);
});

test("cancelled replies cannot change the app, and basic chat commands work offline", async ({ page }) => {
  await page.route("**/api/showcase/edits", async route => {
    await new Promise(resolve => setTimeout(resolve, 600));
    try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "apply", message: "late", model: "test", actions: [{ type: "project.rename", target: "", data: { title: "Wrong project" } }] }) }); } catch { /* Request was cancelled. */ }
  });
  await page.goto("/?mode=demo");
  await page.getByLabel("Describe a change").fill("Rename my project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.waitForTimeout(800);
  await expect(page.getByRole("heading", { name: "Untitled app" })).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  await page.route("**/api/showcase/edits", route => route.abort());
  await page.getByLabel("Describe a change").fill("Create a note called Travel");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Applied locally while Codex was unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Travel" })).toBeVisible();
});

test("model supplied Markdown cannot inject active HTML", async ({ page }) => {
  await page.route("**/api/showcase/edits", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "apply", message: "note", model: "test", actions: [
    { type: "note.create", target: "", data: { title: "Unsafe", body: '# Unsafe\n\n<img src=x onerror="window.__showcaseXss=1">\n\n[[Safe]]' } },
    { type: "note.create", target: "", data: { title: "Safe", body: "# Safe" } },
  ] }) }));
  await page.goto("/?mode=demo");
  await page.getByLabel("Describe a change").fill("Create two notes");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".obsidian-preview h1")).toHaveText("Unsafe");
  expect(await page.locator(".obsidian-preview img").count()).toBe(0);
  expect(await page.evaluate(() => (window as any).__showcaseXss)).toBeUndefined();
  await page.locator(".obsidian-preview a.internal-link").click();
  await expect(page.locator(".obsidian-preview h1")).toHaveText("Safe");
});

test("filters, task details, metrics, and chart bindings work in the app", async ({ page }) => {
  await page.goto("/?mode=demo");
  await page.getByRole("button", { name: "Event budget", exact: true }).click();
  await page.getByLabel("Filter Event costs").fill("Snacks");
  await expect(page.getByLabel("Cell A4")).toHaveValue("Snacks");
  await expect(page.getByLabel("Cell A2")).toHaveCount(0);
  await page.getByLabel("Filter Event costs").fill("");
  await page.getByLabel("Value for Costs by item").selectOption("2");
  await expect(page.getByText("0.5", { exact: true })).toBeVisible();
  await page.getByLabel("Source for Event total").selectOption("tasks");
  await expect(page.getByText("0%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("heading", { name: "Tasks", exact: true }).locator("..").locator("..").getByRole("button", { name: "Add to app" }).click();
  await page.getByLabel("New task", { exact: true }).fill("Send invites");
  await page.getByLabel("New task due date").fill("2026-11-10");
  await page.getByLabel("New task priority").selectOption("high");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByLabel("Priority Send invites")).toHaveValue("high");
  await page.getByLabel("Complete Send invites").check();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();
});
