import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Router, raw } from "express";
import * as asar from "@electron/asar";
import { z } from "zod";
import { REPO_ROOT, config } from "../config.js";
import { openSse } from "../http/sse.js";

const StartRequest = z.object({
  archive_id: z.string().regex(/^[a-f0-9]{64}$/),
  channels: z.array(z.string().min(1).max(120)).min(1).max(20),
  scope_label: z.string().min(1).max(120),
  spec_rounds: z.number().int().min(1).max(8).default(2),
  impl_rounds: z.number().int().min(1).max(8).default(2),
}).strict();
const execFileAsync = promisify(execFile);

type Run = {
  run_id: string; archive_id: string; channels: string[]; scope_label: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  created_at: string; finished_at: string | null; exit_code: number | null;
  ready: boolean | null; error: string | null;
};
type Event = { type: "log" | "done"; message?: string; run?: Run };

export function electronRunsRouter(stateDir = path.resolve(process.env.SPLICE_STATE_DIR || ".splice-state"),
  pipelineScript = path.join(REPO_ROOT, "scripts", "electron", "pipeline.mjs"), rendererWorkerScript?: string): Router {
  const router = Router();
  const root = path.join(stateDir, "electron-runs");
  const archivePath = (id: string) => path.join(root, "archives", `${id}.asar`);
  const runDir = (id: string) => path.join(root, "runs", id);
  const runs = new Map<string, Run>();
  const children = new Map<string, ChildProcess>();
  const subscribers = new Map<string, Set<(event: Event) => void>>();
  const save = async (run: Run) => {
    await fsp.mkdir(runDir(run.run_id), { recursive: true });
    const target = path.join(runDir(run.run_id), "run.json");
    const temp = `${target}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(run, null, 2));
    await fsp.rename(temp, target);
  };
  const emit = (id: string, event: Event) => {
    for (const subscriber of subscribers.get(id) ?? []) subscriber(event);
  };
  const ready = (async () => {
    await fsp.mkdir(path.join(root, "archives"), { recursive: true });
    await fsp.mkdir(path.join(root, "runs"), { recursive: true });
    for (const entry of await fsp.readdir(path.join(root, "runs"))) {
      try {
        const run = JSON.parse(await fsp.readFile(path.join(runDir(entry), "run.json"), "utf8")) as Run;
        if (run.status === "running") {
          run.status = "interrupted";
          run.finished_at = new Date().toISOString();
          run.error = "Backend stopped before the reconstruction job completed";
          await save(run);
        }
        runs.set(run.run_id, run);
      } catch { /* An incomplete directory is not a run. */ }
    }
  })();

  router.get("/api/electron/archives", async (_req, res) => {
    await ready;
    const names = (await fsp.readdir(path.join(root, "archives"))).filter(name => /^[a-f0-9]{64}\.asar$/.test(name));
    res.json({ archives: await Promise.all(names.map(async name => ({ archive_id: name.slice(0, 64), bytes: (await fsp.stat(archivePath(name.slice(0, 64)))).size }))) });
  });

  router.post("/api/electron/archives", raw({ type: "application/octet-stream", limit: "100mb" }), async (req, res) => {
    await ready;
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Upload an .asar file as application/octet-stream" });
    const bytes = req.body as Buffer;
    const id = createHash("sha256").update(bytes).digest("hex");
    const target = archivePath(id);
    if (!fs.existsSync(target)) {
      const temp = `${target}.${randomUUID()}.tmp`;
      await fsp.writeFile(temp, bytes);
      try {
        const entries = asar.listPackage(temp, { isPack: false });
        if (!entries.length) throw new Error("Archive contains no files");
        await fsp.rename(temp, target);
      } catch (cause) {
        await fsp.unlink(temp).catch(() => {});
        return res.status(400).json({ error: `Invalid Electron asar archive: ${(cause as Error).message}` });
      }
    }
    return res.status(201).json({ archive_id: id, bytes: bytes.length });
  });

  router.get("/api/electron/archives/:id/inventory", async (req, res) => {
    await ready;
    if (!/^[a-f0-9]{64}$/.test(req.params.id) || !fs.existsSync(archivePath(req.params.id)))
      return res.status(404).json({ error: "Archive not uploaded" });
    try {
      const { stdout } = await execFileAsync(process.execPath,
        [path.join(REPO_ROOT, "scripts", "electron", "client-inventory.mjs"), archivePath(req.params.id)],
        { cwd: REPO_ROOT, maxBuffer: 20_000_000, timeout: 120_000 });
      const analysis = JSON.parse(stdout);
      return res.json({ archive_id: req.params.id, channels: analysis.channels ?? [],
        entries: analysis.entries, diagnostics: analysis.diagnostics ?? [], runtime_error: analysis.runtime_error });
    } catch (cause) { return res.status(422).json({ error: `Archive inventory failed: ${(cause as Error).message}` }); }
  });

  router.post("/api/electron/runs", async (req, res) => {
    await ready;
    const parsed = StartRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid scoped reconstruction request", issues: parsed.error.issues });
    const input = parsed.data;
    if (!fs.existsSync(archivePath(input.archive_id))) return res.status(404).json({ error: "Archive not uploaded" });
    const run: Run = { run_id: `electron-${randomUUID()}`, archive_id: input.archive_id,
      channels: input.channels, scope_label: input.scope_label, status: "running",
      created_at: new Date().toISOString(), finished_at: null, exit_code: null, ready: null, error: null };
    runs.set(run.run_id, run);
    await save(run);
    const dir = runDir(run.run_id);
    const args = [pipelineScript, archivePath(input.archive_id), path.join(dir, "output"),
      "--state", path.join(dir, "state"), "--spec-rounds", String(input.spec_rounds), "--impl-rounds", String(input.impl_rounds),
      "--only", input.channels.join(","), "--scope-label", input.scope_label];
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT,
      env: { ...process.env, AWS_REGION: config.awsRegion, AWS_DEFAULT_REGION: config.awsRegion },
      stdio: ["ignore", "pipe", "pipe"] });
    children.set(run.run_id, child);
    const logFile = fs.createWriteStream(path.join(dir, "events.log"), { flags: "a" });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").slice(0, 16_000);
      logFile.write(message);
      emit(run.run_id, { type: "log", message });
    });
    child.on("error", (cause) => { run.error = cause.message; });
    child.on("close", async (code) => {
      children.delete(run.run_id);
      logFile.end();
      run.exit_code = code;
      run.finished_at = new Date().toISOString();
      if (run.status !== "cancelled") {
        run.status = code === 0 ? "completed" : "failed";
        if (code !== 0) {
          try {
            const names = (await fsp.readdir(path.join(dir, "state"))).filter(name => /^agent-(spec|implement)-round-\d+\.events\.jsonl$/.test(name));
            for (const name of names.sort().reverse()) {
              const lines = (await fsp.readFile(path.join(dir, "state", name), "utf8")).trim().split("\n");
              const failure = lines.map(line => { try { return JSON.parse(line); } catch { return null; } })
                .find(event => event?.type === "error" && typeof event?.error?.message === "string");
              if (failure) { run.error = String(failure.error.message).slice(0, 500); break; }
            }
          } catch { /* The agent may have failed before writing events. */ }
          run.error ??= `Reconstruction exited with code ${code}`;
        }
      }
      try {
        const report = JSON.parse(await fsp.readFile(path.join(dir, "output", "reconstruction-report.json"), "utf8"));
        run.ready = report?.readiness?.ready === true;
      } catch { run.ready = false; }
      await save(run);
      emit(run.run_id, { type: "done", run });
    });
    return res.status(202).json({ run });
  });

  router.post("/api/electron/archives/:id/renderer-discovery", async (req, res) => {
    await ready;
    const request = z.object({ task: z.string().min(5).max(4000), confirm_cost: z.literal(true),
      resource_archives: z.array(z.object({ archive_id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().regex(/^[a-zA-Z0-9_.-]+\.asar$/) })).max(10).default([]),
      entry_resource: z.string().regex(/^[a-zA-Z0-9_.-]+\.asar$/).optional(),
    }).strict().safeParse(req.body);
    if (!request.success) return res.status(400).json({ error: "A task and model-cost confirmation are required" });
    if (!/^[a-f0-9]{64}$/.test(req.params.id) || !fs.existsSync(archivePath(req.params.id)))
      return res.status(404).json({ error: "Archive not uploaded" });
    if (config.llmMode !== "live") return res.status(503).json({ error: "Renderer discovery requires live model mode" });
    if (request.data.resource_archives.some(item => !fs.existsSync(archivePath(item.archive_id))))
      return res.status(404).json({ error: "A companion archive is not uploaded" });
    if (new Set(request.data.resource_archives.map(item => item.name)).size !== request.data.resource_archives.length)
      return res.status(400).json({ error: "Resource names must be unique" });
    const id = `renderer-${randomUUID()}`;
    const sse = openSse(req, res);
    let ok = false;
    try {
      sse.send({ type: "stage", message: "Starting renderer discovery", discovery_id: id });
      const worker = rendererWorkerScript ?? fileURLToPath(new URL(`../scripts/discoverRenderer.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
      const signal = AbortSignal.any([sse.signal, AbortSignal.timeout(20 * 60_000)]);
      const child = spawn(process.execPath, [...(worker.endsWith(".ts") ? ["--import", "tsx"] : []), worker,
        archivePath(req.params.id), path.join(root, "renderer-discoveries", id), request.data.task,
        JSON.stringify({ resources: request.data.resource_archives.map(item => ({ archive: archivePath(item.archive_id), name: item.name })), entryResource: request.data.entry_resource })],
      { cwd: REPO_ROOT, detached: true, env: { ...process.env, AWS_REGION: config.awsRegion }, stdio: ["ignore", "pipe", "pipe"] });
      const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} } };
      signal.addEventListener("abort", stop, { once: true });
      let buffer = "", errors = "";
      child.stdout.on("data", chunk => {
        buffer += String(chunk);
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) { try { sse.send({ ...JSON.parse(line), discovery_id: id }); } catch {} }
      });
      child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-8000); });
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        if (code !== 0) throw new Error(errors || `Renderer worker exited ${code}`);
        ok = true;
      } finally { signal.removeEventListener("abort", stop); stop(); }
    } catch (error) { if (!sse.signal.aborted) sse.send({ type: "error", message: (error as Error).message }); }
    finally { sse.send({ type: "done", ok }); sse.close(); }
  });

  router.get("/api/electron/renderer-discoveries/:id", async (req, res) => {
    if (!/^renderer-[a-f0-9-]{36}$/.test(req.params.id)) return res.status(400).json({ error: "Invalid discovery ID" });
    try { return res.json(JSON.parse(await fsp.readFile(path.join(root, "renderer-discoveries", req.params.id, "draft.json"), "utf8"))); }
    catch { return res.status(404).json({ error: "No completed discovery draft" }); }
  });
  router.get("/api/electron/renderer-discoveries/:id/replay", async (req, res) => {
    if (!/^renderer-[a-f0-9-]{36}$/.test(req.params.id)) return res.status(400).json({ error: "Invalid discovery ID" });
    try { return res.json(JSON.parse(await fsp.readFile(path.join(root, "renderer-discoveries", req.params.id, "replay", "replay-report.json"), "utf8"))); }
    catch { return res.status(404).json({ error: "No completed original replay report" }); }
  });

  router.get("/api/electron/runs", async (_req, res) => { await ready; res.json({ runs: [...runs.values()] }); });
  router.get("/api/electron/runs/:id", async (req, res) => {
    await ready;
    const run = runs.get(req.params.id);
    return run ? res.json({ run }) : res.status(404).json({ error: "Run not found" });
  });
  router.get("/api/electron/runs/:id/report", async (req, res) => {
    await ready;
    if (!runs.has(req.params.id)) return res.status(404).json({ error: "Run not found" });
    try { return res.json(JSON.parse(await fsp.readFile(path.join(runDir(req.params.id), "output", "reconstruction-report.json"), "utf8"))); }
    catch { return res.status(409).json({ error: "Report is not available yet" }); }
  });
  router.get("/api/electron/runs/:id/log", async (req, res) => {
    await ready;
    if (!runs.has(req.params.id)) return res.status(404).json({ error: "Run not found" });
    try { return res.json({ text: (await fsp.readFile(path.join(runDir(req.params.id), "events.log"), "utf8")).slice(-200_000) }); }
    catch { return res.json({ text: "" }); }
  });
  router.get("/api/electron/runs/:id/events", async (req, res) => {
    await ready;
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const sse = openSse(req, res);
    try {
      const prior = await fsp.readFile(path.join(runDir(run.run_id), "events.log"), "utf8");
      if (prior) sse.send({ type: "log", message: prior.slice(-200_000) });
    } catch { /* The child may not have written its first log line. */ }
    if (run.status !== "running") { sse.send({ type: "done", run }); sse.close(); return; }
    const listener = (event: Event) => { sse.send(event); if (event.type === "done") sse.close(); };
    const group = subscribers.get(run.run_id) ?? new Set();
    group.add(listener); subscribers.set(run.run_id, group);
    sse.signal.addEventListener("abort", () => group.delete(listener), { once: true });
  });
  router.post("/api/electron/runs/:id/cancel", async (req, res) => {
    await ready;
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: "Run not found" });
    if (run.status !== "running") return res.status(409).json({ error: `Run is ${run.status}` });
    run.status = "cancelled";
    run.error = "Cancelled by user";
    children.get(run.run_id)?.kill("SIGTERM");
    await save(run);
    return res.json({ run });
  });
  return router;
}
