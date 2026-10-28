import { randomBytes } from "node:crypto";
import { canonicalJson, encodeWireValue, type CompositionPlan, type TranscriptionSession } from "@splice/contracts";
import { FsBlobStore, type ProviderAdapter } from "@splice/runtime";
import { projectTranscript } from "../../backend/src/composition/transcriptProjection.js";
import { AwsTranscribeProvider } from "../../backend/src/example/awsTranscribe.js";
import { parseMonoPcm16Wav } from "../../backend/src/example/wav.js";
import type { SqliteStateStore } from "../../backend/src/state/store.js";
import { TranscriptionStore } from "../../backend/src/state/transcriptions.js";

const MAX_WAV_BYTES = 10 * 1024 * 1024;

/** Host-owned provider jobs for an exported application. The renderer receives snapshots only. */
export class DesktopTranscription {
  private readonly sessions: TranscriptionStore;
  private readonly blobs: FsBlobStore;
  private readonly active = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private stopping = false;

  constructor(
    private readonly state: SqliteStateStore,
    private readonly appId: string,
    private readonly plan: CompositionPlan,
    blobRoot: string,
    private readonly emit: (session: TranscriptionSession) => void,
    private readonly provider: (blobs: FsBlobStore) => ProviderAdapter = (blobs) => new AwsTranscribeProvider({ blobs, region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION }),
  ) {
    this.sessions = new TranscriptionStore(state);
    this.blobs = new FsBlobStore(blobRoot, { maxBytes: MAX_WAV_BYTES });
  }

  availability() {
    const configured = process.env.SPLICE_TRANSCRIPTION_PROVIDER === "aws";
    return {
      configured,
      provider: configured ? "aws_transcribe_streaming" as const : null,
      detail: configured ? "AWS Transcribe Streaming is configured as an external provider" : "Set SPLICE_TRANSCRIPTION_PROVIDER=aws and AWS credentials in the app environment",
    };
  }

  list(): TranscriptionSession[] {
    return this.state.dbHandle.prepare("SELECT session_id FROM transcription_sessions ORDER BY created_at DESC LIMIT 30")
      .all().map((row) => this.sessions.get((row as { session_id: string }).session_id)!).filter((session) => session.projection?.app_id === this.appId);
  }

  get(sessionId: string): TranscriptionSession | null {
    const session = this.sessions.get(sessionId);
    return session?.projection?.app_id === this.appId ? session : null;
  }

  async startWav(bytes: Uint8Array, providerId: string, language: string): Promise<TranscriptionSession> {
    if (this.stopping) throw new Error("Application is closing");
    if (!this.availability().configured) throw new Error("External transcription provider is not configured");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_WAV_BYTES) throw new Error("WAV file must be 10 MB or smaller");
    if (!/^[a-z]{2,3}-[A-Z]{2}$/.test(language)) throw new Error("Language must be a code such as en-US");
    const declared = this.plan.providers.find((item) => item.id === providerId)?.document_projection;
    if (!declared) throw new Error(`Provider ${providerId} has no document projection`);
    const document = this.plan.documents.find((item) => item.id === declared.document);
    if (!document || document.owner_instance !== null || !document.revisioned || document.initial === undefined) throw new Error("Provider projection document is unavailable");
    const audio = parseMonoPcm16Wav(bytes);
    const ref = await this.blobs.put(audio.pcm, { contentType: "audio/L16" });
    const session = this.state.transaction(() => {
      const current = this.state.getDocument(declared.document)
        ?? this.state.putDocument(declared.document, encodeWireValue(document.schema, document.initial), null);
      const projection = { app_id: this.appId, provider_id: providerId, ...declared, revision: current.revision };
      const created = this.sessions.create({ audio: ref, sample_rate_hz: audio.sampleRateHz, language, projection });
      return this.sessions.attachJob(created.session_id, `job_${randomBytes(16).toString("hex")}`);
    });
    this.launch(session.session_id);
    return session;
  }

  resume(): void {
    for (const session of this.sessions.unfinished()) {
      if (session.projection?.app_id === this.appId && session.job_id) this.launch(session.session_id);
    }
  }

  async cancel(sessionId: string): Promise<TranscriptionSession> {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Unknown transcription ${sessionId}`);
    const running = this.active.get(sessionId);
    if (running) {
      running.controller.abort();
      await running.work;
    } else if (session.status === "queued" || session.status === "running") {
      const cancelled = this.sessions.reconcileTerminal(sessionId, "cancelled", "Transcription cancelled");
      this.emit(cancelled);
    }
    return this.get(sessionId)!;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const { controller } of this.active.values()) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.active.values()].map(({ work }) => work)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private launch(sessionId: string): void {
    if (this.active.has(sessionId) || this.stopping) return;
    const controller = new AbortController();
    const work = this.run(sessionId, controller.signal).finally(() => { this.active.delete(sessionId); });
    this.active.set(sessionId, { controller, work });
  }

  private async run(sessionId: string, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    try {
      const started = this.state.transaction(() => {
        const prior = this.sessions.get(sessionId);
        if (!prior?.job_id || prior.projection?.app_id !== this.appId) throw new Error(`Invalid transcription ${sessionId}`);
        const value = this.sessions.beginAttempt(sessionId, prior.job_id);
        if (value.session.status !== "succeeded") projectTranscript(this.state, this.sessions, this.plan, value.session, []);
        return value.session;
      });
      if (started.status === "succeeded") return;
      attempt = started.attempt;
      this.emit(this.sessions.get(sessionId)!);
      const provider = this.provider(this.blobs);
      for await (const raw of provider.transcribe({ audio: started.audio, language: started.language, format: "pcm_s16le", sampleRateHz: started.sample_rate_hz, channels: 1 }, { signal })) {
        if (signal.aborted) throw new Error("Transcription cancelled");
        const segment = { index: raw.index, start_ms: raw.startMs, end_ms: raw.endMs, text: raw.text, final: raw.final };
        const saved = this.state.transaction(() => {
          const previous = this.sessions.get(sessionId);
          const updated = this.sessions.putSegment(sessionId, attempt, segment);
          if (canonicalJson(previous?.segments ?? []) !== canonicalJson(updated.segments)) {
            projectTranscript(this.state, this.sessions, this.plan, updated, updated.segments);
          }
          return this.sessions.get(sessionId)!;
        });
        this.emit(saved);
      }
      if (signal.aborted) throw new Error("Transcription cancelled");
      this.emit(this.sessions.succeed(sessionId, attempt));
    } catch (cause) {
      if (this.stopping) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      const status = signal.aborted ? "cancelled" : "failed";
      const session = this.sessions.get(sessionId);
      const saved = session?.status === "running" && session.attempt === attempt
        ? this.sessions.fail(sessionId, attempt, status, message)
        : this.sessions.reconcileTerminal(sessionId, status, message);
      this.emit(saved);
    }
  }
}
