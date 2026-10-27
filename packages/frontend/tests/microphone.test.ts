import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMonoPcm16Wav } from "../../backend/src/example/wav.js";
import { audioBufferToMonoPcm16Wav } from "../src/recombination/microphone.js";

test("captured stereo audio becomes backend-accepted mono 16 kHz PCM16 WAV", () => {
  const left = new Float32Array(480).fill(1);
  const right = new Float32Array(480).fill(0);
  const wav = audioBufferToMonoPcm16Wav({
    numberOfChannels: 2,
    length: left.length,
    sampleRate: 48_000,
    getChannelData(index: number) { return index === 0 ? left : right; },
  });
  const parsed = parseMonoPcm16Wav(wav);
  assert.equal(parsed.sampleRateHz, 16_000);
  assert.equal(parsed.pcm.length, 320);
  const pcm = new DataView(parsed.pcm.buffer, parsed.pcm.byteOffset, parsed.pcm.byteLength);
  assert.ok(Math.abs(pcm.getInt16(0, true) - 16_384) <= 1);
  assert.ok(Math.abs(pcm.getInt16(318, true) - 16_384) <= 1);
});

test("an empty or unsupported recording cannot become a provider upload", () => {
  assert.throws(() => audioBufferToMonoPcm16Wav({
    numberOfChannels: 1,
    length: 0,
    sampleRate: 48_000,
    getChannelData() { return new Float32Array(0); },
  }), /contains no audio/);
});
