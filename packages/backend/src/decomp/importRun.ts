// Imports a finished worker run (results.tgz) into the local decomp state so GET /api/native-specs
// lists its spec, and copies the Engineer 2 handoff into docs/handoffs/<target>/.
// Artifacts are content-addressed; any file whose bytes do not hash to its name is refused.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DecompRunResult } from "@splice/contracts";
import { TAR } from "./payload.js";

const run = promisify(execFile);
const digest = /^[a-f0-9]{64}$/;

export interface ImportOptions {
  stateDir: string;      // local decomp-state (DECOMP_STATE_DIR)
  handoffDir: string;    // e.g. <repo>/docs/handoffs/libreoffice-formula
  repoRoot: string;      // handoff_path is reported relative to this
}

export async function importRunResults(tgz: Buffer, opts: ImportOptions): Promise<DecompRunResult> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "decomp-import-"));
  try {
    const archive = path.join(scratch, "results.tgz");
    await fs.writeFile(archive, tgz);
    const out = path.join(scratch, "x");
    await fs.mkdir(out);
    await run(TAR, ["-xzf", archive, "-C", out, "state/artifacts", "state/lo_runs", "state/attempts", "state/reviews"],
      { maxBuffer: 16 * 1024 * 1024 }).catch(async (error) => {
        // attempts/reviews are absent when the pipeline stopped before claims; artifacts are required.
        await run(TAR, ["-xzf", archive, "-C", out, "state/artifacts", "state/lo_runs"]).catch(() => { throw error; });
      });
    const state = path.join(out, "state");
    await copyArtifacts(path.join(state, "artifacts"), path.join(opts.stateDir, "artifacts"));

    const runs = path.join(state, "lo_runs");
    const names = (await fs.readdir(runs)).sort();
    const summaryName = names.filter((n) => n.endsWith(".json")).pop();
    if (!summaryName) throw new Error("worker results contain no run summary");
    const summary = JSON.parse(await fs.readFile(path.join(runs, summaryName), "utf8"));
    await fs.mkdir(path.join(opts.stateDir, "lo_runs"), { recursive: true });
    await fs.copyFile(path.join(runs, summaryName), path.join(opts.stateDir, "lo_runs", summaryName));

    let outcomes: Record<string, number> = {};
    let handoffPath: string | null = null;
    const handoff = names.find((n) => n === summaryName.replace(/\.json$/, "-handoff"));
    if (handoff) {
      await fs.mkdir(opts.handoffDir, { recursive: true });
      for (const file of await fs.readdir(path.join(runs, handoff))) {
        await fs.copyFile(path.join(runs, handoff, file), path.join(opts.handoffDir, file));
      }
      const evidence = JSON.parse(await fs.readFile(path.join(runs, handoff, "evidence.json"), "utf8"));
      outcomes = evidence.claim_outcomes ?? {};
      await writeRawOutputs(state, evidence, path.join(opts.handoffDir, "raw_agent_outputs.json"));
      handoffPath = path.relative(opts.repoRoot, opts.handoffDir).split(path.sep).join("/");
    }

    const spec = summary.spec ?? null;
    return {
      readiness: summary.dossier?.readiness ?? null,
      spec_artifact: spec?.artifact ?? null,
      spec_status: spec?.status ?? null,
      spec_writer: spec?.writer ?? null,
      spec_error: summary.spec_error ?? null,
      claim_outcomes: outcomes,
      functions: { included: summary.scope?.included ?? 0, drafted: summary.claims?.drafted ?? 0,
                   reviewed: summary.claims?.reviewed ?? 0 },
      // Command-line targets have no analyst expectations: the program's own result ("observed") is the oracle.
      oracle: { public_agreement: (summary.probes?.public?.agreement ?? 0) + (summary.probes?.public?.observed ?? 0),
                held_out_agreement: (summary.probes?.held_out?.agreement ?? 0) + (summary.probes?.held_out?.observed ?? 0) },
      handoff_path: handoffPath,
      tokens: await sumUsage(state),
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function copyArtifacts(from: string, to: string): Promise<void> {
  for (const prefix of await fs.readdir(from)) {
    if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
    for (const name of await fs.readdir(path.join(from, prefix))) {
      if (!digest.test(name)) continue;
      const bytes = await fs.readFile(path.join(from, prefix, name));
      if (!name.startsWith(prefix) || createHash("sha256").update(bytes).digest("hex") !== name) {
        throw new Error(`artifact ${name} does not match its content hash; refusing the import`);
      }
      const target = path.join(to, prefix, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: "wx" }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; // same hash, same bytes
      });
    }
  }
}

async function results(folder: string): Promise<Array<Record<string, any>>> {
  const found = [];
  for (const id of await fs.readdir(folder).catch(() => [] as string[])) {
    try { found.push(JSON.parse(await fs.readFile(path.join(folder, id, "result.json"), "utf8"))); } catch { /* incomplete */ }
  }
  return found;
}

async function sumUsage(state: string): Promise<{ input: number; output: number }> {
  let input = 0, output = 0;
  for (const r of [...await results(path.join(state, "attempts")), ...await results(path.join(state, "reviews"))]) {
    input += Number(r.usage?.input ?? 0);
    output += Number(r.usage?.output ?? 0);
  }
  return { input, output };
}

/** Every reviewed draft with its review, exactly as the models returned them. */
async function writeRawOutputs(state: string, evidence: { functions?: Array<{ entry: string; name: string }> },
                               file: string): Promise<void> {
  const reviews = new Map<string, Record<string, any>>();
  for (const r of await results(path.join(state, "reviews"))) if (r.state === "reviewed") reviews.set(r.draft_artifact, r);
  const names = new Map((evidence.functions ?? []).map((f) => [f.entry, f.name]));
  const outputs = (await results(path.join(state, "attempts")))
    .filter((r) => r.state === "unreviewed" && reviews.has(r.artifact))
    .map((r) => ({ entry: r.subject, name: names.get(r.subject) ?? null, model: r.model,
                   draft: r.answer, review: reviews.get(r.artifact)!.answer }))
    .sort((a, b) => String(a.entry).localeCompare(String(b.entry)));
  await fs.writeFile(file, JSON.stringify(outputs, null, 2) + "\n");
}
