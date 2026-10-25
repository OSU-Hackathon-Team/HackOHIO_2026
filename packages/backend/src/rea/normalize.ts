import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface NormalizedResult {
  tool: string;
  ok: boolean;
  evidenceId: string | null;
  /** For summary replies: the retained full record's id. Pass THIS to trace/inspect tools. */
  parentEvidenceId: string | null;
  /** structuredContent.normalized_result (falls back to the whole structured payload / parsed text) */
  result: unknown;
  limitations: string[];
  unknowns: string[];
  text: string; // concatenated text content, truncated
  summary: string; // ≤ 300 chars for the terminal
}

const MAX_TEXT = 60_000;

export function normalize(tool: string, r: CallToolResult): NormalizedResult {
  const sc = (r.structuredContent ?? null) as Record<string, unknown> | null;
  const text = (r.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .slice(0, MAX_TEXT);

  const result = sc?.normalized_result ?? sc ?? tryJson(text);
  const evidenceId = typeof sc?.evidence_id === "string" ? sc.evidence_id : null;
  // Summary replies (detail:"summary") point at the retained full record; follow-up tools need that one.
  const parent = (sc?.normalized_result as any)?.parent_evidence_id;
  const parentEvidenceId = typeof parent === "string" ? parent : null;

  return {
    tool,
    ok: !r.isError,
    evidenceId,
    parentEvidenceId,
    result,
    limitations: collectNamed(sc, "limitations"),
    unknowns: collectNamed(sc, "unknowns"),
    text,
    summary: summarize(tool, !r.isError, result, text),
  };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Walk the payload and collect strings from every array under a key with this name. */
function collectNamed(root: unknown, key: string, limit = 50): string[] {
  const out = new Set<string>();
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length && visited++ < 20_000 && out.size < limit) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (k === key && Array.isArray(child)) {
        for (const item of child) {
          if (typeof item === "string") out.add(item);
          else if (item && typeof item === "object") {
            const msg = (item as any).message ?? (item as any).summary ?? (item as any).description;
            if (typeof msg === "string") out.add(msg);
          }
        }
      } else if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return [...out];
}

/** Human summary: counts of top-level arrays, e.g. "modules: 9, relations: 14, routes: 2". */
function summarize(tool: string, ok: boolean, result: unknown, text: string): string {
  if (!ok) return `error: ${text.slice(0, 260)}`;
  if (result && typeof result === "object") {
    const parts = Object.entries(result as Record<string, unknown>)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k}: ${(v as unknown[]).length}`)
      .slice(0, 6);
    if (parts.length) return parts.join(", ");
  }
  return text.replace(/\s+/g, " ").slice(0, 300) || `${tool} ok`;
}
