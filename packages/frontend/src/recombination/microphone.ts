/** Browser microphone capture for the optional external transcription provider. */
const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 300;
const MAX_WAV_BYTES = 10 * 1024 * 1024;

export interface MicrophoneCapture {
  /** Resolves with a mono PCM16 WAV, or null when the user discarded the recording. */
  finished: Promise<File | null>;
  stop(): void;
  discard(): void;
}

/** Convert a decoded recording to the upload format without adding a WAV container to AWS PCM. */
export function audioBufferToMonoPcm16Wav(audio: Pick<AudioBuffer, "numberOfChannels" | "length" | "sampleRate" | "getChannelData">): Uint8Array {
  if (!audio.numberOfChannels || !audio.length || !Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
    throw new Error("The microphone recording contains no audio");
  }
  const frames = Math.round(audio.length * SAMPLE_RATE / audio.sampleRate);
  const byteLength = 44 + frames * 2;
  if (frames === 0 || byteLength > MAX_WAV_BYTES) throw new Error("Microphone recording exceeds the 10 MB WAV limit");
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  const output = new Uint8Array(byteLength);
  const view = new DataView(output.buffer);
  const word = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) output[offset + i] = value.charCodeAt(i); };
  word(0, "RIFF"); view.setUint32(4, byteLength - 8, true); word(8, "WAVE");
  word(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, "data"); view.setUint32(40, frames * 2, true);
  for (let frame = 0; frame < frames; frame += 1) {
    const source = Math.min(audio.length - 1, frame * audio.sampleRate / SAMPLE_RATE);
    const left = Math.floor(source);
    const right = Math.min(audio.length - 1, left + 1);
    const fraction = source - left;
    let sample = 0;
    for (const channel of channels) sample += channel[left] * (1 - fraction) + channel[right] * fraction;
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    view.setInt16(44 + frame * 2, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true);
  }
  return output;
}

export async function startMicrophoneCapture(): Promise<MicrophoneCapture> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Microphone capture is unavailable. Open Studio over HTTPS or localhost in a supported browser.");
  }
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
  catch (cause) {
    if (cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "SecurityError")) {
      throw new Error("Microphone permission was denied. Allow microphone access in the browser and try again.");
    }
    throw cause;
  }
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(stream); }
  catch (cause) { stream.getTracks().forEach((track) => track.stop()); throw cause; }
  const chunks: Blob[] = [];
  let discarded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = new Promise<File | null>((resolve, reject) => {
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = (event) => {
      clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop());
      reject((event as Event & { error?: DOMException }).error ?? new Error("Microphone recording failed"));
    };
    recorder.onstop = async () => {
      clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop());
      if (discarded) { resolve(null); return; }
      let context: AudioContext | null = null;
      try {
        context = new AudioContext();
        const encoded = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
        const decoded = await context.decodeAudioData(encoded);
        const wav = audioBufferToMonoPcm16Wav(decoded);
        resolve(new File([wav.buffer as ArrayBuffer], `meeting-${Date.now()}.wav`, { type: "audio/wav" }));
      } catch (cause) { reject(cause); }
      finally { await context?.close().catch(() => undefined); }
    };
  });
  try { recorder.start(); }
  catch (cause) { stream.getTracks().forEach((track) => track.stop()); throw cause; }
  timer = setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, MAX_SECONDS * 1000);
  const stop = () => { if (recorder.state !== "inactive") recorder.stop(); };
  return {
    finished,
    stop,
    discard: () => { discarded = true; stop(); },
  };
}
