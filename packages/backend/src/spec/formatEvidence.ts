// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/03_requirements_prompt.md §3
import type { RawEvidence, PantryApp, PantryFeature } from "@splice/contracts";

export function snippetPath(location: string): string {
  // "app.asar:src/graph/backlinks.js" → "src/graph/backlinks.js"
  const i = location.indexOf(":");
  return i >= 0 ? location.slice(i + 1) : location;
}

export function withLineNumbers(code: string): string {
  const lines = code.split(/\r?\n/);
  const w = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(w)} | ${l}`).join("\n");
}

export function formatEvidence(ev: RawEvidence, app: PantryApp, feature: PantryFeature): string {
  const calls = ev.tool_calls
    .map(
      (c) =>
        `#${c.seq} ${c.tool} ${c.ok ? "ok" : "FAILED"} ${c.duration_ms}ms — ${c.summary}${
          c.evidence_id ? ` (evidence ${c.evidence_id.slice(0, 15)}…)` : ""
        }`,
    )
    .join("\n");

  const sources = ev.snippets
    .map(
      (s) =>
        `<source path="${snippetPath(s.location)}" symbol="${s.symbol ?? ""}" full_module="${s.full_module}">\n${withLineNumbers(
          s.code,
        )}\n</source>`,
    )
    .join("\n\n");

  return `<feature>
app: ${app.display_name} (${app.app_id}), artifact: ${ev.target.artifact_type}, sha256: ${ev.target.sha256.slice(0, 16)}…
feature_id: ${feature.feature_id}
title: ${feature.title}
question: ${feature.query}
</feature>

<symbols>
${feature.symbols.join(", ")}
</symbols>

<rea_trace>
${calls || "(evidence recorded earlier; no live calls in this run)"}
limitations: ${ev.limitations.join(" | ") || "none reported"}
unknowns: ${ev.unknowns.join(" | ") || "none reported"}
</rea_trace>

${sources}

Write the specification for this feature.`;
}
