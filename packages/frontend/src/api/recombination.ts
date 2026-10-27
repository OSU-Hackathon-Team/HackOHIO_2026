// Typed client for the recombination routes (docs/RECOMBINATION_IMPLEMENTATION.md, W5).
// Every response is parsed with its contract schema, so a malformed payload is an error
// instead of undefined behaviour later in the view.
import {
  ApplicationExportResponse,
  ApplicationListResponse,
  ApplicationRecord,
  ApplicationRevisionListResponse,
  CapabilityIntakeRecord,
  CapabilityListResponse,
  CapabilityPackage,
  CompositionPlan,
  CompositionValidateResponse,
  JobEvent,
  JobRecord,
  PreviewResponse,
  TranscriptionAvailabilityResponse,
  TranscriptionEvent,
  TranscriptionSession,
  TranscriptionStartResponse,
  type ApplicationBuildRequest,
  type CapabilityBuildRequest,
  type CapabilityIntakeRequest,
  type CompositionValidateRequest,
  type PreviewRequest,
  type TranscriptionEvent as TranscriptionEventType,
  type TranscriptionSession as TranscriptionSessionType,
} from "@splice/contracts";
import { z } from "zod";

const JOB_SSE_FALLBACK = Symbol("job-sse-fallback");

export class RecombinationApiError extends Error {
  readonly url: string;
  readonly status: number | undefined;
  readonly issues: string[];

  constructor(
    message: string,
    details: { url: string; status?: number; issues?: string[]; cause?: unknown } = { url: "" },
  ) {
    super(message);
    this.name = "RecombinationApiError";
    this.url = details.url;
    this.status = details.status;
    this.issues = details.issues ?? [];
    if (details.cause !== undefined) (this as { cause?: unknown }).cause = details.cause;
  }
}

type Schema<T> = z.ZodType<T, z.ZodTypeDef, any>;

const JSON_GET = { Accept: "application/json" } as const;
const JSON_POST = { Accept: "application/json", "Content-Type": "application/json" } as const;

function contractError(url: string, schemaName: string, error: z.ZodError): RecombinationApiError {
  return new RecombinationApiError(`${url}: response did not match ${schemaName}`, {
    url,
    issues: error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
    cause: error,
  });
}

