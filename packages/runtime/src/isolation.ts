import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { RuntimeUnavailableError } from "./types.js";

export interface IsolatedCommand {
  executable: string;
  args: string[];
  cwd: string;
}

function nodeExecutable(): string {
  if (!("electron" in process.versions)) return realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "node");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue to the next absolute PATH directory.
    }
  }
  throw new RuntimeUnavailableError("Electron exports require an installed Node executable on PATH for isolated JS packages");
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
  if (runnerPath) {
    const runner = path.resolve(runnerPath);
    if (!existsSync(runner)) throw new RuntimeUnavailableError(`JS package runner is missing: ${runner}`);
    mounts.push("--ro-bind", nodeExecutable(), "/runtime-node");
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
    "--chdir", "/package", "--", ...(runnerPath ? ["/runtime-node", "--max-old-space-size=128", "/runner.mjs", `/package/${relative}`] : [`/package/${relative}`]),
  );
  return {
    executable: prlimit,
    args: ["--as=4294967296", "--cpu=120", "--nproc=1024", "--nofile=64", "--", bwrap, ...mounts],
    cwd: root,
  };
}
