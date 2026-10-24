# 05 — Record & Replay (H8–H12)

Replay exists so the demo survives bad wifi, a slow REA cold start, or an API hiccup. It isn't
there to fake results. **Every replay fixture is a recording of a real live run.**

Two layers:

| Layer | File | Recorded by | Replayed when |
|---|---|---|---|
| Evidence | `fixtures/evidence/<feature_id>.json` | collector, after every successful live run | `REA_MODE=replay`, or `auto` after live fails / exceeds budget. **The LLM steps still run live.** |
| Transcript | `fixtures/transcripts/<kind>/<key>.json` | every streaming route (extract, implement, synthesize) | `LLM_MODE=replay`: the whole stream is re-emitted with its original timing |

## 1. `src/evidence/recorder.ts`

```ts
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
        kind, key, recorded_at: new Date(startedAt).toISOString(), events,
      });
    },
  };
}
```

Keys:
- extract → `feature_id` (e.g. `recall.sm2_scheduler`)
- implement → `feature_id`
- synthesize → `sorted feature_ids joined by "+"` + `__` + a short slug of the prompt, e.g.
  `inkwell.wikilink_graph+recall.sm2_scheduler__med-study`. The demo prompt is fixed, so this
  key is stable.

## 2. `src/evidence/replay.ts`

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { RawEvidence } from "@splice/contracts";
import { REPO_ROOT } from "../config.js";
import type { SseWriter } from "../http/sse.js";
import type { TranscriptKind } from "./recorder.js";

const FIX = path.join(REPO_ROOT, "fixtures");

async function readFirst(files: string[]): Promise<unknown | null> {
  for (const f of files) {
    try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { /* try next */ }
  }
  return null;
}

/** Golden → latest → seed. Always returned with mode "replay". */
export async function loadRecordedEvidence(featureId: string): Promise<RawEvidence | null> {
  const raw = await readFirst([
    path.join(FIX, "evidence", `${featureId}.json`),
    path.join(FIX, "evidence", `${featureId}.latest.json`),
    path.join(FIX, "evidence", "_seed", `${featureId}.json`),
  ]);
  if (!raw) return null;
  return { ...RawEvidence.parse(raw), mode: "replay" };
}

/** Marks every result object in a replayed event as replay so the UI shows the badge. */
function markReplay(e: any, runId: string): any {
  const out = { ...structuredClone(e), run_id: runId, ts: Date.now() };
  if (out.type === "spec") out.spec.provenance.mode = "replay";
  if (out.type === "blueprint") {
    out.blueprint.spec.provenance.mode = "replay";
    out.blueprint.verification.mode = "replay";
  }
  if (out.type === "bundle") out.bundle.mode = "replay";
  if (out.type === "done") out.replayed = true;
  return out;
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
  const rec = (await readFirst([
    path.join(FIX, "transcripts", kind, `${key}.json`),
    path.join(FIX, "transcripts", kind, `${key}.latest.json`),
  ])) as { events: { ts: number }[] } | null;
  if (!rec) return false;
  const speed = opts.speed ?? 1;
  const maxGap = opts.maxGapMs ?? 2500;
  let prevTs = rec.events[0]?.ts ?? 0;
  for (const e of rec.events) {
    if (sse.signal.aborted) return true;
    const gap = Math.min((e.ts - prevTs) / speed, maxGap);
    prevTs = e.ts;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    sse.send(markReplay(e, opts.runId));
  }
  return true;
}
```

The 2.5 s gap cap matters: a 40 s Claude call replays as a 2.5 s pause. Replays are faster
than live, which is fine, but say so if asked.

## 3. Promote fixtures — `src/scripts/promoteFixtures.ts`

```ts
// npm run fixtures:promote -- recall.sm2_scheduler   (or no arg = all *.latest.json)
import fs from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "../config.js";

const only = process.argv[2];
const roots = ["evidence", "transcripts/extract", "transcripts/implement", "transcripts/synthesize", "specs", "blueprints", "bundles"]
  .map((d) => path.join(REPO_ROOT, "fixtures", d));
for (const dir of roots) {
  let files: string[] = [];
  try { files = await fs.readdir(dir); } catch { continue; }
  for (const f of files.filter((f) => f.endsWith(".latest.json"))) {
    if (only && !f.startsWith(only)) continue;
    const golden = f.replace(".latest.json", ".json");
    await fs.copyFile(path.join(dir, f), path.join(dir, golden));
    console.log("promoted", path.relative(REPO_ROOT, path.join(dir, golden)));
  }
}
```

Rules:
- `*.latest.json` is gitignored. Golden `*.json` is committed.
- Promote only after a human has looked at the result (for example, the spec's requirements read
  correctly and the engine card shows "N/N passing").
- After the H18 freeze, nobody promotes without telling the team.

## 4. `src/scripts/recordAll.ts` — record every live feature's evidence

```ts
import { Pantry } from "@splice/contracts";
import fs from "node:fs/promises";
import path from "node:path";
import { collectEvidence } from "../evidence/collector.js";
import { saveEvidence } from "../evidence/recorder.js";
import { rea } from "../rea/reaClient.js";
import { REPO_ROOT } from "../config.js";

const pantry = Pantry.parse(JSON.parse(await fs.readFile(path.join(REPO_ROOT, "targets/manifest.json"), "utf8")));
for (const app of pantry.apps.filter((a) => a.live_supported)) {
  for (const f of app.features) {
    const t0 = Date.now();
    const ev = await collectEvidence(app, f, {
      onStage: (s, m) => console.log(`  [${s}] ${m}`),
      onToolCall: (n, tool, a) => console.log(`  → #${n} ${tool} ${a}`),
      onToolResult: (r) => console.log(`  ← #${r.seq} ${r.ok ? "ok" : "FAIL"} ${r.duration_ms}ms ${r.summary}`),
    });
    await saveEvidence(ev);
    console.log(`✓ ${f.feature_id}: ${ev.tool_calls.length} calls, ${ev.snippets.length} snippets, ${ev.unknowns.length} unknowns, ${Date.now() - t0}ms\n`);
  }
}
await rea.close();
```

## 5. `.gitignore` additions

```
fixtures/**/*.latest.json
```
