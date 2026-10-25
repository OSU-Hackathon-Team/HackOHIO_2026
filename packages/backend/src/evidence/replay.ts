import fs from "node:fs/promises";
import path from "node:path";
import { RawEvidence, FeatureBlueprint } from "@splice/contracts";
import { REPO_ROOT } from "../config.js";
import type { SseWriter } from "../http/sse.js";
import type { TranscriptKind } from "./recorder.js";
import { loadRecordedSpec } from "../spec/store.js";

const FIX = path.join(REPO_ROOT, "fixtures");

async function readFirst(files: string[]): Promise<unknown | null> {
  for (const f of files) {
    try {
      return JSON.parse(await fs.readFile(f, "utf8"));
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Golden → latest → seed → hand-authored. Always returned with mode "replay". */
export async function loadRecordedEvidence(featureId: string): Promise<RawEvidence | null> {
  const raw = await readFirst([
    path.join(FIX, "evidence", `${featureId}.json`),
    path.join(FIX, "evidence", `${featureId}.latest.json`),
    path.join(FIX, "hand-authored", "evidence", `${featureId}.json`),
    path.join(FIX, "evidence", "_seed", `${featureId}.json`),
    ...(featureId === "mockpriority.priority_score"
      ? [path.join(FIX, "test-run", "mock_decompiled_evidence.json")]
      : []),
  ]);
  if (!raw) return null;
  return { ...RawEvidence.parse(raw), mode: "replay" };
}

/** Marks every result object in a replayed event as replay so the UI shows the badge. */
function markReplay(e: any, runId: string): any {
  const out = { ...structuredClone(e), run_id: runId, ts: Date.now() };
  if (out.type === "spec" && out.spec?.provenance) {
    out.spec.provenance.mode = "replay";
  }
  if (out.type === "blueprint") {
    if (out.blueprint?.spec?.provenance) out.blueprint.spec.provenance.mode = "replay";
    if (out.blueprint?.verification) out.blueprint.verification.mode = "replay";
  }
  if (out.type === "bundle" && out.bundle) {
    out.bundle.mode = "replay";
  }
  if (out.type === "done") {
    out.replayed = true;
  }
  return out;
}

/** Golden → latest → hand-authored → seed. */
export async function loadRecordedBlueprint(featureId: string): Promise<FeatureBlueprint | null> {
  const raw = await readFirst([
    path.join(FIX, "blueprints", `${featureId}.json`),
    path.join(FIX, "blueprints", `${featureId}.latest.json`),
    path.join(FIX, "hand-authored", "blueprints", `${featureId}.json`),
    path.join(FIX, "blueprints", "_seed", `${featureId}.json`),
  ]);
  if (!raw) return null;
  try {
    const bp = FeatureBlueprint.parse(raw);
    return {
      ...bp,
      verification: { ...bp.verification, mode: "replay" },
    };
  } catch {
    return null;
  }
}

/**
 * Re-emits a recorded stream with the original gaps (scaled by `speed`, each capped at maxGapMs).
 * Returns false if no recording exists.
 */
export async function replayTranscript(
  kind: TranscriptKind,
  key: string,
  sse: SseWriter,
  opts: { runId: string; speed?: number; maxGapMs?: number },
): Promise<boolean> {
  const raw = await readFirst([
    path.join(FIX, "transcripts", kind, `${key}.json`),
    path.join(FIX, "transcripts", kind, `${key}.latest.json`),
    path.join(FIX, "hand-authored", "transcripts", `${key}.json`),
  ]);
  if (!raw) return false;

  const rawEvents = Array.isArray(raw) ? raw : (raw as { events: { ts: number }[] }).events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) return false;

  const speed = opts.speed ?? 1;
  const maxGap = opts.maxGapMs ?? 2500;
  let prevTs = rawEvents[0]?.ts ?? 0;

  const hasSpec = rawEvents.some((e: any) => e.type === "spec");
  const hasBlueprint = rawEvents.some((e: any) => e.type === "blueprint");

  for (const e of rawEvents) {
    if (sse.signal.aborted) return true;
    if (e.type === "done" && !hasSpec && kind === "extract") {
      const spec = await loadRecordedSpec(key);
      if (spec) {
        sse.send(markReplay({ type: "spec", run_id: opts.runId, feature_id: key, ts: Date.now(), spec }, opts.runId));
      }
    }
    if (e.type === "done" && !hasBlueprint && kind === "implement") {
      const blueprint = await loadRecordedBlueprint(key);
      if (blueprint) {
        sse.send(markReplay({ type: "blueprint", run_id: opts.runId, feature_id: key, ts: Date.now(), blueprint }, opts.runId));
      }
    }
    const gap = Math.min((e.ts - prevTs) / speed, maxGap);
    prevTs = e.ts;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    sse.send(markReplay(e, opts.runId));
  }
  return true;
}
