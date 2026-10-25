import { Router } from "express";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Pantry, RawEvidence, type HealthResponse } from "@splice/contracts";
import { config, REPO_ROOT } from "../../config.js";
import { getModel, resolvedModelTable } from "../../models.js";
import { rea } from "../../rea/reaClient.js";
import { collectEvidence } from "../../evidence/collector.js";
import { loadRecordedEvidence } from "../../evidence/replay.js";
import { saveEvidence } from "../../evidence/recorder.js";

export const step1Router = Router();

/**
 * GET /api/health
 * Returns health status conforming to HealthResponse and maintaining backward compatibility.
 */
step1Router.get("/api/health", (_req, res) => {
  const body: HealthResponse & {
    status: string;
    service: string;
    node_env: string;
    models: Record<string, string>;
    timestamp: number;
  } = {
    ok: true,
    status: "ok",
    service: "splice-backend",
    node_env: process.env.NODE_ENV || "development",
    rea: {
      connected: rea.connected,
      version: rea.serverVersion,
      tool_count: rea.toolCount,
    },
    rea_mode: config.reaMode,
    llm_mode: config.llmMode,
    model: getModel("decomp_worker"),
    models: resolvedModelTable(),
    timestamp: Date.now(),
  };
  res.json(body);
});

/**
 * Loads and validates targets/manifest.json against the Pantry schema.
 * Dynamically checks target paths and flips live_supported to false if the file is absent.
 */
export async function loadPantry(): Promise<Pantry> {
  const manifestPath = path.join(REPO_ROOT, "targets/manifest.json");
  if (!fsSync.existsSync(manifestPath)) {
    throw new Error(`Targets manifest not found: ${manifestPath}`);
  }
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const pantry = Pantry.parse(raw);
  for (const app of pantry.apps) {
    const targetAbs = path.join(REPO_ROOT, app.target_path);
    const exists = await fs
      .access(targetAbs)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      app.live_supported = false;
    }
  }
  return pantry;
}

/**
 * GET /api/pantry
 * Returns the target discovery pantry manifest.
 */
step1Router.get("/api/pantry", async (_req, res, next) => {
  try {
    const pantry = await loadPantry();
    res.json(pantry);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/evidence/:feature_id
 * Returns recorded or hand-authored evidence for a given feature.
 */
step1Router.get("/api/evidence/:feature_id", async (req, res) => {
  const { feature_id } = req.params;
  const evidence = await loadRecordedEvidence(feature_id);
  if (!evidence) {
    return res.status(404).json({
      error: `Evidence not found for feature: ${feature_id}`,
      status: 404,
    });
  }
  return res.json(evidence);
});

/**
 * POST /api/evidence/collect
 * Direct evidence collection endpoint with error guards and offline fallback support.
 */
step1Router.post("/api/evidence/collect", async (req, res) => {
  const { app_id, feature_id, force_mode } = req.body ?? {};
  if (!app_id || !feature_id) {
    return res.status(400).json({
      error: "Missing required fields: app_id and feature_id are required",
      status: 400,
    });
  }

  const pantry = await loadPantry();
  const app = pantry.apps.find((a) => a.app_id === app_id);
  if (!app) {
    return res.status(404).json({
      error: `App not found: ${app_id}`,
      status: 404,
    });
  }

  const feature = app.features.find((f) => f.feature_id === feature_id);
  if (!feature) {
    return res.status(404).json({
      error: `Feature not found: ${feature_id} in app ${app_id}`,
      status: 404,
    });
  }

  const mode = force_mode ?? config.reaMode;

  if (mode === "replay") {
    const recorded = await loadRecordedEvidence(feature_id);
    if (!recorded) {
      return res.status(404).json({
        error: `No recorded evidence found for replay of feature ${feature_id}`,
        status: 404,
      });
    }
    return res.json(recorded);
  }

  // Live collection
  const targetAbs = path.join(REPO_ROOT, app.target_path);
  if (!fsSync.existsSync(targetAbs)) {
    return res.status(422).json({
      error: `Target archive not found: ${app.target_path}`,
      status: 422,
    });
  }

  try {
    const evidence = await collectEvidence(app, feature, {
      onStage() {},
      onToolCall() {},
      onToolResult() {},
    });
    await saveEvidence(evidence);
    return res.json(evidence);
  } catch (err) {
    if (config.reaMode === "auto") {
      const recorded = await loadRecordedEvidence(feature_id);
      if (recorded) {
        return res.json(recorded);
      }
    }
    return res.status(500).json({
      error: `Live evidence collection failed: ${(err as Error).message}`,
      status: 500,
    });
  }
});
