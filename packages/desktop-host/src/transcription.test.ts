import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompositionPlan, type TranscriptionSession } from "@splice/contracts";
import type { ProviderAdapter } from "@splice/runtime";
import { notebookPlan } from "../../backend/src/example/notebook.js";
import { openStateStore } from "../../backend/src/state/store.js";
import { DesktopTranscription } from "./transcription.js";

function wav(): Uint8Array {
  const bytes = Buffer.alloc(44 + 3_200);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(3_200, 40);
  return bytes;
}

function plan() {
  return CompositionPlan.parse(notebookPlan(new Map([
    ["splice.example.formula", `pkg_${"a".repeat(32)}`],
    ["splice.example.markdown", `pkg_${"b".repeat(32)}`],
    ["splice.example.transcription", `pkg_${"c".repeat(32)}`],
  ])));
}

test("exported host replays interrupted audio and protects a later user edit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-desktop-transcription-"));
  const oldProvider = process.env.SPLICE_TRANSCRIPTION_PROVIDER;
  process.env.SPLICE_TRANSCRIPTION_PROVIDER = "aws";
  const appId = "app_test";
  const blobRoot = path.join(root, "audio");
  const events: TranscriptionSession[] = [];
  let state = openStateStore(root);
  let transcription: DesktopTranscription | null = null;
  try {
    const interrupted: ProviderAdapter = {
      id: "aws_transcribe_streaming",
      async *transcribe(_input, { signal }) {
        yield { index: 0, startMs: 0, endMs: 100, text: "old partial", final: false };
        await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
      },
    };
    transcription = new DesktopTranscription(state, appId, plan(), blobRoot, (session) => events.push(session), () => interrupted);
    const first = await transcription.startWav(wav(), "recorded_provider", "en-US");
    await waitFor(() => transcription!.get(first.session_id)?.segments[0]?.text === "old partial");
    assert.equal((state.getDocument("meeting")?.data as { transcript: Array<{ text: string }> }).transcript[0].text, "old partial");
    await transcription.shutdown();
    assert.equal(transcription.get(first.session_id)?.status, "running");
    state.close();

    state = openStateStore(root);
    const replay: ProviderAdapter = {
      id: "aws_transcribe_streaming",
      async *transcribe() {
        yield { index: 0, startMs: 0, endMs: 100, text: "new final", final: true };
      },
    };
    transcription = new DesktopTranscription(state, appId, plan(), blobRoot, (session) => events.push(session), () => replay);
    transcription.resume();
    await waitFor(() => transcription!.get(first.session_id)?.status === "succeeded");
    assert.equal(transcription.get(first.session_id)?.attempt, 2);
    assert.equal((state.getDocument("meeting")?.data as { transcript: Array<{ text: string }> }).transcript[0].text, "new final");
    assert.ok(events.some((event) => event.attempt === 2 && event.status === "running" && event.segments.length === 0));

    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed: ProviderAdapter = {
      id: "aws_transcribe_streaming",
      async *transcribe() {
        yield { index: 0, startMs: 0, endMs: 100, text: "partial", final: false };
        await gate;
        yield { index: 0, startMs: 0, endMs: 100, text: "late final", final: true };
      },
    };
    await transcription.shutdown();
    transcription = new DesktopTranscription(state, appId, plan(), blobRoot, (session) => events.push(session), () => delayed);
    const second = await transcription.startWav(wav(), "recorded_provider", "en-US");
    await waitFor(() => transcription!.get(second.session_id)?.segments[0]?.text === "partial");
    const before = state.getDocument("meeting")!;
    state.putDocument("meeting", { ...(before.data as Record<string, unknown>), formula: "=9" }, before.revision);
    release();
    await waitFor(() => transcription!.get(second.session_id)?.status === "failed");
    assert.match(transcription.get(second.session_id)?.error ?? "", /changed during transcription/);
    assert.equal((state.getDocument("meeting")?.data as { formula: string }).formula, "=9");
    await transcription.shutdown();

    transcription = new DesktopTranscription(state, appId, plan(), blobRoot, (session) => events.push(session), () => interrupted);
    const third = await transcription.startWav(wav(), "recorded_provider", "en-US");
    await waitFor(() => transcription!.get(third.session_id)?.segments[0]?.text === "old partial");
    const cancelled = await transcription.cancel(third.session_id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(transcription.get(third.session_id)?.status, "cancelled");
    await transcription.shutdown();
  } finally {
    await transcription?.shutdown();
    state.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (oldProvider === undefined) delete process.env.SPLICE_TRANSCRIPTION_PROVIDER;
    else process.env.SPLICE_TRANSCRIPTION_PROVIDER = oldProvider;
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for desktop transcription");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
