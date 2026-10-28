// Isolated package process transport: newline-delimited JSON over stdin/stdout per PROTOCOL.md.
//
// The host validates every request before it is written and every result/event after it is read.
// A sidecar is untrusted: malformed output, oversized frames, crashes and deadlines all end the
// process rather than escaping into the host.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CapabilityPackage,
  type HostEffect,
  type OperationSpec,
} from "@splice/contracts";
import { CapabilityCallError, RuntimeUnavailableError } from "./types.js";
import type { CallOptions, CapabilityClient, RuntimeOptions } from "./types.js";
import {
  assertOperationEffects,
  assertDefinitionMatchesPackage,
  decodeEvent,
  decodeOperationError,
  decodeResult,
  describeExit,
  effectiveTimeoutMs,
  encodeRequest,
  errorMessage,
  findOperation,
  isRecord,
  MAX_PROTOCOL_LINE_BYTES,
  DEFAULT_STDERR_CAP_BYTES,
  resolveVerifiedEntrypoint,
  toCallError,
} from "./support.js";
import { isolatedSidecarCommand } from "./isolation.js";

export interface SidecarExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the process did not exit cleanly on its own (or the host killed it). */
  crashed: boolean;
  detail: string;
  at: number;
}

interface PendingCall {
  id: string;
  operation: OperationSpec;
  settled: boolean;
  events: number;
  timer: NodeJS.Timeout;
  detachAbort: (() => void) | null;
  onEvent?: (event: unknown) => void;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

export class SidecarCapabilityClient implements CapabilityClient {
  readonly package: CapabilityPackage;
  private readonly options: RuntimeOptions;
  private readonly entryPath: string;
  private readonly artifactRoot: string;
  private readonly grantedEffects: readonly HostEffect[];
  private readonly runnerPath: string | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private disposed = false;
  private sequence = 0;
  private stdoutChunks: Buffer[] = [];
  private stdoutLength = 0;
  private stderrChunks: Buffer[] = [];
  private stderrLength = 0;
  private stderrLineBuffer = "";
  private exitInfo: SidecarExitInfo | null = null;

  private constructor(pkg: CapabilityPackage, options: RuntimeOptions, entryPath: string, runnerPath?: string) {
    this.package = pkg;
    this.options = options;
    this.entryPath = entryPath;
    this.artifactRoot = path.resolve(options.artifactRoot);
    this.grantedEffects = Object.freeze([...(options.grantedEffects ?? [])]);
    this.runnerPath = runnerPath;
  }

  static async create(pkg: CapabilityPackage, options: RuntimeOptions): Promise<SidecarCapabilityClient> {
    if (pkg.runtime_kind !== "native_sidecar") {
      throw new RuntimeUnavailableError(`package ${pkg.package_id} is ${pkg.runtime_kind}, not a native sidecar`);
    }
    assertDefinitionMatchesPackage(pkg, options.definition);
    const entryPath = await resolveVerifiedEntrypoint(pkg, options.artifactRoot, "sidecar_executable");
    isolatedSidecarCommand(options.artifactRoot, entryPath, undefined, options.env);
    return new SidecarCapabilityClient(pkg, options, entryPath);
  }

  static async createJs(pkg: CapabilityPackage, options: RuntimeOptions): Promise<SidecarCapabilityClient> {
    if (pkg.runtime_kind !== "ts_worker" && pkg.runtime_kind !== "node_worker") {
      throw new RuntimeUnavailableError(`package ${pkg.package_id} is ${pkg.runtime_kind}, not a JS process package`);
    }
    assertDefinitionMatchesPackage(pkg, options.definition);
    const entryPath = await resolveVerifiedEntrypoint(pkg, options.artifactRoot, "module");
    const runnerPath = fileURLToPath(new URL("./jsSidecarRunner.mjs", import.meta.url));
    isolatedSidecarCommand(options.artifactRoot, entryPath, runnerPath, options.env);
    return new SidecarCapabilityClient(pkg, options, entryPath, runnerPath);
  }

  get alive(): boolean {
    return this.child !== null && !this.disposed;
  }

