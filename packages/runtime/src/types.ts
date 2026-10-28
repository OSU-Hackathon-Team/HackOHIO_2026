import type {
  CapabilityDefinition,
  CapabilityPackage,
  HostEffect,
  OperationSpec,
  PlatformSupport,
} from "@splice/contracts";

export interface CallOptions {
  signal?: AbortSignal;
  /** Overrides the operation's declared timeout when smaller. */
  timeoutMs?: number;
  onEvent?(event: unknown): void;
}

/** One call surface for native sidecars and isolated JS processes. Inputs/outputs are host values. */
export interface CapabilityClient {
  readonly package: CapabilityPackage;
  readonly alive: boolean;
  call(operation: string, input: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

export interface RuntimeOptions {
  /** Definition schemas are stored as a separate, hash-pinned registry artifact. */
  definition: CapabilityDefinition;
  /** Directory that contains the package's verified artifacts, by relative path. */
  artifactRoot: string;
  platform?: PlatformSupport;
  /** Granted host effects. A call that needs an ungranted effect fails before transport. */
  grantedEffects?: HostEffect[];
  env?: Record<string, string>;
  /** Hard ceiling for every call. Never lengthens an operation's declared `timeout_ms`. */
  timeoutMs?: number;
  onLog?(line: string): void;
  /** Test seam; production leaves this undefined. */
  spawnImpl?: typeof import("node:child_process").spawn;
}

export interface OperationCall {
  operation: OperationSpec;
  input: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  onEvent?(event: unknown): void;
}

export interface HostServices {
  readonly workspaceDir: string;
  readonly blobs: BlobStore;
  now(): number;
  secret(name: string): string | null;
  /** Null when no capture device/provider is available; never a fake stream. */
  audioCapture(): AudioCapture | null;
  provider(id: string): ProviderAdapter | null;
}

export interface BlobRef {
  id: string;
  size: number;
}

export interface BlobStore {
  put(bytes: Uint8Array, meta?: { contentType?: string }): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Uint8Array>;
  delete(ref: BlobRef): Promise<void>;
}

export interface AudioCapture {
  /** Yields bounded PCM chunks. The caller owns cancellation. */
  start(options: { signal?: AbortSignal; maxBytes: number }): AsyncIterable<{ pcm: Uint8Array; sampleRate: number }>;
}

export interface ProviderAdapter {
  readonly id: string;
  /** Streams ordered segments from an explicitly described audio blob; disconnecting throws a typed provider error. */
  transcribe(
    input: { audio: BlobRef; language: string | null; format: "pcm_s16le"; sampleRateHz: number; channels: 1 },
    options: { signal?: AbortSignal },
  ): AsyncIterable<{ index: number; startMs: number; endMs: number; text: string; final: boolean }>;
}

export class CapabilityCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly operation: string,
  ) {
    super(`${operation}: ${message}`);
    this.name = "CapabilityCallError";
  }
}

export class RuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}
