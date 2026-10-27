import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { StartStreamTranscriptionCommandOutput } from "@aws-sdk/client-transcribe-streaming";
import { FsBlobStore } from "@splice/runtime";
import { AwsTranscribeProvider, TranscriptionProviderError } from "./awsTranscribe.js";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function audio(bytes = new Uint8Array(6_400)) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "splice-transcribe-test-"));
  temporary.push(directory);
  const blobs = new FsBlobStore(directory);
  const ref = await blobs.put(bytes);
  return { blobs, input: { audio: ref, language: "en-US", format: "pcm_s16le" as const, sampleRateHz: 16_000, channels: 1 as const } };
}

function response(results: Array<Array<{ ResultId: string; StartTime: number; EndTime: number; IsPartial: boolean; Alternatives: Array<{ Transcript: string }> }>>): StartStreamTranscriptionCommandOutput {
  return {
    $metadata: {},
    TranscriptResultStream: (async function* () {
      for (const group of results) yield { TranscriptEvent: { Transcript: { Results: group } } };
    })(),
  };
}

test("AWS provider sends bounded raw PCM chunks and emits stable partial/final segment indexes", async () => {
  const { blobs, input } = await audio();
  const chunks: number[] = [];
  const provider = new AwsTranscribeProvider({ blobs, paceAudio: false, send: async (command) => {
    assert.equal(command.input.MediaEncoding, "pcm");
    assert.equal(command.input.MediaSampleRateHertz, 16_000);
    assert.equal(command.input.LanguageCode, "en-US");
    for await (const event of command.input.AudioStream!) chunks.push(event.AudioEvent?.AudioChunk?.length ?? -1);
    return response([
      [{ ResultId: "a", StartTime: 0, EndTime: 0.2, IsPartial: true, Alternatives: [{ Transcript: "bud" }] }],
      [{ ResultId: "a", StartTime: 0, EndTime: 0.2, IsPartial: false, Alternatives: [{ Transcript: "budget" }] }],
      [{ ResultId: "a", StartTime: 0, EndTime: 0.2, IsPartial: false, Alternatives: [{ Transcript: "budget" }] }],
      [{ ResultId: "b", StartTime: 0.2, EndTime: 0.4, IsPartial: false, Alternatives: [{ Transcript: "twenty" }] }],
    ]);
  } });
  const segments = [];
  for await (const segment of provider.transcribe(input, {})) segments.push(segment);
  assert.deepEqual(chunks, [3_200, 3_200]);
  assert.deepEqual(segments, [
    { index: 0, startMs: 0, endMs: 200, text: "bud", final: false },
    { index: 0, startMs: 0, endMs: 200, text: "budget", final: true },
    { index: 1, startMs: 200, endMs: 400, text: "twenty", final: true },
  ]);
});

test("AWS provider rejects malformed PCM before opening a provider stream", async () => {
  const { blobs, input } = await audio(new Uint8Array(3));
  let sent = false;
  const provider = new AwsTranscribeProvider({ blobs, paceAudio: false, send: async () => { sent = true; return response([]); } });
  await assert.rejects(async () => { for await (const _segment of provider.transcribe(input, {})) { /* consume */ } },
    (error: unknown) => error instanceof TranscriptionProviderError && error.code === "invalid_audio");
  assert.equal(sent, false);
});

test("AWS provider reports an incomplete final segment and a disconnect distinctly", async () => {
  const { blobs, input } = await audio();
  const incomplete = new AwsTranscribeProvider({ blobs, paceAudio: false, send: async () => response([
    [{ ResultId: "a", StartTime: 0, EndTime: 0.2, IsPartial: true, Alternatives: [{ Transcript: "bud" }] }],
  ]) });
  await assert.rejects(async () => { for await (const _segment of incomplete.transcribe(input, {})) { /* consume */ } },
    (error: unknown) => error instanceof TranscriptionProviderError && error.code === "provider_incomplete" && error.retryable);
  const disconnected = new AwsTranscribeProvider({ blobs, paceAudio: false, send: async () => { throw new Error("socket closed"); } });
  await assert.rejects(async () => { for await (const _segment of disconnected.transcribe(input, {})) { /* consume */ } },
    (error: unknown) => error instanceof TranscriptionProviderError && error.code === "provider_disconnected" && error.retryable);
});

test("AWS provider honors cancellation before sending audio", async () => {
  const { blobs, input } = await audio();
  const controller = new AbortController();
  controller.abort();
  let sent = false;
  const provider = new AwsTranscribeProvider({ blobs, send: async () => { sent = true; return response([]); } });
  await assert.rejects(async () => { for await (const _segment of provider.transcribe(input, { signal: controller.signal })) { /* consume */ } },
    (error: unknown) => error instanceof TranscriptionProviderError && error.code === "cancelled");
  assert.equal(sent, false);
});
