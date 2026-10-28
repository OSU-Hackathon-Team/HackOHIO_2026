import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import * as asar from "@electron/asar";
import { _electron, chromium, type Browser, type ElementHandle, type Page, type ElectronApplication } from "playwright";
import { z } from "zod";
import { continueWith, structuredCall, type AssistTool, type StructuredCallOpts } from "../llm/llm.js";
import { RendererReplaySource, replayRendererTrace } from "./rendererReplay.js";
import { compactRendererResult } from "./rendererContext.js";
import { captureRendererCase, observedRenderedDocuments, readCapturedDocument, RendererAgentCaseInput, RendererCaseInput, rendererControlMetadata } from "./rendererCases.js";

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

type RenderedMarkdownExpectation = { capability: RegExp; label: string; output: RegExp; input: RegExp; allLevels?: RegExp; allInputs?: RegExp };

const RENDERED_MARKDOWN_EXPECTATIONS: RenderedMarkdownExpectation[] = [
  { capability: /\bheadings?\b/i, label: "HTML heading elements", output: /<h[1-6]\b/i,
    input: /(?:^|\n)#{1,6}\s+\S/m, allLevels: /\b(?:1\s*[-–]\s*6|one through six|all six)\b/i,
    allInputs: /(?:^|\n)#{1}\s+\S[\s\S]*(?:^|\n)#{2}\s+\S[\s\S]*(?:^|\n)#{3}\s+\S[\s\S]*(?:^|\n)#{4}\s+\S[\s\S]*(?:^|\n)#{5}\s+\S[\s\S]*(?:^|\n)#{6}\s+\S/m },
  { capability: /\b(?:italic|emphasis)\b/i, label: "italic elements", output: /<(?:em|i)\b/i, input: /(?<!\*)\*[^*\s][^*]*\*(?!\*)/ },
  { capability: /\bbold\b/i, label: "bold elements", output: /<(?:strong|b)\b/i, input: /\*\*[^*\s][^*]*\*\*/ },
  { capability: /\bstrikethrough\b/i, label: "strikethrough elements", output: /<(?:del|s)\b/i, input: /~~[^~\s][^~]*~~/ },
  { capability: /\bnested lists?\b/i, label: "nested list elements", output: /<ul\b[^>]*>[\s\S]*?<li\b[^>]*>[\s\S]*?<ul\b/i, input: /(?:^|\n)(?: {2,}|\t)[*-+]\s+\S/m },
  { capability: /\bfenced code(?: blocks?)?\b|\bcode blocks?\b/i, label: "fenced code elements", output: /<pre\b[\s\S]*<code\b/i, input: /(?:^|\n)```[\w-]*\s*\n[\s\S]+?\n```/m },
  { capability: /\bexternal links?\b/i, label: "external link elements", output: /<a\b[^>]*href=["']https?:\/\//i, input: /\[[^\]]+\]\(https?:\/\/[^)]+\)/i },
  { capability: /\binternal links?\b/i, label: "internal link elements", output: /<a\b[^>]*(?:internal-link|data-href|href=)/i, input: /\[\[[^\]]+\]\]/ },
  { capability: /\bcallouts?\b/i, label: "callout elements", output: /(?:callout|admonition|data-callout)/i, input: /(?:^|\n)>\s*\[![\w-]+\]/m },
  { capability: /\bmarkdown tables?\b|\btables? with headers\b/i, label: "table elements", output: /<table\b/i, input: /(?:^|\n)\|[^\n]+\|\s*\n\|[\s:|-]+\|/m },
];

export function rendererDraftProblems(draft: z.infer<typeof Answer>, observations: Array<{ id: number; action: unknown; result: unknown }>,
  options: { requireRenderedMarkdownOutput?: boolean; requireCases?: boolean } = {}): string[] {
  const problems: string[] = [];
  if (options.requireCases) {
    const capturedInputs = new Set(observations.filter(item => {
      const action = item.action as Record<string, unknown>, result = item.result as Record<string, unknown>;
      return action.action === "capture_case" && result.input_verified === true && typeof result.rendered === "string" && result.rendered.length > 0 && !result.error &&
        draft.requirements.some(requirement => requirement.observation_ids.includes(item.id));
    }).map(item => (item.action as Record<string, unknown>).value));
    if (capturedInputs.size < 3) problems.push("Capture at least three distinct Markdown inputs with render_case and cite them in requirements before declaring a draft");
  }
  const ids = new Set<string>();
  for (const requirement of draft.requirements) {
    if (ids.has(requirement.id)) problems.push(`${requirement.id} is duplicated`);
    ids.add(requirement.id);
    const cited = requirement.observation_ids.map(id => observations.find(item => item.id === id));
    if (!cited.length || cited.some(item => !item)) problems.push(`${requirement.id} cites missing observations`);
    else if (!cited.some(item => {
      const action = item!.action as { action?: unknown };
      const result = item!.result as { error?: unknown };
      return typeof action.action === "string" && !result.error;
    })) problems.push(`${requirement.id} has no successful UI observation (fixture and host inputs alone are insufficient)`);
    if (/\buser can\b|\b(?:correctly|proper structure|works? as expected)\b/i.test(requirement.statement))
      problems.push(`${requirement.id} is vague or generalized. Replace it with a concrete input, UI action, and visible output; remove it when another requirement already describes the same behavior precisely`);
    if (options.requireRenderedMarkdownOutput && cited.length && cited.every(Boolean)) {
      const successfulUi = cited.filter(item => typeof (item!.action as { action?: unknown }).action === "string" && !(item!.result as { error?: unknown }).error);
      const rendered = successfulUi.map(item => String((item!.result as { rendered?: unknown }).rendered ?? "")).join("\n");
      const entered = cited.map(item => {
        const action = item!.action as { value?: unknown; content?: unknown };
        return [action.value, action.content].filter((value): value is string => typeof value === "string").join("\n");
      }).join("\n");
      for (const expected of RENDERED_MARKDOWN_EXPECTATIONS) {
        if (!expected.capability.test(requirement.statement)) continue;
        const hasOutput = expected.allLevels?.test(requirement.statement)
          ? [1, 2, 3, 4, 5, 6].every(level => new RegExp(`<h${level}\\b`, "i").test(rendered))
          : expected.output.test(rendered);
        const hasInput = expected.allInputs?.test(entered) ?? expected.input.test(entered);
        if (!hasInput) problems.push(`${requirement.id} claims ${expected.label}, but the cited actions do not include the corresponding Markdown syntax input. Cite the editor fill or fixture containing the syntax, or remove the claim`);
        if (!hasOutput) problems.push(`${requirement.id} claims ${expected.label}, but cited UI snapshots contain no matching rendered HTML. Enter the syntax, switch to reading mode, inspect the rendered output, and cite that snapshot; otherwise remove the claim and record a blocker`);
      }
    }
  }
  return problems;
}

/** Observe renderer behavior through UI actions only. No source-reading tool reaches the model. */
export async function discoverRenderer(options: { archive: string; directory: string; task: string; signal: AbortSignal;
  resources?: Array<{ archive: string; name: string }>; entryResource?: string;
  replay?: RendererReplaySource;
  recapture?: boolean; replay_source_id?: string;
  capture_cases?: boolean;
  emit: (event: { type: string; [key: string]: unknown }) => void }) {
  const { archive, directory, task, signal, emit } = options;
  const archiveHash = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  if (options.replay && options.replay.archive_sha256 !== archiveHash) throw new Error("Replay source archive identity mismatch");
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
      originalProcess.stdout!.on("data", value => emit({ type: "diagnostic", message: String(value).slice(0, 2000) }));
      originalProcess.on("exit", (code, exitSignal) => emit({ type: "diagnostic", message: `Original process exited: code=${code}, signal=${exitSignal}` }));
      const endpoint = await new Promise<string>((resolve, reject) => {
        let diagnostic = "";
        const timer = setTimeout(() => reject(new Error(`Original renderer did not expose a debugging endpoint: ${diagnostic}`)), 45_000);
        originalProcess!.once("error", error => { clearTimeout(timer); reject(error); });
        originalProcess!.once("exit", code => { clearTimeout(timer); reject(new Error(`Original exited ${code}: ${diagnostic}`)); });
        originalProcess!.stderr!.on("data", value => {
          diagnostic = (diagnostic + String(value)).slice(-8000);
          emit({ type: "diagnostic", message: String(value).slice(0, 2000) });
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
    let controls: ElementHandle[] = [];
    let renderSelectors: string[] = [];
    let renderRoots: Array<Record<string, unknown>> = [];
    const readControls = async () => {
      await Promise.all(controls.map(control => control.dispose().catch(() => {})));
      const candidates = await page.locator("input,textarea,button,[contenteditable=true],[role=button],[role=link],[role=treeitem],a[href],[class*=button],[aria-label],.nav-file-title,.tree-item-self,.workspace-tab-header,.view-action,.clickable-icon").elementHandles();
      const visible = (await Promise.all(candidates.map(async control => ({ control, state: await control.evaluate((n: any) => ({
        visible: n.getClientRects().length > 0 && n.ownerDocument.defaultView.getComputedStyle(n).visibility !== "hidden" && n.ownerDocument.defaultView.getComputedStyle(n).display !== "none",
        priority: /nav-file-title|tree-item-self|workspace-tab-header|view-action|clickable-icon/.test(n.className?.baseVal ?? n.className ?? "")
          ? 0 : n.matches("input,textarea,button,[contenteditable=true],[role=button],[role=link],[role=treeitem],a[href]") ? 1 : 2,
      })) })))).filter(item => item.state.visible);
      controls = visible.sort((a, b) => a.state.priority - b.state.priority).slice(0, 100).map(item => item.control);
      return Promise.all(controls.map(async (control, ref) => ({ ref: `@${ref}`, ...await control.evaluate(rendererControlMetadata) })));
    };
    const windows = () => (browser ? browser.contexts().flatMap(context => context.pages()) : electron!.windows()).filter(window => !window.isClosed());
    const ensurePage = async () => {
      if (!page.isClosed()) return;
      const available = windows();
      if (available.length) page = available[available.length - 1];
      else if (browser?.isConnected() && browser.contexts()[0]) page = await browser.contexts()[0].waitForEvent("page", { timeout: 15_000 });
      else if (electron) page = await electron.waitForEvent("window", { timeout: 15_000 });
      else throw new Error("Original browser disconnected; no live renderer window remains");
      page.setDefaultTimeout(8000);
      emit({ type: "diagnostic", message: "Attached to a replacement renderer window" });
    };
    if (browser) for (const context of browser.contexts()) context.on("page", () => emit({ type: "diagnostic", message: "Original opened a renderer window" }));
    const readSnapshot = async () => {
      await ensurePage();
      const roots = await observedRenderedDocuments(page);
      if (roots.length) {
        renderSelectors = roots.map(root => root.selector);
        renderRoots = roots.map((root, index) => ({ index, tag: root.tag, class: root.class, elements: root.elements }));
      }
      return { title: await page.title(), windows: await Promise.all(windows().map(async (window, index) => ({ index, title: await window.title().catch(() => "[window closed]") }))),
      text: (await page.locator("body").innerText()).slice(0, 8000),
      rendered: (await page.locator("h1,h2,h3,h4,h5,h6,p,blockquote,pre,code,a,table,li").evaluateAll((nodes: any[]) => nodes.slice(0, 60).map(n => n.outerHTML.slice(0, 600)).join("\n"))).slice(0, 6000),
      controls: await readControls(), rendered_documents: renderRoots };
    };
    const settledSnapshot = async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      let previous = await readSnapshot();
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const next = await readSnapshot();
        if (JSON.stringify([previous.title, previous.text, previous.rendered]) === JSON.stringify([next.title, next.text, next.rendered])) return next;
        previous = next;
      }
      throw new Error("Original renderer did not settle to a consistent title/text/rendered snapshot");
    };
    const snapshot = () => Promise.race([settledSnapshot(), new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Renderer snapshot blocked for 8 seconds; inspect and finish any native dialog before retrying")), 8000); timer.unref();
    })]);
    const record = async (action: unknown, result: unknown) => {
      const observation = { id: observations.length + 1, action, result };
      observations.push(observation);
      await fs.writeFile(path.join(directory, "observations.json"), JSON.stringify(observations, null, 2));
      emit({ type: "observation", observation });
      return JSON.stringify({ id: observation.id, result: compactRendererResult(result) });
    };
    const executeCapture = async (item: z.infer<typeof RendererCaseInput>) => {
      signal.throwIfAborted();
      const action = { action: "capture_case", case_id: item.case_id, value: item.markdown, input_method: item.input_method, document_path: item.document_path,
        input_selector: item.input_selector, render_selector: item.render_selector, output_selector: item.output_selector };
      try {
        if (observations.some(o => (o.action as Record<string, unknown>).case_id === item.case_id && (o.result as Record<string, unknown>).input_verified))
          throw new Error("Choose a unique case_id for each captured case");
        await ensurePage();
        return await record(action, await captureRendererCase(page, item, item.document_path
          ? { readDocument: () => readCapturedDocument(workspace, item.document_path) } : {}));
      } catch (error) { return record(action, { error: (error as Error).message }); }
    };
    const input = z.object({ action: z.enum(["snapshot", "inspect", "select_window", "click", "fill", "press", "type", "wait"]), selector: z.string(), value: z.string() });
    let pickerWindow: string | null = null;
    const tools: AssistTool[] = [{ name: "ui", description: "Operate the original renderer. Prefer the exact control ref from the latest snapshot, such as selector @12, for click/fill/press. Refs avoid guessing element tags or escaping multiline aria labels; request a new snapshot if stale. CSS, text= and [aria-label=] selectors also work but must be precise. inspect returns visible elements' HTML for a selector. snapshot returns visible text, controls, rendered HTML and available windows. select_window switches to the window index in value. fill replaces input/contenteditable content; type inserts text; press sends a keyboard key. wait waits up to 3 seconds. Every action returns a new snapshot and observation ID.",
      inputSchema: { type: "object", additionalProperties: false, required: ["action", "selector", "value"], properties: {
        action: { type: "string", enum: ["snapshot", "inspect", "select_window", "click", "fill", "press", "type", "wait"] }, selector: { type: "string" }, value: { type: "string" },
      } },
      async run(value) {
        signal.throwIfAborted(); const action = input.parse(value);
        try {
          if (action.action === "select_window") {
            const selected = windows()[Number(action.value)];
            if (!selected) throw new Error("Select an available window index");
            page = selected; page.setDefaultTimeout(8_000);
          } else await ensurePage();
          const reference = /^@(\d+)$/.exec(action.selector);
          const target = reference ? controls[Number(reference[1])] : action.selector ? page.locator(action.selector) : page.locator("body");
          if (!target) throw new Error("Control ref is unavailable; request a fresh snapshot");
          if (action.action === "inspect") {
            const elements = await page.locator(action.selector).evaluateAll((nodes: any[]) => nodes.slice(0, 80).filter(node => node.getClientRects().length && !["SCRIPT", "STYLE", "LINK", "META"].includes(node.tagName)).map(node => {
              const clone = node.cloneNode(true);
              clone.querySelectorAll("script,style,link,meta,svg").forEach((child: any) => child.remove());
              return clone.outerHTML.slice(0, 1500);
            }));
            return record(action, { elements: elements.join("\n").slice(0, 20_000) });
          }
          if (action.action === "click") await target.click();
          if (action.action === "fill") await target.fill(action.value);
          if (action.action === "press") await target.press(action.value);
          if (action.action === "type") await page.keyboard.insertText(action.value);
          if (action.action === "wait") await page.waitForTimeout(Math.min(3000, Math.max(0, Number(action.value) || 1000)));
          return await record(action, await snapshot());
        } catch (error) { return record(action, { error: (error as Error).message }); }
      },
    }, { name: "render_case", description: "Capture an executable public Markdown case on the original app. First open a note in EDITING mode; do NOT switch to reading before calling this tool. Supply a unique case_id, complete Markdown, the editable control ref (such as @12) from a fresh snapshot, a view-toggle control ref (such as @26), and a numeric output_document index (such as 0) from rendered_documents learned in a reading-mode snapshot. Do not provide an output CSS selector or translate a ref into a class. The last observed rendered-document indices stay available after switching back to editing. Input and view selectors may also be exact CSS. Control refs are converted to structural CSS paths for frozen replay. Choose input_method fill for ordinary editable controls or keyboard for custom editors: keyboard focuses the control, selects all, deletes and inserts the full text using keyboard input. If fill reports a mismatch on a custom editor, try keyboard. Set document_path to the actual Markdown note path relative to the fixture root when live preview hides syntax markers. The host verifies exact saved document bytes when document_path is provided, otherwise settled editor text, then clicks the view control and records settled DOM output. After capture the note is in rendered mode; switch back to editing before another capture. The result is original evidence, never an authored expectation. Use observation to read full HTML when excerpts are truncated.",
      inputSchema: { type: "object", additionalProperties: false, required: ["case_id", "markdown", "input_selector", "render_selector", "output_document", "input_method", "document_path"], properties: {
        case_id: { type: "string" }, markdown: { type: "string" }, input_selector: { type: "string" }, render_selector: { type: "string" }, output_document: { type: "integer", minimum: 0, maximum: 11 },
        input_method: { type: "string", enum: ["fill", "keyboard"] },
        document_path: { type: "string", description: "Optional relative Markdown fixture path, such as vault/Note.md. Use it to verify the original app's saved bytes when live preview hides syntax markers. Empty string verifies editor DOM text instead." },
      } },
      async run(value) {
        signal.throwIfAborted();
        try {
          const { output_document, ...fields } = RendererAgentCaseInput.parse(value);
          const output_selector = renderSelectors[output_document];
          if (!output_selector) throw new Error("Inspect a snapshot in reading mode to discover rendered_documents indices, then return to editing before capture");
          const item = RendererCaseInput.parse({ ...fields, output_selector });
          for (const field of ["input_selector", "render_selector"] as const) {
            const ref = /^@(\d+)$/.exec(item[field]);
            if (ref) {
              const control = controls[Number(ref[1])];
              if (!control) throw new Error("Case control ref is unavailable; request a fresh snapshot");
              item[field] = (await control.evaluate(rendererControlMetadata)).selector;
            }
          }
          return executeCapture(item);
        } catch (error) {
          return record({ action: "capture_case_request", request: value }, { error: (error as Error).message });
        }
      },
    }, { name: "fixture", description: "Create a UTF-8 test note or folder under the isolated workspace. An empty content creates an empty file; directory=true creates a folder. Returned paths can be typed into the app's folder picker. Never access source or host files.",
      inputSchema: { type: "object", additionalProperties: false, required: ["path", "content", "directory"], properties: { path: { type: "string" }, content: { type: "string" }, directory: { type: "boolean" } } },
      async run(value) {
        const item = z.object({ path: z.string().max(300), content: z.string().max(100_000), directory: z.boolean() }).parse(value);
        const target = path.resolve(workspace, item.path);
        if (!target.startsWith(`${workspace}${path.sep}`)) throw new Error("Fixture path must stay inside the workspace");
        await fs.mkdir(item.directory ? target : path.dirname(target), { recursive: true });
        if (!item.directory) await fs.writeFile(target, item.content);
        return record({ fixture: item.path, content: item.content, directory: item.directory }, { path: target, directory: item.directory });
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
          pickerWindow = (await command("getwindowfocus")).stdout.trim();
          await command("key", "ctrl+l"); await page.waitForTimeout(150);
          await command("type", "--clearmodifiers", "--", target); await command("key", "Return");
          await new Promise(resolve => setTimeout(resolve, 600));
          if ((await command("getwindowfocus")).stdout.trim() === pickerWindow) await command("key", "alt+o");
          for (let attempt = 0; attempt < 10 && (await command("getwindowfocus")).stdout.trim() === pickerWindow; attempt++)
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        const pickerStillOpen = !pickerWindow || (await command("getwindowfocus")).stdout.trim() === pickerWindow;
        if (item.action === "confirm" && pickerStillOpen) await command("key", "alt+o");
        if (item.action === "cancel" && pickerStillOpen) await command("key", "Escape");
        await new Promise(resolve => setTimeout(resolve, 300));
        const focused = (await command("getwindowfocus", "getwindowname")).stdout.trim();
        return record({ host_input: item }, { focused_window: focused,
          note: "Native dialogs can block renderer JavaScript. Confirm or cancel the picker before requesting a browser snapshot." });
      },
    }, { name: "observation", description: "Read an earlier recorded UI observation without re-running the app. Complete evidence is stored even when model replies are compact. Choose a field and an offset to read up to 5000 characters; use field action to inspect the input that produced it. No source files are accessible.",
      inputSchema: { type: "object", additionalProperties: false, required: ["id", "field", "offset"], properties: {
        id: { type: "integer" }, field: { type: "string", enum: ["action", "text", "rendered", "elements", "controls", "windows", "summary"] }, offset: { type: "integer" },
      } },
      async run(value) {
        const query = z.object({ id: z.number().int(), field: z.enum(["action", "text", "rendered", "elements", "controls", "windows", "summary"]), offset: z.number().int().min(0) }).parse(value);
        const observation = observations.find(item => item.id === query.id);
        if (!observation) throw new Error("Observation ID does not exist");
        const result = observation.result as Record<string, unknown>;
        const selected = query.field === "action" ? observation.action : query.field === "summary" ? compactRendererResult(result) : result[query.field];
        const text = typeof selected === "string" ? selected : JSON.stringify(selected) ?? "";
        return JSON.stringify({ id: query.id, field: query.field, offset: query.offset, total_characters: text.length, text: text.slice(query.offset, query.offset + 1800) });
      },
    }];
    const initial = await record({ action: "startup" }, await snapshot());
    if (options.replay) {
      emit({ type: "stage", message: "Replaying recorded actions against a fresh original workspace without model calls" });
      const report = await replayRendererTrace(options.replay, workspace, observations[0].result, async action => {
        signal.throwIfAborted();
        let name: string, input: unknown;
        if (typeof action.fixture === "string") {
          if (typeof action.content !== "string" || typeof action.directory !== "boolean") throw new Error("Fixture content is missing from the source trace");
          name = "fixture"; input = { path: action.fixture, content: action.content, directory: action.directory };
        } else if (action.action === "capture_case") {
          await executeCapture(RendererCaseInput.parse({ case_id: action.case_id, markdown: action.value,
            input_selector: action.input_selector, render_selector: action.render_selector, output_selector: action.output_selector,
            input_method: action.input_method ?? "fill", document_path: action.document_path ?? "" }));
          return observations[observations.length - 1].result;
        } else if (action.action === "capture_case_request") {
          name = "render_case"; input = action.request;
        } else if (action.host_input) { name = "native_dialog"; input = action.host_input; }
        else { name = "ui"; input = action; }
        await tools.find(tool => tool.name === name)!.run(input);
        return observations[observations.length - 1].result;
      }, emit);
      await fs.writeFile(path.join(directory, "replay-report.json"), JSON.stringify(report, null, 2));
      if (options.recapture) {
        if (observations.length !== options.replay.observations.length || observations.some((item, index) => item.id !== options.replay!.observations[index].id))
          throw new Error("Recapture did not preserve the complete action sequence");
        if (observations.some((item, index) => (item.result as { error?: unknown })?.error && !(options.replay!.observations[index].result as { error?: unknown })?.error))
          throw new Error("Recapture introduced an action failure; no replacement source draft was created");
        const requirements = options.replay.requirements.map(item => ({ ...item, statement: item.statement ?? "" }));
        const value = { summary: options.replay.summary ?? "Original trace recaptured after host observation changes", requirements, blockers: options.replay.blockers ?? [] };
        const problems = rendererDraftProblems(value, observations);
        if (problems.length) throw new Error(problems.join("; "));
        const draft = { schema: 1, status: "draft", archive_sha256: archiveHash, workspace_root: workspace, task: options.replay.task, ...value,
          model: options.replay.model ?? "not_recorded", generator: "original_trace_recapture", recaptured_from: options.replay_source_id,
          source_variance: report.checks.filter(check => check.status === "failed"), observations,
          limitations: ["Fresh original observations after a host adapter change; earlier expectations and failed reports remain preserved", "Requirement semantics and candidate parity have not been approved"] };
        await fs.writeFile(path.join(directory, "draft.json"), JSON.stringify(draft, null, 2));
        return draft;
      }
      return report;
    }
    let messages: StructuredCallOpts<z.infer<typeof Answer>>["messages"] = [{ role: "user", content: `Task: ${task}\n${options.capture_cases ? "Use render_case to capture at least THREE distinct Markdown inputs and their original rendered document HTML. Before EVERY capture: put the note in EDITING mode, request a fresh snapshot, use an editable_controls ref as input_selector and the editing-to-reading view_controls ref as render_selector. Do NOT click the reading control yourself immediately before capture: render_case fills FIRST and then clicks it. Use the numeric output_document index from rendered_documents observed in the original reading view. Do not invent an output CSS selector or provide output_selector. After capture you are in reading mode; return to editing before another case. These public executable cases are required before declaring the draft. Cite captured cases in rendering requirements. Capture exact editing effects rather than assuming fill appends text." : ""}\nIsolated fixture root: ${workspace}\nStartup observation: ${initial}` }];
    const call = () => structuredCall({ role: "spec_writer", signal, tools, maxToolTurns: 40, maxTokens: 4_000,
      system: "You are a behavioral specification agent. Observe the original app only through UI and fixture tools. Write precise requirements only for behavior you actually reached; cite observation IDs. Each requirement must state a concrete input, action and visible result directly, never use generalized 'user can' phrasing or merely say that something works correctly. For claims about Markdown syntax, raw text in an editor is not rendered output: enter the syntax, switch to reading mode, inspect the resulting DOM, and cite a successful snapshot containing the corresponding HTML element. If fill replaces content, use one complete note or separate reading-mode snapshots so every claimed syntax has rendered evidence. Use ui inspect on specific rendered elements and on [aria-label] controls to obtain exact outputs and available actions. Explore varied inputs, syntax boundaries and edit/read transitions. Verify each UI transition before assuming it succeeded; fixture creation and native-dialog typing do not prove a vault opened. If a click leaves the same screen, target an actual interactive control precisely rather than its heading. Do not invent behavior from product familiarity. Do not implement anything. Record unreachable task requirements as blockers. Your output is a draft, never an approval. No original source is available.",
      messages,
      schema, parse: value => Answer.parse(value), onProgress: output_chars => emit({ type: "progress", output_chars }),
    });
    let response = await call();
    for (let attempt = 0; ; attempt++) {
      const invalid = rendererDraftProblems(response.value, observations, { requireRenderedMarkdownOutput: true, requireCases: options.capture_cases });
      if (!invalid.length) break;
      await fs.writeFile(path.join(directory, `rejected-draft-${attempt + 1}.json`), JSON.stringify(response.value, null, 2));
      emit({ type: "draft_rejected", draft: response.value, problems: invalid });
      if (attempt === 2) throw new Error(invalid.join("; "));
      emit({ type: "stage", message: "Repairing invalid observation citations" });
      messages = continueWith(messages, response.assistantContent, `Draft problems: ${invalid.join("; ")}. For every listed requirement ID, either rewrite it as a concrete input/action/output claim with supporting citations or remove it and add an accurate blocker. Drop broad duplicate claims such as 'the fixture renders correctly'; do not preserve them by repeating the syntax names. You may continue observing the original UI to gather missing rendered evidence. Never invent observation IDs. For each Markdown syntax claim, cite an action or fixture containing the syntax and a successful reading-mode UI snapshot whose rendered HTML shows the matching element. Use the observation tool for exact earlier evidence. Recorded index: ${JSON.stringify(observations.map(item => ({ id: item.id, action: JSON.stringify(item.action).slice(0, 180), error: (item.result as { error?: unknown })?.error ? String((item.result as { error: unknown }).error).slice(0, 160) : null })))}`);
      response = await call();
    }
    const draft = { schema: 1, status: "draft", archive_sha256: archiveHash, workspace_root: workspace, task, ...response.value, model: response.model,
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
