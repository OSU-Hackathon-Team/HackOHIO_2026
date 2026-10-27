import { randomBytes } from "node:crypto";
import { TranscriptionSegment, TranscriptionSession, type TranscriptionSegment as Segment, type TranscriptionSession as Session } from "@splice/contracts";
import type { SqliteStateStore } from "./store.js";

type Row = {
  session_id: string;
  job_id: string | null;
  provider: string;
  audio_id: string;
  audio_size: number;
  sample_rate_hz: number;
  language: string | null;
  status: string;
  attempt: number;
  segments: string;
  projection: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export class TranscriptionStateError extends Error {
  constructor(message: string) { super(message); this.name = "TranscriptionStateError"; }
}

/** SQLite state for resumable provider jobs. A new attempt replaces only that session's segments. */
export class TranscriptionStore {
  constructor(private readonly state: SqliteStateStore) {}

  create(input: Pick<Session, "audio" | "sample_rate_hz" | "language"> & { projection?: Session["projection"] }): Session {
    const session_id = `tr_${randomBytes(16).toString("hex")}`;
    const now = new Date().toISOString();
    const session = TranscriptionSession.parse({
      session_id, job_id: null, provider: "aws_transcribe_streaming", ...input,
      status: "queued", attempt: 0, segments: [], projection: input.projection ?? null, error: null, created_at: now, updated_at: now,
    });
    this.state.dbHandle.prepare(`INSERT INTO transcription_sessions
      (session_id, job_id, provider, audio_id, audio_size, sample_rate_hz, language, status, attempt, segments, projection, error, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'queued', 0, '[]', ?, NULL, ?, ?)`)
      .run(session.session_id, session.provider, session.audio.id, session.audio.size, session.sample_rate_hz, session.language, session.projection ? JSON.stringify(session.projection) : null, now, now);
    return session;
  }

  get(sessionId: string): Session | null {
    const row = this.state.dbHandle.prepare("SELECT * FROM transcription_sessions WHERE session_id = ?").get(sessionId) as Row | undefined;
    if (!row) return null;
    let segments: unknown;
    try { segments = JSON.parse(row.segments); }
    catch { throw new TranscriptionStateError(`Transcription ${sessionId} has corrupt segments`); }
    return TranscriptionSession.parse({
      session_id: row.session_id,
      job_id: row.job_id,
      provider: row.provider,
      audio: { id: row.audio_id, size: Number(row.audio_size) },
      sample_rate_hz: Number(row.sample_rate_hz),
      language: row.language,
      status: row.status,
      attempt: Number(row.attempt),
      segments,
      projection: row.projection ? JSON.parse(row.projection) : null,
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  unfinished(): Session[] {
    const rows = this.state.dbHandle.prepare("SELECT session_id FROM transcription_sessions WHERE status IN ('queued', 'running') ORDER BY created_at, session_id")
      .all() as Array<{ session_id: string }>;
    return rows.map((row) => this.get(row.session_id)!);
  }

  attachJob(sessionId: string, jobId: string): Session {
    if (!/^job_[a-f0-9]{32}$/.test(jobId)) throw new TranscriptionStateError("Invalid transcription job id");
    return this.state.transaction(() => {
      const session = this.required(sessionId);
      if (session.job_id && session.job_id !== jobId) throw new TranscriptionStateError(`Transcription ${sessionId} belongs to another job`);
      if (session.job_id === jobId) return session;
      this.state.dbHandle.prepare("UPDATE transcription_sessions SET job_id = ?, updated_at = ? WHERE session_id = ?")
        .run(jobId, new Date().toISOString(), sessionId);
      return this.required(sessionId);
    });
  }

  beginAttempt(sessionId: string, jobId: string): { session: Session; replay: boolean } {
    return this.state.transaction(() => {
      const prior = this.attachJob(sessionId, jobId);
      if (prior.status === "succeeded") return { session: prior, replay: true };
      const attempt = prior.attempt + 1;
      this.state.dbHandle.prepare(`UPDATE transcription_sessions
        SET status = 'running', attempt = ?, segments = '[]', error = NULL, updated_at = ? WHERE session_id = ?`)
        .run(attempt, new Date().toISOString(), sessionId);
      return { session: this.required(sessionId), replay: prior.attempt > 0 };
    });
  }

  putSegment(sessionId: string, attempt: number, raw: Segment): Session {
    const segment = TranscriptionSegment.parse(raw);
    if (segment.end_ms < segment.start_ms) throw new TranscriptionStateError("Transcript segment ends before it starts");
    return this.state.transaction(() => {
      const session = this.running(sessionId, attempt);
      const segments = [...session.segments];
      const prior = segments.find((item) => item.index === segment.index);
      if (prior?.final) {
        if (JSON.stringify(prior) !== JSON.stringify(segment)) throw new TranscriptionStateError("A final transcript segment changed");
        return session;
      }
      if (!prior && segment.index !== segments.length) throw new TranscriptionStateError("Transcript segment index is out of order");
      if (prior) segments[segments.indexOf(prior)] = segment;
      else segments.push(segment);
      if (segments.length > 5_000) throw new TranscriptionStateError("Transcript has too many segments");
      this.state.dbHandle.prepare("UPDATE transcription_sessions SET segments = ?, updated_at = ? WHERE session_id = ?")
        .run(JSON.stringify(segments), new Date().toISOString(), sessionId);
      return this.required(sessionId);
    });
  }

  setProjectionRevision(sessionId: string, attempt: number, revision: number): Session {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TranscriptionStateError("Invalid projection revision");
    return this.state.transaction(() => {
      const session = this.running(sessionId, attempt);
      if (!session.projection) throw new TranscriptionStateError(`Transcription ${sessionId} has no document projection`);
      const projection = { ...session.projection, revision };
      this.state.dbHandle.prepare("UPDATE transcription_sessions SET projection = ?, updated_at = ? WHERE session_id = ?")
        .run(JSON.stringify(projection), new Date().toISOString(), sessionId);
      return this.required(sessionId);
    });
  }

  succeed(sessionId: string, attempt: number): Session {
    return this.state.transaction(() => {
      const session = this.running(sessionId, attempt);
      if (session.segments.some((segment) => !segment.final)) throw new TranscriptionStateError("Transcript has unfinished segments");
      this.state.dbHandle.prepare("UPDATE transcription_sessions SET status = 'succeeded', updated_at = ? WHERE session_id = ?")
        .run(new Date().toISOString(), sessionId);
      return this.required(sessionId);
    });
  }

  fail(sessionId: string, attempt: number, status: "failed" | "cancelled", message: string): Session {
    return this.state.transaction(() => {
      const session = this.running(sessionId, attempt);
      this.state.dbHandle.prepare("UPDATE transcription_sessions SET status = ?, error = ?, updated_at = ? WHERE session_id = ?")
        .run(status, message.slice(0, 2_000), new Date().toISOString(), sessionId);
      return this.required(sessionId);
    });
  }

  /** Reconcile a terminal job after restart when no provider runner can update its session. */
  reconcileTerminal(sessionId: string, status: "failed" | "cancelled", message: string): Session {
    return this.state.transaction(() => {
      const session = this.required(sessionId);
      if (session.status === "succeeded" || session.status === "failed" || session.status === "cancelled") return session;
      this.state.dbHandle.prepare("UPDATE transcription_sessions SET status = ?, error = ?, updated_at = ? WHERE session_id = ?")
        .run(status, message.slice(0, 2_000), new Date().toISOString(), sessionId);
      return this.required(sessionId);
    });
  }

  private running(sessionId: string, attempt: number): Session {
    const session = this.required(sessionId);
    if (session.status !== "running" || session.attempt !== attempt) {
      throw new TranscriptionStateError(`Stale transcription attempt ${sessionId}@${attempt}`);
    }
    return session;
  }

  private required(sessionId: string): Session {
    const session = this.get(sessionId);
    if (!session) throw new TranscriptionStateError(`Unknown transcription ${sessionId}`);
    return session;
  }
}
