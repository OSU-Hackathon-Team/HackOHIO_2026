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
  start(runId: string, args: { maxFunctions: number; maxDepth: number; targetId: string }, runnerScript: string): Promise<void>;
  /** results/<runId>/<name> from S3, or null while it does not exist yet. */
  readObject(runId: string, name: string): Promise<Buffer | null>;
}

export interface Ec2WorkerConfig {
  region: string;
  instanceId: string;
  bucket: string;
  onlineTimeoutMs?: number;
  runtimeMaxSeconds?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ec2Worker(config: Ec2WorkerConfig): DecompWorker {
  const options = { region: config.region, maxAttempts: 3 };
  const ec2 = new EC2Client(options), ssm = new SSMClient(options), s3 = new S3Client(options);

  return {
    async instanceState() {
      const r = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [config.instanceId] }));
      return r.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "unknown";
    },

    async uploadPayload(file) {
      // The instance role may read only this key.
      await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: "inputs/payload.tgz", Body: await fs.readFile(file) }));
    },

    async start(runId, { maxFunctions, maxDepth, targetId }, runnerScript) {
      if (!/^[a-z0-9-]{8,64}$/.test(runId)) throw new Error("invalid run id");
      if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(targetId)) throw new Error("invalid target id");
      await ec2.send(new StartInstancesCommand({ InstanceIds: [config.instanceId] }));
      const deadline = Date.now() + (config.onlineTimeoutMs ?? 10 * 60_000);
      for (;;) {
        const info = await ssm.send(new DescribeInstanceInformationCommand({
          Filters: [{ Key: "InstanceIds", Values: [config.instanceId] }] }));
        if (info.InstanceInformationList?.[0]?.PingStatus === "Online") break;
        if (Date.now() > deadline) throw new Error("worker did not come online in SSM; it may still be booting");
        await sleep(10_000);
      }
      const unit = `splice-run-${runId}`;
      const script = Buffer.from(runnerScript).toString("base64");
      const commands = [
        // Backstop independent of the runner: if it dies before its own shutdown, the instance still stops.
        `shutdown -h +${Math.ceil((config.runtimeMaxSeconds ?? 3600) / 60) + 15}`,
        `printf '%s' '${script}' | base64 -d > /opt/${unit}.sh`,
        `systemd-run --unit=${unit} --property=RuntimeMaxSec=${config.runtimeMaxSeconds ?? 3600} ` +
          `--setenv=TRIAL_BUCKET=${config.bucket} --setenv=AWS_DEFAULT_REGION=${config.region} ` +
          `/bin/bash /opt/${unit}.sh ${runId} ${Math.trunc(maxFunctions)} ${Math.trunc(maxDepth)} ${targetId}`,
      ];
      await ssm.send(new SendCommandCommand({ InstanceIds: [config.instanceId], DocumentName: "AWS-RunShellScript",
        Parameters: { commands, executionTimeout: ["60"] } }));
    },

    async readObject(runId, name) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: `results/${runId}/${name}` }));
        return Buffer.from(await r.Body!.transformToByteArray());
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },
  };
}
