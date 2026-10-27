// Durable job records and event fan-out for capability builds, app builds and exports.
// A browser disconnect detaches observation; it does not cancel work.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  ApplicationBuildRequest,
  CapabilityBuildRequest,
  JobEvent as JobEventSchema,
  JobRecord as JobRecordSchema,
  type JobEvent,
  type JobKind,
  type JobProgress,
  type JobRecord,
} from "@splice/contracts";
import { hashJson } from "../capabilities/identity.js";

export interface JobContext {
  job_id?: string;
  signal: AbortSignal;
  stage(stage: string, message: string, pct: number, checkpoint?: string): void;
  log(message: string): void;
}

export interface JobOutcome {
  result_ref: string;
}

type Runner = (context: JobContext) => Promise<JobOutcome>;

export type JobResumeRequest =
  | { kind: "capability_build"; request: CapabilityBuildRequest }
  | { kind: "application_build"; request: ApplicationBuildRequest };

interface StoredJob extends JobRecord {
  events: JobEvent[];
  resume_request: JobResumeRequest | null;
}

const MAX_EVENTS = 2_000;

function validatedResumeRequest(raw: unknown, kind: JobKind, requestHash: string): JobResumeRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { kind?: unknown; request?: unknown };
  if (candidate.kind !== kind) return null;
  if (kind === "capability_build") {
    const parsed = CapabilityBuildRequest.safeParse(candidate.request);
    return parsed.success && hashJson(parsed.data) === requestHash ? { kind, request: parsed.data } : null;
  }
  if (kind === "application_build") {
    const parsed = ApplicationBuildRequest.safeParse(candidate.request);
    return parsed.success && hashJson(parsed.data) === requestHash ? { kind, request: parsed.data } : null;
  }
  return null;
}

export class JobManager {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly runners = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly listeners = new Map<string, Set<(event: JobEvent) => void>>();

  constructor(private readonly root: string | null) {
    if (root) {
      fs.mkdirSync(path.join(root, "jobs"), { recursive: true, mode: 0o700 });
      this.recover();
    }
  }

