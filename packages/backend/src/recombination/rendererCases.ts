import type { Page } from "playwright";
import { z } from "zod";

export const RendererCaseInput = z.object({
  case_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), markdown: z.string().max(20000),
  input_selector: z.string().min(1).max(2000), render_selector: z.string().min(1).max(2000),
  output_selector: z.string().min(1).max(2000),
}).strict();

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
    editable: node.matches("input,textarea,[contenteditable=true]"), selector: segments.join(" > ") };
}

/** Execute the original UI interaction; expectations always come from the resulting DOM. */
export async function captureRendererCase(page: Page, raw: unknown) {
  const input = RendererCaseInput.parse(raw);
  for (const selector of [input.input_selector, input.render_selector, input.output_selector]) {
    if (/^@\d+$/.test(selector)) throw new Error("Case capture requires stable selectors, not snapshot control refs");
  }
  const editor = page.locator(input.input_selector);
  const editorCount = await editor.count();
  if (editorCount !== 1) {
    const visibleEditors = await page.locator("input,textarea,[contenteditable=true]").evaluateAll((nodes: any[]) => nodes.filter(n => n.getClientRects().length > 0).length);
    throw new Error(`Input selector matched ${editorCount} elements; expected one original editor. ${visibleEditors} editable controls are visible. Return to editing mode FIRST and use an editable control ref from a fresh snapshot; render_case itself switches to reading mode after filling.`);
  }
  await editor.fill(input.markdown);
  const actual = await editor.evaluate((node: any) =>
    ["INPUT", "TEXTAREA"].includes(node.tagName) ? node.value : node.innerText);
  if (actual.replaceAll("\r\n", "\n") !== input.markdown.replaceAll("\r\n", "\n"))
    throw new Error("Original editor content differs from the requested case input");
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
    if (rendered === previous) return { case_id: input.case_id, input_verified: true, rendered };
    previous = rendered;
  }
  throw new Error("Original case output did not settle to a document");
}