async function readJson<T>(
  schema: Schema<T>,
  schemaName: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new RecombinationApiError(
      `${url}: ${response.status}${detail ? ` ${detail.trim().slice(0, 800)}` : ""}`,
      { url, status: response.status },
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new RecombinationApiError(`${url}: response was not JSON`, { url, cause: error });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw contractError(url, schemaName, parsed.error);
  return parsed.data;
}

function get<T>(schema: Schema<T>, schemaName: string, url: string, signal?: AbortSignal): Promise<T> {
  return readJson(schema, schemaName, url, { headers: JSON_GET, signal });
}

function post<T>(
  schema: Schema<T>,
  schemaName: string,
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return readJson(schema, schemaName, url, {
    method: "POST",
    headers: JSON_POST,
    body: JSON.stringify(body),
    signal,
  });
}

const jobBase = (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}`;
const appBase = (appId: string) => `/api/apps/${encodeURIComponent(appId)}`;
const packageBase = (packageId: string) => `/api/capabilities/${encodeURIComponent(packageId)}`;

/** `GET /api/capabilities` */
export function listCapabilities(signal?: AbortSignal): Promise<CapabilityListResponse> {
  return get(CapabilityListResponse, "CapabilityListResponse", "/api/capabilities", signal);
}

/** `POST /api/capabilities/intake` */
export function intakeCapability(
  request: CapabilityIntakeRequest,
  signal?: AbortSignal,
): Promise<CapabilityIntakeRecord> {
  return post(CapabilityIntakeRecord, "CapabilityIntakeRecord", "/api/capabilities/intake", request, signal);
}

/** `POST /api/capabilities/build` returns a job; poll/stream it for the resulting package. */
export function buildCapability(
  request: CapabilityBuildRequest,
  signal?: AbortSignal,
): Promise<JobRecord> {
  return post(JobRecord, "JobRecord", "/api/capabilities/build", request, signal);
}

/** `GET /api/capabilities/:packageId` */
export function getCapability(packageId: string, signal?: AbortSignal): Promise<CapabilityPackage> {
  return get(CapabilityPackage, "CapabilityPackage", packageBase(packageId), signal);
}

/** `POST /api/recombination/seed`, idempotent authored development packages. */
export function seedDevelopmentPackages(signal?: AbortSignal): Promise<CapabilityListResponse> {
  return post(
    CapabilityListResponse,
    "CapabilityListResponse",
    "/api/recombination/seed",
    {},
    signal,
  );
}

/** Optional external transcription provider configuration. */
export function getTranscriptionAvailability(signal?: AbortSignal): Promise<TranscriptionAvailabilityResponse> {
  return get(TranscriptionAvailabilityResponse, "TranscriptionAvailabilityResponse", "/api/recombination/transcription", signal);
}

/** Upload a mono PCM16 WAV and consume its POST-SSE partial/final segment stream. */
export async function transcribeWav(
  file: File,
  accessToken: string,
  onEvent: (event: TranscriptionEventType) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (file.size > 10 * 1024 * 1024) throw new RecombinationApiError("WAV file exceeds the 10 MB upload limit", { url: "/api/recombination/transcription" });
  const url = "/api/recombination/transcription";
  const response = await fetch(url, { method: "POST", headers: { Accept: "text/event-stream", "Content-Type": "audio/wav", "X-Splice-Transcription-Token": accessToken }, body: file, signal });
  if (!response.ok || !response.body) throw new RecombinationApiError(`${url}: ${response.status} ${(await response.text()).slice(0, 500)}`, { url, status: response.status });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frame: string[] = [];
  let done = false;
  const dispatch = () => {
    const data = frame.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    frame = [];
    if (!data) return;
    const event = TranscriptionEvent.parse(JSON.parse(data));
    onEvent(event);
    if (event.type === "error") throw new RecombinationApiError(`${event.code}: ${event.message}`, { url });
    if (event.type === "done") done = true;
  };
  try {
    while (!done) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) dispatch();
        else if (!line.startsWith(":")) frame.push(line);
        if (done) break;
      }
      if (chunk.done) break;
    }
    if (!done) throw new RecombinationApiError("Transcription stream closed before a terminal event", { url });
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const transcriptionJobBase = (sessionId: string) => `/api/recombination/transcription/jobs/${encodeURIComponent(sessionId)}`;

/** Start a durable provider job; disconnecting from its event stream leaves it running. */
export async function startTranscriptionJob(file: File, accessToken: string, signal?: AbortSignal): Promise<TranscriptionStartResponse> {
  const url = "/api/recombination/transcription/jobs";
  if (file.size > 10 * 1024 * 1024) throw new RecombinationApiError("WAV file exceeds the 10 MB upload limit", { url });
  return readJson(TranscriptionStartResponse, "TranscriptionStartResponse", url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "audio/wav", "X-Splice-Transcription-Token": accessToken },
    body: file,
    signal,
  });
}

export function getTranscriptionSession(sessionId: string, accessToken: string, signal?: AbortSignal): Promise<TranscriptionSessionType> {
  const url = transcriptionJobBase(sessionId);
  return readJson(TranscriptionSession, "TranscriptionSession", url, {
    headers: { Accept: "application/json", "X-Splice-Transcription-Token": accessToken }, signal,
  });
}

export function cancelTranscriptionSession(sessionId: string, accessToken: string, signal?: AbortSignal): Promise<JobRecord> {
  const url = `${transcriptionJobBase(sessionId)}/cancel`;
  return readJson(JobRecord, "JobRecord", url, {
    method: "POST", headers: { Accept: "application/json", "X-Splice-Transcription-Token": accessToken }, signal,
  });
}

export async function streamTranscriptionSession(
  sessionId: string,
  accessToken: string,
  onEvent: (event: JobEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${transcriptionJobBase(sessionId)}/events`;
  const response = await fetch(url, { headers: { Accept: "text/event-stream", "X-Splice-Transcription-Token": accessToken }, signal });
  if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    throw new RecombinationApiError(`Transcription stream unavailable: ${response.status}`, { url, status: response.status });
  }
  const done = await consumeJobStream(response, onEvent, signal);
  if (!done) throw new RecombinationApiError("Transcription event stream closed before the job completed; reconnect to resume", { url });
}

/** `POST /api/compositions/validate` */
export function validateComposition(
  plan: CompositionPlan,
  signal?: AbortSignal,
): Promise<CompositionValidateResponse> {
  const request: CompositionValidateRequest = { plan };
  return post(
    CompositionValidateResponse,
    "CompositionValidateResponse",
    "/api/compositions/validate",
    request,
    signal,
  );
}

