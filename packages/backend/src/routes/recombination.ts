// HTTP surface for downstream capabilities, compositions and generated applications.
import { timingSafeEqual } from "node:crypto";
import { Router, raw, type NextFunction, type Request, type Response } from "express";
import {
  ApplicationBuildRequest,
  CapabilityBuildRequest,
  CapabilityIntakeRequest,
  CompositionValidateRequest,
  PreviewRequest,
  type JobEvent,
} from "@splice/contracts";
import { openSse } from "../http/sse.js";
import { hashJson } from "../capabilities/identity.js";
import { JobManager } from "../recombination/jobs.js";
import type { RecombinationService } from "../recombination/service.js";
import { parseMonoPcm16Wav } from "../example/wav.js";
import { TranscriptionProviderError } from "../example/awsTranscribe.js";

type Async = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Async) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: unknown) {
    super(message);
  }
}

const asHttp = (error: unknown): HttpError => {
  if (error instanceof HttpError) return error;
  const candidate = error as { status?: number; errors?: unknown; message?: string };
  if (typeof candidate?.status === "number") return new HttpError(candidate.status, candidate.message ?? "failed", candidate.errors);
  return new HttpError(500, candidate?.message ?? String(error));
};

const requireTranscriptionToken = (req: Request, _res: Response, next: NextFunction) => {
  const expected = process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN;
  if (!expected || expected.length < 32) return next(new HttpError(503, "Live transcription access token is not configured"));
  const provided = req.get("X-Splice-Transcription-Token") ?? "";
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
    return next(new HttpError(401, "Invalid transcription access token"));
  }
  next();
};

