// Owner: Eng 3 (Implementation) — routes: /api/implement, /api/blueprints, /api/synthesize, /api/refine
// Spec: agents/3_feature_implementation/01_engine_implementation.md §6, 02_ui_synthesis.md §7, 04_refine_and_autofix.md
// Only Eng 3 edits this file; server.ts just mounts it.
// Implementation note: built by createStep3Router(deps) so the routes run against injected helpers;
// requests are validated (400) before any stream opens, and missing upstream helpers give 503.
import { Router, type Response } from "express";
import { builderRouter } from "../../builder/edits.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  FeatureBlueprint, ImplementRequest, RefineRequest, SynthesizeRequest,
  type PipelineEvent, type PipelineStage, type SynthEvent,
} from "@splice/contracts";
import { implementEngine } from "../../engine/implement.js";
import { fusionErrors, synthesize, type SynthHooks } from "../../synthesis/synthesize.js";
import { refine, refineRequestErrors } from "../../synthesis/refine.js";
import { MISSING_UPSTREAM, REPO_ROOT, step3Deps, type SseWriterPort, type Step3Deps } from "./deps.js";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** skillsVersion keeps recordings made with a different skill set from being replayed. */
export const synthesisKey = (featureIds: string[], prompt: string, skillsVersion?: string) =>
  `${[...featureIds].sort().join("+")}__${slug(prompt)}${skillsVersion ? `__skills-${skillsVersion}` : ""}`;
export const refineKey = (bundleId: string, revision: number) => `refine__${bundleId}__r${revision}`;

const unavailable = (res: Response) =>
  res.status(503).json({ error: "Step 3 streaming routes are not wired yet: upstream helpers are still stubs", missing: MISSING_UPSTREAM });

