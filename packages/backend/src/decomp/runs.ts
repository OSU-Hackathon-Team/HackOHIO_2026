// Orchestrates UI-triggered decomp runs: one at a time (single worker instance), persisted under
// <stateDir>/runs/<id>.json so the event stream survives page reloads and backend restarts.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DecompRun, DecompRunEvent, DecompRunRequest, type DecompRunResult, type DecompStage, type DecompTarget,
} from "@splice/contracts";
import type { DecompWorker } from "./ec2.js";
import { importRunResults } from "./importRun.js";
import { parseProgress } from "./progress.js";

export const DECOMP_TARGETS: readonly (DecompTarget & { depth_by_budget: Record<string, number>; handoff: string })[] = [{
  id: "libreoffice-calc",
  name: "LibreOffice Calc",
  description: "Formula evaluation in libsclo.so: runtime-seeded scope, reviewed claims, real LibreOffice oracle.",
  library: "calc",
  function_budgets: [20, 40],
  // Measured: 20 functions with reviews used ~0.7M input tokens on Qwen3 Coder (about $0.45).
  estimated_cost_usd: { "20": 0.5, "40": 1.2 },
  depth_by_budget: { "20": 2, "40": 3 },
  handoff: "libreoffice-formula",
}];

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface DecompRunDeps {
  worker: DecompWorker | null;          // null when DECOMP_EC2_ENABLED is not set
  stateDir: string;
  repoRoot: string;
  runnerScript: () => Promise<string>;
  buildPayload: (outFile: string) => Promise<unknown>;
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

  constructor(private readonly deps: DecompRunDeps) {}

  get enabled(): boolean { return this.deps.worker !== null; }
  targets(): DecompTarget[] { return DECOMP_TARGETS.map(({ depth_by_budget: _d, handoff: _h, ...t }) => t); }
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
    const target = DECOMP_TARGETS.find((t) => t.id === request.data.target_id);
    if (!target) throw new HttpError(400, `unknown target ${request.data.target_id}`);
    if (!target.function_budgets.includes(request.data.max_functions)) {
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
      max_functions: request.data.max_functions, stage: "queued", started_at: this.now(), finished_at: null,
      ok: null, result: null };
    const record = { run, events: [] };
    this.runs.set(run.run_id, record);
    this.active = run.run_id;
    await this.emit(record, { type: "stage", stage: "queued", message: `${target.name}, ${run.max_functions} functions` });
    void this.drive(record, target).finally(() => { this.active = null; });
    return run;
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

  private async drive(record: Record_, target: (typeof DECOMP_TARGETS)[number]): Promise<void> {
    const worker = this.deps.worker!;
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "decomp-run-"));
    try {
      await this.emit(record, { type: "stage", stage: "uploading", message: "Packaging the analysis code" });
      const payload = path.join(scratch, "payload.tgz");
      await this.deps.buildPayload(payload);
      await worker.uploadPayload(payload);
      await this.emit(record, { type: "stage", stage: "instance_starting", message: "Starting the analysis worker" });
      const depth = target.depth_by_budget[String(record.run.max_functions)] ?? 2;
      await worker.start(record.run.run_id, { maxFunctions: record.run.max_functions, maxDepth: depth },
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
    const target = DECOMP_TARGETS.find((t) => t.id === record.run.target_id)!;
    const deadline = record.run.started_at + (this.deps.timeoutMs ?? 75 * 60_000);
    let lastStage: DecompStage | null = record.run.stage;
    let lines = record.events.filter((e) => e.type === "log").length;
    let lastClaims = "";
    try {
      for (;;) {
        const [progress, consoleLog, exit] = await Promise.all([
          worker.readObject(record.run.run_id, "progress.jsonl"),
          worker.readObject(record.run.run_id, "console.log"),
          worker.readObject(record.run.run_id, "exit.json")]);
        const snapshot = parseProgress(progress?.toString("utf8") ?? "", consoleLog?.toString("utf8") ?? "");
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
        if (this.now() > deadline) {
          await this.fail(record, "the run exceeded its time limit; the worker stops itself at its own backstop");
          return;
        }
        await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 10_000));
      }
      await this.emit(record, { type: "stage", stage: "importing", message: "Importing results" });
      const archive = await this.waitFor(() => worker.readObject(record.run.run_id, "results.tgz"));
      if (!archive) {
        await this.fail(record, "the worker finished without uploading results");
        return;
      }
      const result: DecompRunResult = await importRunResults(archive, {
        stateDir: this.deps.stateDir, repoRoot: this.deps.repoRoot,
        handoffDir: path.join(this.deps.repoRoot, "docs", "handoffs", target.handoff) });
      await this.emit(record, { type: "result", result });
      await this.emit(record, { type: "stage", stage: "complete",
        message: result.spec_artifact ? `${result.spec_status} specification ready` : "Evidence imported; no specification" });
      await this.emit(record, { type: "done", ok: true });
    } catch (error) {
      await this.fail(record, (error as Error).message);
    }
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
