// Orchestrates UI-triggered decomp runs: one at a time (single worker instance), persisted under
// <stateDir>/runs/<id>.json so the event stream survives page reloads and backend restarts.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DecompRun, DecompRunEvent, DecompRunRequest, type DecompRunResult, type DecompStage, type DecompTarget,
  type DecompTargetSpec,
} from "@splice/contracts";
import { REPO_ROOT } from "../config.js";
import type { DecompWorker } from "./ec2.js";
import { importRunResults } from "./importRun.js";
import { parseProgress } from "./progress.js";
import { loadTargetRegistry, publicTarget } from "./targets.js";
import { validatePublicOracle } from "./publicOracle.js";

// Registered targets: fixtures/decomp/targets/<id>.json (Phase 1 registry).
export const TARGET_REGISTRY = path.join(REPO_ROOT, "fixtures", "decomp", "targets");

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface DecompRunDeps {
  worker: DecompWorker | null;          // null when DECOMP_EC2_ENABLED is not set
  stateDir: string;
  repoRoot: string;
  runnerScript: () => Promise<string>;
  buildPayload: (outFile: string) => Promise<unknown>;
  publishAnalysis?: (run: DecompRun, result: DecompRunResult, progress: string, target: DecompTargetSpec) => Promise<void>;
  targets?: DecompTargetSpec[];          // defaults to the repository registry
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface Record_ { run: DecompRun; events: DecompRunEvent[] }
type Listener = (event: DecompRunEvent) => void;

export class DecompRunService {
  private readonly runs = new Map<string, Record_>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private active: string | null = null;

  private readonly registry: DecompTargetSpec[];

  constructor(private readonly deps: DecompRunDeps) {
    this.registry = deps.targets ?? loadTargetRegistry(TARGET_REGISTRY);
  }

  get enabled(): boolean { return this.deps.worker !== null; }
  targets(): DecompTarget[] { return this.registry.map(publicTarget); }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private file(id: string): string { return path.join(this.deps.stateDir, "runs", `${id}.json`); }

  /** Loads persisted runs and resumes polling one that was still in flight. */
  async init(): Promise<void> {
    const folder = path.join(this.deps.stateDir, "runs");
    for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      try {
        const saved = JSON.parse(await fs.readFile(path.join(folder, name), "utf8"));
        const record = { run: DecompRun.parse(saved.run), events: saved.events.map((e: unknown) => DecompRunEvent.parse(e)) };
        this.runs.set(record.run.run_id, record);
        if (record.run.finished_at === null && this.enabled && !this.active) {
          this.active = record.run.run_id;
          void this.poll(record).finally(() => { this.active = null; });
        }
      } catch { /* unreadable run file: ignore */ }
    }
  }

  get(id: string): Record_ | undefined { return this.runs.get(id); }
  list(): DecompRun[] { return [...this.runs.values()].map((r) => r.run).sort((a, b) => b.started_at - a.started_at); }

  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => set.delete(listener);
  }

  async start(body: unknown): Promise<DecompRun> {
    const request = DecompRunRequest.safeParse(body);
    if (!request.success) throw new HttpError(400, request.error.issues.map((i) => i.message).join("; "));
    const worker = this.deps.worker;
    if (!worker) throw new HttpError(403, "decomp runs are disabled; set DECOMP_EC2_ENABLED=1 with the worker config");
    const target = this.registry.find((t) => t.id === request.data.target_id);
    if (!target) throw new HttpError(400, `unknown target ${request.data.target_id}`);
    const mode = request.data.mode ?? "analysis";
    if (mode === "public_oracle" && target.driver !== "uno") throw new HttpError(400, "public oracle recording requires a UNO target");
    if (mode === "analysis" && !target.function_budgets.includes(request.data.max_functions)) {
      throw new HttpError(400, `max_functions must be one of ${target.function_budgets.join(", ")}`);
    }
    if (this.active) throw new HttpError(409, `run ${this.active} is still in progress`);
    this.active = "starting";
    try {
      const state = await worker.instanceState();
      if (state !== "stopped") throw new HttpError(409, `the worker instance is ${state}; wait until it is stopped`);
    } catch (error) {
      this.active = null;
      throw error;
    }
    const run: DecompRun = { run_id: `run-${randomUUID().slice(0, 18)}`, target_id: target.id,
      max_functions: request.data.max_functions, mode, stage: "queued", started_at: this.now(), finished_at: null,
      ok: null, result: null };
    const record = { run, events: [] };
    this.runs.set(run.run_id, record);
    this.active = run.run_id;
    await this.emit(record, { type: "stage", stage: "queued", message: mode === "public_oracle"
      ? `${target.name}: public original observations (no model calls)` : `${target.name}, ${run.max_functions} functions` });
    void this.drive(record, target).finally(() => { this.active = null; });
    return run;
  }

  /** Re-import an already-finished worker result after a local publication/schema repair. */
  async reimport(id: string): Promise<DecompRun> {
    const record = this.runs.get(id);
    if (!record) throw new HttpError(404, "run not found");
    if (!this.deps.worker) throw new HttpError(503, "the decomp worker is not configured");
    if (record.run.stage !== "failed" || record.run.result !== null) {
      throw new HttpError(409, "only a failed run with no imported result can be re-imported");
    }
    if (this.active) throw new HttpError(409, `run ${this.active} is still in progress`);
    const target = this.registry.find((item) => item.id === record.run.target_id);
    if (!target) throw new HttpError(409, `target ${record.run.target_id} is no longer registered`);
    const archive = record.run.mode === "public_oracle" ? null : await this.deps.worker.readObject(id, "results.tgz");
    if (!archive && record.run.mode !== "public_oracle") throw new HttpError(409, "the worker did not save a result archive for this run");

    this.active = id;
    try {
      await this.emit(record, { type: "stage", stage: "importing", message: "Re-importing saved worker results" });
      if (record.run.mode === "public_oracle") {
        await this.importPublicOracle(record, target);
        return record.run;
      }
      const progress = await this.deps.worker.readObject(id, "progress.jsonl");
      const result = await importRunResults(archive!, {
        stateDir: this.deps.stateDir, repoRoot: this.deps.repoRoot,
        handoffDir: path.join(this.deps.repoRoot, "docs", "handoffs", target.handoff),
      });
      await this.deps.publishAnalysis?.(record.run, result, progress?.toString("utf8") ?? "", target);
      await this.emit(record, { type: "result", result });
      await this.emit(record, { type: "stage", stage: "complete", message: "Saved worker results imported" });
      await this.emit(record, { type: "done", ok: true });
      return record.run;
    } catch (error) {
      const message = `Saved result import failed: ${(error as Error).message}`;
      await this.fail(record, message);
      throw new HttpError(422, message);
    } finally { this.active = null; }
  }

  private async emit(record: Record_, event: DistributiveOmit<DecompRunEvent, "run_id" | "ts">): Promise<void> {
    const full = DecompRunEvent.parse({ ...event, run_id: record.run.run_id, ts: this.now() });
    record.events.push(full);
    if (full.type === "stage") record.run.stage = full.stage;
    if (full.type === "result") record.run.result = full.result;
    if (full.type === "done") {
      record.run.ok = full.ok;
      record.run.finished_at = full.ts;
      if (!full.ok) record.run.stage = "failed";
    }
    await fs.mkdir(path.dirname(this.file(record.run.run_id)), { recursive: true });
    await fs.writeFile(this.file(record.run.run_id), JSON.stringify(record, null, 2) + "\n");
    for (const listener of this.listeners.get(record.run.run_id) ?? []) listener(full);
  }

  private async fail(record: Record_, message: string): Promise<void> {
    await this.emit(record, { type: "error", message, fatal: true });
    await this.emit(record, { type: "done", ok: false });
  }

  private async drive(record: Record_, target: DecompTargetSpec): Promise<void> {
    const worker = this.deps.worker!;
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "decomp-run-"));
    try {
      await this.emit(record, { type: "stage", stage: "uploading", message: "Packaging the analysis code" });
      const payload = path.join(scratch, "payload.tgz");
      await this.deps.buildPayload(payload);
      await worker.uploadPayload(payload);
      await this.emit(record, { type: "stage", stage: "instance_starting", message: "Starting the analysis worker" });
      const depth = target.depth_by_budget[String(record.run.max_functions)] ?? 2;
      await worker.start(record.run.run_id, { maxFunctions: record.run.max_functions, maxDepth: depth, targetId: target.id,
        ...(record.run.mode === "public_oracle" ? { mode: "public_oracle" as const } : {}) },
                         await this.deps.runnerScript());
    } catch (error) {
      await this.fail(record, `could not start the run: ${(error as Error).message}`);
      return;
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
    await this.poll(record);
  }

  private async poll(record: Record_): Promise<void> {
    const worker = this.deps.worker!;
    const target = this.registry.find((t) => t.id === record.run.target_id);
    if (!target) {
      await this.fail(record, `target ${record.run.target_id} is no longer registered`);
      return;
    }
    const deadline = record.run.started_at + (this.deps.timeoutMs ?? 75 * 60_000);
    let lastStage: DecompStage | null = record.run.stage;
    let lines = record.events.filter((e) => e.type === "log").length;
    let lastClaims = "";
    let latestProgress = "";
    try {
      for (;;) {
        const [progress, consoleLog, exit] = await Promise.all([
          worker.readObject(record.run.run_id, "progress.jsonl"),
          worker.readObject(record.run.run_id, "console.log"),
          worker.readObject(record.run.run_id, "exit.json")]);
        latestProgress = progress?.toString("utf8") ?? "";
        const snapshot = parseProgress(latestProgress, consoleLog?.toString("utf8") ?? "");
        for (const line of snapshot.lines.slice(lines)) await this.emit(record, { type: "log", line });
        lines = Math.max(lines, snapshot.lines.length);
        if (snapshot.stage && snapshot.stage !== lastStage) {
          lastStage = snapshot.stage;
          await this.emit(record, { type: "stage", stage: snapshot.stage, message: snapshot.message ?? snapshot.stage });
        }
        if (snapshot.claims) {
          const key = `${snapshot.claims.drafted}/${snapshot.claims.reviewed}`;
          if (key !== lastClaims) {
            lastClaims = key;
            await this.emit(record, { type: "progress", label: "drafted", done: snapshot.claims.drafted, total: snapshot.claims.total });
            await this.emit(record, { type: "progress", label: "reviewed", done: snapshot.claims.reviewed, total: snapshot.claims.total });
          }
        }
        if (exit) break;
        // A runner that dies before uploading exit.json leaves nothing to wait for once the worker stops.
        const state = await worker.instanceState();
        if (!["pending", "running"].includes(state) &&
            !(await worker.readObject(record.run.run_id, "exit.json"))) {
          await this.fail(record, `the worker is ${state} but the run never finished; check the runner log on the instance`);
          return;
        }
        if (this.now() > deadline) {
          await this.fail(record, "the run exceeded its time limit; the worker stops itself at its own backstop");
          return;
        }
        await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 10_000));
      }
      await this.emit(record, { type: "stage", stage: "importing", message: "Importing results" });
      if (record.run.mode === "public_oracle") {
        await this.importPublicOracle(record, target);
        return;
      }
      const archive = await this.waitFor(() => worker.readObject(record.run.run_id, "results.tgz"));
      if (!archive) {
        await this.fail(record, "the worker finished without uploading results");
        return;
      }
      const result: DecompRunResult = await importRunResults(archive, {
        stateDir: this.deps.stateDir, repoRoot: this.deps.repoRoot,
        handoffDir: path.join(this.deps.repoRoot, "docs", "handoffs", target.handoff) });
      await this.deps.publishAnalysis?.(record.run, result, latestProgress, target);
      await this.emit(record, { type: "result", result });
      await this.emit(record, { type: "stage", stage: "complete",
        message: result.spec_artifact ? `${result.spec_status} specification ready` : "Evidence imported; no specification" });
      await this.emit(record, { type: "done", ok: true });
    } catch (error) {
      await this.fail(record, (error as Error).message);
    }
  }

  private async importPublicOracle(record: Record_, target: DecompTargetSpec): Promise<void> {
    const bytes = await this.waitFor(() => this.deps.worker!.readObject(record.run.run_id, "public-oracle.json"));
    if (!bytes) throw new Error("the worker finished without a public oracle report");
    const report = await validatePublicOracle(JSON.parse(bytes.toString("utf8")), target, this.deps.repoRoot);
    const observed = report.cases.filter(c => c.outcome === "observed").length;
    await this.emit(record, { type: "result", result: {
      public_oracle: report, readiness: "observation_only", spec_artifact: null, spec_status: null,
      spec_writer: null, spec_error: null, claim_outcomes: {}, functions: { included: 0, drafted: 0, reviewed: 0 },
      oracle: { public_agreement: 0, held_out_agreement: 0, public_observed: observed, held_out_observed: 0 },
      handoff_path: null, tokens: { input: 0, output: 0 },
    } });
    await this.emit(record, { type: "stage", stage: "complete", message: `${observed}/${report.cases.length} public original outputs recorded` });
    await this.emit(record, { type: "done", ok: observed === report.cases.length });
  }

  private async waitFor(read: () => Promise<Buffer | null>): Promise<Buffer | null> {
    for (let i = 0; i < 12; i++) {
      const value = await read();
      if (value) return value;
      await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 10_000));
    }
    return null;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