  /** Captured stderr (bounded); exposed for diagnostics and crash reports. */
  get stderr(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  get lastExit(): SidecarExitInfo | null {
    return this.exitInfo;
  }

  async call(
    operationName: string,
    input: Record<string, unknown>,
    callOptions?: CallOptions,
  ): Promise<Record<string, unknown>> {
    const operation = findOperation(this.options.definition, operationName);
    assertOperationEffects(operation, this.grantedEffects);
    const args = encodeRequest(operation, input);
    if (callOptions?.signal?.aborted) {
      throw new CapabilityCallError("cancelled", "call was aborted before dispatch", false, operation.name);
    }

    const child = await this.ensureProcess(operation);
    const id = String(++this.sequence);
    const timeoutMs = effectiveTimeoutMs(operation, this.options, callOptions);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const pending: PendingCall = {
        id,
        operation,
        settled: false,
        events: 0,
        timer: setTimeout(() => {
          if (pending.settled) return;
          this.failPending(
            pending,
            new CapabilityCallError("timeout", `operation timed out after ${timeoutMs}ms`, true, operation.name),
            "timeout",
          );
        }, timeoutMs),
        detachAbort: null,
        onEvent: callOptions?.onEvent,
        resolve,
        reject,
      };

      const onAbort = () => {
        if (pending.settled) return;
        this.failPending(
          pending,
          new CapabilityCallError("cancelled", "call was aborted", false, operation.name),
          "abort",
        );
      };
      if (callOptions?.signal) {
        callOptions.signal.addEventListener("abort", onAbort, { once: true });
        pending.detachAbort = () => callOptions.signal?.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, pending);

      try {
        child.stdin.write(`${JSON.stringify({ id, op: operation.name, args })}\n`);
      } catch (error) {
        this.settle(pending, new CapabilityCallError("crashed", `could not write to sidecar: ${errorMessage(error)}`, true, operation.name));
        this.killChild(`write failed: ${errorMessage(error)}`);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll((pending) => new CapabilityCallError("cancelled", "client was disposed", false, pending.operation.name));

    const child = this.child;
    if (!child) return;
    if (this.runnerPath) {
      try { child.stdin.write(JSON.stringify({ id: "__dispose", op: "__dispose", args: {} }) + "\n"); } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(); };
        const timer = setTimeout(finish, 400);
        child.once("exit", finish);
      });
    }
    if (this.child === child) {
      this.child = null;
      this.exitInfo = { code: null, signal: "SIGTERM", crashed: false, detail: "disposed by host", at: Date.now() };
      this.resetBuffers();
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish();
      }, 500);
      child.once("exit", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }

  private async ensureProcess(operation: OperationSpec): Promise<ChildProcessWithoutNullStreams> {
    if (this.disposed) {
      throw new CapabilityCallError("cancelled", "sidecar client was disposed", false, operation.name);
    }
    if (this.child) return this.child;
    if (this.exitInfo && !this.restartAllowed()) {
      throw new CapabilityCallError(
        "crashed",
        `sidecar is not running (${this.exitInfo.detail}); restart policy is ${this.options.definition.lifecycle.restart_policy}`,
        false,
        operation.name,
      );
    }

    await this.spawnChild();
    if (!this.child) {
      const detail = this.exitInfo?.detail ?? "process did not start";
      throw new CapabilityCallError("crashed", `could not start sidecar (${detail})`, true, operation.name);
    }
    return this.child;
  }

  private restartAllowed(): boolean {
    switch (this.options.definition.lifecycle.restart_policy) {
      case "always":
        return true;
      case "on_crash":
        return this.exitInfo?.crashed === true;
      case "never":
        return false;
    }
  }

