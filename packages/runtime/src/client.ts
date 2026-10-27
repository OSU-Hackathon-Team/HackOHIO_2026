// One client surface for every supported runtime kind. Selection is explicit: the package's
// declared runtime and platform must match, and an unsupported combination fails with a typed
// RuntimeUnavailableError rather than silently falling back to another transport.
import type { CapabilityPackage, PlatformSupport } from "@splice/contracts";
import { RuntimeUnavailableError } from "./types.js";
import type { CapabilityClient, RuntimeOptions } from "./types.js";
import { assertDefinitionMatchesPackage } from "./support.js";
import { createSidecarClient } from "./sidecarClient.js";
import { createJsWorkerClient } from "./jsWorker.js";

export function currentPlatform(): PlatformSupport {
  const os = process.platform;
  const arch = process.arch;
  if (os !== "linux" && os !== "darwin" && os !== "win32") {
    throw new RuntimeUnavailableError(`unsupported operating system: ${os}`);
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new RuntimeUnavailableError(`unsupported architecture: ${arch}`);
  }
  return { os, arch };
}

export function supportsPlatform(pkg: CapabilityPackage, platform: PlatformSupport): boolean {
  return pkg.platforms.some((candidate) => candidate.os === platform.os && candidate.arch === platform.arch);
}

/**
 * Create a validated client for a package.
 *
 * - `native_sidecar` -> a supervised sidecar process.
 * - `ts_worker` / `node_worker` -> an isolated Node process running the package module.
 * - `renderer_worker` -> not available in the Node host; the browser/desktop renderer host owns it.
 */
export async function createCapabilityClient(
  pkg: CapabilityPackage,
  options: RuntimeOptions,
): Promise<CapabilityClient> {
  assertDefinitionMatchesPackage(pkg, options.definition);
  const platform = options.platform ?? currentPlatform();
  if (!supportsPlatform(pkg, platform)) {
    throw new RuntimeUnavailableError(
      `package ${pkg.package_id} does not support ${platform.os}/${platform.arch}`,
    );
  }

  switch (pkg.runtime_kind) {
    case "native_sidecar":
      return createSidecarClient(pkg, options);
    case "ts_worker":
    case "node_worker":
      return createJsWorkerClient(pkg, options);
    case "renderer_worker":
      throw new RuntimeUnavailableError(
        `package ${pkg.package_id} is a renderer_worker package; create it from the browser/desktop renderer host`,
      );
    default: {
      const exhaustive: never = pkg.runtime_kind;
      throw new RuntimeUnavailableError(`unsupported runtime kind: ${String(exhaustive)}`);
    }
  }
}
