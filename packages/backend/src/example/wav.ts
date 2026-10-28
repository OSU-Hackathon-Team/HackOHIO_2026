/** Parse the declared upload format before passing raw PCM to a transcription provider. */
export interface Pcm16Audio {
  pcm: Uint8Array;
  sampleRateHz: number;
}

export function parseMonoPcm16Wav(input: Uint8Array): Pcm16Audio {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Audio upload must be a RIFF WAVE file");
  }
  if (bytes.readUInt32LE(4) + 8 > bytes.length) throw new Error("WAV header declares bytes missing from the upload");
  let format: { encoding: number; channels: number; sampleRateHz: number; bitsPerSample: number } | null = null;
  let pcm: Uint8Array | null = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error(`WAV ${type} chunk is truncated`);
    if (type === "fmt ") {
      if (size < 16) throw new Error("WAV format chunk is incomplete");
      format = {
        encoding: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRateHz: bytes.readUInt32LE(start + 4),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      };
    }
    if (type === "data") pcm = bytes.subarray(start, start + size);
    offset = start + size + size % 2;
  }
  if (!format || !pcm || format.encoding !== 1 || format.channels !== 1 || format.bitsPerSample !== 16 || pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("Audio upload must contain nonempty mono signed 16-bit PCM data");
  }
  if (!Number.isInteger(format.sampleRateHz) || format.sampleRateHz < 8_000 || format.sampleRateHz > 48_000) {
    throw new Error("WAV sample rate must be between 8000 and 48000 Hz");
  }
  return { pcm, sampleRateHz: format.sampleRateHz };
}
