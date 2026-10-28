import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import * as asar from "@electron/asar";
import { _electron, chromium, type Browser, type Page, type ElectronApplication } from "playwright";
import { z } from "zod";
import { structuredCall, type AssistTool } from "../llm/llm.js";

const Answer = z.object({
  summary: z.string(), requirements: z.array(z.object({ id: z.string(), statement: z.string(), observation_ids: z.array(z.number().int()) })),
  blockers: z.array(z.string()),
});
const execFileAsync = promisify(execFile);
const schema = { type: "object", additionalProperties: false, required: ["summary", "requirements", "blockers"], properties: {
  summary: { type: "string" }, requirements: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["id", "statement", "observation_ids"], properties: { id: { type: "string" }, statement: { type: "string" }, observation_ids: { type: "array", items: { type: "integer" } } } } },
  blockers: { type: "array", items: { type: "string" } },
} };

/** Observe renderer behavior through UI actions only. No source-reading tool reaches the model. */
export async function discoverRenderer(options: { archive: string; directory: string; task: string; signal: AbortSignal;
  resources?: Array<{ archive: string; name: string }>; entryResource?: string;
  emit: (event: { type: string; [key: string]: unknown }) => void }) {
  const { archive, directory, task, signal, emit } = options;
  await fs.mkdir(directory, { recursive: true });
  const original = path.join(directory, "private-original");
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(original); await fs.mkdir(workspace);
  asar.extractAll(archive, original);
  const files = asar.listPackage(archive, { isPack: false }).map(value => value.replace(/^[/\\]+/, ""));
  let entryRoot = original;
  let entryFiles = files;
  let resourceRoot: string | null = null;
  if (options.resources?.length) {
    resourceRoot = path.join(original, "resources"); await fs.mkdir(resourceRoot);
    for (const item of options.resources) {
      if (!/^[a-zA-Z0-9_.-]+\.asar$/.test(item.name)) throw new Error("Resource archives need a basename ending in .asar");
      await fs.copyFile(item.archive, path.join(resourceRoot, item.name));
    }
    if (!options.entryResource || !options.resources.some(item => item.name === options.entryResource)) throw new Error("Select an entry resource from the uploaded archives");
    entryRoot = path.join(resourceRoot, options.entryResource);
    entryFiles = asar.listPackage(entryRoot, { isPack: false }).map(value => value.replace(/^[/\\]+/, ""));
  }
  const pkg = JSON.parse(resourceRoot ? asar.extractFile(entryRoot, "package.json").toString("utf8") : await fs.readFile(path.join(original, "package.json"), "utf8"));
  const entry = [pkg.main, "main.js", "index.js", "main.cjs", "index.cjs"].find(value => typeof value === "string" && entryFiles.includes(value));
  if (!entry) throw new Error("No conventional main entry exists in the archive");
  const launcher = path.join(directory, "launcher.cjs");
  await fs.writeFile(launcher, `const {app}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(workspace, "userData"))});
app.setPath('documents',${JSON.stringify(workspace)});
${resourceRoot ? `Object.defineProperty(process,'resourcesPath',{value:${JSON.stringify(resourceRoot)}});app.setAppPath(${JSON.stringify(entryRoot)});` : ""}
const entry=require(${JSON.stringify(path.join(entryRoot, entry))});
if(typeof entry==='function') entry(${JSON.stringify(original)},new (require('node:events').EventEmitter)());
`);
  emit({ type: "stage", message: "Launching original renderer in an isolated workspace" });
  const display = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
  let electron: ElectronApplication | undefined;
  let browser: Browser | undefined;
  let originalProcess: ChildProcess | undefined;
  const stop = () => { display.kill("SIGTERM"); originalProcess?.kill("SIGTERM"); void browser?.close().catch(() => {}); void electron?.close().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const displayNumber = await Promise.race([
      once(display.stdio[3]!, "data").then(([value]) => String(value).trim()),
      once(display, "error").then(([error]) => { throw error; }),
      new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Xvfb did not start")), 10_000); timer.unref(); }),
    ]);
    signal.throwIfAborted();
    const installed = process.env.SPLICE_RENDERER_ORIGINAL_EXECUTABLE;
    if (installed) {
      const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      const expected = digest(await fs.readFile(archive));
      const resources = path.join(path.dirname(installed), "resources");
      let matches = false;
      for (const name of (await fs.readdir(resources)).filter(name => name.endsWith(".asar"))) {
        if (digest(await fs.readFile(path.join(resources, name))) === expected) matches = true;
      }
      if (!matches) throw new Error("Configured original executable does not contain the uploaded archive identity");
    }
    const environment = { ...process.env, DISPLAY: `:${displayNumber}`, XDG_CONFIG_HOME: path.join(workspace, "config") };
    let page: Page;
    if (installed) {
      originalProcess = spawn(installed, ["--remote-debugging-port=0", `--user-data-dir=${path.join(workspace, "userData")}`],
        { env: environment, stdio: ["ignore", "pipe", "pipe"] });
      const endpoint = await new Promise<string>((resolve, reject) => {
        let diagnostic = "";
        const timer = setTimeout(() => reject(new Error(`Original renderer did not expose a debugging endpoint: ${diagnostic}`)), 45_000);
        originalProcess!.once("error", error => { clearTimeout(timer); reject(error); });
        originalProcess!.once("exit", code => { clearTimeout(timer); reject(new Error(`Original exited ${code}: ${diagnostic}`)); });
        originalProcess!.stderr!.on("data", value => {
          diagnostic = (diagnostic + String(value)).slice(-8000);
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(diagnostic);
          if (match) { clearTimeout(timer); resolve(match[1]); }
        });
      });
      browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
      const context = browser.contexts()[0];
      page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 30_000 });
      await page.waitForLoadState("domcontentloaded");
    } else {
      electron = await _electron.launch({ args: [launcher], executablePath: process.env.SPLICE_RENDERER_ELECTRON,
        env: environment, timeout: 45_000 });
      page = await electron.firstWindow({ timeout: 45_000 });
    }
    signal.throwIfAborted();
    page.on("console", message => emit({ type: "diagnostic", message: message.text().slice(0, 2000) }));
    page.setDefaultTimeout(8_000);
    const observations: Array<{ id: number; action: unknown; result: unknown }> = [];
    const windows = () => browser ? browser.contexts().flatMap(context => context.pages()) : electron!.windows();
    const readSnapshot = async () => ({ title: await page.title(), windows: await Promise.all(windows().map(async (window, index) => ({ index, title: await window.title() }))),
      text: (await page.locator("body").innerText()).slice(0, 8000),
      rendered: (await page.locator("h1,h2,h3,h4,h5,h6,p,blockquote,pre,code,a,table,li").evaluateAll((nodes: any[]) => nodes.slice(0, 60).map(n => n.outerHTML.slice(0, 600)).join("\n"))).slice(0, 6000),
      controls: await page.locator("input,textarea,button,[contenteditable=true],[role=button],[class*=button]").evaluateAll((nodes: any[]) => nodes.slice(0, 60).map(n => ({
        tag: n.tagName, id: n.id, class: n.getAttribute("class"), role: n.getAttribute("role"), label: n.getAttribute("aria-label"),
        placeholder: n.getAttribute("placeholder"), text: (n.innerText || "").slice(0, 120), type: n.getAttribute("type"),
      }))) });
    const snapshot = () => Promise.race([readSnapshot(), new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Renderer snapshot blocked for 8 seconds; inspect and finish any native dialog before retrying")), 8000); timer.unref();
    })]);
    const record = async (action: unknown, result: unknown) => {
      const observation = { id: observations.length + 1, action, result };
      observations.push(observation);
      await fs.writeFile(path.join(directory, "observations.json"), JSON.stringify(observations, null, 2));
      emit({ type: "observation", observation });
      return JSON.stringify(observation);
    };
    const input = z.object({ action: z.enum(["snapshot", "select_window", "click", "fill", "press", "type", "wait"]), selector: z.string(), value: z.string() });
    const tools: AssistTool[] = [{ name: "ui", description: "Operate the original renderer. Use precise Playwright selectors: button:text-is(\"Open\") targets the Open button; text=Open can match a noninteractive heading and has no effect. CSS and [aria-label=] selectors work. Ambiguous selectors fail rather than silently choosing the first. snapshot returns visible text, controls, rendered HTML and available windows. select_window switches to the window index in value (important when opening a vault creates a new window). fill replaces input/contenteditable content; type inserts text; press sends a keyboard key. wait waits up to 3 seconds. Every action returns a new snapshot and observation ID.",
      inputSchema: { type: "object", additionalProperties: false, required: ["action", "selector", "value"], properties: {
        action: { type: "string", enum: ["snapshot", "select_window", "click", "fill", "press", "type", "wait"] }, selector: { type: "string" }, value: { type: "string" },
      } },
      async run(value) {
        signal.throwIfAborted(); const action = input.parse(value);
        try {
          if (action.action === "select_window") {
            const selected = windows()[Number(action.value)];
            if (!selected) throw new Error("Select an available window index");
            page = selected; page.setDefaultTimeout(8_000);
          }
          const target = action.selector ? page.locator(action.selector) : page.locator("body");
          if (action.action === "click") await target.click();
          if (action.action === "fill") await target.fill(action.value);
          if (action.action === "press") await target.press(action.value);
          if (action.action === "type") await page.keyboard.insertText(action.value);
          if (action.action === "wait") await page.waitForTimeout(Math.min(3000, Math.max(0, Number(action.value) || 1000)));
          return await record(action, await snapshot());
        } catch (error) { return record(action, { error: (error as Error).message }); }
      },
    }, { name: "fixture", description: "Create a UTF-8 test note or folder under the isolated workspace. An empty content creates an empty file; directory=true creates a folder. Returned paths can be typed into the app's folder picker. Never access source or host files.",
      inputSchema: { type: "object", additionalProperties: false, required: ["path", "content", "directory"], properties: { path: { type: "string" }, content: { type: "string" }, directory: { type: "boolean" } } },
      async run(value) {
        const item = z.object({ path: z.string().max(300), content: z.string().max(100_000), directory: z.boolean() }).parse(value);
        const target = path.resolve(workspace, item.path);
        if (!target.startsWith(`${workspace}${path.sep}`)) throw new Error("Fixture path must stay inside the workspace");
        await fs.mkdir(item.directory ? target : path.dirname(target), { recursive: true });
        if (!item.directory) await fs.writeFile(target, item.content);
        return record({ fixture: item.path }, { path: target, directory: item.directory });
      },
    }, { name: "native_dialog", description: "Operate a native folder picker opened by the app, outside the browser DOM. inspect returns the focused window name. choose_folder types a fixture folder's absolute path into the picker location bar and navigates there. confirm activates Open with Alt+O (Return can merely navigate the location bar); cancel presses Escape. These are recorded host inputs, not evidence of application behavior by themselves.",
      inputSchema: { type: "object", additionalProperties: false, required: ["action", "path"], properties: { action: { type: "string", enum: ["inspect", "choose_folder", "confirm", "cancel"] }, path: { type: "string" } } },
      async run(value) {
        signal.throwIfAborted();
        const item = z.object({ action: z.enum(["inspect", "choose_folder", "confirm", "cancel"]), path: z.string() }).parse(value);
        const command = (...args: string[]) => execFileAsync("xdotool", args, { env: environment, timeout: 5000 });
        if (item.action === "choose_folder") {
          const target = path.resolve(workspace, item.path);
          if (!target.startsWith(`${workspace}${path.sep}`) || !(await fs.stat(target)).isDirectory()) throw new Error("Choose a fixture folder inside the workspace");
          await command("key", "ctrl+l"); await page.waitForTimeout(150);
          await command("type", "--clearmodifiers", "--", target); await command("key", "Return");
        }
        if (item.action === "confirm") await command("key", "alt+o");
        if (item.action === "cancel") await command("key", "Escape");
        await page.waitForTimeout(300);
        const focused = (await command("getwindowfocus", "getwindowname")).stdout.trim();
        return record({ host_input: item }, { focused_window: focused,
          note: "Native dialogs can block renderer JavaScript. Confirm or cancel the picker before requesting a browser snapshot." });
      },
    }];
    const initial = await record({ action: "startup" }, await snapshot());
    const response = await structuredCall({ role: "spec_writer", signal, tools, maxToolTurns: 40, maxTokens: 12_000,
      system: "You are a behavioral specification agent. Observe the original app only through UI and fixture tools. Write requirements only for behavior you actually reached; cite observation IDs. Explore varied inputs and edit/read transitions. Verify each UI transition before assuming it succeeded; fixture creation and native-dialog typing do not prove a vault opened. If a click leaves the same screen, target an actual interactive control precisely rather than its heading. Do not invent behavior from product familiarity. Do not implement anything. Record unreachable task requirements as blockers. Your output is a draft, never an approval. No original source is available.",
      messages: [{ role: "user", content: `Task: ${task}\nIsolated fixture root: ${workspace}\nStartup observation: ${initial}` }],
      schema, parse: value => Answer.parse(value), onProgress: output_chars => emit({ type: "progress", output_chars }),
    });
    for (const requirement of response.value.requirements) {
      if (!requirement.observation_ids.length || requirement.observation_ids.some(id => !observations.some(item => item.id === id)))
        throw new Error(`Requirement ${requirement.id} cites missing observations`);
    }
    const draft = { schema: 1, status: "draft", task, ...response.value, model: response.model,
      observations, limitations: ["Interactive observations have not been replayed independently", "No implementation or held-out renderer checks have run"] };
    await fs.writeFile(path.join(directory, "draft.json"), JSON.stringify(draft, null, 2));
    return draft;
  } finally {
    signal.removeEventListener("abort", stop);
    await electron?.close().catch(() => {}); display.kill("SIGTERM");
    await browser?.close().catch(() => {}); originalProcess?.kill("SIGTERM");
    await fs.rm(original, { recursive: true, force: true });
  }
}
