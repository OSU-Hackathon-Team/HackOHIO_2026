// Shared transport helpers. Both runtime kinds validate the same wire schemas and surface the
// same CapabilityCallError codes, so callers do not branch on where a package executes.
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  decodeWireValue,
  encodeWireValue,
  canonicalJson,
  type CapabilityDefinition,
  type CapabilityPackage,
  type HostEffect,
  type OperationSpec,
  type WireType,
} from "@splice/contracts";
import { CapabilityCallError, RuntimeUnavailableError, type CallOptions, type RuntimeOptions } from "./types.js";

/** One protocol line may not exceed this many bytes (PROTOCOL.md). */
export const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
/** Captured stderr is for diagnostics only; keep the last chunk bounded. */
export const DEFAULT_STDERR_CAP_BYTES = 64 * 1024;
/** Default startup deadline for a package process before a call may write. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Resolve a package-relative artifact path without allowing escapes.
 *
 * Rejects absolute paths, drive-letter paths, `..` segments (even ones that would resolve back
 * inside), embedded NUL bytes, missing files and symlinks whose target leaves the artifact root.
 */
export async function resolveArtifactPath(root: string, relative: string): Promise<string> {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new RuntimeUnavailableError("artifact path is empty");
  }
  if (relative.includes("\0")) {
    throw new RuntimeUnavailableError("artifact path contains a NUL byte");
  }
  if (path.isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative) || relative.startsWith("\\\\")) {
    throw new RuntimeUnavailableError(`artifact path must be relative to the artifact root: ${relative}`);
  }
  const segments = relative.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new RuntimeUnavailableError(`artifact path must not contain '..': ${relative}`);
  }

  const rootAbs = path.resolve(root);
  const candidate = path.resolve(rootAbs, relative);
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + path.sep)) {
    throw new RuntimeUnavailableError(`artifact path escapes the artifact root: ${relative}`);
  }

  let rootReal: string;
  try {
    rootReal = await realpath(rootAbs);
  } catch {
    throw new RuntimeUnavailableError(`artifact root does not exist: ${rootAbs}`);
  }

  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch {
    throw new RuntimeUnavailableError(`artifact not found inside the artifact root: ${relative}`);
  }
  if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + path.sep)) {
    throw new RuntimeUnavailableError(`artifact path resolves outside the artifact root: ${relative}`);
  }

  const info = await stat(candidateReal);
  if (!info.isFile()) {
    throw new RuntimeUnavailableError(`artifact is not a regular file: ${relative}`);
  }
  return candidateReal;
}

export function findOperation(definition: CapabilityDefinition, name: string): OperationSpec {
  const operation = definition.operations.find((candidate) => candidate.name === name);
  if (!operation) {
    throw new CapabilityCallError("protocol", `package does not define operation ${name}`, false, name);
  }
  return operation;
}

/** The full definition is a separately stored, content-addressed artifact. */
export function assertDefinitionMatchesPackage(pkg: CapabilityPackage, definition: CapabilityDefinition): void {
  if (definition.id !== pkg.definition.id || definition.version !== pkg.definition.version) {
    throw new RuntimeUnavailableError(`definition identity does not match package ${pkg.package_id}`);
  }
  const hash = createHash("sha256").update(canonicalJson(definition)).digest("hex");
  if (hash !== pkg.definition.hash) {
    throw new RuntimeUnavailableError(`definition hash does not match package ${pkg.package_id}`);
  }
}

/** Resolve an entrypoint only when the registry manifest pins its exact bytes. */
export async function resolveVerifiedEntrypoint(
  pkg: CapabilityPackage,
  artifactRoot: string,
  kind: "module" | "sidecar_executable",
): Promise<string> {
  const entrypoint = selectEntrypoint(pkg, kind);
  const artifact = pkg.artifacts.find((candidate) => candidate.path === entrypoint.path);
  if (!artifact) throw new RuntimeUnavailableError(`entrypoint ${entrypoint.path} is not in the package artifact list`);
  const resolved = await resolveArtifactPath(artifactRoot, artifact.path);
  const actual = createHash("sha256").update(await readFile(resolved)).digest("hex");
  if (actual !== artifact.sha256) {
    throw new RuntimeUnavailableError(`artifact hash mismatch for ${artifact.path}`);
  }
  return resolved;
}

/** A call whose declared host effects are not all granted is refused before any process starts. */
export function assertOperationEffects(operation: OperationSpec, grantedEffects: readonly HostEffect[] | undefined): void {
  const granted = new Set(grantedEffects ?? []);
  for (const effect of operation.host_effects) {
    if (!granted.has(effect)) {
      throw new CapabilityCallError(
        "permission_denied",
        `operation requires host effect ${effect}, which was not granted`,
        false,
        operation.name,
      );
    }
  }
}

