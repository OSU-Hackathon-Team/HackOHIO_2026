import type { Page } from "playwright";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

export const RendererCaseInput = z.object({
  case_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), markdown: z.string().max(20000),
  input_selector: z.string().min(1).max(2000), render_selector: z.string().min(1).max(2000),
  output_selector: z.string().min(1).max(2000),
  input_method: z.enum(["fill", "keyboard"]).default("fill"),
  document_path: z.string().max(500).default(""),
}).strict();
export const RendererAgentCaseInput = RendererCaseInput.omit({ output_selector: true }).extend({
  output_document: z.number().int().min(0).max(11),
});

/** Only original fixture Markdown is readable; source archives and host files stay outside. */
export async function readCapturedDocument(workspace: string, relative: string): Promise<string> {
  const root = await fs.realpath(workspace), requested = path.resolve(root, relative);
  if (!relative || path.isAbsolute(relative) || !requested.startsWith(root + path.sep) || path.extname(requested).toLowerCase() !== ".md")
    throw new Error("Case document must be a Markdown file inside the fixture workspace");
  const real = await fs.realpath(requested);
  if (!real.startsWith(root + path.sep)) throw new Error("Case document resolves outside the fixture workspace");
  const stat = await fs.stat(real);
  if (!stat.isFile() || path.extname(real).toLowerCase() !== ".md" || stat.size > 400000) throw new Error("Case document must be a bounded Markdown fixture file");
  const bytes = await fs.readFile(real), text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Case document is not valid UTF-8");
  if (text.length > 100000) throw new Error("Case document exceeds the read limit");
  return text;
}

/** Runs inside the browser; structural paths avoid application-specific selector guesses. */
export function rendererControlMetadata(node: any) {
  const segments: string[] = [];
  for (let current = node; current?.tagName; current = current.parentElement) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement ? [...current.parentElement.children].filter((n: any) => n.tagName === current.tagName) : [current];
    segments.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
    if (tag === "body") break;
  }
  return { tag: node.tagName, id: node.id, class: node.getAttribute("class"), role: node.getAttribute("role"),
    label: node.getAttribute("aria-label"), placeholder: node.getAttribute("placeholder"),
    text: (node.innerText || "").slice(0, 120), type: node.getAttribute("type"),
    multiline: node.tagName === "TEXTAREA" || node.getAttribute("aria-multiline") === "true" ||
      (node.getAttribute("role") === "textbox" && node.isContentEditable),
    editable: node.matches("input,textarea,[contenteditable=true]"), selector: segments.join(" > ") };
}

export async function observedRenderedDocuments(page: Page) {
  const candidates = await page.locator("article,main,[role=document],[class*=preview],[class*=render],[class*=reading]").elementHandles();
  const roots = await Promise.all(candidates.map(async node => {
    try {
      const state = await node.evaluate((n: any) => ({
        visible: n.getClientRects().length > 0 && n.ownerDocument.defaultView.getComputedStyle(n).visibility !== "hidden",
        documentEditor: !!n.closest("[contenteditable=true]") || [...n.querySelectorAll("textarea,[contenteditable=true][role=textbox],[contenteditable=true][aria-multiline=true]")]
          .some((editor: any) => editor.getClientRects().length > 0 && editor.ownerDocument.defaultView.getComputedStyle(editor).visibility !== "hidden"),
        elements: n.querySelectorAll("h1,h2,h3,h4,h5,h6,p,pre,table,li,blockquote").length,
      }));
      return state.visible && !state.documentEditor && state.elements > 0
        ? { ...await node.evaluate(rendererControlMetadata), elements: state.elements } : null;
    } finally { await node.dispose(); }
  }));
  return roots.filter((root): root is NonNullable<typeof root> => root !== null).slice(0, 12);
}

