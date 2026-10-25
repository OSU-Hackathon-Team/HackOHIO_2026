import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const fixture = (file: string) => JSON.parse(readFileSync(path.resolve(process.cwd(), file), "utf8"));
const nativeSpec = fixture("fixtures/specs/_seed/mockpriority.priority_score.json");
const nativeBlueprint = fixture("fixtures/blueprints/_seed/mockpriority.priority_score.json");
const defaultBundle = fixture("fixtures/bundles/_seed/study-room.json");
const sse = (...events: Array<{ type: string; [key: string]: unknown }>) =>
  events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
});
async function navigate(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name, exact: true })
    .click();
}

test("chat is the default page; library nests features under collapsed source applications", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "Chat", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByText("Quick Open Views", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("textbox", { name: "Message Splice" })
    .fill("Keep this draft");
  await navigate(page, "App library");
  const applications = page.getByRole("region", {
    name: "Source applications",
  });
  await expect(
    applications.getByRole("button", { name: /Connected Notes/ }),
  ).toHaveCount(0);
  const inkwell = applications.getByRole("button", { name: /Inkwell Notes/ });
  await inkwell.focus();
  await page.keyboard.press("Enter");
  await expect(inkwell).toHaveAttribute("aria-expanded", "true");
  await applications.getByRole("button", { name: /Connected Notes/ }).click();
  const details = page.getByRole("region", { name: "Feature details" });
  await expect(
    details.getByRole("heading", { name: /Connected Notes/ }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Added to my app", exact: true }),
  ).toBeDisabled();
  await applications.getByRole("button", { name: /Cloud/ }).click();
  await expect(details).toContainText("unavailable for reuse");
  await expect(
    details.getByRole("button", { name: "Add to my app", exact: true }),
  ).toHaveCount(0);
  await applications.getByRole("button", { name: /Connected Notes/ }).click();
  const titleBox = await page.getByRole("heading", { name: "App library", exact: true }).boundingBox();
  expect(titleBox?.y).toBeGreaterThanOrEqual(16);
  await page.screenshot({ path: "test-results/app-library-desktop.png" });
  await navigate(page, "Chat");
  await expect(
    page.getByRole("textbox", { name: "Message Splice" }),
  ).toHaveValue("Keep this draft");
  await page.screenshot({ path: "test-results/chat-desktop.png" });
  expect(errors).toEqual([]);
});

test("remove confirmation restores focus; adding a feature includes dependencies and app sections", async ({
  page,
}) => {
  await navigate(page, "App library");
  const apps = page.getByRole("region", { name: "Source applications" });
  await apps.getByRole("button", { name: /Inkwell Notes/ }).click();
  await apps.getByRole("button", { name: /Connected Notes/ }).click();
  const remove = page.getByRole("button", {
    name: "Remove from my app",
    exact: true,
  });
  await remove.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(remove).toBeFocused();
  await remove.click();
  await page
    .getByRole("button", { name: "Remove feature", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add to my app", exact: true }),
  ).toBeEnabled();
  await apps.getByRole("button", { name: /Recall Flashcards/ }).click();
  await apps.getByRole("button", { name: /Smart Flashcard/ }).click();
  await page
    .getByRole("button", { name: "Add to my app", exact: true })
    .click();
  await expect(
    apps.getByRole("button", { name: /Connected Notes/ }),
  ).toContainText("Added to my app");
  await page.getByRole("button", { name: "Open my app", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "My Study Notes", exact: true }),
  ).toBeVisible();
  await navigate(page, "Chat");
  await expect(
    page.getByRole("textbox", { name: "Message Splice" }),
  ).toBeVisible();
});

test("assistant stays in chat on success and failure, cancels safely, and preserves app state", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/builder/edits", async (route) => {
    const request = route.request().postDataJSON();
    if (request.instruction === "Fail")
      return route.fulfill({
        status: 503,
        json: { error: "503 Qwen unavailable" },
      });
    if (request.instruction === "Wait") {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return route
        .fulfill({
          json: {
            revision: request.revision,
            model: "test",
            summary: "Late response",
            operations: [],
          },
        })
        .catch(() => {});
    }
    await route.fulfill({
      json: {
        revision: request.revision,
        model: "qwen-test",
        summary: "Added your introduction",
        operations: [
          {
            type: "add",
            blockId: "welcome",
            index: 0,
            block: {
              id: "welcome",
              kind: "text",
              title: "Welcome home",
              description: "A little study every day.",
              visible: true,
              width: "full",
            },
          },
        ],
      },
    });
  });
  async function ask(text: string) {
    await page.getByRole("textbox", { name: "Message Splice" }).fill(text);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
  }
  await ask("Add an introduction");
  await expect(
    page.getByText("Added your introduction", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Chat", exact: true }),
  ).toBeVisible();
  await ask("Fail");
  await expect(page.getByRole("alert")).toContainText("503 Qwen unavailable");
  await expect(page.getByRole("alert")).toContainText(
    "Your app was not changed",
  );
  await ask("Wait");
  await page
    .getByRole("button", { name: "Cancel request", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByText("Late response", { exact: true })).toHaveCount(0);
  await navigate(page, "My app");
  await expect(
    page.getByRole("heading", { name: "Welcome home", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Undo layout change", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome home", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Redo layout change", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome home", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("native target uses backend adapter and implementation results in the pipeline preview", async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: Array<{ path: string; body: any }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/health", route => route.fulfill({ json: {
    ok: true,
    rea: { connected: false, version: null, tool_count: 0 },
    rea_mode: "replay",
    llm_mode: "replay",
    model: "test",
    models: {},
  } }));
  await page.route("**/api/native-specs/adapt", async route => {
    const body = route.request().postDataJSON();
    requests.push({ path: "/api/native-specs/adapt", body });
    await route.fulfill({ json: { spec: nativeSpec, feature_spec: nativeSpec } });
  });
  await page.route("**/api/implement", async route => {
    const body = route.request().postDataJSON();
    requests.push({ path: "/api/implement", body });
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: sse(
        { type: "blueprint", run_id: "native-test", feature_id: nativeBlueprint.feature_id, ts: 1, blueprint: nativeBlueprint },
        { type: "done", run_id: "native-test", feature_id: nativeBlueprint.feature_id, ts: 2, ok: true, replayed: false },
      ),
    });
  });
  await page.route("**/api/synthesize", async route => {
    const body = route.request().postDataJSON();
    requests.push({ path: "/api/synthesize", body });
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: sse(
        { type: "bundle", run_id: "native-synth", ts: 3, bundle: defaultBundle },
        { type: "done", run_id: "native-synth", ts: 4, ok: true },
      ),
    });
  });

  await navigate(page, "App library");
  const applications = page.getByRole("region", {
    name: "Source applications",
  });

  const mockPriority = applications.getByRole("button", { name: /Mock Task Board/ });
  await expect(applications).toBeVisible();
  await expect(mockPriority).toBeVisible();
  await expect(mockPriority).toContainText("Native ELF");
  await mockPriority.click();

  const featureBtn = applications.getByRole("button", { name: /Task Priority Scoring/ });
  await expect(featureBtn).toBeVisible();
  await featureBtn.click();

  const details = page.getByRole("region", { name: "Feature details" });
  await expect(details.getByRole("heading", { name: /Task Priority Scoring/ })).toBeVisible();
  await expect(details).toContainText("Native Specification View");
  await expect(details).toContainText("004012a0");

  const reconstructBtn = details.getByRole("button", { name: "Reconstruct Engine", exact: true });
  await expect(reconstructBtn).toBeVisible();
  await reconstructBtn.click();

  await expect(details.getByText("Engine Reconstructed")).toBeVisible({ timeout: 10000 });
  await expect(details.getByRole("button", { name: "Reconstruct Again", exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Preview in Sandbox", exact: true })).toBeVisible();

  // Verify transition from native spec reconstruction to sandbox pipeline bench
  await details.getByRole("button", { name: "Preview in Sandbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pipeline test" })).toBeVisible();

  // Select Native spec source in Pipeline test bench
  const nativeRadio = page.getByRole("radio", { name: /Native · Task Priority/ });
  await expect(nativeRadio).toBeVisible();
  await nativeRadio.click();
  await expect(page.getByText("Native engine implementation verified · ready to fuse into a Studio preview.")).toBeVisible();
  await expect(page.getByText(nativeSpec.consumer_title)).toBeVisible();
  await expect(page.getByText("Task priority scoring (mock decompilation)")).toBeVisible();

  const fuse = page.getByRole("button", { name: /Fuse 1 verified engine/ });
  await expect(fuse).toBeEnabled();
  await fuse.click();
  await expect(page.getByRole("heading", { name: defaultBundle.app_title })).toBeVisible();
  expect(requests.map(request => request.path)).toEqual([
    "/api/native-specs/adapt",
    "/api/implement",
    "/api/synthesize",
  ]);
  expect(requests[0].body).toMatchObject({
    spec: { kind: "native_subsystem_spec" },
    feature_id: nativeSpec.feature_id,
  });
  expect(requests[1].body.spec.feature_id).toBe(nativeSpec.feature_id);
  expect(requests[2].body.blueprints.map((bp: any) => bp.feature_id)).toEqual([nativeBlueprint.feature_id]);

  expect(errors).toEqual([]);
});
