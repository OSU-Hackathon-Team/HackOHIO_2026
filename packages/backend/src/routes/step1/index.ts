// Owner: Eng 1 (REA) — routes: /api/health, /api/pantry
// Spec: agents/1_reverse_engineering/06_backend_server_shell.md §4
// Only Eng 1 edits this file; server.ts just mounts it.
import { Router } from "express";
import { getModel, resolvedModelTable } from "../../models.js";

export const step1Router = Router();

// Temporary health payload carried over from the old server.ts; replace with HealthResponse (06 §4).
step1Router.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "splice-backend",
    node_env: process.env.NODE_ENV || "development",
    rea_mode: process.env.REA_MODE || "auto",
    model: getModel("decomp_worker"),
    models: resolvedModelTable(),
    timestamp: Date.now(),
  });
});
