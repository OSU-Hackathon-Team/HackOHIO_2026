// UI-triggered native decompilation runs on the EC2 worker (see src/decomp/runs.ts).
// Disabled unless DECOMP_EC2_ENABLED=1 with DECOMP_EC2_INSTANCE_ID and DECOMP_EC2_BUCKET set.

import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { REPO_ROOT, config } from "../config.js";
import { ec2Worker } from "../decomp/ec2.js";
import { buildPayload } from "../decomp/payload.js";
import { DecompRunService, HttpError } from "../decomp/runs.js";
import { openSse } from "../http/sse.js";
import { nativeLibraryStore, publishImportedAnalysis } from "../decomp/library.js";

export function defaultDecompRunService(): DecompRunService {
  const enabled = process.env.DECOMP_EC2_ENABLED === "1";
  const instanceId = process.env.DECOMP_EC2_INSTANCE_ID, bucket = process.env.DECOMP_EC2_BUCKET;
  const library = nativeLibraryStore();
  const stateDir = path.resolve(process.env.DECOMP_STATE_DIR ?? path.join(REPO_ROOT, "decomp-state"));
  if (enabled && (!instanceId || !bucket)) {
    console.warn("[decomp] DECOMP_EC2_ENABLED=1 but DECOMP_EC2_INSTANCE_ID / DECOMP_EC2_BUCKET are missing; runs disabled");
  }
  return new DecompRunService({
    worker: enabled && instanceId && bucket ? ec2Worker({ region: config.awsRegion, instanceId, bucket,
      cacheEnabled: process.env.DECOMP_CACHE_ENABLED === "1" }) : null,
    stateDir,
    repoRoot: REPO_ROOT,
    // Bash on the worker rejects CRLF; a Windows checkout may still have it.
    runnerScript: async () => (await fs.readFile(path.join(REPO_ROOT, "infra", "decomp-ec2", "run-scoped-pipeline.sh"), "utf8"))
      .replace(/\r\n/g, "\n"),
    buildPayload: (outFile) => buildPayload(REPO_ROOT, outFile),
    publishAnalysis: library ? (run, result, progress) => {
      if (!result.handoff_path) throw new Error("run has no public handoff to publish");
      return publishImportedAnalysis(library, run, result, stateDir, path.join(REPO_ROOT, result.handoff_path), progress);
    } : undefined,
  });
}

export function decompRunsRouter(service: DecompRunService = defaultDecompRunService()): Router {
  const router = Router();
  const ready = service.init();

  router.get("/api/decomp/targets", async (_req, res) => {
    await ready;
    res.json({ enabled: service.enabled, targets: service.targets() });
  });

  router.get("/api/decomp/runs", async (_req, res) => {
    await ready;
    res.json({ runs: service.list() });
  });

  router.post("/api/decomp/runs", async (req, res) => {
    await ready;
    try {
      res.status(202).json({ run: await service.start(req.body) });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      res.status(status).json({ error: (error as Error).message });
    }
  });

  router.get("/api/decomp/runs/:id", async (req, res) => {
    await ready;
    const record = service.get(req.params.id);
    if (!record) return res.status(404).json({ error: "run not found" });
    return res.json({ run: record.run });
  });

  // Replays the run's history, then streams live events until "done".
  router.get("/api/decomp/runs/:id/events", async (req, res) => {
    await ready;
    const record = service.get(req.params.id);
    if (!record) return res.status(404).json({ error: "run not found" });
    const sse = openSse(req, res);
    for (const event of record.events) sse.send(event);
    if (record.run.finished_at !== null) return sse.close();
    const unsubscribe = service.subscribe(req.params.id, (event) => {
      sse.send(event);
      if (event.type === "done") { unsubscribe(); sse.close(); }
    });
    sse.signal.addEventListener("abort", unsubscribe);
  });

  return router;
}