/** `POST /api/apps` returns a build job whose `result_ref` should name the app id. */
export function buildApplication(plan: CompositionPlan, signal?: AbortSignal): Promise<JobRecord> {
  const request: ApplicationBuildRequest = { plan };
  return post(JobRecord, "JobRecord", "/api/apps", request, signal);
}

/** `GET /api/apps` */
export function listApplications(signal?: AbortSignal): Promise<ApplicationListResponse> {
  return get(ApplicationListResponse, "ApplicationListResponse", "/api/apps", signal);
}

/** `GET /api/apps/:appId/revisions/latest` */
export function getLatestRevision(appId: string, signal?: AbortSignal): Promise<ApplicationRecord> {
  return get(
    ApplicationRecord,
    "ApplicationRecord",
    `${appBase(appId)}/revisions/latest`,
    signal,
  );
}

/** `GET /api/apps/:appId/revisions/:revision` */
export function getRevision(
  appId: string,
  revision: number,
  signal?: AbortSignal,
): Promise<ApplicationRecord> {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RecombinationApiError(`Invalid revision ${revision}`, { url: appBase(appId) });
  }
  return get(
    ApplicationRecord,
    "ApplicationRecord",
    `${appBase(appId)}/revisions/${revision}`,
    signal,
  );
}

/** `GET /api/apps/:appId/revisions` */
export function listApplicationRevisions(appId: string, signal?: AbortSignal): Promise<ApplicationRevisionListResponse> {
  return get(ApplicationRevisionListResponse, "ApplicationRevisionListResponse", `${appBase(appId)}/revisions`, signal);
}

/** `POST /api/apps/:appId/revisions/:revision/activate` */
export function activateApplicationRevision(appId: string, revision: number, signal?: AbortSignal): Promise<ApplicationRecord> {
  if (!Number.isInteger(revision) || revision < 0) throw new RecombinationApiError(`Invalid revision ${revision}`, { url: appBase(appId) });
  return post(ApplicationRecord, "ApplicationRecord", `${appBase(appId)}/revisions/${revision}/activate`, {}, signal);
}

/** `POST /api/apps/:appId/preview` */
export function previewApplication(
  appId: string,
  request: PreviewRequest,
  signal?: AbortSignal,
): Promise<PreviewResponse> {
  return post(
    PreviewResponse,
    "PreviewResponse",
    `${appBase(appId)}/preview`,
    request,
    signal,
  );
}

/** `GET /api/apps/:appId/export` */
export function exportApplication(
  appId: string,
  signal?: AbortSignal,
): Promise<ApplicationExportResponse> {
  return get(
    ApplicationExportResponse,
    "ApplicationExportResponse",
    `${appBase(appId)}/export`,
    signal,
  );
}

