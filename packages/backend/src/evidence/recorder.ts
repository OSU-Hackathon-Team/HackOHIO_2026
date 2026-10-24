import fs from "node:fs/promises";
import path from "node:path";
import type { RawEvidence } from "@splice/contracts";
import { REPO_ROOT } from "../config.js";

const FIX = path.join(REPO_ROOT, "fixtures");

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

/** Save live evidence. `.latest.json` is overwritten every run; promote to golden with fixtures:promote. */
export async function saveEvidence(ev: RawEvidence) {
  if (ev.mode !== "live") return;
  await writeJson(path.join(FIX, "evidence", `${ev.feature_id}.latest.json`), ev);
}

export type TranscriptKind = "extract" | "implement" | "synthesize";

export interface Transcript {
  push(event: { type: string; ts: number }): void;
  /** Writes `<key>.latest.json` only if the run succeeded. */
  save(ok: boolean): Promise<void>;
}

export function createTranscript(kind: TranscriptKind, key: string): Transcript {
  const events: unknown[] = [];
  const startedAt = Date.now();
  return {
    push: (e) => events.push(structuredClone(e)),
    save: async (ok) => {
      if (!ok || events.length === 0) return;
      await writeJson(path.join(FIX, "transcripts", kind, `${key}.latest.json`), {
        kind,
        key,
        recorded_at: new Date(startedAt).toISOString(),
        events,
      });
    },
  };
}
