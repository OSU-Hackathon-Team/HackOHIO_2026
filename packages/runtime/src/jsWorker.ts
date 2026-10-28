// JavaScript capability transport. The package runs in a supervised Linux process using the
// same schema-checked JSON protocol as native sidecars, behind an OS namespace boundary.
import type { CapabilityPackage } from "@splice/contracts";
import type { CallOptions, CapabilityClient, RuntimeOptions } from "./types.js";
import { SidecarCapabilityClient } from "./sidecarClient.js";

export class JsWorkerCapabilityClient implements CapabilityClient {
  private constructor(private readonly processClient: SidecarCapabilityClient) {}

  static async create(pkg: CapabilityPackage, options: RuntimeOptions): Promise<JsWorkerCapabilityClient> {
    return new JsWorkerCapabilityClient(await SidecarCapabilityClient.createJs(pkg, options));
  }

  get package(): CapabilityPackage { return this.processClient.package; }
  get alive(): boolean { return this.processClient.alive; }
  get lastExit() { return this.processClient.lastExit; }

  call(operation: string, input: Record<string, unknown>, options?: CallOptions): Promise<Record<string, unknown>> {
    return this.processClient.call(operation, input, options);
  }

  dispose(): Promise<void> { return this.processClient.dispose(); }
}

export async function createJsWorkerClient(pkg: CapabilityPackage, options: RuntimeOptions): Promise<CapabilityClient> {
  return JsWorkerCapabilityClient.create(pkg, options);
}
