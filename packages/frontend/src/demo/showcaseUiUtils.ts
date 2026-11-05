import { renderMarkdown } from "./engines/obsidianRenderer";
import type { ShowcaseAction } from "./showcaseModel";

export function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export function safeHtml(markdown: string): string {
  const doc = new DOMParser().parseFromString(renderMarkdown(markdown).html, "text/html");
  const allowed = new Set("div p h1 h2 h3 h4 h5 h6 a strong em b i code pre blockquote ul ol li hr br del s span table thead tbody tr th td".split(" "));
  const walk = (root: Element) => {
    for (const child of [...root.children]) {
      if (!allowed.has(child.tagName.toLowerCase())) { child.replaceWith(doc.createTextNode(child.textContent ?? "")); continue; }
      const internalLink = child.tagName === "A" && child.classList.contains("internal-link");
      const callout = child.classList.contains("callout");
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const safeLink = name === "href" && /^(https?:\/\/|#)/i.test(attr.value);
        if (name === "class" && (internalLink || callout)) { child.setAttribute("class", internalLink ? "internal-link" : "callout"); continue; }
        const internal = (name === "data-href" && internalLink) || (name === "data-callout" && callout);
        if (!safeLink && !internal) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
export const action = (type: ShowcaseAction["type"], target = "", data: Record<string, unknown> = {}): ShowcaseAction => ({ type, target, data });
