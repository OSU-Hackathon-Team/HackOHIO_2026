import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { JobEvent, TranscriptionStartResponse } from "@splice/contracts";
import type { ProviderAdapter } from "@splice/runtime";
import { createRecombinationRouter } from "../routes/recombination.js";
import { hashJson } from "../capabilities/identity.js";
import { TranscriptionStore } from "../state/transcriptions.js";
import { JobManager } from "./jobs.js";
import { FilesystemRecombinationService } from "./service.js";

const TOKEN = "a".repeat(40);
const originalProvider = process.env.SPLICE_TRANSCRIPTION_PROVIDER;
const originalToken = process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN;
process.env.SPLICE_TRANSCRIPTION_PROVIDER = "aws";
process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN = TOKEN;
process.on("exit", () => {
  if (originalProvider === undefined) delete process.env.SPLICE_TRANSCRIPTION_PROVIDER;
  else process.env.SPLICE_TRANSCRIPTION_PROVIDER = originalProvider;
  if (originalToken === undefined) delete process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN;
  else process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN = originalToken;
});

function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 3_200);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(3_200, 40);
  return bytes;
}

function provider(text: string): ProviderAdapter {
  return {
    id: "aws_transcribe_streaming",
    async *transcribe(input) {
      assert.equal(input.audio.size, 3_200);
      yield { index: 0, startMs: 0, endMs: 100, text: "partial", final: false };
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { index: 0, startMs: 0, endMs: 100, text, final: true };
    },
  };
}

