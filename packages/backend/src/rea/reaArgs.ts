import type { ReaSeed } from "@splice/contracts";

export const reaArgs = {
  session: () => ({}),

  /** analyze_javascript_application — input_path is ABSOLUTE (dir or .asar).
   *  With detail "summary" the reply is a SUMMARY record: pass its normalized_result.parent_evidence_id
   *  (the retained full analysis) to follow-up tools, NOT its own evidence_id (trace rejects that). */
  analyzeApp: (absPath: string) => ({
    input_path: absPath,
    format: absPath.endsWith(".asar") ? "asar" : "directory",
    detail: "summary",
  }),

  /** trace_application_feature — module seed e.g. "src/graph/backlinks.js" */
  traceFeature: (applicationEvidenceId: string, seed: ReaSeed) => ({
    application: { kind: "retained-evidence", evidence_id: applicationEvidenceId },
    seed: { kind: seed.kind, value: seed.value, match: "exact" },
  }),

  /** trace_javascript_semantics — required: application, query */
  traceSemantics: (applicationEvidenceId: string, symbol: string) => ({
    application: { kind: "retained-evidence", evidence_id: applicationEvidenceId },
    query: { kind: "text", value: symbol },
  }),

  /** inspect_analysis_view — required: source, view */
  inspectView: (parentEvidenceId: string, view: Record<string, unknown> = { kind: "summary" }) => ({
    source: { kind: "retained-evidence", evidence_id: parentEvidenceId },
    view,
  }),
} as const;

/** Called once at startup: fail fast if a builder sends an arg the server doesn't know. */
export function checkArgsAgainstCatalog(tools: { name: string; inputSchema: any }[]) {
  const probes: [string, Record<string, unknown>][] = [
    ["analyze_javascript_application", reaArgs.analyzeApp("/x")],
    ["trace_application_feature", reaArgs.traceFeature("ev_x", { kind: "module", value: "x" })],
  ];
  const problems: string[] = [];
  for (const [name, args] of probes) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      problems.push(`missing tool ${name}`);
      continue;
    }
    const props = Object.keys(tool.inputSchema?.properties ?? {});
    for (const k of Object.keys(args)) {
      if (!props.includes(k)) {
        problems.push(`${name}: unknown arg "${k}" (has: ${props.join(", ")})`);
      }
    }
    for (const r of tool.inputSchema?.required ?? []) {
      if (!(r in args)) {
        problems.push(`${name}: missing required "${r}"`);
      }
    }
  }
  if (problems.length) {
    console.warn("[rea] argument/catalog mismatch:\n  " + problems.join("\n  "));
  }
  return problems;
}
