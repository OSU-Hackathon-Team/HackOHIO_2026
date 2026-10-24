// Read and generate native specifications from immutable decomp dossiers.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { FeatureSpec, NativeSubsystemSpec } from "@splice/contracts";
import { adaptNativeSpecToFeatureSpec } from "../native/nativeAdapter.js";
import { REPO_ROOT } from "../config.js";
import { publicSpecContainsSource } from "../spec/nativeSafety.js";

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
  const spec = NativeSubsystemSpec.parse(JSON.parse(bytes.toString("utf8")));
  if (publicSpecContainsSource(spec)) throw new Error("spec contains source-like text");
  return spec;
}

function generate(dossierArtifact: string): Promise<{ artifact: string; dossier_artifact: string; status: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [path.join(REPO_ROOT, "launch.py"), "spec",
      "--dossier-artifact", dossierArtifact, "--state", stateDir()],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 190_000);
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
    if (pointer.dossier_artifact !== dossierArtifact) {
      throw new Error("generated specification references a different dossier");
    }
    return res.json({ artifact: pointer.artifact, spec });
  } catch (error) {
    const message = (error as Error).message;
    return res.status(message.includes("not ready for a cleanroom specification") ? 409 : 500)
      .json({ error: message });
  }
});

nativeSpecsRouter.get("/api/native-specs", async (_req, res) => {
  try {
    const artRoot = path.join(stateDir(), "artifacts");
    const results: Array<{ artifact: string; spec: NativeSubsystemSpec }> = [];
    let prefixes: string[] = [];
    try {
      prefixes = await fs.readdir(artRoot);
    } catch {
      return res.json({ specs: [] });
    }
    for (const prefix of prefixes) {
      if (prefix.length !== 2) continue;
      const subDir = path.join(artRoot, prefix);
      let files: string[] = [];
      try {
        files = await fs.readdir(subDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!digest.test(file)) continue;
        try {
          const spec = await readSpec(file);
          results.push({ artifact: file, spec });
        } catch {
          // Skip artifacts that are not valid NativeSubsystemSpecs
        }
      }
    }
    return res.json({ specs: results });
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

nativeSpecsRouter.post("/api/native-specs/adapt", async (req, res) => {
  try {
    let nativeSpec: NativeSubsystemSpec;
    if (typeof req.body?.artifact === "string" && digest.test(req.body.artifact)) {
      try {
        nativeSpec = await readSpec(req.body.artifact);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return res.status(404).json({ error: "spec artifact not found" });
        }
        throw err;
      }
    } else if (req.body?.spec && typeof req.body.spec === "object") {
      nativeSpec = NativeSubsystemSpec.parse(req.body.spec);
    } else if (req.body && typeof req.body === "object" && "subsystem_id" in req.body) {
      nativeSpec = NativeSubsystemSpec.parse(req.body);
    } else {
      return res.status(400).json({
        error: "Request body must contain 'spec' (NativeSubsystemSpec) or valid 'artifact' SHA-256 digest",
      });
    }

    const featureId = typeof req.body?.feature_id === "string" ? req.body.feature_id : undefined;
    const featureSpec = adaptNativeSpecToFeatureSpec(nativeSpec, { feature_id: featureId });
    const validated = FeatureSpec.parse(featureSpec);
    return res.json({ spec: validated, feature_spec: validated });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});

