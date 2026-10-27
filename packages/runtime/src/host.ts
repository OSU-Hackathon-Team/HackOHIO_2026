// Host services shared by generated capabilities.
//
// Filesystem access is workspace-scoped and content-addressed. Permissions are a first-class
// object: generated code receives only the narrow API the host chooses to expose, and the
// sensitive service methods re-check the grant on every call so a leaked reference cannot skip
// the gate.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HostEffect, OperationSpec } from "@splice/contracts";
import type {
  AudioCapture,
  BlobRef,
  BlobStore,
  HostServices,
  ProviderAdapter,
} from "./types.js";

export const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;

export class HostPermissionError extends Error {
  readonly code = "permission_denied";
  constructor(
    readonly effect: string,
    message = `host effect ${effect} is not granted`,
  ) {
    super(message);
    this.name = "HostPermissionError";
  }
}

export class BlobStoreError extends Error {
  constructor(
    readonly code: "blob_too_large" | "invalid_blob_id" | "blob_not_found" | "blob_corrupt" | "blob_write_failed",
    message: string,
  ) {
    super(message);
    this.name = "BlobStoreError";
  }
}

/**
 * Immutable grant set. Exposing this object cannot widen permissions: the effect list is a frozen
 * copy and every check consults that copy, not a mutable caller-owned array.
 */
export class HostPermissionGate {
  private readonly effects: readonly HostEffect[];

  constructor(grantedEffects: readonly HostEffect[] = []) {
    this.effects = Object.freeze([...new Set(grantedEffects)]);
    Object.freeze(this);
  }

  get grantedEffects(): readonly HostEffect[] {
    return this.effects;
  }

  has(effect: HostEffect): boolean {
    return this.effects.includes(effect);
  }

  require(effect: HostEffect): void {
    if (!this.has(effect)) throw new HostPermissionError(effect);
  }

  assertOperation(operation: OperationSpec): void {
    for (const effect of operation.host_effects) this.require(effect);
  }
}

export function createPermissionGate(grantedEffects: readonly HostEffect[] = []): HostPermissionGate {
  return new HostPermissionGate(grantedEffects);
}

