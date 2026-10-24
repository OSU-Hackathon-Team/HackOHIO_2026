import { test, expect, type Page } from "@playwright/test";

async function harvest(page: Page) {
  await page.goto("/?mode=development");
  await page.getByRole("button", { name: "Wiki-link graph & backlinks", exact: true }).click();
  await page.getByRole("button", { name: "SM-2 spaced repetition", exact: true }).click();
  await page.getByRole("button", { name: "Harvest 2 features", exact: true }).click();
  await expect(page.getByText("Engine 3/3 · passed", { exact: true })).toHaveCount(2);
}

test("Studio labels, evidence keyboard behavior, cancellation and mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await harvest(page);
  await expect(page.getByText("Development demo", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Inspect evidence" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Tests", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Not run", exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Inspect evidence" }).first()).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/studio-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Harvest 2 features", exact: true }).click();
  await page.getByRole("button", { name: "Cancel work", exact: true }).click();
  await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
});

test("live mode surfaces backend 503 without switching into the development demo", async ({ page }) => {
  await page.route("**/api/health", route => route.fulfill({ json: { status: "ok" } }));
  await page.route("**/api/pantry", async route => {
    const { readFile } = await import("node:fs/promises");
    await route.fulfill({ contentType: "application/json", body: await readFile("targets/manifest.json", "utf8") });
  });
  await page.route("**/api/extract", route => route.fulfill({ status: 503, body: "Missing shared helpers" }));
  await page.goto("/");
  await page.getByRole("button", { name: "SM-2 spaced repetition", exact: true }).click();
  await page.getByRole("button", { name: "Harvest 1 feature", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("503");
  await expect(page.getByText("Development demo", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Live status unknown", { exact: true })).toBeVisible();
});

for (let run = 1; run <= 3; run++) test(`Sandpack boots and engine interaction survives code tab, run ${run}`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await harvest(page);
  await page.getByRole("button", { name: "Fuse 2 engines into an app", exact: true }).click();
  const preview = page.frameLocator('iframe[title="Sandpack Preview"]');
  await expect(preview.getByRole("heading", { name: "Study room", exact: true })).toBeVisible({ timeout: 65000 });
  await preview.getByRole("button", { name: "Review Cardiology · grade 4", exact: true }).click();
  await expect(preview.getByText("Next review:", { exact: false }).first()).toBeVisible();
  await preview.getByLabel("Note title", { exact: true }).fill("New case");
  await preview.getByLabel("Note text", { exact: true }).fill("See [[Cardiology]]");
  await preview.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(preview.getByRole("heading", { name: "New case", exact: true })).toBeVisible();
  await expect(preview.getByRole("article").filter({ has: preview.getByRole("heading", { name: "Cardiology", exact: true }) })).toContainText("New case");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByText("sm2Scheduler.ts", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(preview.getByRole("heading", { name: "New case", exact: true })).toBeVisible();
  if (run === 3) {
    await page.screenshot({ path: "test-results/studio-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(preview.getByRole("heading", { name: "New case", exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
