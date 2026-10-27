// Drive the authored notebook package through an installed app's remote DevTools endpoint.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const endpoint = process.argv[2];
const phase = process.argv[3];
if (!endpoint || !["initial", "restart"].includes(phase)) throw new Error("Usage: node scripts/testRecombinationLinuxVm.mjs <CDP URL> initial|restart");
const browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
try {
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 30_000 });
  await expect(page).toHaveTitle("Meeting notebook", { timeout: 30_000 });
  const native = async (a) => {
    const result = await page.evaluate((value) => window.splice.runWorkflow("native_multiply", { a: value, b: 20 }), a);
    assert.equal(result.status, "succeeded", JSON.stringify(result.errors));
    assert.equal(result.step_results.multiply.product, a * 20);
  };
  const workbook = () => page.evaluate(() => window.splice.getDocument("workbook"));
  const meeting = () => page.evaluate(() => window.splice.getDocument("meeting"));
  if (phase === "initial") {
    await native(3);
    await page.getByRole("button", { name: "Add cell" }).click();
    await page.getByRole("button", { name: "Add cell" }).click();
    await page.getByRole("textbox", { name: "Cell name" }).nth(0).fill("B2");
    await page.getByRole("textbox", { name: "Cell name" }).nth(1).fill("C2");
    await page.locator("table input[type=number]").nth(0).fill("3");
    await page.locator("table input[type=number]").nth(1).fill("20");
    await page.getByRole("button", { name: "Save confirmed cells" }).click();
    await expect.poll(async () => (await workbook()).data.cells, { timeout: 15_000 }).toEqual({ B2: 3, C2: 20 });
    const run = page.getByRole("button", { name: "Run workflow" }).first();
    await run.click();
    await expect.poll(async () => (await meeting()).data.value, { timeout: 15_000 }).toBe(60);
    await expect(run).toBeEnabled();
    await page.getByRole("spinbutton", { name: "Value for B2" }).fill("4");
    await page.getByRole("button", { name: "Save confirmed cells" }).click();
    await expect.poll(async () => (await workbook()).data.cells.B2, { timeout: 15_000 }).toBe(4);
    await run.click();
    await expect.poll(async () => (await meeting()).data.value, { timeout: 15_000 }).toBe(80);
    await expect(run).toBeEnabled();
    await native(4);
  } else {
    assert.deepEqual((await workbook()).data.cells, { B2: 4, C2: 20 });
    assert.equal((await meeting()).data.value, 80);
    assert.match((await meeting()).data.html, /<strong>80<\/strong>/);
    await native(4);
  }
  console.log(`Installed app ${phase} probe passed: native sidecar, workbook, formula and note`);
} finally {
  await browser.close();
}
