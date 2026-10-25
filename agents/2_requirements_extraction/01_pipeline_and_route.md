# 01 — `/api/extract` Pipeline & Route

One POST streams the whole REA → requirements journey for **one** feature. The frontend calls
it once per selected feature, then hands the resulting spec to Eng 3's `/api/implement`.

## 1. Event sequence the UI will see (live, happy path)

```
stage        queued           "Harvesting SM-2 spaced repetition from Recall Flashcards"
stage        connecting       "Connecting to REA (rea-agents MCP)…"
stage        analyzing        "Analyzing Recall Flashcards — app.asar (6,412 bytes)"
tool_call    #1 analyze_javascript_application {"path":"…app.asar","detail":"summary"}
tool_result  #1 ok 2140ms "modules: 6, relations: 9"  ev_3f…
stage        tracing          "Tracing "SM-2 spaced repetition" from src/scheduler/sm2.js"
tool_call    #2 trace_application_feature …
tool_result  #2 ok 880ms  "…"  ev_91…
stage        reading_source   "Reading located modules from the archive…"
stage        specifying       "Deriving requirements from 3 modules (2 glue modules will be stripped)"
llm_progress specifying 1200 … 9800 (throttled, ~every 400ms)
stage        checking_oracle  "Running 7 acceptance tests against the ORIGINAL sm2.js via adapter"
test_result  oracle "REQ-1 REQ-6: first successful review is due tomorrow" ✓
…            (one per test)
stage        repairing_spec   (only if something failed; then specifying/checking_oracle again)
spec         { FeatureSpec }
stage        complete         "8 requirements · 7/7 tests pass against original · verified"
done         ok=true replayed=false
```

## 2. `src/spec/store.ts`

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { FeatureSpec } from "@splice/contracts";
import { REPO_ROOT } from "../config.js";

const DIR = path.join(REPO_ROOT, "fixtures/specs");