export function createRecombinationRouter(service: RecombinationService, jobs: JobManager): Router {
  const router = Router();
  const transcriptionSession = async (sessionId: string) => {
    const session = await service.getTranscriptionSession(sessionId);
    if (!session || session.status === "succeeded" || session.status === "failed" || session.status === "cancelled") return session;
    const job = session.job_id ? jobs.get(session.job_id) : null;
    if (!job) return service.reconcileTranscriptionSession(sessionId, "failed", "Transcription job record is missing after restart");
    if (job.status === "failed" || job.status === "cancelled") {
      return service.reconcileTranscriptionSession(sessionId, job.status, job.error ?? "Transcription job ended without updating its session");
    }
    if (job.status === "succeeded") {
      return service.reconcileTranscriptionSession(sessionId, "failed", "Transcription job completed without a finalized session");
    }
    return session;
  };

  jobs.resumePending(async (saved, _job, context) => {
    if (saved.kind === "capability_build") {
      const result = await service.buildCapability(saved.request.intake_id, context);
      return { result_ref: `package:${result.package_id}` };
    }
    if (saved.kind === "application_build") {
      const result = await service.buildApp(saved.request.plan, context);
      return { result_ref: `app:${result.app_id}:${result.revision}` };
    }
    const result = await service.runTranscription(saved.request.session_id, context);
    return { result_ref: `transcription:${result.session_id}` };
  });

  router.get("/api/capabilities", wrap(async (_req, res) => {
    res.json(await service.listCapabilities());
  }));

  router.post("/api/capabilities/intake", wrap(async (req, res) => {
    const parsed = CapabilityIntakeRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid capability intake", parsed.error.flatten());
    res.status(201).json(await service.intake(parsed.data));
  }));

  router.post("/api/capabilities/build", wrap(async (req, res) => {
    const parsed = CapabilityBuildRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid capability build request", parsed.error.flatten());
    const job = jobs.start("capability_build", hashJson(parsed.data), async (context) => {
      const result = await service.buildCapability(parsed.data.intake_id, context);
      return { result_ref: `package:${result.package_id}` };
    }, { kind: "capability_build", request: parsed.data });
    res.status(202).json(job);
  }));

  router.get("/api/capabilities/:packageId", wrap(async (req, res) => {
    const pkg = await service.getPackage(req.params.packageId);
    if (!pkg) throw new HttpError(404, `Unknown capability package ${req.params.packageId}`);
    res.json(pkg);
  }));

  router.post("/api/recombination/seed", wrap(async (_req, res) => {
    res.json(await service.seedAuthored());
  }));

  router.get("/api/recombination/examples/notebook", wrap(async (_req, res) => {
    res.json(await service.notebookPlan());
  }));

  router.get("/api/recombination/transcription", wrap(async (_req, res) => {
    res.json(await service.transcriptionAvailability());
  }));

  router.post("/api/recombination/transcription", requireTranscriptionToken, raw({ type: ["audio/wav", "audio/x-wav"], limit: "10mb" }), wrap(async (req, res) => {
    if (!(await service.transcriptionAvailability()).configured) throw new HttpError(503, "Live transcription provider is not configured");
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "Upload a mono PCM16 WAV with Content-Type: audio/wav");
    let parsed: ReturnType<typeof parseMonoPcm16Wav>;
    try { parsed = parseMonoPcm16Wav(req.body); }
    catch (cause) { throw new HttpError(400, cause instanceof Error ? cause.message : String(cause)); }
    const language = req.get("X-Splice-Language") ?? "en-US";
    if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(language)) throw new HttpError(400, "X-Splice-Language must be a language code such as en-US");
    const sse = openSse(req, res);
    try {
      for await (const event of service.transcribePcm({ ...parsed, language }, sse.signal)) sse.send(event);
    } catch (cause) {
      if (!sse.closed) sse.send({
        type: "error",
        code: cause instanceof TranscriptionProviderError ? cause.code : "provider_error",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: cause instanceof TranscriptionProviderError && cause.retryable,
      });
    } finally {
      sse.close();
    }
  }));

  router.post("/api/recombination/transcription/jobs", requireTranscriptionToken, raw({ type: ["audio/wav", "audio/x-wav"], limit: "10mb" }), wrap(async (req, res) => {
    if (!(await service.transcriptionAvailability()).configured) throw new HttpError(503, "Live transcription provider is not configured");
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "Upload a mono PCM16 WAV with Content-Type: audio/wav");
    let parsed: ReturnType<typeof parseMonoPcm16Wav>;
    try { parsed = parseMonoPcm16Wav(req.body); }
    catch (cause) { throw new HttpError(400, cause instanceof Error ? cause.message : String(cause)); }
    const language = req.get("X-Splice-Language") ?? "en-US";
    if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(language)) throw new HttpError(400, "X-Splice-Language must be a language code such as en-US");
    const appId = req.get("X-Splice-App-Id");
    const providerId = req.get("X-Splice-Provider-Id");
    const session = await service.prepareTranscription({ ...parsed, language, appId, providerId });
    const request = { session_id: session.session_id };
    let job: ReturnType<JobManager["start"]>;
    try {
      job = jobs.start("transcription", hashJson(request), async (context) => {
        const result = await service.runTranscription(session.session_id, context);
        return { result_ref: `transcription:${result.session_id}` };
      }, { kind: "transcription", request });
    } catch (cause) {
      await service.reconcileTranscriptionSession(session.session_id, "failed", cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
    res.status(202).json({ session: await service.getTranscriptionSession(session.session_id) ?? session, job });
  }));

  router.get("/api/recombination/transcription/jobs/:sessionId", requireTranscriptionToken, wrap(async (req, res) => {
    const session = await transcriptionSession(req.params.sessionId);
    if (!session) throw new HttpError(404, `Unknown transcription ${req.params.sessionId}`);
    res.json(session);
  }));

  router.get("/api/recombination/transcription/jobs/:sessionId/events", requireTranscriptionToken, wrap(async (req, res) => {
    const session = await transcriptionSession(req.params.sessionId);
    if (!session?.job_id) throw new HttpError(404, `Unknown transcription job ${req.params.sessionId}`);
    const job = jobs.get(session.job_id);
    if (!job) throw new HttpError(404, `Unknown transcription job ${req.params.sessionId}`);
    const sse = openSse(req, res);
    let unsubscribe = () => {};
    unsubscribe = jobs.subscribe(job.job_id, (event) => {
      sse.send(event);
      if (event.type === "done") queueMicrotask(() => { unsubscribe(); sse.close(); });
    });
    sse.signal.addEventListener("abort", () => { unsubscribe(); sse.close(); });
  }));

  router.post("/api/recombination/transcription/jobs/:sessionId/cancel", requireTranscriptionToken, wrap(async (req, res) => {
    const session = await transcriptionSession(req.params.sessionId);
    if (!session?.job_id) throw new HttpError(404, `Unknown transcription job ${req.params.sessionId}`);
    const job = session.status === "succeeded" ? jobs.get(session.job_id) : jobs.cancel(session.job_id);
    if (!job) throw new HttpError(404, `Unknown transcription job ${req.params.sessionId}`);
    res.json(job);
  }));

  router.post("/api/compositions/validate", wrap(async (req, res) => {
    const parsed = CompositionValidateRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid composition plan", parsed.error.flatten());
    res.json(await service.validatePlan(parsed.data.plan));
  }));

  router.post("/api/apps", wrap(async (req, res) => {
    const parsed = ApplicationBuildRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid application build request", parsed.error.flatten());
    const job = jobs.start("application_build", hashJson(parsed.data), async (context) => {
      const result = await service.buildApp(parsed.data.plan, context);
      return { result_ref: `app:${result.app_id}:${result.revision}` };
    }, { kind: "application_build", request: parsed.data });
    res.status(202).json(job);
  }));

  router.get("/api/apps", wrap(async (_req, res) => {
    res.json(await service.listApps());
  }));

  router.get("/api/apps/:appId/revisions", wrap(async (req, res) => {
    const history = await service.listAppRevisions(req.params.appId);
    if (!history) throw new HttpError(404, `No application ${req.params.appId}`);
    res.json(history);
  }));

  router.get("/api/apps/:appId/revisions/latest", wrap(async (req, res) => {
    const app = await service.getApp(req.params.appId, "latest");
    if (!app) throw new HttpError(404, `No application ${req.params.appId}`);
    res.json(app);
  }));

  router.get("/api/apps/:appId/revisions/:revision", wrap(async (req, res) => {
    const revision = Number(req.params.revision);
    if (!Number.isInteger(revision) || revision < 0) throw new HttpError(400, "revision must be a non-negative integer");
    const app = await service.getApp(req.params.appId, revision);
    if (!app) throw new HttpError(404, `No revision ${revision} for ${req.params.appId}`);
    res.json(app);
  }));

  router.post("/api/apps/:appId/revisions/:revision/activate", wrap(async (req, res) => {
    const revision = Number(req.params.revision);
    if (!Number.isInteger(revision) || revision < 0) throw new HttpError(400, "revision must be a non-negative integer");
    res.json(await service.activateRevision(req.params.appId, revision));
  }));

  router.post("/api/apps/:appId/preview", wrap(async (req, res) => {
    const parsed = PreviewRequest.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Invalid preview request", parsed.error.flatten());
    res.json(await service.previewApp(req.params.appId, parsed.data));
  }));

  router.get("/api/apps/:appId/export", wrap(async (req, res) => {
    const exported = await service.exportApp(req.params.appId);
    res.setHeader("X-Splice-Manifest-Hash", exported.manifest_hash);
    res.json(exported);
  }));

  router.get("/api/jobs/:jobId", wrap(async (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) throw new HttpError(404, `Unknown job ${req.params.jobId}`);
    if (job.kind === "transcription") throw new HttpError(404, `Unknown job ${req.params.jobId}`);
    res.json(job);
  }));

  router.get("/api/jobs/:jobId/events", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.kind === "transcription") {
      res.status(404).json({ error: `Unknown job ${req.params.jobId}` });
      return;
    }
    const sse = openSse(req, res);
    const seen = new Set<string>();
    let done = false;
    let unsubscribe = () => {};
    unsubscribe = jobs.subscribe(job.job_id, (event: JobEvent) => {
      const key = `${event.type}:${event.ts}:${"message" in event ? event.message : ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      sse.send(event);
      if (event.type === "done") {
        done = true;
        queueMicrotask(() => {
          unsubscribe();
          sse.close();
        });
      }
    });
    sse.signal.addEventListener("abort", () => {
      unsubscribe();
      sse.close();
    });
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      // Persisted events already replayed by subscribe; close after the terminal event.
      setTimeout(() => {
        if (!done) {
          unsubscribe();
          sse.close();
        }
      }, 0);
    }
  });

  router.post("/api/jobs/:jobId/cancel", wrap(async (req, res) => {
    const existing = jobs.get(req.params.jobId);
    if (existing?.kind === "transcription") throw new HttpError(404, `Unknown job ${req.params.jobId}`);
    const job = jobs.cancel(req.params.jobId);
    if (!job) throw new HttpError(404, `Unknown job ${req.params.jobId}`);
    res.json(job);
  }));

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return _next(error);
    const http = asHttp(error);
    res.status(http.status).json({ error: http.message, detail: http.detail ?? null });
  });

  return router;
}
