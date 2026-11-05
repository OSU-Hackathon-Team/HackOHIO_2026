import { renderMarkdown } from "./engines/obsidianRenderer";
import type { ShowcaseAction } from "./showcaseModel";

export function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export function safeHtml(markdown: string): string {
  // The pinned renderer applies inline emphasis inside fenced code. Render those
  // blocks literally at the showcase boundary so formulas and source stay intact.
  const escapeCode = (source: string) => source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const fence = /^```[^\n]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;
  const fragments: string[] = [];
  let start = 0;
  for (const match of markdown.matchAll(fence)) {
    fragments.push(renderMarkdown(markdown.slice(start, match.index)).html);
    fragments.push(`<pre><code>${escapeCode(match[1].replace(/\r?\n$/, ""))}</code></pre>`);
    start = match.index! + match[0].length;
  }
  fragments.push(renderMarkdown(markdown.slice(start)).html);
  const doc = new DOMParser().parseFromString(fragments.join(""), "text/html");
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
