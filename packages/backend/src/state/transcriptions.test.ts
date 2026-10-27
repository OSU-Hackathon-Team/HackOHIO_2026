import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MIGRATIONS } from "./migrations.js";
import { openMemoryStateStore, openStateStore } from "./store.js";
import { TranscriptionStore } from "./transcriptions.js";

const jobId = `job_${"a".repeat(32)}`;
const audio = { id: "b".repeat(64), size: 3200 };
const segment = { index: 0, start_ms: 0, end_ms: 100, text: "budget", final: false };

test("transcript segments survive restart and a replay replaces the interrupted attempt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-transcription-state-"));
  try {
    let state = openStateStore(root);
    let transcripts = new TranscriptionStore(state);
    const created = transcripts.create({ audio, sample_rate_hz: 16_000, language: "en-US" });
    const first = transcripts.beginAttempt(created.session_id, jobId);
    assert.equal(first.session.attempt, 1);
    transcripts.putSegment(created.session_id, 1, segment);
    state.close();

    state = openStateStore(root);
    transcripts = new TranscriptionStore(state);
    assert.deepEqual(transcripts.get(created.session_id)?.segments, [segment]);
    const second = transcripts.beginAttempt(created.session_id, jobId);
    assert.equal(second.replay, true);
    assert.equal(second.session.attempt, 2);
    assert.deepEqual(second.session.segments, []);
    assert.throws(() => transcripts.putSegment(created.session_id, 1, { ...segment, final: true }), /Stale transcription attempt/);
    transcripts.putSegment(created.session_id, 2, { ...segment, final: true });
    const completed = transcripts.succeed(created.session_id, 2);
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(transcripts.beginAttempt(created.session_id, jobId), { session: completed, replay: true });
    state.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a completed segment cannot be revised or assigned to another job", () => {
  const state = openMemoryStateStore();
  try {
    const transcripts = new TranscriptionStore(state);
    const created = transcripts.create({ audio, sample_rate_hz: 16_000, language: null });
    transcripts.beginAttempt(created.session_id, jobId);
    transcripts.putSegment(created.session_id, 1, { ...segment, final: true });
    assert.throws(() => transcripts.putSegment(created.session_id, 1, { ...segment, text: "changed", final: true }), /final transcript segment changed/);
    assert.throws(() => transcripts.attachJob(created.session_id, `job_${"c".repeat(32)}`), /belongs to another job/);
    assert.throws(() => transcripts.putSegment(created.session_id, 1, { ...segment, index: 2 }), /out of order/);
  } finally { state.close(); }
});

test("migration adds transcription sessions without changing existing documents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-transcription-migrate-"));
  try {
    const old = openStateStore(root, { migrations: MIGRATIONS.slice(0, 5) });
    old.putDocument("meeting", { value: 60 }, null);
    old.close();
    const current = openStateStore(root);
    assert.deepEqual(current.getDocument("meeting")?.data, { value: 60 });
    assert.equal(current.appliedMigrations().at(-1), 6);
    assert.equal(new TranscriptionStore(current).get(`tr_${"0".repeat(32)}`), null);
    current.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
