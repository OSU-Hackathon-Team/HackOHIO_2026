// Turns the worker's progress.jsonl and console log into UI stages. Console lines like
// "[claims] 40 functions, 2 workers" come from scripts/lo_pipeline.py; progress.jsonl events from
// the engine (semantic_finished / review_finished per function).

import type { DecompStage } from "@splice/contracts";

export interface ProgressSnapshot {
  stage: DecompStage | null;
  message: string | null;
  claims: { total: number; drafted: number; reviewed: number } | null;
  lines: string[]; // stage lines from the console, in order
}

const TAGS: Record<string, DecompStage> = {
  setup: "setup", triage: "triage", analyze: "analyze", scope: "scope",
  claims: "claims", oracle: "oracle", dossier: "dossier", spec: "spec",
};

export function parseProgress(progressJsonl: string, consoleLog: string): ProgressSnapshot {
  const lines = consoleLog.split(/\r?\n/).filter((line) => /^\[[a-z]+\] /.test(line));
  let stage: DecompStage | null = null;
  let message: string | null = null;
  let total = 0;
  for (const line of lines) {
    const tag = TAGS[line.slice(1, line.indexOf("]"))];
    if (!tag) continue;
    stage = tag;
    message = line.slice(line.indexOf("]") + 2);
    const functions = /^\[claims\] (\d+) functions/.exec(line);
    if (functions) total = Number(functions[1]);
  }
  // Scoped Ghidra preparation reports through progress.jsonl, not the console.
  const drafted = new Set<string>(), reviewed = new Set<string>();
  let preparing = false;
  for (const raw of progressJsonl.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let event: { stage?: string; subject?: string };
    try { event = JSON.parse(raw); } catch { continue; }
    if ((event.stage === "semantic_finished" || event.stage === "semantic_cache_hit") && event.subject) drafted.add(event.subject);
    if ((event.stage === "review_finished" || event.stage === "review_cache_hit") && event.subject) reviewed.add(event.subject);
    if (event.stage === "scoped_prepare_started") preparing = true;
  }
  if (preparing && (stage === null || stage === "triage")) {
    stage = "analyze";
    message = "Scoped Ghidra preparation";
  }
  return { stage, message, claims: total ? { total, drafted: drafted.size, reviewed: reviewed.size } : null, lines };
}
