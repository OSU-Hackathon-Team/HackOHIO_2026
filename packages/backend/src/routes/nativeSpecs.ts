// Read and generate native specifications from immutable decomp dossiers.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { NativeSubsystemSpec } from "@splice/contracts";
import { REPO_ROOT } from "../config.js";

export const nativeSpecsRouter = Router();
const digest = /^[a-f0-9]{64}$/;

function stateDir(): string {
  return path.resolve(process.env.DECOMP_STATE_DIR ?? path.join(REPO_ROOT, "decomp-state"));
}

async function readSpec(artifact: string) {
  if (!digest.test(artifact)) throw new Error("invalid spec artifact digest");
  const bytes = await fs.readFile(path.join(stateDir(), "artifacts", artifact.slice(0, 2), artifact));
  if (createHash("sha256").update(bytes).digest("hex") !== artifact) {
    throw new Error("spec artifact hash mismatch");
  }
  return NativeSubsystemSpec.parse(JSON.parse(bytes.toString("utf8")));
}

function generate(dossierArtifact: string): Promise<{ artifact: string; dossier_artifact: string; status: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [path.join(REPO_ROOT, "launch.py"), "spec",
      "--dossier-artifact", dossierArtifact, "--state", stateDir()],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 2_000_000) child.kill("SIGKILL");
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors += chunk;
      if (errors.length > 16_000) child.kill("SIGKILL");
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(errors.trim() || `spec generation exited ${code}`));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}

nativeSpecsRouter.post("/api/native-specs", async (req, res) => {
  const dossierArtifact = req.body?.dossier_artifact;
  if (typeof dossierArtifact !== "string" || !digest.test(dossierArtifact)) {
    return res.status(400).json({ error: "dossier_artifact must be a SHA-256 digest" });
  }
  try {
    const pointer = await generate(dossierArtifact);
    const spec = await readSpec(pointer.artifact);
    if (spec.provenance.dossier_artifact !== dossierArtifact) {
      throw new Error("generated specification references a different dossier");
    }
    return res.json({ artifact: pointer.artifact, spec });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

nativeSpecsRouter.get("/api/native-specs/:artifact", async (req, res) => {
  if (!digest.test(req.params.artifact)) {
    return res.status(400).json({ error: "artifact must be a SHA-256 digest" });
  }
  try {
    return res.json(await readSpec(req.params.artifact));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return res.status(404).json({ error: "spec artifact not found" });
    }
    return res.status(500).json({ error: (error as Error).message });
  }
});