test("transcription job streams after upload, survives observation disconnect and persists for reload", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-transcription-http-"));
  const service = new FilesystemRecombinationService(root, { transcriptionProvider: () => provider("budget") });
  const jobs = new JobManager(root);
  const app = express();
  app.use(express.json());
  app.use(createRecombinationRouter(service, jobs));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unauthorized = await fetch(`${base}/api/recombination/transcription/jobs`, {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav(),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((service.state.dbHandle.prepare("SELECT COUNT(*) AS count FROM transcription_sessions").get() as { count: number }).count, 0);
    const startedResponse = await fetch(`${base}/api/recombination/transcription/jobs`, {
      method: "POST", headers: { "Content-Type": "audio/wav", "X-Splice-Transcription-Token": TOKEN }, body: wav(),
    });
    assert.equal(startedResponse.status, 202);
    const started = TranscriptionStartResponse.parse(await startedResponse.json());
    assert.equal(started.job.kind, "transcription");
    assert.equal((await fetch(`${base}/api/jobs/${started.job.job_id}`)).status, 404, "generic job route cannot expose speech data");
    assert.equal((await fetch(`${base}/api/recombination/transcription/jobs/${started.session.session_id}`)).status, 401);
    const eventsResponse = await fetch(`${base}/api/recombination/transcription/jobs/${started.session.session_id}/events`, {
      headers: { "X-Splice-Transcription-Token": TOKEN, Accept: "text/event-stream" },
    });
    assert.equal(eventsResponse.status, 200);
    const observer = eventsResponse.body!.getReader();
    await observer.read();
    await observer.cancel();
    await jobs.wait(started.job.job_id);
    const resumedEvents = await fetch(`${base}/api/recombination/transcription/jobs/${started.session.session_id}/events`, {
      headers: { "X-Splice-Transcription-Token": TOKEN, Accept: "text/event-stream" },
    });
    const events = (await resumedEvents.text()).split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => JobEvent.parse(JSON.parse(line.slice(5))));
    assert.ok(events.some((event) => event.type === "transcription_reset" && event.attempt === 1));
    assert.ok(events.some((event) => event.type === "transcription_segment" && event.final && event.text === "budget"));
    assert.ok(events.some((event) => event.type === "done" && event.ok));
    const saved = await fetch(`${base}/api/recombination/transcription/jobs/${started.session.session_id}`, {
      headers: { "X-Splice-Transcription-Token": TOKEN },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json() as { segments: unknown[]; status: string }).segments, [
      { index: 0, start_ms: 0, end_ms: 100, text: "budget", final: true },
    ]);
    service.close();
    const reopened = new FilesystemRecombinationService(root);
    try { assert.equal((await reopened.getTranscriptionSession(started.session.session_id))?.status, "succeeded"); }
    finally { reopened.close(); }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("transcription projects each segment into the application document and rejects a concurrent edit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-transcription-projection-"));
  let release = () => {};
  let gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter: ProviderAdapter = {
    id: "aws_transcribe_streaming",
    async *transcribe() {
      yield { index: 0, startMs: 0, endMs: 100, text: "partial", final: false };
      yield { index: 0, startMs: 0, endMs: 100, text: "partial", final: false };
      await gate;
      yield { index: 0, startMs: 0, endMs: 100, text: "final", final: true };
    },
  };
  let service = new FilesystemRecombinationService(root, { transcriptionProvider: () => adapter });
  try {
    await service.seedAuthored();
    const plan = await service.notebookPlan();
    const buildContext = { signal: new AbortController().signal, stage() {}, log() {}, transcriptionReset() {}, transcriptionSegment() {} };
    const built = await service.buildApp(plan, buildContext);
    const run = async (jobId: string) => {
      let sawPartial = () => {};
      const partial = new Promise<void>((resolve) => { sawPartial = resolve; });
      const session = await service.prepareTranscription({ pcm: new Uint8Array(3_200), sampleRateHz: 16_000, language: "en-US", appId: built.app_id, providerId: "recorded_provider" });
      const result = service.runTranscription(session.session_id, {
        ...buildContext, job_id: jobId,
        transcriptionSegment(_attempt, segment) { if (!segment.final) sawPartial(); },
      });
      await partial;
      return { session, result };
    };
    const first = await run(`job_${"b".repeat(32)}`);
    await new Promise((resolve) => setImmediate(resolve));
    const document = service.state.getDocument(`${built.app_id}:meeting`);
    assert.deepEqual((document?.data as { transcript: unknown[] }).transcript, [{ id: "aws-0", start_ms: 0, end_ms: 100, text: "partial" }]);
    assert.equal(document?.revision, 3, "duplicate provider updates do not advance the document revision");
    assert.equal((document?.data as { formula: string }).formula, "");
    release();
    await first.result;
    assert.equal((service.state.getDocument(`${built.app_id}:meeting`)?.data as { transcript: Array<{ text: string }> }).transcript[0].text, "final");
    assert.equal((await service.getTranscriptionSession(first.session.session_id))?.projection?.revision, 4);

    service.close();
    service = new FilesystemRecombinationService(root, { transcriptionProvider: () => adapter });
    assert.equal((service.state.getDocument(`${built.app_id}:meeting`)?.data as { transcript: Array<{ text: string }> }).transcript[0].text, "final");

    gate = new Promise<void>((resolve) => { release = resolve; });
    const second = await run(`job_${"c".repeat(32)}`);
    const beforeEdit = service.state.getDocument(`${built.app_id}:meeting`)!;
    const edited = { ...(beforeEdit.data as Record<string, unknown>), formula: "=9" };
    service.state.putDocument(`${built.app_id}:meeting`, edited, beforeEdit.revision);
    release();
    await assert.rejects(second.result, /changed during transcription/);
    assert.equal((await service.getTranscriptionSession(second.session.session_id))?.status, "failed");
    const protectedDocument = service.state.getDocument(`${built.app_id}:meeting`)!;
    assert.equal((protectedDocument.data as { formula: string }).formula, "=9");
    assert.equal((protectedDocument.data as { transcript: Array<{ text: string }> }).transcript[0].text, "partial");
  } finally {
    release();
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted transcription job restarts from its saved audio and discards old partial results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-transcription-resume-"));
  const jobId = `job_${"d".repeat(32)}`;
  let service = new FilesystemRecombinationService(root, { transcriptionProvider: () => provider("fresh") });
  try {
    const session = await service.prepareTranscription({ pcm: wav().subarray(44), sampleRateHz: 16_000, language: "en-US" });
    const saved = new TranscriptionStore(service.state);
    saved.beginAttempt(session.session_id, jobId);
    saved.putSegment(session.session_id, 1, { index: 0, start_ms: 0, end_ms: 100, text: "old partial", final: false });
    service.close();
    const request = { session_id: session.session_id };
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
    fs.writeFileSync(path.join(root, "jobs", `${jobId}.json`), JSON.stringify({
      job_id: jobId, kind: "transcription", status: "running",
      progress: { stage: "transcribing", pct: 10, message: "working", checkpoint: null },
      created_at: now, updated_at: now, result_ref: null, error: null,
      request_hash: hashJson(request), events: [], resume_request: { kind: "transcription", request },
    }));
    service = new FilesystemRecombinationService(root, { transcriptionProvider: () => provider("fresh") });
    const jobs = new JobManager(root);
    createRecombinationRouter(service, jobs);
    await jobs.wait(jobId);
    assert.equal(jobs.get(jobId)?.status, "succeeded");
    assert.equal(jobs.get(jobId)?.result_ref, `transcription:${session.session_id}`);
    const recovered = await service.getTranscriptionSession(session.session_id);
    assert.equal(recovered?.attempt, 2);
    assert.deepEqual(recovered?.segments, [{ index: 0, start_ms: 0, end_ms: 100, text: "fresh", final: true }]);
    assert.ok(jobs.events(jobId).some((event) => event.type === "transcription_reset" && event.attempt === 2));
  } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("cancelling a transcription job leaves a durable cancelled session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-transcription-cancel-"));
  const blocking: ProviderAdapter = {
    id: "aws_transcribe_streaming",
    async *transcribe(_input, options) {
      yield { index: 0, startMs: 0, endMs: 100, text: "partial", final: false };
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("cancelled by provider signal");
    },
  };
  const service = new FilesystemRecombinationService(root, { transcriptionProvider: () => blocking });
  const jobs = new JobManager(root);
  const app = express();
  app.use(express.json()); app.use(createRecombinationRouter(service, jobs));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/recombination/transcription/jobs`, {
      method: "POST", headers: { "Content-Type": "audio/wav", "X-Splice-Transcription-Token": TOKEN }, body: wav(),
    });
    const started = TranscriptionStartResponse.parse(await response.json());
    assert.equal((await fetch(`${base}/api/jobs/${started.job.job_id}/cancel`, { method: "POST" })).status, 404);
    const cancelled = await fetch(`${base}/api/recombination/transcription/jobs/${started.session.session_id}/cancel`, {
      method: "POST", headers: { "X-Splice-Transcription-Token": TOKEN },
    });
    assert.equal(cancelled.status, 200);
    await jobs.wait(started.job.job_id);
    assert.equal(jobs.get(started.job.job_id)?.status, "cancelled");
    const session = await service.getTranscriptionSession(started.session.session_id);
    assert.equal(session?.status, "cancelled");
    assert.equal(session?.segments[0]?.final, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
