// Owner: Eng 2 (Requirements) — routes: /api/extract, /api/specs
// Spec: agents/2_requirements_extraction/01_pipeline_and_route.md §3
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
  try {
    res.json(await listSpecs());
  } catch (e) {
    next(e);
  }
});

step2Router.post("/api/extract", async (req, res) => {
  const parsed = ExtractRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }
  const { app_id, feature_id, force_mode } = parsed.data;

  const pantry = await loadPantry();
  const app = pantry.apps.find((a) => a.app_id === app_id);
  const feature = app?.features.find((f) => f.feature_id === feature_id);
  if (!app || !feature) {
    return res.status(404).json({ error: `unknown ${app_id}/${feature_id}` });
  }

  const sse = openSse(req, res);
  const run_id = newRunId();
  const base = () => ({ run_id, feature_id, ts: Date.now() });

  // Full replay (LLM_MODE=replay or force_mode=replay): re-emit a recorded live run
  const llmMode = force_mode ?? config.llmMode;
  if (llmMode === "replay") {
    const speed = process.env.NODE_ENV === "test" ? 100 : 1;
    const maxGapMs = process.env.NODE_ENV === "test" ? 10 : 2500;
    const ok = await replayTranscript("extract", feature_id, sse, { runId: run_id, speed, maxGapMs });
    if (!ok) {
      sse.send({ type: "error", ...base(), message: `No recording for ${feature_id}`, fatal: true });
      sse.send({ type: "done", ...base(), ok: false, replayed: true });
    }
    return sse.close();
  }

  const transcript = createTranscript("extract", feature_id);
  const emit = (e: PipelineEvent) => {
    sse.send(e);
    transcript.push(e);
  };
  const stage = (stage: PipelineStage, message: string) => emit({ type: "stage", ...base(), stage, message });

  let ok = false;
  let replayedEvidence = false;
  try {
    stage("queued", `Harvesting ${feature.title} from ${app.display_name}`);

    // ---------- Step 1: evidence ----------
    const reaMode = force_mode === "replay" ? "replay" : config.reaMode;
    let evidence: RawEvidence | null = null;
    if (reaMode !== "replay" && app.live_supported) {
      try {
        evidence = await collectEvidence(app, feature, {
          signal: sse.signal,
          onStage: (s, m) => stage(s, m),
          onToolCall: (seq, tool, args_preview) => emit({ type: "tool_call", ...base(), seq, tool, args_preview }),
          onToolResult: (r) =>
            emit({
              type: "tool_result",
              ...base(),
              seq: r.seq,
              tool: r.tool,
              ok: r.ok,
              duration_ms: r.duration_ms,
              summary: r.summary,
              evidence_id: r.evidence_id,
            }),
        });
        await saveEvidence(evidence);
      } catch (e) {
        if (sse.signal.aborted || reaMode === "live") throw e;
        emit({
          type: "error",
          ...base(),
          fatal: false,
          message: `Live REA failed (${(e as Error).message}). Using evidence recorded from an earlier live run.`,
        });
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
      onTestResult: (t) =>
        emit({
          type: "test_result",
          ...base(),
          name: t.name,
          kind: "oracle",
          passed: t.passed,
          error: t.error ?? null,
        }),
    });
    await saveSpec(spec);
    emit({ type: "spec", ...base(), spec });
    stage(
      "complete",
      `${spec.requirements.length} requirements · ${spec.oracle.passed}/${spec.oracle.total} tests pass against original · ${spec.status}`,
    );
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
  emit({
    type: "stage",
    ...base(),
    stage: "analyzing",
    message: `Using REA evidence recorded ${ev.collected_at} (target sha256 ${ev.target.sha256.slice(0, 12)}…)`,
  });
  const delay = process.env.NODE_ENV === "test" ? 0 : 150;
  for (const c of ev.tool_calls) {
    if (signal.aborted) return;
    emit({ type: "tool_call", ...base(), seq: c.seq, tool: c.tool, args_preview: "(recorded)" });
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    emit({
      type: "tool_result",
      ...base(),
      seq: c.seq,
      tool: c.tool,
      ok: c.ok,
      duration_ms: c.duration_ms,
      summary: c.summary,
      evidence_id: c.evidence_id,
    });
  }
}
