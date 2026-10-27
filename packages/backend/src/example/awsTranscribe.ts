/** Optional live transcription provider. It accepts raw mono PCM blobs, not WAV containers. */
import { setTimeout as delay } from "node:timers/promises";
import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
  type LanguageCode,
  type StartStreamTranscriptionCommandOutput,
} from "@aws-sdk/client-transcribe-streaming";
import type { BlobStore, ProviderAdapter } from "@splice/runtime";

type AudioInput = Parameters<ProviderAdapter["transcribe"]>[0];
type Segment = ReturnType<ProviderAdapter["transcribe"]> extends AsyncIterable<infer T> ? T : never;

export class TranscriptionProviderError extends Error {
  constructor(
    readonly code: "invalid_audio" | "invalid_response" | "provider_disconnected" | "provider_incomplete" | "cancelled",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TranscriptionProviderError";
  }
}

export interface AwsTranscribeOptions {
  blobs: BlobStore;
  region?: string;
  defaultLanguage?: LanguageCode;
  /** Production sends 100 ms chunks at the source rate. Tests may disable pacing. */
  paceAudio?: boolean;
  send?: (
    command: StartStreamTranscriptionCommand,
    options: { abortSignal?: AbortSignal },
  ) => Promise<StartStreamTranscriptionCommandOutput>;
}

function validateAudio(input: AudioInput, bytes: Uint8Array): void {
  if (input.format !== "pcm_s16le" || input.channels !== 1) {
    throw new TranscriptionProviderError("invalid_audio", "AWS streaming requires raw mono signed 16-bit little-endian PCM", false);
  }
  if (!Number.isInteger(input.sampleRateHz) || input.sampleRateHz < 8_000 || input.sampleRateHz > 48_000) {
    throw new TranscriptionProviderError("invalid_audio", "PCM sample rate must be an integer from 8000 to 48000 Hz", false);
  }
  if (bytes.length === 0 || bytes.length % 2 !== 0 || bytes.length !== input.audio.size) {
    throw new TranscriptionProviderError("invalid_audio", "PCM bytes must be nonempty, sample-aligned and match the blob reference size", false);
  }
}

function transcriptSegment(result: {
  ResultId?: string;
  StartTime?: number;
  EndTime?: number;
  IsPartial?: boolean;
  Alternatives?: Array<{ Transcript?: string }>;
}): Omit<Segment, "index"> & { id: string } {
  const { ResultId: id, StartTime: start, EndTime: end, IsPartial: partial } = result;
  if (!id || typeof partial !== "boolean" || !Number.isFinite(start) || !Number.isFinite(end) || start! < 0 || end! < start!) {
    throw new TranscriptionProviderError("invalid_response", "Provider returned a result without a stable id, finality or valid timestamps", false);
  }
  const text = result.Alternatives?.[0]?.Transcript;
  if (typeof text !== "string") throw new TranscriptionProviderError("invalid_response", `Provider result ${id} has no transcript text`, false);
  return { id, startMs: Math.round(start! * 1000), endMs: Math.round(end! * 1000), text, final: !partial };
}

export class AwsTranscribeProvider implements ProviderAdapter {
  readonly id = "aws_transcribe_streaming";
  private readonly blobs: BlobStore;
  private readonly defaultLanguage: LanguageCode;
  private readonly paceAudio: boolean;
  private readonly send: NonNullable<AwsTranscribeOptions["send"]>;

  constructor(options: AwsTranscribeOptions) {
    this.blobs = options.blobs;
    this.defaultLanguage = options.defaultLanguage ?? "en-US";
    this.paceAudio = options.paceAudio ?? true;
    const client = options.send ? null : new TranscribeStreamingClient({ region: options.region });
    this.send = options.send ?? ((command, sendOptions) => client!.send(command, sendOptions));
  }

  async *transcribe(input: AudioInput, options: { signal?: AbortSignal } = {}): AsyncIterable<Segment> {
    const signal = options.signal;
    if (signal?.aborted) throw new TranscriptionProviderError("cancelled", "Transcription was cancelled", false);
    const bytes = await this.blobs.get(input.audio);
    validateAudio(input, bytes);
    const language = input.language ?? this.defaultLanguage;
    const chunkBytes = Math.round(input.sampleRateHz / 10) * 2;
    const audioStream = async function* (pace: boolean): AsyncIterable<AudioStream> {
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        if (signal?.aborted) throw new TranscriptionProviderError("cancelled", "Transcription was cancelled", false);
        yield { AudioEvent: { AudioChunk: bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)) } };
        if (pace && offset + chunkBytes < bytes.length) await delay(100, undefined, { signal });
      }
    };
    const command = new StartStreamTranscriptionCommand({
      AudioStream: audioStream(this.paceAudio),
      LanguageCode: language as LanguageCode,
      MediaEncoding: "pcm",
      MediaSampleRateHertz: input.sampleRateHz,
    });
    const seen = new Map<string, Segment>();
    let lastFinalStart = -1;
    try {
      const response = await this.send(command, { abortSignal: signal });
      if (!response.TranscriptResultStream) {
        throw new TranscriptionProviderError("invalid_response", "Provider returned no transcript event stream", false);
      }
      for await (const event of response.TranscriptResultStream) {
        if (signal?.aborted) throw new TranscriptionProviderError("cancelled", "Transcription was cancelled", false);
        for (const raw of event.TranscriptEvent?.Transcript?.Results ?? []) {
          const segment = transcriptSegment(raw);
          const previous = seen.get(segment.id);
          const value: Segment = { index: previous?.index ?? seen.size, startMs: segment.startMs, endMs: segment.endMs, text: segment.text, final: segment.final };
          if (previous?.final) {
            if (!value.final || value.text !== previous.text || value.startMs !== previous.startMs || value.endMs !== previous.endMs) {
              throw new TranscriptionProviderError("invalid_response", `Provider changed completed result ${segment.id}`, false);
            }
            continue;
          }
          if (value.final && value.startMs < lastFinalStart) {
            throw new TranscriptionProviderError("invalid_response", `Provider completed result ${segment.id} out of order`, false);
          }
          if (value.final) lastFinalStart = value.startMs;
          seen.set(segment.id, value);
          if (!previous || previous.text !== value.text || previous.startMs !== value.startMs || previous.endMs !== value.endMs || previous.final !== value.final) yield value;
        }
      }
      if ([...seen.values()].some((result) => !result.final)) {
        throw new TranscriptionProviderError("provider_incomplete", "Provider stream closed before all transcript segments were final", true);
      }
    } catch (cause) {
      if (cause instanceof TranscriptionProviderError) throw cause;
      if (signal?.aborted) throw new TranscriptionProviderError("cancelled", "Transcription was cancelled", false);
      throw new TranscriptionProviderError("provider_disconnected", cause instanceof Error ? cause.message : String(cause), true);
    }
  }
}
