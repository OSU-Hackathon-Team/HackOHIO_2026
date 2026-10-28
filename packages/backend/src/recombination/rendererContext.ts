/** Compact model replies only; original observations remain unchanged in the audit trace. */
const MAX_REPLY_CHARS = 3_800;

export function compactRendererResult(value: unknown): unknown {
  const result = value as Record<string, unknown>;
  if (!result || typeof result !== "object" || Array.isArray(result)) return value;
  if (typeof result.error === "string") return { error: result.error.slice(0, 1000) };
  if (result.input_verified === true && typeof result.rendered === "string") return {
    case_id: result.case_id, input_verified: true, input_verification: result.input_verification, rendered_excerpt: result.rendered.slice(0, 1800),
    note: "Exact original case output is recorded. Read observation rendered in chunks for full HTML.",
  };
  if (typeof result.elements === "string") return { elements: result.elements.slice(0, 3000), truncated: result.elements.length > 3000, note: "Read the recorded observation in chunks for complete HTML" };
  if (typeof result.text !== "string") return value;
  const controls = Array.isArray(result.controls) ? result.controls.map((item: Record<string, unknown>) => ({
    ref: item.ref, tag: item.tag, name: String(item.label || item.placeholder || item.text || item.class || "").replace(/\n/g, " | ").slice(0, 50),
  })).slice(0, 40) : [];
  const compact = { title: String(result.title ?? "").slice(0, 160),
    editable_controls: Array.isArray(result.controls) ? result.controls.filter((c: Record<string, unknown>) => c.editable === true)
      .slice(0, 4).map((c: Record<string, unknown>) => ({ ref: c.ref, tag: c.tag, role: String(c.role ?? "").slice(0, 80) })) : [],
    view_controls: Array.isArray(result.controls) ? result.controls
      .filter((c: Record<string, unknown>) => /\b(read(?:ing)?|edit(?:ing)?|preview|source)\b/i.test(String(c.label || c.text || "")))
      .slice(0, 4).map((c: Record<string, unknown>) => ({ ref: c.ref, name: String(c.label || c.text || "").slice(0, 80) })) : [],
    rendered_documents: Array.isArray(result.rendered_documents) ? result.rendered_documents.slice(0, 6)
      .map((r: Record<string, unknown>) => ({ ref: r.ref, class: String(r.class ?? "").slice(0, 90), elements: r.elements })) : [],
    windows: Array.isArray(result.windows) ? result.windows.slice(0, 8).map((item: Record<string, unknown>) => ({ index: item.index, title: String(item.title ?? "").slice(0, 100) })) : [], text: result.text.slice(0, 1000),
    rendered_excerpt: String(result.rendered ?? "").slice(0, 400), controls,
    note: "Snapshot excerpts may be truncated. Use observation tool fields or UI inspect for exact evidence and remaining controls." };
  while (JSON.stringify(compact).length > MAX_REPLY_CHARS && compact.controls.length) compact.controls.pop();
  while (JSON.stringify(compact).length > MAX_REPLY_CHARS && compact.rendered_documents.length > 1) compact.rendered_documents.pop();
  while (JSON.stringify(compact).length > MAX_REPLY_CHARS && compact.view_controls.length > 1) compact.view_controls.pop();
  return compact;
}