export async function saveSpec(spec: FeatureSpec) {
  if (spec.provenance.mode !== "live") return;   // replay-derived specs are not re-saved
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${spec.feature_id}.latest.json`), JSON.stringify(spec, null, 2));
}

/** Golden specs first, then _seed. One per feature_id. */
export async function listSpecs(): Promise<FeatureSpec[]> {
  const out = new Map<string, FeatureSpec>();
  for (const dir of [DIR, path.join(DIR, "_seed")]) {
    let files: string[] = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files.filter((f) => f.endsWith(".json") && !f.endsWith(".latest.json"))) {
      const spec = FeatureSpec.parse(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
      if (!out.has(spec.feature_id)) out.set(spec.feature_id, { ...spec, provenance: { ...spec.provenance, mode: "replay" } });
    }
  }
  return [...out.values()];
}
```

## 3. `src/routes/step2/index.ts`

```ts
import { Router } from "express";
import { ExtractRequest, type PipelineEvent, type PipelineStage, type RawEvidence } from "@splice/contracts";
import { config } from "../../config.js";
import { openSse, newRunId } from "../../http/sse.js";
import { loadPantry } from "../step1/index.js";
import { collectEvidence } from "../../evidence/collector.js";
import { saveEvidence, createTranscript } from "../../evidence/recorder.js";
import { loadRecordedEvidence, replayTranscript } from "../../evidence/replay.js";
import { buildSpec } from "../../spec/buildSpec.js";
import { saveSpec, listSpecs } from "../../spec/store.js";

export const step2Router = Router();

step2Router.get("/api/specs", async (_req, res, next) => {
  try { res.json(await listSpecs()); } catch (e) { next(e); }
});

step2Router.post("/api/extract", async (req, res) => {
  const parsed = ExtractRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { app_id, feature_id, force_mode } = parsed.data;

  const pantry = await loadPantry();
  const app = pantry.apps.find((a) => a.app_id === app_id);
  const feature = app?.features.find((f) => f.feature_id === feature_id);
  if (!app || !feature) return res.status(404).json({ error: `unknown ${app_id}/${feature_id}` });

  const sse = openSse(req, res);
  const run_id = newRunId();
  const base = () => ({ run_id, feature_id, ts: Date.now() });

  // Full replay (LLM_MODE=replay): re-emit a recorded live run, timing included
  const llmMode = force_mode === "replay" ? "replay" : config.llmMode;
  if (llmMode === "replay") {
    const ok = await replayTranscript("extract", feature_id, sse, { runId: run_id });
    if (!ok) {
      sse.send({ type: "error", ...base(), message: `No recording for ${feature_id}`, fatal: true });
      sse.send({ type: "done", ...base(), ok: false, replayed: true });
    }
    return sse.close();
  }

  const transcript = createTranscript("extract", feature_id);
  const emit = (e: PipelineEvent) => { sse.send(e); transcript.push(e); };
  const stage = (stage: PipelineStage, message: string) => emit({ type: "stage", ...base(), stage, message });

  let ok = false;
  let replayedEvidence = false;
  try {
    stage("queued", `Harvesting ${feature.title} from ${app.display_name}`);

    // ---------- Step 1: evidence ----------
    const reaMode = force_mode ?? config.reaMode;
    let evidence: RawEvidence | null = null;
    if (reaMode !== "replay" && app.live_supported) {
      try {
        evidence = await collectEvidence(app, feature, {
          signal: sse.signal,
          onStage: (s, m) => stage(s, m),
          onToolCall: (seq, tool, args_preview) => emit({ type: "tool_call", ...base(), seq, tool, args_preview }),
          onToolResult: (r) => emit({ type: "tool_result", ...base(), seq: r.seq, tool: r.tool, ok: r.ok,
                                      duration_ms: r.duration_ms, summary: r.summary, evidence_id: r.evidence_id }),
        });
        await saveEvidence(evidence);
      } catch (e) {
        if (sse.signal.aborted || reaMode === "live") throw e;
        emit({ type: "error", ...base(), fatal: false,
               message: `Live REA failed (${(e as Error).message}). Using evidence recorded from an earlier live run.` });
      }
    }
    if (!evidence) {
      evidence = await loadRecordedEvidence(feature_id);
      if (!evidence) throw new Error(`No recorded evidence for ${feature_id}`);
      replayedEvidence = true;
      await replayRecordedCalls(evidence, emit, base, sse.signal);
    }

    // ---------- Step 2: requirements ----------
    const spec = await buildSpec(evidence, app, feature, {
      signal: sse.signal,
      onStage: (s, m) => stage(s, m),
      onProgress: (phase, output_chars) => emit({ type: "llm_progress", ...base(), phase, output_chars }),
      onTestResult: (t) => emit({ type: "test_result", ...base(), name: t.name, kind: "oracle", passed: t.passed, error: t.error }),
    });
    await saveSpec(spec);
    emit({ type: "spec", ...base(), spec });
    stage("complete", `${spec.requirements.length} requirements · ${spec.oracle.passed}/${spec.oracle.total} tests pass against original · ${spec.status}`);
    ok = true;
  } catch (e) {
    if (!sse.signal.aborted) {
      emit({ type: "stage", ...base(), stage: "failed", message: (e as Error).message });
      emit({ type: "error", ...base(), message: (e as Error).message, fatal: true });
    }
  } finally {
    emit({ type: "done", ...base(), ok, replayed: replayedEvidence });
    if (!replayedEvidence) await transcript.save(ok);
    sse.close();
  }
});

/** Shows the recorded REA calls quickly, so the terminal tells the true story of where the evidence came from. */
async function replayRecordedCalls(
  ev: RawEvidence,
  emit: (e: PipelineEvent) => void,
  base: () => { run_id: string; feature_id: string; ts: number },
  signal: AbortSignal,
) {
  emit({ type: "stage", ...base(), stage: "analyzing", message: `Using REA evidence recorded ${ev.collected_at} (target sha256 ${ev.target.sha256.slice(0, 12)}…)` });
  for (const c of ev.tool_calls) {
    if (signal.aborted) return;
    emit({ type: "tool_call", ...base(), seq: c.seq, tool: c.tool, args_preview: "(recorded)" });
    await new Promise((r) => setTimeout(r, 150));
    emit({ type: "tool_result", ...base(), seq: c.seq, tool: c.tool, ok: c.ok, duration_ms: c.duration_ms, summary: c.summary, evidence_id: c.evidence_id });
  }
}
```

## 4. Mode matrix (what actually happens)

| `REA_MODE` | `LLM_MODE` | Evidence | Spec | Badge in UI |
|---|---|---|---|---|
| live | live | live REA | live Claude | none |
| auto | live | live; recorded if REA fails or takes > 45 s | live Claude | `REPLAY` on evidence only if fallback used |
| replay | live | recorded | live Claude | `REPLAY` (evidence) |
| any | replay | – | whole recorded stream | `REPLAY` |

Demo default: `REA_MODE=auto`, `LLM_MODE=live`. If venue internet is bad: `LLM_MODE=replay`.

## 5. Gotchas

- **Never retry a live Claude call silently in the route.** Retries happen inside
  `structuredCall` (the SDK retries 429/5xx twice). Visible repairs happen in `buildSpec`.
- Pass `sse.signal` everywhere. If a judge clicks away, the Claude stream and REA call are
  cancelled instead of burning tokens.
- `express.json({ limit: "10mb" })` is already set by Eng 1. Specs with full snippets can be 100+ KB.