export function createStep3Router(
  deps: Step3Deps | null,
  opts: { blueprintsDir?: string } = {},
): Router {
  const router = Router();
  const BP_DIR = opts.blueprintsDir ?? path.join(REPO_ROOT, "fixtures/blueprints");

  router.get("/api/blueprints", async (_req, res, next) => {
    try {
      const out = new Map<string, FeatureBlueprint>();
      for (const dir of [BP_DIR, path.join(BP_DIR, "_seed")]) {
        let files: string[] = [];
        try { files = await fs.readdir(dir); } catch { continue; }
        for (const f of files.filter((f) => f.endsWith(".json") && !f.endsWith(".latest.json"))) {
          const bp = FeatureBlueprint.parse(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
          if (!out.has(bp.feature_id)) out.set(bp.feature_id, bp);
        }
      }
      res.json([...out.values()]);
    } catch (e) { next(e); }
  });

  router.post("/api/implement", async (req, res) => {
    const parsed = ImplementRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    if (!deps) return unavailable(res);
    const { spec, force_mode } = parsed.data;
    const feature_id = spec.feature_id;
    const sse = deps.openSse(req, res);
    const run_id = deps.newRunId();
    const base = () => ({ run_id, feature_id, ts: Date.now() });

    const send = (e: PipelineEvent) => sse.send(e);

    if ((force_mode ?? deps.llmMode()) === "replay") {
      const ok = await deps.replayTranscript("implement", feature_id, sse, { runId: run_id });
      if (!ok) {
        send({ type: "error", ...base(), message: `No recording for ${feature_id}`, fatal: true });
        send({ type: "done", ...base(), ok: false, replayed: true });
      }
      return sse.close();
    }

    const transcript = deps.createTranscript("implement", feature_id);
    const emit = (e: PipelineEvent) => { send(e); transcript.push(e); };
    const stage = (stage: PipelineStage, message: string) => emit({ type: "stage", ...base(), stage, message });
    let ok = false;
    try {
      const bp = await implementEngine(spec, {
        signal: sse.signal,
        onStage: stage,
        onProgress: (phase, output_chars) => emit({ type: "llm_progress", ...base(), phase, output_chars }),
        onTestResult: (t) => emit({ type: "test_result", ...base(), name: t.name, kind: "acceptance", passed: t.passed, error: t.error }),
      }, deps);
      await fs.mkdir(BP_DIR, { recursive: true });
      await fs.writeFile(path.join(BP_DIR, `${feature_id}.latest.json`), JSON.stringify(bp, null, 2));
      emit({ type: "blueprint", ...base(), blueprint: bp });
      stage(bp.verification.status === "passed" ? "complete" : "failed",
        `Engine ${bp.implementation.module_name}: ${bp.verification.passed}/${bp.verification.total} acceptance tests passing`);
      ok = bp.verification.status === "passed";
    } catch (e) {
      if (!sse.signal.aborted) emit({ type: "error", ...base(), message: (e as Error).message, fatal: true });
    } finally {
      emit({ type: "done", ...base(), ok, replayed: false });
      await transcript.save(ok);
      sse.close();
    }
  });

  /** Shared body of /api/synthesize and /api/refine: replay or live, one terminal `done`. */
  async function streamSynth(
    deps: Step3Deps,
    sse: SseWriterPort,
    key: string,
    run: (hooks: SynthHooks, emit: (e: SynthEvent) => void, base: () => { run_id: string; ts: number }) => Promise<void>,
  ) {
    const run_id = deps.newRunId();
    const base = () => ({ run_id, ts: Date.now() });
    const send = (e: SynthEvent) => sse.send(e);

    if (deps.llmMode() === "replay") {
      if (!(await deps.replayTranscript("synthesize", key, sse, { runId: run_id }))) {
        send({ type: "error", ...base(), message: `No recording for "${key}"`, fatal: true });
        send({ type: "done", ...base(), ok: false });
      }
      return sse.close();
    }

    const transcript = deps.createTranscript("synthesize", key);
    const emit = (e: SynthEvent) => { send(e); transcript.push(e); };
    let ok = false;
    try {
      await run({
        signal: sse.signal,
        onStage: (stage, message) => emit({ type: "stage", ...base(), stage, message }),
        onProgress: (output_chars) => emit({ type: "llm_progress", ...base(), output_chars }),
        onValidation: (valid, errors) => emit({ type: "validation", ...base(), ok: valid, errors }),
      }, emit, base);
      ok = true;
    } catch (e) {
      if (!sse.signal.aborted) emit({ type: "error", ...base(), message: (e as Error).message, fatal: true });
    } finally {
      emit({ type: "done", ...base(), ok });
      await transcript.save(ok);
      sse.close();
    }
  }

  router.post("/api/synthesize", async (req, res) => {
    const parsed = SynthesizeRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { blueprints, prompt } = parsed.data;
    const invalid = fusionErrors(blueprints);
    if (invalid.length) return res.status(400).json({ error: invalid.join("; ") });
    if (!deps) return unavailable(res);

    const sse = deps.openSse(req, res);
    await streamSynth(deps, sse, synthesisKey(blueprints.map((b) => b.feature_id), prompt, deps.skills?.version), async (hooks, emit, base) => {
      const bundle = await synthesize(blueprints, prompt, `b_${base().run_id}`, hooks, deps);
      emit({ type: "bundle", ...base(), bundle });
      emit({ type: "stage", ...base(), stage: "complete", message: `${bundle.app_title}: ${bundle.generated_paths.length} files around ${bundle.engine_paths.length} engines` });
    });
  });

  router.post("/api/refine", async (req, res) => {
    const parsed = RefineRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const invalid = refineRequestErrors(parsed.data);
    if (invalid.length) return res.status(400).json({ error: invalid.join("; ") });
    if (!deps) return unavailable(res);

    const r = parsed.data;
    const sse = deps.openSse(req, res);
    await streamSynth(deps, sse, refineKey(r.bundle.bundle_id, r.bundle.revision), async (hooks, emit, base) => {
      let summary = "";
      const bundle = await refine(r, { ...hooks, onSummary: (s) => (summary = s) }, deps);
      emit({ type: "bundle", ...base(), bundle });
      // The chat panel shows the last "complete" message as the assistant's reply (04 §2).
      emit({ type: "stage", ...base(), stage: "complete", message: summary });
    });
  });

  return router;
}

export const step3Router = createStep3Router(step3Deps);
step3Router.use(builderRouter);