/** `GET /api/jobs/:jobId` */
export function getJob(
  jobId: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<JobRecord> {
  return readJson(
    JobRecord,
    "JobRecord",
    jobBase(jobId),
    { headers: JSON_GET, signal },
    fetchImpl,
  );
}

/** `POST /api/jobs/:jobId/cancel` */
export function cancelJob(jobId: string, signal?: AbortSignal): Promise<JobRecord> {
  return post(JobRecord, "JobRecord", `${jobBase(jobId)}/cancel`, {}, signal);
}

/**
 * `GET /api/recombination/examples/notebook`.
 * The backend owns the notebook example. Accept either the plan itself or `{ plan }` so a
 * wrapper does not become a second invented route; anything else is a contract error.
 */
const NotebookExampleResponse = z.union([
  CompositionPlan,
  z.object({ plan: CompositionPlan }).strict(),
]);

export async function getNotebookExample(signal?: AbortSignal): Promise<CompositionPlan> {
  const value = await get(
    NotebookExampleResponse,
    "CompositionPlan (notebook example)",
    "/api/recombination/examples/notebook",
    signal,
  );
  return "plan" in value ? value.plan : value;
}

export function isTerminalStatus(status: JobRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export type ObservedJobResult =
  | { kind: "application"; record: ApplicationRecord }
  | { kind: "package"; package: CapabilityPackage }
  | { kind: "reference"; ref: string }
  | null;

/** Resolve `JobRecord.result_ref` without guessing a route that is not in the W5 table. */
export async function resolveJobResult(
  job: JobRecord,
  signal?: AbortSignal,
): Promise<ObservedJobResult> {
  const ref = job.result_ref;
  if (!ref) return null;
  const app = /^app:(app_[a-f0-9]{32}):\d+$/.exec(ref);
  if (app) return { kind: "application", record: await getLatestRevision(app[1], signal) };
  const pkg = /^package:(pkg_[a-f0-9]{32})$/.exec(ref);
  if (pkg) return { kind: "package", package: await getCapability(pkg[1], signal) };
  if (ref.startsWith("app_")) return { kind: "application", record: await getLatestRevision(ref, signal) };
  if (ref.startsWith("pkg_")) return { kind: "package", package: await getCapability(ref, signal) };
  return { kind: "reference", ref };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** True for SSE frames whose `data:` payload is not a valid `JobEvent`. */
class MalformedJobStreamError extends Error {}

async function consumeJobStream(
  response: Response,
  onEvent: (event: JobEvent) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frame: string[] = [];
  let sawDone = false;

  const dispatch = () => {
    const data = frame
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    frame = [];
    if (!data) return;
    let parsed: JobEvent;
    try {
      parsed = JobEvent.parse(JSON.parse(data));
    } catch (error) {
      throw new MalformedJobStreamError(
        `Malformed job event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    onEvent(parsed);
    if (parsed.type === "done") sawDone = true;
  };

  try {
    while (!sawDone) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += decoder
        .decode(value, { stream: !done })
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");

      let lineEnd: number;
      while ((lineEnd = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (line === "") dispatch();
        else if (!line.startsWith(":")) frame.push(line);
        if (sawDone) break;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!sawDone && buffer.trim() !== "") {
    frame.push(buffer);
    dispatch();
  }
  return sawDone;
}

async function pollJob(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  signal: AbortSignal | undefined,
  intervalMs: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  let last = "";
  for (;;) {
    signal?.throwIfAborted();
    const job = await getJob(jobId, signal, fetchImpl);
    const key = `${job.status}:${job.progress.stage}:${job.progress.pct}:${job.progress.message}`;
    if (key !== last) {
      last = key;
      onEvent({
        type: "stage",
        job_id: job.job_id,
        ts: Date.now(),
        stage: job.progress.stage,
        pct: job.progress.pct,
        message: job.progress.message,
      });
    }
    if (job.status === "succeeded") {
      onEvent({ type: "done", job_id: job.job_id, ts: Date.now(), ok: true });
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      if (job.error) {
        onEvent({
          type: "error",
          job_id: job.job_id,
          ts: Date.now(),
          message: job.error,
          fatal: true,
        });
      }
      onEvent({ type: "done", job_id: job.job_id, ts: Date.now(), ok: false });
      return;
    }
    await delay(intervalMs, signal);
  }
}

/**
 * Observe a durable job. Prefers the replaying SSE route (`GET /api/jobs/:jobId/events`) and
 * falls back to polling `GET /api/jobs/:jobId` when the stream route is unavailable.
 * A malformed SSE event is an error, not a silent fallback. Cancellation stops observation;
 * it does not cancel the job (use `cancelJob` for that).
 */
export async function streamJob(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  signal?: AbortSignal,
  options: { pollIntervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  signal?.throwIfAborted();
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = options.pollIntervalMs ?? 750;
  let sawDone = false;

  try {
    const response = await fetchImpl(`${jobBase(jobId)}/events`, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(
        new RecombinationApiError(
          `Job stream unavailable: ${response.status}${detail ? ` ${detail.trim().slice(0, 300)}` : ""}`,
          { url: `${jobBase(jobId)}/events`, status: response.status },
        ),
        { [JOB_SSE_FALLBACK]: true },
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      throw Object.assign(new RecombinationApiError("Job stream was not SSE", {
        url: `${jobBase(jobId)}/events`,
        status: response.status,
      }), { [JOB_SSE_FALLBACK]: true });
    }
    sawDone = await consumeJobStream(response, onEvent, signal);
  } catch (error) {
    if (isAbort(error, signal)) {
      throw error instanceof Error ? error : abortError(signal);
    }
    if (error instanceof MalformedJobStreamError) {
      throw new RecombinationApiError(error.message, { url: `${jobBase(jobId)}/events`, cause: error });
    }
    const fallback =
      typeof error === "object" && error !== null &&
      (error as { [JOB_SSE_FALLBACK]?: boolean })[JOB_SSE_FALLBACK] === true;
    if (!fallback && error instanceof RecombinationApiError) throw error;
    // Network errors and unavailable SSE routes fall through to polling.
  }

  if (!sawDone) await pollJob(jobId, onEvent, signal, intervalMs, fetchImpl);
  signal?.throwIfAborted();
}