/** Execute the original UI interaction; expectations always come from the resulting DOM. */
export async function captureRendererCase(page: Page, raw: unknown, options: { readDocument?: () => Promise<string> } = {}) {
  const input = RendererCaseInput.parse(raw);
  for (const selector of [input.input_selector, input.render_selector, input.output_selector]) {
    if (/^@\d+$/.test(selector)) throw new Error("Case capture requires stable selectors, not snapshot control refs");
  }
  let editor = page.locator(input.input_selector);
  const editorCount = await editor.count();
  if (editorCount !== 1) {
    const visibleEditors = await page.locator("input,textarea,[contenteditable=true]").evaluateAll((nodes: any[]) => nodes.filter(n => n.getClientRects().length > 0).length);
    throw new Error(`Input selector matched ${editorCount} elements; expected one original editor. ${visibleEditors} editable controls are visible. Return to editing mode FIRST and use an editable control ref from a fresh snapshot; render_case itself switches to reading mode after filling.`);
  }
  if (!await editor.evaluate((node: any) => node.matches("input,textarea,[contenteditable=true]"))) {
    const nested = editor.locator("input:visible,textarea:visible,[contenteditable=true]:visible");
    if (await nested.count() !== 1) throw new Error("The selected control is a container with no unique editable descendant; use an editable_controls ref from a fresh editing-mode snapshot");
    editor = nested;
  }
  if (input.input_method === "keyboard") {
    await editor.click();
    await editor.press("ControlOrMeta+A");
    await editor.press("Backspace");
    await page.keyboard.insertText(input.markdown);
  } else await editor.fill(input.markdown);
  const requested = options.readDocument ? input.markdown : input.markdown.replaceAll("\r\n", "\n");
  let actual = "", matches = 0;
  for (let attempt = 0; attempt < 12 && matches < 2; attempt++) {
    await page.waitForTimeout(150);
    try {
      const value = options.readDocument ? await options.readDocument() : await editor.evaluate((node: any) =>
        ["INPUT", "TEXTAREA"].includes(node.tagName) ? node.value : node.innerText);
      actual = options.readDocument ? value : value.replaceAll("\r\n", "\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 11) throw error;
      actual = ""; matches = 0;
      continue;
    }
    matches = actual === requested ? matches + 1 : 0;
  }
  if (matches < 2) {
    let offset = 0;
    while (offset < Math.min(actual.length, requested.length) && actual[offset] === requested[offset]) offset++;
    throw new Error(`Original editor content differs from the requested case input at offset ${offset}; requested length ${requested.length}, actual length ${actual.length}. Actual excerpt: ${JSON.stringify(actual.slice(Math.max(0, offset - 40), offset + 120))}`);
  }
  const transition = page.locator(input.render_selector);
  const transitionCount = await transition.count();
  if (transitionCount !== 1) throw new Error(`Render selector matched ${transitionCount} controls; use an exact view-control ref from a fresh snapshot or the actual aria-label selector, not an invented name attribute`);
  await transition.click();
  const output = page.locator(input.output_selector);
  await output.waitFor({ state: "visible", timeout: 8000 });
  if (await output.count() !== 1) throw new Error("Output selector must identify exactly one rendered document");
  let previous: string | null = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.waitForTimeout(250);
    const rendered = await output.evaluate((node: any) => {
      const clone = node.cloneNode(true);
      clone.querySelectorAll("script,style,link,meta,svg").forEach((child: any) => child.remove());
      for (const element of [clone, ...clone.querySelectorAll("*")]) {
        for (const attribute of [...element.attributes]) {
          if (/^on/i.test(attribute.name) || attribute.name === "style") element.removeAttribute(attribute.name);
        }
      }
      return clone.innerHTML;
    });
    if (rendered.length > 100000) throw new Error("Original case output exceeds the capture limit; use a smaller document");
    if (rendered === previous) return { case_id: input.case_id, input_verified: true,
      input_verification: options.readDocument ? "saved_document" : "editor_dom", rendered };
    previous = rendered;
  }
  throw new Error("Original case output did not settle to a document");
}
