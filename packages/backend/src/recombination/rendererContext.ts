/** Compact model replies only; original observations remain unchanged in the audit trace. */
export function compactRendererResult(value: unknown): unknown {
  const result = value as Record<string, unknown>;
  if (!result || typeof result !== "object" || Array.isArray(result)) return value;
  if (typeof result.error === "string") return { error: result.error.slice(0, 1800) };
  if (typeof result.elements === "string") return { elements: result.elements.slice(0, 5000), truncated: result.elements.length > 5000, note: "Read the recorded observation in chunks for complete HTML" };
  if (typeof result.text !== "string") return value;
  const controls = Array.isArray(result.controls) ? result.controls.map((item: Record<string, unknown>) => ({
    ref: item.ref, tag: item.tag, name: String(item.label || item.placeholder || item.text || item.class || "").replace(/\n/g, " | ").slice(0, 70),
  })) : [];
  const compact = { title: String(result.title ?? "").slice(0, 200),
    windows: Array.isArray(result.windows) ? result.windows.slice(0, 12).map((item: Record<string, unknown>) => ({ index: item.index, title: String(item.title ?? "").slice(0, 150) })) : [], text: result.text.slice(0, 1400),
    rendered_excerpt: String(result.rendered ?? "").slice(0, 500), controls,
    note: "Snapshot excerpts may be truncated. Use observation tool fields or UI inspect for exact evidence and remaining controls." };
  while (JSON.stringify(compact).length > 6000 && compact.controls.length) compact.controls.pop();
  return compact;
}
