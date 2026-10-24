import { test, expect, type Page } from "@playwright/test";

async function sample(page: Page) {
  await page.goto("/"); await page.getByRole("button",{ name: "Try the study app" }).click();
}
async function build(page: Page) {
  await sample(page);
  await page.getByRole("region",{ name: "Recall Flashcards" }).getByRole("button",{ name: "Add to app", exact: true }).click();
  await page.getByRole("button",{ name: "Open app builder" }).click();
}
test("maker journey: inspect, select dependencies, edit, try engines and reopen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await sample(page);
  await expect(page.getByText("Sample results · not live analysis")).toBeVisible();
  await page.getByRole("button",{ name: "Inspect Cloud sync" }).click();
  await expect(page.getByRole("region",{ name: "Inspector" })).toContainText("Network and storage dependencies are unresolved");
  await expect(page.getByRole("region",{ name: "Inspector" }).getByRole("button",{ name: "Add to app" })).toHaveCount(0);
  await page.getByRole("region",{ name: "Recall Flashcards" }).getByRole("button",{ name: "Add to app", exact: true }).click();
  await page.getByRole("button",{ name: "Open app builder" }).click();
  await expect(page.getByRole("grid",{ name: "App layout",exact: true })).toBeVisible();
  await page.getByRole("button",{ name: "Edit section My notes", exact: true }).click();
  await page.getByLabel("Section title",{ exact: true }).fill("Learning journal");
  await page.getByRole("button",{ name: "Apply section changes" }).click();
  await expect(page.getByRole("heading",{ name: "Learning journal", exact: true })).toBeVisible();
  await page.getByRole("button",{ name: "Undo", exact: true }).click();
  await expect(page.getByRole("heading",{ name: "My notes", exact: true })).toBeVisible();
  await page.getByRole("button",{ name: "Redo", exact: true }).click();
  await page.getByRole("button",{ name: "Try app", exact: true }).click();
  await page.getByLabel("Note title",{ exact: true }).fill("New case");
  await page.getByLabel("Note text",{ exact: true }).fill("See [[Cardiology]]");
  await page.getByRole("button",{ name: "Add note", exact: true }).click();
  await expect(page.getByRole("heading",{ name: "New case",exact: true })).toBeVisible();
  await expect(page.getByRole("article",{ name: "Connected ideas" })).toContainText("New case");
  await page.getByRole("button",{ name: "Review Cardiology, grade 4",exact: true }).click();
  await expect(page.getByText("Next review:",{ exact: false }).first()).toBeVisible();
  await page.getByRole("button",{ name: "Edit layout",exact: true }).click();
  await page.getByRole("button",{ name: "Try app",exact: true }).click();
  await expect(page.getByRole("heading",{ name: "New case",exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/builder-desktop.png",fullPage: true });
  await page.reload();
  await page.getByRole("button",{ name: /My study space.*2 features/ }).click();
  await page.getByRole("button",{ name: "Try app",exact: true }).click();
  await expect(page.getByRole("heading",{ name: "New case",exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("mobile inspector keyboard, movement alternatives and no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390,height: 844 }); await build(page);
  const edit = page.getByRole("row",{ name: "My notes",exact: true });
  await edit.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog",{ name: "Inspector" }); await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(edit).toBeFocused();
  await page.keyboard.press("Enter"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button",{ name: "Move down" }).click();
  await expect(dialog).toBeVisible(); await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button",{ name: "Open feature library" }).click();
  await expect(page.getByRole("dialog",{ name: "Feature library" })).toBeVisible();
  await page.getByRole("button",{ name: "Add heading / text" }).click();
  await expect(page.getByRole("heading",{ name: "A little context",exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/builder-mobile.png",fullPage: true });
});
test("live assistant route: validated edits, cancellation and visible errors", async ({ page }) => {
  await page.setViewportSize({ width: 1440,height: 1000 }); await build(page);
  await page.route("**/api/builder/edits",async route => {
    const request = route.request().postDataJSON();
    if (request.instruction === "Fail") return route.fulfill({ status: 503,json: { error: "503 Qwen unavailable" } });
    if (request.instruction === "Malformed") return route.fulfill({ json: { revision: request.revision, summary: "bad",model: "test", operations: [{ type: "execute-code" }] } });
    if (request.instruction === "Wait") { await new Promise(resolve => setTimeout(resolve,500)); return route.fulfill({ json: { revision: request.revision,summary: "Late change",model: "test",operations: [] } }).catch(() => {}); }
    return route.fulfill({ json: { revision: request.revision,summary: "Added your introduction",model: "qwen-browser-test",operations: [{ type: "add",blockId: "welcome",index: 0,block: { id: "welcome",kind: "text",title: "Welcome to your study space",description: "A little every day.",visible: true,width: "full" } }] } });
  });
  async function ask(text: string) { await page.getByLabel("Ask the assistant").fill(text); await page.getByRole("button",{ name: "Send message",exact: true }).click(); }
  await ask("Add an introduction");
  await expect(page.getByRole("heading",{ name: "Welcome to your study space" })).toBeVisible();
  await expect(page.getByText("Added your introduction",{ exact: true })).toBeVisible();
  await ask("Fail"); await expect(page.getByRole("alert")).toContainText("503 Qwen unavailable");
  await expect(page.getByRole("heading",{ name: "Welcome to your study space" })).toBeVisible();
  await ask("Malformed"); await expect(page.getByRole("alert")).toBeVisible();
  await ask("Wait"); await page.getByRole("button",{ name: "Cancel",exact: true }).click();
  await expect(page.getByText("Qwen is preparing your edit…",{ exact: true })).toHaveCount(0);
  await page.waitForTimeout(700); await expect(page.getByText("Late change",{ exact: true })).toHaveCount(0);
});
test("attached files never produce fake analysis; storage failures remain visible", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({ name: "my-app.exe",mimeType: "application/octet-stream",buffer: Buffer.from("Not uploaded") });
  await page.getByLabel("Describe what you want to find").fill("Reuse search");
  await page.getByRole("button",{ name: "Create project",exact: true }).click();
  await expect(page.getByRole("heading",{ name: "Your application has not been analyzed" })).toBeVisible();
  await expect(page.getByText("Sample results · not live analysis",{ exact: true })).toHaveCount(0);
  await page.getByRole("button",{ name: "Explore sample analysis instead" }).click();
  await expect(page.getByText("Your attached files remain unanalyzed.",{ exact: false })).toBeVisible();
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("Quota","QuotaExceededError"); }; });
  await page.reload(); await page.getByRole("button",{ name: /Untitled project.*0 features/ }).click();
  await page.getByRole("region",{ name: "Recall Flashcards" }).getByRole("button",{ name: "Add to app",exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be saved");
});
