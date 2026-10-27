import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

export interface RestrictedRunOptions {
  cwd: string;
  input?: string | Buffer;
  timeoutMs: number;
  maxOutputBytes?: number;
  writable?: boolean;
  signal?: AbortSignal;
}

export interface RestrictedRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

function capture(stream: Readable, maxBytes: number, onOverflow: () => void): Buffer[] {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on("data", (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) {
      onOverflow();
      return;
    }
    chunks.push(chunk);
  });
  return chunks;
}

/** Linux user/PID/network namespaces plus resource limits. No host home or repository is mounted. */
export async function runRestricted(
  executable: string,
  args: string[],
  options: RestrictedRunOptions,
): Promise<RestrictedRunResult> {
  if (process.platform !== "linux") throw new SandboxUnavailableError("restricted build execution currently requires Linux bubblewrap");
  const bwrap = "/usr/bin/bwrap";
  const prlimit = "/usr/bin/prlimit";
  if (!existsSync(bwrap) || !existsSync(prlimit)) throw new SandboxUnavailableError("bubblewrap and prlimit are required for generated-code execution");
  const work = path.resolve(options.cwd);
  const nodeExecutable = executable === process.execPath ? realpathSync(process.execPath) : null;
  const mounts: string[] = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--ro-bind", "/usr", "/usr",
  ];
  for (const systemPath of ["/lib", "/lib64"]) {
    if (existsSync(systemPath)) mounts.push("--ro-bind", systemPath, systemPath);
  }
  if (existsSync("/etc/ld.so.cache")) mounts.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
  if (nodeExecutable) mounts.push("--ro-bind", nodeExecutable, "/runtime-node");
  mounts.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    options.writable ? "--bind" : "--ro-bind", work, "/work",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "HOME", "/tmp",
    "--setenv", "TMPDIR", "/tmp",
    "--chdir", "/work",
    "--", nodeExecutable ? "/runtime-node" : executable, ...args,
  );

  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  const started = Date.now();
  const child = spawn(prlimit, [
    // V8 reserves several GiB of virtual address space even when its live heap is small.
    "--as=4294967296",
    "--cpu=12",
    // The limit applies to all processes owned by this UID, including the parent server.
    // A value below the host's existing process count prevents bubblewrap from creating namespaces.
    "--nproc=1024",
    "--nofile=64",
    "--", bwrap, ...mounts,
  ], {
    cwd: work,
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  return await new Promise<RestrictedRunResult>((resolve, reject) => {
    let settled = false;
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    const stdout = capture(child.stdout, maxOutputBytes, () => {
      overflow = true;
      stop();
    });
    const stderr = capture(child.stderr, maxOutputBytes, () => {
      overflow = true;
      stop();
    });
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The process may have exited between the check and signal.
      }
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      stop();
      reject(error);
    };
    const onAbort = () => {
      aborted = true;
      finishError(new Error("restricted execution cancelled"));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finishError(new Error(`restricted execution exceeded ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finishError(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (overflow) {
        reject(new Error(`restricted execution exceeded ${maxOutputBytes} output bytes`));
        return;
      }
      if (timedOut || aborted) {
        reject(new Error(timedOut ? `restricted execution exceeded ${options.timeoutMs}ms` : "restricted execution cancelled"));
        return;
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - started,
      });
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}
