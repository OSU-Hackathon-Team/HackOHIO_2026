import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { RuntimeUnavailableError } from "./types.js";

export interface IsolatedCommand {
  executable: string;
  args: string[];
  cwd: string;
}

function nodeExecutable(): { source: string; command: string; electron: boolean } {
  const source = realpathSync(process.execPath);
  if ("electron" in process.versions) return { source, command: "/runtime-electron/electron", electron: true };
  return { source, command: "/runtime-node", electron: false };
}

/** Run a verified package executable with no host home, workspace, or network mount. */
export function isolatedSidecarCommand(artifactRoot: string, entryPath: string, runnerPath?: string, packageEnv?: Record<string, string>): IsolatedCommand {
  if (process.platform !== "linux") throw new RuntimeUnavailableError("package process isolation currently requires Linux");
  const bwrap = "/usr/bin/bwrap";
  const prlimit = "/usr/bin/prlimit";
  if (!existsSync(bwrap) || !existsSync(prlimit)) {
    throw new RuntimeUnavailableError("package process isolation requires bubblewrap and prlimit");
  }
  const root = path.resolve(artifactRoot);
  const entry = path.resolve(entryPath);
  if (!entry.startsWith(`${root}${path.sep}`)) throw new RuntimeUnavailableError("sidecar entrypoint escapes its artifact root");
  const relative = path.relative(root, entry).split(path.sep).join("/");
  const mounts: string[] = [
    "--die-with-parent", "--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/usr", "/usr",
  ];
  for (const systemPath of ["/lib", "/lib64"]) {
    if (existsSync(systemPath)) mounts.push("--ro-bind", systemPath, systemPath);
  }
  if (existsSync("/etc/ld.so.cache")) mounts.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
  let runnerCommand = "/runtime-node";
  let addressLimit = "--as=4294967296";
  if (runnerPath) {
    const runner = path.resolve(runnerPath);
    if (!existsSync(runner)) throw new RuntimeUnavailableError(`JS package runner is missing: ${runner}`);
    const runtime = nodeExecutable();
    runnerCommand = runtime.command;
    if (runtime.electron) {
      // Chromium reserves a large uncommitted V8 cage; RLIMIT_AS aborts at startup.
      addressLimit = "--data=4294967296";
      const runtimeRoot = path.dirname(runtime.source);
      mounts.push("--dir", "/runtime-electron", "--ro-bind", runtime.source, runtime.command);
      for (const resource of ["libffmpeg.so", "icudtl.dat", "snapshot_blob.bin", "v8_context_snapshot.bin"]) {
        const resourcePath = path.join(runtimeRoot, resource);
        if (!existsSync(resourcePath)) throw new RuntimeUnavailableError(`Electron Node runtime is missing ${resource}`);
        mounts.push("--ro-bind", resourcePath, `/runtime-electron/${resource}`);
      }
      mounts.push("--setenv", "ELECTRON_RUN_AS_NODE", "1");
    } else {
      mounts.push("--ro-bind", runtime.source, runtime.command);
    }
    mounts.push("--ro-bind", runner, "/runner.mjs");
  }
  for (const [name, value] of Object.entries(packageEnv ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) {
      throw new RuntimeUnavailableError(`invalid package environment variable ${name}`);
    }
    mounts.push("--setenv", name, value);
  }
  mounts.push(
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", root, "/package",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp",
    "--chdir", "/package", "--", ...(runnerPath ? [runnerCommand, "--max-old-space-size=128", "/runner.mjs", `/package/${relative}`] : [`/package/${relative}`]),
  );
  return {
    executable: prlimit,
    args: [addressLimit, "--cpu=120", "--nproc=1024", "--nofile=64", "--", bwrap, ...mounts],
    cwd: root,
  };
}