  private recover() {
    if (!this.root) return;
    for (const file of fs.readdirSync(path.join(this.root, "jobs"))) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.root, "jobs", file), "utf8")) as StoredJob;
        const { events: rawEvents, resume_request: rawResume, ...publicRecord } = raw;
        const job: StoredJob = {
          ...JobRecordSchema.parse(publicRecord),
          events: Array.isArray(rawEvents) ? rawEvents.map((event) => JobEventSchema.parse(event)) : [],
          resume_request: null,
        };
        if (job.job_id !== file.slice(0, -5)) continue;
        const resume = validatedResumeRequest(rawResume, job.kind, job.request_hash);
        if (job.status === "running" || job.status === "queued") {
          if (resume) {
            job.resume_request = resume;
            job.status = "queued";
            job.error = null;
            job.progress = { ...job.progress, stage: "resume_pending", message: "Server restarted; replaying from a safe build boundary" };
            this.append(job, { type: "stage", job_id: job.job_id, ts: Date.now(), stage: "resume_pending", pct: job.progress.pct, message: job.progress.message });
          } else {
            job.status = "failed";
            job.error = "Interrupted by a server restart. No valid saved build request is available for replay.";
            job.progress = { ...job.progress, stage: "interrupted", message: job.error, checkpoint: job.progress.checkpoint };
            this.append(job, { type: "error", job_id: job.job_id, ts: Date.now(), message: job.error, fatal: true });
            this.append(job, { type: "done", job_id: job.job_id, ts: Date.now(), ok: false });
          }
          job.updated_at = new Date().toISOString();
        }
        this.jobs.set(job.job_id, job);
        this.persist(job);
      } catch {
        // A corrupt job file is ignored; it must never become a trusted result.
      }
    }
  }

  start(kind: JobKind, requestHash: string, runner: Runner, resumeRequest?: JobResumeRequest): JobRecord {
    const savedRequest = resumeRequest ? validatedResumeRequest(resumeRequest, kind, requestHash) : null;
    if (resumeRequest && !savedRequest) throw new Error("Job resume request does not match its kind and request hash");
    const job_id = `job_${crypto.randomBytes(16).toString("hex")}`;
    const now = new Date().toISOString();
    const job: StoredJob = {
      job_id,
      kind,
      status: "queued",
      progress: { stage: "queued", pct: 0, message: "Queued", checkpoint: null },
      created_at: now,
      updated_at: now,
      result_ref: null,
      error: null,
      request_hash: requestHash,
      events: [],
      resume_request: savedRequest,
    };
    this.jobs.set(job_id, job);
    this.persist(job);
    const controller = new AbortController();
    const promise = this.run(job, runner, controller);
    this.runners.set(job_id, { controller, promise });
    return this.record(job);
  }

  /** Starts and waits. Useful for deterministic tests and scripted jobs. */
  async runNow(kind: JobKind, requestHash: string, runner: Runner): Promise<JobRecord> {
    const job = this.start(kind, requestHash, runner);
    await this.wait(job.job_id);
    return this.get(job.job_id)!;
  }

  /** Replays interrupted durable builds after the service has registered its handlers. */
  resumePending(handler: (request: JobResumeRequest, job: JobRecord, context: JobContext) => Promise<JobOutcome>): JobRecord[] {
    const resumed: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "queued" || !job.resume_request || this.runners.has(job.job_id)) continue;
      const request = job.resume_request;
      const controller = new AbortController();
      const promise = this.run(job, (context) => handler(request, this.record(job), context), controller, true);
      this.runners.set(job.job_id, { controller, promise });
      resumed.push(this.record(job));
    }
    return resumed;
  }

  private async run(job: StoredJob, runner: Runner, controller: AbortController, resumed = false) {
    job.status = "running";
    job.progress = resumed
      ? { ...job.progress, stage: "resuming", message: "Replaying saved build request" }
      : { stage: "starting", pct: 1, message: "Starting", checkpoint: null };
    job.updated_at = new Date().toISOString();
    this.append(job, { type: "stage", job_id: job.job_id, ts: Date.now(), stage: job.progress.stage, pct: job.progress.pct, message: job.progress.message });
    this.persist(job);
    try {
      const outcome = await runner({
        job_id: job.job_id,
        signal: controller.signal,
        stage: (stage, message, pct, checkpoint) => {
          this.progress(job, stage, message, pct, checkpoint);
        },
        log: (message) => {
          this.append(job, { type: "log", job_id: job.job_id, ts: Date.now(), message });
        },
      });
      if (controller.signal.aborted) throw new Error("cancelled");
      job.status = "succeeded";
      job.result_ref = outcome.result_ref;
      job.progress = { stage: "complete", pct: 100, message: "Complete", checkpoint: null };
      this.append(job, { type: "result", job_id: job.job_id, ts: Date.now(), result_ref: outcome.result_ref });
      this.append(job, { type: "done", job_id: job.job_id, ts: Date.now(), ok: true });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      job.status = cancelled ? "cancelled" : "failed";
      job.error = cancelled ? "Cancelled by the user" : error instanceof Error ? error.message : String(error);
      job.progress = { ...job.progress, stage: cancelled ? "cancelled" : "failed", message: job.error };
      this.append(job, { type: "error", job_id: job.job_id, ts: Date.now(), message: job.error, fatal: true });
      this.append(job, { type: "done", job_id: job.job_id, ts: Date.now(), ok: false });
    } finally {
      job.resume_request = null;
      job.updated_at = new Date().toISOString();
      this.persist(job);
      this.runners.delete(job.job_id);
    }
  }

  cancel(jobId: string): JobRecord | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === "queued" || job.status === "running") {
      const running = this.runners.get(jobId);
      if (running) running.controller.abort(new Error("cancelled"));
      else {
        job.status = "cancelled";
        job.error = "Cancelled by the user";
        job.progress = { ...job.progress, stage: "cancelled", message: job.error };
        job.resume_request = null;
        this.append(job, { type: "error", job_id: job.job_id, ts: Date.now(), message: job.error, fatal: true });
        this.append(job, { type: "done", job_id: job.job_id, ts: Date.now(), ok: false });
        this.persist(job);
      }
    }
    return this.record(job);
  }

  async wait(jobId: string): Promise<void> {
    await this.runners.get(jobId)?.promise;
  }

  get(jobId: string): JobRecord | null {
    const job = this.jobs.get(jobId);
    return job ? this.record(job) : null;
  }

  events(jobId: string): JobEvent[] {
    return [...(this.jobs.get(jobId)?.events ?? [])];
  }

  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);
    const job = this.jobs.get(jobId);
    if (job) for (const event of job.events) listener(event);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(jobId);
    };
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map((job) => this.record(job));
  }

  private progress(job: StoredJob, stage: string, message: string, pct: number, checkpoint?: string) {
    const progress: JobProgress = {
      stage,
      pct: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)),
      message,
      checkpoint: checkpoint ?? job.progress.checkpoint,
    };
    job.progress = progress;
    job.updated_at = new Date().toISOString();
    this.append(job, { type: "stage", job_id: job.job_id, ts: Date.now(), stage, pct: progress.pct, message });
    this.persist(job);
  }

  private append(job: StoredJob, event: JobEvent) {
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    job.updated_at = new Date().toISOString();
    for (const listener of this.listeners.get(job.job_id) ?? []) {
      try {
        listener(event);
      } catch {
        // A dead subscriber must not stop the job.
      }
    }
  }

  private record(job: StoredJob): JobRecord {
    const { events: _events, resume_request: _resume, ...record } = job;
    return { ...record };
  }

  private persist(job: StoredJob) {
    if (!this.root) return;
    const target = path.join(this.root, "jobs", `${job.job_id}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
  }
}