  private async spawnChild(): Promise<void> {
    const spawnImpl = this.options.spawnImpl ?? spawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      const isolated = isolatedSidecarCommand(this.artifactRoot, this.entryPath, this.runnerPath, this.options.env);
      child = spawnImpl(isolated.executable, isolated.args, {
        cwd: isolated.cwd,
        env: { PATH: "/usr/bin:/bin" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      this.exitInfo = { code: null, signal: null, crashed: true, detail: `spawn failed: ${errorMessage(error)}`, at: Date.now() };
      this.stderrChunks = [];
      this.stderrLength = 0;
      return;
    }

    this.child = child;
    this.resetBuffers();
    this.exitInfo = null;
    this.attach(child);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      };
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    }).catch((error: unknown) => {
      if (this.child === child) {
        this.child = null;
        this.exitInfo = {
          code: null,
          signal: null,
          crashed: true,
          detail: `spawn failed: ${errorMessage(error)}`,
          at: Date.now(),
        };
        this.rejectAll(
          (pending) =>
            new CapabilityCallError("crashed", `could not start sidecar: ${errorMessage(error)}`, true, pending.operation.name),
        );
      }
    });
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child === child) this.consumeStdout(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child === child) this.consumeStderr(chunk);
    });
    child.stdin.on("error", (error: Error) => {
      this.handleFailure(child, `stdin error: ${errorMessage(error)}`);
    });
    child.on("error", (error: Error) => {
      this.handleFailure(child, `process error: ${errorMessage(error)}`);
    });
    child.on("exit", (code, signal) => {
      this.handleExit(child, code, signal);
    });
  }

  private consumeStdout(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        const rest = chunk.subarray(start);
        if (rest.length > 0) {
          this.stdoutChunks.push(rest);
          this.stdoutLength += rest.length;
          if (this.stdoutLength > MAX_PROTOCOL_LINE_BYTES) {
            this.protocolFailure(undefined, `sidecar wrote a line larger than ${MAX_PROTOCOL_LINE_BYTES} bytes`);
          }
        }
        return;
      }
      const part = chunk.subarray(start, newline);
      let lineBuffer: Buffer;
      if (this.stdoutChunks.length === 0) {
        lineBuffer = part;
      } else {
        this.stdoutChunks.push(part);
        lineBuffer = Buffer.concat(this.stdoutChunks, this.stdoutLength + part.length);
      }
      this.stdoutChunks = [];
      this.stdoutLength = 0;
      start = newline + 1;

      if (lineBuffer.length > MAX_PROTOCOL_LINE_BYTES) {
        this.protocolFailure(undefined, `sidecar wrote a line larger than ${MAX_PROTOCOL_LINE_BYTES} bytes`);
        return;
      }
      this.consumeLine(lineBuffer.toString("utf8").replace(/\r$/, ""));
      if (this.child === null) return;
    }
  }

  private consumeStderr(chunk: Buffer): void {
    const combined = Buffer.concat([...this.stderrChunks, chunk]);
    this.stderrChunks = [combined.subarray(Math.max(0, combined.length - DEFAULT_STDERR_CAP_BYTES))];
    this.stderrLength = Math.min(combined.length, DEFAULT_STDERR_CAP_BYTES);
    if (!this.options.onLog) return;
    this.stderrLineBuffer += chunk.toString("utf8");
    const lines = this.stderrLineBuffer.split("\n");
    this.stderrLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) this.options.onLog(line.replace(/\r$/, ""));
    }
  }

  private consumeLine(line: string): void {
    if (line.length === 0) {
      this.protocolFailure(undefined, "sidecar wrote an empty line");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.protocolFailure(undefined, "sidecar wrote a line that is not JSON");
      return;
    }
    if (!isRecord(message) || typeof message.id !== "string") {
      this.protocolFailure(undefined, "sidecar message has no string request id");
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.protocolFailure(undefined, `sidecar replied to unknown request id ${message.id}`);
      return;
    }

    if ("event" in message) {
      if (message.ok !== undefined && message.ok !== null) {
        this.protocolFailure(pending, "event line also carried a terminal ok value");
        return;
      }
      if (pending.events >= (pending.operation.streaming?.max_events ?? 0)) {
        this.protocolFailure(pending, `sidecar exceeded max_events for ${pending.operation.name}`);
        return;
      }
      let event: unknown;
      try {
        event = decodeEvent(pending.operation, message.event);
      } catch (error) {
        this.protocolFailure(pending, errorMessage(error));
        return;
      }
      pending.events += 1;
      if (pending.onEvent) {
        try {
          pending.onEvent(event);
        } catch (error) {
          this.options.onLog?.(`event handler threw: ${errorMessage(error)}`);
        }
      }
      return;
    }

    if (typeof message.ok !== "boolean") {
      this.protocolFailure(pending, "terminal message needs a boolean ok");
      return;
    }

    if (message.ok) {
      let value: Record<string, unknown>;
      try {
        value = decodeResult(pending.operation, message.value);
      } catch (error) {
        this.protocolFailure(pending, errorMessage(error));
        return;
      }
      this.settle(pending, null, value);
      return;
    }

    const decoded = decodeOperationError(pending.operation, message.error);
    this.settle(pending, toCallError(pending.operation, decoded));
  }

  private protocolFailure(target: PendingCall | undefined, message: string): void {
    const error = (pending: PendingCall) =>
      pending === target
        ? new CapabilityCallError("protocol", message, false, pending.operation.name)
        : new CapabilityCallError(
            "protocol",
            `sidecar terminated after a protocol violation: ${message}`,
            false,
            pending.operation.name,
          );
    this.rejectAll(error);
    this.killChild(`protocol violation: ${message}`);
  }

  private failPending(pending: PendingCall, error: Error, reason: string): void {
    this.settle(pending, error);
    const crash = new CapabilityCallError(
      "crashed",
      `sidecar was killed after ${reason} of another request`,
      true,
      pending.operation.name,
    );
    this.rejectAll((other) => (other === pending ? error : crash));
    this.killChild(reason);
  }

  private settle(pending: PendingCall, error: Error | null, value?: Record<string, unknown>): void {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    pending.detachAbort?.();
    this.pending.delete(pending.id);
    if (error) pending.reject(error);
    else pending.resolve(value ?? {});
  }

  private rejectAll(factory: (pending: PendingCall) => Error): void {
    for (const pending of [...this.pending.values()]) {
      this.settle(pending, factory(pending));
    }
  }

  private handleFailure(child: ChildProcessWithoutNullStreams, detail: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.exitInfo = { code: child.exitCode, signal: child.signalCode, crashed: true, detail, at: Date.now() };
    this.resetBuffers();
    const stderr = this.stderrTail();
    this.rejectAll(
      (pending) =>
        new CapabilityCallError(
          "crashed",
          `sidecar failed (${detail})${stderr ? `; stderr: ${stderr}` : ""}`,
          true,
          pending.operation.name,
        ),
    );
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    const clean = code === 0 && signal === null && this.pending.size === 0;
    this.exitInfo = {
      code,
      signal,
      crashed: !clean,
      detail: describeExit(code, signal),
      at: Date.now(),
    };
    this.resetBuffers();
    const stderr = this.stderrTail();
    this.rejectAll(
      (pending) =>
        new CapabilityCallError(
          "crashed",
          `sidecar exited (${describeExit(code, signal)}) while ${pending.operation.name} was pending${
            stderr ? `; stderr: ${stderr}` : ""
          }`,
          true,
          pending.operation.name,
        ),
    );
  }

  private killChild(detail: string): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.exitInfo = { code: null, signal: "SIGKILL", crashed: true, detail, at: Date.now() };
    this.resetBuffers();
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  private resetBuffers(): void {
    this.stdoutChunks = [];
    this.stdoutLength = 0;
    this.stderrChunks = [];
    this.stderrLength = 0;
    this.stderrLineBuffer = "";
  }

  private stderrTail(limit = 1000): string {
    const text = this.stderr.trim();
    return text.length > limit ? text.slice(text.length - limit) : text;
  }
}

/**
 * Start a client for one native sidecar package. The process is spawned lazily on the first call;
 * validating the entrypoint happens now so bad packages fail before a call is attempted.
 */
export async function createSidecarClient(
  pkg: CapabilityPackage,
  options: RuntimeOptions,
): Promise<CapabilityClient> {
  return SidecarCapabilityClient.create(pkg, options);
}