/** Operation timeout, capped (never extended) by runtime and per-call ceilings. */
export function effectiveTimeoutMs(
  operation: OperationSpec,
  options: Pick<RuntimeOptions, "timeoutMs">,
  callOptions?: Pick<CallOptions, "timeoutMs">,
): number {
  let timeoutMs = operation.timeout_ms;
  if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
    timeoutMs = Math.min(timeoutMs, options.timeoutMs);
  }
  if (typeof callOptions?.timeoutMs === "number" && callOptions.timeoutMs > 0) {
    timeoutMs = Math.min(timeoutMs, callOptions.timeoutMs);
  }
  return Math.max(1, Math.floor(timeoutMs));
}

/**
 * Validate a host value against a wire type without changing its representation.
 * Returns a canonical host value (for example i64 becomes a `bigint`).
 */
export function normalizeHostValue(type: WireType, value: unknown, operation: string, what: string): unknown {
  try {
    return decodeWireValue(type, encodeWireValue(type, value));
  } catch (error) {
    throw new CapabilityCallError("protocol", `${what} does not match the wire schema: ${errorMessage(error)}`, false, operation);
  }
}

/** Validate and encode a request for a JSON transport. */
export function encodeRequest(operation: OperationSpec, input: unknown): Record<string, unknown> {
  try {
    return encodeWireValue(operation.request, input) as Record<string, unknown>;
  } catch (error) {
    throw new CapabilityCallError(
      "protocol",
      `request does not match the wire schema: ${errorMessage(error)}`,
      false,
      operation.name,
    );
  }
}

/** Decode a result that arrived from a JSON transport. */
export function decodeResult(operation: OperationSpec, value: unknown): Record<string, unknown> {
  try {
    const decoded = decodeWireValue(operation.result, value);
    if (!isRecord(decoded)) throw new Error("result is not an object");
    return decoded;
  } catch (error) {
    throw new CapabilityCallError(
      "protocol",
      `result does not match the wire schema: ${errorMessage(error)}`,
      false,
      operation.name,
    );
  }
}

/** Decode a streaming event; a non-streaming operation may not receive one. */
export function decodeEvent(operation: OperationSpec, value: unknown): unknown {
  if (!operation.streaming) {
    throw new CapabilityCallError("protocol", "received a stream event for a non-streaming operation", false, operation.name);
  }
  try {
    return decodeWireValue(operation.streaming.event, value);
  } catch (error) {
    throw new CapabilityCallError(
      "protocol",
      `event does not match the wire schema: ${errorMessage(error)}`,
      false,
      operation.name,
    );
  }
}

export interface DecodedOperationError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Error payloads keep their own code (for example `division_by_zero`). If a package sends an
 * error object that does not match its declared schema we keep the code/message rather than
 * hiding the failure behind a generic protocol error.
 */
export function decodeOperationError(operation: OperationSpec, raw: unknown): DecodedOperationError {
  const record = isRecord(raw) ? raw : {};
  const code = typeof record.code === "string" && record.code.length > 0 ? record.code : "protocol";
  const message = typeof record.message === "string" ? record.message : "sidecar returned an error without a message";
  const retryable = record.retryable === true;
  try {
    const decoded = decodeWireValue(operation.error, raw);
    if (isRecord(decoded)) {
      return {
        code: typeof decoded.code === "string" ? decoded.code : code,
        message: typeof decoded.message === "string" ? decoded.message : message,
        retryable: typeof decoded.retryable === "boolean" ? decoded.retryable : retryable,
      };
    }
  } catch {
    // Preserve the original code/message: error fidelity is more useful than a schema complaint.
  }
  return { code, message, retryable };
}

export function toCallError(operation: OperationSpec, error: DecodedOperationError): CapabilityCallError {
  return new CapabilityCallError(error.code, error.message, error.retryable, operation.name);
}

export function selectEntrypoint(
  pkg: CapabilityPackage,
  kind: "module" | "sidecar_executable",
): CapabilityPackage["entrypoints"][number] {
  const protocol = kind === "module" ? "splice-ts-module-v1" : "splice-sidecar-v1";
  const entrypoint = pkg.entrypoints.find((candidate) => candidate.kind === kind);
  if (!entrypoint) {
    throw new RuntimeUnavailableError(
      `package ${pkg.package_id} (${pkg.runtime_kind}) has no ${kind} entrypoint`,
    );
  }
  if (entrypoint.protocol !== protocol) {
    throw new RuntimeUnavailableError(
      `entrypoint ${entrypoint.path} declares protocol ${entrypoint.protocol}; expected ${protocol}`,
    );
  }
  return entrypoint;
}

export function describeExit(code: number | null, signal: string | null): string {
  if (signal) return `signal ${signal}`;
  return `exit code ${code ?? "unknown"}`;
}