export function blobId(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const BLOB_ID = /^[a-f0-9]{64}$/;
const TEMP_FILE = /^\.[a-z0-9-]+\.tmp$/;

export interface FsBlobStoreOptions {
  maxBytes?: number;
}

/**
 * Content-addressed blob store rooted at `<workspace>/blobs`. Writes land in a temporary file in
 * the destination directory and are renamed into place, so readers never observe partial bytes.
 */
export class FsBlobStore implements BlobStore {
  readonly root: string;
  private readonly maxBytes: number;

  constructor(root: string, options: FsBlobStoreOptions = {}) {
    this.root = path.resolve(root);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BLOB_BYTES;
    if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive number");
    }
    mkdirSync(this.root, { recursive: true });
  }

  async put(bytes: Uint8Array, meta?: { contentType?: string }): Promise<BlobRef> {
    if (!(bytes instanceof Uint8Array)) {
      throw new BlobStoreError("blob_write_failed", "put() expects a Uint8Array");
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new BlobStoreError("blob_too_large", `blob is ${bytes.byteLength} bytes; limit is ${this.maxBytes}`);
    }
    const id = blobId(bytes);
    const dir = path.join(this.root, id.slice(0, 2));
    const target = path.join(dir, id);
    await mkdir(dir, { recursive: true });

    const temp = path.join(dir, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, target);
      if (meta?.contentType) {
        const metaTemp = `${temp}.meta`;
        await writeFile(metaTemp, JSON.stringify({ contentType: meta.contentType }), { mode: 0o600 });
        await rename(metaTemp, `${target}.meta.json`);
      }
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw new BlobStoreError(
        "blob_write_failed",
        `could not store blob: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { id, size: bytes.byteLength };
  }

  async get(ref: BlobRef): Promise<Uint8Array> {
    const target = this.resolve(ref);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(target));
    } catch {
      throw new BlobStoreError("blob_not_found", `blob ${ref.id} does not exist`);
    }
    if (bytes.byteLength !== ref.size || blobId(bytes) !== ref.id) {
      throw new BlobStoreError("blob_corrupt", `blob ${ref.id} no longer matches its content address and size`);
    }
    return bytes;
  }

  async delete(ref: BlobRef): Promise<void> {
    const target = this.resolve(ref);
    await unlink(target).catch(() => undefined);
    await unlink(`${target}.meta.json`).catch(() => undefined);
  }

  /** True only for a well-formed id that exists inside the store. */
  async has(ref: BlobRef): Promise<boolean> {
    const target = this.resolve(ref);
    try {
      await readFile(target);
      return true;
    } catch {
      return false;
    }
  }

  /** Remove abandoned temporary files (for example after a hard crash during a write). */
  async sweepTemporaryFiles(): Promise<string[]> {
    const removed: string[] = [];
    for (const prefix of await listDirectories(this.root)) {
      for (const name of await listFiles(path.join(this.root, prefix))) {
        if (TEMP_FILE.test(name)) {
          await unlink(path.join(this.root, prefix, name)).catch(() => undefined);
          removed.push(path.join(prefix, name));
        }
      }
    }
    return removed;
  }

  private resolve(ref: BlobRef): string {
    if (!ref || typeof ref.id !== "string" || !BLOB_ID.test(ref.id)) {
      throw new BlobStoreError("invalid_blob_id", "blob id must be a 64-character lowercase sha256 hex string");
    }
    const target = path.join(this.root, ref.id.slice(0, 2), ref.id);
    const root = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (!target.startsWith(root)) {
      throw new BlobStoreError("invalid_blob_id", "blob id escapes the blob store");
    }
    return target;
  }
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listFiles(root: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export interface HostServicesOptions {
  /** Root of the application workspace. Nothing outside this directory is readable by blobs. */
  workspaceDir: string;
  grantedEffects?: readonly HostEffect[];
  maxBlobBytes?: number;
  now?: () => number;
  /** Values available through `secret()`; only names in `secretAllowlist` can be read. */
  secrets?: Record<string, string>;
  secretAllowlist?: readonly string[];
  /** Supply a real capture implementation. Omit it when the platform has none. */
  audioCapture?: AudioCapture | null;
  providers?: readonly ProviderAdapter[];
}

export class WorkspaceHostServices implements HostServices {
  readonly workspaceDir: string;
  readonly blobs: FsBlobStore;
  readonly permissions: HostPermissionGate;
  private readonly clock: () => number;
  private readonly secrets: ReadonlyMap<string, string>;
  private readonly secretAllowlist: ReadonlySet<string>;
  private readonly capture: AudioCapture | null;
  private readonly providers: ReadonlyMap<string, ProviderAdapter>;

  constructor(options: HostServicesOptions) {
    if (!options || typeof options.workspaceDir !== "string" || options.workspaceDir.length === 0) {
      throw new Error("host services need a workspaceDir");
    }
    this.workspaceDir = path.resolve(options.workspaceDir);
    mkdirSync(this.workspaceDir, { recursive: true });
    this.blobs = new FsBlobStore(path.join(this.workspaceDir, "blobs"), { maxBytes: options.maxBlobBytes });
    this.permissions = createPermissionGate(options.grantedEffects ?? []);
    this.clock = options.now ?? Date.now;
    this.secrets = new Map(Object.entries(options.secrets ?? {}));
    this.secretAllowlist = new Set(options.secretAllowlist ?? []);
    this.capture = options.audioCapture ?? null;
    this.providers = new Map((options.providers ?? []).map((provider) => [provider.id, provider]));
    Object.freeze(this);
  }

  now(): number {
    return this.clock();
  }

  secret(name: string): string | null {
    this.permissions.require("secrets");
    if (!this.secretAllowlist.has(name)) {
      throw new HostPermissionError("secrets", `secret ${name} is not in the package allowlist`);
    }
    return this.secrets.get(name) ?? null;
  }

  /** Returns null when capture is unavailable or the package did not receive the audio effect. */
  audioCapture(): AudioCapture | null {
    if (!this.permissions.has("audio_capture")) return null;
    return this.capture;
  }

  provider(id: string): ProviderAdapter | null {
    return this.providers.get(id) ?? null;
  }
}

export function createHostServices(options: HostServicesOptions): WorkspaceHostServices {
  return new WorkspaceHostServices(options);
}
