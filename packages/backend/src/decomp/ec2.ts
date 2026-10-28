// The EC2 decomp worker: one stopped instance that the backend starts per run. The runner script
// (infra/decomp-ec2/run-scoped-pipeline.sh) uploads progress and results to S3 and stops the
// instance itself, so the backend only starts it and reads S3.

import fs from "node:fs/promises";
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand } from "@aws-sdk/client-ec2";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeInstanceInformationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";

export interface DecompWorker {
  instanceState(): Promise<string>;
  uploadPayload(file: string): Promise<void>;
  /** Starts the instance and launches the runner; resolves once the runner is running. */
  start(runId: string, args: { maxFunctions: number; maxDepth: number; targetId: string; mode?: "analysis" | "public_oracle" }, runnerScript: string): Promise<void>;
  /** results/<runId>/<name> from S3, or null while it does not exist yet. */
  readObject(runId: string, name: string): Promise<Buffer | null>;
}

export interface Ec2WorkerConfig {
  region: string;
  instanceId: string;
  bucket: string;
  cacheEnabled?: boolean;
  onlineTimeoutMs?: number;
  runtimeMaxSeconds?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mock-aware EC2 worker to avoid AWS credential errors in mock/replay mode
export function ec2Worker(config: Ec2WorkerConfig): DecompWorker {
  const options = { region: config.region, maxAttempts: 3 };
  const isMock = process.env.LLM_MODE === 'mock' || process.env.LLM_MODE === 'replay' || process.env.REA_MODE === 'mock' || process.env.REA_MODE === 'replay';

  // Real clients only instantiated when not in mock mode.
  const realClients = isMock ? null : {
    ec2: new EC2Client(options),
    ssm: new SSMClient(options),
    s3: new S3Client(options),
  };

  // Helper to send commands, using mock responses when needed.
  const clientSend = async (client: any, command: any) => {
    if (isMock) {
      // Minimal mock behavior based on command type.
      if (command instanceof DescribeInstancesCommand) {
        return { Reservations: [{ Instances: [{ State: { Name: "stopped" } }] }] };
      }
      if (command instanceof GetObjectCommand) {
        const err: any = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        throw err;
      }
      // For other commands, assume success.
      return {};
    }
    return client.send(command);
  };

  return {
    async instanceState() {
      const ec2 = realClients?.ec2;
      const result = await clientSend(ec2, new DescribeInstancesCommand({ InstanceIds: [config.instanceId] }));
      return (result as any).Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "unknown";
    },

    async uploadPayload(file) {
      const s3 = realClients?.s3;
      await clientSend(s3, new PutObjectCommand({ Bucket: config.bucket, Key: "inputs/payload.tgz", Body: await fs.readFile(file) }));
    },

    async start(runId, { maxFunctions, maxDepth, targetId, mode = "analysis" }, runnerScript) {
      if (!/^[a-z0-9-]{8,64}$/.test(runId)) throw new Error("invalid run id");
      if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(targetId)) throw new Error("invalid target id");
      if (!["analysis", "public_oracle"].includes(mode)) throw new Error("invalid run mode");
      if (isMock) return; // Skip actual start in mock mode.
      const ec2 = realClients?.ec2;
      const ssm = realClients?.ssm;
      await clientSend(ec2, new StartInstancesCommand({ InstanceIds: [config.instanceId] }));
      const deadline = Date.now() + (config.onlineTimeoutMs ?? 10 * 60_000);
      for (;;) {
        const info = await clientSend(ssm, new DescribeInstanceInformationCommand({
          Filters: [{ Key: "InstanceIds", Values: [config.instanceId] }],
        }));
        if ((info as any).InstanceInformationList?.[0]?.PingStatus === "Online") break;
        if (Date.now() > deadline) throw new Error("worker did not come online in SSM; it may still be booting");
        await sleep(10_000);
      }
      const unit = `splice-run-${runId}`;
      const script = Buffer.from(runnerScript).toString("base64");
      const commands = [
        `shutdown -h +${Math.ceil((config.runtimeMaxSeconds ?? 3600) / 60) + 15}`,
        `printf '%s' '${script}' | base64 -d > /opt/${unit}.sh`,
        `systemd-run --unit=${unit} --property=RuntimeMaxSec=${config.runtimeMaxSeconds ?? 3600} ` +
          `--setenv=TRIAL_BUCKET=${config.bucket} --setenv=AWS_DEFAULT_REGION=${config.region} ` +
          (config.cacheEnabled ? "--setenv=DECOMP_CACHE_ENABLED=1 " : "") +
          `/bin/bash /opt/${unit}.sh ${runId} ${Math.trunc(maxFunctions)} ${Math.trunc(maxDepth)} ${targetId} ${mode}`,
      ];
      await clientSend(ssm, new SendCommandCommand({ InstanceIds: [config.instanceId], DocumentName: "AWS-RunShellScript",
        Parameters: { commands, executionTimeout: ["60"] } }));
    },

    async readObject(runId, name) {
      const s3 = realClients?.s3;
      try {
        const r = await clientSend(s3, new GetObjectCommand({ Bucket: config.bucket, Key: `results/${runId}/${name}` }));
        return Buffer.from(await (r as any).Body!.transformToByteArray());
      } catch (error) {
        if ((error as any).name === "NoSuchKey") return null;
        throw error;
      }
    },
  };
}

